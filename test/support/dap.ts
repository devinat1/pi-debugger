import type { Readable, Writable } from "node:stream"
import { DapMessageDecoder, encodeDapMessage } from "../../src/dap/codec"
import type { DapMessage, Request } from "../../src/dap/types"

export function collectMessages(output: Readable) {
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
    throw new Error("Timed out waiting for a DAP message.")
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

export function sendRequest(
  output: Writable,
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
  output.write(encodeDapMessage(request))
}
