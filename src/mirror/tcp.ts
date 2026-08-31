import { createServer, type Server, type Socket } from "node:net"
import type { BreakpointProjectionSource } from "../breakpoint/state"
import { BreakpointStateReader } from "../breakpoint/state"
import { BreakpointMirrorServer } from "./server"

const LOOPBACK_HOST = "127.0.0.1"
export const DEFAULT_MIRROR_IDLE_TIMEOUT = 30_000

export async function serveTcpMirror(options: {
  workspace: string
  port: number
  idleTimeout?: number
  source?: BreakpointProjectionSource
  onListening?: () => void
}): Promise<void> {
  const listener = createServer()
  await listen({ listener, port: options.port })
  options.onListening?.()
  const socket = await acceptOne({
    listener,
    port: options.port,
    idleTimeout: options.idleTimeout ?? DEFAULT_MIRROR_IDLE_TIMEOUT,
  })
  listener.close()
  const mirror = new BreakpointMirrorServer({
    input: socket,
    output: socket,
    source: options.source ?? new BreakpointStateReader({
      workspace: options.workspace,
    }),
  })
  try {
    await mirror.run()
  } finally {
    socket.destroy()
    listener.close()
  }
}

function listen(options: {
  listener: Server
  port: number
}): Promise<void> {
  return new Promise((resolveListening, rejectListening) => {
    options.listener.once("error", (error) => {
      rejectListening(
        new Error(
          `Cannot start the pi breakpoint mirror on ${LOOPBACK_HOST}:${options.port}: ${error.message} Rerun setup to choose another port.`,
        ),
      )
    })
    options.listener.listen(options.port, LOOPBACK_HOST, resolveListening)
  })
}

function acceptOne(options: {
  listener: Server
  port: number
  idleTimeout: number
}): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const timeout = setTimeout(() => {
      options.listener.close()
      rejectSocket(
        new Error(
          `The pi breakpoint mirror on ${LOOPBACK_HOST}:${options.port} received no editor connection before its idle timeout.`,
        ),
      )
    }, options.idleTimeout)
    options.listener.once("connection", (socket) => {
      clearTimeout(timeout)
      resolveSocket(socket)
    })
    options.listener.once("error", (error) => {
      clearTimeout(timeout)
      rejectSocket(error)
    })
  })
}
