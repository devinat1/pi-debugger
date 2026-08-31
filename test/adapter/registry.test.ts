import { describe, expect, it } from "bun:test"
import { detectType } from "../../src/adapter/registry"

describe("detectType", () => {
  it("detects supported source files", () => {
    expect(detectType("app.ts")).toBe("node")
    expect(detectType("app.py")).toBe("python")
    expect(detectType("main.go")).toBe("go")
  })

  it("requires an explicit type for unknown files", () => {
    expect(() => detectType("app.bin")).toThrow("Specify node, python, or go")
  })
})
