import { resolveConfig, resolveModel, type CheckConfig, type GrannyConfig, type ReviewerConfig, type RoleConfig } from './config'
import {
  agentPlanReviewPrompt,
  agentReviewPrompt,
  checkCommandPrompt,
  commandReviewPrompt,
  draftPrompt,
  extractPrompt,
  finalPrompt,
  fixPrompt,
  implementPrompt,
  judgePrompt,
  mergePrompt,
  planFixPrompt,
  planJudgePrompt,
  planReviewPrompt,
  repairPrompt,
  reviewCommandPrompt,
  gitCommandPrompt,
  worktreeCommandPrompt,
  roundLabel,
  type EarlierRound,
  type FailedCheck,
  type Overruled,
  type PromptContext,
  type StageTask,
  WHOLE_BRANCH_NOTE,
} from './prompts'
import { isBlocker, mergeDuplicates, parseCodexReview, reviewFailure, saysNoFindings, triage } from './review'
import { planReviewScript, reportedBackend, reviewPlan, reviewStem } from './reviewer'
import { SCHEMAS } from './schemas'
import { shellQuote } from './shell'
import { branchSlug, reportedWorktree, worktreePath, worktreeScript } from './worktree'
import type {
  AgentRequest,
  CheckResult,
  CheckRun,
  FinalReport,
  Finding,
  Host,
  Implementation,
  PlanDraft,
  PlanFix,
  PlanResult,
  RepoResult,
  ResultKind,
  Role,
  RoundRecord,
  RunResult,
  StageResult,
  StageSpec,
} from './types'

type Subject = { kind: 'diff'; base: string; stage?: StageTask; note?: string } | { kind: 'plan'; files: string[] }

const PLAN_PHASE = 'Plan review'
const DRAFT_PHASE = 'Plan'
const FINAL_REVIEW_PHASE = 'Final review'
const CHECKS_PHASE = 'Checks'

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
}

interface RepoState {
  lane: Lane
  locked: boolean
  waiters: Array<() => void>
  setup: Promise<unknown>
  merges: number
}

const saidSomething = (d: unknown): string | undefined =>
  typeof d === 'string' && d.trim() && !/^\s*(none|n\/a|-|no deviations)?\.?\s*$/i.test(d) ? d : undefined
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stage'
const trimPath = (s: string) => s.replace(/\/+$/, '') || '/'
const repoPathOf = (r: RepoInput): unknown => (typeof r === 'string' ? r : r && typeof r === 'object' ? r.repo : undefined)
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

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
  })
  return errors
}

export function stageCheckErrors(stages: StageSpec[] | undefined, checks: CheckConfig[]): string[] {
  const names = new Set(checks.map(c => c.name))
  return (stages ?? []).flatMap((st, i) =>
    (Array.isArray(st?.checks) ? st.checks : []).filter(n => !names.has(n)).map(n => `stages[${i}].checks names "${n}", which is not in config checks (${[...names].join(', ') || 'none configured'})`),
  )
}

const planFiles = (input: RunInput): string[] => (input.plan === undefined ? [] : Array.isArray(input.plan) ? input.plan : [input.plan])

export async function runGranny(host: Host, input: RunInput): Promise<RunResult> {
  const inputErrors = checkInput(input)
  if (inputErrors.length) throw new Error(`Invalid granny input:\n- ${inputErrors.join('\n- ')}`)

  const layers = Array.isArray(input.config) ? input.config : [input.config]
  const config = resolveConfig(layers, host.name)
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

  const call = async (role: Role, kind: ResultKind, label: string, phase: string, prompt: string, access: AgentRequest['access'], rc: RoleConfig, cwd: string) =>
    host.agent({
      role,
      kind,
      label,
      phase,
      prompt,
      schema: SCHEMAS[kind],
      model: resolveModel(rc.model, host.name),
      effort: rc.effort,
      access,
      cwd,
    })

  const shell = async (label: string, phase: string, script: string, cwd: string, ask = gitCommandPrompt): Promise<{ ran: boolean; code: number | string; output: string }> => {
    if (host.run) {
      const r = await host.run(script, cwd)
      return { ran: r.code === 0, code: r.code, output: r.output }
    }
    const prompt = ask(cwd, label, `cd ${shellQuote(cwd)} && ${script}`)
    const r = await call('granny', 'command', label, phase, prompt, 'write', config.roles.granny, cwd)
    const ran = Boolean(r?.ran)
    return { ran, code: r?.exitCode ?? (ran ? 0 : '?'), output: r ? `${String(r.output ?? '')}${r.note ? `\n${r.note}` : ''}` : `the ${label} runner returned nothing` }
  }

  const setUpWorktree = async (repo: string, branch: string, from: string, label: string, shared: boolean): Promise<string> => {
    const script = worktreeScript(config, branch, from, worktreePath(repo, branch, config.worktreeDir, shared))
    let r: { ran: boolean; code: number | string; output: string }
    if (host.run) r = await shell(label, 'Worktree', script, repo)
    else {
      const prompt = worktreeCommandPrompt(repo, branch, `cd ${shellQuote(repo)} && ${script}`)
      const a = await call('granny', 'command', label, 'Worktree', prompt, 'write', config.roles.granny, repo)
      const ran = Boolean(a?.ran)
      r = { ran, code: a?.exitCode ?? (ran ? 0 : '?'), output: a ? `${String(a.output ?? '')}${a.note ? `\n${a.note}` : ''}` : 'the worktree runner returned nothing' }
    }
    const path = r.ran ? reportedWorktree(r.output) : undefined
    if (!path) throw new Error(`worktree setup failed${repo === primary && branch === input.branch ? '' : ` for ${repo} ${branch}`} (exit ${r.code}): ${r.output.slice(-2000)}`)
    host.log(`worktree${repo === primary && branch === input.branch ? '' : ` ${baseName(repo)} ${branch}`}: ${path}`)
    return path
  }

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
  const context = [plans.length ? `Plan files - read them first: ${plans.join(', ')}` : '', input.context ?? ''].filter(Boolean).join('\n') || undefined
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
      return [r, { lane: { repo: r, base: baseOf(r), branch: input.branch, cwd, p: promptFor(r, cwd, input.branch, others) }, locked: false, waiters: [], setup: Promise.resolve(), merges: 0 }]
    }),
  )
  const primaryLane = repoState.get(primary)!.lane

  const implement = async (lane: Lane, label: string, prompt: string): Promise<Implementation> => {
    const r = (await call('implementer', 'implementation', label, 'Implement', prompt, 'write', config.roles.implementer, lane.cwd)) as Implementation | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: ${r.startSha.slice(0, 8)}..${r.headSha.slice(0, 8)}, gates ${r.gatesGreen ? 'green' : 'RED'} - ${r.gates}`)
    return r
  }

  const runCheck = async (lane: Lane, name: string, check: CheckConfig): Promise<CheckResult & { output: string }> => {
    const script = check.timeout ? `timeout ${check.timeout} bash -c ${shellQuote(check.run)}` : check.run
    const ask = (repo: string, label: string, run: string) => checkCommandPrompt(repo, label, run, check.metric?.pattern)
    const r = await shell(`check ${name} ${check.name}`, CHECKS_PHASE, script, lane.cwd, ask)
    const base = { name: check.name, code: r.code, output: r.output }
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

  const checkGate = async (lane: Lane, name: string, at: string, checks: CheckConfig[], runs: CheckRun[], stage?: StageTask): Promise<{ passed: boolean; note?: string }> => {
    host.phase(CHECKS_PHASE)
    const budget = (c: CheckConfig) => c.maxRepairs ?? config.maxRepairs
    let deviations: string | undefined
    for (let repairs = 0; ; repairs++) {
      const results: Array<CheckResult & { output: string }> = []
      for (const check of checks) results.push(await runCheck(lane, name, check))
      runs.push({ at, attempt: repairs + 1, results: results.map(({ output, ...r }) => r) })
      const failed = results.filter(r => !r.passed)
      if (!failed.length) {
        host.log(`${name}: checks green${repairs ? ` after ${repairs} repair${repairs > 1 ? 's' : ''}` : ''} (${at}: ${checks.map(c => c.name).join(', ')})`)
        return { passed: true }
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
      deviations = saidSomething((await implement(lane, `repair ${name} ${at} #${repairs + 1}`, repairPrompt(lane.p, name, at, repairs + 1, sent, stage))).deviations)
    }
  }

  const attribute = (rv: ReviewerConfig, findings: Finding[]): Finding[] =>
    findings.map((f, i) => ({ ...f, id: `${rv.name}-F${i + 1}`, reviewer: rv.name }))

  const fixPlan = async (label: string, prompt: string): Promise<PlanFix> => {
    const r = (await call('implementer', 'planFix', label, PLAN_PHASE, prompt, 'write', config.roles.implementer, worktree)) as PlanFix | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: plan edited - ${Array.isArray(r.files) && r.files.length ? r.files.join(', ') : 'no file reported'}`)
    return r
  }

  const phaseOf = (subject: Subject) => (subject.kind === 'plan' ? PLAN_PHASE : subject.note ? FINAL_REVIEW_PHASE : 'Review')

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
    const plan =
      subject.kind === 'plan'
        ? planReviewScript(rv, config, host.name, lane.base, stem, planReviewPrompt(p, subject.files))
        : reviewPlan(rv, config, host.name, subject.base, stem, commandReviewPrompt(p, name, subject.base, subject.stage, subject.note))
    if (!plan) return { ran: false, findings: [], note: 'this reviewer has no command for a plan review' }
    let ran: boolean
    let output: string
    let note: string | undefined
    if (host.run) {
      const r = await host.run(plan.script, cwd)
      ran = r.code === 0
      output = r.output
      if (!ran) note = `review command exited ${r.code}: ${r.output.slice(-2000)}`
    } else {
      const script = `cd ${shellQuote(cwd)} && ${plan.script}`
      const r = await call('granny', 'command', `review ${tag}`, phase, reviewCommandPrompt(p, name, rv.name, script), 'read-only', config.roles.granny, cwd)
      ran = Boolean(r?.ran)
      output = String(r?.output ?? '')
      if (!ran) note = r ? `review command exited ${r.exitCode ?? '?'}${r.note ? ` (${r.note})` : ''}: ${output.slice(-2000)}` : 'review runner returned nothing'
    }
    host.log(`${tag}: reviewer: ${plan.backend ?? reportedBackend(output) ?? 'not reported'}`)
    if (!ran) return { ran, findings: [], note }
    const failure = reviewFailure(output)
    if (failure) return { ran: false, findings: [], note: `reviewer returned no usable result (${failure}): ${output.slice(-2000)}` }

    const parsed = parseCodexReview(output, subject.kind === 'plan' ? undefined : cwd)
    const extractions = async (label: string, prompt: string) => call('granny', 'findings', label, phase, prompt, 'read-only', config.roles.granny, cwd)
    const extract = async (label: string, prompt: string): Promise<Finding[]> => {
      const r = await extractions(label, prompt)
      return Array.isArray(r?.findings) ? r.findings : []
    }
    if (parsed.markers === 0 && !saysNoFindings(output)) {
      host.log(`${tag}: no finding in the expected form and no "No findings." - asking an agent to extract findings`)
      const r = await extractions(`extract ${tag}`, extractPrompt(name, output, 'unmarked'))
      const found: Finding[] = Array.isArray(r?.findings) ? r.findings : []
      if (found.length || r?.clean === true) return { ran, findings: found }
      return { ran: false, findings: [], note: `reviewer output had no findings in the expected form and did not say No findings, and an extraction found none in it: ${output.slice(-2000)}` }
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

  const reviewLoop = async (lane: Lane, name: string, subject: Subject, reviewers = config.reviewers, opts: { gates?: Gates; checks?: CheckConfig[]; runs?: CheckRun[] } = {}): Promise<PlanResult> => {
    const { gates, checks = [], runs = [] } = opts
    const { p } = lane
    const phase = phaseOf(subject)
    const history: RoundRecord[] = []
    const earlier: EarlierRound[] = []
    let unmerged: Finding[] = []
    for (let round = 1; round <= config.maxRounds; round++) {
      const results = await reviewAll(lane, reviewers, name, subject, round)
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
        return { outcome: 'review-failed', rounds: round, residual: [], unresolved: [...found, ...earlier], history, note }
      }
      if (!found.length) {
        host.log(`${name} r${round}: clean`)
        return { outcome: 'clean', rounds: round, residual: [], unresolved: [], history }
      }

      const declined = earlier.filter(e => e.deviations?.trim())
      const labels = new Map(earlier.flatMap(e => e.sent.map(f => [roundLabel(e.round, f), e] as const)))
      const blockers = found.filter(isBlocker)
      const judged = declined.length ? found : found.filter(f => !isBlocker(f))
      if (blockers.length && declined.length) {
        host.log(`${name} r${round}: ${blockers.length} P0/P1 finding(s) go to the judge too - the fixer declined findings before, so a repeat of one can be scored down: ${blockers.map(f => f.id).join(', ')}`)
      } else if (blockers.length) {
        host.log(`${name} r${round}: ${blockers.length} P0/P1 finding(s) go to the implementer without the judge: ${blockers.map(f => f.id).join(', ')}`)
      }
      let findings = found
      unmerged = found
      let score: number | null = null
      if (judged.length) {
        const prompt = subject.kind === 'plan' ? planJudgePrompt(p, subject.files, judged, earlier) : judgePrompt(p, subject.base, judged, earlier, subject.stage, subject.note)
        const scored = await call('judge', 'score', `judge ${name} r${round}`, phase, prompt, 'read-only', config.roles.judge, lane.cwd)
        if (!scored) host.log(`${name} r${round}: judge returned nothing - all ${judged.length} finding(s) go to the implementer unscored`)
        const per: Array<{ id: string; score: number; reason: string; duplicateOf?: string; repeatOf?: string }> = Array.isArray(scored?.perFinding) ? scored.perFinding : []
        const judgedIds = new Set(judged.map(f => f.id))
        const blockerIds = new Set(blockers.map(f => f.id))
        const duplicateOf = new Map(
          per
            .filter(x => judgedIds.has(x.id) && typeof x.duplicateOf === 'string' && judgedIds.has(x.duplicateOf))
            .filter(x => !blockerIds.has(x.id) || blockerIds.has(x.duplicateOf!))
            .map(x => [x.id, x.duplicateOf!]),
        )
        const withScores = found.map(f => {
          const s = judgedIds.has(f.id) ? per.find(x => x.id === f.id) : undefined
          if (!s) return { ...f }
          const repeat = typeof s.repeatOf === 'string' && labels.has(s.repeatOf) ? { repeatOf: s.repeatOf } : {}
          return { ...f, score: s.score, reason: s.reason, ...repeat }
        })
        const merge = mergeDuplicates(withScores, duplicateOf)
        for (const m of merge.merged) host.log(`${name} r${round}: judge merged ${m.id} into ${m.into} (duplicate)`)
        unmerged = withScores
        findings = merge.findings
        score = typeof scored?.score === 'number' ? scored.score : null
      }
      history.push({ round, score, findings })
      host.log(`${name} r${round}: ${findings.length} finding(s), review score ${score} (informational)`)

      const { accepted, residual } = triage(findings, config.threshold)
      const declinedBefore = (f: Finding) => (f.repeatOf ? labels.get(f.repeatOf)?.deviations?.trim() : undefined)
      for (const f of residual.filter(declinedBefore)) {
        host.log(`${name} r${round}: ${f.id} dropped as a repeat of ${f.repeatOf}, which the fixer declined (score ${f.score}) - kept as residual`)
      }
      if (residual.length) {
        host.log(`${name} r${round}: ${residual.length} finding(s) <= ${config.threshold} and not ${residual.some(isBlocker) ? 'first-time ' : ''}P0/P1, not sent: ${residual.map(f => `${f.id}(${f.score})`).join(', ')}`)
      }
      if (!accepted.length) {
        host.log(`${name} r${round}: nothing actionable left - stage done with ${residual.length} residual finding(s) for the user`)
        return { outcome: 'residual-only', rounds: round, residual, unresolved: [], history }
      }

      const overruled: Overruled[] = accepted.filter(declinedBefore).map(f => ({ id: f.id, repeatOf: f.repeatOf!, round: labels.get(f.repeatOf!)!.round, reason: f.reason }))
      for (const o of overruled) {
        host.log(`${name} r${round}: the judge overruled the fixer on ${o.id} (repeat of ${o.repeatOf}, score ${accepted.find(f => f.id === o.id)!.score})`)
      }

      let deviations: string | undefined
      if (subject.kind === 'plan') {
        deviations = (await fixPlan(`fix ${name} r${round}`, planFixPrompt(p, subject.files, round, accepted, overruled, earlier))).deviations
      } else {
        const fix = await implement(lane, `fix ${name} r${round}`, fixPrompt(p, name, round, accepted, overruled, earlier))
        if (gates) Object.assign(gates, { green: fix.gatesGreen, text: fix.gates, by: `the last fix (fix ${name} r${round})` })
        if (!fix.gatesGreen) host.log(`${name} r${round}: WARNING fixer left gates red - ${fix.gates}`)
        deviations = fix.deviations
      }
      const said = saidSomething(deviations)
      if (said) history.at(-1)!.deviations = said
      earlier.push({ round, sent: accepted, ...(said ? { deviations: said } : {}) })
      if (subject.kind === 'diff' && checks.length) {
        const gate = await checkGate(lane, name, `fix r${round}`, checks, runs, subject.stage)
        if (!gate.passed) return { outcome: 'checks-failed', rounds: round, residual, unresolved: [], history, note: gate.note }
        host.phase(phase)
      }
    }
    host.log(`${name}: hit the ${config.maxRounds}-round cap without a clean review`)
    return { outcome: 'round-cap', rounds: config.maxRounds, residual: [], unresolved: history.at(-1)?.findings ?? [], history }
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
    const name = 'plan review'
    const able = config.reviewers.filter(rv => rv.engine !== 'command' || rv.command?.includes('{prompt}'))
    const unable = config.reviewers.filter(rv => !able.includes(rv))
    for (const rv of unable) host.log(`${name}: reviewer ${rv.name} skipped - its command has no {prompt}, so it cannot review a plan`)
    if (!able.length) {
      const note = `no reviewer can review a plan: ${unable.map(rv => rv.name).join(', ')} ${unable.length > 1 ? 'have commands' : 'has a command'} without {prompt} - add a reviewer that can, or set planReview to false`
      host.log(`${name}: ${note}`)
      return { outcome: 'review-failed', rounds: 0, residual: [], unresolved: [], history: [], note }
    }
    return reviewLoop(primaryLane, name, { kind: 'plan', files: plans }, able)
  }

  const planResult = await reviewThePlan()
  if (draft) {
    host.log(`plan written - the run stops here; launch again with plan and the approved stages to implement it`)
    return { repo: input.repo, branch: input.branch, base, worktree, draft, ...(planResult ? { plan: planResult } : {}), stages: [], final: null }
  }
  if (planResult && (planResult.outcome === 'round-cap' || planResult.outcome === 'review-failed')) {
    host.log(`plan review ended ${planResult.outcome} - stopping before stage 1; nothing was implemented`)
    return { repo: input.repo, branch: input.branch, base, worktree, plan: planResult, stages: [], final: null }
  }

  const tryLock = (s: RepoState) => (s.locked ? false : (s.locked = true))
  const lock = (s: RepoState) => new Promise<void>(resolve => (tryLock(s) ? resolve() : s.waiters.push(resolve)))
  const unlock = (s: RepoState) => {
    const next = s.waiters.shift()
    if (next) next()
    else s.locked = false
  }

  const runStage = async (lane: Lane, st: StageSpec, i: number, name: string): Promise<StageResult> => {
    let impl: Implementation | undefined
    let base = lane.base
    const lastLine = (output: string) => output.trim().split('\n').at(-1)?.trim() ?? ''
    const where = st.repo !== undefined && repoOf(st) !== primary ? { repo: repoOf(st) } : {}
    const task: StageTask | undefined = st.task ? { number: i + 1, total: specs.length, name, task: st.task } : undefined
    const checks = checksOf(st)
    const runs: CheckRun[] = []
    const ran = () => (runs.length ? { checks: runs } : {})
    if (st.implement !== false) {
      host.phase('Implement')
      const head = await shell(`head ${name}`, 'Implement', 'git rev-parse --verify HEAD', lane.cwd)
      const start = head.ran && /^[0-9A-Za-z]+$/.test(lastLine(head.output)) ? lastLine(head.output) : undefined
      if (start) base = start
      else host.log(`${name}: could not read HEAD before the implementer ran - reviewing ${lane.base}...HEAD instead (exit ${head.code}): ${head.output.slice(-500)}`)
      impl = await implement(lane, `implement ${name}`, implementPrompt(lane.p, st, i, specs.length, name, buildsOnEarlier(i)))
      if (!impl.gatesGreen) host.log(`${name}: implementer ended with RED gates - review will see it`)
      if (start && impl.startSha !== start) host.log(`${name}: the implementer reported startSha ${impl.startSha}, but HEAD was ${start} before it ran - reviewing ${start}...HEAD`)
      const count = await shell(`commits ${name}`, 'Implement', `git rev-list --count ${shellQuote(base)}..HEAD`, lane.cwd)
      if (!count.ran || !/^\d+$/.test(lastLine(count.output))) {
        host.log(`${name}: could not count the commits in ${base}..HEAD - reviewing it anyway (exit ${count.code}): ${count.output.slice(-500)}`)
      } else if (Number(lastLine(count.output)) === 0) {
        const note = `the implementer made no commit: ${base}..HEAD is empty, so there was nothing to review`
        host.log(`${name}: no-changes - ${note}`)
        return { stage: name, ...where, implementation: impl, outcome: 'no-changes', rounds: 0, residual: [], unresolved: [], history: [], note }
      }
      if (checks.length) {
        const gate = await checkGate(lane, name, 'implement', checks, runs, task)
        if (!gate.passed) return { stage: name, ...where, implementation: impl, outcome: 'checks-failed', rounds: 0, residual: [], unresolved: [], history: [], note: gate.note, ...ran() }
      }
    } else {
      host.log(`${name}: review-only stage - reviewing ${lane.base}...HEAD`)
    }

    host.phase('Review')
    const gates: Gates | undefined = impl && !runs.length ? { green: impl.gatesGreen, text: impl.gates, by: 'the implementer' } : undefined
    const loop: PlanResult = st.review === false
      ? { outcome: 'review-skipped' as const, rounds: 0, residual: [], unresolved: [], history: [] }
      : await reviewLoop(
          lane,
          name,
          { kind: 'diff', base, ...(task ? { stage: task } : {}) },
          undefined,
          { gates, checks, runs },
        )
    if (gates && !gates.green && (loop.outcome === 'clean' || loop.outcome === 'residual-only')) {
      loop.outcome = 'gates-red'
      loop.note = `the review found nothing to fix, but ${gates.by} left the gates red: ${gates.text}`
      host.log(`${name}: gates-red - ${loop.note}`)
    }
    return { stage: name, ...where, ...(impl ? { implementation: impl } : {}), ...loop, ...ran() }
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
    } else host.log(`${label}: ${lane.branch} merged into ${main.branch}`)
    const cleanup = `[ -z "$(git -C ${shellQuote(lane.cwd)} status --porcelain)" ] && git worktree remove --force ${shellQuote(lane.cwd)} && git branch -d ${shellQuote(lane.branch)}`
    const cleaned = await shell(`cleanup ${name}`, 'Implement', cleanup, main.cwd)
    if (!cleaned.ran) {
      host.log(`${label}: left ${lane.cwd} (${lane.branch}) in place - remove it yourself once you have checked it: ${cleaned.output.slice(-500)}`)
      return `ran in parallel on ${lane.branch}; its worktree ${lane.cwd} was left in place`
    }
    return merged.ran ? `ran in parallel on ${lane.branch}, merged` : `ran in parallel on ${lane.branch}, merged after the implementer resolved conflicts`
  }

  const startStage = async (i: number): Promise<StageResult> => {
    const st = specs[i]!
    const name = st.name || `stage ${i + 1}`
    const state = repoState.get(repoOf(st))!
    if (tryLock(state)) {
      try {
        return await runStage(state.lane, st, i, name)
      } finally {
        unlock(state)
      }
    }
    const branch = `${input.branch}--s${i + 1}-${slug(name)}`
    host.log(`${name}: ${state.lane.branch} is busy in ${baseName(state.lane.repo)} - running in parallel on ${branch}`)
    const main = state.lane
    const setup = state.setup.then(() => setUpWorktree(main.repo, branch, input.branch, `worktree ${name}`, main.repo !== primary))
    state.setup = setup.catch(() => {})
    const cwd = await setup
    const others = [main.cwd, ...used.filter(o => o !== main.repo).map(o => cwdOf.get(o)!)]
    const lane: Lane = { repo: main.repo, base: main.base, branch, cwd, p: promptFor(main.repo, cwd, branch, others, `${main.cwd}/${config.workDir}/PR-BODY-s${i + 1}-${slug(name)}.md`) }
    const result = await runStage(lane, st, i, name)
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
  for (let i = 0; i < fromStage - 1; i++) {
    results[i] = { stage: specs[i]!.name || `stage ${i + 1}`, outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [] }
    done.add(i)
  }
  for (;;) {
    if (!failure) {
      for (let i = 0; i < specs.length && running.size < limit; i++) {
        if (done.has(i) || running.has(i) || ![...deps[i]!].every(d => done.has(d))) continue
        const blocker = [...builds[i]!].find(d => undelivered.has(d))
        if (blocker !== undefined) {
          const ended = results[blocker]!.outcome
          const note = `not started: it builds on ${nameOf(blocker)}, which ${ended === 'no-changes' || ended === 'checks-failed' ? `ended ${ended}` : 'was not started'}`
          host.log(`${specs[i]!.name || `stage ${i + 1}`}: ${note}`)
          results[i] = { stage: specs[i]!.name || `stage ${i + 1}`, outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [], note }
          done.add(i)
          undelivered.add(i)
          continue
        }
        if (running.size) host.log(`${specs[i]!.name || `stage ${i + 1}`}: starting in parallel with ${[...running.keys()].map(j => specs[j]!.name || `stage ${j + 1}`).join(', ')}`)
        running.set(
          i,
          startStage(i).then(
            r => {
              results[i] = r
              if (r.outcome === 'no-changes' || r.outcome === 'checks-failed') undelivered.add(i)
              done.add(i)
              running.delete(i)
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
    host.log(`a stage failed - waited for the stages already running. Finished: ${finished.map(nameOf).join(', ') || 'none'}. Not finished: ${unfinished.map(nameOf).join(', ')}`)
    throw failure.error
  }
  if (unfinished.length) throw new Error(`scheduler stopped with stages that never started: ${unfinished.map(nameOf).join(', ')}`)

  const states = [...repoState.values()]
  const stageCount = (s: RepoState) => specs.filter(st => repoOf(st) === s.lane.repo).length
  const finalRuns = new Map<RepoState, CheckRun[]>()
  const finalReview = async (s: RepoState): Promise<PlanResult | undefined> => {
    const stages = stageCount(s)
    if (!stages) return undefined
    const name = s.lane.repo === primary ? 'final review' : `final review ${baseName(s.lane.repo)}`
    const runs: CheckRun[] = []
    if (config.checks.length) {
      finalRuns.set(s, runs)
      const gate = await checkGate(s.lane, name, 'final', config.checks, runs)
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
    if (stages === 1 && !s.merges) return skipped('skipped', `${name} skipped - ${why}`, why)
    host.phase(FINAL_REVIEW_PHASE)
    host.log(`${name}: reviewing ${s.lane.base}...HEAD across ${stages} stage(s)${s.merges ? ` and ${s.merges} lane merge(s)` : ''}`)
    const r = await reviewLoop(s.lane, name, { kind: 'diff', base: s.lane.base, note: WHOLE_BRANCH_NOTE }, undefined, { checks: config.checks, runs })
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
  const check = async (s: RepoState): Promise<RepoResult> => {
    const label = s.lane.repo === primary ? 'pr-ready check' : `pr-ready check ${baseName(s.lane.repo)}`
    const final = (await call('granny', 'final', label, 'PR ready', finalPrompt(s.lane.p), 'write', config.roles.granny, s.lane.cwd)) as FinalReport | null
    if (!final) host.log(s.lane.repo === primary ? 'final check returned nothing' : `${label} returned nothing`)
    const review = reviews.get(s)
    const runs = finalRuns.get(s)
    return { repo: s.lane.repo, base: s.lane.base, worktree: s.lane.cwd, ...(review ? { finalReview: review } : {}), ...(runs ? { checks: runs } : {}), final }
  }
  const finals: RepoResult[] = []
  if (config.parallel) finals.push(...(await Promise.all(states.map(check))))
  else for (const s of states) finals.push(await check(s))

  const final = finals[0]!.final
  const primaryReview = finals[0]!.finalReview
  const primaryChecks = finals[0]!.checks
  return {
    repo: input.repo,
    branch: input.branch,
    base,
    worktree,
    ...(planResult ? { plan: planResult } : {}),
    stages: results,
    ...(primaryReview ? { finalReview: primaryReview } : {}),
    ...(primaryChecks ? { checks: primaryChecks } : {}),
    final,
    ...(finals.length > 1 ? { repos: finals } : {}),
  }
}

export type { GrannyConfig }
