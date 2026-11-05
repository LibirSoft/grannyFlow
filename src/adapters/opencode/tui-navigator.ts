// The /granny navigator's model: the shown run's work groups, agents, checks and subagent sessions,
// the other known runs, a selection and the detail of the selected row, laid out as the shared page.
// It reads the hub's cached snapshots and activity, and opencode's in-memory session list.
import { type ActivityItem, activityLines, summarise } from '../runview/activity'
import { clean, fit, pad } from '../runview/format'
import { agentEnd, agentHead, type Cell, checksDetail, frame, groupDetail, headerText, paneSizes, runDetail, stepperCells, summaryCells, treeCells } from '../runview/layout'
import { type AgentNode, agentKey, focusStage, nextAgent, type Row, type RunTree, stepsFor, visibleRows } from '../runview/tree'
import type { MessageActivity } from './activity'
import type { RunSnapshot } from './runwatch'
import { attempt } from './tui-view'

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
  /** What the hub last read of a role session's messages. */
  activity?(session: string): MessageActivity | undefined
  /** Told the selected agent's session, or undefined off an agent, whenever that changes. */
  onSelect?(session: string | undefined): void
  home?: string
  now(): number
}

export type NavKey = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'return' | 'space' | 'next' | 'prev' | 'parent' | 'back' | 'verbose' | 'follow'

export type NavAction = { type: 'open'; sessionID: string } | { type: 'parent'; sessionID: string } | { type: 'back' }

const NARROW_DETAIL = 4
const UNREADABLE = 'run files not readable from this TUI - showing the role sessions only'
const BLANK: Cell = { text: '', tone: 'base' }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export class NavModel {
  /** The run the page shows. */
  shown: string
  selected = ''
  verbose = false
  private follow = true
  private listTop = 0
  private listRows = 0
  private listRoom = 0
  private listFor = ''
  private readonly folded = new Set<string>()
  private readonly opened = new Set<string>()
  private readonly parents = new Map<string, string>()
  private readonly subs = new Map<string, ChildSession>()
  private runs: NavRun[] = []
  private rows: Row[] = []
  private top = 0
  private page = 10
  private told: string | undefined | null = null

  constructor(
    private readonly deps: NavDeps,
    runId: string,
    select?: string,
  ) {
    this.shown = runId
    this.refresh()
    this.selected = select && this.rows.some(r => r.key === select && r.selectable) ? select : this.defaultSelection()
    this.settle()
  }

  /** The run the page shows. */
  run(): NavRun | undefined {
    return this.runs.find(r => r.snapshot.id === this.shown)
  }

  private tree(): RunTree | undefined {
    return this.run()?.snapshot.tree
  }

  private defaultSelection(): string {
    const tree = this.tree()
    const agent = tree && ([...tree.agents].reverse().find(a => a.state === 'running') ?? tree.agents.at(-1))
    if (agent) return agentKey(agent.session)
    return this.rows.find(r => r.selectable)?.key ?? ''
  }

  private refresh() {
    try {
      this.runs = [...this.deps.runs()].sort((a, b) => a.snapshot.start - b.snapshot.start)
    } catch {
      this.runs = []
    }
    if (!this.run() && this.runs.length) this.shown = this.runs.at(-1)!.snapshot.id
    this.subs.clear()
    const tree = this.tree()
    const sessions = tree ? [...new Set(tree.agents.map(a => a.session))] : []
    const children = (sessions.length ? attempt(() => this.deps.children(sessions)) : undefined) ?? new Map<string, readonly ChildSession[]>()
    const trees = this.runs.map(r => (r.snapshot.id === this.shown ? this.withChildren(r.snapshot.tree, children) : r.snapshot.tree))
    const shown = trees.find(t => t.id === this.shown)
    const focus = shown ? focusStage(shown) : undefined
    this.rows = visibleRows(trees, { run: this.shown, folded: this.folded, opened: this.opened, ...(focus !== undefined ? { focus } : {}), runs: trees.length > 1 ? 'list' : 'one' })
    for (const row of this.rows) if (row.parent) this.parents.set(row.key, row.parent)
  }

  /** The tree with each agent's subagents taken from its session's children, leaving the snapshot as it was. */
  private withChildren(tree: RunTree, children: ReadonlyMap<string, readonly ChildSession[]>): RunTree {
    if (!children.size) return tree
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
    const groups = tree.groups.map(g => ({ ...g, agents: g.agents.map(copy), ...(g.checks ? { checks: { ...g.checks, ...(g.checks.after ? { after: copy(g.checks.after) } : {}) } } : {}) }))
    return { ...tree, groups, agents: tree.agents.map(copy) }
  }

  /** Keeps the selection on a row that shows, and tells the hub which agent to read. */
  private settle() {
    let key: string | undefined = this.selected
    while (key && !this.rows.some(r => r.key === key && r.selectable)) key = this.parents.get(key)
    this.selected = key ?? this.rows.find(r => r.selectable)?.key ?? ''
    if (this.selected !== this.listFor) {
      this.listFor = this.selected
      this.follow = true
    }
    const row = this.selectedRow()
    const session = row?.kind === 'agent' ? row.agent!.session : undefined
    if (session === this.told) return
    this.told = session
    attempt(() => this.deps.onSelect?.(session))
  }

  private selectedRow(): Row | undefined {
    return this.rows.find(r => r.key === this.selected)
  }

  // --- keys -------------------------------------------------------------------------------------

  key(key: NavKey): NavAction | undefined {
    this.refresh()
    this.settle()
    const action = this.press(key)
    this.refresh()
    this.settle()
    return action
  }

  private press(key: NavKey): NavAction | undefined {
    const selectable = this.rows.filter(r => r.selectable)
    const at = selectable.findIndex(r => r.key === this.selected)
    const move = (delta: number) => {
      const next = selectable[clamp(at + delta, 0, selectable.length - 1)]
      if (next) this.selected = next.key
    }
    const listing = this.listing()
    const listPage = Math.max(1, this.listRoom - 1)
    switch (key) {
      case 'up':
        return void move(-1)
      case 'down':
        return void move(1)
      case 'pageup':
        return void (listing ? this.scroll(-listPage) : move(-this.page))
      case 'pagedown':
        return void (listing ? this.scroll(listPage) : move(this.page))
      case 'home':
        return void (listing ? this.scroll(-this.listRows) : (this.selected = selectable[0]?.key ?? this.selected))
      case 'end':
        return void (listing ? (this.follow = true) : (this.selected = selectable.at(-1)?.key ?? this.selected))
      case 'next':
      case 'prev':
        return void (this.selected = nextAgent(this.rows, this.selected, key === 'next' ? 1 : -1) ?? this.selected)
      case 'verbose':
        this.verbose = !this.verbose
        this.follow = true
        return
      case 'follow':
        if (listing) {
          this.scroll(0)
          this.follow = !this.follow
        }
        return
      case 'space':
        return void this.toggle()
      case 'return': {
        const row = this.selectedRow()
        if (row?.kind === 'agent' && row.agent!.session) return { type: 'open', sessionID: row.agent!.session }
        if (row?.kind === 'sub') return { type: 'open', sessionID: row.sub!.name }
        return void this.toggle()
      }
      case 'parent': {
        const parent = this.run()?.snapshot.parent
        return parent ? { type: 'parent', sessionID: parent } : undefined
      }
      case 'back':
        return { type: 'back' }
    }
  }

  /** Whether the detail shows the verbose list, which then takes the page keys. */
  private listing(): boolean {
    return this.verbose && this.selectedRow()?.kind === 'agent'
  }

  /** Moves the verbose list by `delta` rows from what it shows; only a list that can move stops following. */
  private scroll(delta: number) {
    const max = Math.max(0, this.listRows - this.listRoom)
    this.listTop = clamp((this.follow ? max : this.listTop) + delta, 0, max)
    if (this.listTop < max) this.follow = false
  }

  /** Folds or opens the selected group, or shows the selected run. */
  private toggle() {
    const row = this.selectedRow()
    if (row?.kind === 'run' && row.run.id !== this.shown) {
      this.shown = row.run.id
      this.top = 0
      this.refresh()
      this.selected = this.defaultSelection()
      return
    }
    if (row?.kind !== 'group' || row.folded === undefined) return
    if (row.folded) {
      this.opened.add(row.key)
      this.folded.delete(row.key)
    } else {
      this.folded.add(row.key)
      this.opened.delete(row.key)
    }
  }

  // --- layout -----------------------------------------------------------------------------------

  /** The whole page: header, stepper, the panes and the key help, every row exactly `width` long. */
  frame(width: number, height: number): Cell[][] {
    this.refresh()
    this.settle()
    const now = this.deps.now()
    const w = Math.max(1, Math.floor(width))
    const sizes = paneSizes(w, height, NARROW_DETAIL)
    const tree = this.tree()
    const focus = tree ? focusStage(tree, this.selected) : undefined
    const header: Cell[] = [{ text: tree ? headerText(tree, now, focus, w) : 'granny · no run', tone: 'base' }]
    const stepper = tree ? stepperCells(stepsFor(tree, focus), w) : []
    this.page = Math.max(1, sizes.left.height - 1)
    const left = this.treePane(now, sizes.left.width, sizes.left.height)
    const right = this.detail(now, sizes.right.width, sizes.right.height)
    return frame({ header, stepper, left, right, help: [{ text: this.help(), tone: 'muted' }], width: w, height, split: NARROW_DETAIL })
  }

  private treePane(now: number, width: number, height: number): Cell[] {
    const { cells, top } = treeCells(this.rows, this.selected, now, width, height, this.top)
    this.top = top
    return cells.map((cell, i) => {
      const row = this.rows[top + i]
      if (row?.kind !== 'sub') return cell
      const child = this.subs.get(row.sub!.name)
      const text = `${'  '.repeat(row.depth)}└ ${child?.running ? '●' : '✓'} ${clean(child?.title || row.sub!.name)}`
      return { ...cell, text: pad(`${cell.selected ? '›' : ' '} ${fit(text, width - 2)}`, width), tone: child?.running ? 'info' : 'muted' }
    })
  }

  private help(): string {
    const row = this.selectedRow()
    const enter =
      row?.kind === 'agent' || row?.kind === 'sub'
        ? 'Enter open session'
        : row?.kind === 'group' && row.folded !== undefined
          ? 'Enter fold'
          : row?.kind === 'run' && row.run.id !== this.shown
            ? 'Enter switch run'
            : undefined
    if (this.listing()) return ['↑↓ move', 'PgUp/PgDn scroll', `f follow ${this.follow ? 'on' : 'off'}`, 'v summary', enter, 'Tab next agent', 'p parent', 'Esc close'].join(' · ')
    const verbose = row?.kind === 'agent' ? 'v details' : undefined
    return ['↑↓ move', enter, 'Tab next agent', 'Space fold', verbose, 'p parent', 'Esc close'].filter(Boolean).join(' · ')
  }

  private detail(now: number, width: number, height: number): Cell[] {
    if (height <= 0) return []
    const row = this.selectedRow()
    const run = this.runs.find(r => r.snapshot.id === row?.run.id) ?? this.run()
    if (!row || !run) return [{ text: 'no granny run here', tone: 'muted' }]
    const note: Cell[] = run.snapshot.readable ? [] : [{ text: UNREADABLE, tone: 'warning' }]
    const room = Math.max(0, height - note.length)
    const tree = row.run
    switch (row.kind) {
      case 'agent':
        return [...note, ...this.agentDetail(row.agent!, now, width, room)]
      case 'sub': {
        const child = this.subs.get(row.sub!.name)
        return [
          ...note,
          { text: clean(child?.title || row.sub!.name), tone: 'base' },
          { text: child?.running ? 'running' : 'idle', tone: child?.running ? 'info' : 'muted' },
          { text: `subagent of ${row.agent!.action}`, tone: 'muted' },
        ]
      }
      case 'group':
        return [...note, ...newest(groupDetail(tree, row.group!, now, width), room)]
      case 'checks':
        return [...note, ...newest(checksDetail(row.group!), room)]
      default: {
        const s = run.snapshot
        return [
          ...note,
          ...runDetail(tree, { ...(s.repo ? { repo: s.repo } : {}), dir: run.dir, ...(s.error ? { error: s.error } : {}) }),
          BLANK,
          { text: `ask the agent for granny_status { runId: "${s.id}" } for the full record`, tone: 'muted' },
        ]
      }
    }
  }

  /** The agent's head, then its summary (NOW, TODO, RECENT, LAST SAID) or, verbose, every event in order. */
  private agentDetail(agent: AgentNode, now: number, width: number, height: number): Cell[] {
    const linked = attempt(() => this.deps.linked(agent.session))
    const head = agentHead(agent, now, linked === undefined ? {} : { linked })
    const activity = attempt(() => this.deps.activity?.(agent.session))
    const items = withNotes(activity?.items ?? [], agent)
    const room = Math.max(0, height - head.length - 1)
    if (this.verbose) {
      const lines = activityLines(items, agent.cwd, this.deps.home)
      this.listRows = lines.length
      this.listRoom = room
      const max = Math.max(0, lines.length - room)
      const top = this.follow ? max : clamp(this.listTop, 0, max)
      const body: Cell[] = lines.length ? lines.slice(top, top + room).map(text => ({ text, tone: 'base' })) : [{ text: 'no activity yet', tone: 'muted' }]
      return [...head, BLANK, ...body]
    }
    const end = agentEnd(agent)
    const live = end ? undefined : (activity?.now ?? (agent.state === 'running' ? { state: 'waiting' as const, since: items.at(-1)?.t ?? agent.start } : undefined))
    const summary = summarise(items, now, { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(this.deps.home ? { home: this.deps.home } : {}), ...(live ? { live } : {}), ...(end ? { end } : {}) })
    if (!end && !live) summary.now = { text: 'idle', tone: 'muted' }
    return [...head, BLANK, ...summaryCells(summary, width, room)]
  }
}

/** The agent's journal notes merged into its activity by time. */
function withNotes(items: readonly ActivityItem[], agent: AgentNode): ActivityItem[] {
  if (!agent.notes.length) return [...items]
  const notes = agent.notes.map((n): ActivityItem => ({ t: n.t, kind: 'note', text: n.text }))
  return [...items, ...notes].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
}

/** A detail fitted to `height` rows: everything up to its first blank row, then the newest rows that fit. */
function newest(cells: readonly Cell[], height: number): Cell[] {
  if (cells.length <= height) return [...cells]
  const blank = cells.findIndex(c => c.text === '')
  const head = cells.slice(0, blank < 0 ? 0 : blank + 1).slice(0, height)
  const room = height - head.length
  return [...head, ...(room > 0 ? cells.slice(head.length).slice(-room) : [])]
}
