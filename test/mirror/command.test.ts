import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { parseMirrorCommand } from "../../src/mirror/command"

describe("parseMirrorCommand", () => {
  it("requires an explicit supported editor for setup", () => {
    expect(() => parseMirrorCommand(["setup"])).toThrow("--editor is required")
    expect(() => parseMirrorCommand([
      "setup",
      "--editor",
      "vim",
    ])).toThrow("either zed or vscode")
  })

  it("parses setup and TCP serve commands", () => {
    expect(parseMirrorCommand([
      "setup",
      "--editor",
      "zed",
      "--workspace",
      "fixtures",
    ])).toEqual({
      kind: "setup",
      editor: "zed",
      workspace: resolve("fixtures"),
    })
    expect(parseMirrorCommand([
      "serve",
      "--port",
      "43123",
      "--detach",
    ])).toEqual({
      kind: "serve",
      port: 43123,
      workspace: process.cwd(),
      shouldDetach: true,
    })
  })

  it("preserves the legacy stdio command", () => {
    expect(parseMirrorCommand(["--workspace", "fixtures"])).toEqual({
      kind: "stdio",
      workspace: resolve("fixtures"),
    })
  })
})
