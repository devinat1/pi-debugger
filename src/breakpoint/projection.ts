import { resolve } from "node:path"
import type { SessionState } from "../session/state"

export interface MirroredBreakpoint {
  file: string
  line: number
  column?: number
  verified: boolean
}

export function createBreakpointProjection(
  sessions: Pick<SessionState, "breakpoints">[],
): MirroredBreakpoint[] {
  const breakpoints = sessions.flatMap((session) =>
    Array.from(session.breakpoints.entries()).flatMap(([file, items]) =>
      items.map((item) => ({
        file: resolve(file),
        line: item.line,
        column: item.column,
        verified: item.verified,
      })),
    ),
  )
  const grouped = breakpoints.reduce<Map<string, MirroredBreakpoint[]>>(
    (current, breakpoint) => {
      const key = breakpointKey(breakpoint)
      return new Map(current).set(key, [
        ...(current.get(key) ?? []),
        breakpoint,
      ])
    },
    new Map(),
  )
  return Array.from(grouped.values())
    .map((items) => ({
      ...items[0],
      verified: items.some((item) => item.verified),
    }))
    .sort(compareBreakpoints)
}

export function breakpointKey(
  breakpoint: Pick<MirroredBreakpoint, "file" | "line" | "column">,
): string {
  return JSON.stringify([
    resolve(breakpoint.file),
    breakpoint.line,
    breakpoint.column ?? null,
  ])
}

function compareBreakpoints(
  first: MirroredBreakpoint,
  second: MirroredBreakpoint,
): number {
  return (
    first.file.localeCompare(second.file) ||
    first.line - second.line ||
    (first.column ?? 0) - (second.column ?? 0)
  )
}
