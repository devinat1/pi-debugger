import { describe, expect, it } from "bun:test"
import type {
  AdapterType,
  AttachConfig,
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  EvaluateOptions,
  SetBreakpointsOptions,
  LaunchConfig,
  StopResult,
  StoppedInfo,
} from "../../src/adapter/base"
import type { StackFrame, Variable } from "../../src/dap/types"
import { SessionManager } from "../../src/session/manager"

class FakeAdapter implements DebugAdapter {
  isDisconnected = false
  readonly callbacks = new Set<(event: StoppedInfo) => void>()

  constructor(readonly id: AdapterType) {}

  async launch(_config: LaunchConfig): Promise<void> {}
  async attach(_config: AttachConfig): Promise<void> {}
  async waitForInitialPause(): Promise<StopResult> {
    return { reason: "entry", threadId: 1 }
  }
  async setBreakpoints(
    options: SetBreakpointsOptions,
  ): Promise<BreakpointResult[]> {
    return options.breakpoints.map((item) => ({ verified: true, line: item.line }))
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
  async evaluate(options: EvaluateOptions): Promise<EvalResult> {
    return { result: options.expression }
  }
  async disconnect(): Promise<void> {
    this.isDisconnected = true
  }
  onStopped(callback: (event: StoppedInfo) => void): void {
    this.callbacks.add(callback)
  }
}

describe("SessionManager", () => {
  it("keeps two sessions live and targets stop by sessionId", async () => {
    const nodeAdapter = new FakeAdapter("node")
    const goAdapter = new FakeAdapter("go")
    const manager = new SessionManager((type) =>
      type === "node" ? nodeAdapter : goAdapter,
    )

    const first = await manager.launch({
      config: { type: "node", program: "one.js" },
      name: "one",
    })
    const second = await manager.attach({
      config: { type: "go", pid: 123 },
      name: "two",
    })

    expect(manager.list().map((session) => session.id)).toEqual([
      first.session.id,
      second.session.id,
    ])
    expect(nodeAdapter.isDisconnected).toBe(false)
    expect(goAdapter.isDisconnected).toBe(false)

    await manager.stop(first.session.id)

    expect(nodeAdapter.isDisconnected).toBe(true)
    expect(goAdapter.isDisconnected).toBe(false)
    expect(manager.require(second.session.id).name).toBe("two")
  })
})
