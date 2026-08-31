import type { AdapterType, DebugAdapter } from "./base"
import { GoAdapter } from "./go"
import { NodeAdapter } from "./node"
import { PythonAdapter } from "./python"

export function createAdapter(adapterType: AdapterType): DebugAdapter {
  if (adapterType === "node") return new NodeAdapter()
  if (adapterType === "python") return new PythonAdapter()
  return new GoAdapter()
}

export function detectType(program: string): AdapterType {
  if (program.endsWith(".py")) return "python"
  if (program.endsWith(".go")) return "go"
  if (/\.(?:[cm]?js|tsx?|jsx)$/.test(program)) return "node"
  throw new Error(
    `Cannot detect debugger for ${program}. Specify node, python, or go.`,
  )
}

export function isAdapterType(value?: string): value is AdapterType {
  return value === "node" || value === "python" || value === "go"
}
