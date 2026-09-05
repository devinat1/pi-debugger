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
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { readEditorConfiguration } from "../../src/editor/config"
import { setupVsCode } from "../../src/editor/setup"
import { arrayValue, recordValue } from "../../src/util/value"

describe("setupVsCode", () => {
  it("preserves unrelated JSONC entries and writes readable bridge credentials", async () => {
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
    try {
      const result = await setupVsCode({ workspace, port: 43123 })
      const launchText = await readFile(join(vscodeDirectory, "launch.json"), "utf8")
      const launch = recordValue(parse(launchText))
      const launchEntries = arrayValue(launch?.configurations)
      const profile = namedEntry(launchEntries, "name", "Pi debugger")

      expect(launchText).toContain("Keep this launch profile")
      expect(launchEntries.map(recordValue).filter(Boolean)).toHaveLength(2)
      expect(namedEntry(launchEntries, "name", "Existing")).toBeDefined()
      expect(profile?.debugServer).toBe(43123)
      expect(profile?.piDebuggerToken).toBe(result.token)
      expect(await readEditorConfiguration(workspace)).toEqual({
        port: 43123,
        token: result.token,
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("atomically preserves permissions and rejects symbolic-link targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-debugger-safe-write-"))
    const vscodeDirectory = join(workspace, ".vscode")
    const targetFile = join(workspace, "target.json")
    const configurationFile = join(vscodeDirectory, "launch.json")
    await mkdir(vscodeDirectory)
    await writeFile(targetFile, "{}\n")
    await symlink(targetFile, configurationFile)
    try {
      await expect(setupVsCode({ workspace, port: 43124 })).rejects.toThrow(
        "symbolic link",
      )
      expect(await readFile(targetFile, "utf8")).toBe("{}\n")

      await rm(configurationFile)
      await writeFile(configurationFile, "{}\n")
      await chmod(configurationFile, 0o640)
      await setupVsCode({ workspace, port: 43124 })
      expect((await stat(configurationFile)).mode & 0o777).toBe(0o640)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

function namedEntry(
  values: unknown[],
  property: string,
  expected: string,
): Record<string, unknown> | undefined {
  return values
    .map(recordValue)
    .find((value) => value?.[property] === expected)
}
