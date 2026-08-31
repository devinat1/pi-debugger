import { resolve } from "node:path"
import { createAdapter, isAdapterType } from "../../src/adapter/registry"

const adapterType = Bun.argv[2]
if (!isAdapterType(adapterType)) {
  throw new Error("Usage: bun run test/manual/launch-smoke.ts <node|python|go>.")
}

const debuggerFixtures = {
  node: { program: resolve("samples/node/app.js"), line: 3 },
  python: { program: resolve("samples/python/app.py"), line: 3 },
  go: { program: resolve("samples/go/main.go"), line: 7, cwd: resolve("samples/go") },
}
const debuggerFixture = debuggerFixtures[adapterType]
const adapter = createAdapter(adapterType)

try {
  await adapter.launch({ type: adapterType, ...debuggerFixture })
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
}
