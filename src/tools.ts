import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { StopResult } from "./adapter/base"
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

const textContentType: "text" = "text"

export function registerDebuggerTools(
  extensionApi: Pick<ExtensionAPI, "registerTool">,
): void {
  extensionApi.registerTool({
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
        const created = await sessions.launch({
          config: {
            ...params,
            args: params.args,
          },
          name: params.name,
        })
        return sessionResult({
          session: created.session,
          stop: created.initialStop,
        })
      })
    },
  })

  extensionApi.registerTool({
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
        if (!params.port && !params.pid) {
          throw new Error("Attach requires a port or PID.")
        }
        const created = await sessions.attach({
          config: params,
          name: params.name,
        })
        return sessionResult({
          session: created.session,
          stop: created.initialStop,
        })
      })
    },
  })

  extensionApi.registerTool({
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

  extensionApi.registerTool({
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
        const merged = params.breakpoints.reduce<BreakpointInfo[]>(
          (currentBreakpoints, item) => {
            const index = currentBreakpoints.findIndex(
              (current) => current.line === item.line,
            )
            const next = { ...item, verified: false }
            if (index < 0) return [...currentBreakpoints, next]
            return currentBreakpoints.map((current, currentIndex) =>
              currentIndex === index ? next : current,
            )
          },
          existing,
        )
        const results = await session.adapter.setBreakpoints({
          file: params.file,
          breakpoints: merged,
        })
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

  extensionApi.registerTool({
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
        const results = await session.adapter.setBreakpoints({
          file: params.file,
          breakpoints: remaining,
        })
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

  extensionApi.registerTool({
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

  registerExecutionTool({
    extensionApi,
    name: "debug_continue",
    label: "Continue",
    description: "Continue until the next stop",
    execute: (session, threadId) => session.adapter.continue({ threadId }),
  })
  registerExecutionTool({
    extensionApi,
    name: "debug_step_over",
    label: "Step Over",
    description: "Step over the current line",
    execute: (session, threadId) => session.adapter.stepOver({ threadId }),
  })
  registerExecutionTool({
    extensionApi,
    name: "debug_step_into",
    label: "Step Into",
    description: "Step into the current call",
    execute: (session, threadId) => session.adapter.stepIn({ threadId }),
  })
  registerExecutionTool({
    extensionApi,
    name: "debug_step_out",
    label: "Step Out",
    description: "Step out to the caller",
    execute: (session, threadId) => session.adapter.stepOut({ threadId }),
  })

  extensionApi.registerTool({
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
          .adapter.getVariables({
            frameId: params.frameId,
            scope: params.scope,
            maxDepth: params.maxDepth,
          }),
      }))
    },
  })

  extensionApi.registerTool({
    name: "debug_get_call_stack",
    label: "Get Call Stack",
    description: "Get the paused call stack for one session.",
    parameters: Type.Object({ sessionId, threadId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        frames: await sessions
          .require(params.sessionId)
          .adapter.getCallStack({ threadId: params.threadId }),
      }))
    },
  })

  extensionApi.registerTool({
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
          .adapter.evaluate({
            expression: params.expression,
            frameId: params.frameId,
          })),
      }))
    },
  })
}

function registerExecutionTool(options: {
  extensionApi: Pick<ExtensionAPI, "registerTool">
  name: "debug_continue" | "debug_step_over" | "debug_step_into" | "debug_step_out"
  label: string
  description: string
  execute: (session: SessionState, threadId?: number) => Promise<StopResult>
}): void {
  options.extensionApi.registerTool({
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: Type.Object({ sessionId, threadId }),
    async execute(_toolCallId, params) {
      return toolResult(async () => ({
        sessionId: params.sessionId,
        ...formatStop(
          await options.execute(
            sessions.require(params.sessionId),
            params.threadId,
          ),
        ),
      }))
    },
  })
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const value = await action()
    return {
      content: [{ type: textContentType, text: JSON.stringify(value, null, 2) }],
      details: value,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: textContentType, text: message }],
      details: { error: message },
      isError: true,
    }
  }
}

function sessionResult(options: { session: SessionState; stop: StopResult }) {
  return {
    sessionId: options.session.id,
    name: options.session.name,
    adapterType: options.session.adapter.id,
    mode: options.session.mode,
    ...formatStop(options.stop),
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
