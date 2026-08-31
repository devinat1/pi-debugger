import { resolve } from "node:path"
import { createAdapter } from "../../src/adapter/registry"
import type { AdapterType } from "../../src/adapter/base"

const type = Bun.argv[2] as AdapterType | undefined
if (!type || !["node", "python", "go"].includes(type)) {
  throw new Error("Usage: bun run test/manual/launch-smoke.ts <node|python|go>")
}

const fixtures = {
  node: { program: resolve("samples/node/app.js"), line: 3 },
  python: { program: resolve("samples/python/app.py"), line: 3 },
  go: { program: resolve("samples/go/main.go"), line: 7, cwd: resolve("samples/go") },
}
const fixture = fixtures[type]
const adapter = createAdapter(type)

try {
  await adapter.launch({ type, ...fixture })
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
}
