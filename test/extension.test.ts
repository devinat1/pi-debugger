import { describe, expect, it } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import piDebugger from "../extensions/pi-debugger"

describe("pi extension", () => {
  it("registers the complete native debugger tool surface", () => {
    const names: string[] = []
    const pi = {
      registerTool(tool: { name: string }) {
        names.push(tool.name)
      },
      on() {},
    } as unknown as ExtensionAPI

    piDebugger(pi)

    expect(names).toEqual([
      "debug_start_session",
      "debug_attach_session",
      "debug_stop_session",
      "debug_set_breakpoints",
      "debug_remove_breakpoints",
      "debug_list_breakpoints",
      "debug_continue",
      "debug_step_over",
      "debug_step_into",
      "debug_step_out",
      "debug_get_variables",
      "debug_get_call_stack",
      "debug_evaluate",
    ])
  })
})
