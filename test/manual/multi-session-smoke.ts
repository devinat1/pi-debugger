import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { SessionManager } from "../../src/session/manager"
import { findFreePort } from "../../src/util/port"

const manager = new SessionManager()
const nodeProgram = resolve("samples/node/app.js")
const pythonProgram = resolve("samples/python/app.py")
const pythonPort = await findFreePort()
const python = spawn(
  "python3",
  [
    "-m",
    "debugpy",
    "--listen",
    `127.0.0.1:${pythonPort}`,
    "--wait-for-client",
    pythonProgram,
  ],
  { stdio: "ignore" },
)

try {
  const launched = await manager.launch(
    { type: "node", program: nodeProgram },
    "launched-node",
  )
  const attached = await manager.attach(
    { type: "python", port: pythonPort },
    "attached-python",
  )
  if (manager.list().length !== 2) throw new Error("Expected two live sessions")

  await launched.session.adapter.setBreakpoints(nodeProgram, [{ line: 3 }])
  await attached.session.adapter.setBreakpoints(pythonProgram, [{ line: 3 }])
  const nodeStop = await launched.session.adapter.continue()
  const pythonStop = await attached.session.adapter.continue()
  console.log({
    sessions: manager.list().map((session) => ({ id: session.id, name: session.name })),
    nodeStop,
    pythonStop,
    nodeVariables: await manager.require(launched.session.id).adapter.getVariables(),
    pythonVariables: await manager.require(attached.session.id).adapter.getVariables(),
  })

  await manager.stop(launched.session.id)
  if (manager.require(attached.session.id).name !== "attached-python") {
    throw new Error("Stopping one session affected the other")
  }
} finally {
  await manager.stopAll()
  python.kill("SIGKILL")
}
process.exit(0)
