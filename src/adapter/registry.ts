import type { AdapterType, DebugAdapter } from "./base"
import { GoAdapter } from "./go"
import { NodeAdapter } from "./node"
import { PythonAdapter } from "./python"

export function createAdapter(type: AdapterType): DebugAdapter {
  if (type === "node") return new NodeAdapter()
  if (type === "python") return new PythonAdapter()
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
