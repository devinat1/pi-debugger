import { describe, expect, it } from "bun:test"
import { requireDlv, resolveGoMode } from "../../src/adapter/go"
import { requireRuntime } from "../../src/adapter/node"
import { requireDebugpy } from "../../src/adapter/python"

describe("missing debugger prerequisites", () => {
  it("names node and its exact install command", () => {
    expect(() => requireRuntime("node", () => null)).toThrow(
      "node not found on PATH. Install with: brew install node",
    )
  })

  it("names debugpy and its exact install command", () => {
    expect(() => requireDebugpy("python3", () => false)).toThrow(
      "debugpy not found. Install with: python3 -m pip install debugpy",
    )
  })

  it("names dlv and its exact install command", () => {
    expect(() => requireDlv(undefined, () => null)).toThrow(
      "dlv not found on PATH. Install with: go install github.com/go-delve/delve/cmd/dlv@latest",
    )
  })
})

describe("resolveGoMode", () => {
  it("detects tests and respects explicit mode", () => {
    expect(resolveGoMode({ type: "go", program: "thing_test.go" })).toBe("test")
    expect(
      resolveGoMode({ type: "go", program: "main.go", goMode: "test" }),
    ).toBe("test")
  })
})
