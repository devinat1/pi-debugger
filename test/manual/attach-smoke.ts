import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { createAdapter, isAdapterType } from "../../src/adapter/registry"
import type { AdapterType, AttachConfig } from "../../src/adapter/base"
import { findFreePort } from "../../src/util/port"

const TARGET_START_DELAY = 250

const adapterType = Bun.argv[2]
if (!isAdapterType(adapterType)) {
  throw new Error("Usage: bun run test/manual/attach-smoke.ts <node|python|go>.")
}

const debuggerFixtures = {
  node: { program: resolve("samples/node/app.js"), line: 3 },
  python: { program: resolve("samples/python/app.py"), line: 3 },
  go: { program: resolve("samples/go/main.go"), line: 7 },
}
const debuggerFixture = debuggerFixtures[adapterType]
const startedTarget = await startTarget({
  adapterType,
  program: debuggerFixture.program,
  shouldUseGoPort: Bun.argv[3] === "port",
})
const adapter = createAdapter(adapterType)

try {
  await adapter.attach({ type: adapterType, ...startedTarget.config })
  console.log("Initial pause.", await adapter.waitForInitialPause())
  console.log(
    "Breakpoints configured.",
    await adapter.setBreakpoints({
      file: debuggerFixture.program,
      breakpoints: [{ line: debuggerFixture.line }],
    }),
  )
  console.log("Debugger stopped.", await adapter.continue())
  console.log("Call stack received.", await adapter.getCallStack())
  console.log("Variables received.", await adapter.getVariables())
} finally {
  await adapter.disconnect()
  startedTarget.processes.forEach((target) => target.kill("SIGKILL"))
}
process.exit(0)

async function startTarget(options: {
  adapterType: AdapterType
  program: string
  shouldUseGoPort: boolean
}): Promise<{ processes: ChildProcess[]; config: Omit<AttachConfig, "type"> }> {
  if (options.adapterType === "node") {
    const port = await findFreePort()
    return {
      processes: [
        spawn("node", [`--inspect-brk=127.0.0.1:${port}`, options.program], {
          stdio: "ignore",
        }),
      ],
      config: { port },
    }
  }
  if (options.adapterType === "python") {
    const port = await findFreePort()
    return {
      processes: [
        spawn(
          "python3",
          [
            "-m",
            "debugpy",
            "--listen",
            `127.0.0.1:${port}`,
            "--wait-for-client",
            options.program,
          ],
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
  if (built.status !== 0) throw new Error("Failed to build Go attach fixture.")
  const child = spawn(output, [], { stdio: "ignore" })
  if (!child.pid) throw new Error("Go attach fixture has no PID.")
  await new Promise((resolve) => setTimeout(resolve, TARGET_START_DELAY))
  if (!options.shouldUseGoPort) {
    return { processes: [child], config: { pid: child.pid } }
  }
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
