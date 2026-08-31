import { describe, expect, it } from "bun:test"
import { DapMessageDecoder, encodeDapMessage } from "../../src/dap/codec"
import type { Event, Request } from "../../src/dap/types"

describe("DAP codec", () => {
  it("decodes fragmented UTF-8 messages and multiple frames", () => {
    const decoder = new DapMessageDecoder()
    const first: Event = {
      seq: 1,
      type: "event",
      event: "output",
      body: { output: "héllo" },
    }
    const second: Request = {
      seq: 2,
      type: "request",
      command: "threads",
    }
    const frames = Buffer.concat([
      encodeDapMessage(first),
      encodeDapMessage(second),
    ])

    expect(decoder.push(frames.subarray(0, 11))).toEqual([])
    expect(decoder.push(frames.subarray(11))).toEqual([first, second])
  })

  it("skips malformed framed content and continues", () => {
    const decoder = new DapMessageDecoder()
    const request: Request = {
      seq: 3,
      type: "request",
      command: "disconnect",
    }
    const malformed = Buffer.from("Content-Length: 1\r\n\r\n{")

    expect(
      decoder.push(Buffer.concat([malformed, encodeDapMessage(request)])),
    ).toEqual([request])
  })
})
