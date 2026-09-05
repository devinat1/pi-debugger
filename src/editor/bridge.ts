import { createServer, type Server, type Socket } from "node:net"
import type { SessionManager } from "../session/manager"
import { readEditorPort } from "./config"
import { SharedDebugServer } from "./server"

const LOOPBACK_HOST = "127.0.0.1"

export class EditorDebugBridge {
  private activeDebugServer: SharedDebugServer | null = null
  private activeSocket: Socket | null = null
  private listener: Server | null = null

  constructor(
    private options: {
      port: number
      sessions: SessionManager
    },
  ) {}

  async start(): Promise<void> {
    const listener = createServer((socket) => this.accept(socket))
    this.listener = listener
    await new Promise<void>((resolveListening, rejectListening) => {
      listener.once("error", rejectListening)
      listener.listen(this.options.port, LOOPBACK_HOST, resolveListening)
    })
  }

  async close(): Promise<void> {
    this.activeDebugServer?.stop()
    this.activeDebugServer = null
    this.activeSocket?.destroy()
    this.activeSocket = null
    const listener = this.listener
    this.listener = null
    if (!listener?.listening) return
    await new Promise<void>((resolveClosed) => listener.close(() => resolveClosed()))
  }

  private accept(socket: Socket): void {
    if (this.activeSocket && !this.activeSocket.destroyed) {
      socket.destroy()
      return
    }
    this.activeSocket = socket
    const debugServer = new SharedDebugServer({
      input: socket,
      output: socket,
      sessions: this.options.sessions,
    })
    this.activeDebugServer = debugServer
    void this.runClient({ debugServer, socket })
  }

  private async runClient(options: {
    debugServer: SharedDebugServer
    socket: Socket
  }): Promise<void> {
    try {
      await options.debugServer.run()
    } finally {
      options.socket.destroy()
      if (this.activeDebugServer === options.debugServer) {
        this.activeDebugServer = null
        this.activeSocket = null
      }
    }
  }
}

export async function startConfiguredEditorBridge(options: {
  workspace: string
  sessions: SessionManager
}): Promise<EditorDebugBridge | null> {
  const port = await readEditorPort(options.workspace)
  if (port === null) return null
  const bridge = new EditorDebugBridge({ port, sessions: options.sessions })
  await bridge.start()
  return bridge
}
