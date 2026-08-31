import { spawn, type ChildProcess } from "node:child_process"
import { watch, type FSWatcher } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { basename, join, normalize, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  AnyMap,
  generatedPositionFor,
  LEAST_UPPER_BOUND,
  originalPositionFor,
  type TraceMap,
} from "@jridgewell/trace-mapping"
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
import { InspectorAnnouncementReader, isNextProgram } from "./node-next"

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

interface LoadedSourceMap {
  contents: string
  generatedFile: string
  map: TraceMap
  scriptId?: string
}

interface BoundBreakpoint {
  breakpointId?: string
  isVerified: boolean
  line?: number
  message?: string
}

interface NodeAdapterTiming {
  inspectorTimeout?: number
  pauseTimeout?: number
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
  private sourceMaps = new Map<string, LoadedSourceMap>()
  private sourceMapLoads = new Map<string, Promise<void>>()
  private pausedFrames: Record<string, unknown>[] = []
  private breakpointIds = new Map<string, string[]>()
  private configuredBreakpoints = new Map<
    string,
    SetBreakpointsOptions["breakpoints"]
  >()
  private unresolvedBreakpointFiles = new Set<string>()
  private nextWorkspace: string | null = null
  private sourceMapWatcher: FSWatcher | null = null
  private initialPausePromise: Promise<StopResult> | null = null
  private isPaused = false

  constructor(private timing: NodeAdapterTiming = {}) {}

  async launch(config: LaunchConfig): Promise<void> {
    const runtime = config.runtimeExecutable ?? "node"
    requireRuntime({ runtime })
    const port = await findFreePort()
    const isNextLaunch = isNextProgram(config.program)
    this.nextWorkspace = isNextLaunch
      ? resolve(config.cwd ?? process.cwd())
      : null
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
        stdio: isNextLaunch ? ["ignore", "ignore", "pipe"] : "ignore",
      },
    )
    this.isProcessOwned = true
    const inspectorAnnouncements = isNextLaunch
      ? new InspectorAnnouncementReader(this.process.stderr)
      : null
    try {
      await this.connectWebSocket(await this.waitForDebugger({ port }))
      const launcherPause = this.waitForPause()
      await this.enableDebugger()
      if (!inspectorAnnouncements) {
        this.initialPausePromise = launcherPause
        return
      }

      await launcherPause
      const childInspectorUrl = inspectorAnnouncements.waitForChild({
        parentPort: port,
      })
      this.isPaused = false
      await this.cdpSend({ method: "Debugger.resume", parameters: {} })
      await this.connectToNextChild(await childInspectorUrl)
    } finally {
      inspectorAnnouncements?.close()
    }
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
    await this.connectWebSocket(
      await this.waitForDebugger({
        port,
        host,
        timeout: ATTACH_INSPECTOR_TIMEOUT,
      }),
    )
    this.initialPausePromise = this.waitForPause()
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
    await Promise.all(this.sourceMapLoads.values())
    await Promise.all(
      (this.breakpointIds.get(options.file) ?? []).map((breakpointId) =>
        this.cdpSend({
          method: "Debugger.removeBreakpoint",
          parameters: { breakpointId },
        }),
      ),
    )
    if (options.breakpoints.length === 0) {
      this.configuredBreakpoints.delete(options.file)
      this.unresolvedBreakpointFiles.delete(options.file)
    } else {
      this.configuredBreakpoints.set(options.file, options.breakpoints)
      this.unresolvedBreakpointFiles.delete(options.file)
      await this.discoverNextSourceMaps(options.file)
    }
    const breakpointEntries = await Promise.all(
      options.breakpoints.map(async (breakpoint, index) => {
        const direct = await this.setDirectBreakpoint({
          file: options.file,
          breakpoint,
        })
        const mapped = await Promise.all(
          Array.from(this.sourceMaps.values()).map((sourceMap) =>
            this.setSourceMappedBreakpoint({
              file: options.file,
              breakpoint,
              sourceMap,
            }),
          ),
        )
        const mappedBindings = mapped.filter(
          (binding): binding is BoundBreakpoint => binding !== null,
        )
        const isSourceMapped = mappedBindings.some(
          (binding) => binding.isVerified,
        )
        return {
          breakpointIds: [direct, ...mappedBindings].flatMap((binding) =>
            binding.breakpointId ? [binding.breakpointId] : [],
          ),
          result: {
            id: index,
            verified: direct.isVerified || isSourceMapped,
            line: isSourceMapped
              ? breakpoint.line
              : direct.line ?? breakpoint.line,
            message: direct.message,
          },
        }
      }),
    )
    this.breakpointIds.set(
      options.file,
      breakpointEntries.flatMap((entry) => entry.breakpointIds),
    )
    if (breakpointEntries.some((entry) => !entry.result.verified)) {
      this.unresolvedBreakpointFiles.add(options.file)
      this.startNextSourceMapWatcher()
    } else {
      this.unresolvedBreakpointFiles.delete(options.file)
      this.closeSourceMapWatcherIfResolved()
    }
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
      const sourceMap = scriptId
        ? Array.from(this.sourceMaps.values()).find(
            (candidate) => candidate.scriptId === scriptId,
          )
        : undefined
      const original = sourceMap
        ? originalPositionFor(sourceMap.map, {
            line: line + 1,
            column,
          })
        : null
      const originalFile = original?.source
        ? filePathFromUrl(original.source)
        : null
      const file = originalFile ?? (scriptId ? this.scripts.get(scriptId) : undefined)
      return [
        {
          id,
          name: original?.name ?? (stringValue(frame.functionName) || "(anonymous)"),
          source: file ? { path: file, name: basename(file) } : undefined,
          line: original?.line ?? line + 1,
          column: original?.column === null || original?.column === undefined
            ? column + 1
            : original.column + 1,
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
    this.sourceMapWatcher?.close()
    this.sourceMapWatcher = null
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

  private async connectToNextChild(url: string): Promise<void> {
    this.closeWebSocketForHandoff()
    this.scripts.clear()
    this.sourceMaps.clear()
    this.sourceMapLoads.clear()
    this.pausedFrames = []
    this.breakpointIds.clear()
    this.configuredBreakpoints.clear()
    this.unresolvedBreakpointFiles.clear()
    this.isPaused = false
    await this.connectWebSocket(url)
    this.initialPausePromise = this.waitForPause()
    await this.enableDebugger()
    await new Promise((resolve) => setTimeout(resolve, ENTRY_PAUSE_DELAY))
    if (!this.isPaused) {
      await this.cdpSend({ method: "Debugger.pause", parameters: {} })
    }
  }

  private async setDirectBreakpoint(options: {
    file: string
    breakpoint: SetBreakpointsOptions["breakpoints"][number]
  }): Promise<BoundBreakpoint> {
    try {
      const response = await this.cdpSend({
        method: "Debugger.setBreakpointByUrl",
        parameters: {
          lineNumber: options.breakpoint.line - 1,
          url: pathToFileURL(options.file).href,
          columnNumber: options.breakpoint.column
            ? options.breakpoint.column - 1
            : undefined,
          condition: options.breakpoint.condition,
        },
      })
      const locations = arrayValue(response.locations)
        .map(recordValue)
        .filter((location) => location !== undefined)
      const lineNumber = numberValue(locations[0]?.lineNumber)
      return {
        breakpointId: stringValue(response.breakpointId),
        isVerified: locations.length > 0,
        line: lineNumber === undefined
          ? options.breakpoint.line
          : lineNumber + 1,
      }
    } catch (error) {
      return {
        isVerified: false,
        line: options.breakpoint.line,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async setSourceMappedBreakpoint(options: {
    file: string
    breakpoint: SetBreakpointsOptions["breakpoints"][number]
    sourceMap: LoadedSourceMap
  }): Promise<BoundBreakpoint | null> {
    const sourceUrl = pathToFileURL(options.file).href
    const source = options.sourceMap.map.resolvedSources.find(
      (candidate) => candidate === sourceUrl,
    )
    if (!source) return null
    const generated = generatedPositionFor(options.sourceMap.map, {
      source,
      line: options.breakpoint.line,
      column: options.breakpoint.column
        ? options.breakpoint.column - 1
        : 0,
      bias: LEAST_UPPER_BOUND,
    })
    if (generated.line === null || generated.column === null) return null
    try {
      const response = options.sourceMap.scriptId
        ? await this.cdpSend({
            method: "Debugger.setBreakpoint",
            parameters: {
              location: {
                scriptId: options.sourceMap.scriptId,
                lineNumber: generated.line - 1,
                columnNumber: generated.column,
              },
              condition: options.breakpoint.condition,
            },
          })
        : await this.cdpSend({
            method: "Debugger.setBreakpointByUrl",
            parameters: {
              lineNumber: generated.line - 1,
              columnNumber: generated.column,
              urlRegex: exactFileUrlRegex(options.sourceMap.generatedFile),
              condition: options.breakpoint.condition,
            },
          })
      return {
        breakpointId: stringValue(response.breakpointId),
        isVerified: options.sourceMap.scriptId
          ? recordValue(response.actualLocation) !== undefined
          : stringValue(response.breakpointId) !== undefined,
        line: options.breakpoint.line,
      }
    } catch {
      return null
    }
  }

  private async bindConfiguredBreakpoints(
    sourceMap: LoadedSourceMap,
  ): Promise<void> {
    await Promise.all(
      Array.from(this.configuredBreakpoints).map(async ([file, breakpoints]) => {
        const bindings = await Promise.all(
          breakpoints.map((breakpoint) =>
            this.setSourceMappedBreakpoint({ file, breakpoint, sourceMap }),
          ),
        )
        const resolvedBindings = bindings.filter(
          (binding): binding is BoundBreakpoint => binding !== null,
        )
        const existingIds = this.breakpointIds.get(file) ?? []
        this.breakpointIds.set(
          file,
          [
            ...existingIds,
            ...resolvedBindings.flatMap((binding) =>
              binding.breakpointId ? [binding.breakpointId] : [],
            ),
          ],
        )
        if (
          bindings.length === breakpoints.length &&
          bindings.every((binding) => binding?.isVerified === true)
        ) {
          this.unresolvedBreakpointFiles.delete(file)
          this.closeSourceMapWatcherIfResolved()
        }
      }),
    )
  }

  private async loadSourceMap(options: {
    generatedUrl: string
    scriptId: string
    sourceMapUrl: string
  }): Promise<void> {
    const mapUrl = sourceMapFileUrl(options)
    if (!mapUrl) return
    const generatedFile = fileURLToPath(options.generatedUrl)
    await this.loadSourceMapFile({
      generatedFile,
      mapUrl,
      scriptId: options.scriptId,
      shouldBindConfiguredBreakpoints: true,
    })
    this.sourceMapLoads.delete(generatedFile)
  }

  private async discoverNextSourceMaps(file: string): Promise<void> {
    if (!this.nextWorkspace) return
    const buildDirectory = join(this.nextWorkspace, ".next")
    try {
      const entries = await readdir(buildDirectory, { recursive: true })
      const sourceFileName = basename(file)
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".js.map"))
          .map(async (entry) => {
            const mapFile = join(buildDirectory, entry)
            const contents = await readFile(mapFile, "utf8")
            if (!contents.includes(sourceFileName)) return
            const generatedFile = mapFile.slice(0, -".map".length)
            await this.loadSourceMapFile({
              contents,
              generatedFile,
              mapUrl: pathToFileURL(mapFile),
              shouldBindConfiguredBreakpoints: false,
            })
          }),
      )
    } catch {
      // Next.js may not have created its build directory yet.
    }
  }

  private async loadSourceMapFile(options: {
    contents?: string
    generatedFile: string
    mapUrl: URL
    scriptId?: string
    shouldBindConfiguredBreakpoints: boolean
  }): Promise<boolean> {
    try {
      const contents = options.contents
        ?? await readFile(fileURLToPath(options.mapUrl), "utf8")
      const existing = this.sourceMaps.get(options.generatedFile)
      const loaded = {
        contents,
        generatedFile: options.generatedFile,
        map: new AnyMap(JSON.parse(contents), options.mapUrl.href),
        scriptId: options.scriptId ?? existing?.scriptId,
      }
      this.sourceMaps.set(options.generatedFile, loaded)
      if (
        options.shouldBindConfiguredBreakpoints &&
        existing?.contents !== contents
      ) {
        await this.bindConfiguredBreakpoints(loaded)
      }
      return true
    } catch {
      return false
    }
  }

  private startNextSourceMapWatcher(): void {
    if (!this.nextWorkspace || this.sourceMapWatcher) return
    try {
      const watcher = watch(
        this.nextWorkspace,
        { recursive: true },
        (_eventType, fileName) => {
          if (!fileName) return
          const relativeFile = normalize(String(fileName)).replaceAll("\\", "/")
          if (
            !relativeFile.includes(".next/") ||
            !relativeFile.endsWith(".js.map")
          ) {
            return
          }
          const workspace = this.nextWorkspace
          if (workspace) {
            void this.loadWatchedSourceMap(join(workspace, relativeFile))
          }
        },
      )
      this.sourceMapWatcher = watcher
      watcher.on("error", () => {
        if (this.sourceMapWatcher !== watcher) return
        watcher.close()
        this.sourceMapWatcher = null
      })
    } catch {
      // Script-parsed events still support source maps when watching is unavailable.
    }
  }

  private async loadWatchedSourceMap(mapFile: string): Promise<void> {
    const generatedFile = mapFile.slice(0, -".map".length)
    const mapUrl = pathToFileURL(mapFile)
    const options = {
      generatedFile,
      mapUrl,
      shouldBindConfiguredBreakpoints: true,
    }
    if (await this.loadSourceMapFile(options)) return
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 50))
    await this.loadSourceMapFile(options)
  }

  private closeSourceMapWatcherIfResolved(): void {
    if (this.unresolvedBreakpointFiles.size > 0) return
    this.sourceMapWatcher?.close()
    this.sourceMapWatcher = null
  }

  private closeWebSocketForHandoff(): void {
    const currentWebSocket = this.webSocket
    this.webSocket = null
    currentWebSocket?.close()
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
    const timeout = options.timeout
      ?? this.timing.inspectorTimeout
      ?? INSPECTOR_TIMEOUT
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
        if (this.webSocket !== webSocket) return
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
        const sourceMapUrl = stringValue(parameters.sourceMapURL)
        if (sourceMapUrl && !url.includes("/node_modules/")) {
          const load = this.loadSourceMap({
            generatedUrl: url,
            scriptId,
            sourceMapUrl,
          })
          this.sourceMapLoads.set(fileURLToPath(url), load)
        }
      }
      return
    }
    if (method === "Debugger.paused") {
      this.isPaused = true
      this.pausedFrames = arrayValue(parameters.callFrames)
        .map(recordValue)
        .filter((frame) => frame !== undefined)
      const reason = stringValue(parameters.reason) ?? "breakpoint"
      const info = {
        reason,
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
      }, this.timing.pauseTimeout ?? WAIT_TIMEOUT)
      const cleanup = () => {
        clearTimeout(timer)
        this.stoppedCallbacks.delete(stopped)
        this.terminatedCallbacks.delete(terminated)
      }
      const stopped = async (info: StoppedInfo) => {
        cleanup()
        await Promise.all(this.sourceMapLoads.values())
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

function sourceMapFileUrl(options: {
  generatedUrl: string
  sourceMapUrl: string
}): URL | null {
  try {
    const url = new URL(options.sourceMapUrl, options.generatedUrl)
    return url.protocol === "file:" ? url : null
  } catch {
    return null
  }
}

function filePathFromUrl(url: string): string | null {
  try {
    return url.startsWith("file://") ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

function exactFileUrlRegex(file: string): string {
  const encodedUrl = pathToFileURL(file).href
  const unencodedUrl = `file://${normalize(file).replaceAll("\\", "/")}`
  return [
    "^(?:",
    escapeRegularExpression(encodedUrl),
    "|",
    escapeRegularExpression(unencodedUrl),
    ")$",
  ].join("")
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
