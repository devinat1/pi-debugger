import { spawn, type ChildProcess } from "node:child_process"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import type { AdapterType, AttachConfig, LaunchConfig } from "./base"
import { TcpDapAdapter } from "./dap"
import { findFreePort } from "../util/port"
import { connectDap, findExecutable } from "../util/process"

const DELVE_START_TIMEOUT = 10_000

export class GoAdapter extends TcpDapAdapter {
  readonly id: AdapterType = "go"

  async launch(config: LaunchConfig): Promise<void> {
    const port = await findFreePort()
    this.adapterProcess = await startDlvDap({
      dlvPath: requireDlv({ dlvPath: config.dlvPath }),
      port,
      cwd: config.cwd,
      env: config.env,
    })
    this.shouldTerminateDebuggee = true
    this.useClient(await connectDap({ host: "127.0.0.1", port }))
    this.beginInitialPause()
    await this.initialize("go")
    const mode = resolveGoMode(config)
    await this.configure({
      command: "launch",
      arguments: {
        type: "go",
        request: "launch",
        mode,
        program:
          mode === "test" && config.program.endsWith(".go")
            ? dirname(config.program)
            : config.program,
        args: [
          ...(config.args ?? []),
          ...(config.testFilter ? ["--", config.testFilter] : []),
        ],
        cwd: config.cwd ?? process.cwd(),
        env: config.env,
        buildFlags: config.buildFlags,
        stopOnEntry: true,
      },
    })
  }

  async attach(config: AttachConfig): Promise<void> {
    requireDlv({ dlvPath: config.dlvPath })
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? await findFreePort() : undefined)
    if (!port) throw new Error("Go attach requires a port or PID.")
    if (config.pid) {
      this.adapterProcess = await startDlvDap({
        dlvPath: requireDlv({ dlvPath: config.dlvPath }),
        port,
        cwd: config.cwd,
      })
    }
    this.shouldTerminateDebuggee = false
    this.useClient(await connectDap({ host, port }))
    this.beginInitialPause()
    await this.initialize("go")
    await this.configure({
      command: "attach",
      arguments: {
        type: "go",
        request: "attach",
        mode: config.pid ? "local" : "remote",
        processId: config.pid,
        stopOnEntry: true,
      },
    })
    try {
      await this.pauseAttachedTarget()
    } catch {
      // Some remote Delve servers reject pause because the target is already stopped.
    }
  }
}

export function resolveGoMode(config: LaunchConfig): "debug" | "test" {
  if (config.goMode) return config.goMode
  return config.program.endsWith("_test.go") ? "test" : "debug"
}

export function requireDlv(options: {
  dlvPath?: string
  resolver?: (name: string) => string | null
}): string {
  if (options.dlvPath) return options.dlvPath
  const found = (options.resolver ?? findExecutable)("dlv")
  if (found) return found
  throw new Error(
    "dlv was not found on PATH. Install it with the following command.\ngo install github.com/go-delve/delve/cmd/dlv@latest",
  )
}

async function startDlvDap(options: {
  dlvPath: string
  port: number
  cwd?: string
  env?: Record<string, string>
}): Promise<ChildProcess> {
  const child = spawn(
    options.dlvPath,
    ["dap", "--listen", `127.0.0.1:${options.port}`, "--check-go-version=false"],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const output = child.stdout
  if (!output) throw new Error("dlv did not expose its DAP output stream.")
  const lines = createInterface({ input: output })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out starting dlv dap on port ${options.port}.`))
    }, DELVE_START_TIMEOUT)
    const cleanup = () => {
      clearTimeout(timer)
      lines.off("line", onLine)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onLine = (line: string) => {
      if (!line.includes("DAP server listening at:")) return
      cleanup()
      resolve()
    }
    const onExit = () => {
      cleanup()
      reject(new Error("dlv exited before its DAP listener was ready."))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    lines.on("line", onLine)
    child.once("exit", onExit)
    child.once("error", onError)
    child.stderr?.resume()
  })
  lines.close()
  output.resume()
  return child
}
