import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { PassThrough } from "node:stream"
import type {
  AdapterType,
  AttachConfig,
  BreakpointResult,
  DebugAdapter,
  EvalResult,
  EvaluateOptions,
  ExecutionCommand,
  LaunchConfig,
  SetBreakpointsOptions,
  StopResult,
  StoppedInfo,
} from "../../src/adapter/base"
import type { StackFrame, Variable } from "../../src/dap/types"
import { NodeAdapter } from "../../src/adapter/node"
import { SharedDebugServer } from "../../src/editor/server"
import { SessionManager } from "../../src/session/manager"
import { collectMessages, sendRequest } from "../mirror/support"

class FakeSharedNodeAdapter implements DebugAdapter {
  readonly id: AdapterType = "node"
  frames: StackFrame[] = []
  isPaused = true
  startedCommands: ExecutionCommand[] = []
  private continuedCallbacks = new Set<(threadId: number) => void>()
  private stoppedCallbacks = new Set<(event: StoppedInfo) => void>()
  private terminatedCallbacks = new Set<() => void>()

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
    return this.frames
  }
  async getVariables(): Promise<Variable[]> {
    return [{ name: "answer", value: "42", variablesReference: 0 }]
  }
  async evaluate(options: EvaluateOptions): Promise<EvalResult> {
    return { result: options.expression }
  }
  async disconnect(): Promise<void> {
    this.terminatedCallbacks.forEach((callback) => callback())
  }
  onStopped(callback: (event: StoppedInfo) => void): () => void {
    this.stoppedCallbacks.add(callback)
    return () => this.stoppedCallbacks.delete(callback)
  }
  onContinued(callback: (threadId: number) => void): () => void {
    this.continuedCallbacks.add(callback)
    return () => this.continuedCallbacks.delete(callback)
  }
  onTerminated(callback: () => void): () => void {
    this.terminatedCallbacks.add(callback)
    return () => this.terminatedCallbacks.delete(callback)
  }
  async startExecution(options: { command: ExecutionCommand }): Promise<void> {
    if (!this.isPaused) throw new Error("The program is already running.")
    this.isPaused = false
    this.startedCommands.push(options.command)
    this.continuedCallbacks.forEach((callback) => callback(1))
  }
  async pause(): Promise<void> {}

  stopAt(frame: StackFrame): void {
    this.frames = [frame]
    this.isPaused = true
    this.stoppedCallbacks.forEach((callback) =>
      callback({
        reason: "step",
        threadId: 1,
        location: {
          file: frame.source?.path,
          line: frame.line,
          column: frame.column,
          name: frame.name,
        },
      }),
    )
  }
}

describe("SharedDebugServer", () => {
  it("shares breakpoints and execution with one live Node session", async () => {
    const adapter = new FakeSharedNodeAdapter()
    const sessions = new SessionManager(() => adapter)
    const created = await sessions.launch({
      config: { type: "node", program: "app.js" },
      name: "app",
    })
    const file = resolve("app.js")
    await sessions.setBreakpoints({
      sessionId: created.session.id,
      file,
      breakpoints: [{ line: 3 }],
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const server = new SharedDebugServer({ input, output, sessions })
    const messages = collectMessages(output)
    const running = server.run()

    sendRequest(input, { seq: 1, command: "initialize" })
    expect((await messages.nextResponse(1)).success).toBe(true)
    await messages.nextEvent("initialized")
    sendRequest(input, { seq: 2, command: "launch" })
    expect((await messages.nextResponse(2)).success).toBe(true)
    sendRequest(input, { seq: 3, command: "configurationDone" })
    expect((await messages.nextResponse(3)).success).toBe(true)
    expect((await messages.nextEvent("breakpoint")).body?.reason).toBe("new")
    expect((await messages.nextEvent("stopped")).body?.reason).toBe("entry")

    sendRequest(input, {
      seq: 4,
      command: "setBreakpoints",
      arguments: { source: { path: file }, breakpoints: [{ line: 8 }] },
    })
    expect((await messages.nextResponse(4)).success).toBe(true)
    expect(created.session.breakpoints.get(file)?.map((item) => item.line)).toEqual([8])

    sendRequest(input, { seq: 5, command: "next", arguments: { threadId: 1 } })
    expect((await messages.nextResponse(5)).success).toBe(true)
    expect(adapter.startedCommands).toEqual(["next"])
    await messages.nextEvent("continued")
    sendRequest(input, { seq: 6, command: "next", arguments: { threadId: 1 } })
    const conflict = await messages.nextResponse(6)
    expect(conflict.success).toBe(false)
    expect(conflict.message).toBe("The program is already running.")

    adapter.stopAt({
      id: 0,
      name: "main",
      source: { path: file, name: "app.js" },
      line: 9,
      column: 1,
    })
    expect((await messages.nextEvent("stopped")).body?.reason).toBe("step")
    expect(created.session.stoppedLocation?.line).toBe(9)
    sendRequest(input, {
      seq: 7,
      command: "stackTrace",
      arguments: { threadId: 1 },
    })
    expect((await messages.nextResponse(7)).body?.totalFrames).toBe(1)

    await sessions.setBreakpoints({
      sessionId: created.session.id,
      file,
      breakpoints: [{ line: 12 }],
    })
    expect((await messages.nextEvent("breakpoint")).body?.reason).toBe("new")

    sendRequest(input, { seq: 8, command: "disconnect" })
    expect((await messages.nextResponse(8)).success).toBe(true)
    await running
  })

  it("steps the real Node process from DAP and updates Pi state", async () => {
    const sessions = new SessionManager(() => new NodeAdapter())
    const file = resolve("samples/node/app.js")
    const created = await sessions.launch({
      config: { type: "node", program: file },
      name: "sample",
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const server = new SharedDebugServer({ input, output, sessions })
    const messages = collectMessages(output)
    const running = server.run()
    try {
      sendRequest(input, { seq: 1, command: "initialize" })
      await messages.nextResponse(1)
      await messages.nextEvent("initialized")
      sendRequest(input, { seq: 2, command: "launch" })
      await messages.nextResponse(2)
      sendRequest(input, {
        seq: 3,
        command: "setBreakpoints",
        arguments: { source: { path: file }, breakpoints: [{ line: 2 }] },
      })
      expect((await messages.nextResponse(3)).success).toBe(true)
      expect(created.session.breakpoints.get(file)?.[0]?.line).toBe(2)
      sendRequest(input, { seq: 4, command: "configurationDone" })
      await messages.nextResponse(4)
      await messages.nextEvent("stopped")

      sendRequest(input, { seq: 5, command: "continue", arguments: { threadId: 1 } })
      expect((await messages.nextResponse(5)).success).toBe(true)
      await messages.nextEvent("continued")
      expect((await messages.nextEvent("stopped")).body?.reason).toBe("other")
      expect(created.session.stoppedLocation?.line).toBe(2)

      sendRequest(input, { seq: 6, command: "next", arguments: { threadId: 1 } })
      expect((await messages.nextResponse(6)).success).toBe(true)
      await messages.nextEvent("continued")
      await messages.nextEvent("stopped")
      expect(created.session.stoppedLocation?.line).toBe(3)
    } finally {
      sendRequest(input, { seq: 7, command: "disconnect" })
      await messages.nextResponse(7)
      await running
      await sessions.stopAll()
    }
  }, 15_000)
})
