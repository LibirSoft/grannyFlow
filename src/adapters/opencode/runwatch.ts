// What the opencode TUI knows about a granny run: found through the role sessions' metadata, read
// incrementally from the run's status.json and journal, and turned into sidebar lines, a footer
// chip and toasts. No opencode imports, so it runs under bun test as is.
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WatchMode } from '../../core/config'
import { clean, duration, fit } from '../runview/format'
import { AGENT_TONES, STATUS_TONES, type Tone } from '../runview/layout'
import { TailReader, type TailOptions } from '../runview/tail'
import { AGENT_MARKERS, type AgentNode, agentKey, buildRunTree, type JournalEntry, type LiveView, phaseKey, runKey, type RunTree } from '../runview/tree'

export interface RoleMeta {
  run: string
  dir: string
  parent: string
  label: string
  role: string
  phase: string
  model: string | null
}

export interface SessionLike {
  id: string
  metadata?: unknown
}

export interface RoleSession {
  id: string
  meta: RoleMeta
}

export interface FoundRun {
  dir: string
  parent: string
  sessions: string[]
  roles: RoleSession[]
}

export interface FsLike {
  stat(path: string): { size: number; mtimeMs: number }
  readText(path: string): string
}

export type WatchEvent = { type: 'phase'; title: string } | { type: 'failed'; label: string; error?: string } | { type: 'ended'; status: string }

export interface RunSnapshot {
  id: string
  status: string
  watch: WatchMode
  parent: string
  phase?: string
  start: number
  end?: number
  error?: string
  repo?: string
  branch?: string
  tree: RunTree
  readable: boolean
  /** Running, but its files have not changed for a while and none of its role sessions runs. */
  stale?: true
}

export type { Tone } from '../runview/layout'

export interface Line {
  text: string
  tone: Tone
  key?: string
}

export interface Toast {
  title: string
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
  sessionID?: string
}

const META_KEY = 'granny-workflow'
const MAX_ENTRIES = 5000
const MAX_AGENT_LINES = 8
const FRESH_MS = 60_000
const STALE_MS = 10 * 60_000
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const MODES: readonly WatchMode[] = ['full', 'panel', 'off']

const nodeFs: FsLike = {
  stat(path) {
    const st = statSync(path)
    return { size: st.size, mtimeMs: st.mtimeMs }
  },
  readText: path => readFileSync(path, 'utf8'),
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function roleMeta(info: SessionLike | undefined): RoleMeta | undefined {
  const metadata = info?.metadata
  const m = isRecord(metadata) ? metadata[META_KEY] : undefined
  if (!isRecord(m)) return undefined
  const fields = ['run', 'dir', 'parent', 'label', 'role', 'phase'] as const
  if (fields.some(f => typeof m[f] !== 'string')) return undefined
  if (m.model !== undefined && m.model !== null && typeof m.model !== 'string') return undefined
  const [run, dir, parent, label, role, phase] = fields.map(f => m[f] as string) as [string, string, string, string, string, string]
  return { run, dir, parent, label, role, phase, model: typeof m.model === 'string' ? m.model : null }
}

/** The granny runs among `sessions`, by run id, from the metadata granny puts on its role sessions. */
export function discoverRuns(sessions: readonly SessionLike[]): Map<string, FoundRun> {
  const runs = new Map<string, FoundRun>()
  for (const session of sessions) {
    const meta = roleMeta(session)
    if (!meta) continue
    let run = runs.get(meta.run)
    if (!run) {
      run = { dir: meta.dir, parent: meta.parent, sessions: [], roles: [] }
      runs.set(meta.run, run)
    }
    run.sessions.push(session.id)
    run.roles.push({ id: session.id, meta })
  }
  return runs
}

const timeOf = (value: unknown): number | undefined => {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(t) ? undefined : t
}

const firstLine = (text: string) => text.split('\n')[0]!.trim()

interface StatusFile {
  id?: string
  status?: string
  parent?: string
  watch?: WatchMode
  startedAt?: number
  finishedAt?: number
  error?: string
  repo?: string
  branch?: string
}

export interface RunWatchOptions {
  now(): number
  read?: FsLike
  roles?: RoleSession[]
  tail?: TailOptions
  staleMs?: number
}

export class RunWatch {
  readonly journal: TailReader
  /** The run's role sessions, for the view built when the run files cannot be read. */
  roles: RoleSession[]
  snapshot: RunSnapshot
  /** Events since the previous poll; the caller drains them. */
  readonly events: WatchEvent[] = []
  private readonly fs: FsLike
  private readonly statusPath: string
  private readonly journalPath: string
  private status?: StatusFile
  private statusStamp?: string
  private statusSeen = ''
  private filesSeen = ''
  private changedAt: number
  private startedAt?: number
  private entries: JournalEntry[] = []
  private primed = false
  private readonly reported = new Set<string>()
  private key = ''

  constructor(
    readonly dir: string,
    private readonly opts: RunWatchOptions,
  ) {
    this.fs = opts.read ?? nodeFs
    this.roles = opts.roles ?? []
    this.statusPath = join(dir, 'status.json')
    this.journalPath = join(dir, 'journal.jsonl')
    this.journal = new TailReader(this.journalPath, opts.tail)
    this.changedAt = opts.now()
    this.snapshot = this.build(new Map(), opts.now(), false)
  }

  get entryCount(): number {
    return this.entries.length
  }

  /** Reads what changed and rebuilds the snapshot; true when the snapshot's text changed. */
  poll(live: ReadonlyMap<string, LiveView>): boolean {
    const now = this.opts.now()
    const before = this.snapshot
    const statusOk = this.readStatus()
    let journalSize: number | undefined
    let journalSeen = ''
    try {
      const st = this.fs.stat(this.journalPath)
      journalSize = st.size
      journalSeen = `${st.size}:${st.mtimeMs}`
    } catch {}
    const files = `${this.statusSeen}|${journalSeen}`
    if (files !== this.filesSeen) {
      this.filesSeen = files
      this.changedAt = now
    }
    const { lines, reset } = this.journal.poll()
    const primed = this.primed && !reset
    if (reset) this.entries = []
    const fresh: JournalEntry[] = []
    for (const text of lines) {
      if (!text.trim()) continue
      try {
        const entry = JSON.parse(text)
        if (isRecord(entry) && typeof entry.type === 'string' && entry.type !== 'heartbeat') fresh.push(entry as JournalEntry)
      } catch {}
    }
    for (const entry of fresh) this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    const caughtUp = journalSize !== undefined && this.journal.offset >= journalSize

    this.snapshot = this.build(live, now, statusOk && journalSize !== undefined)
    if (this.isStale(live, now)) this.snapshot.stale = true
    if (primed) this.collect(before, fresh)
    this.primed = caughtUp
    const key = this.keyOf(this.snapshot, now)
    const changed = key !== this.key
    this.key = key
    return changed
  }

  /** Whether status.json or the journal changed since the last poll; two stats, nothing read. */
  touched(): boolean {
    return `${this.seen(this.statusPath)}|${this.seen(this.journalPath)}` !== this.filesSeen
  }

  private seen(path: string): string {
    try {
      const st = this.fs.stat(path)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return ''
    }
  }

  private isStale(live: ReadonlyMap<string, LiveView>, now: number): boolean {
    if (this.snapshot.status !== 'running' || now - this.changedAt < (this.opts.staleMs ?? STALE_MS)) return false
    for (const view of live.values()) if (view.active) return false
    return true
  }

  private readStatus(): boolean {
    let stamp: string
    try {
      const st = this.fs.stat(this.statusPath)
      stamp = `${st.size}:${st.mtimeMs}`
    } catch {
      this.statusSeen = ''
      return false
    }
    this.statusSeen = stamp
    if (stamp === this.statusStamp && this.status) return true
    try {
      const raw = JSON.parse(this.fs.readText(this.statusPath))
      if (!isRecord(raw)) return !!this.status
      const startedAt = timeOf(raw.startedAt)
      if (startedAt !== undefined) this.startedAt = startedAt
      const finishedAt = timeOf(raw.finishedAt)
      this.status = {
        ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
        ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
        ...(typeof raw.parent === 'string' ? { parent: raw.parent } : {}),
        ...(MODES.includes(raw.watch as WatchMode) ? { watch: raw.watch as WatchMode } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        ...(typeof raw.error === 'string' ? { error: clean(raw.error) } : {}),
        ...(typeof raw.repo === 'string' ? { repo: clean(raw.repo) } : {}),
        ...(typeof raw.branch === 'string' ? { branch: clean(raw.branch) } : {}),
      }
      this.statusStamp = stamp
      return true
    } catch {
      return !!this.status
    }
  }

  private build(live: ReadonlyMap<string, LiveView>, now: number, readable: boolean): RunSnapshot {
    const status = this.status
    const first = this.roles[0]?.meta
    const id = status?.id ?? first?.run ?? basename(this.dir)
    const info = {
      id,
      status: status?.status ?? 'running',
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(status?.finishedAt !== undefined ? { endedAt: status.finishedAt } : {}),
    }
    const entries: JournalEntry[] = readable
      ? this.entries
      : this.roles.map(({ id: session, meta }) => ({ type: 'agent', label: meta.label, role: meta.role, session, phase: meta.phase, model: meta.model }))
    const tree = buildRunTree(info, entries, live, now)
    return {
      id,
      status: tree.status,
      watch: status?.watch ?? 'full',
      parent: status?.parent ?? first?.parent ?? '',
      ...(tree.phase !== undefined ? { phase: tree.phase } : {}),
      start: tree.start,
      ...(tree.end !== undefined ? { end: tree.end } : {}),
      ...(status?.error !== undefined ? { error: status.error } : {}),
      ...(status?.repo !== undefined ? { repo: status.repo } : {}),
      ...(status?.branch !== undefined ? { branch: status.branch } : {}),
      tree,
      readable,
    }
  }

  private collect(before: RunSnapshot, fresh: readonly JournalEntry[]) {
    const after = this.snapshot
    if (after.phase !== undefined && after.phase !== before.phase) this.events.push({ type: 'phase', title: after.phase })
    for (const entry of fresh) {
      const failed = entry.type === 'agent-failed' || (entry.type === 'agent-end' && entry.outcome === 'failed')
      if (!failed) continue
      const label = String(entry.label ?? '?')
      const who = typeof entry.session === 'string' ? entry.session : label
      if (this.reported.has(who)) continue
      this.reported.add(who)
      this.events.push({ type: 'failed', label, ...(typeof entry.error === 'string' ? { error: entry.error } : {}) })
    }
    if (TERMINAL.has(after.status) && !TERMINAL.has(before.status)) this.events.push({ type: 'ended', status: after.status })
  }

  private keyOf(s: RunSnapshot, now: number): string {
    const over = TERMINAL.has(s.status)
    const clock = over ? String(s.end !== undefined && now - s.end < FRESH_MS) : String(Math.floor((now - s.start) / 1000))
    const agents = s.tree.agents.map(a => `${a.session}:${a.state}:${a.activity ?? ''}`).join(',')
    return [s.status, s.stale ?? '', s.watch, s.readable, s.phase ?? '', this.entries.length, clock, agents].join('|')
  }
}

const shortId = (id: string) => id.slice(-4)
const terminal = (s: RunSnapshot) => TERMINAL.has(s.status)
const fresh = (s: RunSnapshot, now: number) => s.end !== undefined && now - s.end < FRESH_MS
const elapsed = (s: RunSnapshot, now: number) => duration((s.end ?? now) - s.start)

export { AGENT_TONES, STATUS_TONES } from '../runview/layout'

function agentLine(a: AgentNode, now: number, width: number): string {
  const marker = `${AGENT_MARKERS[a.state]} `
  const tail = ` · ${a.activity ?? `${a.state} ${duration((a.end ?? now) - a.start)}`}`
  const model = a.model ? a.model.slice(a.model.lastIndexOf('/') + 1) : 'default model'
  const full = `${marker}${a.label}  ${model}${tail}`
  if (full.length <= width) return full
  const short = `${marker}${a.label}${tail}`
  if (short.length <= width) return short
  const room = width - marker.length - tail.length
  return room >= 2 ? `${marker}${a.label.slice(0, room - 1)}…${tail}` : fit(short, width)
}

/** The run's sidebar section: header, phase and the agents that matter now; empty when watching is off or the run is long over. */
export function sidebarLines(s: RunSnapshot, now: number, width: number): Line[] {
  if (s.watch === 'off') return []
  const short = shortId(s.id)
  if (terminal(s)) {
    if (!fresh(s, now)) return []
    return [{ text: fit(`granny ${short} · ${s.status} · ${elapsed(s, now)}`, width), tone: STATUS_TONES[s.status] ?? 'base', key: runKey(s.id) }]
  }
  const lines: Line[] = [{ text: fit(`granny ${short} · ${s.stale ? 'stale?' : s.status}`, width), tone: s.stale ? 'warning' : 'base', key: runKey(s.id) }]
  if (!s.readable) lines.push({ text: fit('run files not readable', width), tone: 'muted' })
  const phase = s.tree.phases.at(-1)
  lines.push({
    text: fit(`${phase?.title ?? 'Starting'} · ${duration(now - (phase?.start ?? s.start))}`, width),
    tone: 'muted',
    ...(phase ? { key: phaseKey(s.id, phase.index) } : {}),
  })
  const agents = s.tree.agents.filter(a => a.phase === phase?.title || a.state === 'running' || a.state === 'waiting').reverse()
  for (const a of agents.slice(0, MAX_AGENT_LINES)) lines.push({ text: agentLine(a, now, width), tone: AGENT_TONES[a.state], key: agentKey(a.session) })
  if (agents.length > MAX_AGENT_LINES) lines.push({ text: fit(`+${agents.length - MAX_AGENT_LINES} more`, width), tone: 'muted' })
  return lines
}

/** The prompt footer chip; empty when watching is off or the run is long over. */
export function chipText(s: RunSnapshot, now: number): string {
  if (s.watch === 'off') return ''
  if (terminal(s)) return fresh(s, now) ? `granny · ${s.status}` : ''
  if (s.stale) return `granny · ${s.phase ?? 'Starting'} · stale?`
  const running = s.tree.agents.filter(a => a.state === 'running').length
  return `granny · ${s.phase ?? 'Starting'} · ${running} running · ${elapsed(s, now)}`
}

/** The toast for an event, sent to the run's parent session; only when watching is full. */
export function toastFor(e: WatchEvent, s: RunSnapshot): Toast | undefined {
  if (s.watch !== 'full') return undefined
  const base = { title: `granny ${shortId(s.id)}`, ...(s.parent ? { sessionID: s.parent } : {}) }
  switch (e.type) {
    case 'phase':
      return { ...base, message: e.title, variant: 'info' }
    case 'failed':
      return { ...base, message: `${e.label} failed${e.error ? `: ${firstLine(e.error)}` : ''}`, variant: 'error' }
    case 'ended': {
      const took = s.end !== undefined ? ` · ${duration(s.end - s.start)}` : ''
      const message = e.status === 'failed' && s.error ? `run ${s.id} failed: ${firstLine(s.error)}` : `run ${s.id} ${e.status}${took}`
      return { ...base, message, variant: e.status === 'done' ? 'success' : e.status === 'cancelled' ? 'warning' : 'error' }
    }
  }
}
