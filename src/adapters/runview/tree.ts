// A granny run as a tree, built from the run's journal entries with what the host knows live about each
// role laid over them: work groups (plan, plan review, each stage, final review, PR ready) with their agents,
// checks, round results and task subagents, and the older phase tree.
import { clean, clock, duration } from './format'
import type { RunOutline } from './outline'

export interface JournalEntry {
  t?: string
  type: string
  [key: string]: any
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

/** What a host knows live about a role session; the activity shows only with both `state` and `since`. */
export interface LiveView {
  active: boolean
  state?: string
  since?: number
  outcome?: AgentState
  endedAt?: number
  error?: string
}

export interface SubagentNode {
  name: string
  path?: string
}

export interface AgentNote {
  t: number
  text: string
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
  /** The label without its subject: `implement`, `review r1`, `commit #2`. */
  action: string
  /** The key of the work group it belongs to. */
  group: string
  /** The review round it worked in; none before the loop. */
  round?: number
  cwd?: string
  /** Its retries, provider errors, failure and failed link, from the journal. */
  notes: AgentNote[]
  linked?: boolean
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
  branch?: string
}

/** One finding of a round, from the journal's `round` entries. */
export interface FindingView {
  id: string
  sent: boolean
  severity?: string
  title: string
  file?: string
  line?: number
  reviewer?: string
  detail?: string
  verdict?: string
  impact?: string
  priority?: number
  reason?: string
  why?: string
}

export interface RoundResult {
  round: number
  findings: FindingView[]
}

export type GroupState = 'upcoming' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export interface ChecksNode {
  state: 'running' | 'passed' | 'failed'
  failed: string[]
  lines: string[]
  /** The agent the checks ran after; the checks row follows it. */
  after?: AgentNode
  t: number
}

export interface WorkGroup {
  /** `plan`, `plan-review`, `stage:<n>`, `final-review`, `pr-ready`, `other:<phase>`; in a judge run `review`, `tag` or `report`. */
  key: string
  title: string
  number?: number
  state: GroupState
  outcome?: string
  /** How the stage ended, also when it went well; `outcome` only says so when it did not. */
  result?: string
  /** How each review round was routed. */
  rounds?: RoundResult[]
  note?: string
  start?: number
  end?: number
  agents: AgentNode[]
  checks?: ChecksNode
  lines: string[]
}

export interface RunTree {
  id: string
  status: string
  start: number
  end?: number
  phase?: string
  branch?: string
  outline?: RunOutline
  phases: PhaseNode[]
  /** Every agent, in start order. */
  agents: AgentNode[]
  groups: WorkGroup[]
  /** The numbers of the stages running now, oldest start first. */
  running: number[]
}

export type PhaseRowKind = 'run' | 'phase' | 'group' | 'agent' | 'sub'

export interface PhaseRow {
  key: string
  kind: PhaseRowKind
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

function roundOf(label: string): string | undefined {
  const round = GROUP.exec(label)
  if (round) return `${round[1]} · round ${round[2]}`
  return STAGE.exec(label)?.[1]
}

const timeOf = (entry: JournalEntry): number | undefined => {
  const t = entry.t ? Date.parse(entry.t) : Number.NaN
  return Number.isNaN(t) ? undefined : t
}

const at = (t: number | undefined, text: string): string[] => {
  const [first, ...rest] = clean(text).split('\n')
  return [`${clock(t)}  ${first}`, ...rest.map(l => `${PAD}${l}`)]
}

export function lastOf<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i]
  return undefined
}

const modelText = (model?: string, effort?: string) => `${model ?? 'default model'}${effort ? `/${effort}` : ''}`

/** A journalled model: omp's string, or opencode's `{ providerID, id, variant? }` as `provider/id[#variant]`. */
function modelOf(model: unknown): string | undefined {
  if (typeof model === 'string') return model
  if (!model || typeof model !== 'object') return undefined
  const { providerID, id, variant } = model as Record<string, unknown>
  if (typeof providerID !== 'string' || typeof id !== 'string') return undefined
  return `${providerID}/${id}${typeof variant === 'string' && variant ? `#${variant}` : ''}`
}

interface PhaseBuild extends PhaseNode {
  entries: string[][]
  byGroup: Map<string, GroupNode>
  agentNodes: AgentNode[]
}

/** Builds the tree of one run; `files` maps an agent's session to its subagent transcripts. */
export function buildRunTree(
  run: RunInfo,
  entries: readonly JournalEntry[],
  live: ReadonlyMap<string, LiveView>,
  now: number,
  files: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
  outline?: RunOutline,
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
  const phaseFor = (entry: JournalEntry, t: number) => {
    const title = typeof entry.phase === 'string' && entry.phase ? entry.phase : undefined
    return title ? (lastOf(phases, p => p.title === title) ?? newPhase(title, t)) : current(t)
  }
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
        const phase = phaseFor(entry, t)
        const raw = modelOf(entry.model)
        const model = raw === undefined ? undefined : clean(raw)
        const agent: AgentNode = {
          label: clean(String(entry.label ?? '?')),
          role: clean(String(entry.role ?? '?')),
          ...(model ? { model } : {}),
          ...(typeof entry.effort === 'string' ? { effort: clean(entry.effort) } : {}),
          session: String(entry.session ?? ''),
          phase: phase.title,
          start: t,
          state: 'waiting',
          subagents: [],
          action: clean(String(entry.label ?? '?')),
          group: '',
          ...(typeof entry.cwd === 'string' && entry.cwd ? { cwd: clean(entry.cwd) } : {}),
          notes: [],
          ...(typeof entry.linked === 'boolean' ? { linked: entry.linked } : {}),
        }
        agents.push(agent)
        bySession.set(agent.session, agent)
        phase.agentNodes.push(agent)
        phaseOf.set(agent, phase)
        const name = roundOf(agent.label)
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
        outcomes.set(String(entry.session), { outcome, end: t, ...(typeof entry.error === 'string' ? { error: clean(entry.error) } : {}) })
        ended(String(entry.session), outcome, t)
        break
      }
      case 'agent-failed':
        failed.set(String(entry.session), { end: t, ...(typeof entry.error === 'string' ? { error: clean(entry.error) } : {}) })
        ended(String(entry.session), 'failed', t)
        break
      case 'subagent': {
        const agent = lastOf(agents, a => a.label === clean(String(entry.label ?? '?')))
        if (!agent) break
        const names = subagentNames.get(agent) ?? []
        for (const name of Array.isArray(entry.agents) ? entry.agents : []) if (!names.includes(clean(String(name)))) names.push(clean(String(name)))
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
      case 'link-failed':
        note(phaseFor(entry, t), at(t, `! ${entry.label}: not linked to the parent session (${String(entry.error ?? '').split('\n')[0]})`))
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
      if (view.error) agent.error = clean(view.error)
    } else if (running) agent.state = view?.active ? 'running' : 'waiting'
    else {
      agent.state = run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'failed' : 'done'
      agent.end = view?.endedAt ?? end
    }
    if (agent.state === 'running' && view?.state !== undefined && view.since !== undefined) agent.activity = `${view.state} ${duration(now - view.since)}`
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

  const tree: RunTree = {
    id: run.id,
    status: run.status,
    start,
    ...(end !== undefined ? { end } : {}),
    ...(phases.length ? { phase: phases.at(-1)!.title } : {}),
    ...(run.branch ?? outline?.branch ? { branch: clean(run.branch ?? outline!.branch) } : {}),
    ...(outline ? { outline } : {}),
    phases: phases.map(({ entries: _e, byGroup: _g, agentNodes: _a, ...phase }) => phase),
    agents,
    groups: [],
    running: [],
  }
  workGroups(tree, entries, now)
  return tree
}

// --- work groups ----------------------------------------------------------------------------------

export interface StageName {
  number: number
  name: string
}

export interface Placement {
  group: string
  action: string
  round?: number
}

const VERBS = ['resolve merge', 'implement', 'commit', 'repair', 'review', 'judge', 'fix', 'extract'] as const
type Verb = (typeof VERBS)[number]
const AT = '(?:implement|fix r\\d+|final)'
const SHAPES: Record<Verb, RegExp> = {
  'resolve merge': /^$/,
  implement: /^$/,
  commit: new RegExp(`^${AT}(?: (#\\d+))?$`),
  repair: new RegExp(`^${AT} (#\\d+)$`),
  review: /^(r\d+) (\S+)((?: #\d+)?(?: wait \d+| read| stop)?)$/,
  judge: /^(r\d+)((?: retry)?)$/,
  fix: /^(r\d+)$/,
  extract: /^(r\d+) (\S+)((?: retry)?)$/,
}

function actionOf(verb: Verb, rest: string, reviewers: number | undefined): string | undefined {
  const m = SHAPES[verb].exec(rest)
  if (!m) return undefined
  switch (verb) {
    case 'commit':
    case 'repair':
      return m[1] ? `${verb} ${m[1]}` : verb
    case 'review':
      return `review ${m[1]}${reviewers === 1 ? '' : ` ${m[2]}`}${m[3]}`
    case 'judge':
      return `judge ${m[1]}${m[2]}`
    case 'fix':
      return `fix ${m[1]}`
    case 'extract':
      return `extract ${m[1]} ${m[2]}${m[3]}`
    default:
      return verb
  }
}

/** The review round in what follows a label's subject: `r2 terra`, `fix r1 #2`. */
function roundIn(rest: string): { round?: number } {
  const n = /^(?:fix )?r(\d+)\b/.exec(rest)?.[1]
  return n === undefined ? {} : { round: Number(n) }
}

const SUBJECTS: Array<[string, string]> = [
  ['plan review', 'plan-review'],
  ['final review', 'final-review'],
]

/**
 * The work group of an agent label and its action without the subject. `stages` are matched longest name
 * first; `pick` chooses among stages that share a name. `reviewers` drops the reviewer from `review r1 <name>`
 * when the run has exactly one.
 */
export function placeOf(label: string, stages: readonly StageName[], reviewers?: number, pick: (numbers: number[]) => number = n => n[0]!): Placement | undefined {
  if (label === 'plan') return { group: 'plan', action: 'plan' }
  if (label === 'pr-ready check' || label.startsWith('pr-ready check ')) return { group: 'pr-ready', action: label }
  const subjects: Array<[string, string | number[]]> = [
    ...SUBJECTS.map(([name, group]): [string, string] => [name, group]),
    ...[...new Set(stages.map(s => s.name))].map((name): [string, number[]] => [name, stages.filter(s => s.name === name).map(s => s.number).sort((a, b) => a - b)]),
  ].sort((a, b) => b[0].length - a[0].length)
  for (const verb of VERBS) {
    if (!label.startsWith(`${verb} `)) continue
    const tail = label.slice(verb.length + 1)
    for (const [name, target] of subjects) {
      if (tail !== name && !tail.startsWith(`${name} `)) continue
      const rest = tail.slice(name.length + 1)
      if (typeof target === 'string') {
        const plain = actionOf(verb, rest, reviewers)
        const inRepo = rest.replace(/^\S+ /, '')
        const action = plain ?? (target === 'final-review' ? actionOf(verb, inRepo, reviewers) : undefined)
        if (action) return { group: target, action, ...roundIn(plain ? rest : inRepo) }
        continue
      }
      const action = actionOf(verb, rest, reviewers)
      if (action) return { group: `stage:${pick(target)}`, action, ...roundIn(rest) }
    }
  }
  return undefined
}

const FIXED_GROUPS: Record<string, string> = { plan: 'Plan', 'plan-review': 'Plan review', 'final-review': 'Final review', 'pr-ready': 'PR ready', review: 'Review', tag: 'Tag', report: 'Report' }
const PHASE_GROUPS: Record<string, string> = { Plan: 'plan', 'Plan review': 'plan-review', 'Final review': 'final-review', 'PR ready': 'pr-ready' }
// `Judge` and `Report` are what journals written before the rename to `Tagging` and `Save report` carry.
const JUDGE_PHASE_GROUPS: Record<string, string> = { Review: 'review', Tagging: 'tag', 'Save report': 'report', Judge: 'tag', Report: 'report' }
const JUDGE_RANKS: Record<string, number> = { review: 0, tag: 1, report: 2 }
const DONE_OUTCOMES = new Set(['clean', 'residual-only', 'review-skipped'])
const MAX_GROUP_LINES = 200
const MAX_CHECK_LINES = 50
const BUSY = new Set<AgentState>(['running', 'waiting'])

const rankOf = (key: string, number?: number) =>
  JUDGE_RANKS[key] ?? (key === 'plan' ? 0 : key === 'plan-review' ? 1 : number !== undefined ? 2 + number / 1e6 : key === 'final-review' ? 3 : key === 'pr-ready' ? 4 : 5)

const stageNumber = (key: string) => (key.startsWith('stage:') ? Number(key.slice('stage:'.length)) : undefined)

/** The stage names of a run: its outline's and its `stage` entries', else those its `implement <name>` labels give. */
function stageNames(entries: readonly JournalEntry[], outline?: RunOutline): StageName[] {
  const names = new Map<number, string>()
  for (const st of outline?.stages ?? []) names.set(st.number, st.name)
  for (const e of entries) if (e.type === 'stage' && typeof e.number === 'number' && typeof e.name === 'string' && !names.has(e.number)) names.set(e.number, clean(e.name))
  if (!names.size) {
    for (const e of entries) {
      const m = e.type === 'agent' ? STAGE.exec(clean(String(e.label ?? ''))) : null
      if (m && ![...names.values()].includes(m[1]!)) names.set(names.size + 1, m[1]!)
    }
  }
  return [...names].map(([number, name]) => ({ number, name })).sort((a, b) => a.number - b.number)
}

/** A judge run's agent: its group is its phase's, its action the label without the branch. */
function judgePlace(agent: AgentNode, reviewers: number | undefined): Placement {
  const tag = /^tag \S+( retry)?$/.exec(agent.label)
  const review = /^(review|extract) \S+ (r\d+ .+)$/.exec(agent.label)
  return {
    group: JUDGE_PHASE_GROUPS[agent.phase] ?? `other:${agent.phase}`,
    action: tag ? `tag${tag[1] ?? ''}` : review ? (actionOf(review[1] as Verb, review[2]!, reviewers) ?? agent.label) : agent.label,
  }
}

interface StageMark {
  start?: number
  end?: number
  outcome?: string
}

interface ChecksEvent {
  kind: 'batch' | 'other'
}

function workGroups(tree: RunTree, entries: readonly JournalEntry[], now: number) {
  const { outline } = tree
  const stages = stageNames(entries, outline)
  const reviewers = outline?.reviewers.length
  const groups = new Map<string, WorkGroup>()
  const ensure = (key: string, number?: number): WorkGroup => {
    let g = groups.get(key)
    if (!g) {
      const title = number !== undefined ? (stages.find(s => s.number === number)?.name ?? `stage ${number}`) : (FIXED_GROUPS[key] ?? key.slice('other:'.length))
      g = { key, title, ...(number !== undefined ? { number } : {}), state: 'upcoming', agents: [], lines: [] }
      groups.set(key, g)
    }
    return g
  }
  const judging = outline?.kind === 'judge'
  const phaseGroups = judging ? JUDGE_PHASE_GROUPS : PHASE_GROUPS
  if (judging) for (const key of Object.values(JUDGE_PHASE_GROUPS)) ensure(key)
  if (outline?.kind === 'plan') ensure('plan')
  if (outline?.planReview) ensure('plan-review')
  for (const st of stages) ensure(`stage:${st.number}`, st.number)
  if (outline?.finalReview) ensure('final-review')
  if (outline?.kind === 'implement') ensure('pr-ready')

  const marks = new Map<number, StageMark>()
  const reached = new Set<string>()
  const pendingLinks = new Map<string, AgentNote[]>()
  const lastChecks = new Map<number, ChecksEvent>()
  const byLabel = (label: string) => lastOf(tree.agents, a => a.label === label)
  const runningNow = () => [...marks].filter(([, m]) => m.start !== undefined && m.end === undefined).map(([n]) => n)
  const pick = (numbers: number[]) => numbers.find(n => marks.get(n)?.end === undefined) ?? numbers[0]!
  const timed = new Map<WorkGroup, Array<{ t: number; text: string }>>()
  const push = (g: WorkGroup, t: number | undefined, text: string) => {
    const list = timed.get(g) ?? []
    list.push({ t: t ?? Number.POSITIVE_INFINITY, text })
    timed.set(g, list)
  }
  const checkLines = new Map<WorkGroup, Array<{ t: number; text: string }>>()
  const note = (agent: AgentNode | undefined, t: number, text: string) => {
    if (agent) agent.notes.push({ t, text: clean(text) })
  }
  const named = [...stages].sort((a, b) => b.name.length - a.name.length)
  const logGroup = (message: string): { group: WorkGroup; rest?: string } | undefined => {
    for (const st of named) {
      if (!message.startsWith(st.name)) continue
      const after = message.slice(st.name.length)
      if (!after.startsWith(':') && !ROUND.test(after)) continue
      const n = pick(stages.filter(s => s.name === st.name).map(s => s.number))
      return { group: ensure(`stage:${n}`, n), ...(after.startsWith(':') ? { rest: after.slice(1).trimStart() } : {}) }
    }
    if (message.startsWith('plan review')) return outline && !outline.planReview ? undefined : { group: ensure('plan-review'), rest: message }
    if (message.startsWith('final review')) return { group: ensure('final-review'), rest: message }
    if (message.startsWith('plan:')) return { group: ensure('plan'), rest: message }
    if (message.startsWith('pr-ready check')) return { group: ensure('pr-ready'), rest: message }
    return undefined
  }
  let agentIndex = 0
  let lastTime = tree.start
  let judgePhase: string | undefined
  for (const entry of entries) {
    const t = (entry.t ? Date.parse(entry.t) : Number.NaN) || lastTime
    lastTime = Math.max(lastTime, t)
    switch (entry.type) {
      case 'stage': {
        const n = Number(entry.number)
        if (!Number.isInteger(n)) break
        const mark = marks.get(n) ?? {}
        if (entry.event === 'start') mark.start = t
        else if (entry.event === 'end') {
          mark.end = t
          if (typeof entry.outcome === 'string') mark.outcome = clean(entry.outcome)
        }
        marks.set(n, mark)
        ensure(`stage:${n}`, n)
        break
      }
      case 'phase': {
        const title = String(entry.title ?? '')
        const key = phaseGroups[title]
        if (key) {
          judgePhase = key
          reached.add(key)
          const g = ensure(key)
          g.start ??= t
        }
        if (title === 'Checks') {
          const run = runningNow()
          const n = run.length === 1 ? run[0] : !marks.size ? stageNumber(lastOf(tree.agents.slice(0, agentIndex), a => a.group.startsWith('stage:'))?.group ?? '') : undefined
          if (n !== undefined) {
            const g = ensure(`stage:${n}`, n)
            g.checks = { state: 'running', failed: [], lines: g.checks?.lines ?? [], t }
            lastChecks.set(n, { kind: 'other' })
          }
        }
        break
      }
      case 'agent': {
        const agent = tree.agents[agentIndex++]
        if (!agent) break
        const placed = judging ? judgePlace(agent, reviewers) : placeOf(agent.label, stages, reviewers, pick)
        const run = runningNow()
        const group = placed?.group ?? (run.length === 1 ? `stage:${run[0]}` : `other:${agent.phase}`)
        agent.group = group
        agent.action = placed?.action ?? agent.label
        if (placed?.round !== undefined) agent.round = placed.round
        const g = ensure(group, stageNumber(group))
        if (g.number !== undefined && lastChecks.get(g.number)?.kind === 'batch') {
          g.checks = { state: 'running', failed: [], lines: g.checks?.lines ?? [], t: agent.start }
          lastChecks.set(g.number, { kind: 'other' })
        }
        g.agents.push(agent)
        push(g, agent.start, `▸ ${agent.action} started`)
        for (const n of pendingLinks.get(agent.label) ?? []) agent.notes.push(n)
        pendingLinks.delete(agent.label)
        break
      }
      case 'round': {
        const round = Number(entry.round)
        const found = Number.isInteger(round) ? logGroup(`${clean(String(entry.subject ?? ''))} r${round}`) : undefined
        if (!found) break
        const results = (found.group.rounds ??= [])
        const result = { round, findings: findingViews(entry.findings) }
        const at = results.findIndex(r => r.round === round)
        if (at >= 0) results[at] = result
        else results.push(result)
        break
      }
      case 'retry':
        note(byLabel(clean(String(entry.label ?? ''))), t, `↻ retry ${entry.attempt}: ${String(entry.reason ?? '').split('\n')[0]}`)
        break
      case 'provider-error':
        note(byLabel(clean(String(entry.label ?? ''))), t, `! provider error${entry.backoffMs !== undefined ? ` (retry in ${duration(Number(entry.backoffMs))})` : ''}: ${String(entry.error?.message ?? entry.error ?? '').split('\n')[0]}`)
        break
      case 'agent-failed':
        note(tree.agents.find(a => a.session === String(entry.session)), t, `✗ failed${typeof entry.error === 'string' ? `: ${entry.error.split('\n')[0]}` : ''}`)
        break
      case 'link-failed': {
        const label = clean(String(entry.label ?? ''))
        const list = pendingLinks.get(label) ?? []
        list.push({ t, text: clean(`! not linked to the parent session: ${String(entry.error ?? '').split('\n')[0]}`) })
        pendingLinks.set(label, list)
        break
      }
      case 'log': {
        const message = clean(String(entry.message ?? ''))
        const found = judging ? (judgePhase ? { group: ensure(judgePhase) } : undefined) : logGroup(message)
        if (!found) break
        const { group: g, rest } = found
        push(g, t, message)
        if (g.number === undefined || rest === undefined) break
        const n = g.number
        const green = rest.startsWith('checks green')
        const failedCheck = CHECK_FAILED.exec(rest)
        const gaveUp = rest.startsWith('checks-failed - ')
        if (!green && !failedCheck && !gaveUp && !/\bcheck/.test(rest)) break
        const raw = checkLines.get(g) ?? []
        raw.push({ t, text: message })
        checkLines.set(g, raw)
        const lines: string[] = []
        if (green) {
          g.checks = { state: 'passed', failed: [], lines, t }
          lastChecks.set(n, { kind: 'other' })
        } else if (failedCheck) {
          const batch = lastChecks.get(n)?.kind === 'batch' && g.checks?.state === 'failed'
          g.checks = { state: 'failed', failed: batch ? [...g.checks!.failed, failedCheck[1]!] : [failedCheck[1]!], lines, t }
          lastChecks.set(n, { kind: 'batch' })
        } else if (gaveUp) {
          g.checks = { state: 'failed', failed: g.checks?.state === 'failed' ? g.checks.failed : [], lines, t }
          lastChecks.set(n, { kind: 'other' })
        }
        break
      }
    }
  }

  const { status } = tree
  const ended = status === 'failed' || status === 'cancelled'
  const lastPhase = tree.phases.at(-1)?.title
  const currentKey = lastPhase ? phaseGroups[lastPhase] : undefined
  const list = [...groups.values()].sort((a, b) => rankOf(a.key, a.number) - rankOf(b.key, b.number))
  for (const g of list) {
    for (const a of g.agents) if (a.state !== 'running' && a.state !== 'waiting') push(g, a.end, `■ ${a.action} ${a.state}${a.end === undefined ? '' : ` ${duration(a.end - a.start)}`}`)
    g.lines = (timed.get(g) ?? [])
      .sort((x, y) => x.t - y.t)
      .slice(-MAX_GROUP_LINES)
      .flatMap(e => at(Number.isFinite(e.t) ? e.t : undefined, e.text))
    if (g.checks) g.checks.lines = (checkLines.get(g) ?? []).slice(-MAX_CHECK_LINES).flatMap(e => at(e.t, e.text))
    const busy = g.agents.some(a => BUSY.has(a.state))
    const starts = g.agents.map(a => a.start)
    const ends = g.agents.map(a => a.end).filter((e): e is number => e !== undefined)
    if (g.number !== undefined) {
      const mark = marks.get(g.number)
      if (outline && g.number < outline.fromStage) {
        g.state = 'skipped'
        g.note = `resumed from stage ${outline.fromStage}`
      } else if (mark?.end !== undefined) {
        g.outcome = mark.outcome
        if (mark.outcome) g.result = mark.outcome
        g.state = mark.outcome === 'skipped' ? 'skipped' : DONE_OUTCOMES.has(mark.outcome ?? 'clean') ? 'done' : 'failed'
        if (g.state === 'done' || g.state === 'skipped') delete g.outcome
        if (mark.start !== undefined) g.start = mark.start
        if (mark.start !== undefined || g.state !== 'skipped') g.end = mark.end
      } else if (mark?.start !== undefined) {
        g.state = 'running'
        g.start = mark.start
      } else if (g.agents.length) {
        g.state = busy ? 'running' : 'done'
        g.start = Math.min(...starts)
        if (!busy && ends.length) g.end = Math.max(...ends)
      }
    } else {
      const phases = tree.phases.filter(p => phaseGroups[p.title] === g.key)
      const was = reached.has(g.key) || g.agents.length > 0
      if (was) {
        g.start = Math.min(...[...phases.map(p => p.start), ...starts])
        const last = phases.at(-1)
        const end = Math.max(...[...(last?.end !== undefined ? [last.end] : []), ...ends])
        g.state = busy || (status === 'running' && currentKey === g.key) ? 'running' : 'done'
        if (g.state === 'done' && Number.isFinite(end)) g.end = end
      }
    }
    if (g.state === 'running' && ended) {
      g.state = status === 'cancelled' ? 'cancelled' : 'failed'
      g.end ??= tree.end
    }
    if (g.state === 'running' && status === 'done') {
      g.state = 'done'
      g.end ??= tree.end
    }
    if (judging && g.state === 'upcoming' && status !== 'running') g.state = 'skipped'
    if (g.checks && g.checks.state === 'running' && g.state !== 'running') delete g.checks
    if (g.checks) {
      const t = g.checks.t
      const after = lastOf(g.agents, a => a.end !== undefined && a.end <= t) ?? lastOf(g.agents, a => a.start <= t)
      if (after) g.checks.after = after
    }
  }
  if (ended && !list.some(g => g.state === 'failed' || g.state === 'cancelled')) {
    const last = lastOf(list, g => g.state === 'done' && g.number === undefined && g.key === currentKey)
    if (last) last.state = status === 'cancelled' ? 'cancelled' : 'failed'
  }
  tree.groups = list
  tree.running = list
    .filter(g => g.number !== undefined && g.state === 'running')
    .sort((a, b) => (a.start ?? now) - (b.start ?? now))
    .map(g => g.number!)
}

const text = (v: unknown) => (typeof v === 'string' && v ? { value: clean(v) } : undefined)

function findingViews(value: unknown): FindingView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): FindingView[] => {
    if (!raw || typeof raw !== 'object') return []
    const f = raw as Record<string, unknown>
    const id = text(f.id)?.value
    if (!id) return []
    const copy = (key: 'severity' | 'file' | 'reviewer' | 'detail' | 'verdict' | 'impact' | 'reason' | 'why') => {
      const v = text(f[key])
      return v ? { [key]: v.value } : {}
    }
    return [{
      id,
      sent: f.sent === true,
      title: text(f.title)?.value ?? id,
      ...copy('severity'),
      ...copy('file'),
      ...(typeof f.line === 'number' ? { line: f.line } : {}),
      ...copy('reviewer'),
      ...copy('detail'),
      ...copy('verdict'),
      ...copy('impact'),
      ...(typeof f.priority === 'number' ? { priority: f.priority } : {}),
      ...copy('reason'),
      ...copy('why'),
    }]
  })
}

const ROUND = /^ r\d+\b/
const CHECK_FAILED = /^check (.+?) failed \(/

// --- focus ----------------------------------------------------------------------------

/** The stage to name: the selected row's, else the newest running one, else the last started one. */
export function focusStage(tree: RunTree, selectedKey?: string): number | undefined {
  if (selectedKey) {
    const groupKey = selectedKey.startsWith(`group:${tree.id}:`) ? selectedKey.slice(`group:${tree.id}:`.length) : undefined
    const checks = selectedKey.startsWith(`checks:${tree.id}:`) ? Number(selectedKey.slice(`checks:${tree.id}:`.length)) : undefined
    const session = selectedKey.startsWith('agent:') ? selectedKey.slice('agent:'.length) : selectedKey.startsWith('sub:') ? selectedKey.slice('sub:'.length, selectedKey.lastIndexOf(':')) : undefined
    const agent = session !== undefined ? tree.agents.find(a => a.session === session) : undefined
    const n = groupKey ? stageNumber(groupKey) : checks !== undefined && Number.isInteger(checks) ? checks : agent ? stageNumber(agent.group) : undefined
    if (n !== undefined && tree.groups.some(g => g.number === n)) return n
  }
  if (tree.running.length) return tree.running.at(-1)
  const started = tree.groups.filter(g => g.number !== undefined && g.start !== undefined).sort((a, b) => a.start! - b.start!)
  return started.at(-1)?.number
}

// --- rows -----------------------------------------------------------------------------------------

export type RowKind = 'group' | 'agent' | 'checks' | 'sub' | 'run' | 'label'

export interface Row {
  key: string
  kind: RowKind
  depth: number
  selectable: boolean
  run: RunTree
  group?: WorkGroup
  agent?: AgentNode
  sub?: SubagentNode
  folded?: boolean
  /** The key of the row this one hangs under. */
  parent?: string
  /** A run row of the run the page shows. */
  shown?: boolean
  /** The one run row of a page that lists no other run. */
  details?: boolean
}

export interface RowView {
  /** The id of the run the page shows. */
  run: string
  /** Groups the user folded. */
  folded: ReadonlySet<string>
  /** Groups the user opened. */
  opened: ReadonlySet<string>
  focus?: number
  /** `list`: a runs section with every run; `one`: one `run details` row. */
  runs: 'list' | 'one'
}

export const groupKey = (runId: string, key: string) => `group:${runId}:${key}`
export const checksKey = (runId: string, n: number) => `checks:${runId}:${n}`

/** The rows a detail can show: the shown run's work groups with their agents, checks and subagents, then the runs. */
export function visibleRows(trees: readonly RunTree[], view: RowView): Row[] {
  const rows: Row[] = []
  const tree = trees.find(t => t.id === view.run)
  if (tree) {
    for (const g of tree.groups) {
      const gk = groupKey(tree.id, g.key)
      if (g.state === 'upcoming') {
        rows.push({ key: gk, kind: 'group', depth: 0, selectable: true, run: tree, group: g })
        continue
      }
      const open = view.opened.has(gk) || (!view.folded.has(gk) && (g.state === 'running' || (g.number !== undefined && g.number === view.focus)))
      rows.push({ key: gk, kind: 'group', depth: 0, selectable: true, run: tree, group: g, folded: !open })
      if (!open) continue
      const checksRow = (): Row => ({ key: checksKey(tree.id, g.number!), kind: 'checks', depth: 1, selectable: true, run: tree, group: g, parent: gk })
      let placed = !g.checks
      if (g.checks && !g.checks.after) {
        rows.push(checksRow())
        placed = true
      }
      for (const agent of g.agents) {
        const ak = agentKey(agent.session)
        rows.push({ key: ak, kind: 'agent', depth: 1, selectable: true, run: tree, group: g, agent, parent: gk })
        for (const sub of agent.subagents) rows.push({ key: subKey(agent.session, sub.name), kind: 'sub', depth: 2, selectable: true, run: tree, group: g, agent, sub, parent: ak })
        if (!placed && g.checks?.after === agent) {
          rows.push(checksRow())
          placed = true
        }
      }
    }
  }
  if (view.runs === 'list') {
    rows.push({ key: 'label:runs', kind: 'label', depth: 0, selectable: false, run: tree ?? trees[0]! })
    for (const t of trees) rows.push({ key: runKey(t.id), kind: 'run', depth: 0, selectable: true, run: t, shown: t.id === view.run })
  } else if (tree) rows.push({ key: runKey(tree.id), kind: 'run', depth: 0, selectable: true, run: tree, shown: true, details: true })
  return rows
}

export const GROUP_MARKERS: Record<GroupState, string> = { upcoming: '', running: '●', done: '✓', failed: '✗', skipped: '⊘', cancelled: '⊘' }
export const runKey = (id: string) => `run:${id}`
export const phaseKey = (id: string, index: number) => `phase:${id}:${index}`
export const agentKey = (session: string) => `agent:${session}`
export const subKey = (session: string, name: string) => `sub:${session}:${name}`

/** The rows of the older phase tree: run, phases, round groups, agents. */
export function phaseRows(runs: readonly RunTree[], folded: ReadonlySet<string>, expandedRun: string): PhaseRow[] {
  const rows: PhaseRow[] = []
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

const elapsed = (start: number, end: number | undefined, now: number) => duration((end ?? now) - start)

/** A phase row's plain text; an agent row that would not fit `width` drops the model's provider prefix, then its role and model. */
export function phaseRowText(row: PhaseRow, now: number, width = Number.POSITIVE_INFINITY): string {
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
