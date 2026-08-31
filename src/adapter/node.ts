import { spawn, type ChildProcess } from "node:child_process"
import { basename } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { SourceBreakpoint, StackFrame, Variable } from "../dap/types"
import type {
  AttachConfig,
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  LaunchConfig,
  StopResult,
  StoppedInfo,
} from "./base"
import { findFreePort } from "../util/port"
import { findExecutable } from "../util/process"

interface CdpResponse {
  id: number
  result?: Record<string, unknown>
  error?: { message: string }
}

interface CdpEvent {
  method: string
  params?: Record<string, unknown>
}

const WAIT_TIMEOUT = 30_000

/** Node/Bun/tsx/Deno debugger using their Chrome DevTools Protocol endpoint. */
export class NodeAdapter implements DebugAdapter {
  readonly id = "node" as const
  private process: ChildProcess | null = null
  private ownsProcess = false
  private ws: WebSocket | null = null
  private seq = 1
  private pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void
      reject: (error: Error) => void
    }
  >()
  private stoppedCallbacks: Array<(event: StoppedInfo) => void> = []
  private terminatedCallbacks: Array<() => void> = []
  private scripts = new Map<string, string>()
  private pausedFrames: Record<string, unknown>[] = []
  private breakpointIds = new Map<string, string[]>()
  private initialPausePromise: Promise<StopResult> | null = null
  private paused = false

  async launch(config: LaunchConfig): Promise<void> {
    const runtime = config.runtimeExecutable ?? "node"
    requireRuntime(runtime)
    const port = await findFreePort()
    this.process = spawn(
      runtime,
      [
        ...(config.runtimeArgs ?? []),
        `--inspect-brk=127.0.0.1:${port}`,
        config.program,
        ...(config.args ?? []),
      ],
      {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: "ignore",
      },
    )
    this.ownsProcess = true
    this.initialPausePromise = this.waitForPause()
    await this.connectWebSocket(await this.waitForDebugger(port))
    await this.enableDebugger()
  }

  async attach(config: AttachConfig): Promise<void> {
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? 9229 : undefined)
    if (!port) throw new Error("Node attach requires an inspector port or pid")
    if (config.pid && !config.port) {
      if (process.platform === "win32") {
        throw new Error("Node PID attach is unsupported on Windows; use an inspector port")
      }
      process.kill(config.pid, "SIGUSR1")
    }
    this.initialPausePromise = this.waitForPause()
    await this.connectWebSocket(await this.waitForDebugger(port, host, 15_000))
    await this.enableDebugger()
    // An --inspect-brk target reports its entry pause asynchronously after
    // runIfWaitingForDebugger. Give that event priority over a forced pause.
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!this.paused) await this.cdpSend("Debugger.pause", {})
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
    for (const breakpointId of this.breakpointIds.get(file) ?? []) {
      await this.cdpSend("Debugger.removeBreakpoint", { breakpointId })
    }
    const results: BreakpointResult[] = []
    const ids: string[] = []
    for (const breakpoint of breakpoints) {
      try {
        const response = await this.cdpSend("Debugger.setBreakpointByUrl", {
          lineNumber: breakpoint.line - 1,
          url: pathToFileURL(file).href,
          columnNumber: breakpoint.column ? breakpoint.column - 1 : undefined,
          condition: breakpoint.condition,
        })
        const breakpointId = stringValue(response.breakpointId)
        const locations = arrayValue(response.locations)
          .map(recordValue)
          .filter((location) => location !== undefined)
        if (breakpointId) ids.push(breakpointId)
        results.push({
          id: results.length,
          verified: locations.length > 0,
          line: numberValue(locations[0]?.lineNumber) !== undefined
            ? numberValue(locations[0]?.lineNumber)! + 1
            : breakpoint.line,
        })
      } catch (error) {
        results.push({
          verified: false,
          line: breakpoint.line,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.breakpointIds.set(file, ids)
    return results
  }

  async continue(): Promise<StopResult> {
    return this.resume("Debugger.resume")
  }

  async stepOver(): Promise<StopResult> {
    return this.resume("Debugger.stepOver")
  }

  async stepIn(): Promise<StopResult> {
    return this.resume("Debugger.stepInto")
  }

  async stepOut(): Promise<StopResult> {
    return this.resume("Debugger.stepOut")
  }

  async getCallStack(): Promise<StackFrame[]> {
    return this.pausedFrames.flatMap((frame, id) => {
      const location = recordValue(frame.location)
      const scriptId = stringValue(location?.scriptId)
      const line = numberValue(location?.lineNumber)
      const column = numberValue(location?.columnNumber)
      if (line === undefined || column === undefined) return []
      const file = scriptId ? this.scripts.get(scriptId) : undefined
      return [
        {
          id,
          name: stringValue(frame.functionName) || "(anonymous)",
          source: file ? { path: file, name: basename(file) } : undefined,
          line: line + 1,
          column: column + 1,
        },
      ]
    })
  }

  async getVariables(
    frameId = 0,
    scope?: string,
    maxDepth = 1,
  ): Promise<Variable[]> {
    const frame = this.pausedFrames[frameId]
    if (!frame) return []
    const scopes = arrayValue(frame.scopeChain)
      .map(recordValue)
      .filter((item) => item !== undefined)
    const selected = scope
      ? scopes.filter((item) => stringValue(item.type) === scope)
      : scopes.filter((item) => ["local", "closure"].includes(stringValue(item.type) ?? ""))
    const variables = await Promise.all(
      selected.map(async (item) => {
        const object = recordValue(item.object)
        const objectId = stringValue(object?.objectId)
        return objectId ? this.getProperties(objectId, maxDepth) : []
      }),
    )
    return variables.flat()
  }

  async evaluate(expression: string, frameId = 0): Promise<EvalResult> {
    const frame = this.pausedFrames[frameId]
    const callFrameId = stringValue(frame?.callFrameId)
    const response = callFrameId
      ? await this.cdpSend("Debugger.evaluateOnCallFrame", {
          callFrameId,
          expression,
          generatePreview: true,
        })
      : await this.cdpSend("Runtime.evaluate", {
          expression,
          generatePreview: true,
        })
    return this.formatEvalResult(recordValue(response.result) ?? {})
  }

  async disconnect(): Promise<void> {
    this.ws?.close()
    this.ws = null
    if (this.ownsProcess) this.process?.kill()
    this.process = null
  }

  onStopped(callback: (event: StoppedInfo) => void): void {
    this.stoppedCallbacks.push(callback)
  }

  private async enableDebugger(): Promise<void> {
    await this.cdpSend("Debugger.enable", {})
    await this.cdpSend("Runtime.enable", {})
    await this.cdpSend("Runtime.runIfWaitingForDebugger", {})
  }

  private async resume(method: string): Promise<StopResult> {
    const pause = this.waitForPause()
    this.paused = false
    await this.cdpSend(method, {})
    return pause
  }

  private async waitForDebugger(
    port: number,
    host = "127.0.0.1",
    timeout = 10_000,
  ): Promise<string> {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try {
        const response = await fetch(`http://${host}:${port}/json`)
        const targets = (await response.json()) as unknown
        if (Array.isArray(targets)) {
          for (const target of targets) {
            const url = stringValue(recordValue(target)?.webSocketDebuggerUrl)
            if (url) return url
          }
        }
      } catch {
        // The inspector has not opened its HTTP endpoint yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for Node inspector at ${host}:${port}`)
  }

  private async connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onopen = () => {
        this.ws = ws
        resolve()
      }
      ws.onerror = () => reject(new Error(`WebSocket connection failed: ${url}`))
      ws.onmessage = (event) => {
        try {
          this.handleCdpMessage(JSON.parse(String(event.data)) as unknown)
        } catch {
          // Ignore malformed inspector messages.
        }
      }
      ws.onclose = () => {
        this.ws = null
        for (const callback of this.terminatedCallbacks) callback()
        this.terminatedCallbacks = []
      }
    })
  }

  private cdpSend(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ws) return Promise.reject(new Error("Debugger is not connected"))
    const id = this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify({ id, method, params }))
    })
  }

  private handleCdpMessage(value: unknown): void {
    const message = recordValue(value)
    if (!message) return
    const id = numberValue(message.id)
    if (id !== undefined) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      const error = recordValue(message.error)
      if (error) {
        pending.reject(new Error(stringValue(error.message) ?? "CDP request failed"))
        return
      }
      pending.resolve(recordValue(message.result) ?? {})
      return
    }
    const method = stringValue(message.method)
    const params = recordValue(message.params) ?? {}
    if (method === "Debugger.scriptParsed") {
      const scriptId = stringValue(params.scriptId)
      const url = stringValue(params.url)
      if (scriptId && url?.startsWith("file://")) {
        this.scripts.set(scriptId, fileURLToPath(url))
      }
      return
    }
    if (method === "Debugger.paused") {
      this.paused = true
      this.pausedFrames = arrayValue(params.callFrames)
        .map(recordValue)
        .filter((frame) => frame !== undefined)
      const info = { reason: stringValue(params.reason) ?? "breakpoint", threadId: 1 }
      for (const callback of this.stoppedCallbacks) callback(info)
      return
    }
    if (method === "Debugger.resumed") {
      this.paused = false
      this.pausedFrames = []
    }
  }

  private waitForPause(): Promise<StopResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for debugger to pause"))
      }, WAIT_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timer)
        const stoppedIndex = this.stoppedCallbacks.indexOf(stopped)
        if (stoppedIndex >= 0) this.stoppedCallbacks.splice(stoppedIndex, 1)
        const terminatedIndex = this.terminatedCallbacks.indexOf(terminated)
        if (terminatedIndex >= 0) this.terminatedCallbacks.splice(terminatedIndex, 1)
      }
      const stopped = async (info: StoppedInfo) => {
        cleanup()
        const frame = (await this.getCallStack())[0]
        resolve({
          reason: info.reason,
          threadId: info.threadId,
          location: frame
            ? {
                file: frame.source?.path,
                line: frame.line,
                column: frame.column,
                name: frame.name,
              }
            : undefined,
        })
      }
      const terminated = () => {
        cleanup()
        resolve({ reason: "terminated", terminated: true })
      }
      this.stoppedCallbacks.push(stopped)
      this.terminatedCallbacks.push(terminated)
    })
  }

  private async getProperties(
    objectId: string,
    maxDepth: number,
  ): Promise<Variable[]> {
    const response = await this.cdpSend("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      generatePreview: maxDepth > 0,
    })
    return arrayValue(response.result).flatMap((item) => {
      const property = recordValue(item)
      const value = recordValue(property?.value)
      const name = stringValue(property?.name)
      if (!name || name === "__proto__" || !value) return []
      return [
        {
          name,
          value: this.formatValue(value),
          type: stringValue(value.type),
          variablesReference: stringValue(value.objectId) ? 1 : 0,
        },
      ]
    })
  }

  private formatEvalResult(result: Record<string, unknown>): EvalResult {
    return {
      result: this.formatValue(result),
      type: stringValue(result.type),
      variablesReference: stringValue(result.objectId) ? 1 : 0,
    }
  }

  private formatValue(value: Record<string, unknown>): string {
    const type = stringValue(value.type)
    if (type === "undefined") return "undefined"
    if (type === "string") return JSON.stringify(value.value)
    if (type === "number" || type === "boolean") return String(value.value)
    if (value.value === null) return "null"
    return stringValue(value.description) ?? type ?? "unknown"
  }
}

export function requireRuntime(
  runtime: string,
  resolver: (name: string) => string | null = findExecutable,
): string {
  const found = resolver(runtime)
  if (found) return found
  const name = basename(runtime)
  const commands: Record<string, string> = {
    node: "brew install node",
    bun: "curl -fsSL https://bun.sh/install | bash",
    tsx: "npm install --global tsx",
    deno: "brew install deno",
  }
  throw new Error(
    `${name} not found on PATH. Install with: ${commands[name] ?? `brew install ${name}`}`,
  )
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}
