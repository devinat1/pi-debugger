import { spawn, type ChildProcess } from "node:child_process"
import { basename } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { StackFrame, Variable } from "../dap/types"
import type {
  AdapterType,
  AttachConfig,
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  EvaluateOptions,
  GetVariablesOptions,
  LaunchConfig,
  SetBreakpointsOptions,
  StopResult,
  StoppedInfo,
} from "./base"
import { findFreePort } from "../util/port"
import { findExecutable } from "../util/process"
import { arrayValue, numberValue, recordValue, stringValue } from "../util/value"

const WAIT_TIMEOUT = 30_000
const INSPECTOR_TIMEOUT = 10_000
const ATTACH_INSPECTOR_TIMEOUT = 15_000
const INSPECTOR_RETRY_DELAY = 100
const ENTRY_PAUSE_DELAY = 100
const RUNTIME_INSTALL_COMMANDS: Record<string, string> = {
  node: "brew install node",
  bun: "curl -fsSL https://bun.sh/install | bash",
  tsx: "npm install --global tsx",
  deno: "brew install deno",
}

/** Node/Bun/tsx/Deno debugger using their Chrome DevTools Protocol endpoint. */
export class NodeAdapter implements DebugAdapter {
  readonly id: AdapterType = "node"
  private process: ChildProcess | null = null
  private isProcessOwned = false
  private webSocket: WebSocket | null = null
  private sequence = 1
  private pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void
      reject: (error: Error) => void
    }
  >()
  private stoppedCallbacks = new Set<(event: StoppedInfo) => void>()
  private terminatedCallbacks = new Set<() => void>()
  private scripts = new Map<string, string>()
  private pausedFrames: Record<string, unknown>[] = []
  private breakpointIds = new Map<string, string[]>()
  private initialPausePromise: Promise<StopResult> | null = null
  private isPaused = false

  async launch(config: LaunchConfig): Promise<void> {
    const runtime = config.runtimeExecutable ?? "node"
    requireRuntime({ runtime })
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
    this.isProcessOwned = true
    this.initialPausePromise = this.waitForPause()
    await this.connectWebSocket(await this.waitForDebugger({ port }))
    await this.enableDebugger()
  }

  async attach(config: AttachConfig): Promise<void> {
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? 9229 : undefined)
    if (!port) throw new Error("Node attach requires an inspector port or PID.")
    if (config.pid && !config.port) {
      if (process.platform === "win32") {
        throw new Error(
          "Node PID attach is unsupported on Windows; use an inspector port.",
        )
      }
      process.kill(config.pid, "SIGUSR1")
    }
    this.initialPausePromise = this.waitForPause()
    await this.connectWebSocket(
      await this.waitForDebugger({
        port,
        host,
        timeout: ATTACH_INSPECTOR_TIMEOUT,
      }),
    )
    await this.enableDebugger()
    // An --inspect-brk target reports its entry pause asynchronously after
    // runIfWaitingForDebugger. Give that event priority over a forced pause.
    await new Promise((resolve) => setTimeout(resolve, ENTRY_PAUSE_DELAY))
    if (!this.isPaused) {
      await this.cdpSend({ method: "Debugger.pause", parameters: {} })
    }
  }

  async waitForInitialPause(): Promise<StopResult> {
    if (!this.initialPausePromise) return { reason: "attached" }
    const result = await this.initialPausePromise
    this.initialPausePromise = null
    return result
  }

  async setBreakpoints(options: SetBreakpointsOptions): Promise<BreakpointResult[]> {
    await Promise.all(
      (this.breakpointIds.get(options.file) ?? []).map((breakpointId) =>
        this.cdpSend({
          method: "Debugger.removeBreakpoint",
          parameters: { breakpointId },
        }),
      ),
    )
    const breakpointEntries = await Promise.all(
      options.breakpoints.map(async (breakpoint, index) => {
        try {
          const response = await this.cdpSend({
            method: "Debugger.setBreakpointByUrl",
            parameters: {
              lineNumber: breakpoint.line - 1,
              url: pathToFileURL(options.file).href,
              columnNumber: breakpoint.column ? breakpoint.column - 1 : undefined,
              condition: breakpoint.condition,
            },
          })
          const locations = arrayValue(response.locations)
            .map(recordValue)
            .filter((location) => location !== undefined)
          const lineNumber = numberValue(locations[0]?.lineNumber)
          return {
            breakpointId: stringValue(response.breakpointId),
            result: {
              id: index,
              verified: locations.length > 0,
              line: lineNumber === undefined ? breakpoint.line : lineNumber + 1,
            },
          }
        } catch (error) {
          return {
            breakpointId: undefined,
            result: {
              verified: false,
              line: breakpoint.line,
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }),
    )
    this.breakpointIds.set(
      options.file,
      breakpointEntries.flatMap((entry) =>
        entry.breakpointId ? [entry.breakpointId] : [],
      ),
    )
    return breakpointEntries.map((entry) => entry.result)
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

  async getVariables(options?: GetVariablesOptions): Promise<Variable[]> {
    const frame = this.pausedFrames[options?.frameId ?? 0]
    if (!frame) return []
    const scopes = arrayValue(frame.scopeChain)
      .map(recordValue)
      .filter((item) => item !== undefined)
    const selected = options?.scope
      ? scopes.filter((item) => stringValue(item.type) === options.scope)
      : scopes.filter((item) => ["local", "closure"].includes(stringValue(item.type) ?? ""))
    const variables = await Promise.all(
      selected.map(async (item) => {
        const object = recordValue(item.object)
        const objectId = stringValue(object?.objectId)
        return objectId
          ? this.getProperties({ objectId, maxDepth: options?.maxDepth ?? 1 })
          : []
      }),
    )
    return variables.flat()
  }

  async evaluate(options: EvaluateOptions): Promise<EvalResult> {
    const frame = this.pausedFrames[options.frameId ?? 0]
    const callFrameId = stringValue(frame?.callFrameId)
    const response = callFrameId
      ? await this.cdpSend({
          method: "Debugger.evaluateOnCallFrame",
          parameters: {
            callFrameId,
            expression: options.expression,
            generatePreview: true,
          },
        })
      : await this.cdpSend({
          method: "Runtime.evaluate",
          parameters: {
            expression: options.expression,
            generatePreview: true,
          },
        })
    return this.formatEvalResult(recordValue(response.result) ?? {})
  }

  async disconnect(): Promise<void> {
    this.webSocket?.close()
    this.webSocket = null
    if (this.isProcessOwned) this.process?.kill()
    this.process = null
  }

  onStopped(callback: (event: StoppedInfo) => void): void {
    this.stoppedCallbacks.add(callback)
  }

  private async enableDebugger(): Promise<void> {
    await this.cdpSend({ method: "Debugger.enable", parameters: {} })
    await this.cdpSend({ method: "Runtime.enable", parameters: {} })
    await this.cdpSend({
      method: "Runtime.runIfWaitingForDebugger",
      parameters: {},
    })
  }

  private async resume(method: string): Promise<StopResult> {
    const pause = this.waitForPause()
    this.isPaused = false
    await this.cdpSend({ method, parameters: {} })
    return pause
  }

  private async waitForDebugger(options: {
    port: number
    host?: string
    timeout?: number
  }): Promise<string> {
    const host = options.host ?? "127.0.0.1"
    const timeout = options.timeout ?? INSPECTOR_TIMEOUT
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try {
        const response = await fetch(`http://${host}:${options.port}/json`)
        const targets: unknown = await response.json()
        if (Array.isArray(targets)) {
          const url = targets
            .map((target) =>
              stringValue(recordValue(target)?.webSocketDebuggerUrl),
            )
            .find((candidate) => candidate !== undefined)
          if (url) return url
        }
      } catch {
        // The inspector has not opened its HTTP endpoint yet.
      }
      await new Promise((resolve) => setTimeout(resolve, INSPECTOR_RETRY_DELAY))
    }
    throw new Error(
      `Timed out waiting for Node inspector at ${host}:${options.port}.`,
    )
  }

  private async connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocket(url)
      webSocket.onopen = () => {
        this.webSocket = webSocket
        resolve()
      }
      webSocket.onerror = () =>
        reject(new Error(`WebSocket connection failed: ${url}.`))
      webSocket.onmessage = (event) => {
        try {
          this.handleCdpMessage(JSON.parse(String(event.data)))
        } catch {
          // Ignore malformed inspector messages.
        }
      }
      webSocket.onclose = () => {
        this.webSocket = null
        this.terminatedCallbacks.forEach((callback) => callback())
        this.terminatedCallbacks.clear()
      }
    })
  }

  private async cdpSend(options: {
    method: string
    parameters: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    if (!this.webSocket) throw new Error("Debugger is not connected.")
    const requestId = this.sequence++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.webSocket?.send(
        JSON.stringify({
          id: requestId,
          method: options.method,
          params: options.parameters,
        }),
      )
    })
  }

  private handleCdpMessage(value: unknown): void {
    const message = recordValue(value)
    if (!message) return
    const requestId = numberValue(message.id)
    if (requestId !== undefined) {
      const pending = this.pending.get(requestId)
      if (!pending) return
      this.pending.delete(requestId)
      const error = recordValue(message.error)
      if (error) {
        pending.reject(new Error(stringValue(error.message) ?? "CDP request failed."))
        return
      }
      pending.resolve(recordValue(message.result) ?? {})
      return
    }
    const method = stringValue(message.method)
    const parameters = recordValue(message.params) ?? {}
    if (method === "Debugger.scriptParsed") {
      const scriptId = stringValue(parameters.scriptId)
      const url = stringValue(parameters.url)
      if (scriptId && url?.startsWith("file://")) {
        this.scripts.set(scriptId, fileURLToPath(url))
      }
      return
    }
    if (method === "Debugger.paused") {
      this.isPaused = true
      this.pausedFrames = arrayValue(parameters.callFrames)
        .map(recordValue)
        .filter((frame) => frame !== undefined)
      const info = {
        reason: stringValue(parameters.reason) ?? "breakpoint",
        threadId: 1,
      }
      this.stoppedCallbacks.forEach((callback) => callback(info))
      return
    }
    if (method === "Debugger.resumed") {
      this.isPaused = false
      this.pausedFrames = []
    }
  }

  private waitForPause(): Promise<StopResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for debugger to pause."))
      }, WAIT_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timer)
        this.stoppedCallbacks.delete(stopped)
        this.terminatedCallbacks.delete(terminated)
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
      this.stoppedCallbacks.add(stopped)
      this.terminatedCallbacks.add(terminated)
    })
  }

  private async getProperties(options: {
    objectId: string
    maxDepth: number
  }): Promise<Variable[]> {
    const response = await this.cdpSend({
      method: "Runtime.getProperties",
      parameters: {
        objectId: options.objectId,
        ownProperties: true,
        generatePreview: options.maxDepth > 0,
      },
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

export function requireRuntime(options: {
  runtime: string
  resolver?: (name: string) => string | null
}): string {
  const found = (options.resolver ?? findExecutable)(options.runtime)
  if (found) return found
  const name = basename(options.runtime)
  throw new Error(
    `${name} not found on PATH. Install it with the following command.\n${
      RUNTIME_INSTALL_COMMANDS[name] ?? `brew install ${name}`
    }`,
  )
}
