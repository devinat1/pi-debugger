import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import {
  arrayValue,
  numberValue,
  recordValue,
  stringValue,
} from "../util/value"

export const EDITOR_PROFILE_NAME = "Pi debugger"

export interface EditorConfiguration {
  port: number
  token: string
}

export async function readEditorConfiguration(
  workspace: string,
): Promise<EditorConfiguration | null> {
  try {
    const launchConfiguration = recordValue(
      parse(
        await readFile(join(workspace, ".vscode", "launch.json"), "utf8"),
      ),
    )
    const editorProfile = arrayValue(launchConfiguration?.configurations)
      .map(recordValue)
      .find((configuration) =>
        stringValue(configuration?.name) === EDITOR_PROFILE_NAME
      )
    const port = numberValue(editorProfile?.debugServer)
    const token = stringValue(editorProfile?.piDebuggerToken)
    return port !== undefined &&
        Number.isSafeInteger(port) &&
        port > 0 &&
        port <= 65_535 &&
        token !== undefined &&
        token.length > 0
      ? { port, token }
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
