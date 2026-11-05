// The run navigator: a full-screen overlay with the runs of this omp process as a tree (phases,
// round/stage groups, agents, subagents) and a detail pane for the selected node. Files are read
// only in the tick; render() lays out cached lines.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stamp } from './format'
import { duration, type LiveRun, type RoleActivity } from './panel'
import { TailReader } from './tail'
import { LineBuffer, sessionEntryLines } from './transcript'
import { AGENT_MARKERS, buildRunTree, type JournalEntry, nextAgent, type Row, rowText, runKey, type RunTree, subagentFiles, visibleRows } from './tree'
import { entryLines, fit, type Logged } from './watch'

export interface NavRun {
  id: string
  dir: string
  status: string
  reply?: string
  live: LiveRun
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
  | 'tab' | 'backtab' | 'space' | 'next' | 'prev' | 'follow' | 'toggle' | 'quit'

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
  ' ': 'space', ']': 'next', '[': 'prev', f: 'follow', t: 'toggle', q: 'quit',
}

const TREE_HELP = '↑↓ move · Enter/→ open · Space fold · Tab/] next agent · [ prev · Esc close'
const SOURCES = 8
const MB = 1024 * 1024
const SEPARATOR = ' │ '

type SourceKind = 'events' | 'transcript' | 'phase' | 'run'

interface Source {
  key: string
  kind: SourceKind
  /** A file source's directory to list (an agent's transcript) or its one file. */
  dir?: string
  file?: string
  relist: boolean
  readers: Map<string, TailReader>
  buffer: LineBuffer
  /** The body of a phase or run detail, rebuilt from the tree. */
  lines?: string[]
  linesVersion: number
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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

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

export class Navigator {
  private focus: 'tree' | 'detail' = 'tree'
  private expanded: string
  private readonly folded = new Set<string>()
  private selected = ''
  private trees: RunTree[] = []
  private rows: Row[] = []
  private readonly parents = new Map<string, string>()
  private readonly caches = new Map<string, RunCache>()
  private readonly sources = new Map<string, Source>()
  private readonly overrides = new Map<string, 'events' | 'transcript'>()
  private source?: Source
  private version = 0
  private memo?: { key: string; lines: string[] }
  private wrapped?: { key: string; lines: string[] }
  private bodyHeight = 10
  private treeTop = 0
  private closed = false
  private finished = false
  private readonly timer: ReturnType<typeof setInterval>
  private soon?: ReturnType<typeof setTimeout>

  constructor(private readonly deps: NavigatorDeps) {
    this.expanded = deps.runId
    try {
      this.refresh()
      const tree = this.trees.find(t => t.id === this.expanded)
      const agent = tree && ([...tree.agents].reverse().find(a => a.state === 'running') ?? tree.agents.at(-1))
      this.selected = agent ? `agent:${agent.session}` : runKey(this.expanded)
      this.relayout()
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
      if (this.focus === 'tree') this.treeKey(key)
      else this.detailKey(key)
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
        cache.entries.push(JSON.parse(line))
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

  private refresh() {
    const now = this.deps.now()
    const runs = this.runList()
    this.trees = runs.map(run => {
      const cache = this.cacheOf(run)
      const open = run.id === this.expanded
      if (open || (!cache.read && run.status !== 'running')) this.pollJournal(cache)
      const live = new Map<string, RoleActivity>()
      for (const role of run.live.roles) live.set(role.info.session, role)
      const info = { id: run.id, status: run.status, startedAt: run.live.startedAt, ...(run.reply !== undefined ? { reply: run.reply } : {}) }
      const tree = buildRunTree(info, cache.entries, live, now, cache.files)
      if (!open) return tree
      if (this.selected === runKey(run.id) && cache.status?.for !== run.status) {
        try {
          cache.status = { for: run.status, data: JSON.parse(readFileSync(join(run.dir, 'status.json'), 'utf8')) }
        } catch {}
      }
      let found = false
      for (const agent of tree.agents) {
        if (!agent.subagents.length) continue
        const files = subagentFiles(agent.session)
        if ([...files.values()].join('\n') !== [...(cache.files.get(agent.session)?.values() ?? [])].join('\n')) found = true
        cache.files.set(agent.session, files)
      }
      return found ? buildRunTree(info, cache.entries, live, now, cache.files) : tree
    })
    this.relayout()
  }

  private relayout() {
    this.rows = visibleRows(this.trees, this.folded, this.expanded)
    for (const row of this.rows) if (row.parent) this.parents.set(row.key, row.parent)
    let key: string | undefined = this.selected
    while (key && !this.rows.some(r => r.key === key && r.selectable)) key = this.parents.get(key)
    this.selected = key ?? this.rows.find(r => r.selectable)?.key ?? ''
    this.choose()
  }

  private selectedRow(): Row | undefined {
    return this.rows.find(r => r.key === this.selected)
  }

  private choose() {
    const row = this.selectedRow()
    if (!row) return void (this.source = undefined)
    let kind: SourceKind
    let spec: Partial<Source> = {}
    if (row.kind === 'agent') {
      const agent = row.agent!
      const live = agent.state === 'running' || agent.state === 'waiting'
      kind = this.overrides.get(row.key) ?? (live ? 'events' : 'transcript')
      spec = kind === 'events' ? { file: join(agent.session, 'events.jsonl'), relist: false } : { dir: agent.session, relist: live }
      spec.follow = live
    } else if (row.kind === 'sub') {
      kind = 'transcript'
      spec = { ...(row.sub!.path ? { file: row.sub!.path } : {}), relist: false, follow: false }
    } else kind = row.kind === 'run' ? 'run' : 'phase'
    const key = `${row.key}|${kind}|${spec.file ?? spec.dir ?? ''}`
    let source = this.sources.get(key)
    if (!source) {
      source = { key, kind, relist: false, readers: new Map(), buffer: new LineBuffer(), linesVersion: 0, follow: false, read: 0, polled: false, ...spec }
      this.sources.set(key, source)
      if (this.sources.size > SOURCES) this.sources.delete(this.sources.keys().next().value!)
      if (source.file || source.dir) this.later()
    } else if (source.dir) source.relist = spec.relist ?? false
    this.source = source
    if (kind === 'phase' || kind === 'run') this.staticBody(source, row)
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

  private staticBody(source: Source, row: Row) {
    const lines = row.kind === 'run' ? this.runBody(row.run) : row.phase!.lines
    if (source.lines && source.lines.length === lines.length && source.lines.every((l, i) => l === lines[i])) return
    source.lines = lines
    source.linesVersion++
  }

  private runBody(tree: RunTree): string[] {
    const run = this.runList().find(r => r.id === tree.id)
    const status = this.caches.get(tree.id)?.status?.data ?? {}
    const out = [`status   ${tree.status}`]
    if (typeof status.repo === 'string') out.push(`repo     ${status.repo}`)
    if (typeof status.branch === 'string') out.push(`branch   ${status.branch}`)
    out.push(`started  ${stamp(status.startedAt) ?? stamp(tree.start) ?? '?'}`)
    if (tree.status !== 'running') out.push(`ended    ${stamp(status.finishedAt) ?? stamp(tree.end) ?? '?'}`)
    else out.push(`phase    ${tree.phase ?? '?'}`)
    if (run) out.push(`result   ${join(run.dir, 'result.json')}`)
    if (run?.reply !== undefined) out.push('', ...run.reply.split('\n'))
    return out
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
    const render = source.kind === 'events' ? eventLines : sessionEntryLines
    source.polled = true
    for (const reader of source.readers.values()) {
      const before = reader.bytesRead
      const { lines, reset, skippedBytes } = reader.poll()
      source.read += reader.bytesRead - before
      if (reset) {
        source.readers.clear()
        source.buffer = new LineBuffer()
        source.top = undefined
        return this.pollSource()
      }
      if (skippedBytes) source.buffer.push([`… first ${Math.max(1, Math.round(skippedBytes / MB))} MB skipped`])
      if (lines.length) source.buffer.push(lines.flatMap(render))
    }
  }

  // --- keys -------------------------------------------------------------------------------------

  private select(key: string | undefined) {
    if (!key || key === this.selected) return
    this.selected = key
    this.choose()
  }

  private selectable(): Row[] {
    return this.rows.filter(r => r.selectable)
  }

  private moveBy(delta: number) {
    const rows = this.selectable()
    const at = rows.findIndex(r => r.key === this.selected)
    this.select(rows[clamp(at + delta, 0, rows.length - 1)]?.key)
  }

  private agentStep(dir: 1 | -1) {
    this.select(nextAgent(this.rows, this.selected, dir))
  }

  private treeKey(key: Key) {
    const page = Math.max(1, this.height() - 3)
    switch (key) {
      case 'up':
        return this.moveBy(-1)
      case 'down':
        return this.moveBy(1)
      case 'pageUp':
        return this.moveBy(-page)
      case 'pageDown':
        return this.moveBy(page)
      case 'home':
        return this.select(this.selectable()[0]?.key)
      case 'end':
        return this.select(this.selectable().at(-1)?.key)
      case 'enter':
      case 'right': {
        const row = this.selectedRow()
        if (row?.kind === 'run' && row.folded && key === 'enter') return this.fold()
        this.focus = 'detail'
        return
      }
      case 'space':
        return this.fold()
      case 'tab':
      case 'next':
        return this.agentStep(1)
      case 'backtab':
      case 'prev':
        return this.agentStep(-1)
      case 'left':
        return this.select(this.selectedRow()?.parent)
      case 'escape':
      case 'quit':
        return this.close()
    }
  }

  private fold() {
    const row = this.selectedRow()
    if (!row) return
    if (row.kind === 'run') {
      if (row.run.id !== this.expanded) {
        this.expanded = row.run.id
        this.folded.delete(row.key)
        this.later()
      } else if (this.folded.has(row.key)) this.folded.delete(row.key)
      else this.folded.add(row.key)
    } else if (row.kind === 'phase') {
      if (this.folded.has(row.key)) this.folded.delete(row.key)
      else this.folded.add(row.key)
    } else return
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
        if (source) {
          source.follow = false
          source.top = 0
        }
        return
      case 'end':
        if (source) {
          source.follow = true
          source.top = undefined
        }
        return
      case 'follow':
        if (source) {
          source.follow = !source.follow
          if (source.follow) source.top = undefined
          else this.scroll(0)
        }
        return
      case 'toggle': {
        const row = this.selectedRow()
        if (row?.kind !== 'agent' || !source) return
        this.overrides.set(row.key, source.kind === 'events' ? 'transcript' : 'events')
        return this.choose()
      }
      case 'tab':
      case 'next':
        return this.agentStep(1)
      case 'backtab':
      case 'prev':
        return this.agentStep(-1)
      case 'left':
      case 'escape':
        this.focus = 'tree'
        return
      case 'quit':
        return this.close()
    }
  }

  private scroll(delta: number) {
    const source = this.source
    if (!source) return
    const length = this.wrapped?.lines.length ?? 0
    const max = Math.max(0, length - this.bodyHeight)
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
    const tree = this.trees.find(t => t.id === this.expanded) ?? this.trees[0]
    const now = this.deps.now()
    const tag = this.focus === 'tree' ? '[tree]' : '[detail]'
    const title = tree ? `granny ${tree.id} · ${tree.phase ?? 'Starting'} · ${tree.status} · ${duration((tree.end ?? now) - tree.start)}` : 'granny · no run'
    const room = width - tag.length - 1
    const header = room >= 10 ? `${fit(title, room).padEnd(room)} ${tag}` : fit(title, width)
    const body = Math.max(1, height - 2)
    let panes: string[]
    if (width >= 100) {
      const treeWidth = clamp(Math.round(width * 0.38), 36, 60)
      const left = this.treePane(treeWidth, body, now)
      const right = this.detailPane(width - treeWidth - SEPARATOR.length, body, now)
      panes = left.map((l, i) => `${l}${this.paint('dim', SEPARATOR)}${right[i] ?? ''}`)
    } else panes = this.focus === 'tree' ? this.treePane(width, body, now) : this.detailPane(width, body, now)
    return [this.paint('accent', header), ...panes, this.paint('dim', fit(this.help(), width))]
  }

  private help(): string {
    if (this.focus === 'tree') return TREE_HELP
    const source = this.source
    const toggle = this.selectedRow()?.kind === 'agent' ? ` · t ${source?.kind === 'events' ? 'transcript' : 'events'}` : ''
    return `↑↓ PgUp/PgDn Home/End scroll · f follow (${source?.follow ? 'on' : 'off'})${toggle} · Tab/] [ agent · ←/Esc back · q close`
  }

  private treePane(width: number, height: number, now: number): string[] {
    const at = this.rows.findIndex(r => r.key === this.selected)
    if (at >= 0) {
      if (at < this.treeTop) this.treeTop = at
      if (at >= this.treeTop + height) this.treeTop = at - height + 1
    }
    this.treeTop = clamp(this.treeTop, 0, Math.max(0, this.rows.length - height))
    const out: string[] = []
    for (const row of this.rows.slice(this.treeTop, this.treeTop + height)) {
      const chosen = row.key === this.selected
      const plain = fit(`${chosen ? '›' : ' '} ${rowText(row, now, width - 2)}`, width).padEnd(width)
      out.push(chosen ? this.highlight(plain) : this.paint(styleOf(row), plain))
    }
    while (out.length < height) out.push(' '.repeat(width))
    return out
  }

  private detailHeader(now: number): string {
    const row = this.selectedRow()
    const source = this.source
    if (!row) return 'nothing selected'
    const follow = `follow ${source?.follow ? 'on' : 'off'}`
    switch (row.kind) {
      case 'agent': {
        const a = row.agent!
        const view = this.runList().find(r => r.id === row.run.id)?.live.roles.find(r => r.info.session === a.session)
        const state =
          a.state === 'running' && view
            ? `${view.state} ${duration(now - view.since)}${view.state === 'thinking' && view.heading ? ` · "${view.heading}"` : ''}`
            : `${a.state} ${duration((a.end ?? now) - a.start)}`
        return `${a.label} (${a.role}) · ${a.model ?? 'default model'}${a.effort ? `/${a.effort}` : ''} · ${state} · ${source?.kind ?? 'events'} · ${follow}`
      }
      case 'sub':
        return `${row.sub!.name} · subagent of ${row.agent!.label} · transcript · ${follow}`
      case 'phase': {
        const p = row.phase!
        return `${p.marker} ${p.title} · ${duration((p.end ?? now) - p.start)} · journal`
      }
      default:
        return `run ${row.run.id} · ${row.run.status}`
    }
  }

  private detailPane(width: number, height: number, now: number): string[] {
    const header = wrap([this.detailHeader(now)], width).slice(0, Math.max(1, height - 1))
    const source = this.source
    const bodyHeight = Math.max(1, height - header.length)
    this.bodyHeight = bodyHeight
    const raw = source?.lines ?? source?.buffer.lines() ?? []
    const version = source?.lines ? source.linesVersion : (source?.buffer.version ?? 0)
    const key = `${source?.key}:${width}:${version}`
    if (this.wrapped?.key !== key) this.wrapped = { key, lines: wrap(raw.length ? raw : [emptyText(source)], width) }
    const lines = this.wrapped.lines
    const max = Math.max(0, lines.length - bodyHeight)
    const top = source?.follow ? max : clamp(source?.top ?? max, 0, max)
    const out = [...header.map(h => this.paint('accent', h)), ...lines.slice(top, top + bodyHeight)]
    while (out.length < height) out.push('')
    return out
  }
}

function eventLines(line: string): string[] {
  if (!line.trim()) return []
  try {
    return entryLines(JSON.parse(line) as Logged)
  } catch {
    return []
  }
}

function emptyText(source: Source | undefined): string {
  if (!source) return ''
  if ((source.file || source.dir) && !source.polled) return '(reading …)'
  if (source.kind === 'events') return '(no events yet)'
  if (source.kind === 'transcript') return source.file || source.dir ? '(no transcript yet)' : '(no transcript yet - the subagent has not written one)'
  return '(nothing yet)'
}

function styleOf(row: Row): string {
  if (row.kind === 'group') return 'dim'
  const state = row.kind === 'agent' ? row.agent!.state : undefined
  const marker = row.kind === 'phase' ? row.phase!.marker : state ? AGENT_MARKERS[state] : undefined
  if (marker === '●') return 'accent'
  if (marker === '✗') return 'error'
  if (marker === '⊘' || marker === '…') return 'muted'
  return 'text'
}
