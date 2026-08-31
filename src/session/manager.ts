import type {
  AdapterType,
  AttachConfig,
  DebugAdapter,
  LaunchConfig,
  StopResult,
} from "../adapter/base"
import { createAdapter, detectType } from "../adapter/registry"
import { createSessionState, recordStop, type SessionState } from "./state"

export interface CreatedSession {
  session: SessionState
  initialStop: StopResult
}

export class SessionManager {
  private sessions = new Map<string, SessionState>()
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

  async stop(sessionId: string): Promise<SessionState> {
    const session = this.require(sessionId)
    await session.adapter.disconnect()
    this.sessions.delete(sessionId)
    return session
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.adapter.disconnect()),
    )
    this.sessions.clear()
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
}

export const sessions = new SessionManager()
