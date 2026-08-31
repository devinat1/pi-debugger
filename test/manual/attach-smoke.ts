import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { createAdapter } from "../../src/adapter/registry"
import type { AdapterType, AttachConfig } from "../../src/adapter/base"
import { findFreePort } from "../../src/util/port"

const type = Bun.argv[2] as AdapterType | undefined
if (!type || !["node", "python", "go"].includes(type)) {
  throw new Error("Usage: bun run test/manual/attach-smoke.ts <node|python|go>")
}

const fixtures = {
  node: { program: resolve("samples/node/app.js"), line: 3 },
  python: { program: resolve("samples/python/app.py"), line: 3 },
  go: { program: resolve("samples/go/main.go"), line: 7 },
}
const fixture = fixtures[type]
const started = await startTarget(type, fixture.program, Bun.argv[3] === "port")
const adapter = createAdapter(type)

try {
  await adapter.attach({ type, ...started.config })
  console.log("initial", await adapter.waitForInitialPause())
  console.log(
    "breakpoints",
    await adapter.setBreakpoints(fixture.program, [{ line: fixture.line }]),
  )
  console.log("stop", await adapter.continue())
  console.log("stack", await adapter.getCallStack())
  console.log("variables", await adapter.getVariables())
} finally {
  await adapter.disconnect()
  for (const target of started.processes) target.kill("SIGKILL")
}
process.exit(0)

async function startTarget(
  adapterType: AdapterType,
  program: string,
  useGoPort: boolean,
): Promise<{ processes: ChildProcess[]; config: Omit<AttachConfig, "type"> }> {
  if (adapterType === "node") {
    const port = await findFreePort()
    return {
      processes: [
        spawn("node", [`--inspect-brk=127.0.0.1:${port}`, program], {
          stdio: "ignore",
        }),
      ],
      config: { port },
    }
  }
  if (adapterType === "python") {
    const port = await findFreePort()
    return {
      processes: [
        spawn(
          "python3",
          ["-m", "debugpy", "--listen", `127.0.0.1:${port}`, "--wait-for-client", program],
          { stdio: "ignore" },
        ),
      ],
      config: { port },
    }
  }
  const output = resolve("samples/go/pi-debugger-sample")
  const built = spawnSync(
    "go",
    ["build", "-gcflags=all=-N -l", "-o", output, "."],
    { cwd: resolve("samples/go"), stdio: "inherit" },
  )
  if (built.status !== 0) throw new Error("Failed to build Go attach fixture")
  const child = spawn(output, [], { stdio: "ignore" })
  if (!child.pid) throw new Error("Go attach fixture has no PID")
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (!useGoPort) return { processes: [child], config: { pid: child.pid } }
  const port = await findFreePort()
  const delve = spawn(
    "dlv",
    [
      "attach",
      String(child.pid),
      "--headless",
      "--api-version=2",
      `--listen=127.0.0.1:${port}`,
      "--accept-multiclient",
      "--check-go-version=false",
    ],
    { stdio: "ignore" },
  )
  return { processes: [delve, child], config: { port } }
}
