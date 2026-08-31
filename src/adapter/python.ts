import { spawn, spawnSync } from "node:child_process"
import type { AttachConfig, LaunchConfig } from "./base"
import { TcpDapAdapter } from "./dap"
import { findFreePort } from "../util/port"
import { connectDap } from "../util/process"

export class PythonAdapter extends TcpDapAdapter {
  readonly id = "python" as const

  async launch(config: LaunchConfig): Promise<void> {
    const pythonPath = config.pythonPath ?? "python3"
    requireDebugpy(pythonPath)
    const port = await findFreePort()
    this.adapterProcess = spawn(
      pythonPath,
      ["-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: "ignore" },
    )
    this.terminateDebuggee = true
    this.useClient(await connectDap("127.0.0.1", port))
    this.beginInitialPause()
    await this.initialize("python")
    await this.configure("launch", {
      type: "python",
      request: "launch",
      program: config.module ? undefined : config.program,
      module: config.module,
      args: config.args ?? [],
      cwd: config.cwd ?? process.cwd(),
      env: config.env,
      python: [pythonPath],
      console: "internalConsole",
      stopOnEntry: true,
      justMyCode: true,
    })
  }

  async attach(config: AttachConfig): Promise<void> {
    const pythonPath = config.pythonPath ?? "python3"
    requireDebugpy(pythonPath)
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? await findFreePort() : undefined)
    if (!port) throw new Error("Python attach requires port or pid")
    if (config.pid) {
      this.adapterProcess = spawn(
        pythonPath,
        ["-m", "debugpy", "--listen", `${host}:${port}`, "--pid", String(config.pid)],
        { cwd: config.cwd, stdio: "ignore" },
      )
    }
    this.terminateDebuggee = false
    this.useClient(await connectDap(host, port, 15_000))
    this.beginInitialPause()
    await this.initialize("python")
    await this.configure("attach", {
      type: "python",
      request: "attach",
      justMyCode: true,
    })
    await this.pauseAttachedTarget()
  }
}

export function requireDebugpy(
  pythonPath: string,
  check: (path: string) => boolean = (path) =>
    spawnSync(path, ["-c", "import debugpy"], {
      stdio: "ignore",
      timeout: 5_000,
    }).status === 0,
): void {
  if (check(pythonPath)) return
  throw new Error(
    `debugpy not found. Install with: ${pythonPath} -m pip install debugpy`,
  )
}
