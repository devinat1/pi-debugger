import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { sessions } from "../src/session/manager"
import { registerDebuggerTools } from "../src/tools"

export default function piDebugger(extensionApi: ExtensionAPI): void {
  registerDebuggerTools(extensionApi)
  extensionApi.on("session_shutdown", async () => {
    await sessions.stopAll()
  })
}
