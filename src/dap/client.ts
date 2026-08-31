import { Socket } from "node:net"
import { booleanValue, numberValue, recordValue, stringValue } from "../util/value"
import type { DapMessage, Event, Request, Response } from "./types"

type EventHandler = (body: Record<string, unknown>) => void

const REQUEST_TIMEOUT = 30_000

/** A small DAP client using Content-Length framing over TCP. */
export class DapClient {
  private socket = new Socket()
  private sequence = 1
  private pending = new Map<
    number,
    {
      resolve: (response: Response) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private buffer = Buffer.alloc(0)
  private isConnected = false

  constructor(private connection: { host: string; port: number }) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.socket.destroy()
        reject(error)
      }
      this.socket.once("error", onError)
      this.socket.connect(this.connection, () => {
        this.socket.off("error", onError)
        this.isConnected = true
        resolve()
      })
      this.socket.on("error", (error) => {
        if (this.isConnected) this.rejectPending(error)
      })
      this.socket.on("data", (data) => this.onData(data))
      this.socket.on("close", () => {
        this.isConnected = false
        this.rejectPending(new Error("Debugger connection closed."))
      })
    })
  }

  async sendRequest(options: {
    command: string
    arguments?: Record<string, unknown>
  }): Promise<Response> {
    if (!this.isConnected) throw new Error("Debugger is not connected.")
    const sequence = this.sequence++
    const request: Request = {
      seq: sequence,
      type: "request",
      command: options.command,
      arguments: options.arguments,
    }
    const json = JSON.stringify(request)
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence)
        reject(
          new Error(`Timed out waiting for DAP response to ${options.command}.`),
        )
      }, REQUEST_TIMEOUT)
      this.pending.set(sequence, { resolve, reject, timer })
      this.socket.write(header + json)
    })
  }

  on(options: { event: string; handler: EventHandler }): void {
    const handlers = this.eventHandlers.get(options.event) ?? new Set<EventHandler>()
    handlers.add(options.handler)
    this.eventHandlers.set(options.event, handlers)
  }

  off(options: { event: string; handler: EventHandler }): void {
    this.eventHandlers.get(options.event)?.delete(options.handler)
  }

  once(options: { event: string }): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (body: Record<string, unknown>) => {
        this.off({ event: options.event, handler })
        resolve(body)
      }
      this.on({ event: options.event, handler })
    })
  }

  async disconnect(): Promise<void> {
    this.socket.destroy()
    this.isConnected = false
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return
      const match = this.buffer
        .subarray(0, headerEnd)
        .toString()
        .match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const contentLength = Number.parseInt(match[1], 10)
      const contentStart = headerEnd + 4
      if (this.buffer.length < contentStart + contentLength) return
      const content = this.buffer
        .subarray(contentStart, contentStart + contentLength)
        .toString()
      this.buffer = this.buffer.subarray(contentStart + contentLength)
      try {
        const message = parseDapMessage(JSON.parse(content))
        if (message) this.handleMessage(message)
      } catch {
        // Ignore malformed adapter output and keep reading framed messages.
      }
    }
  }

  private handleMessage(message: DapMessage): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.request_seq)
      if (message.success) {
        pending.resolve(message)
        return
      }
      pending.reject(
        new Error(message.message ?? `DAP request failed: ${message.command}.`),
      )
      return
    }
    if (message.type !== "event") return
    const handlers = this.eventHandlers.get(message.event) ?? []
    Array.from(handlers).forEach((handler) => {
      handler(message.body ?? {})
    })
  }

  private rejectPending(error: Error): void {
    Array.from(this.pending.values()).forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }
}

function parseDapMessage(value: unknown): DapMessage | undefined {
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
