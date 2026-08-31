import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { BreakpointStatePublisher } from "../src/breakpoint/state"
import { sessions } from "../src/session/manager"
import { registerDebuggerTools } from "../src/tools"

export default function piDebugger(extensionApi: ExtensionAPI): void {
  const publisher = new BreakpointStatePublisher({ workspace: process.cwd() })
  const stopPublishing = sessions.onBreakpointsChanged((breakpoints) =>
    publisher.publish(breakpoints),
  )
  registerDebuggerTools(extensionApi)
  extensionApi.on("session_shutdown", async () => {
    stopPublishing()
    await sessions.stopAll()
    await publisher.close()
  })
}
