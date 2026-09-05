import { basename, resolve } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { ExecutionCommand } from "../adapter/base"
import {
  breakpointKey,
  createBreakpointProjection,
  type MirroredBreakpoint,
} from "../breakpoint/projection"
import { DapMessageDecoder, encodeDapMessage } from "../dap/codec"
import type { Event, Request, Response } from "../dap/types"
import type { SessionManager } from "../session/manager"
import type { BreakpointInfo, SessionState } from "../session/state"
import { arrayValue, numberValue, recordValue, stringValue } from "../util/value"

const THREAD_ID = 1

export class SharedDebugServer {
  private announcedBreakpoints: MirroredBreakpoint[] = []
  private breakpointIds = new Map<string, number>()
  private decoder = new DapMessageDecoder()
  private finish: (() => void) | null = null
  private isApplyingBreakpoints = false
  private isAuthenticated = false
  private isConfigured = false
  private isStopped = false
  private nextBreakpointId = 1
  private nextVariablesReference = 1
  private sequence = 1
  private session: SessionState | null = null
  private unsubscribe: (() => void)[] = []
  private variableFrames = new Map<number, number>()

  constructor(
    private options: {
      input: Readable
      output: Writable
      sessions: SessionManager
      token: string
      onAuthenticated?: () => void
    },
  ) {}

  async run(): Promise<void> {
    const stopped = new Promise<void>((resolveStopped) => {
      this.finish = resolveStopped
    })
    this.options.input.on("data", (data: Buffer | string) => {
      this.decoder.push(Buffer.from(data)).forEach((message) => {
        if (message.type === "request") void this.dispatch(message)
      })
    })
    this.options.input.once("end", () => this.stop())
    this.options.input.once("error", () => this.stop())
    this.options.input.resume()
    await stopped
  }

  stop(): void {
    if (this.isStopped) return
    this.isStopped = true
    this.unsubscribe.forEach((removeListener) => removeListener())
    this.unsubscribe = []
    this.finish?.()
    this.finish = null
  }

  private async dispatch(request: Request): Promise<void> {
    try {
      await this.handleRequest(request)
    } catch (error) {
      this.sendResponse({
        request,
        isSuccessful: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleRequest(request: Request): Promise<void> {
    if (request.command === "initialize") {
      this.sendResponse({
        request,
        body: {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsEvaluateForHovers: true,
          supportsTerminateRequest: false,
        },
      })
      this.sendEvent({ event: "initialized" })
      return
    }
    if (request.command === "launch" || request.command === "attach") {
      if (stringValue(request.arguments?.piDebuggerToken) !== this.options.token) {
        throw new Error(
          "Editor authentication failed. Rerun `pi-debugger setup` and reload Pi.",
        )
      }
      if (!this.isAuthenticated) {
        this.isAuthenticated = true
        this.options.onAuthenticated?.()
      }
      this.bindOnlyNodeSession()
      this.sendResponse({ request })
      this.sendEvent({
        event: "process",
        body: {
          name: this.session?.name ?? "Pi Node session",
          isLocalProcess: true,
          startMethod: "attach",
        },
      })
      return
    }
    if (!this.isAuthenticated && request.command !== "disconnect") {
      throw new Error("The editor must authenticate before using the debugger.")
    }
    if (request.command === "configurationDone") {
      const session = this.requireSession()
      this.isConfigured = true
      this.sendResponse({ request })
      this.emitBreakpointChanges(this.currentBreakpoints())
      if (session.executionState === "stopped") {
        this.sendStoppedEvent({
          reason: session.stoppedReason ?? "entry",
          threadId: session.stoppedThreadId ?? THREAD_ID,
        })
      }
      return
    }
    if (request.command === "setBreakpoints") {
      await this.handleSetBreakpoints(request)
      return
    }
    if (request.command === "setExceptionBreakpoints") {
      this.sendResponse({ request, body: { breakpoints: [] } })
      return
    }
    if (request.command === "threads") {
      const session = this.requireSession()
      this.sendResponse({
        request,
        body: { threads: [{ id: THREAD_ID, name: session.name ?? "Node" }] },
      })
      return
    }
    if (request.command === "stackTrace") {
      const frames = await this.requireSession().adapter.getCallStack({
        threadId: numberValue(request.arguments?.threadId) ?? THREAD_ID,
      })
      this.sendResponse({
        request,
        body: { stackFrames: frames, totalFrames: frames.length },
      })
      return
    }
    if (request.command === "scopes") {
      const frameId = numberValue(request.arguments?.frameId)
      if (frameId === undefined) throw new Error("A stack frame is required.")
      const variablesReference = this.nextVariablesReference++
      this.variableFrames.set(variablesReference, frameId)
      this.sendResponse({
        request,
        body: {
          scopes: [{
            name: "Locals",
            presentationHint: "locals",
            variablesReference,
            expensive: false,
          }],
        },
      })
      return
    }
    if (request.command === "variables") {
      const variablesReference = numberValue(request.arguments?.variablesReference)
      const frameId = variablesReference === undefined
        ? undefined
        : this.variableFrames.get(variablesReference)
      if (frameId === undefined) throw new Error("Variable scope not found.")
      const variables = await this.requireSession().adapter.getVariables({ frameId })
      this.sendResponse({
        request,
        body: {
          variables: variables.map((variable) => ({
            ...variable,
            variablesReference: 0,
          })),
        },
      })
      return
    }
    if (request.command === "evaluate") {
      const expression = stringValue(request.arguments?.expression)
      if (expression === undefined) throw new Error("An expression is required.")
      const result = await this.requireSession().adapter.evaluate({
        expression,
        frameId: numberValue(request.arguments?.frameId),
      })
      this.sendResponse({ request, body: { ...result, variablesReference: 0 } })
      return
    }
    const executionCommand = dapExecutionCommand(request.command)
    if (executionCommand) {
      const adapter = this.requireSession().adapter
      if (!adapter.startExecution) {
        throw new Error("This debug session does not support shared execution.")
      }
      await adapter.startExecution({
        command: executionCommand,
        threadId: numberValue(request.arguments?.threadId),
      })
      this.sendResponse({
        request,
        body: request.command === "continue"
          ? { allThreadsContinued: true }
          : undefined,
      })
      return
    }
    if (request.command === "pause") {
      const adapter = this.requireSession().adapter
      if (!adapter.pause) {
        throw new Error("This debug session does not support pause.")
      }
      await adapter.pause({
        threadId: numberValue(request.arguments?.threadId),
      })
      this.sendResponse({ request })
      return
    }
    if (request.command === "disconnect") {
      this.sendResponse({ request })
      this.stop()
      return
    }
    this.sendResponse({
      request,
      isSuccessful: false,
      message: `The Pi debugger does not support ${request.command}.`,
    })
  }

  private bindOnlyNodeSession(): void {
    if (this.session) return
    const nodeSessions = this.options.sessions
      .list()
      .filter((session) => session.adapter.id === "node")
    if (nodeSessions.length === 0) {
      throw new Error("Start one Node debug session in Pi before opening the editor debugger.")
    }
    if (nodeSessions.length > 1) {
      throw new Error("Stop extra Node debug sessions before opening the editor debugger.")
    }
    const session = nodeSessions[0]
    if (!session) throw new Error("Node debug session not found.")
    this.session = session
    this.unsubscribe.push(
      this.options.sessions.onBreakpointsChanged(() => {
        if (this.isConfigured && !this.isApplyingBreakpoints) {
          this.emitBreakpointChanges(this.currentBreakpoints())
        }
      }),
      session.adapter.onStopped((event) => {
        if (this.isConfigured) {
          this.sendStoppedEvent({
            reason: event.reason,
            threadId: event.threadId ?? THREAD_ID,
          })
        }
      }),
    )
    if (session.adapter.onContinued) {
      this.unsubscribe.push(
        session.adapter.onContinued((threadId) => {
          if (!this.isConfigured) return
          this.variableFrames.clear()
          this.sendEvent({
            event: "continued",
            body: { threadId, allThreadsContinued: true },
          })
        }),
      )
    }
    if (session.adapter.onTerminated) {
      this.unsubscribe.push(
        session.adapter.onTerminated(() => {
          if (this.isConfigured) this.sendEvent({ event: "terminated" })
        }),
      )
    }
  }

  private async handleSetBreakpoints(request: Request): Promise<void> {
    const session = this.requireSession()
    const source = recordValue(request.arguments?.source)
    const sourcePath = stringValue(source?.path)
    if (!sourcePath) throw new Error("An absolute source path is required.")
    const file = resolve(sourcePath)
    const breakpoints = arrayValue(request.arguments?.breakpoints)
      .map(recordValue)
      .filter((item) => item !== undefined)
      .flatMap((item) => {
        const line = numberValue(item.line)
        if (line === undefined) return []
        return [{
          line,
          column: numberValue(item.column),
          condition: stringValue(item.condition),
          hitCondition: stringValue(item.hitCondition),
          logMessage: stringValue(item.logMessage),
        }]
    })
    this.isApplyingBreakpoints = true
    try {
      const updated = await this.options.sessions.replaceBreakpoints({
        sessionId: session.id,
        file,
        breakpoints,
      })
      this.announcedBreakpoints = this.currentBreakpoints()
      this.sendResponse({
        request,
        body: {
          breakpoints: updated.map((breakpoint) =>
            this.dapBreakpoint({ file, breakpoint }),
          ),
        },
      })
    } finally {
      this.isApplyingBreakpoints = false
    }
  }

  private requireSession(): SessionState {
    if (!this.session) throw new Error("The editor is not attached to a Pi debug session.")
    return this.session
  }

  private currentBreakpoints(): MirroredBreakpoint[] {
    const session = this.session
    return session ? createBreakpointProjection([session]) : []
  }

  private emitBreakpointChanges(next: MirroredBreakpoint[]): void {
    const previousByKey = new Map(
      this.announcedBreakpoints.map((breakpoint) => [
        breakpointKey(breakpoint),
        breakpoint,
      ]),
    )
    const nextByKey = new Map(
      next.map((breakpoint) => [breakpointKey(breakpoint), breakpoint]),
    )
    this.announcedBreakpoints
      .filter((breakpoint) => !nextByKey.has(breakpointKey(breakpoint)))
      .forEach((breakpoint) =>
        this.sendBreakpointEvent({ reason: "removed", breakpoint }),
      )
    next.forEach((breakpoint) => {
      const previous = previousByKey.get(breakpointKey(breakpoint))
      if (!previous) {
        this.sendBreakpointEvent({ reason: "new", breakpoint })
      } else if (previous.verified !== breakpoint.verified) {
        this.sendBreakpointEvent({ reason: "changed", breakpoint })
      }
    })
    this.announcedBreakpoints = next
  }

  private sendBreakpointEvent(options: {
    reason: "new" | "changed" | "removed"
    breakpoint: MirroredBreakpoint
  }): void {
    this.sendEvent({
      event: "breakpoint",
      body: {
        reason: options.reason,
        breakpoint: this.dapBreakpoint({
          file: options.breakpoint.file,
          breakpoint: options.breakpoint,
        }),
      },
    })
  }

  private dapBreakpoint(options: {
    file: string
    breakpoint: BreakpointInfo | MirroredBreakpoint
  }): Record<string, unknown> {
    const key = breakpointKey({ file: options.file, ...options.breakpoint })
    const existingId = this.breakpointIds.get(key)
    const id = existingId ?? this.nextBreakpointId++
    if (existingId === undefined) this.breakpointIds.set(key, id)
    return {
      id,
      verified: options.breakpoint.verified,
      source: { name: basename(options.file), path: options.file },
      line: options.breakpoint.line,
      column: options.breakpoint.column,
      message: "message" in options.breakpoint
        ? options.breakpoint.message
        : undefined,
    }
  }

  private sendStoppedEvent(options: {
    reason: string
    threadId: number
  }): void {
    this.sendEvent({
      event: "stopped",
      body: {
        reason: options.reason,
        threadId: options.threadId,
        allThreadsStopped: true,
      },
    })
  }

  private sendResponse(options: {
    request: Request
    body?: Record<string, unknown>
    isSuccessful?: boolean
    message?: string
  }): void {
    const response: Response = {
      seq: this.sequence++,
      type: "response",
      request_seq: options.request.seq,
      success: options.isSuccessful ?? true,
      command: options.request.command,
      message: options.message,
      body: options.body,
    }
    this.options.output.write(encodeDapMessage(response))
  }

  private sendEvent(options: {
    event: string
    body?: Record<string, unknown>
  }): void {
    const event: Event = {
      seq: this.sequence++,
      type: "event",
      event: options.event,
      body: options.body,
    }
    this.options.output.write(encodeDapMessage(event))
  }
}

function dapExecutionCommand(command: string): ExecutionCommand | null {
  if (command === "continue") return "continue"
  if (command === "next") return "next"
  if (command === "stepIn") return "stepIn"
  if (command === "stepOut") return "stepOut"
  return null
}
