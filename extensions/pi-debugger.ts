import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { sessions } from "../src/session/manager"
import { registerDebuggerTools } from "../src/tools"
import { startConfiguredEditorBridge } from "../src/editor/bridge"

export default function piDebugger(extensionApi: ExtensionAPI): void {
  const editorBridge = startEditorBridge()
  registerDebuggerTools(extensionApi)
  extensionApi.on("session_shutdown", async () => {
    await sessions.stopAll()
    await (await editorBridge)?.close()
  })
}

async function startEditorBridge() {
  try {
    return await startConfiguredEditorBridge({
      workspace: process.cwd(),
      sessions,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[pi-debugger] Cannot start the editor bridge: ${message}\n`)
    return null
  }
}
