import { spawn, type ChildProcess } from "node:child_process"
import { dirname } from "node:path"
import type { AttachConfig, LaunchConfig } from "./base"
import { TcpDapAdapter } from "./dap"
import { findFreePort } from "../util/port"
import { connectDap, findExecutable } from "../util/process"

export class GoAdapter extends TcpDapAdapter {
  readonly id = "go" as const

  async launch(config: LaunchConfig): Promise<void> {
    const port = await findFreePort()
    this.adapterProcess = await startDlvDap(
      requireDlv(config.dlvPath),
      port,
      config.cwd,
      config.env,
    )
    this.terminateDebuggee = true
    this.useClient(await connectDap("127.0.0.1", port))
    this.beginInitialPause()
    await this.initialize("go")
    const mode = resolveGoMode(config)
    await this.configure("launch", {
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
    })
  }

  async attach(config: AttachConfig): Promise<void> {
    requireDlv(config.dlvPath)
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? (config.pid ? await findFreePort() : undefined)
    if (!port) throw new Error("Go attach requires port or pid")
    if (config.pid) {
      this.adapterProcess = await startDlvDap(
        requireDlv(config.dlvPath),
        port,
        config.cwd,
      )
    }
    this.terminateDebuggee = false
    this.useClient(await connectDap(host, port))
    this.beginInitialPause()
    await this.initialize("go")
    await this.configure("attach", {
      type: "go",
      request: "attach",
      mode: config.pid ? "local" : "remote",
      processId: config.pid,
      stopOnEntry: true,
    })
    await this.pauseAttachedTarget().catch(() => undefined)
  }
}

export function resolveGoMode(config: LaunchConfig): "debug" | "test" {
  if (config.goMode) return config.goMode
  return config.program.endsWith("_test.go") ? "test" : "debug"
}

export function requireDlv(
  dlvPath?: string,
  resolver: (name: string) => string | null = findExecutable,
): string {
  if (dlvPath) return dlvPath
  const found = resolver("dlv")
  if (found) return found
  throw new Error(
    "dlv not found on PATH. Install with: go install github.com/go-delve/delve/cmd/dlv@latest",
  )
}

async function startDlvDap(
  dlvPath: string,
  port: number,
  cwd?: string,
  env?: Record<string, string>,
): Promise<ChildProcess> {
  const child = spawn(
    dlvPath,
    ["dap", "--listen", `127.0.0.1:${port}`, "--check-go-version=false"],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let output = ""
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out starting dlv dap on port ${port}`))
    }, 10_000)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (!output.includes("DAP server listening at:")) return
      cleanup()
      resolve()
    }
    const onExit = () => {
      cleanup()
      reject(new Error("dlv exited before its DAP listener was ready"))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
    child.once("error", onError)
    child.stderr?.resume()
  })
  child.stdout?.resume()
  return child
}
