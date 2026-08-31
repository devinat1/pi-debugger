import { Socket } from "node:net"
import type { DapMessage, Event, Request, Response } from "./types"

type EventHandler = (body: Record<string, unknown>) => void

const REQUEST_TIMEOUT = 30_000

/** A small DAP client using Content-Length framing over TCP. */
export class DapClient {
  private socket = new Socket()
  private seq = 1
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
  private connected = false

  constructor(
    private host: string,
    private port: number,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.socket.destroy()
        reject(error)
      }
      this.socket.once("error", onError)
      this.socket.connect(this.port, this.host, () => {
        this.socket.off("error", onError)
        this.connected = true
        resolve()
      })
      this.socket.on("error", (error) => {
        if (this.connected) this.rejectPending(error)
      })
      this.socket.on("data", (data) => this.onData(data))
      this.socket.on("close", () => {
        this.connected = false
        this.rejectPending(new Error("Debugger connection closed"))
      })
    })
  }

  async sendRequest(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<Response> {
    if (!this.connected) throw new Error("Debugger is not connected")
    const seq = this.seq++
    const request: Request = {
      seq,
      type: "request",
      command,
      arguments: args,
    }
    const json = JSON.stringify(request)
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`Timed out waiting for DAP response to ${command}`))
      }, REQUEST_TIMEOUT)
      this.pending.set(seq, { resolve, reject, timer })
      this.socket.write(header + json)
    })
  }

  on(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? new Set<EventHandler>()
    handlers.add(handler)
    this.eventHandlers.set(event, handlers)
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler)
  }

  once(event: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (body: Record<string, unknown>) => {
        this.off(event, handler)
        resolve(body)
      }
      this.on(event, handler)
    })
  }

  async disconnect(): Promise<void> {
    this.socket.destroy()
    this.connected = false
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
        this.handleMessage(JSON.parse(content) as DapMessage)
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
        new Error(message.message ?? `DAP request failed: ${message.command}`),
      )
      return
    }
    if (message.type !== "event") return
    for (const handler of this.eventHandlers.get(message.event) ?? []) {
      handler(message.body ?? {})
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
