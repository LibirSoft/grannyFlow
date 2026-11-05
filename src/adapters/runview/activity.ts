// What an agent is doing, from a stream of its events: the summary the detail pane shows (NOW, TODO,
// RECENT, LAST SAID) and the full chronological list of the verbose view. Pure; each host turns its own
// events (omp's events.jsonl, opencode's session parts) into ActivityItems.
import { clean, clock, duration, fit, shortArg } from './format'
import type { Tone } from './layout'

export type NowKind = 'thinking' | 'writing' | 'running' | 'waiting' | 'starting' | 'preparing'

export interface NowState {
  state: NowKind
  tool?: string
  arg?: string
  intent?: string
  since: number
  heading?: string
}

export interface TodoItem {
  text: string
  state: 'done' | 'active' | 'pending'
}

export interface ActivityItem {
  t?: number
  kind: 'state' | 'tool' | 'tool-end' | 'text' | 'heading' | 'error' | 'subagents' | 'todo' | 'exit' | 'note'
  /** The tool of a tool, tool-end or error item. */
  name?: string
  /** Pairs a tool-end with its tool. */
  id?: string
  arg?: string
  intent?: string
  /** A state's words (`thinking`, `waiting for model`), a heading, a said text, an error or a note. */
  text?: string
  failed?: boolean
  names?: string[]
  todos?: TodoItem[]
  code?: number
}

export interface NowBlock {
  text: string
  tone: Tone
  /** The running tool's intent, or its short argument. */
  detail?: string
  heading?: string
}

export interface RecentRow {
  t?: number
  tool: string
  text: string
  tone: Tone
}

export interface Summary {
  now?: NowBlock
  todo?: TodoItem[]
  recent: RecentRow[]
  lastSaid?: string
}

export interface AgentEnd {
  state: 'done' | 'failed' | 'cancelled'
  start: number
  end?: number
  error?: string
}

export interface SummaryOptions {
  cwd?: string
  home?: string
  /** What the host knows live about the agent; wins over the state the stream implies. */
  live?: NowState
  /** Set once the agent has ended: NOW shows the outcome. */
  end?: AgentEnd
  /** Rows kept, newest first. */
  max?: number
}

export const ARG_KEYS = ['path', 'file_path', 'file', 'pattern', 'command', 'query', 'url', 'description', 'op'] as const

const ARG_CHARS = 400
const TEXT_CHARS = 120
const SAID_CHARS = 400
const COMMAND_CHARS = 40
const BURST_MS = 5000
const BURST_NAMES = 10
const MAX_ROWS = 200
const SHELLS = new Set(['bash', 'shell', 'sh'])

const oneLine = (text: string) => clean(text).replace(/\s+/g, ' ').trim()

/** The argument a person recognises a tool call by, from its input. */
export function argOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const args = input as Record<string, unknown>
  const key = ARG_KEYS.find(k => typeof args[k] === 'string' && (args[k] as string).trim())
  return key ? oneLine(args[key] as string).slice(0, ARG_CHARS) : undefined
}

const KINDS: Record<string, NowKind> = {
  thinking: 'thinking',
  writing: 'writing',
  starting: 'starting',
  'waiting for model': 'waiting',
  waiting: 'waiting',
  'preparing a tool call': 'preparing',
  preparing: 'preparing',
}

const shortOf = (name: string | undefined, arg: string | undefined, cwd?: string, home?: string): string | undefined => {
  if (!arg) return undefined
  const short = shortArg(arg, cwd, home)
  return SHELLS.has(name ?? '') ? fit(short, COMMAND_CHARS) : short
}

const firstLine = (text: string) => clean(text).split('\n').map(l => l.trim()).find(Boolean) ?? ''

/** The agent's state now as one line, e.g. `● running bash: bun test 12s`. */
export function nowLine(now: NowState, at: number, cwd?: string): string {
  const took = duration(at - now.since)
  switch (now.state) {
    case 'thinking':
      return `● thinking ${took}${now.heading ? ` · "${oneLine(now.heading)}"` : ''}`
    case 'writing':
      return `● writing ${took}`
    case 'running': {
      const what = now.intent ? oneLine(now.intent) : now.arg ? shortArg(now.arg, cwd) : ''
      return `● running ${now.tool ?? 'a tool'}${what ? `: ${what}` : ''} ${took}`
    }
    case 'preparing':
      return `● preparing a tool call ${took}`
    case 'waiting':
      return `… waiting for model ${took}`
    case 'starting':
      return `… starting ${took}`
  }
}

const TODO_MARKS: Record<TodoItem['state'], string> = { done: '✓', active: '●', pending: '·' }

export const todoText = (todos: readonly TodoItem[]) => todos.map(t => `${TODO_MARKS[t.state]} ${oneLine(t.text)}`).join('  ')

/** Every event as one line, oldest first: the verbose view. */
export function activityLines(items: readonly ActivityItem[], cwd?: string, home?: string): string[] {
  const out: string[] = []
  let last = ''
  for (const item of items) {
    const body = lineOf(item, cwd, home)
    if (body === undefined || body === last) continue
    last = body
    out.push(`${clock(item.t)}  ${body}`)
  }
  return out
}

function lineOf(item: ActivityItem, cwd?: string, home?: string): string | undefined {
  const name = oneLine(item.name ?? 'tool')
  switch (item.kind) {
    case 'state':
      return item.text ? `· ${oneLine(item.text)}` : undefined
    case 'heading':
      return item.text ? `» ${oneLine(item.text)}` : undefined
    case 'tool': {
      const arg = item.arg ? shortArg(item.arg, cwd, home) : ''
      const what = item.intent ? `${oneLine(item.intent)}${arg ? ` · ${arg}` : ''}` : arg
      return `▸ ${name.padEnd(6)} ${what}`.trimEnd()
    }
    case 'tool-end':
      return item.failed ? `✗ ${name} failed${item.text ? `: ${firstLine(item.text)}` : ''}` : undefined
    case 'error':
      return `✗ ${name} failed${item.text ? `: ${firstLine(item.text)}` : ''}`
    case 'subagents':
      return `└ task: ${(item.names ?? []).map(oneLine).join(', ')}`
    case 'text': {
      const said = firstLine(item.text ?? '')
      return said ? `✎ "${fit(said, TEXT_CHARS)}"` : undefined
    }
    case 'todo':
      return `▸ ${'todo'.padEnd(6)} ${todoText(item.todos ?? [])}`
    case 'note':
      return item.text ? oneLine(item.text) : undefined
    case 'exit':
      return `■ process exited ${item.code ?? '?'}`
  }
}

interface Row {
  t?: number
  /** The time of a burst's call before its newest. */
  before?: number
  tool: string
  id?: string
  intent?: string
  args: string[]
  count: number
  names?: string[]
  mark?: string
  error?: string
  tone: Tone
  open: boolean
  note?: string
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const isRef = (arg: string) => arg.startsWith('skill://')

function rowText(row: Row): string {
  if (row.note !== undefined) return row.note
  const mark = row.mark ? ` ${row.mark}` : ''
  const error = row.error ? ` ${row.error}` : ''
  if (row.names) return `${row.names.join(', ')}${row.mark ? mark : ' …'}${error}`
  const unique = [...new Set(row.args)]
  if (row.count > 1 && unique.length === 1) return `${unique[0]}  (${row.count}×)${mark}${error}`
  if (row.count > 1 && unique.length > 1) {
    const refs = unique.every(isRef)
    const shown = unique.slice(0, BURST_NAMES).map(a => (refs ? baseName(a) : a))
    return `${row.count} ${refs ? 'skill refs' : 'files'} · ${shown.join(', ')}${unique.length > BURST_NAMES ? ', …' : ''}${mark}${error}`
  }
  return `${row.intent ?? row.args[0] ?? ''}${mark}${error}`.trim()
}

/** NOW, TODO, RECENT (newest first, bursts of one tool merged) and LAST SAID from an agent's events. */
export function summarise(items: readonly ActivityItem[], at: number, opts: SummaryOptions = {}): Summary {
  const { cwd, home } = opts
  const rows: Row[] = []
  let state: NowState | undefined
  let heading: string | undefined
  let todo: TodoItem[] | undefined
  let said: string | undefined
  const openRow = (name: string | undefined, id: string | undefined) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.note === undefined && row.open && (id !== undefined ? row.id === id : row.tool === name)) return row
    }
    return undefined
  }
  for (const item of items) {
    const t = item.t ?? at
    switch (item.kind) {
      case 'state': {
        const kind = KINDS[oneLine(item.text ?? '')]
        if (kind) state = { state: kind, since: t }
        break
      }
      case 'heading':
        if (item.text) heading = oneLine(item.text)
        break
      case 'tool': {
        const tool = oneLine(item.name ?? 'tool')
        const intent = item.intent ? oneLine(item.intent) : undefined
        const arg = isRef(item.arg ?? '') ? item.arg! : shortOf(tool, item.arg, cwd, home)
        state = { state: 'running', tool, ...(item.arg ? { arg: item.arg } : {}), ...(intent ? { intent } : {}), since: t }
        const prev = rows.at(-1)
        const same = prev?.args.every(a => a === arg) && prev.intent === intent
        const burst =
          prev && prev.note === undefined && prev.tool === tool && !prev.names && !prev.mark && !prev.error && tool !== 'task' && arg !== undefined &&
          prev.args.length === prev.count && prev.t !== undefined && t - prev.t <= BURST_MS && (same || !SHELLS.has(tool))
        if (burst) {
          prev.count++
          prev.args.push(arg)
          prev.before = prev.t
          prev.t = t
          prev.id = item.id
          prev.open = true
          if (prev.intent !== intent) delete prev.intent
          break
        }
        rows.push({ t, tool, ...(item.id ? { id: item.id } : {}), ...(intent ? { intent } : {}), args: arg ? [arg] : [], count: 1, tone: 'base', open: true })
        break
      }
      case 'subagents': {
        const row = openRow('task', undefined)
        const names = (item.names ?? []).map(oneLine)
        if (row) row.names = names
        else rows.push({ t, tool: 'task', args: [], count: 1, names, tone: 'base', open: true })
        break
      }
      case 'tool-end': {
        const row = openRow(item.name, item.id)
        if (row) {
          row.open = false
          if (item.failed) {
            row.mark = '✗'
            row.tone = 'error'
          } else if (row.names) row.mark = '✓'
        }
        if (state?.state === 'running' && (state.tool === item.name || item.name === undefined)) state = { state: 'waiting', since: t }
        break
      }
      case 'error': {
        const row = openRow(item.name, item.id) ?? [...rows].reverse().find(r => r.tool === item.name)
        if (row) {
          row.open = false
          row.mark = '✗'
          row.tone = 'error'
          if (item.text) row.error = firstLine(item.text)
        }
        break
      }
      case 'todo':
        todo = (item.todos ?? []).map(x => ({ text: oneLine(x.text), state: x.state }))
        break
      case 'text': {
        const lines = clean(item.text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
        if (lines.length) said = fit(lines.join(' ').replace(/\s+/g, ' '), SAID_CHARS)
        if (state?.state === 'writing') state = { state: 'waiting', since: t }
        break
      }
      case 'note':
        if (item.text) rows.push({ t, tool: '', args: [], count: 1, note: oneLine(item.text), tone: 'warning', open: false })
        break
      case 'exit':
        state = undefined
        break
    }
  }

  const live = opts.live ?? state
  const last = rows.at(-1)
  if (!opts.end && live?.state === 'running' && last?.open && last.tool === live.tool && !last.names) {
    if (last.count > 1) {
      last.count--
      last.args.pop()
      last.t = last.before
    } else rows.pop()
  }
  const max = opts.max ?? MAX_ROWS
  const recent = rows.slice(-max).reverse().map((row): RecentRow => ({ ...(row.t !== undefined ? { t: row.t } : {}), tool: row.tool, text: rowText(row), tone: row.tone }))
  const now = nowBlock(opts.end, live, opts.live?.heading ?? heading, at, cwd, home)
  return { ...(now ? { now } : {}), ...(todo ? { todo } : {}), recent, ...(said ? { lastSaid: said } : {}) }
}

function nowBlock(end: AgentEnd | undefined, state: NowState | undefined, heading: string | undefined, at: number, cwd?: string, home?: string): NowBlock | undefined {
  if (end) {
    const took = duration((end.end ?? at) - end.start)
    if (end.state === 'done') return { text: `✓ done in ${took}`, tone: 'success' }
    if (end.state === 'cancelled') return { text: `⊘ cancelled after ${took}`, tone: 'warning' }
    return { text: `✗ failed after ${took}${end.error ? `: ${firstLine(end.error)}` : ''}`, tone: 'error' }
  }
  if (!state) return undefined
  const took = duration(at - state.since)
  const extra = heading ? { heading } : {}
  switch (state.state) {
    case 'running': {
      const detail = state.intent ? oneLine(state.intent) : shortOf(state.tool, state.arg, cwd, home)
      return { text: `● ${state.tool ?? 'tool'} · ${took}`, tone: 'info', ...(detail ? { detail } : {}), ...extra }
    }
    case 'thinking':
    case 'writing':
      return { text: `● ${state.state} ${took}`, tone: 'info', ...extra }
    case 'preparing':
      return { text: `● preparing a tool call ${took}`, tone: 'info', ...extra }
    case 'waiting':
      return { text: `… waiting for model ${took}`, tone: 'muted', ...extra }
    case 'starting':
      return { text: `… starting ${took}`, tone: 'muted', ...extra }
  }
}
