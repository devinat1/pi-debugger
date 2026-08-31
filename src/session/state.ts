import type { DebugAdapter, StoppedInfo } from "../adapter/base"

export interface BreakpointInfo {
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
  verified: boolean
  id?: number
  message?: string
}

export interface SessionState {
  id: string
  name?: string
  mode: "launch" | "attach"
  adapter: DebugAdapter
  breakpoints: Map<string, BreakpointInfo[]>
  stoppedThreadId: number | null
  stoppedReason: string | null
}

export function createSessionState(
  id: string,
  adapter: DebugAdapter,
  mode: "launch" | "attach",
  name?: string,
): SessionState {
  return {
    id,
    name,
    mode,
    adapter,
    breakpoints: new Map(),
    stoppedThreadId: null,
    stoppedReason: null,
  }
}

export function recordStop(state: SessionState, event: StoppedInfo): void {
  state.stoppedThreadId = event.threadId ?? null
  state.stoppedReason = event.reason
}

export function getAllBreakpoints(
  state: SessionState,
): Record<string, BreakpointInfo[]> {
  return Object.fromEntries(state.breakpoints)
}
