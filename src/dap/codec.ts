import { booleanValue, numberValue, recordValue, stringValue } from "../util/value"
import type { DapMessage } from "./types"

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n")

export function encodeDapMessage(message: DapMessage): Buffer {
  const json = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`
  return Buffer.from(header + json)
}

export class DapMessageDecoder {
  private buffer = Buffer.alloc(0)

  push(data: Buffer): DapMessage[] {
    this.buffer = Buffer.concat([this.buffer, data])
    return this.decodeAvailable([])
  }

  private decodeAvailable(messages: DapMessage[]): DapMessage[] {
    const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR)
    if (headerEnd === -1) return messages
    const contentLength = parseContentLength(
      this.buffer.subarray(0, headerEnd).toString(),
    )
    if (contentLength === null) {
      this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length)
      return this.decodeAvailable(messages)
    }
    const contentStart = headerEnd + HEADER_SEPARATOR.length
    if (this.buffer.length < contentStart + contentLength) return messages
    const content = this.buffer
      .subarray(contentStart, contentStart + contentLength)
      .toString()
    this.buffer = this.buffer.subarray(contentStart + contentLength)
    const message = parseJsonMessage(content)
    return this.decodeAvailable(message ? [...messages, message] : messages)
  }
}

export function parseDapMessage(value: unknown): DapMessage | undefined {
  const message = recordValue(value)
  const sequence = numberValue(message?.seq)
  const type = stringValue(message?.type)
  if (sequence === undefined) return undefined
  if (type === "event") {
    const event = stringValue(message?.event)
    if (!event) return undefined
    return { seq: sequence, type, event, body: recordValue(message?.body) }
  }
  if (type === "response") {
    const requestSequence = numberValue(message?.request_seq)
    const isSuccessful = booleanValue(message?.success)
    const command = stringValue(message?.command)
    if (requestSequence === undefined || isSuccessful === undefined || !command) {
      return undefined
    }
    return {
      seq: sequence,
      type,
      request_seq: requestSequence,
      success: isSuccessful,
      command,
      message: stringValue(message?.message),
      body: recordValue(message?.body),
    }
  }
  if (type !== "request") return undefined
  const command = stringValue(message?.command)
  if (!command) return undefined
  return {
    seq: sequence,
    type,
    command,
    arguments: recordValue(message?.arguments),
  }
}

function parseContentLength(header: string): number | null {
  const match = header.match(/Content-Length:\s*(\d+)/i)
  return match ? Number.parseInt(match[1], 10) : null
}

function parseJsonMessage(content: string): DapMessage | undefined {
  try {
    return parseDapMessage(JSON.parse(content))
  } catch {
    return undefined
  }
}
