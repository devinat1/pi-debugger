import { describe, expect, it } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerDebuggerTools } from "../src/tools"

describe("pi extension", () => {
  it("registers the complete native debugger tool surface", () => {
    const registeredToolNames = new Set<string>()
    const extensionApi: Pick<ExtensionAPI, "registerTool"> = {
      registerTool(tool) {
        registeredToolNames.add(tool.name)
      },
    }

    registerDebuggerTools(extensionApi)

    expect(Array.from(registeredToolNames)).toEqual([
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
