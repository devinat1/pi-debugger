# Project Guidelines

## Scope

- This is a standalone TypeScript pi package. Frontend, JSX, Tailwind, meeting ownership, Prisma, email-type placement, and component-fetch rules do not apply unless those domains are added later.
- Keep runtime control tools-only. A read-only DAP breakpoint mirror may expose source locations and generate project connection profiles for supported editors. Keep editor extensions, editor-specific runtime bridges, shared execution control, MCP servers, phase machines, teaching modes, and custom TUIs out of the package.
- Preserve independent named debugger sessions. Creating or attaching a session must not stop another session, and every later debugger operation must require `sessionId`.
- Do not modify the humancode repository. Reuse its debugger behavior here without adding a runtime dependency on a humancode checkout.

## Structure

- Reuse an existing function before creating another implementation of the same behavior.
- Keep helpers only when they are reused or isolate a meaningful boundary.
- Avoid unnecessary comments. Add comments only for non-obvious constraints or behavior.
- Keep DAP protocol types in `src/dap/types.ts` and shared adapter contracts in `src/adapter/base.ts`.
- Do not auto-install `node`, `debugpy`, or `dlv`. Missing-runtime errors must name the binary and include the exact install command.

## TypeScript

- Prefer `async`/`await`; avoid `.then()` and `.catch()`. Use `try`/`catch` when error handling is required.
- Avoid type casts unless TypeScript cannot express a verified boundary. Never use non-null assertions.
- Prefer object parameters with descriptive property names over multiple positional parameters.
- Use `const`; avoid `let` and reassignment.
- Write nullable fields explicitly as `value?: number | null` when both states are valid.
- Use `Item[]`, not `Array<Item>`.
- Check arrays with `items.length === 0` or `items.length > 0`, not array truthiness.
- Prefer immutable transformations such as `.map()`, `.filter()`, and `.reduce()` over mutation and manual loops.
- Use strong domain types instead of broad primitives or `any`.
- Use `null` for a completed lookup with no result and `undefined` for omitted caller input.

## Naming and Messages

- Use complete, intention-revealing names for variables, parameters, functions, and types.
- Prefix booleans with `is`, `has`, `should`, or another predicate verb.
- Write errors, comments, and logs as complete sentences ending with punctuation.
- Define named constants for unexplained magic values.
- Mark temporary code with `TODO(cleanup):`.

## Functional Style and Dependencies

- Prefer `Array.from()`, `.map()`, `.filter()`, and `.reduce()` over `for` loops when they remain clear.
- Reuse existing utilities such as `.toLocaleString()` and project helpers instead of recreating them.
- Use Lodash for operations such as mean or sum only when it materially improves clarity; do not add it when the platform API is sufficient.

## Verification

- Run `bun run check` after source changes.
- Run `npm pack --dry-run` after changing package contents or metadata.
- Keep macOS as the documented baseline; treat other operating systems as best-effort.
