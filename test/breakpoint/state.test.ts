import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BreakpointStatePublisher,
  readBreakpointProjection,
} from "../../src/breakpoint/state"

const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(
    Array.from(temporaryDirectories).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  temporaryDirectories.clear()
})

describe("breakpoint state", () => {
  it("publishes and merges live producers without repository files", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const workspace = join(temporaryDirectory, "workspace")
    const stateRoot = join(temporaryDirectory, "state")
    await mkdir(workspace)
    const first = new BreakpointStatePublisher({
      workspace,
      stateRoot,
      producerId: "first",
      producerPid: 101,
    })
    const second = new BreakpointStatePublisher({
      workspace,
      stateRoot,
      producerId: "second",
      producerPid: 202,
    })

    await first.publish([
      { file: join(workspace, "app.ts"), line: 3, verified: false },
    ])
    await second.publish([
      { file: join(workspace, "app.ts"), line: 3, verified: true },
      { file: join(workspace, "worker.ts"), line: 8, verified: true },
    ])

    expect(
      await readBreakpointProjection({
        workspace,
        stateRoot,
        isProcessAlive: (pid) => pid === 101 || pid === 202,
      }),
    ).toEqual([
      { file: join(workspace, "app.ts"), line: 3, verified: true },
      { file: join(workspace, "worker.ts"), line: 8, verified: true },
    ])

    await second.close()
    expect(
      await readBreakpointProjection({
        workspace,
        stateRoot,
        isProcessAlive: (pid) => pid === 101 || pid === 202,
      }),
    ).toEqual([
      { file: join(workspace, "app.ts"), line: 3, verified: false },
    ])
    await first.close()
  })

  it("ignores stale producers", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const workspace = join(temporaryDirectory, "workspace")
    const stateRoot = join(temporaryDirectory, "state")
    await mkdir(workspace)
    const publisher = new BreakpointStatePublisher({
      workspace,
      stateRoot,
      producerId: "stale",
      producerPid: 303,
    })
    await publisher.publish([
      { file: join(workspace, "app.ts"), line: 3, verified: true },
    ])

    expect(
      await readBreakpointProjection({
        workspace,
        stateRoot,
        isProcessAlive: () => false,
      }),
    ).toEqual([])
    await publisher.close()
  })

  it("lets a replacement publisher own the process state file", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const workspace = join(temporaryDirectory, "workspace")
    const stateRoot = join(temporaryDirectory, "state")
    await mkdir(workspace)
    const first = new BreakpointStatePublisher({
      workspace,
      stateRoot,
      producerId: "first",
      producerPid: 404,
    })
    const replacement = new BreakpointStatePublisher({
      workspace,
      stateRoot,
      producerId: "replacement",
      producerPid: 404,
    })
    await first.publish([
      { file: join(workspace, "old.ts"), line: 3, verified: true },
    ])
    await replacement.publish([
      { file: join(workspace, "current.ts"), line: 8, verified: true },
    ])

    await first.close()
    expect(
      await readBreakpointProjection({
        workspace,
        stateRoot,
        isProcessAlive: () => true,
      }),
    ).toEqual([
      { file: join(workspace, "current.ts"), line: 8, verified: true },
    ])
    await replacement.close()
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-debugger-breakpoints-"))
  temporaryDirectories.add(directory)
  return directory
}
