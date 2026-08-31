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

export function createSessionState(options: {
  id: string
  adapter: DebugAdapter
  mode: "launch" | "attach"
  name?: string
}): SessionState {
  return {
    id: options.id,
    name: options.name,
    mode: options.mode,
    adapter: options.adapter,
    breakpoints: new Map(),
    stoppedThreadId: null,
    stoppedReason: null,
  }
}

export function recordStop(options: {
  state: SessionState
  event: StoppedInfo
}): void {
  options.state.stoppedThreadId = options.event.threadId ?? null
  options.state.stoppedReason = options.event.reason
}

export function getAllBreakpoints(
  state: SessionState,
): Record<string, BreakpointInfo[]> {
  return Object.fromEntries(state.breakpoints)
}
