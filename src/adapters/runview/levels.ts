// The run view as levels, shared by the omp and opencode navigators: the run's stages, a stage's review
// rounds, a round's agents side by side, a round's findings, and the detail of one agent. One level shows at
// a time; Enter goes down, Esc goes up.
import { duration, fit, pad, shortModel } from './format'
import { AGENT_TONES, type Cell, fitRow, STATUS_TONES, type Tone, wrap } from './layout'
import { AGENT_MARKERS, type AgentNode, agentKey, checksKey, type FindingView, GROUP_MARKERS, groupKey, type GroupState, lastOf, type RoundResult, runKey, type RunTree, subKey, type WorkGroup } from './tree'

export type Screen =
  | { kind: 'run' }
  | { kind: 'group'; group: string }
  | { kind: 'round'; group: string; round: number }
  | { kind: 'findings'; group: string; round: number }
  | { kind: 'detail'; key: string }

export interface LevelItem {
  key: string
  /** The body row that must stay on screen when it is selected. */
  row: number
  open?: Screen
  /** A row of another run: Enter shows that run. */
  run?: string
}

export interface LevelPage {
  crumbs: Cell[]
  rows: Cell[][]
  items: LevelItem[]
  /** The item to select when nothing is, or the selected one is gone. */
  preferred?: string
  help: string
}

export interface LevelView {
  tree: RunTree
  trees: readonly RunTree[]
  now: number
  width: number
  /** The rows the body has; connector rows go when they do not fit. */
  height: number
  /** What an agent does now, for its card. */
  activity?: (agent: AgentNode) => string | undefined
  /** A subagent's name for the path, where the host keeps its id as its name. */
  subName?: (name: string) => string
}

export interface RoundView {
  number: number
  state: 'running' | 'done' | 'failed'
  review: AgentNode[]
  judge: AgentNode[]
  fix: AgentNode[]
  result?: RoundResult
  checks?: 'running' | 'passed' | 'failed'
  start?: number
  end?: number
}

const REVIEWING = /^(review|extract)\b/
const JUDGING = /^judge\b/
const BUSY = new Set(['running', 'waiting'])
const CARD_MIN = 28
const MAX_CARDS = 3
const CARD_ROWS = 4
const ROUND_TONES: Record<RoundView['state'], Tone> = { running: 'info', done: 'success', failed: 'error' }
const ROUND_MARKS: Record<RoundView['state'], string> = { running: '●', done: '✓', failed: '✗' }
const GROUP_TONES: Record<GroupState, Tone> = { upcoming: 'muted', running: 'info', done: 'success', failed: 'error', skipped: 'muted', cancelled: 'warning' }

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const span = (start: number | undefined, end: number | undefined, now: number) => (start === undefined ? '' : duration((end ?? now) - start))
const busy = (a: AgentNode) => BUSY.has(a.state)

export const isLoop = (tree: RunTree, group: WorkGroup) => {
  if (group.key === 'plan-review' || group.key === 'final-review') return true
  if (group.number === undefined) return false
  return tree.outline?.stages.find(s => s.number === group.number)?.review !== false
}

/** A group's agents before its loop, and its rounds. */
export function flowOf(group: WorkGroup): { build: AgentNode[]; rounds: RoundView[] } {
  const build = group.agents.filter(a => a.round === undefined)
  const numbers = [...new Set([...group.agents.flatMap(a => (a.round === undefined ? [] : [a.round])), ...(group.rounds ?? []).map(r => r.round)])].sort((a, b) => a - b)
  const last = numbers.at(-1)
  const rounds = numbers.map((number): RoundView => {
    const agents = group.agents.filter(a => a.round === number)
    const later = number !== last
    const open = !later && (agents.some(busy) || group.state === 'running')
    const failed = !later && (group.state === 'failed' || group.state === 'cancelled')
    const result = group.rounds?.find(r => r.round === number)
    const fix = agents.filter(a => !REVIEWING.test(a.action) && !JUDGING.test(a.action))
    const after = group.checks?.after
    const checks = later && fix.length ? 'passed' : after && fix.includes(after) ? group.checks!.state : undefined
    const ends = agents.map(a => a.end).filter((e): e is number => e !== undefined)
    const start = agents.length ? Math.min(...agents.map(a => a.start)) : undefined
    return {
      number,
      state: open ? 'running' : failed ? 'failed' : 'done',
      review: agents.filter(a => REVIEWING.test(a.action)),
      judge: agents.filter(a => JUDGING.test(a.action)),
      fix,
      ...(result ? { result } : {}),
      ...(checks ? { checks } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(!open && ends.length ? { end: Math.max(...ends) } : {}),
    }
  })
  return { build, rounds }
}

const routed = (result: RoundResult | undefined): string | undefined => {
  if (!result) return undefined
  const sent = result.findings.filter(f => f.sent).length
  return `${sent} sent back, ${result.findings.length - sent} kept`
}

const findingsText = (result: RoundResult | undefined): string | undefined => {
  if (!result) return undefined
  if (!result.findings.length) return 'no findings'
  return `${count(result.findings.length, 'finding')}: ${routed(result)}`
}

// --- rows -----------------------------------------------------------------------------------------

interface Col {
  text: string
  tone?: Tone
  /** Fixed width; the one column without takes what is left. */
  width?: number
  right?: boolean
}

const MARK = 4
const TIME = 8

/** A row of columns exactly `width` wide; a column that does not fit next to the flexible one goes. */
function columns(cols: readonly Col[], width: number, selected: boolean): Cell[] {
  const fixed = cols.reduce((n, c) => n + (c.width ?? 0), 0)
  const flex = Math.max(0, width - fixed)
  return cols.map(c => {
    const w = c.width ?? flex
    const body = fit(c.text, Math.max(0, w - (c.width && !c.right ? 1 : 0)))
    return { text: c.right ? body.padStart(w) : body.padEnd(w), tone: c.tone ?? 'base', ...(selected ? { selected: true } : {}) }
  })
}

const mark = (text: string, selected: boolean) => `${selected ? '›' : ' '} ${text}`

/** Marker, name, what it did, its agents, its time; narrow, the middle goes first, then the agents. */
function tableRow(width: number, selected: boolean, marker: string, tone: Tone, name: string, middle: string, agents: string, time: string, nameTone: Tone = 'base'): Cell[] {
  const wide = width >= 96
  const mid = width >= 64
  const middleWidth = wide ? 38 : 28
  const cols: Col[] = [
    { text: mark(marker, selected), tone, width: MARK },
    { text: name, tone: nameTone },
    ...(mid ? [{ text: middle, tone: 'muted' as Tone, width: middleWidth }] : []),
    ...(wide || (width >= 56 && agents) ? [{ text: agents, tone: 'muted' as Tone, width: wide ? 24 : 12 }] : []),
    { text: time, tone: 'muted', width: TIME, right: true },
  ]
  return columns(cols, width, selected)
}

const connector = (width: number): Cell[] => [{ text: pad('  │', width), tone: 'muted' }]
const blank = (width: number): Cell[] => [{ text: ' '.repeat(Math.max(0, width)), tone: 'base' }]

// --- the run's stages -----------------------------------------------------------------------------

function groupMiddle(tree: RunTree, group: WorkGroup, rounds: readonly RoundView[]): string {
  const max = tree.outline?.maxRounds
  if (group.state === 'upcoming') return 'waiting'
  if (group.state === 'skipped') return group.note ?? 'skipped'
  if (group.state === 'running') {
    if (rounds.length) return `round ${rounds.at(-1)!.number}${max ? ` of ${max}` : ''}`
    if (group.checks?.state === 'running') return 'checks'
    return lastOf(group.agents, busy)?.action ?? group.agents.at(-1)?.action ?? ''
  }
  const result = group.outcome ?? group.result
  const turns = rounds.length ? count(rounds.length, 'round') : ''
  return [result, turns].filter(Boolean).join(' · ')
}

function agentsText(agents: readonly AgentNode[], width: number): string {
  if (!agents.length) return ''
  const running = agents.filter(a => a.state === 'running').length
  if (width < 96) return running ? `${running}/${agents.length} running` : count(agents.length, 'agent')
  return `${count(agents.length, 'agent')}${running ? ` · ${running} running` : ''}`
}

function runPage(view: LevelView, selected: string): LevelPage {
  const { tree, trees, now, width, height } = view
  const rows: Cell[][] = []
  const items: LevelItem[] = []
  const worktree = tree.phases.find(p => p.title === 'Worktree')
  const entries: Array<() => void> = []
  if (worktree) {
    const after = tree.groups.map(g => g.start).filter((t): t is number => t !== undefined)
    const last = tree.phases.at(-1) === worktree && tree.status === 'running' && !after.length
    entries.push(() => rows.push(tableRow(width, false, last ? '●' : '✓', last ? 'info' : 'success', 'Worktree', '', '', span(worktree.start, worktree.end ?? (after.length ? Math.min(...after) : undefined), now), last ? 'base' : 'muted')))
  }
  for (const g of tree.groups) {
    const key = groupKey(tree.id, g.key)
    const { rounds } = flowOf(g)
    const name = g.number !== undefined ? `${g.number} ${g.title}` : g.title
    entries.push(() => {
      const chosen = key === selected
      const reached = g.state !== 'upcoming' && g.state !== 'skipped'
      items.push({ key, row: rows.length, ...(reached ? { open: g.agents.length ? { kind: 'group' as const, group: g.key } : { kind: 'detail' as const, key } } : {}) })
      const tone = GROUP_TONES[g.state]
      rows.push(tableRow(width, chosen, GROUP_MARKERS[g.state] || '·', tone, name, groupMiddle(tree, g, rounds), agentsText(g.agents, width), span(g.start, g.end, now), g.state === 'running' ? 'base' : tone === 'muted' ? 'muted' : 'base'))
    })
  }
  const others = trees.length > 1 ? trees.length + 2 : 2
  const roomy = entries.length * 2 - 1 + others <= height
  entries.forEach((draw, i) => {
    if (i && roomy) rows.push(connector(width))
    draw()
  })
  rows.push(blank(width))
  if (trees.length > 1) {
    rows.push([{ text: pad('  runs', width), tone: 'muted' }])
    for (const t of trees) {
      const key = runKey(t.id)
      const chosen = key === selected
      items.push({ key, row: rows.length, ...(t.id === tree.id ? { open: { kind: 'detail' as const, key } } : { run: t.id }) })
      rows.push(columns([{ text: mark(`${t.id.slice(-4)} · ${t.status}${t.id === tree.id ? ' (shown)' : ''}`, chosen), tone: STATUS_TONES[t.status] ?? 'base' }, { text: duration((t.end ?? now) - t.start), tone: 'muted', width: TIME, right: true }], width, chosen))
    }
  } else {
    const key = runKey(tree.id)
    const chosen = key === selected
    items.push({ key, row: rows.length, open: { kind: 'detail', key } })
    rows.push(columns([{ text: mark('run details', chosen), tone: 'muted' }], width, chosen))
  }
  const live = lastOf(tree.groups, g => g.state === 'running') ?? lastOf(tree.groups, g => g.state !== 'upcoming' && g.state !== 'skipped') ?? tree.groups[0]
  return {
    crumbs: runCrumbs(tree, now),
    rows,
    items,
    ...(live ? { preferred: groupKey(tree.id, live.key) } : {}),
    help: ['↑↓ move', 'Enter open', 'Esc close'].join(' · '),
  }
}

// --- a stage's rounds -----------------------------------------------------------------------------

const roundKey = (group: string, n: number) => `round:${group}:${n}`

function groupPage(view: LevelView, group: WorkGroup, selected: string, chain: readonly Screen[]): LevelPage {
  const { tree, now, width, height } = view
  const { build, rounds } = flowOf(group)
  const rows: Cell[][] = []
  const items: LevelItem[] = []
  const loop = isLoop(tree, group)
  const stage = tree.outline?.stages.find(s => s.number === group.number)
  const checksRow = group.number !== undefined && (!!group.checks || stage?.checks === true) && (build.length > 0 || !!group.checks)
  const steps = build.length + (checksRow ? 1 : 0)
  const body = steps * 2 + (loop ? rounds.length + 4 : 0)
  const roomy = body <= height
  const gap = () => {
    if (roomy && rows.length) rows.push(connector(width))
  }
  for (const a of build) {
    gap()
    const key = agentKey(a.session)
    const chosen = key === selected
    items.push({ key, row: rows.length, open: { kind: 'detail', key } })
    rows.push(tableRow(width, chosen, AGENT_MARKERS[a.state], AGENT_TONES[a.state], capital(a.action), shortModel(a.model, a.effort), '1 agent', span(a.start, a.end, now)))
  }
  if (checksRow) {
    gap()
    const state = rounds.length ? 'passed' : group.checks?.state
    const key = checksKey(tree.id, group.number!)
    const chosen = key === selected
    if (group.checks) items.push({ key, row: rows.length, open: { kind: 'detail', key } })
    const text = state === 'failed' && group.checks?.failed.length ? `failed: ${group.checks.failed.join(', ')}` : (state ?? 'after the implementer')
    const tone: Tone = state === 'passed' ? 'success' : state === 'failed' ? 'error' : state === 'running' ? 'info' : 'muted'
    rows.push(tableRow(width, chosen, state === 'passed' ? '✓' : state === 'failed' ? '✗' : state === 'running' ? '●' : '·', tone, 'Checks', text, '', '', state ? 'base' : 'muted'))
  }
  if (loop) {
    gap()
    const max = tree.outline?.maxRounds
    const inner = Math.max(1, width - 4)
    const title = `┌ ↺ review loop${max ? ` · up to ${count(max, 'round')}` : ''} `
    rows.push([{ text: `${fit(title, width - 1)}${'─'.repeat(Math.max(0, width - 1 - title.length))}${width > title.length ? '┐' : ''}`, tone: 'muted' }])
    const boxed = (cells: Cell[]): Cell[] => [{ text: '│ ', tone: 'muted' }, ...cells, { text: ' │', tone: 'muted' }]
    for (const r of rounds) {
      const key = roundKey(group.key, r.number)
      const chosen = key === selected
      items.push({ key, row: rows.length, open: { kind: 'round', group: group.key, round: r.number } })
      const agents = [...r.review, ...r.judge, ...r.fix]
      const middle = findingsText(r.result) ?? (r.state === 'running' ? (r.fix.some(busy) ? 'fixing' : r.judge.some(busy) ? 'judging' : 'reviewing') : '')
      rows.push(boxed(tableRow(inner, chosen, ROUND_MARKS[r.state], ROUND_TONES[r.state], `Round ${r.number}`, middle, agentsText(agents, inner), span(r.start, r.end, now))))
    }
    const finished = group.state !== 'running' && group.state !== 'upcoming'
    const lastRound = rounds.at(-1)?.number ?? 0
    if (!finished && max) {
      const next = lastRound + 1
      const ahead = next < max ? [next, max] : next === max ? [max] : []
      for (const n of ahead) {
        const text = n === max ? 'the last one' : lastRound ? `only if round ${lastRound} sends findings back` : 'after the implementer'
        rows.push(boxed(tableRow(inner, false, '·', 'muted', `Round ${n}`, text, '', '', 'muted')))
      }
    }
    if (!rounds.length && (!max || finished)) rows.push(boxed([{ text: pad('no review round', inner), tone: 'muted' }]))
    rows.push([{ text: `└${'─'.repeat(Math.max(0, width - 2))}┘`, tone: 'muted' }])
  }
  const after = tree.groups[tree.groups.indexOf(group) + 1]
  if (after && !finishedRun(tree)) {
    gap()
    rows.push(tableRow(width, false, '·', 'muted', 'Next', after.number !== undefined ? `${after.number} ${after.title}` : after.title, '', '', 'muted'))
  }
  if (!rows.length) rows.push([{ text: pad('  no agent ran here', width), tone: 'muted' }])
  const preferred = lastOf(rounds, r => r.state === 'running') ?? rounds.at(-1)
  return {
    crumbs: crumbs(view, chain),
    rows,
    items,
    ...(preferred ? { preferred: roundKey(group.key, preferred.number) } : items.length ? { preferred: (items.find(i => build.some(a => agentKey(a.session) === i.key && busy(a))) ?? items.at(-1)!).key } : {}),
    help: ['↑↓ move', 'Enter open', 'l log', 'Esc back'].join(' · '),
  }
}

const finishedRun = (tree: RunTree) => tree.status !== 'running'
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// --- a round's agents -----------------------------------------------------------------------------

const cardName = (a: AgentNode, round: number): string => {
  const tail = a.label.slice(a.label.lastIndexOf(` r${round} `) + ` r${round} `.length)
  if (a.label.lastIndexOf(` r${round} `) >= 0 && tail) return a.action.startsWith('extract') ? `extract ${tail}` : tail
  return a.action
}

const OUTCOME = /^[●…]\s*/

function cardRows(view: LevelView, agents: readonly AgentNode[], round: RoundView, selected: string, items: LevelItem[], base: number, indent: number): Cell[][] {
  const { now, width } = view
  const room = Math.max(CARD_MIN, width - indent)
  const across = Math.max(1, Math.min(MAX_CARDS, Math.floor((room + 2) / (CARD_MIN + 2)), agents.length))
  const each = Math.max(8, Math.floor((room - 2 * (across - 1)) / across))
  const out: Cell[][] = []
  for (let i = 0; i < agents.length; i += across) {
    const line = agents.slice(i, i + across)
    const lines = Array.from({ length: CARD_ROWS }, (): Cell[] => [{ text: ' '.repeat(indent), tone: 'base' }])
    line.forEach((a, j) => {
      const key = agentKey(a.session)
      const chosen = key === selected
      items.push({ key, row: base + out.length + CARD_ROWS - 1, open: { kind: 'detail', key } })
      const found = round.result?.findings.filter(f => f.reviewer !== undefined && a.label.endsWith(` ${f.reviewer}`)).length
      const said = view.activity?.(a)?.replace(OUTCOME, '') ?? a.activity
      const what = busy(a) ? (said ?? shortModel(a.model, a.effort)) : found !== undefined && round.result ? count(found, 'finding') : shortModel(a.model, a.effort)
      const subs = a.subagents.length ? ` · ${count(a.subagents.length, 'subagent')}` : ''
      const tone: Tone = AGENT_TONES[a.state]
      const box = chosen ? 'info' : 'muted'
      const inner = each - 4
      const cell = (text: string, t: Tone): Cell => ({ text, tone: t, ...(chosen ? { selected: true } : {}) })
      if (j) for (const l of lines) l.push({ text: '  ', tone: 'base' })
      lines[0]!.push(cell(`┌${'─'.repeat(each - 2)}┐`, box))
      lines[1]!.push(cell('│ ', box), cell(pad(`${AGENT_MARKERS[a.state]} ${cardName(a, round.number)}  ${span(a.start, a.end, now)}`, inner), tone), cell(' │', box))
      lines[2]!.push(cell('│ ', box), cell(pad(`${what}${subs}`, inner), 'base'), cell(' │', box))
      lines[3]!.push(cell(`└${'─'.repeat(each - 2)}┘`, box))
    })
    out.push(...lines)
  }
  return out
}

function stepAgents(view: LevelView, agents: readonly AgentNode[], title: string, text: string | undefined, selected: string, items: LevelItem[], rows: Cell[][]) {
  agents.forEach((a, i) => {
    const key = agentKey(a.session)
    const chosen = key === selected
    items.push({ key, row: rows.length, open: { kind: 'detail', key } })
    rows.push(tableRow(view.width, chosen, AGENT_MARKERS[a.state], AGENT_TONES[a.state], i ? a.action : title, (i ? undefined : text) ?? shortModel(a.model, a.effort), '', span(a.start, a.end, view.now)))
  })
}

function roundPage(view: LevelView, group: WorkGroup, number: number, selected: string, chain: readonly Screen[]): LevelPage {
  const { tree, width, height } = view
  const { rounds } = flowOf(group)
  const round = rounds.find(r => r.number === number)
  const items: LevelItem[] = []
  const rows: Cell[][] = []
  const max = tree.outline?.maxRounds
  if (!round) return { crumbs: crumbs(view, chain), rows: [[{ text: pad('  no such round', width), tone: 'muted' }]], items, help: 'Esc back' }
  const running = round.review.filter(a => a.state === 'running').length
  const heading = running > 1 ? `${running} agents at the same time` : (findingsText(round.result)?.split(':')[0] ?? count(round.review.length, 'agent'))
  const reviewTone: Tone = round.review.some(busy) ? 'info' : round.review.some(a => a.state === 'failed') ? 'error' : round.review.length ? 'success' : 'muted'
  const reviewMark = round.review.some(busy) ? '●' : round.review.some(a => a.state === 'failed') ? '✗' : round.review.length ? '✓' : '·'
  rows.push(tableRow(width, false, reviewMark, reviewTone, 'Review', heading, '', ''))
  rows.push(...cardRows(view, round.review, round, selected, items, rows.length, MARK))
  const closed = round.state !== 'running'
  const sentNothing = closed && round.fix.length === 0
  const planned = round.review.length ? 1 : 0
  const roomy = planned + rows.length + 8 <= height
  const gap = () => {
    if (roomy) rows.push(connector(width))
  }
  gap()
  if (round.judge.length) stepAgents(view, round.judge, 'Judge', routed(round.result), selected, items, rows)
  else if (!(sentNothing && round.result?.findings.length === 0)) rows.push(tableRow(width, false, '·', 'muted', 'Judge', closed ? (routed(round.result) ?? 'not needed') : 'after the reviewers', '', '', 'muted'))
  if (!sentNothing) {
    gap()
    if (round.fix.length) stepAgents(view, round.fix, 'Fix', undefined, selected, items, rows)
    else rows.push(tableRow(width, false, '·', 'muted', 'Fix', 'only if findings go back', '', '', 'muted'))
    if (round.checks || tree.outline?.stages.find(s => s.number === group.number)?.checks) {
      gap()
      const state = round.checks
      if (state && group.number !== undefined) {
        const key = checksKey(tree.id, group.number)
        const chosen = key === selected
        items.push({ key, row: rows.length, open: { kind: 'detail', key } })
        rows.push(tableRow(width, chosen, state === 'passed' ? '✓' : state === 'failed' ? '✗' : '●', state === 'passed' ? 'success' : state === 'failed' ? 'error' : 'info', 'Checks', state, '', ''))
      } else rows.push(tableRow(width, false, '·', 'muted', 'Checks', 'after the fix', '', '', 'muted'))
    }
  }
  gap()
  const later = rounds.some(r => r.number > number)
  const next = later ? `Round ${number + 1}` : closed ? (group.outcome ?? group.result ?? 'done') : max !== undefined && number >= max ? 'the round cap: no more rounds' : `Round ${number + 1}, or the stage is done`
  rows.push(tableRow(width, false, later ? '↺' : '·', 'muted', 'Next', next, '', '', 'muted'))
  const live = [...round.review, ...round.judge, ...round.fix]
  return {
    crumbs: crumbs(view, chain),
    rows,
    items,
    ...(live.length ? { preferred: agentKey((live.find(busy) ?? live[0]!).session) } : {}),
    help: ['↑↓←→ move', 'Enter open agent', '[ ] other round', ...(round.result?.findings.length ? ['f findings'] : []), 'l log', 'Esc back'].join(' · '),
  }
}

// --- a round's findings ---------------------------------------------------------------------------

const findingKey = (f: FindingView) => `finding:${f.id}`

function findingsPage(view: LevelView, group: WorkGroup, number: number, selected: string, chain: readonly Screen[]): LevelPage {
  const { width } = view
  const { rounds } = flowOf(group)
  const round = rounds.find(r => r.number === number)
  const findings = round?.result?.findings ?? []
  const items: LevelItem[] = []
  const rows: Cell[][] = []
  for (const f of findings) {
    const key = findingKey(f)
    const chosen = key === selected
    const reviewer = f.reviewer ? round!.review.find(a => a.label.endsWith(` ${f.reviewer}`)) : undefined
    items.push({ key, row: rows.length, ...(reviewer ? { open: { kind: 'detail' as const, key: agentKey(reviewer.session) } } : {}) })
    rows.push(columns([
      { text: mark(f.sent ? '↺' : '·', chosen), tone: f.sent ? 'info' : 'warning', width: MARK },
      { text: f.title },
      { text: f.sent ? 'sent back' : 'kept', tone: f.sent ? 'info' : 'warning', width: 10, right: true },
    ], width, chosen))
  }
  const shown = findings.find(f => findingKey(f) === selected) ?? findings[0]
  if (shown) {
    rows.push(blank(width))
    const field = (label: string, text: string | undefined, max = 4) => {
      if (!text) return
      const room = Math.max(8, width - label.length - 2)
      wrap(text.replace(/\s+/g, ' '), room)
        .slice(0, max)
        .forEach((line, i) => rows.push([{ text: i ? '      ' : `${label.padEnd(5)} `, tone: 'muted' }, { text: pad(line, Math.max(0, width - 6)), tone: 'base' }]))
    }
    field('WHERE', shown.file ? `${shown.file}${shown.line !== undefined ? `:${shown.line}` : ''}` : undefined, 1)
    field('SAID', [shown.reviewer, shown.severity].filter(Boolean).join(' ') + (shown.detail ? `: ${shown.detail}` : ''))
    field('JUDGE', [shown.verdict, shown.impact, shown.priority !== undefined ? `priority ${shown.priority}` : undefined].filter(Boolean).join(' · '), 1)
    field('WHY', shown.why ?? shown.reason)
  } else rows.push([{ text: pad('  this round has no findings', width), tone: 'muted' }])
  return { crumbs: crumbs(view, chain), rows, items, ...(findings[0] ? { preferred: findingKey(findings[0]) } : {}), help: ['↑↓ move', 'Enter open the agent that found it', 'Esc back'].join(' · ') }
}

// --- the path at the top --------------------------------------------------------------------------

function runCrumbs(tree: RunTree, now: number): Cell[] {
  return [
    { text: 'granny', tone: 'base' },
    ...(tree.branch ? [{ text: `  ${tree.branch}`, tone: 'base' as Tone }] : []),
    { text: `  ${tree.status === 'running' ? '●' : ''}${tree.status === 'running' ? ' ' : ''}${tree.status}`, tone: STATUS_TONES[tree.status] ?? 'base' },
    { text: ` · ${duration((tree.end ?? now) - tree.start)}`, tone: 'muted' },
  ]
}

function screenName(view: LevelView, screen: Screen): string {
  const { tree } = view
  const max = tree.outline?.maxRounds
  switch (screen.kind) {
    case 'run':
      return 'granny'
    case 'group': {
      const g = tree.groups.find(x => x.key === screen.group)
      return g ? (g.number !== undefined ? `${g.number} ${g.title}` : g.title) : screen.group
    }
    case 'round':
      return `Round ${screen.round}${max ? ` of ${max}` : ''}`
    case 'findings':
      return 'Findings'
    case 'detail':
      return detailName(tree, screen.key, view.subName)
  }
}

function detailName(tree: RunTree, key: string, subName: (name: string) => string = name => name): string {
  if (key.startsWith('agent:')) return tree.agents.find(a => agentKey(a.session) === key)?.action ?? 'agent'
  if (key.startsWith('sub:')) {
    const agent = tree.agents.find(a => a.subagents.some(s => subKey(a.session, s.name) === key))
    const sub = agent?.subagents.find(s => subKey(agent.session, s.name) === key)
    return sub ? subName(sub.name) : 'subagent'
  }
  if (key.startsWith('checks:')) return 'Checks'
  if (key.startsWith('group:')) return 'Log'
  return 'Run details'
}

export function crumbs(view: LevelView, chain: readonly Screen[]): Cell[] {
  const names = chain.map(s => screenName(view, s))
  const parents = names.slice(0, -1).join(' › ')
  return [{ text: `${parents} › `, tone: 'muted' }, { text: names.at(-1) ?? '', tone: 'base' }]
}

// --- moving between levels ------------------------------------------------------------------------

interface Frame {
  screen: Screen
  selected?: string
}

/** The agents of `key`'s round, or else of its group, each followed by its subagents: what Tab goes through. */
export function detailSiblings(tree: RunTree, key: string): string[] {
  const agent = tree.agents.find(a => agentKey(a.session) === key || a.subagents.some(s => subKey(a.session, s.name) === key))
  if (!agent) return []
  const group = tree.groups.find(g => g.key === agent.group)
  const peers = (group?.agents ?? [agent]).filter(a => a.round === agent.round)
  return peers.flatMap(a => [agentKey(a.session), ...a.subagents.map(s => subKey(a.session, s.name))])
}

/** Where a level's Enter, Esc and arrows lead. It holds no run data; each call gets the tree as it is now. */
export class LevelNav {
  private stack: Frame[] = [{ screen: { kind: 'run' } }]
  private page?: LevelPage

  get screen(): Screen {
    return this.stack.at(-1)!.screen
  }

  /** The key the detail shows, on a detail level. */
  get detail(): string | undefined {
    const s = this.screen
    return s.kind === 'detail' ? s.key : undefined
  }

  get selected(): string {
    return this.detail ?? this.stack.at(-1)!.selected ?? ''
  }

  get atRoot(): boolean {
    return this.stack.length === 1
  }

  reset() {
    this.stack = [{ screen: { kind: 'run' } }]
    this.page = undefined
  }

  /** Builds the level on screen and keeps its selection on an item that exists. */
  layout(view: LevelView): LevelPage {
    const frame = this.stack.at(-1)!
    const build = () => this.build(view, frame)
    let page = build()
    if (frame.screen.kind !== 'detail' && !page.items.some(i => i.key === frame.selected)) {
      const next = page.preferred ?? page.items[0]?.key
      if (next !== frame.selected) {
        if (next === undefined) delete frame.selected
        else frame.selected = next
        page = build()
      }
    }
    this.page = page
    return page
  }

  private build(view: LevelView, frame: Frame): LevelPage {
    const { tree } = view
    const { screen } = frame
    const selected = frame.selected ?? ''
    const chain = this.stack.map(f => f.screen)
    const missing = (): LevelPage => ({ crumbs: crumbs(view, chain), rows: [], items: [], help: 'Esc back' })
    switch (screen.kind) {
      case 'run':
        return runPage(view, selected)
      case 'group': {
        const g = tree.groups.find(x => x.key === screen.group)
        return g ? groupPage(view, g, selected, chain) : missing()
      }
      case 'round': {
        const g = tree.groups.find(x => x.key === screen.group)
        return g ? roundPage(view, g, screen.round, selected, chain) : missing()
      }
      case 'findings': {
        const g = tree.groups.find(x => x.key === screen.group)
        return g ? findingsPage(view, g, screen.round, selected, chain) : missing()
      }
      case 'detail':
        return { crumbs: crumbs(view, chain), rows: [], items: [], help: '' }
    }
  }

  move(delta: number) {
    const items = this.page?.items ?? []
    if (!items.length) return
    const frame = this.stack.at(-1)!
    const at = items.findIndex(i => i.key === frame.selected)
    frame.selected = items[Math.max(0, Math.min(items.length - 1, at + delta))]!.key
  }

  edge(last: boolean) {
    const items = this.page?.items ?? []
    const item = last ? items.at(-1) : items[0]
    if (item) this.stack.at(-1)!.selected = item.key
  }

  /** Enter: goes down a level; returns the id of another run to show, when that is what the row is. */
  enter(): { run?: string } {
    const item = this.page?.items.find(i => i.key === this.stack.at(-1)!.selected)
    if (!item) return {}
    if (item.run) return { run: item.run }
    if (item.open) this.push(item.open)
    return {}
  }

  private push(screen: Screen) {
    this.stack.push({ screen })
    this.page = undefined
  }

  /** Esc: goes up a level; false at the top. */
  back(): boolean {
    if (this.stack.length <= 1) return false
    this.stack.pop()
    this.page = undefined
    return true
  }

  /** `[` and `]` on a round: the round before or after it. */
  otherRound(tree: RunTree, dir: 1 | -1) {
    const s = this.screen
    if (s.kind !== 'round') return
    const g = tree.groups.find(x => x.key === s.group)
    const numbers = g ? flowOf(g).rounds.map(r => r.number) : []
    const next = numbers[numbers.indexOf(s.round) + dir]
    if (next === undefined) return
    this.stack[this.stack.length - 1] = { screen: { ...s, round: next } }
    const parent = this.stack.at(-2)
    if (parent) parent.selected = roundKey(s.group, next)
  }

  /** `f` on a round with findings. */
  findings(tree: RunTree) {
    const s = this.screen
    if (s.kind !== 'round') return
    const g = tree.groups.find(x => x.key === s.group)
    if (g?.rounds?.find(r => r.round === s.round)?.findings.length) this.push({ kind: 'findings', group: s.group, round: s.round })
  }

  /** `l` on a stage or round: its journal lines. */
  log(tree: RunTree) {
    const s = this.screen
    if (s.kind === 'group' || s.kind === 'round') this.push({ kind: 'detail', key: groupKey(tree.id, s.group) })
  }

  /** Tab, `]` and `[` in an agent's detail: the next of its round, keeping the level under it on that agent. */
  stepDetail(tree: RunTree, dir: 1 | -1) {
    const key = this.detail
    if (!key) return
    const peers = detailSiblings(tree, key)
    const next = peers[peers.indexOf(key) + dir]
    if (!next) return
    this.stack[this.stack.length - 1] = { screen: { kind: 'detail', key: next } }
    const parent = this.stack.at(-2)
    if (parent && next.startsWith('agent:')) parent.selected = next
  }

  /** Opens the levels down to `key`, an agent or a subagent; false when the tree does not have it. */
  openAt(tree: RunTree, key: string): boolean {
    const agent = tree.agents.find(a => agentKey(a.session) === key || a.subagents.some(s => subKey(a.session, s.name) === key))
    if (!agent) return false
    this.stack = [{ screen: { kind: 'run' }, selected: groupKey(tree.id, agent.group) }]
    this.stack.push({ screen: { kind: 'group', group: agent.group }, ...(agent.round !== undefined ? { selected: roundKey(agent.group, agent.round) } : { selected: agentKey(agent.session) }) })
    if (agent.round !== undefined) this.stack.push({ screen: { kind: 'round', group: agent.group, round: agent.round }, selected: agentKey(agent.session) })
    this.stack.push({ screen: { kind: 'detail', key } })
    this.page = undefined
    return true
  }
}

const HEAD = 2

/** The page's rows exactly `width` × `height`: the path, a blank row, the body scrolled to the selection, the key help. */
export function levelFrame(crumbsRow: readonly Cell[], body: readonly (readonly Cell[])[], help: string, width: number, height: number, selectedRow = 0): Cell[][] {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(3, Math.floor(height))
  const room = Math.max(0, h - HEAD - 1)
  const first = Math.max(0, Math.min(selectedRow - room + 1, Math.max(0, body.length - room)))
  const rows: Cell[][] = [fitRow(crumbsRow, w), fitRow([], w)]
  for (let i = 0; i < room; i++) rows.push(fitRow(body[first + i] ?? [], w))
  rows.push(fitRow([{ text: help, tone: 'muted' }], w))
  return rows
}

/** The rows the body of a `height`-row page has. */
export const levelBody = (height: number) => Math.max(0, Math.floor(height) - HEAD - 1)

/** The selected item's row on `page`. */
export const selectedRow = (page: LevelPage, selected: string) => page.items.find(i => i.key === selected)?.row ?? 0
