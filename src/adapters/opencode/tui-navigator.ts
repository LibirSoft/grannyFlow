// The /granny navigator's model: the shared levels - the run's stages, a stage's rounds, a round's agents,
// one agent's detail - over the shown run, with its role sessions' subagents and the other known runs.
// It reads the hub's cached snapshots and activity, and opencode's in-memory session list.
import { type ActivityItem, activityLines, nowLine, summarise } from '../runview/activity'
import { clean } from '../runview/format'
import { agentEnd, agentHead, type Cell, checksDetail, groupDetail, runDetail, summaryCells } from '../runview/layout'
import { flowOf, levelBody, levelFrame, type LevelView, LevelNav, selectedRow } from '../runview/levels'
import { type AgentNode, groupKey, type Row, type RunTree, visibleRows } from '../runview/tree'
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
  /** Told the role sessions the page shows the activity of, whenever those change. */
  onWatch?(sessions: readonly string[]): void
  home?: string
  now(): number
}

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown' | 'home' | 'end' | 'return' | 'space' | 'next' | 'prev' | 'parent' | 'back' | 'verbose' | 'follow' | 'log'

export type NavAction = { type: 'open'; sessionID: string } | { type: 'parent'; sessionID: string } | { type: 'back' }

const MAX_WATCHED = 4
const UNREADABLE = 'run files not readable from this TUI - showing the role sessions only'
const BLANK: Cell = { text: '', tone: 'base' }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export class NavModel {
  /** The run the page shows. */
  shown: string
  verbose = false
  private follow = true
  private listTop = 0
  private listRows = 0
  private listRoom = 0
  private listFor = ''
  private readonly nav = new LevelNav()
  private readonly subs = new Map<string, ChildSession>()
  private runs: NavRun[] = []
  private rows: Row[] = []
  private trees: RunTree[] = []
  private shownTree?: RunTree
  private lastSize = { width: 100, height: 30 }
  private told?: string

  constructor(
    private readonly deps: NavDeps,
    runId: string,
    select?: string,
  ) {
    this.shown = runId
    this.refresh()
    if (select && this.shownTree) this.nav.openAt(this.shownTree, select)
    this.settle()
  }

  /** What the page has selected: the row of a level, or what the detail shows. */
  get selected(): string {
    return this.nav.selected
  }

  /** The run the page shows. */
  run(): NavRun | undefined {
    return this.runs.find(r => r.snapshot.id === this.shown)
  }

  private tree(): RunTree | undefined {
    return this.run()?.snapshot.tree
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
    this.shownTree = shown
    this.trees = trees
    const opened = new Set(shown?.groups.map(g => groupKey(shown.id, g.key)) ?? [])
    this.rows = visibleRows(trees, { run: this.shown, folded: new Set(), opened, runs: trees.length > 1 ? 'list' : 'one' })
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

  private levelView(tree: RunTree, width: number, height: number): LevelView {
    const now = this.deps.now()
    return {
      tree,
      trees: this.trees,
      now,
      width,
      height,
      activity: agent => {
        const live = attempt(() => this.deps.activity?.(agent.session))?.now
        return live ? nowLine(live, now, agent.cwd) : undefined
      },
      subName: name => clean(this.subs.get(name)?.title || name),
    }
  }

  private levelPage() {
    const tree = this.shownTree
    return tree ? this.nav.layout(this.levelView(tree, this.lastSize.width, levelBody(this.lastSize.height))) : undefined
  }

  /** Keeps the levels on what exists, and tells the hub which agents to read. */
  private settle() {
    if (this.nav.detail && !this.selectedRow()) this.nav.back()
    this.levelPage()
    if (this.selected !== this.listFor) {
      this.listFor = this.selected
      this.follow = true
    }
    const watched = this.watched().join('\n')
    if (watched === this.told) return
    this.told = watched
    attempt(() => this.deps.onWatch?.(this.watched()))
  }

  /** The agent the detail shows, or the running agents of the round on screen. */
  private watched(): string[] {
    const row = this.selectedRow()
    if (this.nav.detail) return row?.kind === 'agent' ? [row.agent!.session] : []
    const { screen } = this.nav
    if (screen.kind !== 'round') return []
    const group = this.shownTree?.groups.find(g => g.key === screen.group)
    const round = group && flowOf(group).rounds.find(r => r.number === screen.round)
    return round ? round.review.filter(a => a.state === 'running').slice(0, MAX_WATCHED).map(a => a.session) : []
  }

  private selectedRow(): Row | undefined {
    const key = this.nav.detail
    return key ? this.rows.find(r => r.key === key) : undefined
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
    if (key === 'parent') {
      const parent = this.run()?.snapshot.parent
      return parent ? { type: 'parent', sessionID: parent } : undefined
    }
    return this.nav.detail ? this.pressDetail(key) : this.pressLevel(key)
  }

  private pressLevel(key: NavKey): NavAction | undefined {
    const { nav } = this
    const tree = this.shownTree
    const inRound = nav.screen.kind === 'round'
    const page = Math.max(1, levelBody(this.lastSize.height))
    switch (key) {
      case 'up':
        return void nav.move(-1)
      case 'down':
        return void nav.move(1)
      case 'pageup':
        return void nav.move(-page)
      case 'pagedown':
        return void nav.move(page)
      case 'home':
        return void nav.edge(false)
      case 'end':
        return void nav.edge(true)
      case 'left':
        return void (inRound ? nav.move(-1) : nav.back())
      case 'right':
        return void (inRound ? nav.move(1) : this.enter())
      case 'return':
      case 'space':
        return void this.enter()
      case 'next':
        return void (inRound && tree ? nav.otherRound(tree, 1) : nav.move(1))
      case 'prev':
        return void (inRound && tree ? nav.otherRound(tree, -1) : nav.move(-1))
      case 'follow':
        return void (tree && nav.findings(tree))
      case 'log':
        return void (tree && nav.log(tree))
      case 'back':
        return nav.back() ? undefined : { type: 'back' }
      default:
        return undefined
    }
  }

  private enter() {
    const { run } = this.nav.enter()
    if (!run) return
    this.shown = run
    this.nav.reset()
    this.refresh()
  }

  private pressDetail(key: NavKey): NavAction | undefined {
    const listing = this.listing()
    const listPage = Math.max(1, this.listRoom - 1)
    const tree = this.shownTree
    switch (key) {
      case 'up':
        return void (listing && this.scroll(-1))
      case 'down':
        return void (listing && this.scroll(1))
      case 'pageup':
        return void (listing && this.scroll(-listPage))
      case 'pagedown':
        return void (listing && this.scroll(listPage))
      case 'home':
        return void (listing && this.scroll(-this.listRows))
      case 'end':
        return void (listing && (this.follow = true))
      case 'next':
        return void (tree && this.nav.stepDetail(tree, 1))
      case 'prev':
        return void (tree && this.nav.stepDetail(tree, -1))
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
      case 'return':
      case 'space':
      case 'right': {
        const row = this.selectedRow()
        if (row?.kind === 'agent' && row.agent!.session) return { type: 'open', sessionID: row.agent!.session }
        if (row?.kind === 'sub') return { type: 'open', sessionID: row.sub!.name }
        return undefined
      }
      case 'left':
      case 'back':
        this.nav.back()
        return undefined
      default:
        return undefined
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

  // --- layout -----------------------------------------------------------------------------------

  /** The whole page, every row exactly `width` long. */
  frame(width: number, height: number): Cell[][] {
    const w = Math.max(1, Math.floor(width))
    this.lastSize = { width: w, height }
    this.refresh()
    this.settle()
    const now = this.deps.now()
    const body = levelBody(height)
    const page = this.levelPage()
    if (!page) return levelFrame([{ text: 'granny · no run', tone: 'base' }], [{ text: 'no granny run here', tone: 'muted' }].map(c => [c as Cell]), 'Esc close', w, height)
    if (!this.nav.detail) {
      const readable = this.run()?.snapshot.readable !== false
      const rows = readable ? page.rows : [[{ text: UNREADABLE, tone: 'warning' as const }], ...page.rows]
      return levelFrame(page.crumbs, rows, page.help, w, height, selectedRow(page, this.nav.selected) + (readable ? 0 : 1))
    }
    return levelFrame(page.crumbs, this.detail(now, w, body).map(c => [c]), this.help(), w, height)
  }

  private help(): string {
    const row = this.selectedRow()
    const session = row?.kind === 'agent' || row?.kind === 'sub'
    const open = session ? 'Enter open session' : undefined
    if (this.listing()) return ['PgUp/PgDn scroll', `f follow ${this.follow ? 'on' : 'off'}`, 'v summary', open, 'Tab next agent', 'p parent', 'Esc back'].filter(Boolean).join(' · ')
    return [open, row?.kind === 'agent' ? 'v details' : undefined, session ? 'Tab next agent' : undefined, 'p parent', 'Esc back'].filter(Boolean).join(' · ')
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
