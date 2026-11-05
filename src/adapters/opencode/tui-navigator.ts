// The /granny navigator's model: the known runs as a tree of phases, rounds, agents and their
// subagent sessions, a selection, and the detail of the selected node, laid out as rows of cells.
// It reads only the hub's cached snapshots and opencode's in-memory session store.
import { join } from 'node:path'
import { clean, stamp } from '../omp/format'
import { duration } from '../runview/format'
import { type AgentNode, AGENT_MARKERS, agentKey, nextAgent, type PhaseNode, type Row, rowText, runKey, type RunTree, visibleRows } from '../runview/tree'
import { AGENT_TONES, type RunSnapshot, STATUS_TONES, type Tone } from './runwatch'
import { attempt, type Cell } from './tui-view'

export interface NavRun {
  dir: string
  snapshot: RunSnapshot
}

export interface ChildSession {
  id: string
  title: string
  running: boolean
}

export interface NavDeps {
  runs(): NavRun[]
  /** The child sessions of each of `sessions`, keyed by parent; a session with none may be left out. */
  children(sessions: readonly string[]): ReadonlyMap<string, readonly ChildSession[]>
  /** Whether a role session is a child of the run's parent; undefined when the store does not know it. */
  linked(session: string): boolean | undefined
  now(): number
}

export type NavKey = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'return' | 'space' | 'next' | 'prev' | 'parent' | 'back'

export type NavAction = { type: 'open'; sessionID: string } | { type: 'parent'; sessionID: string } | { type: 'back' }

export const NAV_HELP = '↑↓ move · Enter open · Space fold · Tab/] next agent · [ prev · p parent · Esc back'
const SEPARATOR = ' │ '
const WIDE = 100
const NARROW_DETAIL = 4
const AGENT_LINES = 40
const PHASE_LINES = 200
const UNREADABLE = 'run files not readable from this TUI - showing the role sessions only'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function fit(text: string, width: number): string {
  if (width < 1) return ''
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

const pad = (text: string, width: number) => fit(text, width).padEnd(Math.max(0, width))

interface Detail {
  head: Cell[]
  body: Cell[]
  foot: Cell[]
}

export class NavModel {
  expanded: string
  selected = ''
  private readonly folded = new Set<string>()
  private readonly parents = new Map<string, string>()
  private readonly subs = new Map<string, ChildSession>()
  private runs: NavRun[] = []
  private rows: Row[] = []
  private top = 0
  private page = 10

  constructor(
    private readonly deps: NavDeps,
    runId: string,
    select?: string,
  ) {
    this.expanded = runId
    this.refresh()
    this.selected = select && this.rows.some(r => r.key === select && r.selectable) ? select : this.defaultSelection()
    this.relayout()
  }

  /** The run the navigator is expanded on. */
  run(): NavRun | undefined {
    return this.runs.find(r => r.snapshot.id === this.expanded)
  }

  private defaultSelection(): string {
    const tree = this.run()?.snapshot.tree
    if (!tree) return this.rows.find(r => r.selectable)?.key ?? ''
    const agent = [...tree.agents].reverse().find(a => a.state === 'running') ?? tree.agents.at(-1)
    return agent ? agentKey(agent.session) : runKey(tree.id)
  }

  private refresh() {
    try {
      this.runs = [...this.deps.runs()].sort((a, b) => a.snapshot.start - b.snapshot.start)
    } catch {
      this.runs = []
    }
    this.subs.clear()
    const sessions = [...new Set(this.runs.flatMap(r => r.snapshot.tree.agents.map(a => a.session)))]
    const children = attempt(() => this.deps.children(sessions)) ?? new Map<string, readonly ChildSession[]>()
    const trees = this.runs.map(r => this.withChildren(r.snapshot.tree, children))
    this.rows = visibleRows(trees, this.folded, this.expanded)
    for (const row of this.rows) if (row.parent) this.parents.set(row.key, row.parent)
  }

  /** The tree with each agent's subagents taken from its session's children, leaving the snapshot as it was. */
  private withChildren(tree: RunTree, children: ReadonlyMap<string, readonly ChildSession[]>): RunTree {
    const copies = new Map<AgentNode, AgentNode>()
    const copy = (agent: AgentNode): AgentNode => {
      let out = copies.get(agent)
      if (!out) {
        const mine = children.get(agent.session) ?? []
        for (const child of mine) this.subs.set(child.id, child)
        out = { ...agent, subagents: mine.map(c => ({ name: c.id, path: c.id })) }
        copies.set(agent, out)
      }
      return out
    }
    const phases: PhaseNode[] = tree.phases.map(phase => ({ ...phase, groups: phase.groups.map(group => ({ ...group, agents: group.agents.map(copy) })) }))
    return { ...tree, phases, agents: tree.agents.map(copy) }
  }

  private relayout() {
    let key: string | undefined = this.selected
    while (key && !this.rows.some(r => r.key === key && r.selectable)) key = this.parents.get(key)
    this.selected = key ?? this.rows.find(r => r.selectable)?.key ?? ''
  }

  private selectedRow(): Row | undefined {
    return this.rows.find(r => r.key === this.selected)
  }

  // --- keys -------------------------------------------------------------------------------------

  key(key: NavKey): NavAction | undefined {
    this.refresh()
    this.relayout()
    const selectable = this.rows.filter(r => r.selectable)
    const at = selectable.findIndex(r => r.key === this.selected)
    const move = (delta: number) => {
      const next = selectable[clamp(at + delta, 0, selectable.length - 1)]
      if (next) this.selected = next.key
    }
    switch (key) {
      case 'up':
        return void move(-1)
      case 'down':
        return void move(1)
      case 'pageup':
        return void move(-this.page)
      case 'pagedown':
        return void move(this.page)
      case 'home':
        return void (this.selected = selectable[0]?.key ?? this.selected)
      case 'end':
        return void (this.selected = selectable.at(-1)?.key ?? this.selected)
      case 'next':
      case 'prev':
        return void (this.selected = nextAgent(this.rows, this.selected, key === 'next' ? 1 : -1) ?? this.selected)
      case 'space':
        return void this.fold()
      case 'return': {
        const row = this.selectedRow()
        if (row?.kind === 'agent' && row.agent!.session) return { type: 'open', sessionID: row.agent!.session }
        if (row?.kind === 'sub') return { type: 'open', sessionID: row.sub!.name }
        return void this.fold()
      }
      case 'parent': {
        const parent = this.run()?.snapshot.parent
        return parent ? { type: 'parent', sessionID: parent } : undefined
      }
      case 'back':
        return { type: 'back' }
    }
  }

  private fold() {
    const row = this.selectedRow()
    if (!row || (row.kind !== 'run' && row.kind !== 'phase')) return
    if (row.kind === 'run' && row.run.id !== this.expanded) {
      this.expanded = row.run.id
      this.folded.delete(row.key)
    } else if (this.folded.has(row.key)) this.folded.delete(row.key)
    else this.folded.add(row.key)
    this.refresh()
    this.relayout()
  }

  // --- layout -----------------------------------------------------------------------------------

  /** The whole page: header, the panes and the key help, every row fitted to `width`. */
  frame(width: number, height: number): Cell[][] {
    this.refresh()
    this.relayout()
    const now = this.deps.now()
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(3, Math.floor(height))
    const body = h - 2
    const header: Cell[] = [{ text: pad(this.title(now), w), tone: 'base' }]
    const help: Cell[] = [{ text: pad(NAV_HELP, w), tone: 'muted' }]
    const detail = this.detail(now)
    let rows: Cell[][]
    if (w >= WIDE) {
      const treeWidth = clamp(Math.round(w * 0.38), 36, 60)
      const detailWidth = w - treeWidth - SEPARATOR.length
      const left = this.treePane(treeWidth, body, now)
      const right = compose(detail, body).map(c => ({ ...c, text: pad(c.text, detailWidth) }))
      rows = left.map((cell, i) => [cell, { text: SEPARATOR, tone: 'muted' }, right[i] ?? { text: pad('', detailWidth), tone: 'base' }])
    } else {
      const lower = Math.min(NARROW_DETAIL, Math.max(0, body - 1))
      const left = this.treePane(w, body - lower, now)
      const below = compose(detail, lower).map(c => ({ ...c, text: pad(c.text, w) }))
      while (below.length < lower) below.push({ text: pad('', w), tone: 'base' })
      rows = [...left.map(cell => [cell]), ...below.map(cell => [cell])]
    }
    return [header, ...rows, help]
  }

  private title(now: number): string {
    const s = this.run()?.snapshot
    if (!s) return 'granny · no run'
    return `granny ${s.id} · ${s.phase ?? 'Starting'} · ${s.status} · ${duration((s.end ?? now) - s.start)}`
  }

  private treePane(width: number, height: number, now: number): Cell[] {
    this.page = Math.max(1, height - 1)
    const at = this.rows.findIndex(r => r.key === this.selected)
    if (at >= 0) {
      if (at < this.top) this.top = at
      if (at >= this.top + height) this.top = at - height + 1
    }
    this.top = clamp(this.top, 0, Math.max(0, this.rows.length - height))
    const out: Cell[] = []
    for (const row of this.rows.slice(this.top, this.top + Math.max(0, height))) {
      const chosen = row.key === this.selected
      out.push({ text: pad(`${chosen ? '›' : ' '} ${this.rowLabel(row, now, width - 2)}`, width), tone: toneOf(row, this.subs), ...(chosen ? { selected: true } : {}) })
    }
    while (out.length < height) out.push({ text: pad('', width), tone: 'base' })
    return out
  }

  private rowLabel(row: Row, now: number, width: number): string {
    if (row.kind !== 'sub') return rowText(row, now, width)
    const child = this.subs.get(row.sub!.name)
    return `${'  '.repeat(row.depth)}└ ${child?.running ? '●' : '✓'} ${clean(child?.title || row.sub!.name)}`
  }

  private detail(now: number): Detail {
    const row = this.selectedRow()
    const run = this.runs.find(r => r.snapshot.id === row?.run.id) ?? this.run()
    const note: Cell[] = run && !run.snapshot.readable ? [{ text: UNREADABLE, tone: 'warning' }] : []
    if (!row || !run) return { head: [{ text: 'no granny run here', tone: 'muted' }], body: [], foot: [] }
    const open: Cell[] = [{ text: 'Enter open session · p parent session', tone: 'muted' }]
    switch (row.kind) {
      case 'agent': {
        const a = row.agent!
        const state = a.activity ?? `${a.state} ${duration((a.end ?? now) - a.start)}`
        const linked = attempt(() => this.deps.linked(a.session))
        const head: Cell[] = [
          ...note,
          { text: `${a.label} (${a.role})`, tone: 'base' },
          { text: `${a.model ?? 'default model'}${a.effort ? `/${a.effort}` : ''} · ${state}`, tone: AGENT_TONES[a.state] },
          { text: `session ${a.session}${linked === undefined ? '' : linked ? ' · linked' : ' · not linked'}`, tone: 'muted' },
        ]
        if (a.error) head.push({ text: `error: ${a.error.split('\n')[0]}`, tone: 'error' })
        if (a.subagents.length)
          head.push({ text: `subagents: ${a.subagents.map(s => `${clean(this.subs.get(s.name)?.title || s.name)} ${this.subs.get(s.name)?.running ? '●' : '✓'}`).join(', ')}`, tone: 'muted' })
        const lines = (row.phase?.lines ?? []).filter(l => mentions(l, a.label)).slice(-AGENT_LINES)
        return { head, body: lines.map(text => ({ text, tone: 'base' })), foot: open }
      }
      case 'sub': {
        const child = this.subs.get(row.sub!.name)
        return {
          head: [
            ...note,
            { text: clean(child?.title || row.sub!.name), tone: 'base' },
            { text: child?.running ? 'running' : 'idle', tone: child?.running ? 'info' : 'muted' },
            { text: `session ${row.sub!.name} · subagent of ${row.agent!.label}`, tone: 'muted' },
          ],
          body: [],
          foot: open,
        }
      }
      case 'phase': {
        const p = row.phase!
        return {
          head: [...note, { text: `${p.marker} ${p.title} · ${duration((p.end ?? now) - p.start)}`, tone: 'base' }],
          body: p.lines.slice(-PHASE_LINES).map(text => ({ text, tone: 'base' })),
          foot: [],
        }
      }
      default: {
        const s = run.snapshot
        const head: Cell[] = [...note, { text: `run ${s.id}`, tone: 'base' }, { text: `status   ${s.status}`, tone: STATUS_TONES[s.status] ?? 'base' }]
        if (s.repo) head.push({ text: `repo     ${s.repo}`, tone: 'muted' })
        if (s.branch) head.push({ text: `branch   ${s.branch}`, tone: 'muted' })
        head.push({ text: `started  ${stamp(s.start) ?? '?'}`, tone: 'muted' })
        if (s.status === 'running') head.push({ text: `phase    ${s.phase ?? 'Starting'}`, tone: 'muted' })
        else head.push({ text: `ended    ${stamp(s.end) ?? '?'}`, tone: 'muted' })
        head.push({ text: `result   ${join(run.dir, 'result.json')}`, tone: 'muted' })
        if (s.error) head.push({ text: `error: ${s.error.split('\n')[0]}`, tone: 'error' })
        return { head, body: [], foot: [{ text: `ask the agent for granny_status { runId: "${s.id}" } for the full record`, tone: 'muted' }] }
      }
    }
  }
}

const MARKS = ['▸', '■', '↻', '!']

/** A journal line about `label`: its start, end, retries, provider errors and a failed link. */
function mentions(line: string, label: string): boolean {
  return MARKS.some(mark => line.includes(`${mark} ${label} `) || line.includes(`${mark} ${label}:`))
}

/** The detail fitted to `height` rows: the head, the newest body lines that fit, then the foot. */
function compose(detail: Detail, height: number): Cell[] {
  if (height <= 0) return []
  const head = detail.head.slice(0, height)
  const foot = detail.foot.slice(0, Math.max(0, height - head.length))
  const room = Math.max(0, height - head.length - foot.length)
  const body = room ? detail.body.slice(-room) : []
  return [...head, ...body, ...foot]
}

function toneOf(row: Row, subs: ReadonlyMap<string, ChildSession>): Tone {
  switch (row.kind) {
    case 'run':
      return STATUS_TONES[row.run.status] ?? 'base'
    case 'group':
      return 'muted'
    case 'agent':
      return AGENT_TONES[row.agent!.state]
    case 'sub':
      return subs.get(row.sub!.name)?.running ? 'info' : 'muted'
    case 'phase': {
      const marker = row.phase!.marker
      return marker === AGENT_MARKERS.running ? 'info' : marker === AGENT_MARKERS.failed ? 'error' : marker === AGENT_MARKERS.cancelled ? 'warning' : 'base'
    }
  }
}
