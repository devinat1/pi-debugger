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
  location?: StopResult["location"]
}

export type ExecutionCommand = "continue" | "next" | "stepIn" | "stepOut"

export interface BreakpointResult {
  id?: number
  verified: boolean
  line?: number
  message?: string
}

export interface SetBreakpointsOptions {
  file: string
  breakpoints: SourceBreakpoint[]
}

export interface ThreadOptions {
  threadId?: number
}

export interface GetVariablesOptions {
  frameId?: number
  scope?: string
  maxDepth?: number
}

export interface EvaluateOptions {
  expression: string
  frameId?: number
}

export interface DebugAdapter {
  readonly id: AdapterType
  launch(config: LaunchConfig): Promise<void>
  attach(config: AttachConfig): Promise<void>
  waitForInitialPause(): Promise<StopResult>
  setBreakpoints(options: SetBreakpointsOptions): Promise<BreakpointResult[]>
  continue(options?: ThreadOptions): Promise<StopResult>
  stepOver(options?: ThreadOptions): Promise<StopResult>
  stepIn(options?: ThreadOptions): Promise<StopResult>
  stepOut(options?: ThreadOptions): Promise<StopResult>
  getCallStack(options?: ThreadOptions): Promise<StackFrame[]>
  getVariables(options?: GetVariablesOptions): Promise<Variable[]>
  evaluate(options: EvaluateOptions): Promise<EvalResult>
  disconnect(): Promise<void>
  onStopped(callback: (event: StoppedInfo) => void): () => void
  startExecution?(options: {
    command: ExecutionCommand
    threadId?: number
  }): Promise<void>
  pause?(options?: ThreadOptions): Promise<void>
  onContinued?(callback: (threadId: number) => void): () => void
  onTerminated?(callback: () => void): () => void
}
