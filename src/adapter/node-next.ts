import { normalize } from "node:path"
import type { Readable } from "node:stream"

const NEXT_CHILD_INSPECTOR_TIMEOUT = 15_000

export class InspectorAnnouncementReader {
  private buffer = ""
  private onAnnouncementCallbacks = new Set<() => void>()
  private urls = new Set<string>()

  constructor(private stream: Readable | null) {
    this.stream?.setEncoding("utf8")
    this.stream?.on("data", this.handleData)
  }

  async waitForChild(options: { parentPort: number }): Promise<string> {
    const existingUrl = this.childUrl(options.parentPort)
    if (existingUrl) return existingUrl
    return new Promise((resolveChild, rejectChild) => {
      const timeout = setTimeout(() => {
        cleanup()
        rejectChild(
          new Error("Timed out waiting for the Next.js server child inspector."),
        )
      }, NEXT_CHILD_INSPECTOR_TIMEOUT)
      const onAnnouncement = () => {
        const url = this.childUrl(options.parentPort)
        if (!url) return
        cleanup()
        resolveChild(url)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.onAnnouncementCallbacks.delete(onAnnouncement)
      }
      this.onAnnouncementCallbacks.add(onAnnouncement)
    })
  }

  close(): void {
    this.stream?.off("data", this.handleData)
    this.stream?.resume()
    this.stream = null
  }

  private handleData = (chunk: string | Buffer): void => {
    const lines = `${this.buffer}${String(chunk)}`.split(/\r?\n/)
    this.buffer = lines.pop() ?? ""
    lines
      .flatMap((line) => inspectorUrls(line))
      .forEach((url) => this.urls.add(url))
    this.onAnnouncementCallbacks.forEach((callback) => callback())
  }

  private childUrl(parentPort: number): string | null {
    return Array.from(this.urls).find(
      (url) => inspectorPort(url) !== parentPort,
    ) ?? null
  }
}

export function isNextProgram(program: string): boolean {
  return /(?:^|\/)next\/dist\/bin\/next(?:\.js)?$/.test(
    normalize(program).replaceAll("\\", "/"),
  )
}

function inspectorUrls(line: string): string[] {
  return Array.from(
    line.matchAll(/Debugger listening on (ws:\/\/\S+)/g),
    (match) => match[1],
  ).filter((url) => url !== undefined)
}

function inspectorPort(url: string): number | null {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) ? port : null
  } catch {
    return null
  }
}
