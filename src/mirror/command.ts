import { resolve } from "node:path"
import type { SupportedEditor } from "./setup"

export type MirrorCommand =
  | { kind: "stdio"; workspace: string }
  | {
      kind: "serve"
      workspace: string
      port: number
      shouldDetach: boolean
    }
  | { kind: "setup"; workspace: string; editor: SupportedEditor }

const USAGE = `Usage:
  pi-debugger-breakpoint-mirror setup --editor <zed|vscode> [--workspace /absolute/path]
  pi-debugger-breakpoint-mirror serve --port <port> [--workspace /absolute/path] [--detach]
  pi-debugger-breakpoint-mirror [--workspace /absolute/path]`

export function parseMirrorCommand(argumentsList: string[]): MirrorCommand {
  const commandName = argumentsList[0]
  if (commandName === "setup") {
    const editor = optionValue({
      argumentsList: argumentsList.slice(1),
      name: "--editor",
      isRequired: true,
    })
    if (editor !== "zed" && editor !== "vscode") {
      throw new Error(`--editor must be either zed or vscode.\n\n${USAGE}`)
    }
    return {
      kind: "setup",
      editor,
      workspace: workspaceOption(argumentsList.slice(1)),
    }
  }
  if (commandName === "serve") {
    const portText = optionValue({
      argumentsList: argumentsList.slice(1),
      name: "--port",
      isRequired: true,
    })
    const port = Number(portText)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`--port must be an integer from 1 to 65535.\n\n${USAGE}`)
    }
    return {
      kind: "serve",
      port,
      workspace: workspaceOption(argumentsList.slice(1)),
      shouldDetach: argumentsList.slice(1).includes("--detach"),
    }
  }
  if (commandName === "--help" || commandName === "-h") {
    throw new Error(USAGE)
  }
  return { kind: "stdio", workspace: workspaceOption(argumentsList) }
}

function workspaceOption(argumentsList: string[]): string {
  return resolve(optionValue({
    argumentsList,
    name: "--workspace",
    isRequired: false,
  }) ?? process.cwd())
}

function optionValue(options: {
  argumentsList: string[]
  name: string
  isRequired: boolean
}): string | undefined {
  const optionIndex = options.argumentsList.indexOf(options.name)
  if (optionIndex === -1) {
    if (!options.isRequired) return undefined
    throw new Error(`${options.name} is required.\n\n${USAGE}`)
  }
  const value = options.argumentsList[optionIndex + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${options.name} requires a value.\n\n${USAGE}`)
  }
  return value
}
