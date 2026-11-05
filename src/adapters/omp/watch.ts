// A role's event log (`sessions/<n>-<label>/events.jsonl`) and the /granny view of it: condensed
// entries appended while the role process streams, read back from the file's tail.
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type { LogEntry } from './panel'

export const VIEW_LINES = 40
const TAIL_BYTES = 256 * 1024
const TEXT_LINES = 12

export class EventLog {
  private failed = false

  constructor(
    readonly path: string,
    private readonly now: () => number,
    private readonly onError: (error: unknown) => void,
  ) {}

  write(entry: LogEntry) {
    if (this.failed) return
    try {
      appendFileSync(this.path, JSON.stringify({ t: new Date(this.now()).toISOString(), ...entry }) + '\n')
    } catch (e) {
      this.failed = true
      try {
        this.onError(e)
      } catch {}
    }
  }
}

export type Logged = LogEntry & { t: string }

/** The entries in the last `maxBytes` of an event log; a missing file has none. */
export function readTail(path: string, maxBytes = TAIL_BYTES): Logged[] {
  if (!existsSync(path)) return []
  const size = statSync(path).size
  const from = Math.max(0, size - maxBytes)
  const buffer = Buffer.alloc(size - from)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, from)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf8').split('\n')
  if (from > 0) lines.shift()
  const out: Logged[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

const clock = (t: string) => {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8)
}

function entryLines(e: Logged): string[] {
  const at = clock(e.t)
  switch (e.type) {
    case 'state':
      return e.state.startsWith('running ') ? [] : [`${at}  · ${e.state}`]
    case 'heading':
      return [`${at}  » ${e.text}`]
    case 'tool': {
      const what = e.intent ?? e.arg
      return [`${at}  ▸ ${e.name}${what ? `: ${what}` : ''}${e.intent && e.arg ? ` (${e.arg})` : ''}`]
    }
    case 'tool-end':
      return e.error ? [`${at}  ✗ ${e.name} failed`] : []
    case 'subagents':
      return [`${at}  └ task: ${e.agents.join(', ')}`]
    case 'text': {
      const lines = e.text.split('\n')
      const shown = lines.slice(0, TEXT_LINES).map(l => `          ${l}`)
      if (lines.length > TEXT_LINES) shown.push(`          … ${lines.length - TEXT_LINES} more line(s)`)
      return [`${at}  ✎ answer:`, ...shown]
    }
    case 'exit':
      return [`${at}  ■ process exited ${e.code}`]
  }
  return []
}

/** The readable form of a log's entries, its last `max` lines. */
export function formatEntries(entries: Logged[], max = VIEW_LINES): string[] {
  return entries.flatMap(entryLines).slice(-max)
}

export function fit(line: string, width: number): string {
  const flat = line.replace(/\t/g, '  ')
  if (width <= 0) return ''
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat
}

interface ViewTui {
  requestRender(): void
}

interface ViewKeys {
  matches?(data: string, binding: string): boolean
}

/** A live overlay over one role's event log; Esc (or q) closes it. */
export class LogView {
  private size = -1
  private body: string[] = []
  private readonly timer: ReturnType<typeof setInterval>
  private closed = false

  constructor(
    private readonly path: string,
    private readonly title: () => string,
    private readonly tui: ViewTui,
    private readonly keys: ViewKeys | undefined,
    private readonly done: () => void,
    refreshMs = 500,
  ) {
    this.timer = setInterval(() => {
      if (this.read()) this.tui.requestRender()
    }, refreshMs)
    this.timer.unref?.()
  }

  private read(): boolean {
    let size = 0
    try {
      size = existsSync(this.path) ? statSync(this.path).size : 0
    } catch {}
    if (size === this.size) return false
    this.size = size
    try {
      this.body = formatEntries(readTail(this.path))
    } catch {
      this.body = []
    }
    return true
  }

  render(width: number): string[] {
    this.read()
    const body = this.body.length ? this.body : ['(no events yet)']
    return [this.title(), '', ...body, '', 'Esc closes'].map(l => fit(l, width))
  }

  invalidate() {}

  handleInput(data: string) {
    if (data === '\x1b' || data === 'q' || this.keys?.matches?.(data, 'tui.select.cancel')) this.close()
  }

  close() {
    if (this.closed) return
    this.dispose()
    this.done()
  }

  dispose() {
    this.closed = true
    clearInterval(this.timer)
  }
}
