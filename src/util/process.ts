import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { DapClient } from "../dap/client"

export function findExecutable(name: string): string | null {
  if (isAbsolute(name) || name.includes("/")) {
    try {
      accessSync(name, constants.X_OK)
      return name
    } catch {
      return null
    }
  }
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, name))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        return false
      }
    }) ?? null
}

export async function connectDap(
  host: string,
  port: number,
  timeout = 10_000,
): Promise<DapClient> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const client = new DapClient(host, port)
    try {
      await client.connect()
      return client
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Timed out connecting to debugger at ${host}:${port}`)
}
