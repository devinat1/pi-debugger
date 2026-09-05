import { describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parse } from "jsonc-parser"
import { setupEditor } from "../../src/mirror/setup"
import { arrayValue, recordValue } from "../../src/util/value"

const EXECUTABLE = resolve("dist/pi-debugger-breakpoint-mirror.js")

describe("setupEditor", () => {
  it("creates an extension-free Zed debug profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-debugger-zed-"))
    try {
      const result = await setupEditor({
        editor: "zed",
        executable: EXECUTABLE,
        workspace,
        port: 43121,
      })
      const configuration = await parseFile(join(workspace, ".zed", "debug.json"))
      expect(result.port).toBe(43121)
      expect(configuration).toEqual([
        {
          label: "Pi debugger",
          adapter: "JavaScript",
          type: "node",
          request: "launch",
          program: result.workspace,
          tcp_connection: { host: "127.0.0.1", port: 43121 },
        },
      ])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("preserves unrelated VS Code JSONC entries and replaces its own entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-debugger-vscode-"))
    const vscodeDirectory = join(workspace, ".vscode")
    await mkdir(vscodeDirectory)
    await writeFile(
      join(vscodeDirectory, "launch.json"),
      `{
  // Keep this launch profile.
  "version": "0.2.0",
  "configurations": [
    { "name": "Existing", "type": "node", "request": "launch" },
    { "name": "Pi breakpoint mirror", "debugServer": 1 },
  ],
}
`,
    )
    await writeFile(
      join(vscodeDirectory, "tasks.json"),
      `{
  // Keep this task.
  "version": "2.0.0",
  "tasks": [
    { "label": "Existing task", "type": "shell", "command": "true" },
  ],
}
`,
    )
    try {
      await setupEditor({
        editor: "vscode",
        executable: EXECUTABLE,
        workspace,
        port: 43122,
      })
      await setupEditor({
        editor: "vscode",
        executable: EXECUTABLE,
        workspace,
        port: 43123,
      })
      const launchText = await readFile(join(vscodeDirectory, "launch.json"), "utf8")
      const tasksText = await readFile(join(vscodeDirectory, "tasks.json"), "utf8")
      const launch = recordValue(parse(launchText))
      const tasks = recordValue(parse(tasksText))
      const launchEntries = arrayValue(launch?.configurations)
      const taskEntries = arrayValue(tasks?.tasks)

      expect(launchText).toContain("Keep this launch profile")
      expect(tasksText).toContain("Keep this task")
      expect(launchEntries.map(recordValue).filter(Boolean)).toHaveLength(2)
      expect(taskEntries.map(recordValue).filter(Boolean)).toHaveLength(1)
      expect(namedEntry(launchEntries, "name", "Existing")).toBeDefined()
      expect(namedEntry(taskEntries, "label", "Existing task")).toBeDefined()
      expect(
        namedEntry(launchEntries, "name", "Pi debugger")?.debugServer,
      ).toBe(43123)
      expect(
        JSON.parse(await readFile(join(workspace, ".pi-debugger.json"), "utf8")),
      ).toEqual({ editorPort: 43123 })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("atomically preserves permissions and rejects symbolic-link targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-debugger-safe-write-"))
    const zedDirectory = join(workspace, ".zed")
    const targetFile = join(workspace, "target.json")
    const configurationFile = join(zedDirectory, "debug.json")
    await mkdir(zedDirectory)
    await writeFile(targetFile, "[]\n")
    await symlink(targetFile, configurationFile)
    try {
      await expect(setupEditor({
        editor: "zed",
        executable: EXECUTABLE,
        workspace,
        port: 43124,
      })).rejects.toThrow("symbolic link")
      expect(await readFile(targetFile, "utf8")).toBe("[]\n")

      await rm(configurationFile)
      await writeFile(configurationFile, "[]\n")
      await chmod(configurationFile, 0o640)
      await setupEditor({
        editor: "zed",
        executable: EXECUTABLE,
        workspace,
        port: 43124,
      })
      expect((await stat(configurationFile)).mode & 0o777).toBe(0o640)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

async function parseFile(file: string): Promise<unknown> {
  return parse(await readFile(file, "utf8"))
}

function namedEntry(
  values: unknown[],
  property: string,
  expected: string,
): Record<string, unknown> | undefined {
  return values
    .map(recordValue)
    .find((value) => value?.[property] === expected)
}
