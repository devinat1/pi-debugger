import { createServer, type Server, type Socket } from "node:net"
import type { SessionManager } from "../session/manager"
import { readEditorConfiguration } from "./config"
import { SharedDebugServer } from "./server"

const LOOPBACK_HOST = "127.0.0.1"
const AUTHENTICATION_TIMEOUT = 2_000

export class EditorDebugBridge {
  private activeDebugServer: SharedDebugServer | null = null
  private activeSocket: Socket | null = null
  private listener: Server | null = null

  constructor(
    private options: {
      port: number
      sessions: SessionManager
      token: string
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
    const authenticationTimer = setTimeout(
      () => socket.destroy(),
      AUTHENTICATION_TIMEOUT,
    )
    socket.once("close", () => clearTimeout(authenticationTimer))
    const debugServer = new SharedDebugServer({
      input: socket,
      output: socket,
      sessions: this.options.sessions,
      token: this.options.token,
      onAuthenticated: () => clearTimeout(authenticationTimer),
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
  const configuration = await readEditorConfiguration(options.workspace)
  if (configuration === null) return null
  const bridge = new EditorDebugBridge({
    port: configuration.port,
    sessions: options.sessions,
    token: configuration.token,
  })
  await bridge.start()
  return bridge
}
