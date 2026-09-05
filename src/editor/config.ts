import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { numberValue, recordValue } from "../util/value"

export const EDITOR_CONFIGURATION_FILE = ".pi-debugger.json"

export async function readEditorPort(workspace: string): Promise<number | null> {
  try {
    const configuration = recordValue(
      parse(await readFile(join(workspace, EDITOR_CONFIGURATION_FILE), "utf8")),
    )
    const port = numberValue(configuration?.editorPort)
    return port !== undefined && Number.isSafeInteger(port) && port > 0 && port <= 65_535
      ? port
      : null
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? String(Reflect.get(error, "code") ?? "") || undefined
    : undefined
}
