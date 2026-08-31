#!/usr/bin/env node

import { resolve } from "node:path"
import { BreakpointStateReader } from "../breakpoint/state"
import { BreakpointMirrorServer } from "./server"

const workspace = workspaceArgument(process.argv.slice(2))
if (!workspace) {
  process.stderr.write(
    "Usage: pi-debugger-breakpoint-mirror [--workspace /absolute/path]\n",
  )
  process.exitCode = 1
} else {
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

function workspaceArgument(argumentsList: string[]): string | null {
  const workspaceIndex = argumentsList.indexOf("--workspace")
  if (workspaceIndex === -1) return process.cwd()
  const workspace = argumentsList[workspaceIndex + 1]
  return workspace ? resolve(workspace) : null
}
