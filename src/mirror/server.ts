import { basename, resolve } from "node:path"
import type { Readable, Writable } from "node:stream"
import type {
  BreakpointProjectionSource,
} from "../breakpoint/state"
import {
  breakpointKey,
  type MirroredBreakpoint,
} from "../breakpoint/projection"
import { DapMessageDecoder, encodeDapMessage } from "../dap/codec"
import type { Event, Request, Response } from "../dap/types"
import { arrayValue, numberValue, recordValue, stringValue } from "../util/value"

const READ_ONLY_MESSAGE =
  "The pi breakpoint mirror is read-only. Use pi to control the debugger."

export class BreakpointMirrorServer {
  private currentProjection: MirroredBreakpoint[] = []
  private announcedProjection: MirroredBreakpoint[] = []
  private breakpointIds = new Map<string, number>()
  private decoder = new DapMessageDecoder()
  private finish: (() => void) | null = null
  private isConfigured = false
  private isStopped = false
  private nextBreakpointId = 1
  private sequence = 1

  constructor(
    private options: {
      input: Readable
      output: Writable
      source: BreakpointProjectionSource
    },
  ) {}

  async run(): Promise<void> {
    const stopped = new Promise<void>((resolveStopped) => {
      this.finish = resolveStopped
    })
    await this.options.source.start({
      onChange: (breakpoints) => this.updateProjection(breakpoints),
    })
    this.options.input.on("data", (data: Buffer | string) => {
      this.decoder.push(Buffer.from(data)).forEach((message) => {
        if (message.type === "request") this.handleRequest(message)
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
    this.options.source.stop()
    this.finish?.()
    this.finish = null
  }

  private handleRequest(request: Request): void {
    if (request.command === "initialize") {
      this.sendResponse({
        request,
        body: {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: false,
          supportsHitConditionalBreakpoints: false,
          supportsLogPoints: false,
          supportsTerminateRequest: true,
        },
      })
      this.sendEvent({ event: "initialized" })
      return
    }
    if (request.command === "launch" || request.command === "attach") {
      this.sendResponse({ request })
      return
    }
    if (request.command === "configurationDone") {
      this.sendResponse({ request })
      this.isConfigured = true
      this.emitProjectionChanges({
        previous: this.announcedProjection,
        next: this.currentProjection,
      })
      this.announcedProjection = this.currentProjection
      return
    }
    if (request.command === "setBreakpoints") {
      this.handleSetBreakpoints(request)
      return
    }
    if (request.command === "setExceptionBreakpoints") {
      this.sendResponse({ request, body: { breakpoints: [] } })
      return
    }
    if (request.command === "threads") {
      this.sendResponse({ request, body: { threads: [] } })
      return
    }
    if (request.command === "disconnect" || request.command === "terminate") {
      this.sendResponse({ request })
      this.stop()
      return
    }
    this.sendResponse({
      request,
      isSuccessful: false,
      message: READ_ONLY_MESSAGE,
    })
  }

  private handleSetBreakpoints(request: Request): void {
    const source = recordValue(request.arguments?.source)
    const sourcePath = stringValue(source?.path)
    const requestedBreakpoints = arrayValue(request.arguments?.breakpoints)
      .map(recordValue)
      .filter((item) => item !== undefined)
    const breakpoints = requestedBreakpoints.map((item) => {
      const line = numberValue(item.line)
      const column = numberValue(item.column)
      const requested = sourcePath && line
        ? { file: resolve(sourcePath), line, column }
        : null
      const mirrored = requested
        ? this.currentProjection.find(
            (breakpoint) => breakpointKey(breakpoint) === breakpointKey(requested),
          )
        : undefined
      if (mirrored) return this.dapBreakpoint(mirrored)
      return {
        verified: false,
        source: sourcePath ? { path: resolve(sourcePath) } : undefined,
        line,
        column,
        message: READ_ONLY_MESSAGE,
      }
    })
    this.sendResponse({ request, body: { breakpoints } })
    if (!this.isConfigured || !sourcePath) return
    const requestedKeys = new Set(
      requestedBreakpoints.flatMap((item) => {
        const line = numberValue(item.line)
        if (!line) return []
        return [
          breakpointKey({
            file: resolve(sourcePath),
            line,
            column: numberValue(item.column),
          }),
        ]
      }),
    )
    this.currentProjection
      .filter(
        (breakpoint) =>
          breakpoint.file === resolve(sourcePath) &&
          !requestedKeys.has(breakpointKey(breakpoint)),
      )
      .forEach((breakpoint) =>
        this.sendBreakpointEvent({ reason: "new", breakpoint }),
      )
  }

  private updateProjection(breakpoints: MirroredBreakpoint[]): void {
    const previous = this.announcedProjection
    this.currentProjection = breakpoints
    if (!this.isConfigured) return
    this.emitProjectionChanges({ previous, next: breakpoints })
    this.announcedProjection = breakpoints
  }

  private emitProjectionChanges(options: {
    previous: MirroredBreakpoint[]
    next: MirroredBreakpoint[]
  }): void {
    const previousByKey = new Map(
      options.previous.map((breakpoint) => [breakpointKey(breakpoint), breakpoint]),
    )
    const nextByKey = new Map(
      options.next.map((breakpoint) => [breakpointKey(breakpoint), breakpoint]),
    )
    options.previous
      .filter((breakpoint) => !nextByKey.has(breakpointKey(breakpoint)))
      .forEach((breakpoint) =>
        this.sendBreakpointEvent({ reason: "removed", breakpoint }),
      )
    options.next.forEach((breakpoint) => {
      const previous = previousByKey.get(breakpointKey(breakpoint))
      if (!previous) {
        this.sendBreakpointEvent({ reason: "new", breakpoint })
        return
      }
      if (previous.verified !== breakpoint.verified) {
        this.sendBreakpointEvent({ reason: "changed", breakpoint })
      }
    })
  }

  private sendBreakpointEvent(options: {
    reason: "new" | "changed" | "removed"
    breakpoint: MirroredBreakpoint
  }): void {
    this.sendEvent({
      event: "breakpoint",
      body: {
        reason: options.reason,
        breakpoint: this.dapBreakpoint(options.breakpoint),
      },
    })
  }

  private dapBreakpoint(breakpoint: MirroredBreakpoint): Record<string, unknown> {
    return {
      id: this.breakpointId(breakpoint),
      verified: breakpoint.verified,
      source: {
        name: basename(breakpoint.file),
        path: breakpoint.file,
      },
      line: breakpoint.line,
      column: breakpoint.column,
    }
  }

  private breakpointId(breakpoint: MirroredBreakpoint): number {
    const key = breakpointKey(breakpoint)
    const existing = this.breakpointIds.get(key)
    if (existing !== undefined) return existing
    const id = this.nextBreakpointId++
    this.breakpointIds.set(key, id)
    return id
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
