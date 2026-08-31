import type {
  AdapterType,
  AttachConfig,
  DebugAdapter,
  LaunchConfig,
  SetBreakpointsOptions,
  StopResult,
} from "../adapter/base"
import {
  createBreakpointProjection,
  type MirroredBreakpoint,
} from "../breakpoint/projection"
import { createAdapter, detectType } from "../adapter/registry"
import {
  createSessionState,
  recordStop,
  type BreakpointInfo,
  type SessionState,
} from "./state"

export interface CreatedSession {
  session: SessionState
  initialStop: StopResult
}

export class SessionManager {
  private sessions = new Map<string, SessionState>()
  private breakpointListeners = new Set<
    (breakpoints: MirroredBreakpoint[]) => Promise<void>
  >()
  private counter = 0

  constructor(
    private adapterFactory: (type: AdapterType) => DebugAdapter = createAdapter,
  ) {}

  async launch(options: {
    config: Omit<LaunchConfig, "type"> & { type?: AdapterType }
    name?: string
  }): Promise<CreatedSession> {
    const adapterType = options.config.type ?? detectType(options.config.program)
    return this.create({
      mode: "launch",
      adapter: this.adapterFactory(adapterType),
      name: options.name,
      start: (adapter) => adapter.launch({ ...options.config, type: adapterType }),
    })
  }

  async attach(options: {
    config: AttachConfig
    name?: string
  }): Promise<CreatedSession> {
    return this.create({
      mode: "attach",
      adapter: this.adapterFactory(options.config.type),
      name: options.name,
      start: (adapter) => adapter.attach(options.config),
    })
  }

  require(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Debug session not found: ${sessionId}.`)
    return session
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
  }

  onBreakpointsChanged(
    listener: (breakpoints: MirroredBreakpoint[]) => Promise<void>,
  ): () => void {
    this.breakpointListeners.add(listener)
    return () => this.breakpointListeners.delete(listener)
  }

  async setBreakpoints(options: {
    sessionId: string
    file: string
    breakpoints: SetBreakpointsOptions["breakpoints"]
  }): Promise<BreakpointInfo[]> {
    const session = this.require(options.sessionId)
    const existing = session.breakpoints.get(options.file) ?? []
    const merged = options.breakpoints.reduce<BreakpointInfo[]>(
      (currentBreakpoints, item) => {
        const index = currentBreakpoints.findIndex(
          (current) => current.line === item.line,
        )
        const next = { ...item, verified: false }
        if (index < 0) return [...currentBreakpoints, next]
        return currentBreakpoints.map((current, currentIndex) =>
          currentIndex === index ? next : current,
        )
      },
      existing,
    )
    const results = await session.adapter.setBreakpoints({
      file: options.file,
      breakpoints: merged,
    })
    const updated = merged.map((item, index) => ({
      ...item,
      id: results[index]?.id,
      verified: results[index]?.verified ?? false,
      line: results[index]?.line ?? item.line,
      message: results[index]?.message,
    }))
    session.breakpoints.set(options.file, updated)
    await this.publishBreakpointChanges()
    return updated
  }

  async removeBreakpoints(options: {
    sessionId: string
    file: string
    lines?: number[]
  }): Promise<BreakpointInfo[]> {
    const session = this.require(options.sessionId)
    const remaining = options.lines
      ? (session.breakpoints.get(options.file) ?? []).filter(
          (item) => !options.lines?.includes(item.line),
        )
      : []
    const results = await session.adapter.setBreakpoints({
      file: options.file,
      breakpoints: remaining,
    })
    const updated = remaining.map((item, index) => ({
      ...item,
      id: results[index]?.id,
      verified: results[index]?.verified ?? false,
      message: results[index]?.message,
    }))
    if (updated.length > 0) session.breakpoints.set(options.file, updated)
    else session.breakpoints.delete(options.file)
    await this.publishBreakpointChanges()
    return updated
  }

  async stop(sessionId: string): Promise<SessionState> {
    const session = this.require(sessionId)
    await session.adapter.disconnect()
    this.sessions.delete(sessionId)
    await this.publishBreakpointChanges()
    return session
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.adapter.disconnect()),
    )
    this.sessions.clear()
    await this.publishBreakpointChanges()
  }

  private async create(options: {
    mode: "launch" | "attach"
    adapter: DebugAdapter
    name?: string
    start: (adapter: DebugAdapter) => Promise<void>
  }): Promise<CreatedSession> {
    const session = createSessionState({
      id: `debug-${++this.counter}`,
      adapter: options.adapter,
      mode: options.mode,
      name: options.name,
    })
    options.adapter.onStopped((event) => recordStop({ state: session, event }))
    try {
      await options.start(options.adapter)
      const initialStop = await options.adapter.waitForInitialPause()
      this.sessions.set(session.id, session)
      return { session, initialStop }
    } catch (error) {
      try {
        await options.adapter.disconnect()
      } catch {
        // Preserve the original startup error when cleanup also fails.
      }
      throw error
    }
  }

  private async publishBreakpointChanges(): Promise<void> {
    const projection = createBreakpointProjection(this.list())
    await Promise.allSettled(
      Array.from(this.breakpointListeners).map((listener) =>
        listener(projection),
      ),
    )
  }
}

export const sessions = new SessionManager()
