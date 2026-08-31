import { describe, expect, it } from "bun:test"
import type {
  AdapterType,
  AttachConfig,
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  LaunchConfig,
  StopResult,
  StoppedInfo,
} from "../../src/adapter/base"
import type { SourceBreakpoint, StackFrame, Variable } from "../../src/dap/types"
import { SessionManager } from "../../src/session/manager"

class FakeAdapter implements DebugAdapter {
  disconnected = false
  readonly callbacks: Array<(event: StoppedInfo) => void> = []

  constructor(readonly id: AdapterType) {}

  async launch(_config: LaunchConfig): Promise<void> {}
  async attach(_config: AttachConfig): Promise<void> {}
  async waitForInitialPause(): Promise<StopResult> {
    return { reason: "entry", threadId: 1 }
  }
  async setBreakpoints(
    _file: string,
    breakpoints: SourceBreakpoint[],
  ): Promise<BreakpointResult[]> {
    return breakpoints.map((item) => ({ verified: true, line: item.line }))
  }
  async continue(): Promise<StopResult> {
    return { reason: "breakpoint" }
  }
  async stepOver(): Promise<StopResult> {
    return { reason: "step" }
  }
  async stepIn(): Promise<StopResult> {
    return { reason: "step" }
  }
  async stepOut(): Promise<StopResult> {
    return { reason: "step" }
  }
  async getCallStack(): Promise<StackFrame[]> {
    return []
  }
  async getVariables(): Promise<Variable[]> {
    return []
  }
  async evaluate(expression: string): Promise<EvalResult> {
    return { result: expression }
  }
  async disconnect(): Promise<void> {
    this.disconnected = true
  }
  onStopped(callback: (event: StoppedInfo) => void): void {
    this.callbacks.push(callback)
  }
}

describe("SessionManager", () => {
  it("keeps two sessions live and targets stop by sessionId", async () => {
    const adapters: FakeAdapter[] = []
    const manager = new SessionManager((type) => {
      const adapter = new FakeAdapter(type)
      adapters.push(adapter)
      return adapter
    })

    const first = await manager.launch({ type: "node", program: "one.js" }, "one")
    const second = await manager.attach({ type: "go", pid: 123 }, "two")

    expect(manager.list().map((session) => session.id)).toEqual([
      first.session.id,
      second.session.id,
    ])
    expect(adapters[0].disconnected).toBe(false)
    expect(adapters[1].disconnected).toBe(false)

    await manager.stop(first.session.id)

    expect(adapters[0].disconnected).toBe(true)
    expect(adapters[1].disconnected).toBe(false)
    expect(manager.require(second.session.id).name).toBe("two")
  })
})
