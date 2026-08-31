import { spawn, spawnSync } from "node:child_process"
import type { AdapterType, AttachConfig, LaunchConfig } from "./base"
import { TcpDapAdapter } from "./dap"
import { findFreePort } from "../util/port"
import { connectDap } from "../util/process"

export class PythonAdapter extends TcpDapAdapter {
  readonly id: AdapterType = "python"

  async launch(config: LaunchConfig): Promise<void> {
    const pythonPath = config.pythonPath ?? "python3"
    requireDebugpy({ pythonPath })
    const port = await findFreePort()
    this.adapterProcess = spawn(
      pythonPath,
      ["-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: "ignore" },
    )
    this.shouldTerminateDebuggee = true
    this.useClient(await connectDap({ host: "127.0.0.1", port }))
    this.beginInitialPause()
    await this.initialize("python")
    await this.configure({
      command: "launch",
      arguments: {
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
      },
    })
  }

  async attach(config: AttachConfig): Promise<void> {
    const pythonPath = config.pythonPath ?? "python3"
    requireDebugpy({ pythonPath })
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? await findFreePort() : undefined)
    if (!port) throw new Error("Python attach requires a port or PID.")
    if (config.pid) {
      this.adapterProcess = spawn(
        pythonPath,
        ["-m", "debugpy", "--listen", `${host}:${port}`, "--pid", String(config.pid)],
        { cwd: config.cwd, stdio: "ignore" },
      )
    }
    this.shouldTerminateDebuggee = false
    this.useClient(await connectDap({ host, port, timeout: 15_000 }))
    this.beginInitialPause()
    await this.initialize("python")
    await this.configure({
      command: "attach",
      arguments: {
        type: "python",
        request: "attach",
        justMyCode: true,
      },
    })
    await this.pauseAttachedTarget()
  }
}

export function requireDebugpy(options: {
  pythonPath: string
  check?: (path: string) => boolean
}): void {
  const isDebugpyInstalled =
    options.check ??
    ((path) =>
      spawnSync(path, ["-c", "import debugpy"], {
        stdio: "ignore",
        timeout: 5_000,
      }).status === 0)
  const isInstalled = isDebugpyInstalled(options.pythonPath)
  if (isInstalled) return
  throw new Error(
    `debugpy was not found. Install it with the following command.\n${options.pythonPath} -m pip install debugpy`,
  )
}
