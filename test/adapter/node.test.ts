import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { NodeAdapter } from "../../src/adapter/node"

const nextProgram = resolve("test/fixtures/next/dist/bin/next")
const nextWorkspace = resolve("test/fixtures/next")
const serverProgram = resolve("test/fixtures/next/dist/bin/server.js")
const serverSource = resolve("test/fixtures/next/dist/bin/server.ts")
const lazySource = resolve("test/fixtures/next/app/lazy.ts")

describe("NodeAdapter", () => {
  it("does not reject a pause waiter after launch already failed", async () => {
    const adapter = new NodeAdapter({
      inspectorTimeout: 20,
      pauseTimeout: 50,
    })
    try {
      await expect(
        adapter.launch({
          type: "node",
          program: serverProgram,
          runtimeExecutable: "/usr/bin/false",
        }),
      ).rejects.toThrow("Timed out waiting for Node inspector")
      await Bun.sleep(75)
    } finally {
      await adapter.disconnect()
    }
  })

  it("hands a Next.js launch to its inspected server child", async () => {
    const adapter = new NodeAdapter()
    try {
      await adapter.launch({
        type: "node",
        program: nextProgram,
        cwd: nextWorkspace,
      })
      await adapter.waitForInitialPause()

      const activeProgram = await adapter.evaluate({ expression: "process.argv[1]" })
      expect(activeProgram.result).toBe(JSON.stringify(serverProgram))

      expect(
        await adapter.setBreakpoints({
          file: serverSource,
          breakpoints: [{ line: 2 }],
        }),
      ).toEqual([{ id: 0, verified: true, line: 2 }])

      const stopped = await adapter.continue()
      expect(stopped.location?.file).toBe(serverSource)
      expect(stopped.location?.line).toBe(2)
    } finally {
      await adapter.disconnect()
    }
  }, 15_000)

  it("binds a source-mapped breakpoint before the script loads", async () => {
    const adapter = new NodeAdapter()
    try {
      await adapter.launch({
        type: "node",
        program: nextProgram,
        cwd: nextWorkspace,
      })
      await adapter.waitForInitialPause()

      expect(
        await adapter.setBreakpoints({
          file: lazySource,
          breakpoints: [{ line: 2 }],
        }),
      ).toEqual([{ id: 0, verified: true, line: 2 }])

      const stopped = await adapter.continue()
      expect(stopped.location?.file).toBe(lazySource)
      expect(stopped.location?.line).toBe(2)
    } finally {
      await adapter.disconnect()
    }
  }, 15_000)
})
