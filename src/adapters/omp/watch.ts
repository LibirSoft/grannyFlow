// A role's event log (`sessions/<n>-<label>/events.jsonl`): condensed entries appended while the
// role process streams; the run navigator reads them through `activity.ts`.
import { appendFileSync } from 'node:fs'
import type { LogEntry } from './panel'

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
