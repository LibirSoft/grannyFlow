import { GrannyCancelled, isCancelled } from './cancel'
import { judgeConfigGaps, planReviewWarning, resolveConfig, resolveEffort, resolveModel, type CheckConfig, type GrannyConfig, type ReviewerConfig, type RoleConfig } from './config'
import { trimPath, workOf } from './paths'
import {
  agentPlanReviewPrompt,
  agentReviewPrompt,
  checkCommandPrompt,
  commandReviewPrompt,
  commitPrompt,
  draftPrompt,
  extractPrompt,
  finalPrompt,
  fixPrompt,
  implementPrompt,
  implementStepPrompt,
  judgePrompt,
  judgeRetryNote,
  judgeStepPrompt,
  mergePrompt,
  ONE_SHOT_NOTE,
  planFixPrompt,
  planJudgePrompt,
  planReviewPrompt,
  repairPrompt,
  reportWritePrompt,
  reviewReadPrompt,
  reviewSavePrompt,
  reviewStartPrompt,
  reviewStopPrompt,
  reviewWaitPrompt,
  stepName,
  gitCommandPrompt,
  tagPrompt,
  timeoutProbePrompt,
  trailWritePrompt,
  worktreeCommandPrompt,
  roundLabel,
  type EarlierRound,
  type FailedCheck,
  type Overruled,
  type PromptContext,
  type RunOutcomes,
  type StageTask,
  WHOLE_BRANCH_NOTE,
} from './prompts'
import { opencodeAnswer, readGrant } from './opencode'
import { bucketOf, countsOf, isDemoted, isJudged, renderReport, severityOf, utf8Length, type ReportMeta } from './report'
import { decide, declinedOf, isBlocker, mergeDuplicates, parseCodexReview, reviewFailure, rideAlong, saysNoFindings, triage, type Policy } from './review'
import { detachedReview, MAX_WAITS, planReviewScript, reportedBackend, reviewerModel, reviewPlan, reviewStem, WAIT_SECONDS } from './reviewer'
import { SCHEMAS } from './schemas'
import { heredocWriteScript, shellQuote } from './shell'
import { trailDir, trailId, trailPath, trailRound, trailText, type RoundFacts } from './trail'
import { branchSlug, excludeScript, reportedWorktree, worktreePath, worktreeScript } from './worktree'
import type {
  AgentRequest,
  CheckResult,
  CheckRun,
  FinalReport,
  Finding,
  RoundFinding,
  Host,
  Implementation,
  JudgeOutcome,
  JudgeResult,
  PlanDraft,
  PlanFix,
  PlanResult,
  Recheck,
  RepoResult,
  ResultKind,
  Role,
  RoundRecord,
  RunResult,
  StageEvent,
  StageOutcome,
  StageResult,
  StageSpec,
  TrailReviewer,
  TrailRound,
  TrailSummary,
} from './types'

type Subject = { kind: 'diff'; base: string; stage?: StageTask; note?: string } | { kind: 'plan'; files: string[] }

const PLAN_PHASE = 'Plan review'
const DRAFT_PHASE = 'Plan'
const FINAL_REVIEW_PHASE = 'Final review'
const CHECKS_PHASE = 'Checks'
const REVIEW_PHASE = 'Review'
const TAGGING_PHASE = 'Tagging'
const REPORT_PHASE = 'Save report'
const TIMEOUT_PROBE = 'if command -v timeout >/dev/null; then echo timeout; elif command -v gtimeout >/dev/null; then echo gtimeout; else exit 1; fi'
const TIMEOUT_MISSING = /(^|[\s:])g?timeout: (command )?not found|command not found: g?timeout$/m

const EXIT_MARK = /\[granny\] exit=(\d+)[ \t]*(?:\r?\n|$)/g

/**
 * Claude Code's Bash tool shows no exit code when a command succeeds, so the helper cannot always report one:
 * the command prints its own as a last line. A subshell, not a brace group, so a script's own `exit` still reaches it.
 */
export const markExit = (command: string) => `( ${command} ) 2>&1; echo "[granny] exit=$?"`

/** The exit code from the last marker line, and the output without that line. */
export function exitMarked(output: string): { code: number; output: string } | undefined {
  const last = [...output.matchAll(EXIT_MARK)].at(-1)
  if (!last) return undefined
  return { code: Number(last[1]), output: output.slice(0, last.index) + output.slice(last.index! + last[0].length) }
}

export type RepoInput = string | { repo: string; base?: string }

export interface RunInput {
  repo: string
  branch: string
  base?: string
  repos?: RepoInput[]
  context?: string
  goal?: string
  plan?: string | string[]
  stages?: StageSpec[]
  fromStage?: number
  config?: unknown | unknown[]
}

interface ReviewerRound {
  reviewer: ReviewerConfig
  ran: boolean
  findings: Finding[]
  note?: string
}

interface Gates {
  green: boolean
  text: string
  by: string
}

interface Lane {
  repo: string
  base: string
  branch: string
  cwd: string
  p: PromptContext
  /** What an opencode reviewer may read outside the worktree: the paths named in free text, and files. */
  readable: { text: string; files: string[] }
}

interface RepoState {
  lane: Lane
  locked: boolean
  waiters: Array<() => void>
  setup: Promise<unknown>
  merges: number
  red?: number
  started?: Promise<string | undefined>
  /** Each stage's review decisions, by stage index, for the final review's judge. */
  ledger: Map<number, EarlierRound[]>
}

const saidSomething = (d: unknown): string | undefined =>
  typeof d === 'string' && d.trim() && !/^\s*(none|n\/a|-|no deviations)?\.?\s*$/i.test(d) ? d : undefined
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stage'
const ROUND_DETAIL = 2000

/** What a run view keeps of a finding: the text bounded, so a journal line stays small. */
function roundFinding(f: Finding, sent: boolean): RoundFinding {
  return {
    id: f.id,
    sent,
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.title ? { title: f.title } : {}),
    ...(f.file ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.reviewer ? { reviewer: f.reviewer } : {}),
    ...(f.detail ? { detail: String(f.detail).slice(0, ROUND_DETAIL) } : {}),
    ...(f.verdict ? { verdict: f.verdict } : {}),
    ...(f.impact ? { impact: f.impact } : {}),
    ...(f.priority !== undefined ? { priority: f.priority } : {}),
    ...(f.reason ? { reason: String(f.reason).slice(0, ROUND_DETAIL) } : {}),
    ...(f.decision?.why ? { why: f.decision.why } : {}),
  }
}

const repoPathOf = (r: RepoInput): unknown => (typeof r === 'string' ? r : r && typeof r === 'object' ? r.repo : undefined)
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const lineShaped = (output: string, shape: RegExp) => output.split('\n').map(l => l.trim()).find(l => shape.test(l))
const SHA = /^[0-9a-f]{7,64}$/i
const COUNT = /^\d+$/
const short = (sha: string) => sha.slice(0, 8)
const STATUS_LINE = /^\s*[MADRCUT?!]{1,2}\s+\S/
type Unreadable = { unreadable: string }
type Committed = { impl?: Implementation; by?: string; left?: string[]; unread?: string }
const listed = (status: string[]) => status.map(l => l.trim()).join(', ')
type JudgeEntry = Record<string, unknown> & { id: string; duplicateOf?: unknown; repeatOf?: unknown }
const entriesOf = (answer: any): JudgeEntry[] =>
  Array.isArray(answer?.perFinding) ? answer.perFinding.filter((x: unknown) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') : []
const phaseOf = (subject: Subject) => (subject.kind === 'plan' ? PLAN_PHASE : subject.note === WHOLE_BRANCH_NOTE ? FINAL_REVIEW_PHASE : REVIEW_PHASE)

const reviewerMeta = (rv: ReviewerConfig, host: Host): TrailReviewer => {
  const model = reviewerModel(rv, host.name)
  return { name: rv.name, engine: rv.engine, ...(model ? { model } : {}) }
}

export function checkInput(input: RunInput): string[] {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return ['input must be an object']
  if (typeof input.repo !== 'string' || !input.repo.startsWith('/')) errors.push('repo must be an absolute path')
  if (typeof input.branch !== 'string' || !input.branch) errors.push('branch is required')
  const known = new Set<string>(typeof input.repo === 'string' ? [trimPath(input.repo)] : [])
  if (input.repos !== undefined) {
    if (!Array.isArray(input.repos)) errors.push('repos must be an array of absolute paths or { repo, base } objects')
    else input.repos.forEach((r, i) => {
      const path = repoPathOf(r)
      if (typeof path !== 'string' || !path.startsWith('/')) errors.push(`repos[${i}] must be an absolute path or { repo, base } with an absolute repo`)
      else if (known.has(trimPath(path))) errors.push(`repos[${i}] repeats ${path}${trimPath(path) === trimPath(input.repo) ? ' (it is the primary repo)' : ''}`)
      else known.add(trimPath(path))
      if (typeof r === 'object' && r && r.base !== undefined && (typeof r.base !== 'string' || !r.base)) errors.push(`repos[${i}].base must be a non-empty string`)
    })
  }
  if (input.goal !== undefined) {
    if (typeof input.goal !== 'string' || !input.goal.trim()) errors.push('goal must be a non-empty string')
    if (input.stages !== undefined) errors.push('a run with goal plans the work and proposes the stages - drop stages, or drop goal and pass the plan')
    if (input.fromStage !== undefined) errors.push('fromStage has no stages to resume in a run with goal')
  } else if (!Array.isArray(input.stages) || !input.stages.length) errors.push('stages must be a non-empty array (or pass goal to have the planner write the plan)')
  else errors.push(...stageErrors(input.stages, known))
  if (input.goal === undefined && input.fromStage !== undefined && (!Number.isInteger(input.fromStage) || input.fromStage < 1 || input.fromStage > (input.stages?.length ?? 0))) {
    errors.push('fromStage must be a 1-based stage index')
  }
  if (input.plan !== undefined) {
    const plans: unknown[] = Array.isArray(input.plan) ? input.plan : [input.plan]
    const bad = plans.find(f => typeof f !== 'string' || !f.startsWith('/'))
    if (!plans.length || bad !== undefined) {
      errors.push(`plan must be an absolute path or a non-empty array of absolute paths${bad === undefined || bad === '' ? '' : ` (got ${JSON.stringify(bad)})`}`)
    }
  }
  return errors
}

function stageErrors(stages: StageSpec[], known: Set<string>): string[] {
  const errors: string[] = []
  stages.forEach((s, i) => {
    if (!s || typeof s !== 'object') return errors.push(`stages[${i}] must be an object`)
    if (s.implement === false && s.review === false) errors.push(`stages[${i}] has nothing to do (implement and review are both false)`)
    else if (s.implement !== false && (typeof s.task !== 'string' || !s.task.trim())) errors.push(`stages[${i}].task is required`)
    if (s.repo !== undefined && (typeof s.repo !== 'string' || !known.has(trimPath(s.repo)))) {
      errors.push(`stages[${i}].repo must be the repo or one of repos (got ${JSON.stringify(s.repo)})`)
    }
    if (s.after !== undefined && !(Array.isArray(s.after) && s.after.every(n => Number.isInteger(n) && n >= 1 && n <= i))) {
      errors.push(`stages[${i}].after must list 1-based numbers of earlier stages (1..${i})`)
    }
    if (s.checks !== undefined && !(Array.isArray(s.checks) && s.checks.every(c => typeof c === 'string' && c.trim()))) {
      errors.push(`stages[${i}].checks must be an array of check names`)
    }
    if (s.steps !== undefined) errors.push(...stepErrors(i, s))
  })
  return errors
}

function stepErrors(i: number, s: StageSpec): string[] {
  const at = `stages[${i}].steps`
  if (!Array.isArray(s.steps) || !s.steps.length) return [`${at} must be a non-empty array of { name?, task }`]
  if (s.implement === false) return [`${at} needs an implementing stage (implement is false)`]
  return s.steps.flatMap((step, k) => {
    const here = `${at}[${k}]`
    if (!step || typeof step !== 'object') return [`${here} must be an object { name?, task }`]
    const problems: string[] = []
    if (step.name !== undefined && (typeof step.name !== 'string' || !step.name.trim())) problems.push(`${here}.name must be a non-empty string`)
    if (typeof step.task !== 'string' || !step.task.trim()) problems.push(`${here}.task is required`)
    return problems
  })
}

function plannedSteps(list: unknown): Array<{ name?: string; task: string }> | undefined {
  if (!Array.isArray(list)) return undefined
  const kept = list.flatMap((step: unknown) => {
    if (!step || typeof step !== 'object') return []
    const { name, task } = step as { name?: unknown; task?: unknown }
    if (typeof task !== 'string' || !task.trim()) return []
    return [typeof name === 'string' && name.trim() ? { name, task } : { task }]
  })
  return kept.length ? kept : undefined
}

type StepRun = { name: string; implementation: Implementation }

function mergeSteps(ran: StepRun[]): Implementation {
  const first = ran[0]!.implementation
  const last = ran.at(-1)!.implementation
  const said = (text: (r: Implementation) => string | undefined): string | undefined => {
    const parts = ran.flatMap((s, k) => {
      const t = text(s.implementation)
      return t ? [`step ${k + 1} (${s.name}): ${t}`] : []
    })
    return parts.length ? parts.join('\n') : undefined
  }
  const deviations = said(r => saidSomething(r.deviations))
  const declined = ran.flatMap((s, k) => (s.implementation.declined ?? []).map(d => ({ id: d.id, reason: `step ${k + 1} (${s.name}): ${d.reason}` })))
  return {
    startSha: first.startSha,
    headSha: last.headSha,
    gatesGreen: last.gatesGreen,
    gates: last.gates,
    commits: ran.flatMap(s => s.implementation.commits ?? []),
    untested: said(r => r.untested?.trim() || undefined) ?? '',
    ...(deviations ? { deviations } : {}),
    ...(declined.length ? { declined } : {}),
  }
}

export function stageCheckErrors(stages: StageSpec[] | undefined, checks: CheckConfig[]): string[] {
  const names = new Set(checks.map(c => c.name))
  return (stages ?? []).flatMap((st, i) =>
    (Array.isArray(st?.checks) ? st.checks : []).filter(n => !names.has(n)).map(n => `stages[${i}].checks names "${n}", which is not in config checks (${[...names].join(', ') || 'none configured'})`),
  )
}

const planFiles = (input: RunInput): string[] => (input.plan === undefined ? [] : Array.isArray(input.plan) ? input.plan : [input.plan])

export const configLayers = (input: { config?: unknown }): unknown[] => (Array.isArray(input.config) ? input.config : [input.config])

/** What a full run and a review-only run share: the agent and shell calls, the status read, the reviewers and the judge call. */
function engineParts(host: Host, config: GrannyConfig) {
  const stopIfCancelled = () => {
    if (host.cancelled?.()) throw new GrannyCancelled()
  }
  const guarded = async <T>(start: () => Promise<T>): Promise<T> => {
    stopIfCancelled()
    let r: T
    try {
      r = await start()
    } catch (e) {
      stopIfCancelled()
      throw e
    }
    stopIfCancelled()
    return r
  }
  const run = (script: string, cwd: string) => guarded(() => host.run!(script, cwd))

  const call = async (role: Role, kind: ResultKind, label: string, phase: string, prompt: string, access: AgentRequest['access'], rc: RoleConfig, cwd: string) =>
    guarded(() =>
      host.agent({
        role,
        kind,
        label,
        phase,
        prompt,
        schema: SCHEMAS[kind],
        model: resolveModel(rc.model, host.name),
        effort: resolveEffort(rc.effort, host.name),
        access,
        cwd,
      }),
    )

  const reported = (r: any): { ran: boolean; code: number | string; output: string; note?: string } => {
    const said = exitMarked(String(r?.output ?? ''))
    const ran = said ? said.code === 0 : Boolean(r?.ran)
    const note = typeof r?.note === 'string' && r.note.trim() ? r.note : undefined
    return { ran, code: said ? said.code : (r?.exitCode ?? (ran ? 0 : '?')), output: said ? said.output : String(r?.output ?? ''), ...(note ? { note } : {}) }
  }

  const helped = (label: string, r: any, missing: string): { ran: boolean; code: number | string; output: string } => {
    const { ran, code, output, note } = reported(r)
    if (ran && note) host.log(`${label}: the helper's note, kept out of the command's output: ${note}`)
    return { ran, code, output: r ? `${output}${!ran && note ? `\n${note}` : ''}` : missing }
  }

  const shell = async (label: string, phase: string, script: string, cwd: string, ask = gitCommandPrompt): Promise<{ ran: boolean; code: number | string; output: string }> => {
    if (host.run) {
      const r = await run(script, cwd)
      return { ran: r.code === 0, code: r.code, output: r.output }
    }
    const prompt = ask(cwd, label, markExit(`cd ${shellQuote(cwd)} && ${script}`))
    return helped(label, await call('helper', 'command', label, phase, prompt, 'write', config.roles.helper, cwd), `the ${label} runner returned nothing`)
  }

  const readHead = async (label: string, phase: string, cwd: string) => {
    const r = await shell(label, phase, 'git rev-parse --verify HEAD', cwd)
    const sha = r.ran ? lineShaped(r.output, SHA) : undefined
    return { sha, code: r.code, output: r.output }
  }

  /** Writes text that ends in a newline through a heredoc, then checks the file's byte count and writes once more on a mismatch. */
  const writeChecked = async (o: {
    path: string
    text: string
    cwd: string
    phase: string
    what: string
    labels: { write: string; retry: string; size: string }
    ask: typeof gitCommandPrompt
    sizeAsk?: typeof gitCommandPrompt
    log?: (line: string) => void
  }): Promise<boolean> => {
    const log = o.log ?? host.log
    const want = utf8Length(o.text)
    for (let n = 1; n <= 2; n++) {
      const w = await shell(n === 1 ? o.labels.write : o.labels.retry, o.phase, heredocWriteScript(o.path, o.text), o.cwd, o.ask)
      if (!w.ran) {
        log(`writing ${o.what} failed (exit ${w.code}): ${w.output.slice(-300)}`)
        return false
      }
      const size = await shell(o.labels.size, o.phase, `wc -c < ${shellQuote(o.path)}`, o.cwd, o.sizeAsk ?? o.ask)
      const got = size.ran ? lineShaped(size.output, COUNT) : undefined
      if (got !== undefined && Number(got) === want) return true
      log(`${o.path} holds ${got ?? 'an unknown number of'} bytes, not ${want}${n === 1 ? ' - writing it once more' : ''}`)
    }
    return false
  }

  const work = workOf(config)

  const uncommitted = async (label: string, phase: string, cwd: string, plans: string[] = []): Promise<string[] | Unreadable> => {
    const keep = plans.map(f => shellQuote(`:(exclude,literal)${f.slice(trimPath(cwd).length + 1)}`))
    const read = () => shell(label, phase, `git status --porcelain${keep.length ? ` -- ':(top)' ${keep.join(' ')}` : ''}`, cwd)
    let r = await read()
    if (!r.ran) {
      host.log(`${label}: could not read the working tree status (exit ${r.code}) - reading it once more`)
      r = await read()
    }
    if (!r.ran) {
      const unreadable = `exit ${r.code}: ${r.output.trim().slice(-300)}`
      host.log(`${label}: could not read the working tree status again - not treating the tree as clean (${unreadable})`)
      return { unreadable }
    }
    return r.output.split('\n').filter(l => STATUS_LINE.test(l) && !`${l.trim().replace(/^\S+\s+/, '')}/`.startsWith(`${work}/`))
  }

  const attribute = (rv: ReviewerConfig, findings: Finding[]): Finding[] =>
    findings.map((f, i) => ({ ...f, id: `${rv.name}-F${i + 1}`, reviewer: rv.name }))

  /** The review file keeps the answer a reviewer gave, not the event stream it was read from; a failed save only logs. */
  const saveAnswer = async (label: string, phase: string, path: string, text: string, cwd: string, tag: string) => {
    const failed = `${tag}: could not save the answer to ${path}`
    try {
      const w = await shell(label, phase, heredocWriteScript(path, `${text}\n`), cwd, reviewSavePrompt)
      if (!w.ran) host.log(`${failed} (exit ${w.code}): ${w.output.trim().slice(-300)}`)
    } catch (e) {
      if (isCancelled(e)) throw e
      host.log(`${failed}: ${String((e as Error)?.message ?? e)}`)
    }
  }

  const review = async (lane: Lane, rv: ReviewerConfig, name: string, subject: Subject, round: number, attempt: number): Promise<Omit<ReviewerRound, 'reviewer'>> => {
    const { p, cwd } = lane
    const tag = `${name} r${round} ${rv.name}${attempt > 1 ? ` #${attempt}` : ''}`
    const phase = phaseOf(subject)
    if (rv.engine === 'agent') {
      const prompt = subject.kind === 'plan' ? agentPlanReviewPrompt(p, subject.files) : agentReviewPrompt(p, name, subject.base, subject.stage, subject.note)
      const r = await call('reviewer', 'findings', `review ${tag}`, phase, prompt, 'read-only', rv, cwd)
      if (!r) return { ran: false, findings: [], note: 'reviewer agent returned nothing' }
      return { ran: true, findings: Array.isArray(r.findings) ? r.findings : [] }
    }

    const stem = reviewStem(config, slug(name), round, rv)
    const { text, files } = lane.readable
    const { dirs, refused } =
      rv.engine === 'opencode'
        ? subject.kind === 'plan'
          ? readGrant(text, [...files, ...subject.files], cwd, p.others ?? [])
          : readGrant([text, subject.stage?.task ?? ''].join('\n'), files, cwd)
        : { dirs: [], refused: [] }
    if (refused.length) host.log(`${tag}: opencode cannot read ${refused.join(', ')} - move ${refused.length > 1 ? 'them' : 'it'} under a project directory`)
    const plan =
      subject.kind === 'plan'
        ? planReviewScript(rv, config, host.name, lane.base, stem, planReviewPrompt(p, subject.files), dirs)
        : reviewPlan(rv, config, host.name, subject.base, stem, commandReviewPrompt(p, name, subject.base, subject.stage, subject.note, rv.engine === 'opencode'), dirs)
    if (!plan) return { ran: false, findings: [], note: 'this reviewer has no command for a plan review' }
    const failed = (out: string) => (rv.engine === 'opencode' ? opencodeAnswer(out).error : undefined) ?? out.slice(-2000)
    let ran: boolean
    let output: string
    let note: string | undefined
    if (host.run) {
      const r = await run(plan.script, cwd)
      ran = r.code === 0
      output = r.output
      if (!ran) note = `review command exited ${r.code}: ${failed(r.output)}`
    } else {
      const job = detachedReview(plan, config, stem, cwd)
      const step = async (label: string, prompt: string) => {
        const r = await call('helper', 'command', label, phase, prompt, 'read-only', config.roles.helper, cwd)
        return r ? reported(r) : undefined
      }
      const started = await step(`review ${tag}`, reviewStartPrompt(p, name, rv.name, markExit(job.start)))
      if (!started?.ran) {
        return { ran: false, findings: [], note: started ? `review command did not start (exit ${started.code})${started.note ? ` (${started.note})` : ''}: ${started.output.slice(-2000)}` : 'review runner returned nothing' }
      }
      let done = false
      for (let n = 1; n <= MAX_WAITS && !done; n++) {
        const w = await step(`review ${tag} wait ${n}`, reviewWaitPrompt(p, name, rv.name, n, MAX_WAITS, WAIT_SECONDS / 60, markExit(job.wait)))
        done = lineShaped(w?.output ?? '', /^done$/) !== undefined
      }
      if (!done) {
        await step(`review ${tag} stop`, reviewStopPrompt(p, name, rv.name, markExit(job.stop)))
        const limit = `${MAX_WAITS} waits of up to ${WAIT_SECONDS / 60} minutes (${(MAX_WAITS * WAIT_SECONDS) / 60} minutes)`
        return { ran: false, findings: [], note: `review command still running after ${limit} - stopped it` }
      }
      const r = await step(`review ${tag} read`, reviewReadPrompt(p, name, rv.name, markExit(job.read)))
      ran = Boolean(r?.ran)
      output = r?.output ?? ''
      if (!ran) note = r ? `review command exited ${r.code}${r.note ? ` (${r.note})` : ''}: ${failed(output)}` : 'review runner returned nothing'
    }
    host.log(`${tag}: reviewer: ${plan.backend ?? reportedBackend(output) ?? 'not reported'}`)
    if (!ran) return { ran, findings: [], note }
    if (rv.engine === 'opencode') {
      const answer = opencodeAnswer(output)
      if (answer.error) return { ran: false, findings: [], note: `opencode: ${answer.error}` }
      if (answer.dropped) host.log(`${tag}: opencode: ${answer.dropped} text part(s) did not come back whole and may be missing from the answer - check ${stem}.log`)
      if (!answer.text) return { ran: false, findings: [], note: 'opencode returned no answer' }
      output = answer.text
      await saveAnswer(`review ${tag} save`, phase, `${stem}.md`, output, cwd, tag)
    }
    const failure = reviewFailure(output)
    if (failure) return { ran: false, findings: [], note: `reviewer returned no usable result (${failure}): ${output.slice(-2000)}` }

    const parsed = parseCodexReview(output, subject.kind === 'plan' ? undefined : cwd)
    const extractions = async (label: string, prompt: string) => call('granny', 'findings', label, phase, prompt, 'read-only', config.roles.granny, cwd)
    const extract = async (label: string, prompt: string): Promise<Finding[]> => {
      const r = await extractions(label, prompt)
      return Array.isArray(r?.findings) ? r.findings : []
    }
    if (parsed.markers === 0 && !saysNoFindings(output)) {
      host.log(`${tag}: no finding in the expected form and not just "No findings." - asking an agent to extract findings`)
      const r = await extractions(`extract ${tag}`, extractPrompt(name, output, 'unmarked'))
      const found: Finding[] = Array.isArray(r?.findings) ? r.findings : []
      if (found.length || r?.clean === true) return { ran, findings: found }
      return { ran: false, findings: [], note: `reviewer output had no findings in the expected form and was not just No findings, and an extraction found none in it: ${output.slice(-2000)}` }
    }
    if (parsed.markers <= parsed.findings.length) return { ran, findings: parsed.findings }

    host.log(`${tag}: parser read ${parsed.findings.length}/${parsed.markers} findings - asking an agent to extract them`)
    const first = await extract(`extract ${tag}`, extractPrompt(name, output))
    if (first.length >= parsed.markers) return { ran, findings: first }

    host.log(`${tag}: extraction recovered ${first.length}/${parsed.markers} findings - asking once more with the expected count`)
    const second = await extract(`extract ${tag} retry`, extractPrompt(name, output, { markers: parsed.markers, got: first.length }))
    if (second.length >= parsed.markers) return { ran, findings: second }
    return {
      ran: false,
      findings: [],
      note: `review reported ${parsed.markers} finding marker(s), parser read ${parsed.findings.length}; extraction recovered ${first.length}, then ${second.length} on a retry that named the count: ${output.slice(-2000)}`,
    }
  }

  const attempt = async (lane: Lane, rv: ReviewerConfig, name: string, subject: Subject, round: number, n: number): Promise<Omit<ReviewerRound, 'reviewer'>> => {
    try {
      return await review(lane, rv, name, subject, round, n)
    } catch (e) {
      if (isCancelled(e)) throw e
      return { ran: false, findings: [], note: `reviewer call failed: ${String((e as Error)?.message ?? e)}` }
    }
  }

  const reviewAll = (lane: Lane, reviewers: ReviewerConfig[], name: string, subject: Subject, round: number): Promise<ReviewerRound[]> =>
    Promise.all(
      reviewers.map(async reviewer => {
        let r = await attempt(lane, reviewer, name, subject, round, 1)
        if (!r.ran) {
          host.log(`${name} r${round} ${reviewer.name}: did not run - retrying once. ${r.note ?? ''}`)
          r = await attempt(lane, reviewer, name, subject, round, 2)
        }
        return { reviewer, ...r, findings: attribute(reviewer, r.findings) }
      }),
    )

  /** One judge call and, when it left a finding unclassified, one retry; `apply` turns its entries into decided findings. */
  const judgeAnswers = async (o: {
    at: string
    label: string
    prompt: string
    ids: Set<string>
    ask: (label: string, prompt: string) => Promise<any>
    apply: (per: JudgeEntry[]) => Finding[]
    leftTo: string
  }): Promise<{ per: JudgeEntry[]; decided: Finding[] }> => {
    const unjudged = (decided: Finding[]) => decided.filter(f => o.ids.has(f.id) && f.decision!.rule === 2)
    const named = (fs: Finding[]) => fs.map(f => `${f.id} (${f.decision!.why})`).join(', ')
    const scored = await o.ask(o.label, o.prompt)
    let per = entriesOf(scored)
    let decided = o.apply(per)
    let left = unjudged(decided)
    if (left.length) {
      host.log(`${o.at}: ${scored ? `judge left ${left.length} finding(s) unclassified - retrying once: ${named(left)}` : 'judge returned nothing - retrying once'}`)
      const problems = scored ? left.map(f => ({ id: f.id, why: f.decision!.why === 'not judged' ? 'no classification in your answer' : f.decision!.why })) : null
      const retried = await o.ask(`${o.label} retry`, `${o.prompt}\n\n${judgeRetryNote(problems)}`)
      const again = new Set(left.map(f => f.id))
      const fresh = entriesOf(retried).filter(x => again.has(x.id))
      per = [...per.filter(x => !again.has(x.id) || !fresh.some(y => y.id === x.id)), ...fresh]
      decided = o.apply(per)
      left = unjudged(decided)
      if (!scored && !retried) host.log(`${o.at}: judge returned nothing, also on a retry - all ${o.ids.size} finding(s) go ${o.leftTo}`)
      else if (left.length) host.log(`${o.at}: judge left ${left.length} finding(s) unclassified, also on a retry - ${o.leftTo}: ${named(left)}`)
    }
    return { per, decided }
  }

  return { call, shell, readHead, writeChecked, uncommitted, reviewAll, judgeAnswers }
}

export async function runGranny(host: Host, input: RunInput): Promise<RunResult> {
  const inputErrors = checkInput(input)
  if (inputErrors.length) throw new Error(`Invalid granny input:\n- ${inputErrors.join('\n- ')}`)

  const config = resolveConfig(configLayers(input), host.name)
  const { call, shell, readHead, writeChecked, uncommitted: statusOf, reviewAll, judgeAnswers } = engineParts(host, config)
  const work = workOf(config)
  const uncommitted = (label: string, phase: string, cwd: string) => statusOf(label, phase, cwd, plansIn(cwd))
  const base = input.base ?? config.base
  const fromStage = input.fromStage ?? 1
  const primary = trimPath(input.repo)
  const extra = (input.repos ?? []).map(r => (typeof r === 'string' ? { repo: trimPath(r), base: config.base } : { repo: trimPath(r.repo), base: r.base ?? config.base }))
  const baseOf = (repo: string) => (repo === primary ? base : extra.find(r => r.repo === repo)!.base)
  const specs = input.stages ?? []
  const repoOf = (st: StageSpec) => (st.repo === undefined ? primary : trimPath(st.repo))
  const unknownChecks = stageCheckErrors(specs, config.checks)
  if (unknownChecks.length) throw new Error(`Invalid granny input:\n- ${unknownChecks.join('\n- ')}`)
  const checksOf = (st: StageSpec): CheckConfig[] => (st.checks === undefined ? config.checks : config.checks.filter(c => st.checks!.includes(c.name)))
  const finalChecksOf = (repo: string): CheckConfig[] => {
    const theirs = specs.filter(st => repoOf(st) === repo).map(checksOf)
    return config.checks.filter(c => theirs.some(list => list.includes(c)))
  }

  const setUpWorktree = async (repo: string, branch: string, from: string, label: string, shared: boolean): Promise<string> => {
    const script = worktreeScript(config, branch, from, worktreePath(repo, branch, config.worktreeDir, shared))
    const r = await shell(label, 'Worktree', script, repo, (_cwd, _step, command) => worktreeCommandPrompt(repo, branch, command))
    const path = r.ran ? reportedWorktree(r.output) : undefined
    if (!path) throw new Error(`worktree setup failed${repo === primary && branch === input.branch ? '' : ` for ${repo} ${branch}`} (exit ${r.code}): ${r.output.slice(-2000)}`)
    host.log(`worktree${repo === primary && branch === input.branch ? '' : ` ${baseName(repo)} ${branch}`}: ${path}`)
    return path
  }

  const findTimeout = async (timed: CheckConfig[]): Promise<string> => {
    const once = () => shell('timeout probe', CHECKS_PHASE, TIMEOUT_PROBE, primary, timeoutProbePrompt)
    let r = await once()
    if (typeof r.code !== 'number') {
      host.log(`timeout probe: the runner failed (exit ${r.code}) - running it once more`)
      r = await once()
    }
    const found = r.ran ? r.output.split('\n').map(l => /^(?:.*\/)?(g?timeout)$/.exec(l.trim())?.[1]).find(Boolean) : undefined
    if (found) {
      if (found !== 'timeout') host.log(`checks: no \`timeout\` on PATH - the checks with a timeout run in \`${found}\``)
      return found
    }
    if (typeof r.code !== 'number') throw new Error(`could not look up the timeout command for the checks with a timeout (exit ${r.code}): ${r.output.slice(-300)}`)
    throw new Error(
      `checks with a timeout (${timed.map(c => c.name).join(', ')}) run as \`timeout <s> bash -c '<run>'\`, but neither \`timeout\` nor \`gtimeout\` is on PATH - install GNU coreutils (macOS: \`brew install coreutils\`), or drop \`timeout\` from those checks`,
    )
  }
  const timed = config.checks.filter(c => c.timeout && specs.some(st => checksOf(st).includes(c)))
  const timeoutCommand = timed.length ? await findTimeout(timed) : 'timeout'

  const used = input.goal !== undefined ? [primary] : [primary, ...extra.map(r => r.repo).filter(r => specs.some(st => repoOf(st) === r))]
  const cwdOf = new Map<string, string>(used.map(r => [r, r]))
  if (config.worktree) {
    host.phase('Worktree')
    for (const r of used) cwdOf.set(r, await setUpWorktree(r, input.branch, baseOf(r), r === primary ? 'worktree' : `worktree ${baseName(r)}`, r !== primary))
  }
  const worktree = cwdOf.get(primary)!

  const draftPlan = async (goal: string): Promise<PlanDraft> => {
    host.phase(DRAFT_PHASE)
    const targets = input.plan === undefined ? [`${primary}/${config.workDir}/plans/${branchSlug(input.branch)}.md`] : planFiles(input)
    const prompt = draftPrompt({ repo: worktree, branch: input.branch, base, context: input.context, config }, goal, targets, extra.map(r => r.repo))
    const r = (await call('planner', 'draft', 'plan', DRAFT_PHASE, prompt, 'write', config.roles.planner, worktree)) as PlanDraft | null
    if (!r) throw new Error('planner returned nothing')
    const files = (Array.isArray(r.files) ? r.files : []).filter(f => typeof f === 'string' && f.startsWith('/'))
    if (!files.length) throw new Error(`planner reported no plan file (expected ${targets.join(', ')})`)
    const proposed = (Array.isArray(r.stages) ? r.stages : []).filter(st => st && typeof st.task === 'string' && st.task.trim())
    if (!proposed.length) throw new Error('planner proposed no stage with a task')
    const stages = proposed.map((st): StageSpec => {
      const out: StageSpec = { name: st.name, task: st.task }
      if (typeof st.repo === 'string' && st.repo && trimPath(st.repo) !== primary && trimPath(st.repo) !== trimPath(worktree)) out.repo = st.repo
      if (Array.isArray(st.after)) out.after = st.after
      const steps = config.stepAgents ? plannedSteps(st.steps) : undefined
      if (steps) out.steps = steps
      return out
    })
    const draft: PlanDraft = { files, stages, summary: String(r.summary ?? '') }
    if (typeof r.questions === 'string' && r.questions.trim()) draft.questions = r.questions
    const problems = stageErrors(stages, new Set([primary, ...extra.map(e => e.repo)]))
    if (problems.length) host.log(`plan: the proposed stages need fixing before a run accepts them:\n- ${problems.join('\n- ')}`)
    host.log(`plan: ${files.join(', ')} - ${draft.stages.length} proposed stage(s)${draft.questions ? ', with open questions for the user' : ''}`)
    return draft
  }

  const draft = input.goal !== undefined ? await draftPlan(input.goal) : undefined
  const plans = draft ? draft.files : planFiles(input)
  const plansIn = (cwd: string): string[] => plans.filter(f => f.startsWith(`${trimPath(cwd)}/`) && !f.slice(trimPath(cwd).length + 1).startsWith(`${work}/`))
  const context = [plans.length ? `Plan files - read them first: ${plans.join(', ')}` : '', input.context ?? ''].filter(Boolean).join('\n') || undefined
  const readable = { text: input.context ?? '', files: plans }
  const promptFor = (repo: string, cwd: string, branch: string, others: string[], prBody?: string): PromptContext => ({
    repo: cwd,
    branch,
    base: baseOf(repo),
    context,
    config,
    ...(others.length ? { others } : {}),
    ...(prBody ? { prBody } : {}),
  })
  const repoState = new Map<string, RepoState>(
    used.map(r => {
      const cwd = cwdOf.get(r)!
      const others = used.filter(o => o !== r).map(o => cwdOf.get(o)!)
      return [r, { lane: { repo: r, base: baseOf(r), branch: input.branch, cwd, p: promptFor(r, cwd, input.branch, others), readable }, locked: false, waiters: [], setup: Promise.resolve(), merges: 0, ledger: new Map() }]
    }),
  )
  const primaryLane = repoState.get(primary)!.lane

  const implement = async (lane: Lane, label: string, prompt: string): Promise<Implementation> => {
    const r = (await call('implementer', 'implementation', label, 'Implement', prompt, 'write', config.roles.implementer, lane.cwd)) as Implementation | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: ${r.startSha.slice(0, 8)}..${r.headSha.slice(0, 8)}, gates ${r.gatesGreen ? 'green' : 'RED'} - ${r.gates}`)
    return r
  }

  const runCheck = async (lane: Lane, name: string, check: CheckConfig): Promise<CheckResult & { output: string; broken?: true }> => {
    const script = check.timeout ? `${timeoutCommand} ${check.timeout} bash -c ${shellQuote(check.run)}` : check.run
    const ask = (repo: string, label: string, run: string) => checkCommandPrompt(repo, label, run, check.metric?.pattern)
    const once = () => shell(`check ${name} ${check.name}`, CHECKS_PHASE, script, lane.cwd, ask)
    let r = await once()
    if (typeof r.code !== 'number') {
      host.log(`${name}: the check ${check.name} runner failed (exit ${r.code}) - running it once more`)
      r = await once()
    }
    const base = { name: check.name, code: r.code, output: r.output }
    if (typeof r.code !== 'number') return { ...base, passed: false, note: 'check runner failed', broken: true }
    if (check.timeout && r.code === 127 && TIMEOUT_MISSING.test(r.output)) return { ...base, passed: false, note: `${timeoutCommand} command not found`, broken: true }
    if (!r.ran || r.code !== 0) {
      const timedOut = check.timeout && r.code === 124 ? { note: `timed out after ${check.timeout}s` } : {}
      return { ...base, passed: false, ...timedOut }
    }
    if (!check.metric) return { ...base, passed: true }
    const { pattern, min, max } = check.metric
    const value = Number.parseFloat([...r.output.matchAll(new RegExp(pattern, 'gm'))].at(-1)?.[1] ?? '')
    if (!Number.isFinite(value)) return { ...base, passed: false, note: 'metric not found in output' }
    const metric = { metric: value }
    if (min !== undefined && value < min) return { ...base, ...metric, passed: false, note: `metric ${value} is below min ${min}` }
    if (max !== undefined && value > max) return { ...base, ...metric, passed: false, note: `metric ${value} is above max ${max}` }
    return { ...base, ...metric, passed: true }
  }

  const detail = (r: CheckResult) => r.note ?? `exit ${r.code}`

  const commitWork = async (lane: Lane, name: string, at: string, stage?: StageTask): Promise<Committed> => {
    const dirty = await uncommitted(`status ${name} ${at}`, 'Implement', lane.cwd)
    if (!Array.isArray(dirty)) return { unread: dirty.unreadable }
    if (!dirty.length) return {}
    host.log(`${name}: uncommitted changes after ${at} - asking the implementer to commit them: ${listed(dirty)}`)
    const label = `commit ${name} ${at}`
    const impl = await implement(lane, label, commitPrompt(lane.p, name, at, dirty.join('\n'), plansIn(lane.cwd), stage))
    const left = await uncommitted(`status ${name} ${at} after commit`, 'Implement', lane.cwd)
    return { impl, by: `the commit step (${label})`, ...(!Array.isArray(left) ? { unread: left.unreadable } : left.length ? { left } : {}) }
  }

  const unreviewed = (name: string, at: string, { left, unread }: Committed) => {
    if (!left && !unread) return undefined
    const note = unread
      ? `working tree status unreadable after ${at} (${unread}) - the review saw HEAD and may have missed uncommitted work`
      : `uncommitted changes after ${at}: ${listed(left!)} - the review saw HEAD without them`
    host.log(`${name}: ${note}`)
    return note
  }

  const checkGate = async (
    lane: Lane,
    name: string,
    at: string,
    checks: CheckConfig[],
    runs: CheckRun[],
    stage?: StageTask,
    gates?: Gates,
    steps?: Implementation[],
  ): Promise<{ passed: boolean; note?: string }> => {
    host.phase(CHECKS_PHASE)
    const budget = (c: CheckConfig) => c.maxRepairs ?? config.maxRepairs
    const most = Math.max(0, ...checks.map(budget))
    let deviations: string | undefined
    const step = async (label: string, by: string, prompt: string) => {
      const impl = await implement(lane, label, prompt)
      steps?.push(impl)
      if (gates) Object.assign(gates, { green: impl.gatesGreen, text: impl.gates, by: `${by} (${label})` })
      return saidSomething(impl.deviations)
    }
    for (let repairs = 0; ; repairs++) {
      const dirty = await uncommitted(`status ${name} ${at}`, CHECKS_PHASE, lane.cwd)
      if (!Array.isArray(dirty)) {
        const note = `checks not run at ${at} - working tree status unreadable (${dirty.unreadable})`
        host.log(`${name}: checks-failed - ${note}`)
        return { passed: false, note }
      }
      if (dirty.length && repairs >= most) {
        const note = `checks not run at ${at} - uncommitted changes: ${listed(dirty)}${repairs ? ` (still there after ${repairs} repair(s))` : ''}${deviations ? `\nthe last repair's deviations: ${deviations}` : ''}`
        host.log(`${name}: checks-failed - ${note}`)
        return { passed: false, note }
      }
      if (dirty.length) {
        host.log(`${name}: uncommitted changes before the checks at ${at} - repair ${repairs + 1}/${most}: ${listed(dirty)}`)
        deviations = await step(`commit ${name} ${at} #${repairs + 1}`, 'the commit step', commitPrompt(lane.p, name, at, dirty.join('\n'), plansIn(lane.cwd), stage))
        continue
      }
      const results: Array<CheckResult & { output: string; broken?: true }> = []
      for (const check of checks) results.push(await runCheck(lane, name, check))
      const head = (await readHead(`head ${name} ${at}`, CHECKS_PHASE, lane.cwd)).sha
      runs.push({ at, attempt: repairs + 1, ...(head ? { head } : {}), results: results.map(({ output, broken, ...r }) => r) })
      const failed = results.filter(r => !r.passed)
      if (!failed.length) {
        host.log(`${name}: checks green${repairs ? ` after ${repairs} repair${repairs > 1 ? 's' : ''}` : ''} (${at}: ${checks.map(c => c.name).join(', ')})`)
        return { passed: true }
      }
      const broken = failed.filter(r => r.broken)
      if (broken.length) {
        const note = `checks failed at ${at}: check runner failed: ${broken.map(r => `${r.name} (${r.output.slice(-300)})`).join(', ')} - the command's own result is unknown, so no repair was spent on it`
        host.log(`${name}: checks-failed - ${note}`)
        return { passed: false, note }
      }
      const configOf = (r: CheckResult) => checks.find(c => c.name === r.name)!
      const spent = failed.filter(r => repairs >= budget(configOf(r)))
      if (spent.length) {
        const note = `checks failed at ${at} after ${repairs} repair(s): ${failed.map(r => `${r.name} (${detail(r)})`).join(', ')}; out of repairs: ${spent.map(r => `${r.name} (${budget(configOf(r))})`).join(', ')}${deviations ? `\nthe last repair's deviations: ${deviations}` : ''}`
        host.log(`${name}: checks-failed - ${note}`)
        return { passed: false, note }
      }
      for (const r of failed) host.log(`${name}: check ${r.name} failed (${detail(r)}) - repair ${repairs + 1}/${budget(configOf(r))}`)
      const sent: FailedCheck[] = failed.map(r => ({ ...r, run: configOf(r).run }))
      deviations = await step(`repair ${name} ${at} #${repairs + 1}`, 'the last repair', repairPrompt(lane.p, name, at, repairs + 1, sent, stage))
    }
  }

  const fixPlan = async (label: string, prompt: string): Promise<PlanFix> => {
    const r = (await call('implementer', 'planFix', label, PLAN_PHASE, prompt, 'write', config.roles.implementer, worktree)) as PlanFix | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: plan edited - ${Array.isArray(r.files) && r.files.length ? r.files.join(', ') : 'no file reported'}`)
    return r
  }

  const trailed: Omit<TrailSummary, 'dir'> = { written: 0, failed: [] }
  const saveTrail = async (cwd: string, record: TrailRound, at: string, phase: string) => {
    const id = trailId(record.loop, record.round)
    const path = trailPath(config, cwd, record.loop, record.round)
    const why: string[] = []
    let ok = false
    try {
      ok = await writeChecked({
        path,
        text: trailText(record),
        cwd,
        phase,
        what: 'the record',
        labels: { write: `trail ${id}`, retry: `trail ${id} retry`, size: `trail ${id} size` },
        ask: trailWritePrompt,
        log: line => why.push(line),
      })
    } catch (e) {
      if (isCancelled(e)) throw e
      why.push(String((e as Error)?.message ?? e))
    }
    if (ok) trailed.written++
    else {
      trailed.failed.push(id)
      host.log(`${at}: trail record not written: ${path}${why.length ? ` (${why.join('; ')})` : ''}`)
    }
  }
  const trailHead = async (label: string, phase: string, cwd: string): Promise<string | undefined> => {
    try {
      return (await readHead(label, phase, cwd)).sha
    } catch (e) {
      if (isCancelled(e)) throw e
      host.log(`${label}: could not read HEAD for the trail record: ${String((e as Error)?.message ?? e)}`)
      return undefined
    }
  }
  const trailOf = (): { trail?: TrailSummary } => (config.trail ? { trail: { dir: trailDir(config, worktree), written: trailed.written, failed: [...trailed.failed] } } : {})

  const reviewLoop = async (
    lane: Lane,
    name: string,
    subject: Subject,
    reviewers = config.reviewers,
    opts: {
      loop: string
      head?: string
      gates?: Gates
      checks?: CheckConfig[]
      runs?: CheckRun[]
      notes?: string[]
      prior?: EarlierRound[]
      record?: { loop: NonNullable<EarlierRound['loop']>; into: EarlierRound[] }
    },
  ): Promise<PlanResult> => {
    const { gates, checks = [], runs = [], notes = [], prior = [], record } = opts
    const { p } = lane
    const phase = phaseOf(subject)
    const trailCwd = repoState.get(lane.repo)?.lane.cwd ?? lane.cwd
    let known = opts.head ?? runs.at(-1)?.head
    const history: RoundRecord[] = []
    const earlier: EarlierRound[] = [...prior]
    let unmerged: Finding[] = []
    let carried: Array<{ round: number; labels: string[]; finding: Finding }> = []
    const kept = () => carried.map(c => c.finding)
    for (let round = 1; round <= config.maxRounds; round++) {
      const reviewedSha = config.trail && subject.kind !== 'plan' ? (known ?? (await trailHead(`head ${name} r${round}`, phase, lane.cwd))) : undefined
      known = undefined
      const results = await reviewAll(lane, reviewers, name, subject, round)
      const facts: RoundFacts = {
        loop: opts.loop,
        name,
        round,
        base: subject.kind === 'diff' ? subject.base : lane.base,
        ...(reviewedSha ? { reviewedSha } : {}),
        reviewers: results.filter(r => r.ran).map(r => reviewerMeta(r.reviewer, host)),
        findings: [],
      }
      const keep = async (more: Partial<RoundFacts>) => {
        if (config.trail) await saveTrail(trailCwd, trailRound({ ...facts, ...more }), `${name} r${round}`, phase)
      }
      const failed = results.filter(r => !r.ran)
      const found = results.filter(r => r.ran).flatMap(r => r.findings)
      if (failed.length) {
        const names = new Set(failed.map(r => r.reviewer.name))
        const byFailed = (f: Finding) => f.reviewer !== undefined && names.has(f.reviewer)
        const earlier = (history.at(-1)?.findings ?? []).flatMap(f =>
          byFailed(f) ? [f] : unmerged.filter(d => byFailed(d) && f.duplicates?.includes(d.id)),
        )
        const note = [`reviewer(s) that did not run, also on a retry: ${[...names].join(', ')}`, ...failed.map(r => `${r.reviewer.name}: ${r.note ?? 'no output'}`)].join('\n')
        host.log(`${name} r${round}: review failed - stopping this stage's loop. ${note}`)
        await keep({ findings: found, outcome: 'review-failed', note })
        return { outcome: 'review-failed', rounds: round, residual: [], unresolved: [...found, ...earlier], history, note }
      }
      if (!found.length) {
        host.log(`${name} r${round}: clean`)
        host.round?.({ subject: name, round, findings: [] })
        await keep({ outcome: 'clean' })
        return { outcome: 'clean', rounds: round, residual: kept(), unresolved: [], history }
      }

      const declined = new Map(earlier.flatMap(e => (e.declined ?? []).map(d => [roundLabel(e.round, d, e.loop), d.reason] as const)))
      const ledger = new Map(earlier.flatMap(e => [...e.sent, ...(e.residual ?? [])].map(f => [roundLabel(e.round, f, e.loop), f] as const)))
      const earlierOf = (f: Finding) => (f.repeatOf === undefined ? undefined : ledger.get(f.repeatOf))
      const blockers = found.filter(isBlocker)
      const judged = declined.size ? found : found.filter(f => !isBlocker(f))
      const unjudgedBlockers = new Set(declined.size ? [] : blockers.map(f => f.id))
      if (blockers.length && declined.size) {
        host.log(`${name} r${round}: ${blockers.length} P0/P1 finding(s) go to the judge too - the fixer declined findings before, so a repeat of one can stay residual: ${blockers.map(f => f.id).join(', ')}`)
      } else if (blockers.length) {
        host.log(`${name} r${round}: ${blockers.length} P0/P1 finding(s) go to the implementer without the judge: ${blockers.map(f => f.id).join(', ')}`)
      }
      const declinedBefore = (f: Finding) => f.repeatOf !== undefined && declined.has(f.repeatOf)
      const policy = { threshold: config.threshold, alwaysFix: config.alwaysFix, rideAlong: config.rideAlong }
      let findings = found.map(f => decide(f, undefined, policy, declinedBefore))
      unmerged = findings
      if (judged.length) {
        const prompt = subject.kind === 'plan' ? planJudgePrompt(p, subject.files, judged, earlier) : judgePrompt(p, subject.base, judged, earlier, subject.stage, subject.note)
        const label = `judge ${name} r${round}`
        const judgedIds = new Set(judged.map(f => f.id))
        const blockerIds = new Set(blockers.map(f => f.id))
        const decideAll = (per: JudgeEntry[]) =>
          found.map(f => {
            const s = judgedIds.has(f.id) ? per.find(x => x.id === f.id) : undefined
            const repeat = typeof s?.repeatOf === 'string' && ledger.has(s.repeatOf) ? { repeatOf: s.repeatOf } : {}
            return decide({ ...f, ...repeat }, s, policy, declinedBefore, earlierOf)
          })
        const { per, decided: withScores } = await judgeAnswers({
          at: `${name} r${round}`,
          label,
          prompt,
          ids: judgedIds,
          ask: (l, text) => call('judge', 'judge', l, phase, text, 'read-only', config.roles.judge, lane.cwd),
          apply: decideAll,
          leftTo: 'to the implementer unjudged (rule 2)',
        })
        const duplicateOf = new Map(
          per
            .filter(x => judgedIds.has(x.id) && typeof x.duplicateOf === 'string' && judgedIds.has(x.duplicateOf))
            .filter(x => !blockerIds.has(x.id) || blockerIds.has(x.duplicateOf as string))
            .map(x => [x.id, x.duplicateOf as string]),
        )
        const merge = mergeDuplicates(withScores, duplicateOf)
        for (const m of merge.merged) host.log(`${name} r${round}: judge merged ${m.id} into ${m.into} (duplicate)`)
        unmerged = withScores
        findings = rideAlong(merge.findings, policy, declinedBefore)
      }
      history.push({ round, findings })
      host.log(`${name} r${round}: ${findings.length} finding(s)`)

      const { accepted, residual } = triage(findings)
      const routed: Partial<RoundFacts> = { findings, sent: accepted, blockers: unjudgedBlockers }
      host.round?.({ subject: name, round, findings: findings.map(f => roundFinding(f, accepted.includes(f))) })
      const entry: EarlierRound = { round, sent: accepted, ...(residual.length ? { residual } : {}) }
      const recorded = record ? { ...entry, loop: record.loop } : undefined
      if (recorded) record!.into.push(recorded)
      const ruled = (f: Finding) => `rule ${f.decision!.rule}: ${f.decision!.why}`
      for (const f of findings.filter(f => f.decision!.raised)) host.log(`${name} r${round}: the ratchet raised ${f.id} - ${f.decision!.raised}`)
      if (accepted.length) host.log(`${name} r${round}: to the implementer: ${accepted.map(f => `${f.id} (${ruled(f)})`).join(', ')}`)
      for (const f of residual.filter(declinedBefore)) {
        host.log(`${name} r${round}: ${f.id} dropped as a repeat of ${f.repeatOf}, which the fixer declined (${ruled(f)}) - kept as residual`)
      }
      const repeated = new Set(unmerged.flatMap(f => (f.repeatOf ? [f.repeatOf] : [])))
      const repeatsOf = (f: Finding) => new Set(unmerged.filter(u => u.id === f.id || f.duplicates?.includes(u.id)).flatMap(u => (u.repeatOf ? [u.repeatOf] : [])))
      const aliases = (f: Finding) => {
        const of = repeatsOf(f)
        return carried.filter(c => c.labels.some(l => of.has(l))).flatMap(c => c.labels)
      }
      carried = [
        ...carried.filter(c => !c.labels.some(l => repeated.has(l))),
        ...residual.map(f => ({ round, labels: [roundLabel(round, f), ...aliases(f)], finding: f })),
      ]
      if (residual.length) {
        host.log(`${name} r${round}: ${residual.length} finding(s) kept as residual, not sent: ${residual.map(f => `${f.id} (${ruled(f)})`).join(', ')}`)
        for (const f of residual.filter(f => f.decision!.attention)) host.log(`${name} r${round}: ATTENTION ${f.id} is pre-existing with impact ${f.impact} - left for the user`)
      }
      if (!accepted.length) {
        host.log(`${name} r${round}: nothing actionable left - stage done with ${carried.length} residual finding(s) for the user`)
        await keep({ ...routed, outcome: 'residual-only' })
        return { outcome: 'residual-only', rounds: round, residual: kept(), unresolved: [], history }
      }

      const overruled: Overruled[] = accepted.filter(declinedBefore).map(f => ({ id: f.id, repeatOf: f.repeatOf!, reason: f.reason, said: declined.get(f.repeatOf!)! }))
      for (const o of overruled) {
        host.log(`${name} r${round}: the judge overruled the fixer on ${o.id} (repeat of ${o.repeatOf}, ${ruled(accepted.find(f => f.id === o.id)!)})`)
      }

      let fixed: { deviations?: string; declined?: unknown }
      let fixWork: Implementation | undefined
      const fixLabel = `fix ${name} r${round}`
      if (subject.kind === 'plan') {
        fixed = await fixPlan(fixLabel, planFixPrompt(p, subject.files, round, accepted, overruled))
      } else {
        const fix = await implement(lane, fixLabel, fixPrompt(p, name, round, accepted, overruled))
        if (gates) Object.assign(gates, { green: fix.gatesGreen, text: fix.gates, by: `the last fix (${fixLabel})` })
        if (!fix.gatesGreen) host.log(`${name} r${round}: WARNING fixer left gates red - ${fix.gates}`)
        fixed = fix
        fixWork = fix
      }
      const said = saidSomething(fixed.deviations)
      const { declined: refused, unknown } = declinedOf(fixed.declined, accepted)
      if (unknown.length) host.log(`${name} r${round}: the fixer declined id(s) it was not sent - ignored: ${unknown.join(', ')}`)
      if (refused.length) host.log(`${name} r${round}: the fixer declined ${refused.map(d => d.id).join(', ')}`)
      if (said) history.at(-1)!.deviations = said
      if (refused.length) history.at(-1)!.declined = refused
      const reply = { ...(said ? { deviations: said } : {}), ...(refused.length ? { declined: refused } : {}) }
      earlier.push({ ...entry, ...reply })
      if (recorded) Object.assign(recorded, reply)
      const later: Implementation[] = []
      const before = runs.length
      const fixFacts = (): Partial<RoundFacts> => {
        const head = runs.length > before ? runs.at(-1)!.head : undefined
        const commitsOf = (i: Implementation) => (Array.isArray(i.commits) ? i.commits : [])
        const done = fixWork && {
          startSha: fixWork.startSha,
          headSha: head ?? later.at(-1)?.headSha ?? fixWork.headSha,
          commits: [fixWork, ...later].flatMap(commitsOf),
        }
        return { ...routed, overruled: overruled.map(o => ({ id: o.id, said: o.said })), fix: { label: fixLabel, ...(done ? { work: done } : {}), refused, ...(said ? { said } : {}) } }
      }
      if (subject.kind === 'diff' && checks.length) {
        const gate = await checkGate(lane, name, `fix r${round}`, checks, runs, subject.stage, gates, later)
        if (!gate.passed) {
          await keep({ ...fixFacts(), outcome: 'checks-failed', ...(gate.note ? { note: gate.note } : {}) })
          return { outcome: 'checks-failed', rounds: round, residual: kept(), unresolved: [], history, note: gate.note }
        }
        known = runs.at(-1)?.head
        host.phase(phase)
      } else if (subject.kind === 'diff') {
        const left = await commitWork(lane, name, `fix r${round}`, subject.stage)
        if (left.impl) later.push(left.impl)
        if (left.impl && gates) Object.assign(gates, { green: left.impl.gatesGreen, text: left.impl.gates, by: left.by })
        const note = unreviewed(name, `fix r${round}`, left)
        if (note) notes.push(note)
      }
      await keep({ ...fixFacts(), ...(round === config.maxRounds ? { outcome: 'round-cap' as const } : {}) })
    }
    host.log(`${name}: hit the ${config.maxRounds}-round cap without a clean review`)
    return { outcome: 'round-cap', rounds: config.maxRounds, residual: carried.filter(c => c.round < config.maxRounds).map(c => c.finding), unresolved: history.at(-1)?.findings ?? [], history }
  }

  const reviewThePlan = async (): Promise<PlanResult | undefined> => {
    const skipped = (outcome: 'skipped' | 'review-skipped', why: string): PlanResult => {
      host.log(why)
      return { outcome, rounds: 0, residual: [], unresolved: [], history: [] }
    }
    if (!plans.length) return undefined
    if (!config.planReview) return skipped('review-skipped', 'plan review off (planReview: false)')
    if (fromStage > 1) return skipped('skipped', `plan review skipped - the run resumes from stage ${fromStage}`)

    host.phase(PLAN_PHASE)
    host.log(planReviewWarning(config.maxRounds))
    const name = 'plan review'
    const able = config.reviewers.filter(rv => rv.engine !== 'command' || rv.command?.includes('{prompt}'))
    const unable = config.reviewers.filter(rv => !able.includes(rv))
    for (const rv of unable) host.log(`${name}: reviewer ${rv.name} skipped - its command has no {prompt}, so it cannot review a plan`)
    if (!able.length) {
      const note = `no reviewer can review a plan: ${unable.map(rv => rv.name).join(', ')} ${unable.length > 1 ? 'have commands' : 'has a command'} without {prompt} - add a reviewer that can, or set planReview to false`
      host.log(`${name}: ${note}`)
      return { outcome: 'review-failed', rounds: 0, residual: [], unresolved: [], history: [], note }
    }
    return reviewLoop(primaryLane, name, { kind: 'plan', files: plans }, able, { loop: 'plan' })
  }

  const planResult = await reviewThePlan()
  if (draft) {
    host.log(`plan written - the run stops here; launch again with plan and the approved stages to implement it`)
    return { repo: input.repo, branch: input.branch, base, worktree, draft, ...(planResult ? { plan: planResult } : {}), stages: [], final: null, ...trailOf() }
  }
  if (planResult && (planResult.outcome === 'round-cap' || planResult.outcome === 'review-failed')) {
    host.log(`plan review ended ${planResult.outcome} - stopping before stage 1; nothing was implemented`)
    return { repo: input.repo, branch: input.branch, base, worktree, plan: planResult, stages: [], final: null, ...trailOf() }
  }

  const tryLock = (s: RepoState) => (s.locked ? false : (s.locked = true))
  const lock = (s: RepoState) => new Promise<void>(resolve => (tryLock(s) ? resolve() : s.waiters.push(resolve)))
  const unlock = (s: RepoState) => {
    const next = s.waiters.shift()
    if (next) next()
    else s.locked = false
  }

  const ledgerOf = (st: StageSpec, i: number): EarlierRound[] => {
    const ledger = repoState.get(repoOf(st))!.ledger
    if (!ledger.has(i)) ledger.set(i, [])
    return ledger.get(i)!
  }

  /** A stage is built in steps when stepAgents is on and it has two or more steps; one step is built as a stage without steps. */
  const stepAgentsOf = (st: StageSpec): boolean => config.stepAgents && (st.steps?.length ?? 0) > 1

  const implementSteps = async (lane: Lane, st: StageSpec, i: number, name: string, task: StageTask | undefined, notes: string[], ran: StepRun[]): Promise<Implementation> => {
    const steps = st.steps!
    for (let k = 0; k < steps.length; k++) {
      const at = `step ${k + 1}/${steps.length}`
      const impl = await implement(lane, `implement ${name} ${at}`, implementStepPrompt(lane.p, st, i, specs.length, name, k, buildsOnEarlier(i)))
      ran.push({ name: stepName(steps[k], k), implementation: impl })
      if (k === steps.length - 1) break
      if (!impl.gatesGreen) host.log(`${name}: ${at} ended with RED gates`)
      const { left, unread } = await commitWork(lane, name, at, task)
      if (left || unread) {
        const note = unread ? `working tree status unreadable after ${at} (${unread})` : `uncommitted changes after ${at}: ${listed(left!)} - step ${k + 2}/${steps.length} started on them`
        host.log(`${name}: ${note}`)
        notes.push(note)
      }
    }
    return mergeSteps(ran)
  }

  const runStage = async (lane: Lane, st: StageSpec, i: number, name: string, began?: (start?: string) => void): Promise<StageResult> => {
    let impl: Implementation | undefined
    let base = lane.base
    const where = st.repo !== undefined && repoOf(st) !== primary ? { repo: repoOf(st) } : {}
    const task: StageTask | undefined = st.task ? { number: i + 1, total: specs.length, name, task: st.task } : undefined
    const checks = checksOf(st)
    const runs: CheckRun[] = []
    const ran = () => (runs.length ? { checks: runs } : {})
    const stepRuns: StepRun[] = []
    const stepsOut = () => (stepRuns.length ? { steps: stepRuns } : {})
    const notes: string[] = []
    let committed: Committed = {}
    let gates: Gates | undefined
    if (st.implement !== false) {
      host.phase('Implement')
      const head = await readHead(`head ${name}`, 'Implement', lane.cwd)
      const start = head.sha
      began?.(start)
      if (start) base = start
      else host.log(`${name}: could not read HEAD before the implementer ran - reviewing ${lane.base}...HEAD instead (exit ${head.code}): ${head.output.slice(-500)}`)
      impl = stepAgentsOf(st)
        ? await implementSteps(lane, st, i, name, task, notes, stepRuns)
        : await implement(lane, `implement ${name}`, implementPrompt(lane.p, st, i, specs.length, name, buildsOnEarlier(i)))
      if (!impl.gatesGreen) host.log(`${name}: implementer ended with RED gates - review will see it`)
      if (start && impl.startSha !== start) host.log(`${name}: the implementer reported startSha ${impl.startSha}, but HEAD was ${start} before it ran - reviewing ${start}...HEAD`)
      const commits = async (label: string, since = base) => {
        const count = await shell(label, 'Implement', `git rev-list --count ${shellQuote(since)}..HEAD`, lane.cwd)
        const n = count.ran ? lineShaped(count.output, COUNT) : undefined
        if (n !== undefined) return Number(n)
        host.log(`${name}: could not count the commits in ${since}..HEAD - reviewing it anyway (exit ${count.code}): ${count.output.slice(-500)}`)
        return undefined
      }
      let count = await commits(`commits ${name}`)
      if (count === 0) {
        committed = await commitWork(lane, name, 'implement', task)
        if (committed.impl) count = await commits(`commits ${name} after commit`)
      }
      const resumed = count === 0 && fromStage > 1 && i === fromStage - 1
      if (resumed) {
        count = await commits(`commits ${name} on resume`, lane.base)
        if (count !== 0) {
          host.log(`${name}: no new commit on resume - reviewing ${lane.base}...HEAD instead`)
          base = lane.base
        }
      }
      if (count === 0) {
        const { left, unread } = committed
        const note = left
          ? `the implementer made no commit: the work it left is uncommitted (${listed(left)}), so there was nothing to review`
          : `the implementer made no commit: ${base}..HEAD is empty${resumed ? `, and so is ${lane.base}..HEAD on this resume` : ''}, so there was nothing to review${unread ? `; the working tree status could not be read (${unread}), so uncommitted work may be left` : ''}`
        host.log(`${name}: no-changes - ${note}`)
        return { stage: name, ...where, implementation: impl, outcome: 'no-changes', rounds: 0, residual: [], unresolved: [], history: [], note: [note, ...notes].join('\n'), ...stepsOut() }
      }
      const last = committed.impl ?? impl
      gates = { green: last.gatesGreen, text: last.gates, by: committed.by ?? 'the implementer' }
      if (checks.length) {
        const gate = await checkGate(lane, name, 'implement', checks, runs, task, gates)
        if (!gate.passed) return { stage: name, ...where, implementation: impl, outcome: 'checks-failed', rounds: 0, residual: [], unresolved: [], history: [], note: [gate.note, ...notes].filter(Boolean).join('\n'), ...ran(), ...stepsOut() }
      } else {
        if (!committed.impl) {
          committed = await commitWork(lane, name, 'implement', task)
          if (committed.impl) gates = { green: committed.impl.gatesGreen, text: committed.impl.gates, by: committed.by! }
        }
        const note = unreviewed(name, 'implement', committed)
        if (note) notes.push(note)
      }
    } else {
      began?.()
      host.log(`${name}: review-only stage - reviewing ${lane.base}...HEAD`)
    }

    host.phase('Review')
    const loop: PlanResult = st.review === false
      ? { outcome: 'review-skipped' as const, rounds: 0, residual: [], unresolved: [], history: [] }
      : await reviewLoop(
          lane,
          name,
          { kind: 'diff', base, ...(task ? { stage: task } : {}) },
          undefined,
          { loop: `s${i + 1}`, gates, checks, runs, notes, record: { loop: { id: `s${i + 1}`, name: `Stage ${i + 1} (${name})` }, into: ledgerOf(st, i) } },
        )
    if (gates && !gates.green && !runs.length && (loop.outcome === 'clean' || loop.outcome === 'residual-only')) {
      loop.outcome = 'gates-red'
      loop.note = `the review found nothing to fix, but ${gates.by} left the gates red: ${gates.text}`
      host.log(`${name}: gates-red - ${loop.note}`)
    }
    if (gates && !gates.green && runs.length && loop.outcome !== 'checks-failed') {
      const warned = `the checks passed, but ${gates.by} reported red gates: ${gates.text}`
      host.log(`${name}: ${warned}`)
      notes.push(warned)
    }
    const note = [loop.note, ...notes].filter(Boolean).join('\n')
    return { stage: name, ...where, ...(impl ? { implementation: impl } : {}), ...loop, ...(note ? { note } : {}), ...ran(), ...stepsOut() }
  }

  const mergeLane = async (state: RepoState, lane: Lane, name: string): Promise<string | undefined> => {
    const main = state.lane
    const label = `merge ${name}`
    const merged = await shell(label, 'Implement', `git merge --no-edit ${shellQuote(lane.branch)}`, main.cwd)
    if (!merged.ran) {
      host.log(`${label}: conflicts merging ${lane.branch} into ${main.branch} - the implementer resolves them`)
      const fix = await implement(main, `resolve ${label}`, mergePrompt(main.p, name, lane.branch, merged.output))
      if (!fix.gatesGreen) host.log(`${label}: WARNING merge left gates red - ${fix.gates}`)
      const open = await shell(`check ${label}`, 'Implement', 'if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git status --short; exit 1; fi', main.cwd)
      if (!open.ran) throw new Error(`${label}: the merge of ${lane.branch} into ${main.branch} is still unfinished in ${main.cwd} - resolve it, then resume with fromStage: ${open.output.slice(-1000)}`)
    }
    const inHead = `git merge-base --is-ancestor ${shellQuote(lane.branch)} HEAD`
    const verified = await shell(`verify ${label}`, 'Implement', inHead, main.cwd)
    if (!verified.ran) {
      const why = merged.ran ? '' : ` - the merge stopped with: ${merged.output.slice(-1000)}`
      throw new Error(`${label}: ${lane.branch} is not merged into ${main.branch} (git merge-base --is-ancestor exit ${verified.code}) - its worktree ${lane.cwd} and branch ${lane.branch} are left in place; merge it in ${main.cwd}, then resume with fromStage${why}`)
    }
    host.log(merged.ran ? `${label}: ${lane.branch} merged into ${main.branch}` : `${label}: ${lane.branch} merged into ${main.branch} after the implementer resolved conflicts`)
    const done = merged.ran ? `ran in parallel on ${lane.branch}, merged` : `ran in parallel on ${lane.branch}, merged after the implementer resolved conflicts`
    const step = (marker: string) => `echo '[granny] ${marker}'`
    const cleanup = [
      inHead,
      step('lane merged'),
      `[ -z "$(git -C ${shellQuote(lane.cwd)} status --porcelain)" ]`,
      step('lane worktree clean'),
      `git worktree remove --force ${shellQuote(lane.cwd)}`,
      step('lane worktree removed'),
      `git branch -d ${shellQuote(lane.branch)}`,
    ].join(' && ')
    const cleaned = await shell(`cleanup ${name}`, 'Implement', cleanup, main.cwd)
    if (cleaned.ran) return done
    const reached = (marker: string) => cleaned.output.includes(`[granny] ${marker}`)
    const left = reached('lane worktree removed')
      ? `its worktree ${lane.cwd} was removed, but its branch ${lane.branch} was left in place`
      : `its worktree ${lane.cwd} and branch ${lane.branch} were left in place (${reached('lane worktree clean') ? 'git worktree remove failed' : reached('lane merged') ? 'uncommitted changes in the worktree' : 'the cleanup could not confirm the merge'})`
    host.log(`${label}: left ${reached('lane worktree removed') ? lane.branch : `${lane.cwd} (${lane.branch})`} in place - remove it yourself once you have checked it: ${cleaned.output.slice(-500)}`)
    return `${done}; ${left}`
  }

  const startStage = async (i: number): Promise<StageResult> => {
    const st = specs[i]!
    const name = st.name || `stage ${i + 1}`
    const state = repoState.get(repoOf(st))!
    if (tryLock(state)) {
      let began: (start?: string) => void = () => {}
      state.started = new Promise(resolve => (began = resolve))
      try {
        const result = await runStage(state.lane, st, i, name, began)
        if (result.outcome === 'checks-failed') state.red ??= i
        return result
      } finally {
        began()
        state.started = undefined
        unlock(state)
      }
    }
    const branch = `${input.branch}--s${i + 1}-${slug(name)}`
    host.log(`${name}: ${state.lane.branch} is busy in ${baseName(state.lane.repo)} - running in parallel on ${branch}`)
    const main = state.lane
    const started = state.started
    const from = async () => {
      const start = await started
      if (start) host.log(`${name}: branching ${branch} from ${start.slice(0, 8)}, where the stage still running on ${main.branch} started, not from its unfinished commits`)
      return start ?? input.branch
    }
    const setup = state.setup.then(async () => setUpWorktree(main.repo, branch, await from(), `worktree ${name}`, main.repo !== primary))
    state.setup = setup.catch(() => {})
    const cwd = await setup
    const others = [main.cwd, ...used.filter(o => o !== main.repo).map(o => cwdOf.get(o)!)]
    const lane: Lane = { repo: main.repo, base: main.base, branch, cwd, p: promptFor(main.repo, cwd, branch, others, `${main.cwd}/${config.workDir}/PR-BODY-s${i + 1}-${slug(name)}.md`), readable }
    const result = await runStage(lane, st, i, name)
    if (result.outcome === 'checks-failed') {
      const note = `ran in parallel on ${branch}; its checks stayed red, so it was not merged - its worktree ${cwd} is left in place`
      host.log(`${name}: ${note}`)
      return { ...result, note: result.note ? `${result.note}\n${note}` : note }
    }
    await lock(state)
    try {
      const note = await mergeLane(state, lane, name)
      state.merges++
      return note ? { ...result, note: result.note ? `${result.note}\n${note}` : note } : result
    } finally {
      unlock(state)
    }
  }

  const builds = specs.map((st, i) => {
    const d = new Set<number>()
    if (st.after !== undefined) for (const n of st.after) d.add(n - 1)
    else {
      for (let j = i - 1; j >= 0; j--) {
        if (repoOf(specs[j]!) === repoOf(st)) {
          d.add(j)
          break
        }
      }
    }
    return d
  })
  const deps = builds.map((d, i) => (!config.parallel && i > 0 ? new Set([...d, i - 1]) : d))
  const buildsOnEarlier = (i: number): boolean => {
    const seen = new Set<number>()
    const todo = [...deps[i]!]
    while (todo.length) {
      const j = todo.pop()!
      if (seen.has(j)) continue
      seen.add(j)
      if (repoOf(specs[j]!) === repoOf(specs[i]!)) return true
      todo.push(...deps[j]!)
    }
    return false
  }
  const limit = config.parallel ? config.maxParallel : 1
  const results: StageResult[] = []
  const done = new Set<number>()
  const running = new Map<number, Promise<void>>()
  const undelivered = new Set<number>()
  let failure: { error: unknown } | undefined
  const nameOf = (i: number) => `${i + 1} (${specs[i]!.name || `stage ${i + 1}`})`
  const stageEvent = (i: number, event: StageEvent['event'], outcome?: StageOutcome) => {
    try {
      host.stage?.({ number: i + 1, name: specs[i]!.name || `stage ${i + 1}`, event, ...(outcome ? { outcome } : {}) })
    } catch {}
  }
  for (let i = 0; i < fromStage - 1; i++) {
    results[i] = { stage: specs[i]!.name || `stage ${i + 1}`, outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [] }
    done.add(i)
  }
  for (;;) {
    if (!failure) {
      for (let i = 0; i < specs.length && running.size < limit; i++) {
        if (done.has(i) || running.has(i) || ![...deps[i]!].every(d => done.has(d))) continue
        const blocker = [...builds[i]!].find(d => undelivered.has(d))
        const red = repoState.get(repoOf(specs[i]!))!.red
        if (blocker !== undefined || red !== undefined) {
          const ended = blocker !== undefined ? results[blocker]!.outcome : undefined
          const note =
            blocker !== undefined
              ? `not started: it builds on ${nameOf(blocker)}, which ${ended === 'no-changes' || ended === 'checks-failed' ? `ended ${ended}` : 'was not started'}`
              : results[red!]?.note?.includes('check runner failed')
                ? `not started: ${nameOf(red!)} ended checks-failed because its check runner failed, so the state of ${input.branch} in this repo is unknown`
                : `not started: ${nameOf(red!)} ended checks-failed and left its red commits on ${input.branch} in this repo`
          host.log(`${specs[i]!.name || `stage ${i + 1}`}: ${note}`)
          results[i] = { stage: specs[i]!.name || `stage ${i + 1}`, outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [], note }
          done.add(i)
          undelivered.add(i)
          stageEvent(i, 'end', 'skipped')
          continue
        }
        if (running.size) host.log(`${specs[i]!.name || `stage ${i + 1}`}: starting in parallel with ${[...running.keys()].map(j => specs[j]!.name || `stage ${j + 1}`).join(', ')}`)
        stageEvent(i, 'start')
        running.set(
          i,
          startStage(i).then(
            r => {
              results[i] = r
              if (r.outcome === 'no-changes' || r.outcome === 'checks-failed') undelivered.add(i)
              done.add(i)
              running.delete(i)
              stageEvent(i, 'end', r.outcome)
            },
            error => {
              failure ??= { error }
              running.delete(i)
            },
          ),
        )
      }
    }
    if (!running.size) break
    await Promise.race(running.values())
  }
  const unfinished = specs.map((_, i) => i).filter(i => !done.has(i))
  if (failure) {
    const finished = [...done].sort((a, b) => a - b).filter(i => i >= fromStage - 1)
    if (!isCancelled(failure.error)) host.log(`a stage failed - waited for the stages already running. Finished: ${finished.map(nameOf).join(', ') || 'none'}. Not finished: ${unfinished.map(nameOf).join(', ')}`)
    throw failure.error
  }
  if (unfinished.length) throw new Error(`scheduler stopped with stages that never started: ${unfinished.map(nameOf).join(', ')}`)

  const states = [...repoState.values()]
  const stageCount = (s: RepoState) => specs.filter(st => repoOf(st) === s.lane.repo).length
  const finalRuns = new Map<RepoState, CheckRun[]>()
  const reusedHead = new Map<RepoState, string>()
  const finalReview = async (s: RepoState): Promise<PlanResult | undefined> => {
    const stages = stageCount(s)
    if (!stages) return undefined
    const name = s.lane.repo === primary ? 'final review' : `final review ${baseName(s.lane.repo)}`
    const runs: CheckRun[] = []
    const checks = finalChecksOf(s.lane.repo)
    const reviewed = config.finalReview && (stages > 1 || s.merges > 0)
    const single = stages === 1 && !s.merges ? specs.findIndex(st => repoOf(st) === s.lane.repo) : -1
    const last = single >= 0 ? results[single]?.checks?.at(-1) : undefined
    const known = last && !last.results.some(r => r.note === 'check runner failed')
    const same = checks.length && last && known && last.results.map(r => r.name).join('\n') === checks.map(c => c.name).join('\n')
    const now = same ? (last.head ? await readHead(`head ${name}`, CHECKS_PHASE, s.lane.cwd) : undefined)?.sha : undefined
    if (same && now && now === last.head) {
      reusedHead.set(s, now)
      const failed = last.results.filter(r => !r.passed)
      if (!failed.length) host.log(`${name}: final checks not rerun - ${nameOf(single)} ran them green last on ${short(now)}, HEAD unchanged`)
      else {
        const note = `checks failed at final: ${nameOf(single)} ended with ${failed.map(r => r.name).join(', ')} red on ${short(now)}, HEAD unchanged`
        host.log(`${name} not run - ${note}; the branch is not PR-ready, the final check still runs`)
        return { outcome: 'checks-failed', rounds: 0, residual: [], unresolved: [], history: [], note }
      }
    } else if (checks.length) {
      if (same) {
        const why = !last.head ? `could not read the HEAD ${nameOf(single)} last ran them on` : !now ? 'could not read HEAD' : `${nameOf(single)} ran them last on ${short(last.head)}, but HEAD is now ${short(now)}`
        host.log(`${name}: running the final checks - ${why}${now && last.head ? '' : ', so their result is not reused'}`)
      }
      finalRuns.set(s, runs)
      const red = specs.findIndex((st, i) => repoOf(st) === s.lane.repo && results[i]?.outcome === 'checks-failed')
      const noRepairs = !reviewed ? 'no final review follows to see one' : red >= 0 ? `${nameOf(red)} already ended checks-failed` : undefined
      if (noRepairs) host.log(`${name}: the final checks get no repairs - ${noRepairs}`)
      const gate = await checkGate(s.lane, name, 'final', noRepairs ? checks.map(c => ({ ...c, maxRepairs: 0 })) : checks, runs)
      if (!gate.passed) {
        host.log(`${name} not run - the final checks failed, so the branch is not PR-ready; the final check still runs`)
        return { outcome: 'checks-failed', rounds: 0, residual: [], unresolved: [], history: [], note: gate.note }
      }
    }
    const skipped = (outcome: 'skipped' | 'review-skipped', log: string, note: string): PlanResult => {
      host.log(log)
      return { outcome, rounds: 0, residual: [], unresolved: [], history: [], note }
    }
    if (!config.finalReview) return skipped('review-skipped', `${name} off (finalReview: false)`, 'off (finalReview: false)')
    const why = 'one stage and no lane merge, so its stage review already covered the whole branch'
    if (!reviewed) return skipped('skipped', `${name} skipped - ${why}`, why)
    host.phase(FINAL_REVIEW_PHASE)
    host.log(`${name}: reviewing ${s.lane.base}...HEAD across ${stages} stage(s)${s.merges ? ` and ${s.merges} lane merge(s)` : ''}`)
    const notes: string[] = []
    const prior = [...s.ledger].sort(([a], [b]) => a - b).flatMap(([, rounds]) => rounds)
    const loop = s.lane.repo === primary ? 'final' : `final-${slug(baseName(s.lane.repo))}`
    const head = reusedHead.get(s)
    const looped = await reviewLoop(s.lane, name, { kind: 'diff', base: s.lane.base, note: WHOLE_BRANCH_NOTE }, undefined, { loop, ...(head ? { head } : {}), checks, runs, notes, prior })
    const note = [looped.note, ...notes].filter(Boolean).join('\n')
    const r = note ? { ...looped, note } : looped
    if (r.outcome === 'checks-failed') host.log(`${name} ended checks-failed - the final check still runs, but the branch is not PR-ready`)
    if (r.outcome === 'round-cap' || r.outcome === 'review-failed') {
      host.log(`${name} ended ${r.outcome} - the final check still runs, but the branch has ${r.unresolved.length} unresolved finding(s)`)
    }
    return r
  }
  const reviews = new Map<RepoState, PlanResult | undefined>()
  if (config.parallel) (await Promise.all(states.map(async s => [s, await finalReview(s)] as const))).forEach(([s, r]) => reviews.set(s, r))
  else for (const s of states) reviews.set(s, await finalReview(s))

  host.phase('PR ready')
  const recheck = async (s: RepoState, label: string, runs: CheckRun[]): Promise<Recheck | undefined> => {
    const checks = stageCount(s) ? finalChecksOf(s.lane.repo) : []
    if (!checks.length) return undefined
    const gated = runs.length ? runs.at(-1)!.head : reusedHead.get(s)
    const now = (await readHead(`head ${label}`, 'PR ready', s.lane.cwd)).sha
    if (gated && now === gated) return undefined
    host.log(
      `${label}: ${gated && now ? `HEAD moved from ${short(gated)} to ${short(now)} after the final checks` : 'could not read HEAD after the pr-ready check or at the final checks'} - running them once more, without repairs`,
    )
    const gate = await checkGate(s.lane, label, 'pr-ready', checks.map(c => ({ ...c, maxRepairs: 0 })), runs)
    if (!gate.passed) {
      host.log(`${label}: the checks are red after the pr-ready check - the branch is not PR-ready`)
      return { passed: false, note: gate.note }
    }
    const left = await uncommitted(`status ${label} after the checks`, 'PR ready', s.lane.cwd)
    if (!Array.isArray(left)) {
      host.log(`${label}: could not read the working tree status after the checks - the branch is not PR-ready`)
      return { passed: false, note: `working tree status unreadable after the checks at pr-ready (${left.unreadable})` }
    }
    if (!left.length) return { passed: true }
    host.log(`${label}: the checks left uncommitted changes after the pr-ready check - the branch is not PR-ready: ${listed(left)}`)
    return { passed: false, note: `uncommitted changes after the checks at pr-ready: ${listed(left)}` }
  }

  const outcomesOf = (s: RepoState): RunOutcomes => {
    const own = specs.flatMap((st, i) => (repoOf(st) === s.lane.repo ? [i] : []))
    const resumed = 'it ran in an earlier run, which this run resumes: keep what the PR body says about it'
    const review = reviews.get(s)
    return {
      stages: own.map(i => (i < fromStage - 1 ? { ...results[i]!, note: resumed } : results[i]!)),
      ...(review ? { finalReview: review } : {}),
      ...(planResult && s.lane.repo === primary ? { plan: fromStage > 1 && planResult.outcome === 'skipped' ? { ...planResult, note: resumed } : planResult } : {}),
      reviewOnly: own.length > 0 && own.every(i => specs[i]!.implement === false),
    }
  }

  const check = async (s: RepoState): Promise<RepoResult> => {
    const label = s.lane.repo === primary ? 'pr-ready check' : `pr-ready check ${baseName(s.lane.repo)}`
    const final = (await call('granny', 'final', label, 'PR ready', finalPrompt(s.lane.p, plansIn(s.lane.cwd), outcomesOf(s)), 'write', config.roles.granny, s.lane.cwd)) as FinalReport | null
    if (!final) host.log(s.lane.repo === primary ? 'final check returned nothing' : `${label} returned nothing`)
    const review = reviews.get(s)
    const runs = finalRuns.get(s) ?? []
    const again = await recheck(s, label, runs)
    return { repo: s.lane.repo, base: s.lane.base, worktree: s.lane.cwd, ...(review ? { finalReview: review } : {}), ...(runs.length ? { checks: runs } : {}), ...(again ? { recheck: again } : {}), final }
  }
  const finals: RepoResult[] = []
  if (config.parallel) finals.push(...(await Promise.all(states.map(check))))
  else for (const s of states) finals.push(await check(s))

  const final = finals[0]!.final
  const primaryReview = finals[0]!.finalReview
  const primaryChecks = finals[0]!.checks
  const primaryRecheck = finals[0]!.recheck
  return {
    repo: input.repo,
    branch: input.branch,
    base,
    worktree,
    ...(planResult ? { plan: planResult } : {}),
    stages: results,
    ...(primaryReview ? { finalReview: primaryReview } : {}),
    ...(primaryChecks ? { checks: primaryChecks } : {}),
    ...(primaryRecheck ? { recheck: primaryRecheck } : {}),
    final,
    ...(finals.length > 1 ? { repos: finals } : {}),
    ...trailOf(),
  }
}

export interface JudgeInput {
  repo: string
  base?: string
  context?: string
  config?: unknown | unknown[]
}

export function checkJudgeInput(input: JudgeInput): string[] {
  if (!input || typeof input !== 'object') return ['input must be an object']
  const errors: string[] = []
  if (typeof input.repo !== 'string' || !input.repo.startsWith('/')) errors.push('repo must be an absolute path')
  if (input.base !== undefined && (typeof input.base !== 'string' || !input.base)) errors.push('base must be a non-empty string')
  if (input.context !== undefined && typeof input.context !== 'string') errors.push('context must be a string')
  return errors
}

const TAG_POLICY: Policy = { threshold: 100, alwaysFix: [] }
const DATE_STAMP = /^\d{8}-\d{6}$/
const BRANCH_LINE = /^\S+$/

/** One review round of `<base>...HEAD` in the checkout as it is, one tagging of its findings, and a report file. It changes nothing else. */
export async function runJudge(host: Host, input: JudgeInput): Promise<JudgeResult> {
  const inputErrors = checkJudgeInput(input)
  if (inputErrors.length) throw new Error(`Invalid granny judge input:\n- ${inputErrors.join('\n- ')}`)

  const layers = configLayers(input)
  const gaps = judgeConfigGaps(layers, host.name)
  if (gaps.length) throw new Error(`granny judge needs models: ${gaps.join('; ')}`)
  const config = resolveConfig(layers, host.name)
  const { call, shell, readHead, writeChecked, uncommitted, reviewAll, judgeAnswers } = engineParts(host, config)
  const repo = trimPath(input.repo)
  const base = input.base ?? config.base

  host.phase(REVIEW_PHASE)
  const excluded = await shell('exclude', REVIEW_PHASE, excludeScript(config), repo, judgeStepPrompt)
  if (!excluded.ran) host.log(`could not add ${config.workDir}/ to the git excludes, so the report may show as untracked (exit ${excluded.code}): ${excluded.output.slice(-300)}`)
  const needed = async (label: string, script: string, ask?: typeof judgeStepPrompt) => {
    const r = await shell(label, REVIEW_PHASE, script, repo, ask)
    if (!r.ran) throw new Error(`granny judge could not read the ${label} in ${repo} (exit ${r.code}): ${r.output.slice(-500)}`)
    return r.output
  }
  const date = lineShaped(await needed('date', 'date +%Y%m%d-%H%M%S', judgeStepPrompt), DATE_STAMP)
  if (!date) throw new Error('granny judge could not read the date')
  const current = lineShaped(await needed('branch', 'git branch --show-current'), BRANCH_LINE)
  const read = await readHead('head', REVIEW_PHASE, repo)
  if (!read.sha) throw new Error(`granny judge could not read HEAD in ${repo} (exit ${read.code}): ${read.output.slice(-500)}`)
  const head = read.sha
  const branch = current ?? short(head)

  const count = await shell('commits', REVIEW_PHASE, `git rev-list --count ${shellQuote(base)}..HEAD`, repo)
  const commits = count.ran ? lineShaped(count.output, COUNT) : undefined
  if (commits === undefined) {
    throw new Error(`granny judge could not count the commits in ${base}..HEAD in ${repo} (exit ${count.code}): ${count.output.slice(-500)} - ${base} may not be this repo's base; it may use another one such as master, so pass base`)
  }

  const dirty = await uncommitted('status', REVIEW_PHASE, repo)
  const notReviewed = Array.isArray(dirty)
    ? dirty.map(l => l.trim().replace(/^\S+\s+/, ''))
    : [`the working tree status could not be read (${dirty.unreadable.replace(/\s+/g, ' ')})`]
  const finish = (outcome: JudgeOutcome, rest: Partial<JudgeResult> = {}): JudgeResult => ({
    repo,
    branch,
    base,
    head,
    outcome,
    counts: countsOf([]),
    demoted: [],
    findings: [],
    failedReviewers: [],
    notJudged: [],
    uncommitted: notReviewed,
    written: false,
    ...rest,
  })

  if (Number(commits) === 0) {
    const note = `${base}..HEAD has no commits, so there was nothing to review${notReviewed.length ? `; uncommitted files are not reviewed: ${notReviewed.join(', ')}` : ''}`
    host.log(`no-changes - ${note}`)
    return finish('no-changes', { note })
  }

  const p: PromptContext = { repo, branch, base, config, ...(input.context ? { context: input.context } : {}) }
  const lane: Lane = { repo, base, branch, cwd: repo, p, readable: { text: input.context ?? '', files: [] } }
  const note = `${ONE_SHOT_NOTE}${current ? '' : ` HEAD is detached at ${branch}, so that is the "branch" named here.`}`
  const results = await reviewAll(lane, config.reviewers, branch, { kind: 'diff', base, note }, 1)
  const failedReviewers = results.filter(r => !r.ran).map(r => ({ name: r.reviewer.name, note: r.note ?? 'no output' }))
  if (failedReviewers.length === results.length) {
    const notes = failedReviewers.map(r => `${r.name}: ${r.note}`).join('\n')
    host.log(`review-failed - no reviewer ran, also on a retry, so there is no report:\n${notes}`)
    return finish('review-failed', { failedReviewers, note: notes })
  }
  for (const r of failedReviewers) host.log(`${r.name} did not run, also on a retry - going on without it: ${r.note}`)
  const found = results.filter(r => r.ran).flatMap(r => r.findings)

  const tag = async (): Promise<Finding[]> => {
    host.phase(TAGGING_PHASE)
    const ids = new Set(found.map(f => f.id))
    const label = `tag ${branch}`
    const { per, decided } = await judgeAnswers({
      at: label,
      label,
      prompt: tagPrompt(p, base, found),
      ids,
      ask: async (l, text) => {
        try {
          return await call('judge', 'judge', l, TAGGING_PHASE, text, 'read-only', config.roles.judge, repo)
        } catch (e) {
          if (isCancelled(e)) throw e
          host.log(`${l}: the judge call failed: ${String((e as Error)?.message ?? e)}`)
          return null
        }
      },
      // Treating every finding as a declined repeat keeps P0/P1 out of decide's rule 1, which would hide that the judge left one unclassified.
      apply: per => found.map(f => decide(f, per.find(x => x.id === f.id), TAG_POLICY, () => true)),
      leftTo: "under the reviewer's severity, not judged",
    })
    const duplicateOf = new Map(per.filter(x => ids.has(x.id) && typeof x.duplicateOf === 'string' && ids.has(x.duplicateOf)).map(x => [x.id, x.duplicateOf as string]))
    // mergeDuplicates prefers a copy to fix: here that is one the report keeps under a P heading on the judge's word.
    const placed = decided.map(f => ({ ...f, decision: { ...f.decision!, action: isJudged(f) && bucketOf(f) !== 'dismissed' ? ('fix' as const) : ('residual' as const) } }))
    const { findings, merged } = mergeDuplicates(placed, duplicateOf)
    for (const m of merged) host.log(`${label}: judge merged ${m.id} into ${m.into} (duplicate)`)
    const severity = new Map(found.map(f => [f.id, f.severity]))
    return findings.map(({ decision: _decision, ...f }) => ({
      ...f,
      severity: (f.duplicates ?? []).map(id => severity.get(id)!).reduce((worst, s) => (severityOf({ severity: s }) < severityOf({ severity: worst }) ? s : worst), f.severity),
    }))
  }
  const findings = found.length ? await tag() : []
  const counts = countsOf(findings)
  const demoted = findings.filter(f => isDemoted(f) && (severityOf(f) === 'P0' || severityOf(f) === 'P1')).map(f => f.id)
  const notJudged = findings.filter(f => !isJudged(f)).map(f => f.id)
  if (demoted.length) host.log(`the judge placed ${demoted.length} reviewer P0/P1 finding(s) lower: ${demoted.join(', ')}`)

  host.phase(REPORT_PHASE)
  const meta: ReportMeta = {
    branch,
    base,
    head: short(head),
    commits: Number(commits),
    repo,
    when: date,
    reviewers: config.reviewers.map(rv => reviewerMeta(rv, host)),
    judge: resolveModel(config.roles.judge.model, host.name),
    uncommitted: notReviewed,
    failed: failedReviewers,
  }
  const report = renderReport(meta, findings)
  const reportPath = `${repo}/${workOf(config)}/reviews/${date}-${branchSlug(branch)}.md`
  const save = () =>
    writeChecked({
      path: reportPath,
      text: report,
      cwd: repo,
      phase: REPORT_PHASE,
      what: 'the report',
      labels: { write: 'write report', retry: 'write report retry', size: 'report size' },
      ask: reportWritePrompt,
      sizeAsk: judgeStepPrompt,
    })
  let written = false
  try {
    written = await save()
  } catch (e) {
    if (isCancelled(e)) throw e
    host.log(`writing the report failed: ${String((e as Error)?.message ?? e)}`)
  }
  host.log(written ? `report written: ${reportPath}` : `report not written: ${reportPath} - the result holds its text`)
  return finish('reviewed', {
    counts,
    demoted,
    findings,
    failedReviewers,
    notJudged,
    reportPath,
    written,
    report,
    ...(written ? {} : { note: `the report could not be written to ${reportPath}; it is in this result` }),
  })
}

export type { GrannyConfig }
