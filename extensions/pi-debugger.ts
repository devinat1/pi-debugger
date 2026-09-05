import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createBreakpointProjection } from "../src/breakpoint/projection"
import { BreakpointStatePublisher } from "../src/breakpoint/state"
import { sessions } from "../src/session/manager"
import { registerDebuggerTools } from "../src/tools"
import { startConfiguredEditorBridge } from "../src/editor/bridge"

export default function piDebugger(extensionApi: ExtensionAPI): void {
  const editorBridge = startEditorBridge()
  const publisher = new BreakpointStatePublisher({ workspace: process.cwd() })
  const stopPublishing = sessions.onBreakpointsChanged((breakpoints) =>
    publisher.publish(breakpoints),
  )
  void publishInitialBreakpoints(publisher)
  registerDebuggerTools(extensionApi)
  extensionApi.on("session_shutdown", async () => {
    stopPublishing()
    await sessions.stopAll()
    await (await editorBridge)?.close()
    await publisher.close()
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

async function publishInitialBreakpoints(
  publisher: BreakpointStatePublisher,
): Promise<void> {
  try {
    await publisher.publish(createBreakpointProjection(sessions.list()))
  } catch {
    // Debugger tools remain usable when the optional editor mirror cannot publish.
  }
}
