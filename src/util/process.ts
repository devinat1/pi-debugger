import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { DapClient } from "../dap/client"

const CONNECTION_TIMEOUT = 10_000
const CONNECTION_RETRY_DELAY = 100

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

export async function connectDap(options: {
  host: string
  port: number
  timeout?: number
}): Promise<DapClient> {
  const timeout = options.timeout ?? CONNECTION_TIMEOUT
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const client = new DapClient({ host: options.host, port: options.port })
    try {
      await client.connect()
      return client
    } catch {
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_DELAY))
    }
  }
  throw new Error(
    `Timed out connecting to debugger at ${options.host}:${options.port}.`,
  )
}
