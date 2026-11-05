// The run navigator's tree: phases, round/stage groups, agents and their task subagents, built from a
// run's journal entries with the live state of its role processes laid over them.
import { clock, duration } from './format'
import type { RoleActivity } from '../omp/panel'

export interface JournalEntry {
  t?: string
  type: string
  [key: string]: any
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

export interface SubagentNode {
  name: string
  path?: string
}

export interface AgentNode {
  label: string
  role: string
  model?: string
  effort?: string
  session: string
  phase: string
  start: number
  end?: number
  state: AgentState
  activity?: string
  error?: string
  subagents: SubagentNode[]
}

export interface GroupNode {
  title?: string
  agents: AgentNode[]
}

export interface PhaseNode {
  index: number
  title: string
  start: number
  end?: number
  marker: string
  groups: GroupNode[]
  /** Journal lines of the phase, oldest first. */
  lines: string[]
}

export interface RunInfo {
  id: string
  status: string
  startedAt?: number
  endedAt?: number
  reply?: string
}

export interface RunTree {
  id: string
  status: string
  start: number
  end?: number
  phase?: string
  phases: PhaseNode[]
  /** Every agent, in start order. */
  agents: AgentNode[]
}

export type RowKind = 'run' | 'phase' | 'group' | 'agent' | 'sub'

export interface Row {
  key: string
  kind: RowKind
  depth: number
  selectable: boolean
  run: RunTree
  phase?: PhaseNode
  agent?: AgentNode
  sub?: SubagentNode
  title?: string
  folded?: boolean
  /** The key of the node this row hangs under. */
  parent?: string
}

const MAX_PHASE_ENTRIES = 200
const COMMAND_CHARS = 160
const PAD = ' '.repeat(10)

export const AGENT_MARKERS: Record<AgentState, string> = { running: '●', waiting: '…', done: '✓', failed: '✗', cancelled: '⊘' }

const GROUP = /^(?:review|judge|fix|extract)\s+(.+?)\s+r(\d+)\b/
const STAGE = /^implement (.+)$/

/** The round or stage group an agent label belongs to, if any. */
export function groupOf(label: string): string | undefined {
  const round = GROUP.exec(label)
  if (round) return `${round[1]} · round ${round[2]}`
  return STAGE.exec(label)?.[1]
}

const timeOf = (entry: JournalEntry): number | undefined => {
  const t = entry.t ? Date.parse(entry.t) : Number.NaN
  return Number.isNaN(t) ? undefined : t
}

const at = (t: number | undefined, text: string): string[] => {
  const [first, ...rest] = text.replace(/\t/g, '  ').split('\n')
  return [`${clock(t)}  ${first}`, ...rest.map(l => `${PAD}${l}`)]
}

function lastOf<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i]
  return undefined
}

const modelText = (model?: string, effort?: string) => `${model ?? 'default model'}${effort ? `/${effort}` : ''}`

interface PhaseBuild extends PhaseNode {
  entries: string[][]
  byGroup: Map<string, GroupNode>
  agentNodes: AgentNode[]
}

/** Builds the tree of one run; `files` maps an agent's session to its subagent transcripts. */
export function buildRunTree(
  run: RunInfo,
  entries: readonly JournalEntry[],
  live: ReadonlyMap<string, RoleActivity>,
  now: number,
  files: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): RunTree {
  const running = run.status === 'running'
  const phases: PhaseBuild[] = []
  const agents: AgentNode[] = []
  const bySession = new Map<string, AgentNode>()
  const subagentNames = new Map<AgentNode, string[]>()
  const outcomes = new Map<string, { outcome: AgentState; end?: number; error?: string }>()
  const failed = new Map<string, { end?: number; error?: string }>()
  const firstTime = entries.map(timeOf).find(t => t !== undefined)
  const start = run.startedAt ?? firstTime ?? now
  let lastTime = start

  const newPhase = (title: string, t: number): PhaseBuild => {
    const node: PhaseBuild = { index: phases.length, title, start: t, marker: '✓', groups: [], lines: [], entries: [], byGroup: new Map(), agentNodes: [] }
    phases.push(node)
    return node
  }
  const current = (t: number) => phases.at(-1) ?? newPhase('Starting', t)
  const note = (phase: PhaseBuild, lines: string[]) => {
    phase.entries.push(lines)
    if (phase.entries.length > MAX_PHASE_ENTRIES) phase.entries.shift()
  }
  const phaseOf = new Map<AgentNode, PhaseBuild>()
  const noted = new Set<AgentNode>()
  const ended = (session: string, state: AgentState, t: number | undefined) => {
    const agent = bySession.get(session)
    const phase = agent && phaseOf.get(agent)
    if (!agent || !phase || noted.has(agent)) return
    noted.add(agent)
    note(phase, at(t, `■ ${agent.label} ${state}${t === undefined ? '' : ` ${duration(t - agent.start)}`}`))
  }

  for (const entry of entries) {
    const t = timeOf(entry) ?? lastTime
    lastTime = Math.max(lastTime, t)
    switch (entry.type) {
      case 'phase': {
        const title = String(entry.title ?? '')
        if (phases.at(-1)?.title !== title) newPhase(title, t)
        break
      }
      case 'agent': {
        const title = typeof entry.phase === 'string' && entry.phase ? entry.phase : undefined
        const phase = title ? (lastOf(phases, p => p.title === title) ?? newPhase(title, t)) : current(t)
        const agent: AgentNode = {
          label: String(entry.label ?? '?'),
          role: String(entry.role ?? '?'),
          ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
          ...(typeof entry.effort === 'string' ? { effort: entry.effort } : {}),
          session: String(entry.session ?? ''),
          phase: phase.title,
          start: t,
          state: 'waiting',
          subagents: [],
        }
        agents.push(agent)
        bySession.set(agent.session, agent)
        phase.agentNodes.push(agent)
        phaseOf.set(agent, phase)
        const name = groupOf(agent.label)
        const key = name ?? ''
        let group = phase.byGroup.get(key)
        if (!group) {
          group = { ...(name ? { title: name } : {}), agents: [] }
          phase.byGroup.set(key, group)
          phase.groups.push(group)
        }
        group.agents.push(agent)
        note(phase, at(t, `▸ ${agent.label} started (${agent.role} · ${modelText(agent.model, agent.effort)})`))
        break
      }
      case 'agent-end': {
        const outcome = entry.outcome === 'done' || entry.outcome === 'failed' || entry.outcome === 'cancelled' ? entry.outcome : 'failed'
        outcomes.set(String(entry.session), { outcome, end: t, ...(typeof entry.error === 'string' ? { error: entry.error } : {}) })
        ended(String(entry.session), outcome, t)
        break
      }
      case 'agent-failed':
        failed.set(String(entry.session), { end: t, ...(typeof entry.error === 'string' ? { error: entry.error } : {}) })
        ended(String(entry.session), 'failed', t)
        break
      case 'subagent': {
        const agent = lastOf(agents, a => a.label === entry.label)
        if (!agent) break
        const names = subagentNames.get(agent) ?? []
        for (const name of Array.isArray(entry.agents) ? entry.agents : []) if (!names.includes(String(name))) names.push(String(name))
        subagentNames.set(agent, names)
        break
      }
      case 'log':
        note(current(t), at(t, String(entry.message ?? '')))
        break
      case 'command':
        note(current(t), at(t, `$ ${String(entry.command ?? '').split('\n')[0]!.slice(0, COMMAND_CHARS)}`))
        break
      case 'retry':
        note(current(t), at(t, `↻ ${entry.label} retry ${entry.attempt}: ${String(entry.reason ?? '').split('\n')[0]}`))
        break
      case 'provider-error':
        note(current(t), at(t, `! ${entry.label} provider error${entry.backoffMs !== undefined ? ` (retry in ${duration(Number(entry.backoffMs))})` : ''}: ${String(entry.error ?? '').split('\n')[0]}`))
        break
      case 'error':
        note(current(t), at(t, `✗ run failed: ${String(entry.error ?? '')}`))
        break
    }
  }

  const end = running ? undefined : (run.endedAt ?? lastTime)
  for (const agent of agents) {
    const view = live.get(agent.session)
    const recorded = outcomes.get(agent.session)
    const failure = failed.get(agent.session)
    if (recorded) {
      agent.state = recorded.outcome
      agent.end = recorded.end
      if (recorded.error) agent.error = recorded.error
    } else if (failure) {
      agent.state = 'failed'
      agent.end = failure.end
      if (failure.error) agent.error = failure.error
    } else if (view?.outcome) {
      agent.state = view.outcome
      if (view.endedAt !== undefined) agent.end = view.endedAt
      if (view.error) agent.error = view.error
    } else if (running) agent.state = view?.active ? 'running' : 'waiting'
    else {
      agent.state = run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'failed' : 'done'
      agent.end = view?.endedAt ?? end
    }
    if (agent.state === 'running' && view) agent.activity = `${view.state} ${duration(now - view.since)}`
    if (agent.state !== 'running' && agent.state !== 'waiting') ended(agent.session, agent.state, agent.end)
    const names = subagentNames.get(agent)
    if (names) {
      const found = files.get(agent.session)
      agent.subagents = found?.size ? [...found].map(([name, path]) => ({ name, path })) : names.map(name => ({ name }))
    }
  }

  phases.forEach((phase, i) => {
    const next = phases[i + 1]
    phase.end = next ? next.start : end
    const last = i === phases.length - 1
    const states = phase.agentNodes.map(a => a.state)
    if (states.includes('running') || (running && last)) phase.marker = '●'
    else if ((last && run.status === 'cancelled') || states.includes('cancelled')) phase.marker = '⊘'
    else if (states.includes('failed') || (last && run.status === 'failed')) phase.marker = '✗'
    else phase.marker = '✓'
    phase.lines = phase.entries.flat()
  })

  return {
    id: run.id,
    status: run.status,
    start,
    ...(end !== undefined ? { end } : {}),
    ...(phases.length ? { phase: phases.at(-1)!.title } : {}),
    phases: phases.map(({ entries: _e, byGroup: _g, agentNodes: _a, ...phase }) => phase),
    agents,
  }
}

export const runKey = (id: string) => `run:${id}`
export const phaseKey = (id: string, index: number) => `phase:${id}:${index}`
export const agentKey = (session: string) => `agent:${session}`
export const subKey = (session: string, name: string) => `sub:${session}:${name}`

/** The flat list of rows the tree pane draws. */
export function visibleRows(runs: readonly RunTree[], folded: ReadonlySet<string>, expandedRun: string): Row[] {
  const rows: Row[] = []
  for (const run of runs) {
    const rk = runKey(run.id)
    const open = run.id === expandedRun && !folded.has(rk)
    rows.push({ key: rk, kind: 'run', depth: 0, selectable: true, run, folded: !open })
    if (!open) continue
    for (const phase of run.phases) {
      const pk = phaseKey(run.id, phase.index)
      const shut = folded.has(pk)
      rows.push({ key: pk, kind: 'phase', depth: 1, selectable: true, run, phase, folded: shut, parent: rk })
      if (shut) continue
      for (const [g, group] of phase.groups.entries()) {
        const depth = group.title ? 3 : 2
        if (group.title) rows.push({ key: `group:${run.id}:${phase.index}:${g}`, kind: 'group', depth: 2, selectable: false, run, phase, title: group.title, parent: pk })
        for (const agent of group.agents) {
          const ak = agentKey(agent.session)
          rows.push({ key: ak, kind: 'agent', depth, selectable: true, run, phase, agent, parent: pk })
          for (const sub of agent.subagents) rows.push({ key: subKey(agent.session, sub.name), kind: 'sub', depth: depth + 1, selectable: true, run, phase, agent, sub, parent: ak })
        }
      }
    }
  }
  return rows
}

/** The next (`dir` 1) or previous (-1) agent row from `key`, across phases; undefined at the end. */
export function nextAgent(rows: readonly Row[], key: string, dir: 1 | -1): string | undefined {
  const from = rows.findIndex(r => r.key === key)
  let i = from < 0 ? (dir > 0 ? -1 : rows.length) : from
  for (i += dir; i >= 0 && i < rows.length; i += dir) if (rows[i]!.kind === 'agent') return rows[i]!.key
  return undefined
}

const elapsed = (start: number, end: number | undefined, now: number) => duration((end ?? now) - start)

/** A row's plain text; an agent row that would not fit `width` drops the model's provider prefix, then its role and model. */
export function rowText(row: Row, now: number, width = Number.POSITIVE_INFINITY): string {
  const indent = '  '.repeat(row.depth)
  switch (row.kind) {
    case 'run': {
      const { run } = row
      return `${row.folded ? '▸' : '▾'} run ${run.id} · ${run.status} · ${elapsed(run.start, run.end, now)}`
    }
    case 'phase': {
      const phase = row.phase!
      const count = phase.groups.reduce((n, g) => n + g.agents.length, 0)
      return `${indent}${phase.marker} ${phase.title} · ${elapsed(phase.start, phase.end, now)}${row.folded && count ? ` · ${count} agent${count === 1 ? '' : 's'} folded` : ''}`
    }
    case 'group':
      return `${indent}${row.title}`
    case 'agent': {
      const a = row.agent!
      const tail = ` · ${elapsed(a.start, a.end, now)}${a.activity ? ` · ${a.activity}` : ''}`
      const head = `${indent}${AGENT_MARKERS[a.state]} ${a.label}`
      const full = `${head}  ${a.role} · ${modelText(a.model, a.effort)}${tail}`
      if (full.length <= width) return full
      const short = a.model?.includes('/') ? `${head}  ${a.role} · ${modelText(a.model.slice(a.model.lastIndexOf('/') + 1), a.effort)}${tail}` : full
      return short.length <= width ? short : `${head}${tail}`
    }
    case 'sub':
      return `${indent}└ ${row.sub!.name}${row.sub!.path ? '' : ' (no transcript yet)'}`
  }
}
