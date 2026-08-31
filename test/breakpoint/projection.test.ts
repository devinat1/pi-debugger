import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { createBreakpointProjection } from "../../src/breakpoint/projection"
import type { BreakpointInfo, SessionState } from "../../src/session/state"

describe("createBreakpointProjection", () => {
  it("deduplicates breakpoint locations across live sessions", () => {
    const file = resolve("samples/node/app.js")
    const sessions: Pick<SessionState, "breakpoints">[] = [
      sessionWithBreakpoints(file, [
        { line: 3, verified: false },
        { line: 4, column: 2, verified: true },
      ]),
      sessionWithBreakpoints(file, [
        { line: 3, verified: true, condition: "value > 1" },
      ]),
    ]

    expect(createBreakpointProjection(sessions)).toEqual([
      { file, line: 3, verified: true },
      { file, line: 4, column: 2, verified: true },
    ])
  })
})

function sessionWithBreakpoints(
  file: string,
  breakpoints: BreakpointInfo[],
): Pick<SessionState, "breakpoints"> {
  return { breakpoints: new Map([[file, breakpoints]]) }
}
