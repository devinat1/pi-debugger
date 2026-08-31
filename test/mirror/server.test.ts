import { describe, expect, it } from "bun:test"
import { PassThrough } from "node:stream"
import type {
  BreakpointProjectionSource,
} from "../../src/breakpoint/state"
import type { MirroredBreakpoint } from "../../src/breakpoint/projection"
import { DapMessageDecoder, encodeDapMessage } from "../../src/dap/codec"
import type { DapMessage, Request } from "../../src/dap/types"
import { BreakpointMirrorServer } from "../../src/mirror/server"

describe("BreakpointMirrorServer", () => {
  it("mirrors pi breakpoints and rejects runtime control", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const source = new FakeBreakpointSource([
      { file: "/workspace/app.ts", line: 3, verified: true },
    ])
    const server = new BreakpointMirrorServer({ input, output, source })
    const messages = collectMessages(output)
    const running = server.run()
    await Bun.sleep(0)

    sendRequest(input, { seq: 1, command: "initialize" })
    expect((await messages.nextResponse(1)).success).toBe(true)
    expect((await messages.nextEvent("initialized")).event).toBe("initialized")

    sendRequest(input, { seq: 2, command: "attach" })
    expect((await messages.nextResponse(2)).success).toBe(true)
    sendRequest(input, { seq: 3, command: "configurationDone" })
    expect((await messages.nextResponse(3)).success).toBe(true)
    const added = await messages.nextEvent("breakpoint")
    expect(added.body?.reason).toBe("new")
    expect(breakpointLine(added)).toBe(3)

    source.update([
      { file: "/workspace/app.ts", line: 3, verified: false },
      { file: "/workspace/worker.ts", line: 8, verified: true },
    ])
    expect((await messages.nextEvent("breakpoint")).body?.reason).toBe("changed")
    const secondAdded = await messages.nextEvent("breakpoint")
    expect(secondAdded.body?.reason).toBe("new")
    expect(breakpointLine(secondAdded)).toBe(8)

    sendRequest(input, { seq: 4, command: "continue" })
    const rejected = await messages.nextResponse(4)
    expect(rejected.success).toBe(false)
    expect(rejected.message).toContain("read-only")

    sendRequest(input, {
      seq: 5,
      command: "setBreakpoints",
      arguments: {
        source: { path: "/workspace/worker.ts" },
        breakpoints: [],
      },
    })
    expect((await messages.nextResponse(5)).success).toBe(true)
    const restored = await messages.nextEvent("breakpoint")
    expect(restored.body?.reason).toBe("new")
    expect(breakpointLine(restored)).toBe(8)

    source.update([])
    const firstRemoved = await messages.nextEvent("breakpoint")
    const secondRemoved = await messages.nextEvent("breakpoint")
    expect([firstRemoved.body?.reason, secondRemoved.body?.reason]).toEqual([
      "removed",
      "removed",
    ])

    sendRequest(input, { seq: 6, command: "disconnect" })
    expect((await messages.nextResponse(6)).success).toBe(true)
    await running
    expect(source.isStopped).toBe(true)
  })
})

class FakeBreakpointSource implements BreakpointProjectionSource {
  isStopped = false
  private listener: ((breakpoints: MirroredBreakpoint[]) => void) | null = null

  constructor(private breakpoints: MirroredBreakpoint[]) {}

  async start(options: {
    onChange: (breakpoints: MirroredBreakpoint[]) => void
  }): Promise<void> {
    this.listener = options.onChange
    options.onChange(this.breakpoints)
  }

  stop(): void {
    this.isStopped = true
  }

  update(breakpoints: MirroredBreakpoint[]): void {
    this.breakpoints = breakpoints
    this.listener?.(breakpoints)
  }
}

function collectMessages(output: PassThrough) {
  const decoder = new DapMessageDecoder()
  const pending: DapMessage[] = []
  output.on("data", (data: Buffer) => pending.push(...decoder.push(data)))

  const next = async (
    predicate: (message: DapMessage) => boolean,
  ): Promise<DapMessage> => {
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
      const index = pending.findIndex(predicate)
      if (index >= 0) {
        const [message] = pending.splice(index, 1)
        if (message) return message
      }
      await Bun.sleep(5)
    }
    throw new Error("Timed out waiting for DAP message.")
  }

  return {
    async nextResponse(requestSequence: number) {
      const message = await next(
        (item) =>
          item.type === "response" && item.request_seq === requestSequence,
      )
      if (message.type !== "response") throw new Error("Expected a DAP response.")
      return message
    },
    async nextEvent(event: string) {
      const message = await next(
        (item) => item.type === "event" && item.event === event,
      )
      if (message.type !== "event") throw new Error("Expected a DAP event.")
      return message
    },
  }
}

function sendRequest(
  input: PassThrough,
  options: {
    seq: number
    command: string
    arguments?: Record<string, unknown>
  },
): void {
  const request: Request = {
    seq: options.seq,
    type: "request",
    command: options.command,
    arguments: options.arguments,
  }
  input.write(encodeDapMessage(request))
}

function breakpointLine(message: DapMessage): number | undefined {
  if (message.type !== "event") return undefined
  const breakpoint = message.body?.breakpoint
  return typeof breakpoint === "object" && breakpoint !== null
    ? Reflect.get(breakpoint, "line")
    : undefined
}
