import type { ChildProcess } from "node:child_process"
import { DapClient } from "../dap/client"
import type { SourceBreakpoint, StackFrame, Variable } from "../dap/types"
import type {
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  StopResult,
  StoppedInfo,
} from "./base"

const WAIT_TIMEOUT = 30_000

export abstract class TcpDapAdapter
  implements Omit<DebugAdapter, "id" | "launch" | "attach">
{
  protected client: DapClient | null = null
  protected adapterProcess: ChildProcess | null = null
  protected terminateDebuggee = false
  protected threadId = 1
  protected frameIds: number[] = []
  protected paused = false
  private stoppedCallbacks: Array<(event: StoppedInfo) => void> = []
  private initialPausePromise: Promise<StopResult> | null = null

  protected useClient(client: DapClient): void {
    this.client = client
    client.on("stopped", (body) => {
      this.paused = true
      this.threadId = numberValue(body.threadId) ?? 1
      const info = {
        reason: stringValue(body.reason) ?? "breakpoint",
        threadId: this.threadId,
        description: stringValue(body.description),
      }
      for (const callback of this.stoppedCallbacks) callback(info)
    })
    client.on("continued", () => {
      this.paused = false
      this.frameIds = []
    })
  }

  protected beginInitialPause(): void {
    this.initialPausePromise = this.waitForStop()
  }

  protected async initialize(adapterID: string): Promise<void> {
    await this.requireClient().sendRequest("initialize", {
      clientID: "pi-debugger",
      clientName: "pi Debugger",
      adapterID,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    })
  }

  protected async configure(
    command: "launch" | "attach",
    args: Record<string, unknown>,
  ): Promise<void> {
    const client = this.requireClient()
    const initialized = client.once("initialized")
    const configured = client.sendRequest(command, args)
    await initialized
    await client.sendRequest("configurationDone", {})
    await configured
  }

  protected async pauseAttachedTarget(): Promise<void> {
    if (this.paused) return
    const response = await this.requireClient().sendRequest("threads", {})
    const threads = arrayValue(response.body?.threads)
    const thread = recordValue(threads[0])
    const threadId = numberValue(thread?.id)
    if (!threadId) return
    this.threadId = threadId
    await this.requireClient().sendRequest("pause", { threadId })
  }

  async waitForInitialPause(): Promise<StopResult> {
    if (!this.initialPausePromise) return { reason: "attached" }
    const result = await this.initialPausePromise
    this.initialPausePromise = null
    return result
  }

  async setBreakpoints(
    file: string,
    breakpoints: SourceBreakpoint[],
  ): Promise<BreakpointResult[]> {
    const response = await this.requireClient().sendRequest("setBreakpoints", {
      source: { path: file },
      breakpoints,
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

  async continue(threadId?: number): Promise<StopResult> {
    return this.resume("continue", threadId)
  }

  async stepOver(threadId?: number): Promise<StopResult> {
    return this.resume("next", threadId)
  }

  async stepIn(threadId?: number): Promise<StopResult> {
    return this.resume("stepIn", threadId)
  }

  async stepOut(threadId?: number): Promise<StopResult> {
    return this.resume("stepOut", threadId)
  }

  async getCallStack(threadId?: number): Promise<StackFrame[]> {
    const response = await this.requireClient().sendRequest("stackTrace", {
      threadId: threadId ?? this.threadId,
      startFrame: 0,
      levels: 50,
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

  async getVariables(
    frameId?: number,
    scope?: string,
    _maxDepth?: number,
  ): Promise<Variable[]> {
    if (this.frameIds.length === 0) await this.getCallStack()
    const targetFrameId = frameId ?? this.frameIds[0]
    if (targetFrameId === undefined) return []
    const scopesResponse = await this.requireClient().sendRequest("scopes", {
      frameId: targetFrameId,
    })
    const scopes = arrayValue(scopesResponse.body?.scopes)
      .map(recordValue)
      .filter((item) => item !== undefined)
    const selected = scope
      ? scopes.filter(
          (item) => stringValue(item.name)?.toLowerCase() === scope.toLowerCase(),
        )
      : scopes.filter((item) =>
          stringValue(item.name)?.toLowerCase().includes("local"),
        )
    const variables = await Promise.all(
      (selected.length > 0 ? selected : scopes.slice(0, 1)).map(async (item) => {
        const variablesReference = numberValue(item.variablesReference)
        if (variablesReference === undefined) return []
        const response = await this.requireClient().sendRequest("variables", {
          variablesReference,
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

  async evaluate(expression: string, frameId?: number): Promise<EvalResult> {
    if (this.frameIds.length === 0 && this.paused) await this.getCallStack()
    const response = await this.requireClient().sendRequest("evaluate", {
      expression,
      frameId: frameId ?? this.frameIds[0],
      context: "repl",
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
          this.client.sendRequest("disconnect", {
            terminateDebuggee: this.terminateDebuggee,
          }),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
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
    this.stoppedCallbacks.push(callback)
  }

  private async resume(
    command: "continue" | "next" | "stepIn" | "stepOut",
    threadId?: number,
  ): Promise<StopResult> {
    const stopped = this.waitForStop()
    this.paused = false
    await this.requireClient().sendRequest(command, {
      threadId: threadId ?? this.threadId,
    })
    return stopped
  }

  private waitForStop(): Promise<StopResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for debugger to stop"))
      }, WAIT_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timer)
        const index = this.stoppedCallbacks.indexOf(handler)
        if (index >= 0) this.stoppedCallbacks.splice(index, 1)
        this.client?.off("terminated", terminated)
        this.client?.off("exited", terminated)
      }
      const handler = async (info: StoppedInfo) => {
        cleanup()
        try {
          const topFrame = (await this.getCallStack(info.threadId))[0]
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
      this.stoppedCallbacks.push(handler)
      this.client?.on("terminated", terminated)
      this.client?.on("exited", terminated)
    })
  }

  private requireClient(): DapClient {
    if (!this.client) throw new Error("Debugger is not connected")
    return this.client
  }
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}
