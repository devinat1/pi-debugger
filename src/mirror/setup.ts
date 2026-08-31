import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js"
import { findFreePort } from "../util/port"
import { isRecord } from "../util/value"

export type SupportedEditor = "vscode" | "zed"

export interface EditorSetupResult {
  editor: SupportedEditor
  port: number
  workspace: string
}

const MIRROR_PROFILE_NAME = "Pi breakpoint mirror"
const MIRROR_TASK_NAME = "Start Pi breakpoint mirror"

export async function setupEditor(options: {
  editor: SupportedEditor
  executable: string
  workspace: string
  port?: number
}): Promise<EditorSetupResult> {
  const workspace = await existingDirectory(options.workspace)
  const executable = await executableFile(options.executable)
  const port = options.port ?? await findFreePort()
  const serveArguments = [
    "serve",
    "--workspace",
    workspace,
    "--port",
    String(port),
    "--detach",
  ]
  if (options.editor === "zed") {
    await setupZed({ workspace, executable, port, serveArguments })
  } else {
    await setupVsCode({ workspace, executable, port, serveArguments })
  }
  return { editor: options.editor, port, workspace }
}

async function setupZed(options: {
  workspace: string
  executable: string
  port: number
  serveArguments: string[]
}): Promise<void> {
  const file = join(options.workspace, ".zed", "debug.json")
  await updateNamedArray({
    file,
    defaultText: "[]\n",
    arrayPath: [],
    identityProperty: "label",
    identityValue: MIRROR_PROFILE_NAME,
    entry: {
      label: MIRROR_PROFILE_NAME,
      adapter: "JavaScript",
      type: "node",
      request: "launch",
      program: options.workspace,
      tcp_connection: {
        host: "127.0.0.1",
        port: options.port,
      },
      build: {
        command: options.executable,
        args: options.serveArguments,
      },
    },
  })
}

async function setupVsCode(options: {
  workspace: string
  executable: string
  port: number
  serveArguments: string[]
}): Promise<void> {
  const launchFile = join(options.workspace, ".vscode", "launch.json")
  const tasksFile = join(options.workspace, ".vscode", "tasks.json")
  await updateNamedArray({
    file: launchFile,
    defaultText: '{\n  "version": "0.2.0",\n  "configurations": []\n}\n',
    arrayPath: ["configurations"],
    identityProperty: "name",
    identityValue: MIRROR_PROFILE_NAME,
    entry: {
      name: MIRROR_PROFILE_NAME,
      type: "node",
      request: "launch",
      program: options.workspace,
      debugServer: options.port,
      preLaunchTask: MIRROR_TASK_NAME,
    },
  })
  await updateNamedArray({
    file: tasksFile,
    defaultText: '{\n  "version": "2.0.0",\n  "tasks": []\n}\n',
    arrayPath: ["tasks"],
    identityProperty: "label",
    identityValue: MIRROR_TASK_NAME,
    entry: {
      label: MIRROR_TASK_NAME,
      type: "process",
      command: options.executable,
      args: options.serveArguments,
      problemMatcher: [],
    },
  })
}

async function updateNamedArray(options: {
  file: string
  defaultText: string
  arrayPath: JSONPath
  identityProperty: string
  identityValue: string
  entry: Record<string, unknown>
}): Promise<void> {
  const document = await readTextOrDefault({
    file: options.file,
    defaultText: options.defaultText,
  })
  const source = document.source
  const initialValue = parseConfiguration({ file: options.file, source })
  const existingArray = valueAtPath({
    value: initialValue,
    path: options.arrayPath,
  })
  if (existingArray !== undefined && !Array.isArray(existingArray)) {
    throw new Error(
      `Expected ${configurationPath(options.arrayPath)} in ${options.file} to be an array.`,
    )
  }
  const formattingOptions = formattingFor(source)
  const sourceWithArray = Array.isArray(existingArray)
    ? source
    : applyEdits(
        source,
        modify(source, options.arrayPath, [], { formattingOptions }),
      )
  const valueWithArray = parseConfiguration({
    file: options.file,
    source: sourceWithArray,
  })
  const arrayWithEntries = valueAtPath({
    value: valueWithArray,
    path: options.arrayPath,
  })
  if (!Array.isArray(arrayWithEntries)) {
    throw new Error(
      `Failed to create ${configurationPath(options.arrayPath)} in ${options.file}.`,
    )
  }
  const existingIndex = arrayWithEntries.findIndex(
    (value) =>
      isRecord(value) &&
      value[options.identityProperty] === options.identityValue,
  )
  const entryIndex = existingIndex >= 0 ? existingIndex : arrayWithEntries.length
  const updated = applyEdits(
    sourceWithArray,
    modify(
      sourceWithArray,
      [...options.arrayPath, entryIndex],
      options.entry,
      { formattingOptions },
    ),
  )
  await writeConfiguration({
    file: options.file,
    expectedDiskSource: document.diskSource,
    updated,
  })
}

function parseConfiguration(options: {
  file: string
  source: string
}): unknown {
  const errors: ParseError[] = []
  const value: unknown = parse(options.source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  const firstError = errors[0]
  if (firstError) {
    throw new Error(
      `Cannot update ${options.file}: ${printParseErrorCode(firstError.error)} at offset ${firstError.offset}.`,
    )
  }
  return value
}

function valueAtPath(options: {
  value: unknown
  path: JSONPath
}): unknown {
  return options.path.reduce<unknown>((value, segment) => {
    if (typeof segment === "number") {
      return Array.isArray(value) ? value[segment] : undefined
    }
    return isRecord(value) ? value[segment] : undefined
  }, options.value)
}

function formattingFor(source: string): FormattingOptions {
  const firstIndentedLine = source
    .split(/\r?\n/)
    .find((line) => /^\s+["}\]]/.test(line))
  const indentation = firstIndentedLine?.match(/^\s+/)?.[0]
  return {
    insertSpaces: indentation ? !indentation.includes("\t") : true,
    tabSize: indentation && !indentation.includes("\t")
      ? indentation.length
      : 2,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  }
}

async function readTextOrDefault(options: {
  file: string
  defaultText: string
}): Promise<{
  source: string
  diskSource?: string
}> {
  try {
    const diskSource = await readFile(options.file, "utf8")
    return {
      source: diskSource.trim().length === 0 ? options.defaultText : diskSource,
      diskSource,
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { source: options.defaultText }
    throw error
  }
}

async function writeConfiguration(options: {
  file: string
  expectedDiskSource?: string
  updated: string
}): Promise<void> {
  const directory = dirname(options.file)
  await mkdir(directory, { recursive: true })
  const directoryDetails = await lstat(directory)
  if (directoryDetails.isSymbolicLink()) {
    throw new Error(`Configuration directory ${directory} is a symbolic link.`)
  }
  const fileDetails = await fileDetailsOrUndefined(options.file)
  if (fileDetails?.isSymbolicLink()) {
    throw new Error(`Configuration file ${options.file} is a symbolic link.`)
  }
  const currentDiskSource = await fileTextOrUndefined(options.file)
  if (currentDiskSource !== options.expectedDiskSource) {
    throw new Error(
      `Configuration file ${options.file} changed during setup. Rerun setup to preserve the newer changes.`,
    )
  }
  const temporaryFile = join(
    directory,
    `.${basename(options.file)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporaryFile, options.updated, {
      encoding: "utf8",
      mode: fileDetails?.mode ?? 0o600,
    })
    const latestDiskSource = await fileTextOrUndefined(options.file)
    if (latestDiskSource !== options.expectedDiskSource) {
      throw new Error(
        `Configuration file ${options.file} changed during setup. Rerun setup to preserve the newer changes.`,
      )
    }
    await rename(temporaryFile, options.file)
  } finally {
    await rm(temporaryFile, { force: true })
  }
}

async function fileTextOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function fileDetailsOrUndefined(
  file: string,
): Promise<Stats | undefined> {
  try {
    return await lstat(file)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function existingDirectory(directory: string): Promise<string> {
  const absoluteDirectory = resolve(directory)
  try {
    const details = await stat(absoluteDirectory)
    if (!details.isDirectory()) {
      throw new Error(`Workspace ${absoluteDirectory} is not a directory.`)
    }
    return await realpath(absoluteDirectory)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Workspace ${absoluteDirectory} does not exist.`)
    }
    throw error
  }
}

async function executableFile(file: string): Promise<string> {
  const absoluteFile = resolve(file)
  try {
    const canonicalFile = await realpath(absoluteFile)
    await access(canonicalFile, constants.X_OK)
    return canonicalFile
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Mirror executable ${absoluteFile} does not exist.`)
    }
    if (errorCode(error) === "EACCES") {
      throw new Error(`Mirror executable ${absoluteFile} is not executable.`)
    }
    throw error
  }
}

function configurationPath(path: JSONPath): string {
  return path.length === 0 ? "the document root" : path.join(".")
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined
}
