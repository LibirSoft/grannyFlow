// A role's event log (`sessions/<n>-<label>/events.jsonl`): condensed entries appended while the
// role process streams, and their readable form for the run navigator.
import { appendFileSync } from 'node:fs'
import { clock } from './format'

export { fit } from '../runview/format'
import type { LogEntry } from './panel'

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

export function entryLines(e: Logged): string[] {
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
