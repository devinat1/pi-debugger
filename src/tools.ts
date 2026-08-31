import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AdapterType, StopResult } from "./adapter/base"
import { sessions } from "./session/manager"
import {
  getAllBreakpoints,
  type BreakpointInfo,
  type SessionState,
} from "./session/state"

const adapterType = Type.Union([
  Type.Literal("node"),
  Type.Literal("python"),
  Type.Literal("go"),
])
const sessionId = Type.String({
  description: "ID returned by debug_start_session or debug_attach_session",
})
const threadId = Type.Optional(
  Type.Number({ description: "Thread ID; defaults to the stopped thread" }),
)
const breakpoint = Type.Object({
  line: Type.Number({ description: "1-based line number" }),
  column: Type.Optional(Type.Number({ description: "1-based column number" })),
  condition: Type.Optional(Type.String()),
  hitCondition: Type.Optional(Type.String()),
  logMessage: Type.Optional(Type.String()),
})

export function registerDebuggerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "debug_start_session",
    label: "Start Debug Session",
    description:
      "Launch a Node, Python, or Go program under a debugger. Returns a sessionId and pauses at entry without stopping other sessions.",
    promptSnippet: "Launch a program in a native Node, Python, or Go debugger",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Human-readable session name" })),
      type: Type.Optional(adapterType),
      program: Type.String({ description: "Program or source path" }),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      runtimeExecutable: Type.Optional(
        Type.String({ description: "Node-family runtime: node, bun, tsx, or deno" }),
      ),
      runtimeArgs: Type.Optional(Type.Array(Type.String())),
      pythonPath: Type.Optional(Type.String()),
      module: Type.Optional(Type.String({ description: "Python module to run" })),
      dlvPath: Type.Optional(Type.String()),
      goMode: Type.Optional(Type.Union([Type.Literal("debug"), Type.Literal("test")])),
      buildFlags: Type.Optional(Type.String()),
      testFilter: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => {
        const created = await sessions.launch(
          {
            ...params,
            type: params.type as AdapterType | undefined,
            args: params.args,
          },
          params.name,
        )
        return sessionResult(created.session, created.initialStop)
      })
    },
  })

  pi.registerTool({
    name: "debug_attach_session",
    label: "Attach Debug Session",
    description:
      "Attach to an existing Node inspector, debugpy server/process, or Delve process/server. Returns a new isolated sessionId.",
    promptSnippet: "Attach a native debugger to an already-running process",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Human-readable session name" })),
      type: adapterType,
      host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      port: Type.Optional(Type.Number({ description: "Inspector, debugpy, or Delve port" })),
      pid: Type.Optional(Type.Number({ description: "Local process ID" })),
      cwd: Type.Optional(Type.String()),
      pythonPath: Type.Optional(Type.String()),
      dlvPath: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => {
        if (!params.port && !params.pid) throw new Error("Attach requires port or pid")
        const created = await sessions.attach(
          { ...params, type: params.type as AdapterType },
          params.name,
        )
        return sessionResult(created.session, created.initialStop)
      })
    },
  })

  pi.registerTool({
    name: "debug_stop_session",
    label: "Stop Debug Session",
    description: "Stop one debug session. Other sessions keep running.",
    parameters: Type.Object({ sessionId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => {
        const session = await sessions.stop(params.sessionId)
        return { sessionId: session.id, status: "stopped" }
      })
    },
  })

  pi.registerTool({
    name: "debug_set_breakpoints",
    label: "Set Breakpoints",
    description: "Add or replace breakpoints by line in one file for one session.",
    parameters: Type.Object({
      sessionId,
      file: Type.String({ description: "Absolute source file path" }),
      breakpoints: Type.Array(breakpoint),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => {
        const session = sessions.require(params.sessionId)
        const existing = session.breakpoints.get(params.file) ?? []
        const merged = [...existing]
        for (const item of params.breakpoints) {
          const index = merged.findIndex((current) => current.line === item.line)
          const next = { ...item, verified: false }
          if (index >= 0) merged[index] = next
          else merged.push(next)
        }
        const results = await session.adapter.setBreakpoints(params.file, merged)
        const updated = merged.map((item, index) => ({
          ...item,
          id: results[index]?.id,
          verified: results[index]?.verified ?? false,
          line: results[index]?.line ?? item.line,
          message: results[index]?.message,
        }))
        session.breakpoints.set(params.file, updated)
        return { sessionId: session.id, file: params.file, breakpoints: updated }
      })
    },
  })

  pi.registerTool({
    name: "debug_remove_breakpoints",
    label: "Remove Breakpoints",
    description: "Remove selected lines or every breakpoint in a file for one session.",
    parameters: Type.Object({
      sessionId,
      file: Type.String({ description: "Absolute source file path" }),
      lines: Type.Optional(Type.Array(Type.Number())),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => {
        const session = sessions.require(params.sessionId)
        const remaining = params.lines
          ? (session.breakpoints.get(params.file) ?? []).filter(
              (item) => !params.lines?.includes(item.line),
            )
          : []
        const results = await session.adapter.setBreakpoints(params.file, remaining)
        const updated: BreakpointInfo[] = remaining.map((item, index) => ({
          ...item,
          id: results[index]?.id,
          verified: results[index]?.verified ?? false,
          message: results[index]?.message,
        }))
        if (updated.length > 0) session.breakpoints.set(params.file, updated)
        else session.breakpoints.delete(params.file)
        return {
          sessionId: session.id,
          file: params.file,
          removed: params.lines ?? "all",
          remaining: updated.length,
        }
      })
    },
  })

  pi.registerTool({
    name: "debug_list_breakpoints",
    label: "List Breakpoints",
    description: "List breakpoints for one debug session.",
    parameters: Type.Object({ sessionId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        breakpoints: getAllBreakpoints(sessions.require(params.sessionId)),
      }))
    },
  })

  registerExecutionTool(pi, "debug_continue", "Continue", "Continue until the next stop", (session, id) =>
    session.adapter.continue(id),
  )
  registerExecutionTool(pi, "debug_step_over", "Step Over", "Step over the current line", (session, id) =>
    session.adapter.stepOver(id),
  )
  registerExecutionTool(pi, "debug_step_into", "Step Into", "Step into the current call", (session, id) =>
    session.adapter.stepIn(id),
  )
  registerExecutionTool(pi, "debug_step_out", "Step Out", "Step out to the caller", (session, id) =>
    session.adapter.stepOut(id),
  )

  pi.registerTool({
    name: "debug_get_variables",
    label: "Get Variables",
    description: "Inspect variables in a paused stack frame for one session.",
    parameters: Type.Object({
      sessionId,
      frameId: Type.Optional(Type.Number()),
      scope: Type.Optional(Type.String()),
      maxDepth: Type.Optional(Type.Number({ default: 1 })),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        variables: await sessions
          .require(params.sessionId)
          .adapter.getVariables(params.frameId, params.scope, params.maxDepth),
      }))
    },
  })

  pi.registerTool({
    name: "debug_get_call_stack",
    label: "Get Call Stack",
    description: "Get the paused call stack for one session.",
    parameters: Type.Object({ sessionId, threadId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        frames: await sessions
          .require(params.sessionId)
          .adapter.getCallStack(params.threadId),
      }))
    },
  })

  pi.registerTool({
    name: "debug_evaluate",
    label: "Evaluate Expression",
    description: "Evaluate an expression in a paused stack frame for one session.",
    parameters: Type.Object({
      sessionId,
      expression: Type.String(),
      frameId: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        ...(await sessions
          .require(params.sessionId)
          .adapter.evaluate(params.expression, params.frameId)),
      }))
    },
  })
}

function registerExecutionTool(
  pi: ExtensionAPI,
  name: "debug_continue" | "debug_step_over" | "debug_step_into" | "debug_step_out",
  label: string,
  description: string,
  execute: (session: SessionState, threadId?: number) => Promise<StopResult>,
): void {
  pi.registerTool({
    name,
    label,
    description,
    parameters: Type.Object({ sessionId, threadId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        ...formatStop(await execute(sessions.require(params.sessionId), params.threadId)),
      }))
    },
  })
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const value = await action()
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      details: value,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: message },
      isError: true,
    }
  }
}

function sessionResult(session: SessionState, stop: StopResult) {
  return {
    sessionId: session.id,
    name: session.name,
    adapterType: session.adapter.id,
    mode: session.mode,
    ...formatStop(stop),
  }
}

function formatStop(stop: StopResult) {
  if (stop.terminated) return { status: "terminated" }
  return {
    status: "stopped",
    reason: stop.reason,
    threadId: stop.threadId,
    location: stop.location,
  }
}
