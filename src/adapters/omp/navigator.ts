// The run navigator: a full-screen overlay with the shared levels - the run's stages, a stage's rounds, a
// round's agents, one agent's detail - for the runs of this omp process. Files are read only in the tick;
// render() lays out what the tick read.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type ActivityItem, activityLines, nowLine, summarise } from '../runview/activity'
import { clean, fit } from '../runview/format'
import { agentEnd, agentHead, type Cell, checksDetail, groupDetail, runDetail, type RunFacts, summaryCells, type Tone } from '../runview/layout'
import { levelBody, levelFrame, type LevelView, LevelNav, selectedRow } from '../runview/levels'
import type { RunOutline } from '../runview/outline'
import { TailReader } from '../runview/tail'
import { buildRunTree, groupKey, type JournalEntry, type Row, runKey, type RunTree, visibleRows } from '../runview/tree'
import { eventLine } from './activity'
import type { LiveRun, RoleActivity } from './panel'
import { subagentFiles } from './subagents'
import { LineBuffer, sessionEntryLines } from './transcript'

export interface NavRun {
  id: string
  dir: string
  status: string
  reply?: string
  live: LiveRun
  branch?: string
  outline?: RunOutline
}

export interface NavigatorDeps {
  runs: () => NavRun[]
  runId: string
  tui: { requestRender(): void; terminal?: { rows: number } }
  theme?: any
  keys?: { matches?(data: string, name: string): boolean }
  done: () => void
  now: () => number
  tickMs: number
}

type Key =
  | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end' | 'enter' | 'right' | 'left' | 'escape'
  | 'tab' | 'backtab' | 'space' | 'next' | 'prev' | 'follow' | 'toggle' | 'verbose' | 'log' | 'quit'

const NAMED: Array<[string, Key]> = [
  ['tui.select.up', 'up'],
  ['tui.select.down', 'down'],
  ['tui.select.pageUp', 'pageUp'],
  ['tui.select.pageDown', 'pageDown'],
  ['tui.editor.cursorLineStart', 'home'],
  ['tui.editor.cursorLineEnd', 'end'],
  ['tui.select.confirm', 'enter'],
  ['tui.select.cancel', 'escape'],
  ['tui.editor.cursorLeft', 'left'],
  ['tui.editor.cursorRight', 'right'],
  ['tui.input.tab', 'tab'],
]

const RAW: Record<string, Key> = {
  '\x1b[A': 'up', '\x1bOA': 'up', k: 'up',
  '\x1b[B': 'down', '\x1bOB': 'down', j: 'down',
  '\x1b[C': 'right', '\x1bOC': 'right',
  '\x1b[D': 'left', '\x1bOD': 'left',
  '\x1b[5~': 'pageUp', '\x1b[6~': 'pageDown',
  '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home',
  '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end',
  '\r': 'enter', '\n': 'enter',
  '\x1b': 'escape',
  '\t': 'tab', '\x1b[Z': 'backtab',
  ' ': 'space', ']': 'next', '[': 'prev', f: 'follow', t: 'toggle', v: 'verbose', l: 'log', q: 'quit',
}

const SOURCES = 8
const MAX_ITEMS = 5000
const MB = 1024 * 1024
const TONE_STYLES: Record<Tone, string> = { base: 'text', muted: 'muted', success: 'success', error: 'error', warning: 'warning', info: 'accent' }

/** What an agent's detail shows: the summary, every event (`v`), or its session transcript (`t`). */
type Mode = 'summary' | 'verbose' | 'transcript'

interface Source {
  key: string
  kind: 'events' | 'transcript' | 'static'
  /** A transcript's directory to list (an agent's session) or the one file it reads. */
  dir?: string
  file?: string
  relist: boolean
  readers: Map<string, TailReader>
  buffer: LineBuffer
  items: ActivityItem[]
  itemsVersion: number
  skippedMb: number
  follow: boolean
  top?: number
  read: number
  polled: boolean
}

interface RunCache {
  reader: TailReader
  entries: JournalEntry[]
  files: Map<string, Map<string, string>>
  status?: { for: string; data: Record<string, unknown> }
  read: boolean
}

interface Body {
  key: string
  lines: string[]
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const isLive = (row: Row) => row.agent?.state === 'running' || row.agent?.state === 'waiting'

function wrap(lines: readonly string[], width: number): string[] {
  const out: string[] = []
  const w = Math.max(1, width)
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    if (line.length <= w) out.push(line)
    else for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w))
  }
  return out
}

function home(): string | undefined {
  try {
    return homedir()
  } catch {
    return undefined
  }
}

export class Navigator {
  private readonly nav = new LevelNav()
  private shown: string
  private trees: RunTree[] = []
  private rows: Row[] = []
  private lastWidth = 100
  private readonly caches = new Map<string, RunCache>()
  private readonly sources = new Map<string, Source>()
  private readonly modes = new Map<string, Mode>()
  private readonly home = home()
  private source?: Source
  private version = 0
  private memo?: { key: string; lines: string[] }
  private wrapped?: { key: string; lines: string[] }
  private verbose?: { key: string; lines: string[] }
  private bodyHeight = 10
  private bodyLength = 0
  private closed = false
  private finished = false
  private readonly timer: ReturnType<typeof setInterval>
  private soon?: ReturnType<typeof setTimeout>

  constructor(private readonly deps: NavigatorDeps) {
    this.shown = deps.runId
    try {
      this.refresh()
      this.levelPage()
      this.pollSource()
    } catch {}
    this.timer = setInterval(() => this.tick(), Math.max(10, deps.tickMs))
    this.timer.unref?.()
  }

  get disposed(): boolean {
    return this.closed
  }

  /** Bytes the shown detail source has read from disk so far. */
  get bytesRead(): number {
    return this.source?.read ?? 0
  }

  tick() {
    if (this.closed) return
    try {
      this.refresh()
      this.pollSource()
    } catch {}
    this.version++
    this.redraw()
  }

  dispose() {
    this.closed = true
    clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
  }

  invalidate() {
    this.memo = undefined
    this.wrapped = undefined
  }

  capturesInput(data: string): boolean {
    try {
      return this.keyOf(data) !== undefined
    } catch {
      return false
    }
  }

  handleInput(data: string) {
    if (this.closed) return
    try {
      const key = this.keyOf(data)
      if (!key) return
      if (this.nav.detail) this.detailKey(key)
      else this.levelKey(key)
    } catch {}
    if (this.closed) return
    this.version++
    this.redraw()
  }

  render(width: number): readonly string[] {
    const height = this.height()
    const key = `${width}:${height}:${this.version}`
    if (this.memo?.key === key) return this.memo.lines
    let lines: string[]
    try {
      lines = this.draw(width, height)
    } catch {
      lines = [fit('granny: the navigator could not draw this view', width)]
    }
    this.memo = { key, lines }
    return lines
  }

  private close() {
    if (this.finished) return
    this.finished = true
    this.dispose()
    try {
      this.deps.done()
    } catch {}
  }

  private redraw() {
    try {
      this.deps.tui.requestRender()
    } catch {
      this.close()
    }
  }

  private keyOf(data: string): Key | undefined {
    const matches = this.deps.keys?.matches
    if (typeof matches === 'function') {
      for (const [name, key] of NAMED) {
        try {
          if (matches.call(this.deps.keys, data, name)) return key
        } catch {}
      }
    }
    return Object.hasOwn(RAW, data) ? RAW[data] : undefined
  }

  private height(): number {
    try {
      const rows = this.deps.tui.terminal?.rows ?? process.stdout.rows ?? 30
      return Math.max(5, Number.isFinite(rows) ? rows : 30)
    } catch {
      return 30
    }
  }

  // --- data -------------------------------------------------------------------------------------

  private cacheOf(run: NavRun): RunCache {
    let cache = this.caches.get(run.id)
    if (!cache) {
      cache = { reader: new TailReader(join(run.dir, 'journal.jsonl')), entries: [], files: new Map(), read: false }
      this.caches.set(run.id, cache)
    }
    return cache
  }

  private pollJournal(cache: RunCache) {
    const { lines, reset } = cache.reader.poll()
    if (reset) cache.entries = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type !== 'heartbeat') cache.entries.push(entry)
      } catch {}
    }
    cache.read = true
  }

  private runList(): NavRun[] {
    try {
      return this.deps.runs()
    } catch {
      return []
    }
  }

  private liveRole(runId: string, session: string): RoleActivity | undefined {
    return this.runList()
      .find(r => r.id === runId)
      ?.live.roles.find(r => r.info.session === session)
  }

  private refresh() {
    const now = this.deps.now()
    const runs = this.runList()
    this.trees = runs.map(run => {
      const cache = this.cacheOf(run)
      const shown = run.id === this.shown
      if (shown || (!cache.read && run.status !== 'running')) this.pollJournal(cache)
      const live = new Map<string, RoleActivity>()
      for (const role of run.live.roles) live.set(role.info.session, role)
      const info = { id: run.id, status: run.status, startedAt: run.live.startedAt, ...(run.reply !== undefined ? { reply: run.reply } : {}), ...(run.branch ? { branch: run.branch } : {}) }
      const build = () => buildRunTree(info, cache.entries, live, now, cache.files, run.outline)
      if (this.selected === runKey(run.id) && cache.status?.for !== run.status) {
        try {
          cache.status = { for: run.status, data: JSON.parse(readFileSync(join(run.dir, 'status.json'), 'utf8')) }
        } catch {}
      }
      const tree = build()
      if (!shown) return tree
      let found = false
      for (const agent of tree.agents) {
        if (!agent.subagents.length) continue
        const files = subagentFiles(agent.session)
        if ([...files.values()].join('\n') !== [...(cache.files.get(agent.session)?.values() ?? [])].join('\n')) found = true
        cache.files.set(agent.session, files)
      }
      return found ? build() : tree
    })
    this.relayout()
  }

  private shownTree(): RunTree | undefined {
    return this.trees.find(t => t.id === this.shown)
  }

  private get selected(): string {
    return this.nav.detail ?? ''
  }

  /** Every row of the shown run, for the detail to look its selected one up in. */
  private relayout() {
    const tree = this.shownTree()
    const opened = new Set(tree?.groups.map(g => groupKey(tree.id, g.key)) ?? [])
    this.rows = visibleRows(this.trees, { run: this.shown, folded: new Set(), opened, runs: this.trees.length > 1 ? 'list' : 'one' })
    if (this.nav.detail && !this.selectedRow()) this.nav.back()
    this.choose()
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
        const live = this.liveRole(tree.id, agent.session)?.now()
        return live ? nowLine(live, now, agent.cwd) : undefined
      },
    }
  }

  /** Lays out the level on screen, so the keys and the first draw see its items. */
  private levelPage() {
    const tree = this.shownTree()
    return tree ? this.nav.layout(this.levelView(tree, this.lastWidth, levelBody(this.height()))) : undefined
  }

  private selectedRow(): Row | undefined {
    return this.rows.find(r => r.key === this.selected)
  }

  private modeOf(row: Row): Mode {
    return this.modes.get(row.key) ?? 'summary'
  }

  private choose() {
    const row = this.selectedRow()
    if (!row) return void (this.source = undefined)
    let spec: Pick<Source, 'kind' | 'relist' | 'follow'> & Partial<Pick<Source, 'dir' | 'file'>>
    if (row.kind === 'agent') {
      const agent = row.agent!
      const live = isLive(row)
      spec =
        this.modeOf(row) === 'transcript'
          ? { kind: 'transcript', dir: agent.session, relist: live, follow: live }
          : { kind: 'events', file: join(agent.session, 'events.jsonl'), relist: false, follow: live }
    } else if (row.kind === 'sub') spec = { kind: 'transcript', ...(row.sub!.path ? { file: row.sub!.path } : {}), relist: false, follow: false }
    else spec = { kind: 'static', relist: false, follow: false }
    const key = `${row.key}|${spec.kind}|${spec.file ?? spec.dir ?? ''}`
    let source = this.sources.get(key)
    if (!source) {
      source = { key, readers: new Map(), buffer: new LineBuffer(), items: [], itemsVersion: 0, skippedMb: 0, read: 0, polled: false, ...spec }
      this.sources.set(key, source)
      if (this.sources.size > SOURCES) this.sources.delete(this.sources.keys().next().value!)
      if (source.file || source.dir) this.later()
    } else if (source.dir) source.relist = spec.relist
    if (row.kind === 'run') this.later()
    this.source = source
  }

  /** Reads the newly selected source on the next turn of the event loop, not inside the key handler. */
  private later() {
    if (this.soon || this.closed) return
    this.soon = setTimeout(() => {
      this.soon = undefined
      this.tick()
    }, 0)
    this.soon.unref?.()
  }

  private pollSource(): void {
    const source = this.source
    if (!source || (!source.file && !source.dir)) return
    if (source.dir && (source.relist || !source.readers.size)) {
      let names: string[] = []
      try {
        names = readdirSync(source.dir).filter(n => n.endsWith('.jsonl') && n !== 'events.jsonl').sort()
      } catch {}
      for (const name of names) {
        const path = join(source.dir, name)
        if (!source.readers.has(path)) source.readers.set(path, new TailReader(path))
      }
    } else if (source.file && !source.readers.size) source.readers.set(source.file, new TailReader(source.file))
    source.polled = true
    for (const reader of source.readers.values()) {
      const before = reader.bytesRead
      const { lines, reset, skippedBytes } = reader.poll()
      source.read += reader.bytesRead - before
      if (reset) {
        source.readers.clear()
        source.buffer = new LineBuffer()
        source.items = []
        source.itemsVersion++
        source.skippedMb = 0
        source.top = undefined
        return this.pollSource()
      }
      const skipped = skippedBytes ? Math.max(1, Math.round(skippedBytes / MB)) : 0
      if (source.kind === 'events') {
        source.skippedMb += skipped
        const items = lines.map(eventLine).filter((i): i is ActivityItem => i !== undefined)
        if (items.length) {
          source.items.push(...items)
          if (source.items.length > MAX_ITEMS) source.items.splice(0, source.items.length - MAX_ITEMS)
          source.itemsVersion++
        }
      } else {
        if (skipped) source.buffer.push([`… first ${skipped} MB skipped`])
        if (lines.length) source.buffer.push(lines.flatMap(sessionEntryLines))
      }
    }
  }

  // --- keys -------------------------------------------------------------------------------------

  private levelKey(key: Key) {
    const tree = this.shownTree()
    const { nav } = this
    if (!tree) {
      if (key === 'escape' || key === 'quit') this.close()
      return
    }
    this.levelPage()
    const inRound = nav.screen.kind === 'round'
    const page = Math.max(1, levelBody(this.height()))
    switch (key) {
      case 'up':
      case 'backtab':
        nav.move(-1)
        break
      case 'down':
      case 'tab':
        nav.move(1)
        break
      case 'pageUp':
        nav.move(-page)
        break
      case 'pageDown':
        nav.move(page)
        break
      case 'home':
        nav.edge(false)
        break
      case 'end':
        nav.edge(true)
        break
      case 'left':
        if (inRound) nav.move(-1)
        else nav.back()
        break
      case 'right':
        if (inRound) nav.move(1)
        else this.enter()
        break
      case 'enter':
      case 'space':
        this.enter()
        break
      case 'next':
        if (inRound) nav.otherRound(tree, 1)
        else nav.move(1)
        break
      case 'prev':
        if (inRound) nav.otherRound(tree, -1)
        else nav.move(-1)
        break
      case 'follow':
        nav.findings(tree)
        break
      case 'log':
        nav.log(tree)
        break
      case 'escape':
        if (!nav.back()) return this.close()
        break
      case 'quit':
        return this.close()
    }
    this.relayout()
    this.levelPage()
  }

  private enter() {
    const { run } = this.nav.enter()
    if (run) this.switchRun(run)
  }

  private switchRun(id: string) {
    this.shown = id
    this.nav.reset()
    this.later()
    this.relayout()
  }

  private detailKey(key: Key) {
    const source = this.source
    switch (key) {
      case 'up':
        return this.scroll(-1)
      case 'down':
        return this.scroll(1)
      case 'pageUp':
        return this.scroll(-Math.max(1, this.bodyHeight - 1))
      case 'pageDown':
        return this.scroll(Math.max(1, this.bodyHeight - 1))
      case 'home':
        if (source && this.scrolls()) {
          source.follow = false
          source.top = 0
        }
        return
      case 'end':
        if (source && this.scrolls()) {
          source.follow = true
          source.top = undefined
        }
        return
      case 'follow':
        if (source && this.scrolls()) {
          source.follow = !source.follow
          if (source.follow) source.top = undefined
          else this.scroll(0)
        }
        return
      case 'toggle':
        return this.switchMode('transcript')
      case 'verbose':
        return this.switchMode('verbose')
      case 'tab':
      case 'next':
        return this.stepDetail(1)
      case 'backtab':
      case 'prev':
        return this.stepDetail(-1)
      case 'left':
      case 'escape':
        this.nav.back()
        this.relayout()
        this.levelPage()
        return
      case 'quit':
        return this.close()
    }
  }

  private stepDetail(dir: 1 | -1) {
    const tree = this.shownTree()
    if (!tree) return
    this.nav.stepDetail(tree, dir)
    this.relayout()
  }

  /** `t` and `v` turn their view on, or back to the summary when it is on. */
  private switchMode(mode: Mode) {
    const row = this.selectedRow()
    if (row?.kind !== 'agent') return
    this.modes.set(row.key, this.modeOf(row) === mode ? 'summary' : mode)
    this.choose()
  }

  /** Whether the detail shows a scrollable list (not an agent's summary). */
  private scrolls(): boolean {
    const row = this.selectedRow()
    return row?.kind !== 'agent' || this.modeOf(row) !== 'summary'
  }

  private scroll(delta: number) {
    const source = this.source
    if (!source || !this.scrolls()) return
    const max = Math.max(0, this.bodyLength - this.bodyHeight)
    const current = source.follow || source.top === undefined ? max : source.top
    source.top = clamp(current + delta, 0, max)
    if (delta < 0) source.follow = false
  }

  // --- drawing ----------------------------------------------------------------------------------

  private paint(style: string, text: string): string {
    const theme = this.deps.theme
    if (typeof theme?.fg !== 'function') return text
    try {
      const out = theme.fg(style, text)
      return typeof out === 'string' ? out : text
    } catch {
      return text
    }
  }

  private highlight(text: string): string {
    const theme = this.deps.theme
    try {
      if (typeof theme?.bg === 'function') {
        const out = theme.bg('selectedBg', text)
        if (typeof out === 'string') return out
      }
    } catch {}
    try {
      if (typeof theme?.inverse === 'function') {
        const out = theme.inverse(text)
        if (typeof out === 'string') return out
      }
    } catch {}
    return text
  }

  private draw(width: number, height: number): string[] {
    this.lastWidth = width
    const tree = this.shownTree() ?? this.trees[0]
    if (!tree) return levelFrame([{ text: 'granny · no run', tone: 'base' }], [], 'Esc close', width, height).map(r => this.paintRow(r))
    const now = this.deps.now()
    const body = levelBody(height)
    const page = this.nav.layout(this.levelView(tree, width, body))
    if (!this.nav.detail) return levelFrame(page.crumbs, page.rows, page.help, width, height, selectedRow(page, this.nav.selected)).map(r => this.paintRow(r))
    const rows = this.detailPane(width, body, now).map(c => [c])
    return levelFrame(page.crumbs, rows, this.help(), width, height).map(r => this.paintRow(r))
  }

  private paintRow(cells: readonly Cell[]): string {
    return cells.map(c => (c.selected ? this.highlight(c.text) : this.paint(TONE_STYLES[c.tone], c.text))).join('')
  }

  private help(): string {
    const row = this.selectedRow()
    const mode = row?.kind === 'agent' ? this.modeOf(row) : undefined
    const parts: string[] = []
    if (mode !== 'summary') parts.push('↑↓ PgUp/PgDn Home/End scroll', `f follow (${this.source?.follow ? 'on' : 'off'})`)
    if (mode) parts.push(`v ${mode === 'verbose' ? 'summary' : 'details'}`, `t ${mode === 'transcript' ? 'summary' : 'transcript'}`)
    if (row?.kind === 'agent' || row?.kind === 'sub') parts.push('Tab/] [ agent')
    parts.push('←/Esc back', 'q close')
    return parts.join(' · ')
  }

  private detailPane(width: number, height: number, now: number): Cell[] {
    const row = this.selectedRow()
    if (!row || height < 1) return []
    const head = this.headOf(row, width, now)
    if (row.kind === 'agent' && this.modeOf(row) === 'summary') return [...head, ...this.summary(row, width, height - head.length, now)].slice(0, height)
    const shown = head.slice(0, Math.max(1, height - 1))
    const bodyHeight = Math.max(1, height - shown.length)
    const body = this.bodyOf(row)
    const key = `${body.key}:${width}`
    if (this.wrapped?.key !== key) this.wrapped = { key, lines: wrap(body.lines.length || this.source?.kind === 'static' ? body.lines : [emptyText(this.source)], width) }
    const lines = this.wrapped.lines
    this.bodyHeight = bodyHeight
    this.bodyLength = lines.length
    const max = Math.max(0, lines.length - bodyHeight)
    const source = this.source
    const top = source?.follow ? max : clamp(source?.top ?? max, 0, max)
    return [...shown, ...lines.slice(top, top + bodyHeight).map((text): Cell => ({ text, tone: 'base' }))]
  }

  /** The detail's fixed first rows, cut to `width`. */
  private headOf(row: Row, width: number, now: number): Cell[] {
    const tree = row.run
    let cells: Cell[]
    switch (row.kind) {
      case 'agent':
        cells = agentHead(row.agent!, now)
        break
      case 'sub':
        cells = [{ text: `${row.sub!.name} · subagent of ${row.agent!.action}`, tone: 'base' }]
        break
      case 'group': {
        const all = groupDetail(tree, row.group!, now, width)
        const n = row.group!.lines.length
        cells = all.slice(0, all.length - n)
        break
      }
      case 'checks':
        cells = checksDetail(row.group!).slice(0, 2)
        break
      case 'run':
        cells = runDetail(tree, this.factsOf(tree))
        break
      default:
        cells = []
    }
    return cells.map(c => ({ ...c, text: fit(c.text, width) }))
  }

  private factsOf(tree: RunTree): RunFacts {
    const run = this.runList().find(r => r.id === tree.id)
    const status = this.caches.get(tree.id)?.status?.data ?? {}
    return {
      ...(typeof status.repo === 'string' ? { repo: clean(status.repo) } : {}),
      ...(run ? { dir: run.dir } : {}),
      ...(tree.status === 'failed' && typeof status.error === 'string' ? { error: clean(status.error) } : {}),
    }
  }

  /** The scrollable rows under the head, and a key that changes with them. */
  private bodyOf(row: Row): Body {
    const source = this.source
    switch (row.kind) {
      case 'agent':
      case 'sub': {
        if (source?.kind !== 'events') return { key: `${source?.key}:${source?.buffer.version}:${source?.polled}`, lines: source?.buffer.lines() ?? [] }
        const lines = this.verboseLines(row)
        return { key: `${this.verbose!.key}:${source.polled}`, lines }
      }
      case 'group':
        return this.staticBody(row, row.group!.lines)
      case 'checks':
        return this.staticBody(row, row.group!.checks?.lines ?? [])
      case 'run': {
        const reply = this.runList().find(r => r.id === row.run.id)?.reply
        return this.staticBody(row, reply === undefined ? [] : ['', ...clean(reply).split('\n')])
      }
      default:
        return { key: row.key, lines: [] }
    }
  }

  private staticBody(row: Row, lines: string[]): Body {
    return { key: `${row.key}:${lines.length}:${lines.at(-1) ?? ''}`, lines }
  }

  /** The agent's events with its journal notes, in time order. */
  private itemsOf(row: Row): ActivityItem[] {
    const items = this.source?.kind === 'events' ? this.source.items : []
    const notes = row.agent!.notes
    if (!notes.length) return items
    return [...items, ...notes.map((n): ActivityItem => ({ t: n.t, kind: 'note', text: n.text }))].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  }

  private verboseLines(row: Row): string[] {
    const source = this.source!
    const key = `${source.key}:${source.itemsVersion}:${row.agent!.notes.length}`
    if (this.verbose?.key !== key) {
      const lines = activityLines(this.itemsOf(row), row.agent!.cwd, this.home)
      this.verbose = { key, lines: source.skippedMb ? [`… first ${source.skippedMb} MB skipped`, ...lines] : lines }
    }
    return this.verbose.lines
  }

  private summary(row: Row, width: number, height: number, now: number): Cell[] {
    if (height < 1) return []
    const agent = row.agent!
    const source = this.source
    const end = agentEnd(agent)
    const live = agent.state === 'running' ? this.liveRole(row.run.id, agent.session)?.now() : undefined
    const summary = summarise(this.itemsOf(row), now, { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(this.home ? { home: this.home } : {}), ...(live ? { live } : {}), ...(end ? { end } : {}), max: height })
    const blank: Cell = { text: '', tone: 'base' }
    const cells = summaryCells(summary, width, height - 1)
    if (!source?.polled && (source?.file || source?.dir)) cells.push({ text: '(reading …)', tone: 'muted' })
    else if (!cells.length) cells.push({ text: '(no events yet)', tone: 'muted' })
    return [blank, ...cells]
  }
}

function emptyText(source: Source | undefined): string {
  if (!source) return ''
  if ((source.file || source.dir) && !source.polled) return '(reading …)'
  if (source.kind === 'events') return '(no events yet)'
  return source.file || source.dir ? '(no transcript yet)' : '(no transcript yet - the subagent has not written one)'
}
