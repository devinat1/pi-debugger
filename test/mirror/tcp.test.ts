import { describe, expect, it } from "bun:test"
import { connect, type Socket } from "node:net"
import type { MirroredBreakpoint } from "../../src/breakpoint/projection"
import type { BreakpointProjectionSource } from "../../src/breakpoint/state"
import { serveTcpMirror } from "../../src/mirror/tcp"
import { findFreePort } from "../../src/util/port"
import { collectMessages, sendRequest } from "./support"

describe("serveTcpMirror", () => {
  it("serves one loopback DAP client and exits after disconnect", async () => {
    const port = await findFreePort()
    const source = new FakeBreakpointSource([
      { file: "/workspace/app.ts", line: 4, verified: true },
    ])
    const readiness = readinessSignal()
    const running = serveTcpMirror({
      workspace: "/workspace",
      port,
      source,
      onListening: readiness.resolve,
    })
    await readiness.promise
    const socket = await connectSocket(port)
    const messages = collectMessages(socket)

    sendRequest(socket, { seq: 1, command: "initialize" })
    expect((await messages.nextResponse(1)).success).toBe(true)
    sendRequest(socket, { seq: 2, command: "launch" })
    expect((await messages.nextResponse(2)).success).toBe(true)
    sendRequest(socket, { seq: 3, command: "configurationDone" })
    expect((await messages.nextResponse(3)).success).toBe(true)
    expect((await messages.nextEvent("breakpoint")).body?.reason).toBe("new")
    sendRequest(socket, { seq: 4, command: "disconnect" })
    expect((await messages.nextResponse(4)).success).toBe(true)

    await running
    expect(source.isStopped).toBe(true)
  })

  it("closes when no editor connects before the idle timeout", async () => {
    const port = await findFreePort()
    await expect(serveTcpMirror({
      workspace: "/workspace",
      port,
      idleTimeout: 10,
      source: new FakeBreakpointSource([]),
    })).rejects.toThrow("idle timeout")
  })
})

class FakeBreakpointSource implements BreakpointProjectionSource {
  isStopped = false

  constructor(private breakpoints: MirroredBreakpoint[]) {}

  async start(options: {
    onChange: (breakpoints: MirroredBreakpoint[]) => void
  }): Promise<void> {
    options.onChange(this.breakpoints)
  }

  stop(): void {
    this.isStopped = true
  }
}

function readinessSignal(): {
  promise: Promise<void>
  resolve: () => void
} {
  const state: { resolve?: () => void } = {}
  const promise = new Promise<void>((resolveReady) => {
    state.resolve = resolveReady
  })
  return {
    promise,
    resolve: () => state.resolve?.(),
  }
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      resolveSocket(socket)
    })
    socket.once("error", rejectSocket)
  })
}
