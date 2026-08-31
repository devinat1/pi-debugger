# pi-debugger

Native debugger tools for the [pi coding agent](https://github.com/earendil-works/pi). It uses CDP/DAP directly—no MCP server, editor-specific extension, or humancode checkout.

Supported runtimes:

- Node.js, Bun, tsx, and Deno through the Node inspector
- Python through debugpy
- Go through Delve (`dlv`)

macOS is the v1 baseline. Linux and Windows are best-effort.

## Install

From npm:

```sh
pi install npm:@devinat1/pi-debugger
```

From GitHub:

```sh
pi install git:github.com/devinat1/pi-debugger
```

Restart pi or run `/reload`. The `debug_*` tools appear with no MCP configuration.

## Prerequisites

Install only the adapters you use. pi-debugger never installs them for you.

```sh
brew install node
python3 -m pip install debugpy
go install github.com/go-delve/delve/cmd/dlv@latest
```

When a prerequisite is missing, the tool call fails with the relevant command above. Make sure `$HOME/go/bin` is on `PATH` after installing Delve.

## Tools

Every tool except start and attach requires the `sessionId` returned by the creating call.

| Tool | Purpose |
| --- | --- |
| `debug_start_session` | Launch and pause a program at entry |
| `debug_attach_session` | Attach by inspector/debug-server port or local PID |
| `debug_stop_session` | Stop or detach one session |
| `debug_set_breakpoints` | Add or update source breakpoints |
| `debug_remove_breakpoints` | Remove selected or all breakpoints in a file |
| `debug_list_breakpoints` | List a session's breakpoints |
| `debug_continue` | Continue to the next stop |
| `debug_step_over`, `debug_step_into`, `debug_step_out` | Step execution |
| `debug_get_variables` | Inspect variables in a frame |
| `debug_get_call_stack` | Inspect stack frames |
| `debug_evaluate` | Evaluate an expression in a frame |

Starting or attaching another session does not replace existing sessions. You can keep two or more live and direct every action with `sessionId`.

## Node launch

Start pi from this repository, then ask:

> Launch `samples/node/app.js` with the Node debugger. Set a breakpoint at line 3, continue, then show variables and the call stack.

The corresponding tool sequence is:

```text
debug_start_session({ type: "node", program: "/absolute/path/pi-debugger/samples/node/app.js" })
→ { sessionId: "debug-1", ... }

debug_set_breakpoints({ sessionId: "debug-1", file: "/absolute/path/pi-debugger/samples/node/app.js", breakpoints: [{ line: 3 }] })
debug_continue({ sessionId: "debug-1" })
debug_get_variables({ sessionId: "debug-1" })
debug_get_call_stack({ sessionId: "debug-1" })
```

Set `runtimeExecutable` to `bun`, `tsx`, or `deno` and use `runtimeArgs` when that runtime needs a subcommand such as `deno run`.

### Next.js

Launch the app through its resolved Next.js executable and set the workspace as
`cwd`:

```text
debug_start_session({
  type: "node",
  program: "/absolute/path/app/node_modules/next/dist/bin/next",
  args: ["dev"],
  cwd: "/absolute/path/app"
})
```

pi-debugger automatically follows the request-serving Node child. Breakpoints
set in TypeScript or TSX source files are mapped through Next.js source maps,
including breakpoints set before a route chunk loads. No editor extension or
manual inspector port is required.

### Node attach

The usual Node attach target is an inspector port:

```sh
node --inspect-brk=127.0.0.1:9229 samples/node/app.js
```

Then ask pi:

> Attach the Node debugger to port 9229, set a breakpoint at line 3 of the absolute `samples/node/app.js` path, continue, then inspect variables and the stack.

This starts with:

```text
debug_attach_session({ type: "node", port: 9229 })
```

PID-only Node attach is best-effort on macOS/Linux: pi-debugger sends `SIGUSR1` and connects to Node's default port 9229. Prefer an explicit port, especially if the process already uses a custom inspector port. Windows requires a port.

## Python launch

Ask pi:

> Launch `samples/python/app.py` with debugpy. Set a breakpoint at line 3, continue, then show variables and the call stack.

The corresponding tool sequence is:

```text
debug_start_session({ type: "python", program: "/absolute/path/pi-debugger/samples/python/app.py" })
→ { sessionId: "debug-2", ... }

debug_set_breakpoints({ sessionId: "debug-2", file: "/absolute/path/pi-debugger/samples/python/app.py", breakpoints: [{ line: 3 }] })
debug_continue({ sessionId: "debug-2" })
debug_get_variables({ sessionId: "debug-2" })
debug_get_call_stack({ sessionId: "debug-2" })
```

### Python attach

The usual Python attach target is a debugpy listen port:

```sh
python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client samples/python/app.py
```

Then ask pi:

> Attach debugpy on port 5678, set a breakpoint at line 3 of the absolute `samples/python/app.py` path, continue, then inspect variables and the stack.

This starts with:

```text
debug_attach_session({ type: "python", port: 5678 })
```

For PID injection, use `debug_attach_session({ type: "python", pid: 12345 })`. debugpy injection is subject to the operating system's process-attach permissions.

## Go launch

Ask pi:

> Launch `samples/go/main.go` with Delve using `samples/go` as cwd. Set a breakpoint at line 7, continue, then show variables and the call stack.

The corresponding tool sequence is:

```text
debug_start_session({ type: "go", program: "/absolute/path/pi-debugger/samples/go/main.go", cwd: "/absolute/path/pi-debugger/samples/go" })
→ { sessionId: "debug-3", ... }

debug_set_breakpoints({ sessionId: "debug-3", file: "/absolute/path/pi-debugger/samples/go/main.go", breakpoints: [{ line: 7 }] })
debug_continue({ sessionId: "debug-3" })
debug_get_variables({ sessionId: "debug-3" })
debug_get_call_stack({ sessionId: "debug-3" })
```

Files ending in `_test.go` use `dlv test` automatically. `goMode`, `buildFlags`, and `testFilter` can override test launches.

### Go attach by PID

Build with optimizations disabled, start the sample, and capture its PID:

```sh
cd samples/go
go build -gcflags="all=-N -l" -o pi-debugger-sample .
./pi-debugger-sample &
TARGET_PID=$!
```

Then ask pi:

> Attach Delve to PID `$TARGET_PID`, set a breakpoint at line 7 of the absolute `samples/go/main.go` path, continue, then inspect variables and the stack.

This starts with:

```text
debug_attach_session({ type: "go", pid: 12345 })
```

### Go attach by port

Port attach expects a Delve headless server that already owns the target (not a waiting `dlv dap` server):

```sh
dlv attach "$TARGET_PID" --headless --api-version=2 --listen=127.0.0.1:2345 --accept-multiclient
```

Then use:

```text
debug_attach_session({ type: "go", port: 2345 })
```

Delve attach may require Developer Tools permission on macOS. Stopping an attached session detaches without terminating the target; stopping a launched session terminates its debuggee.

## Multiple sessions

Keep the returned IDs separate:

```text
debug_start_session({ name: "api", type: "node", program: "/abs/api.js" })
→ { sessionId: "debug-1" }

debug_attach_session({ name: "worker", type: "python", port: 5678 })
→ { sessionId: "debug-2" }

debug_get_call_stack({ sessionId: "debug-1" })
debug_get_variables({ sessionId: "debug-2" })
```

## Editor breakpoint mirror

pi-debugger can show pi-created source breakpoints as native markers in Zed or
VS Code without installing an editor extension. Run one setup command from the
workspace root:

```sh
pi-debugger-breakpoint-mirror setup --editor zed
# or
pi-debugger-breakpoint-mirror setup --editor vscode
```

`--editor` is required. Use `--workspace /absolute/path` when running the
command outside the target workspace.

Then:

1. Start pi in the same workspace and create breakpoints through pi.
2. Open the editor's debugger and start **Pi breakpoint mirror**.
3. Leave that debug session open while pi adds, removes, or verifies breakpoints.

For a package checkout, build and run the local executable instead:

```sh
bun run build:mirror
./dist/pi-debugger-breakpoint-mirror.js setup --editor zed
```

Setup creates or updates one named entry in `.zed/debug.json`, or one named entry
each in `.vscode/launch.json` and `.vscode/tasks.json`. Other entries and JSONC
comments are preserved. The generated profile contains absolute workspace and
executable paths, so rerun setup after moving the package or copying the project
to another machine.

The profile starts a one-client DAP server on `127.0.0.1` and uses the editor's
built-in JavaScript debugger identity to connect to it. The server exits after
the editor disconnects or after 30 seconds without a connection. It never
connects to Node, debugpy, or Delve, so it cannot compete with pi for pause,
continue, or stepping control. The displayed markers are the deduplicated union
from every live pi session in the workspace. Editor changes remain read-only;
pi stays authoritative.

## Maintainer checks

```sh
bun install
bun run check
bun run test/manual/launch-smoke.ts node
bun run test/manual/launch-smoke.ts python
bun run test/manual/launch-smoke.ts go
bun run test/manual/attach-smoke.ts node
bun run test/manual/attach-smoke.ts python
bun run test/manual/attach-smoke.ts go
bun run test/manual/attach-smoke.ts go port
bun run test/manual/multi-session-smoke.ts
npm pack --dry-run
```

The manual smoke tests exercise breakpoint, continue, variables, and stack inspection. Go PID attach depends on local Developer Tools permission.

## Security

Debugger protocols can execute code in the target process. Bind inspector, debugpy, and Delve ports to `127.0.0.1`; use an authenticated tunnel for remote targets. The breakpoint mirror writes only absolute source paths and breakpoint locations to per-process files under the operating system's temporary directory, and removes its file during a clean pi shutdown.

## License

MIT. The core DAP client and adapters were extracted from humancode's `packages/debugger` and adapted for pi's native extension API.
