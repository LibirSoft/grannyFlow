// The run view's details as rows of tone-coloured cells, shared by the omp and opencode navigators: a
// group's lines, the checks, the run, and an agent's head and summary.
import type { AgentEnd, Summary } from './activity'
import { todoText } from './activity'
import { clock, duration, fit, shortModel, stamp } from './format'
import type { AgentNode, AgentState, GroupState, RunTree, WorkGroup } from './tree'

export type Tone = 'base' | 'muted' | 'success' | 'error' | 'warning' | 'info'

export interface Cell {
  text: string
  tone: Tone
  selected?: boolean
}

export const STATUS_TONES: Record<string, Tone> = { running: 'info', done: 'success', failed: 'error', cancelled: 'warning' }
export const AGENT_TONES: Record<AgentState, Tone> = { running: 'info', waiting: 'muted', done: 'success', failed: 'error', cancelled: 'warning' }
const GROUP_TONES: Record<GroupState, Tone> = { upcoming: 'muted', running: 'info', done: 'success', failed: 'error', skipped: 'muted', cancelled: 'warning' }

/** `text` broken into rows of at most `width` at spaces, words longer than a row cut. */
export function wrap(text: string, width: number): string[] {
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

/** A row of cells cut and padded to exactly `width`. */
export function fitRow(cells: readonly Cell[], width: number): Cell[] {
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
