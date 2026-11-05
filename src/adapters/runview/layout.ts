// The run view's page as rows of tone-coloured cells, shared by the omp and opencode navigators: the
// header, the stepper, the tree pane, the details and the frame that puts them side by side.
import type { AgentEnd, Summary } from './activity'
import { todoText } from './activity'
import { clock, duration, fit, pad, shortModel, stamp } from './format'
import { type AgentNode, type AgentState, focusStage, type GroupState, type Row, rowText, type RunTree, type Step, type StepState, type WorkGroup } from './tree'

export type Tone = 'base' | 'muted' | 'success' | 'error' | 'warning' | 'info'

export interface Cell {
  text: string
  tone: Tone
  selected?: boolean
}

export const STATUS_TONES: Record<string, Tone> = { running: 'info', done: 'success', failed: 'error', cancelled: 'warning' }
export const AGENT_TONES: Record<AgentState, Tone> = { running: 'info', waiting: 'muted', done: 'success', failed: 'error', cancelled: 'warning' }
const GROUP_TONES: Record<GroupState, Tone> = { upcoming: 'muted', running: 'info', done: 'success', failed: 'error', skipped: 'muted', cancelled: 'warning' }

const STAGE_PHASES = new Set(['Implement', 'Checks', 'Review'])

/** `granny · <branch> · stage <k>/<n> · <phase> · <elapsed>`, the branch dropped first when it does not fit. */
export function headerText(tree: RunTree, now: number, focus?: number, width = Number.POSITIVE_INFINITY): string {
  const { outline } = tree
  const elapsed = duration((tree.end ?? now) - tree.start)
  const phase = tree.phase ?? 'Starting'
  let middle: string[]
  if (tree.status !== 'running') middle = [tree.status]
  else if (outline?.kind === 'plan') middle = ['planning', phase]
  else if (outline && outline.stages.length && (STAGE_PHASES.has(phase) || tree.running.length)) {
    const total = outline.stages.length
    const k = tree.running.length > 1 ? undefined : (focus ?? tree.running[0] ?? focusStage(tree))
    middle = [tree.running.length > 1 ? `stages ${tree.running.join('+')}/${total}` : `stage ${k ?? 1}/${total}`, phase]
  } else middle = [phase]
  const parts = (branch: boolean) => ['granny', ...(branch && tree.branch ? [tree.branch] : []), ...middle, elapsed].join(' · ')
  const full = parts(true)
  if (full.length <= width) return full
  return fit(parts(false), width)
}

const STEP_MARKS: Record<StepState, string> = { done: '✓', current: '●', failed: '✗', skipped: '⊘', upcoming: '' }
const STEP_TONES: Record<StepState, Tone> = { done: 'success', current: 'info', failed: 'error', skipped: 'muted', upcoming: 'muted' }
const SEPARATOR: Cell = { text: ' › ', tone: 'muted' }

const length = (cells: readonly Cell[]) => cells.reduce((n, c) => n + c.text.length, 0)

/** The steps in one row: `Worktree ✓ › Implement ● › Checks › …`, narrowed to `width`. */
export function stepperCells(steps: readonly Step[], width: number): Cell[] {
  if (!steps.length) return []
  const cell = (s: Step, bare = false): Cell => ({ text: bare ? STEP_MARKS[s.state] : `${s.title}${STEP_MARKS[s.state] ? ` ${STEP_MARKS[s.state]}` : ''}`, tone: STEP_TONES[s.state] })
  const join = (cells: Cell[]) => cells.flatMap((c, i) => (i ? [SEPARATOR, c] : [c]))
  const full = join(steps.map(s => cell(s)))
  if (length(full) <= width) return full
  const lastDone = steps.map(s => s.state).lastIndexOf('done')
  const bare = join(steps.map((s, i) => cell(s, s.state === 'done' && i < lastDone)))
  if (length(bare) <= width) return bare
  let at = steps.findIndex(s => s.state === 'current' || s.state === 'failed')
  if (at < 0) at = lastDone >= 0 ? lastDone : 0
  const s = steps[at]!
  const one = `${s.title}${STEP_MARKS[s.state] ? ` ${STEP_MARKS[s.state]}` : ''} (${at + 1}/${steps.length})`
  return [{ text: fit(one, width), tone: STEP_TONES[s.state] }]
}

/** The tone a tree row is drawn in. */
export function rowTone(row: Row): Tone {
  switch (row.kind) {
    case 'group':
      return GROUP_TONES[row.group!.state]
    case 'agent':
    case 'sub':
      return AGENT_TONES[row.agent!.state]
    case 'checks': {
      const c = row.group!.checks
      return !c ? 'muted' : c.state === 'running' ? 'info' : c.state === 'passed' ? 'success' : 'error'
    }
    case 'label':
      return 'muted'
    case 'run':
      return row.details ? 'muted' : (STATUS_TONES[row.run.status] ?? 'base')
  }
}

/** The tree pane, `height` rows of `width`, scrolled from `top` so the selected row shows. */
export function treeCells(rows: readonly Row[], selectedKey: string, now: number, width: number, height: number, top: number): { cells: Cell[]; top: number } {
  const at = rows.findIndex(r => r.key === selectedKey)
  let first = top
  if (at >= 0) {
    if (at < first) first = at
    if (at >= first + height) first = at - height + 1
  }
  first = Math.max(0, Math.min(first, Math.max(0, rows.length - height)))
  const cells: Cell[] = rows.slice(first, first + Math.max(0, height)).map(row => {
    const chosen = row.key === selectedKey
    return { text: pad(`${chosen ? '›' : ' '} ${rowText(row, now, width - 2)}`, width), tone: rowTone(row), ...(chosen ? { selected: true } : {}) }
  })
  while (cells.length < height) cells.push({ text: pad('', width), tone: 'base' })
  return { cells, top: first }
}

/** `text` broken into rows of at most `width` at spaces, words longer than a row cut. */
function wrap(text: string, width: number): string[] {
  if (width < 1) return []
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width) line = next
    else {
      if (line) out.push(line)
      line = word.length > width ? fit(word, width) : word
    }
  }
  if (line || !out.length) out.push(line)
  return out
}

const took = (start: number | undefined, end: number | undefined, now: number) => (start === undefined ? '' : duration((end ?? now) - start))

const checksText = (c: NonNullable<WorkGroup['checks']>) => (c.state === 'running' ? 'checks running' : c.state === 'passed' ? 'checks ✓' : `checks ✗${c.failed.length ? ` ${c.failed.join(', ')}` : ''}`)
const checksTone = (c: NonNullable<WorkGroup['checks']>): Tone => (c.state === 'running' ? 'info' : c.state === 'passed' ? 'success' : 'error')

/** A work group: its full name, state, time and outcome, the checks result, then its journal lines. */
export function groupDetail(tree: RunTree, group: WorkGroup, now: number, width: number): Cell[] {
  const total = tree.outline?.stages.length
  const name = group.number !== undefined ? `stage ${group.number}${total ? `/${total}` : ''} · ${group.title}` : group.title
  const out: Cell[] = wrap(name, width).map(text => ({ text, tone: 'base' }))
  out.push({ text: [group.state, took(group.start, group.end, now), group.outcome, group.note].filter(Boolean).join(' · '), tone: GROUP_TONES[group.state] })
  if (group.checks) out.push({ text: checksText(group.checks), tone: checksTone(group.checks) })
  if (group.lines.length) out.push({ text: '', tone: 'base' }, ...group.lines.map((text): Cell => ({ text, tone: 'base' })))
  return out
}

/** A stage's checks row: how they ended and the check lines of the journal. */
export function checksDetail(group: WorkGroup): Cell[] {
  const head: Cell = { text: `checks · ${group.number !== undefined ? `stage ${group.number} · ` : ''}${group.title}`, tone: 'base' }
  const c = group.checks
  if (!c) return [head, { text: 'no checks result yet', tone: 'muted' }]
  return [head, { text: checksText(c), tone: checksTone(c) }, ...c.lines.map((text): Cell => ({ text, tone: 'base' }))]
}

export interface RunFacts {
  repo?: string
  dir?: string
  error?: string
  reply?: string
}

/** The run row's detail: the only place with the run id. */
export function runDetail(tree: RunTree, facts: RunFacts = {}): Cell[] {
  const out: Cell[] = [
    { text: `run ${tree.id}`, tone: 'base' },
    { text: `status   ${tree.status}`, tone: STATUS_TONES[tree.status] ?? 'base' },
  ]
  if (facts.repo) out.push({ text: `repo     ${facts.repo}`, tone: 'muted' })
  if (tree.branch) out.push({ text: `branch   ${tree.branch}`, tone: 'muted' })
  out.push({ text: `started  ${stamp(tree.start) ?? '?'}`, tone: 'muted' })
  if (tree.status === 'running') out.push({ text: `phase    ${tree.phase ?? 'Starting'}`, tone: 'muted' })
  else out.push({ text: `ended    ${stamp(tree.end) ?? '?'}`, tone: 'muted' })
  if (facts.dir) out.push({ text: `result   ${facts.dir.replace(/\/+$/, '')}/result.json`, tone: 'muted' })
  if (facts.error) out.push({ text: `error: ${facts.error.split('\n')[0]}`, tone: 'error' })
  if (facts.reply) out.push({ text: '', tone: 'base' }, ...facts.reply.split('\n').map((text): Cell => ({ text, tone: 'base' })))
  return out
}

const OUTCOME_MARKS: Partial<Record<AgentState, string>> = { done: '✓', failed: '✗', cancelled: '⊘' }

/** An agent's first lines: `<role> · <model> · <time>`, its failure, and a session not linked to its parent. */
export function agentHead(agent: AgentNode, now: number, live: { linked?: boolean } = {}): Cell[] {
  const mark = OUTCOME_MARKS[agent.state]
  const time = `${mark ? `${mark} ` : ''}${duration((agent.end ?? now) - agent.start)}`
  const out: Cell[] = [{ text: `${agent.role} · ${shortModel(agent.model, agent.effort)} · ${time}`, tone: 'base' }]
  if (agent.state === 'failed' && agent.error) out.push({ text: `! ${agent.error.split('\n')[0]}`, tone: 'error' })
  if ((live.linked ?? agent.linked) === false) out.push({ text: '! not linked to the parent session - it is in the session list', tone: 'warning' })
  return out
}

/** How an agent ended, for the summary's NOW line; undefined while it runs. */
export function agentEnd(agent: AgentNode): AgentEnd | undefined {
  if (agent.state === 'running' || agent.state === 'waiting') return undefined
  return { state: agent.state, start: agent.start, ...(agent.end !== undefined ? { end: agent.end } : {}), ...(agent.error ? { error: agent.error } : {}) }
}

const LABEL = 6
const SAID = 'LAST SAID  '

/** NOW, TODO, RECENT and LAST SAID as rows of at most `width`; with `height`, RECENT gives way so the rest stays on screen. */
export function summaryCells(summary: Summary, width: number, height?: number): Cell[] {
  const indent = ' '.repeat(LABEL)
  const top: Cell[] = []
  if (summary.now) {
    top.push({ text: fit(`${'NOW'.padEnd(LABEL)}${summary.now.text}`, width), tone: summary.now.tone })
    if (summary.now.detail) top.push({ text: fit(`${indent}${summary.now.detail}`, width), tone: 'base' })
    if (summary.now.heading) top.push({ text: fit(`${indent}» ${summary.now.heading}`, width), tone: 'muted' })
  }
  if (summary.todo?.length) {
    if (top.length) top.push({ text: '', tone: 'base' })
    top.push({ text: fit(`${'TODO'.padEnd(LABEL)}${todoText(summary.todo)}`, width), tone: 'base' })
  }
  const bottom: Cell[] = []
  if (summary.lastSaid) {
    const room = Math.max(1, width - SAID.length)
    const quoted = `"${summary.lastSaid}"`
    const [first = '', second, ...more] = wrap(quoted, room)
    bottom.push({ text: '', tone: 'base' }, { text: fit(`${SAID}${first}`, width), tone: 'base' })
    if (second !== undefined) {
      const last = more.length ? `${fit(`${second} ${more.join(' ')}`, Math.max(1, room - 1))}"` : second
      bottom.push({ text: fit(`${' '.repeat(SAID.length)}${last}`, width), tone: 'base' })
    }
  }
  const recent: Cell[] = summary.recent.map(r => ({ text: fit(` ${clock(r.t)}  ${r.tool ? `${r.tool.padEnd(LABEL)} ` : ''}${r.text}`, width), tone: r.tone }))
  const head: Cell[] = recent.length ? [...(top.length ? [{ text: '', tone: 'base' as Tone }] : []), { text: 'RECENT', tone: 'muted' }] : []
  if (height === undefined) return [...top, ...head, ...recent, ...bottom]
  const room = Math.max(0, height - top.length - bottom.length - head.length)
  const shown = room > 0 ? [...head, ...recent.slice(0, room)] : []
  return [...top, ...shown, ...bottom].slice(0, Math.max(0, height))
}

export interface FrameInput {
  header: Cell[]
  stepper: Cell[]
  left: Cell[]
  right?: Cell[]
  help: Cell[]
  width: number
  height: number
  /** Below 100 columns: how many rows of `right` show under `left` (default none). */
  split?: number
}

export interface PaneSizes {
  two: boolean
  rules: boolean
  body: number
  left: { width: number; height: number }
  right: { width: number; height: number }
}

const WIDE = 100
const RULES_FROM = 16
const PANE_SEPARATOR = ' │ '
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** How the page splits `width` × `height` into the tree and detail panes. */
export function paneSizes(width: number, height: number, split = 0, right = true): PaneSizes {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(3, Math.floor(height))
  const rules = h >= RULES_FROM
  const body = Math.max(0, h - 3 - (rules ? 2 : 0))
  if (right && w >= WIDE) {
    const tree = clamp(Math.round(w * 0.38), 36, 60)
    return { two: true, rules, body, left: { width: tree, height: body }, right: { width: w - tree - PANE_SEPARATOR.length, height: body } }
  }
  const lower = right ? Math.min(Math.max(0, split), Math.max(0, body - 1)) : 0
  return { two: false, rules, body, left: { width: w, height: body - lower }, right: { width: w, height: lower } }
}

/** A row of cells cut and padded to exactly `width`. */
function fitRow(cells: readonly Cell[], width: number): Cell[] {
  const out: Cell[] = []
  let used = 0
  for (const c of cells) {
    if (used >= width) break
    const text = fit(c.text, width - used)
    out.push({ ...c, text })
    used += text.length
  }
  const last = out.at(-1)
  if (used < width) {
    if (last) last.text = last.text.padEnd(last.text.length + width - used)
    else out.push({ text: ' '.repeat(width), tone: 'base' })
  }
  return out
}

/** The whole page: header, stepper, rules from 16 rows, the panes side by side or stacked, and the key help last. */
export function frame(input: FrameInput): Cell[][] {
  const w = Math.max(1, Math.floor(input.width))
  const sizes = paneSizes(w, input.height, input.split, input.right !== undefined)
  const paneRows = (cells: readonly Cell[] | undefined, width: number, height: number): Cell[] =>
    Array.from({ length: height }, (_, i) => {
      const c = cells?.[i]
      return c ? { ...c, text: pad(c.text, width) } : { text: ' '.repeat(width), tone: 'base' }
    })
  const rule = (joint: string): Cell[] => [{ text: sizes.two ? `${'─'.repeat(sizes.left.width)}─${joint}─${'─'.repeat(sizes.right.width)}` : '─'.repeat(w), tone: 'muted' }]
  const rows: Cell[][] = [fitRow(input.header, w), fitRow(input.stepper, w)]
  if (sizes.rules) rows.push(rule('┬'))
  if (sizes.two) {
    const left = paneRows(input.left, sizes.left.width, sizes.body)
    const right = paneRows(input.right, sizes.right.width, sizes.body)
    for (let i = 0; i < sizes.body; i++) rows.push([left[i]!, { text: PANE_SEPARATOR, tone: 'muted' }, right[i]!])
  } else {
    for (const c of paneRows(input.left, w, sizes.left.height)) rows.push([c])
    for (const c of paneRows(input.right, w, sizes.right.height)) rows.push([c])
  }
  if (sizes.rules) rows.push(rule('┴'))
  rows.push(fitRow(input.help, w))
  return rows
}
