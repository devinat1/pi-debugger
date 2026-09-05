import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
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
  readonly breakpointRequests: SetBreakpointsOptions[] = []
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
    this.breakpointRequests.push(options)
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
  onStopped(callback: (event: StoppedInfo) => void): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
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

  it("publishes the live breakpoint union after mutations and stop", async () => {
    const adapter = new FakeAdapter("node")
    const manager = new SessionManager(() => adapter)
    const projections: unknown[] = []
    manager.onBreakpointsChanged(async (breakpoints) => {
      projections.push(breakpoints)
    })
    const created = await manager.launch({
      config: { type: "node", program: "one.js" },
    })
    const file = resolve("one.js")

    expect(
      await manager.setBreakpoints({
        sessionId: created.session.id,
        file,
        breakpoints: [{ line: 3 }],
      }),
    ).toEqual([{ line: 3, verified: true }])
    expect(projections.at(-1)).toEqual([
      { file, line: 3, verified: true },
    ])

    await manager.removeBreakpoints({
      sessionId: created.session.id,
      file,
      lines: [3],
    })
    expect(projections.at(-1)).toEqual([])
    expect(adapter.breakpointRequests.at(-1)?.breakpoints).toEqual([])

    await manager.setBreakpoints({
      sessionId: created.session.id,
      file,
      breakpoints: [{ line: 4 }],
    })
    await manager.stop(created.session.id)
    expect(projections.at(-1)).toEqual([])
  })
})
