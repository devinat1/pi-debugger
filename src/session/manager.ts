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

  async launch(
    config: Omit<LaunchConfig, "type"> & { type?: AdapterType },
    name?: string,
  ): Promise<CreatedSession> {
    const type = config.type ?? detectType(config.program)
    return this.create("launch", this.adapterFactory(type), name, (adapter) =>
      adapter.launch({ ...config, type }),
    )
  }

  async attach(config: AttachConfig, name?: string): Promise<CreatedSession> {
    return this.create("attach", this.adapterFactory(config.type), name, (adapter) =>
      adapter.attach(config),
    )
  }

  require(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Debug session not found: ${sessionId}`)
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

  private async create(
    mode: "launch" | "attach",
    adapter: DebugAdapter,
    name: string | undefined,
    start: (adapter: DebugAdapter) => Promise<void>,
  ): Promise<CreatedSession> {
    const session = createSessionState(
      `debug-${++this.counter}`,
      adapter,
      mode,
      name,
    )
    adapter.onStopped((event) => recordStop(session, event))
    try {
      await start(adapter)
      const initialStop = await adapter.waitForInitialPause()
      this.sessions.set(session.id, session)
      return { session, initialStop }
    } catch (error) {
      await adapter.disconnect().catch(() => undefined)
      throw error
    }
  }
}

export const sessions = new SessionManager()
