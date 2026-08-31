import { describe, expect, it } from "bun:test"
import { requireDlv, resolveGoMode } from "../../src/adapter/go"
import { requireRuntime } from "../../src/adapter/node"
import { requireDebugpy } from "../../src/adapter/python"

describe("missing debugger prerequisites", () => {
  it("names node and its exact install command", () => {
    expect(() =>
      requireRuntime({ runtime: "node", resolver: () => null }),
    ).toThrow(
      "node not found on PATH. Install it with the following command.\nbrew install node",
    )
  })

  it("names debugpy and its exact install command", () => {
    expect(() =>
      requireDebugpy({ pythonPath: "python3", check: () => false }),
    ).toThrow(
      "debugpy was not found. Install it with the following command.\npython3 -m pip install debugpy",
    )
  })

  it("names dlv and its exact install command", () => {
    expect(() => requireDlv({ resolver: () => null })).toThrow(
      "dlv was not found on PATH. Install it with the following command.\ngo install github.com/go-delve/delve/cmd/dlv@latest",
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
