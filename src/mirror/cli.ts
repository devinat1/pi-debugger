#!/usr/bin/env node

import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { BreakpointStateReader } from "../breakpoint/state"
import { parseMirrorCommand } from "./command"
import { BreakpointMirrorServer } from "./server"
import { setupEditor } from "./setup"
import { serveTcpMirror } from "./tcp"

try {
  await runCommand()
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
}

async function runCommand(): Promise<void> {
  const command = parseMirrorCommand(process.argv.slice(2))
  if (command.kind === "stdio") {
    await runStdioMirror(command.workspace)
    return
  }
  if (command.kind === "setup") {
    const result = await setupEditor({
      editor: command.editor,
      executable: await currentExecutable(),
      workspace: command.workspace,
    })
    process.stdout.write(
      `Configured ${result.editor} profile "Pi breakpoint mirror" in ${result.workspace}.\n`,
    )
    return
  }
  if (command.shouldDetach) {
    await startDetachedServer({
      executable: await currentExecutable(),
      workspace: command.workspace,
      port: command.port,
    })
    return
  }
  await serveTcpMirror({
    workspace: command.workspace,
    port: command.port,
    onListening: notifyParentThatServerIsReady,
  })
}

async function runStdioMirror(workspace: string): Promise<void> {
  const server = new BreakpointMirrorServer({
    input: process.stdin,
    output: process.stdout,
    source: new BreakpointStateReader({ workspace }),
  })
  const stop = () => server.stop()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  await server.run()
}

async function startDetachedServer(options: {
  executable: string
  workspace: string
  port: number
}): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      options.executable,
      "serve",
      "--workspace",
      options.workspace,
      "--port",
      String(options.port),
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  )
  await waitForServerReadiness({ child, port: options.port })
  child.disconnect()
  child.unref()
}

function waitForServerReadiness(options: {
  child: ReturnType<typeof spawn>
  port: number
}): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      options.child.kill()
      rejectReady(
        new Error(
          `Timed out starting the pi breakpoint mirror on 127.0.0.1:${options.port}.`,
        ),
      )
    }, 5_000)
    options.child.once("message", (message: unknown) => {
      if (!isReadyMessage(message)) return
      clearTimeout(timeout)
      resolveReady()
    })
    options.child.once("error", (error) => {
      clearTimeout(timeout)
      rejectReady(error)
    })
    options.child.once("exit", (code) => {
      clearTimeout(timeout)
      rejectReady(
        new Error(
          `The pi breakpoint mirror exited before listening on 127.0.0.1:${options.port} with code ${code ?? "unknown"}. Rerun setup to choose another port.`,
        ),
      )
    })
  })
}

function notifyParentThatServerIsReady(): void {
  if (process.send) process.send({ type: "ready" })
}

async function currentExecutable(): Promise<string> {
  const executable = process.argv[1]
  if (!executable) throw new Error("Cannot determine the mirror executable path.")
  return realpath(executable)
}

function isReadyMessage(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "ready"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
