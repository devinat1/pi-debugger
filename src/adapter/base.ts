import type { SourceBreakpoint, StackFrame, Variable } from "../dap/types"

export type AdapterType = "node" | "python" | "go"

export interface LaunchConfig {
  type: AdapterType
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  runtimeExecutable?: string
  runtimeArgs?: string[]
  pythonPath?: string
  module?: string
  dlvPath?: string
  goMode?: "debug" | "test"
  buildFlags?: string
  testFilter?: string
}

export interface AttachConfig {
  type: AdapterType
  host?: string
  port?: number
  pid?: number
  cwd?: string
  pythonPath?: string
  dlvPath?: string
}

export interface StopResult {
  reason: string
  description?: string
  threadId?: number
  location?: {
    file?: string
    line?: number
    column?: number
    name?: string
  }
  terminated?: boolean
}

export interface EvalResult {
  result: string
  type?: string
  variablesReference?: number
}

export interface StoppedInfo {
  reason: string
  threadId?: number
  description?: string
}

export interface BreakpointResult {
  id?: number
  verified: boolean
  line?: number
  message?: string
}

export interface DebugAdapter {
  readonly id: AdapterType
  launch(config: LaunchConfig): Promise<void>
  attach(config: AttachConfig): Promise<void>
  waitForInitialPause(): Promise<StopResult>
  setBreakpoints(
    file: string,
    breakpoints: SourceBreakpoint[],
  ): Promise<BreakpointResult[]>
  continue(threadId?: number): Promise<StopResult>
  stepOver(threadId?: number): Promise<StopResult>
  stepIn(threadId?: number): Promise<StopResult>
  stepOut(threadId?: number): Promise<StopResult>
  getCallStack(threadId?: number): Promise<StackFrame[]>
  getVariables(
    frameId?: number,
    scope?: string,
    maxDepth?: number,
  ): Promise<Variable[]>
  evaluate(expression: string, frameId?: number): Promise<EvalResult>
  disconnect(): Promise<void>
  onStopped(callback: (event: StoppedInfo) => void): void
}
