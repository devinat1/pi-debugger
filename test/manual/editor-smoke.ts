import { resolve } from "node:path"
import { NodeAdapter } from "../../src/adapter/node"
import { startConfiguredEditorBridge } from "../../src/editor/bridge"
import { SessionManager } from "../../src/session/manager"

const workspace = resolve(import.meta.dir, "../..")
const program = resolve(workspace, "samples/node/app.js")
const sessions = new SessionManager(() => new NodeAdapter())
const created = await sessions.launch({
  config: { type: "node", program },
  name: "editor-smoke",
})
await sessions.setBreakpoints({
  sessionId: created.session.id,
  file: program,
  breakpoints: [{ line: 2 }],
})
const bridge = await startConfiguredEditorBridge({ workspace, sessions })
if (!bridge) {
  throw new Error("Run pi-debugger setup --editor vscode before this smoke test.")
}

process.stdout.write(
  `Editor smoke session ${created.session.id} is ready at ${program}:2.\n`,
)

await new Promise<void>((resolveStopped) => {
  process.once("SIGINT", resolveStopped)
  process.once("SIGTERM", resolveStopped)
})
await bridge.close()
await sessions.stopAll()
