export interface ProtocolMessage {
  seq: number
  type: "request" | "response" | "event"
}

export interface Request extends ProtocolMessage {
  type: "request"
  command: string
  arguments?: Record<string, unknown>
}

export interface Response extends ProtocolMessage {
  type: "response"
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: Record<string, unknown>
}

export interface Event extends ProtocolMessage {
  type: "event"
  event: string
  body?: Record<string, unknown>
}

export type DapMessage = Request | Response | Event

export interface Source {
  name?: string
  path?: string
  sourceReference?: number
}

export interface SourceBreakpoint {
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export interface StackFrame {
  id: number
  name: string
  source?: Source
  line: number
  column: number
}

export interface Variable {
  name: string
  value: string
  type?: string
  variablesReference: number
}
