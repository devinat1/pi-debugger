import type { ChildProcess } from "node:child_process"
import { DapClient } from "../dap/client"
import type { StackFrame, Variable } from "../dap/types"
import type {
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  EvaluateOptions,
  GetVariablesOptions,
  SetBreakpointsOptions,
  StopResult,
  StoppedInfo,
  ThreadOptions,
} from "./base"
import {
  arrayValue,
  booleanValue,
  numberValue,
  recordValue,
  stringValue,
} from "../util/value"

const WAIT_TIMEOUT = 30_000
const DISCONNECT_TIMEOUT = 1_000

export abstract class TcpDapAdapter
  implements Omit<DebugAdapter, "id" | "launch" | "attach">
{
  protected client: DapClient | null = null
  protected adapterProcess: ChildProcess | null = null
  protected shouldTerminateDebuggee = false
  protected threadId = 1
  protected frameIds: number[] = []
  protected isPaused = false
  private stoppedCallbacks = new Set<(event: StoppedInfo) => void>()
  private initialPausePromise: Promise<StopResult> | null = null

  protected useClient(client: DapClient): void {
    this.client = client
    client.on({
      event: "stopped",
      handler: (body) => {
        this.isPaused = true
        this.threadId = numberValue(body.threadId) ?? 1
        const info = {
          reason: stringValue(body.reason) ?? "breakpoint",
          threadId: this.threadId,
          description: stringValue(body.description),
        }
        this.stoppedCallbacks.forEach((callback) => callback(info))
      }
    })
    client.on({
      event: "continued",
      handler: () => {
        this.isPaused = false
        this.frameIds = []
      },
    })
  }

  protected beginInitialPause(): void {
    this.initialPausePromise = this.waitForStop()
  }

  protected async initialize(adapterID: string): Promise<void> {
    await this.requireClient().sendRequest({
      command: "initialize",
      arguments: {
        clientID: "pi-debugger",
        clientName: "pi Debugger",
        adapterID,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsRunInTerminalRequest: false,
      },
    })
  }

  protected async configure(options: {
    command: "launch" | "attach"
    arguments: Record<string, unknown>
  }): Promise<void> {
    const client = this.requireClient()
    const initialized = client.once({ event: "initialized" })
    const configured = client.sendRequest(options)
    await initialized
    await client.sendRequest({ command: "configurationDone", arguments: {} })
    await configured
  }

  protected async pauseAttachedTarget(): Promise<void> {
    if (this.isPaused) return
    const response = await this.requireClient().sendRequest({
      command: "threads",
      arguments: {},
    })
    const threads = arrayValue(response.body?.threads)
    const thread = recordValue(threads[0])
    const threadId = numberValue(thread?.id)
    if (!threadId) return
    this.threadId = threadId
    await this.requireClient().sendRequest({
      command: "pause",
      arguments: { threadId },
    })
  }

  async waitForInitialPause(): Promise<StopResult> {
    if (!this.initialPausePromise) return { reason: "attached" }
    const result = await this.initialPausePromise
    this.initialPausePromise = null
    return result
  }

  async setBreakpoints(
    options: SetBreakpointsOptions,
  ): Promise<BreakpointResult[]> {
    const response = await this.requireClient().sendRequest({
      command: "setBreakpoints",
      arguments: {
        source: { path: options.file },
        breakpoints: options.breakpoints,
      },
    })
    return arrayValue(response.body?.breakpoints).map((value) => {
      const breakpoint = recordValue(value) ?? {}
      return {
        id: numberValue(breakpoint.id),
        verified: booleanValue(breakpoint.verified) ?? false,
        line: numberValue(breakpoint.line),
        message: stringValue(breakpoint.message),
      }
    })
  }

  async continue(options?: ThreadOptions): Promise<StopResult> {
    return this.resume({ command: "continue", threadId: options?.threadId })
  }

  async stepOver(options?: ThreadOptions): Promise<StopResult> {
    return this.resume({ command: "next", threadId: options?.threadId })
  }

  async stepIn(options?: ThreadOptions): Promise<StopResult> {
    return this.resume({ command: "stepIn", threadId: options?.threadId })
  }

  async stepOut(options?: ThreadOptions): Promise<StopResult> {
    return this.resume({ command: "stepOut", threadId: options?.threadId })
  }

  async getCallStack(options?: ThreadOptions): Promise<StackFrame[]> {
    const response = await this.requireClient().sendRequest({
      command: "stackTrace",
      arguments: {
        threadId: options?.threadId ?? this.threadId,
        startFrame: 0,
        levels: 50,
      },
    })
    const frames = arrayValue(response.body?.stackFrames)
      .map(recordValue)
      .filter((frame) => frame !== undefined)
    this.frameIds = frames
      .map((frame) => numberValue(frame.id))
      .filter((id) => id !== undefined)
    return frames.flatMap((frame) => {
      const id = numberValue(frame.id)
      const name = stringValue(frame.name)
      const line = numberValue(frame.line)
      const column = numberValue(frame.column)
      if (id === undefined || !name || line === undefined || column === undefined)
        return []
      const source = recordValue(frame.source)
      return [
        {
          id,
          name,
          source: source
            ? {
                path: stringValue(source.path),
                name: stringValue(source.name),
              }
            : undefined,
          line,
          column,
        },
      ]
    })
  }

  async getVariables(options?: GetVariablesOptions): Promise<Variable[]> {
    if (this.frameIds.length === 0) await this.getCallStack()
    const targetFrameId = options?.frameId ?? this.frameIds[0]
    if (targetFrameId === undefined) return []
    const scopesResponse = await this.requireClient().sendRequest({
      command: "scopes",
      arguments: { frameId: targetFrameId },
    })
    const scopes = arrayValue(scopesResponse.body?.scopes)
      .map(recordValue)
      .filter((item) => item !== undefined)
    const selected = options?.scope
      ? scopes.filter(
          (item) =>
            stringValue(item.name)?.toLowerCase() === options.scope?.toLowerCase(),
        )
      : scopes.filter((item) =>
          stringValue(item.name)?.toLowerCase().includes("local"),
        )
    const variables = await Promise.all(
      (selected.length > 0 ? selected : scopes.slice(0, 1)).map(async (item) => {
        const variablesReference = numberValue(item.variablesReference)
        if (variablesReference === undefined) return []
        const response = await this.requireClient().sendRequest({
          command: "variables",
          arguments: { variablesReference },
        })
        return arrayValue(response.body?.variables).flatMap((value) => {
          const variable = recordValue(value)
          const name = stringValue(variable?.name)
          const result = stringValue(variable?.value)
          if (!name || result === undefined) return []
          return [
            {
              name,
              value: result,
              type: stringValue(variable?.type),
              variablesReference: numberValue(variable?.variablesReference) ?? 0,
            },
          ]
        })
      }),
    )
    return variables.flat()
  }

  async evaluate(options: EvaluateOptions): Promise<EvalResult> {
    if (this.frameIds.length === 0 && this.isPaused) await this.getCallStack()
    const response = await this.requireClient().sendRequest({
      command: "evaluate",
      arguments: {
        expression: options.expression,
        frameId: options.frameId ?? this.frameIds[0],
        context: "repl",
      },
    })
    return {
      result: stringValue(response.body?.result) ?? "",
      type: stringValue(response.body?.type),
      variablesReference: numberValue(response.body?.variablesReference),
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await Promise.race([
          this.client.sendRequest({
            command: "disconnect",
            arguments: { terminateDebuggee: this.shouldTerminateDebuggee },
          }),
          new Promise((resolve) => setTimeout(resolve, DISCONNECT_TIMEOUT)),
        ])
      } catch {
        // The adapter may already be gone after target termination.
      }
      await this.client.disconnect()
      this.client = null
    }
    this.adapterProcess?.kill()
    this.adapterProcess = null
  }

  onStopped(callback: (event: StoppedInfo) => void): void {
    this.stoppedCallbacks.add(callback)
  }

  private async resume(options: {
    command: "continue" | "next" | "stepIn" | "stepOut"
    threadId?: number
  }): Promise<StopResult> {
    const stopped = this.waitForStop()
    this.isPaused = false
    await this.requireClient().sendRequest({
      command: options.command,
      arguments: { threadId: options.threadId ?? this.threadId },
    })
    return stopped
  }

  private waitForStop(): Promise<StopResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for debugger to stop."))
      }, WAIT_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timer)
        this.stoppedCallbacks.delete(handler)
        this.client?.off({ event: "terminated", handler: terminated })
        this.client?.off({ event: "exited", handler: terminated })
      }
      const handler = async (info: StoppedInfo) => {
        cleanup()
        try {
          const topFrame = (await this.getCallStack({ threadId: info.threadId }))[0]
          resolve({
            reason: info.reason,
            description: info.description,
            threadId: info.threadId,
            location: topFrame
              ? {
                  file: topFrame.source?.path,
                  line: topFrame.line,
                  column: topFrame.column,
                  name: topFrame.name,
                }
              : undefined,
          })
        } catch {
          resolve({ reason: info.reason, threadId: info.threadId })
        }
      }
      const terminated = () => {
        cleanup()
        resolve({ reason: "terminated", terminated: true })
      }
      this.stoppedCallbacks.add(handler)
      this.client?.on({ event: "terminated", handler: terminated })
      this.client?.on({ event: "exited", handler: terminated })
    })
  }

  private requireClient(): DapClient {
    if (!this.client) throw new Error("Debugger is not connected.")
    return this.client
  }
}
