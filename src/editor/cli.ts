#!/usr/bin/env node

import { resolve } from "node:path"
import { setupVsCode } from "./setup"

const USAGE = "Usage: pi-debugger setup [--workspace /absolute/path]"

try {
  const argumentsList = process.argv.slice(2)
  if (argumentsList[0] !== "setup") throw new Error(USAGE)
  const workspaceIndex = argumentsList.indexOf("--workspace")
  const workspaceArgument = workspaceIndex < 0
    ? process.cwd()
    : argumentsList[workspaceIndex + 1]
  if (!workspaceArgument) throw new Error(USAGE)
  const recognizedArguments = workspaceIndex < 0
    ? 1
    : 3
  if (argumentsList.length !== recognizedArguments) throw new Error(USAGE)
  const result = await setupVsCode({ workspace: resolve(workspaceArgument) })
  process.stdout.write(
    `Configured VS Code/Cursor profile "Pi debugger" in ${result.workspace}.\n`,
  )
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
