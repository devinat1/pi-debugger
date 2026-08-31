import { Socket } from "node:net"
import { DapMessageDecoder, encodeDapMessage } from "./codec"
import type { DapMessage, Request, Response } from "./types"

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
  private decoder = new DapMessageDecoder()
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence)
        reject(
          new Error(`Timed out waiting for DAP response to ${options.command}.`),
        )
      }, REQUEST_TIMEOUT)
      this.pending.set(sequence, { resolve, reject, timer })
      this.socket.write(encodeDapMessage(request))
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
    this.decoder.push(data).forEach((message) => this.handleMessage(message))
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
