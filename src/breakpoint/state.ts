import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { MirroredBreakpoint } from "./projection"
import { breakpointKey } from "./projection"

const BREAKPOINT_STATE_VERSION = 1
const DEFAULT_POLL_INTERVAL = 250
const STATE_DIRECTORY_NAME = "pi-debugger-breakpoints"

interface BreakpointStateSnapshot {
  version: typeof BREAKPOINT_STATE_VERSION
  workspace: string
  producerId: string
  producerPid: number
  updatedAt: string
  breakpoints: MirroredBreakpoint[]
}

export class BreakpointStatePublisher {
  private pendingWrite: Promise<void> | null = null
  private readonly workspace: string
  private readonly stateDirectory: string
  private readonly stateFile: string
  private readonly producerId: string
  private readonly producerPid: number

  constructor(options: {
    workspace: string
    stateRoot?: string
    producerId?: string
    producerPid?: number
  }) {
    this.workspace = canonicalWorkspace(options.workspace)
    this.stateDirectory = breakpointStateDirectory({
      workspace: this.workspace,
      stateRoot: options.stateRoot,
    })
    this.producerId = options.producerId ?? randomUUID()
    this.producerPid = options.producerPid ?? process.pid
    this.stateFile = join(
      this.stateDirectory,
      `${this.producerPid}-${this.producerId}.json`,
    )
  }

  async publish(breakpoints: MirroredBreakpoint[]): Promise<void> {
    const previousWrite = this.pendingWrite
    const nextWrite = this.writeAfter({ previousWrite, breakpoints })
    this.pendingWrite = nextWrite
    try {
      await nextWrite
    } finally {
      if (this.pendingWrite === nextWrite) this.pendingWrite = null
    }
  }

  async close(): Promise<void> {
    if (this.pendingWrite) {
      try {
        await this.pendingWrite
      } catch {
        // The original publish call reports the write failure.
      }
    }
    await rm(this.stateFile, { force: true })
  }

  private async writeAfter(options: {
    previousWrite: Promise<void> | null
    breakpoints: MirroredBreakpoint[]
  }): Promise<void> {
    if (options.previousWrite) {
      try {
        await options.previousWrite
      } catch {
        // A later snapshot can recover from an earlier failed write.
      }
    }
    await mkdir(this.stateDirectory, { recursive: true })
    const snapshot: BreakpointStateSnapshot = {
      version: BREAKPOINT_STATE_VERSION,
      workspace: this.workspace,
      producerId: this.producerId,
      producerPid: this.producerPid,
      updatedAt: new Date().toISOString(),
      breakpoints: options.breakpoints,
    }
    const temporaryFile = `${this.stateFile}.${randomUUID()}.tmp`
    await writeFile(temporaryFile, `${JSON.stringify(snapshot)}\n`, "utf8")
    await rename(temporaryFile, this.stateFile)
  }
}

export interface BreakpointProjectionSource {
  start(options: {
    onChange: (breakpoints: MirroredBreakpoint[]) => void
  }): Promise<void>
  stop(): void
}

export class BreakpointStateReader implements BreakpointProjectionSource {
  private currentProjection: MirroredBreakpoint[] = []
  private interval: ReturnType<typeof setInterval> | null = null
  private readonly workspace: string
  private readonly stateDirectory: string

  constructor(
    options: {
      workspace: string
      stateRoot?: string
      pollInterval?: number
      isProcessAlive?: (pid: number) => boolean
    },
  ) {
    this.workspace = canonicalWorkspace(options.workspace)
    this.stateDirectory = breakpointStateDirectory({
      workspace: this.workspace,
      stateRoot: options.stateRoot,
    })
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive
  }

  private readonly pollInterval: number
  private readonly isProcessAlive: (pid: number) => boolean

  async start(options: {
    onChange: (breakpoints: MirroredBreakpoint[]) => void
  }): Promise<void> {
    this.onChange = options.onChange
    await this.refresh()
    this.interval = setInterval(() => {
      void this.refresh()
    }, this.pollInterval)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.onChange = null
  }

  private onChange: ((breakpoints: MirroredBreakpoint[]) => void) | null = null

  private async refresh(): Promise<void> {
    try {
      const projection = await readBreakpointProjection({
        workspace: this.workspace,
        stateDirectory: this.stateDirectory,
        isProcessAlive: this.isProcessAlive,
      })
      if (JSON.stringify(projection) === JSON.stringify(this.currentProjection)) return
      this.currentProjection = projection
      this.onChange?.(projection)
    } catch {
      // Keep the last valid projection when one polling pass fails.
    }
  }
}

export async function readBreakpointProjection(options: {
  workspace: string
  stateRoot?: string
  stateDirectory?: string
  isProcessAlive?: (pid: number) => boolean
}): Promise<MirroredBreakpoint[]> {
  const workspace = canonicalWorkspace(options.workspace)
  const stateDirectory =
    options.stateDirectory ??
    breakpointStateDirectory({ workspace, stateRoot: options.stateRoot })
  const fileNames = await readDirectoryOrEmpty(stateDirectory)
  const snapshots = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) =>
        readSnapshot({ file: join(stateDirectory, fileName), workspace }),
      ),
  )
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const breakpoints = snapshots.flatMap((snapshot) =>
    snapshot && isProcessAlive(snapshot.producerPid)
      ? snapshot.breakpoints
      : [],
  )
  return mergeBreakpoints(breakpoints)
}

export function breakpointStateDirectory(options: {
  workspace: string
  stateRoot?: string
}): string {
  const workspaceHash = createHash("sha256")
    .update(canonicalWorkspace(options.workspace))
    .digest("hex")
  return join(
    options.stateRoot ?? tmpdir(),
    STATE_DIRECTORY_NAME,
    workspaceHash,
  )
}

function canonicalWorkspace(workspace: string): string {
  const absoluteWorkspace = resolve(workspace)
  try {
    return realpathSync(absoluteWorkspace)
  } catch {
    return absoluteWorkspace
  }
}

async function readDirectoryOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
}

async function readSnapshot(options: {
  file: string
  workspace: string
}): Promise<BreakpointStateSnapshot | null> {
  try {
    const value: unknown = JSON.parse(await readFile(options.file, "utf8"))
    return parseSnapshot({ value, workspace: options.workspace })
  } catch {
    return null
  }
}

function parseSnapshot(options: {
  value: unknown
  workspace: string
}): BreakpointStateSnapshot | null {
  if (!isRecord(options.value)) return null
  if (options.value.version !== BREAKPOINT_STATE_VERSION) return null
  if (options.value.workspace !== options.workspace) return null
  if (typeof options.value.producerId !== "string") return null
  if (typeof options.value.producerPid !== "number") return null
  if (typeof options.value.updatedAt !== "string") return null
  if (!Array.isArray(options.value.breakpoints)) return null
  const breakpoints = options.value.breakpoints
    .map(parseBreakpoint)
    .filter((breakpoint) => breakpoint !== null)
  return {
    version: BREAKPOINT_STATE_VERSION,
    workspace: options.workspace,
    producerId: options.value.producerId,
    producerPid: options.value.producerPid,
    updatedAt: options.value.updatedAt,
    breakpoints,
  }
}

function parseBreakpoint(value: unknown): MirroredBreakpoint | null {
  if (!isRecord(value)) return null
  if (typeof value.file !== "string") return null
  if (typeof value.line !== "number" || value.line < 1) return null
  if (value.column !== undefined && typeof value.column !== "number") return null
  if (typeof value.verified !== "boolean") return null
  return {
    file: resolve(value.file),
    line: value.line,
    column: value.column,
    verified: value.verified,
  }
}

function mergeBreakpoints(
  breakpoints: MirroredBreakpoint[],
): MirroredBreakpoint[] {
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
    .sort(
      (first, second) =>
        first.file.localeCompare(second.file) ||
        first.line - second.line ||
        (first.column ?? 0) - (second.column ?? 0),
    )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
