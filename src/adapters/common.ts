import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isCancelled } from '../core/cancel'
import { globalConfigPath, readJson } from './config-files'
export { globalConfigPath, readJson } from './config-files'
import { type ConfigRole, type GrannyConfig, judgeConfigGaps, type ModelSpec, planReviewWarning, resolveConfig, resolveModel } from '../core/config'
export { planReviewWarning } from '../core/config'
import { checkJudgeInput, type JudgeInput, type RunInput } from '../core/engine'
import { noteLine, oneLine } from '../core/report'
import type { RunOutline } from './runview/outline'
import type { CommandResult, Host, HostName, JudgeResult, PlanResult, Recheck, ResultKind, RunResult } from '../core/types'

// Shared by the in-process host adapters (opencode, omp): config files, preflight, run ids,
// the completion summary, the granny_run input schema, the retry and cancel defaults and the command runner.

export const SUBMIT: Partial<Record<ResultKind, string>> = {
  implementation: 'granny_submit_implementation',
  draft: 'granny_submit_plan',
  planFix: 'granny_submit_plan_fix',
  findings: 'granny_submit_findings',
  judge: 'granny_submit_judgement',
  final: 'granny_submit_final',
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

export function preflight(repo: string, branch: string, workDir: string, worktree: boolean): string[] {
  const problems: string[] = []
  let current = ''
  try {
    current = git(repo, ['branch', '--show-current'])
  } catch (e) {
    return [(e as Error).message]
  }
  if (!worktree && current !== branch) problems.push(`repo is on branch "${current}", expected "${branch}" - create and check it out first`)
  const dirty = !worktree || current === branch
    ? git(repo, ['status', '--porcelain'])
        .split('\n')
        .filter(l => l && !l.slice(3).startsWith(`${workDir}/`) && l.slice(3) !== workDir && l.slice(3) !== `${workDir}/`)
    : []
  if (dirty.length) problems.push(`working tree is not clean:\n${dirty.join('\n')}`)
  if (!problems.length) {
    const commonDir = git(repo, ['rev-parse', '--git-common-dir'])
    const exclude = join(isAbsolute(commonDir) ? commonDir : join(repo, commonDir), 'info', 'exclude')
    const entry = `/${workDir}/`
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes(entry)) {
      mkdirSync(join(exclude, '..'), { recursive: true })
      appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`)
    }
  }
  return problems
}

export function stageRepos(input: RunInput): string[] {
  const top = (p: string) => p.replace(/\/+$/, '') || '/'
  const primary = top(input.repo)
  return [...new Set((input.stages ?? []).flatMap(st => (typeof st.repo === 'string' && top(st.repo) !== primary ? [top(st.repo)] : [])))]
}

/** status.json's error: the stack of a failure, only "cancelled" for a cancel. */
export function statusError(error: unknown, cancelled: boolean): string {
  return cancelled || isCancelled(error) ? 'cancelled' : String((error as Error)?.stack ?? error)
}

export function stamp(): string {
  return new Date().toISOString()
}

export function runId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`
}

export function summarize(result: RunResult, worktree: boolean): string {
  const line = (s: PlanResult, name: string) => {
    const extra = [
      s.residual.length ? `${s.residual.length} residual` : '',
      s.unresolved.length ? `${s.unresolved.length} unresolved` : '',
    ].filter(Boolean).join(', ')
    const left = s.note?.split('\n').find(l => l.startsWith('uncommitted changes after') || l.startsWith('working tree status unreadable after'))
    const warned = s.note?.split('\n').find(l => l.startsWith('the checks passed, but '))
    return `- ${name}: ${s.outcome}, ${s.rounds} review round(s)${extra ? ` (${extra})` : ''}${left ? ` - ${left}` : ''}${warned ? ` - ${warned}` : ''}`
  }
  const lines = result.stages.map(
    s =>
      `${line(s, s.repo ? `${s.stage} (${s.repo})` : s.stage)}${(s.outcome === 'checks-failed' || s.outcome === 'no-changes') && s.note ? ` - ${s.note.split('\n')[0]}` : ''}${s.note && s.note.includes('in parallel on') ? ` - ${s.note.split('\n').at(-1)}` : ''}`,
  )
  if (result.draft) {
    lines.push(`- plan written: ${result.draft.files.join(', ')} - ${result.draft.stages.length} proposed stage(s)${result.draft.questions ? ', open questions for the user' : ''}`)
    if (result.plan) lines.push(line(result.plan, 'plan review'))
    if (result.draft.questions) lines.push(`- open questions: ask the user these with your question tool (\`ask\` on omp, \`question\` on opencode), do not just write them out; without such a tool, ask in one numbered message:\n${result.draft.questions.trim()}`)
    lines.push('- stopped after planning, nothing was implemented: show the user the plan and the stages, and wait for their approval')
  } else if (result.plan) {
    const stopped = result.plan.outcome === 'round-cap' || result.plan.outcome === 'review-failed'
    lines.unshift(`${line(result.plan, 'plan review')}${stopped ? ' - stopped before stage 1, nothing was implemented' : ''}`)
  }
  const reviewLine = (s: PlanResult, name: string) =>
    `${line(s, name)}${s.outcome === 'skipped' || s.outcome === 'review-skipped' ? ` - ${s.note ?? 'not run'}` : s.outcome === 'round-cap' || s.outcome === 'review-failed' ? ' - the branch still has unresolved findings; the final check ran anyway' : s.outcome === 'checks-failed' ? ` - NOT PR-ready, the checks fail: ${s.note ?? ''}; the final check ran anyway` : ''}`
  if (result.finalReview) lines.push(reviewLine(result.finalReview, 'final review'))
  for (const r of result.repos?.slice(1) ?? []) if (r.finalReview) lines.push(reviewLine(r.finalReview, `final review ${r.repo}`))
  const recheckLine = (r: Recheck, name: string) =>
    `- ${name}: ${r.passed ? 'green on the HEAD the pr-ready check left' : `RED - NOT PR-ready after the pr-ready check moved HEAD: ${r.note ?? ''}`}`
  if (result.final) lines.push(`- final: gates ${result.final.gatesGreen ? 'green' : 'RED'}, PR body ${result.final.prBodyPath}${result.final.issues ? `, issues: ${result.final.issues}` : ''}`)
  if (result.recheck) lines.push(recheckLine(result.recheck, 'checks after the final check'))
  for (const r of result.repos?.slice(1) ?? []) {
    lines.push(`- final ${r.repo}: ${r.final ? `gates ${r.final.gatesGreen ? 'green' : 'RED'}, PR body ${r.final.prBodyPath}${r.final.issues ? `, issues: ${r.final.issues}` : ''}` : 'returned nothing'}`)
    if (r.recheck) lines.push(recheckLine(r.recheck, `checks after the final check ${r.repo}`))
  }
  if (result.trail) {
    const { dir, written, failed } = result.trail
    lines.push(`- trail: ${dir} - ${written} record(s) written${failed.length ? `; NOT written: ${failed.join(', ')} - the PR will not get these rounds' comments` : ''}`)
  }
  if (worktree) lines.push(`- worktree: ${result.worktree}${result.repos?.length ? ` (and ${result.repos.slice(1).map(r => r.worktree).join(', ')})` : ''} - review and push from there; granny never removes it`)
  return lines.join('\n')
}

/** The finish message of a judge run: the report path first, and what to do with it last. */
export function summarizeJudge(result: JudgeResult): string {
  const didNotRun = result.failedReviewers.map(r => `- did not run: ${r.name}: ${noteLine(r.note)}`)
  if (result.outcome !== 'reviewed') {
    const why = result.outcome === 'no-changes' ? oneLine(result.note ?? 'nothing to review') : 'no reviewer ran, also on a retry'
    return [`- no report: ${why}`, ...didNotRun, 'Nothing was fixed or committed. Tell the user; do not fix anything unless they ask.'].join('\n')
  }
  const { P0, P1, P2, P3, dismissed } = result.counts
  return [
    result.written ? `- report: ${result.reportPath}` : `- report NOT written to ${result.reportPath}: its text is in the run's result.json (granny_status), under report`,
    `- counts: P0 ${P0}, P1 ${P1}, P2 ${P2}, P3 ${P3}, dismissed ${dismissed}`,
    `- reviewer P0/P1 findings the judge placed lower: ${result.demoted.length}${result.demoted.length ? ` (${result.demoted.join(', ')})` : ''}`,
    ...(result.uncommitted.length ? [`- not reviewed, uncommitted: ${result.uncommitted.join(', ')}`] : []),
    ...didNotRun,
    ...(result.notJudged.length ? [`- not judged, under the reviewer's severity: ${result.notJudged.join(', ')}`] : []),
    'Nothing was fixed or committed. Give the user the report path and the counts; do not fix anything unless they ask.',
  ].join('\n')
}

/** The start reply's plan review warning, for a run that will review a plan; empty otherwise. */
export function planReviewNotice(input: RunInput, config: { planReview: boolean; maxRounds: number }): string {
  const reviewsPlan = config.planReview && (input.plan !== undefined || input.goal !== undefined) && !((input.fromStage ?? 1) > 1)
  return reviewsPlan ? `\n${planReviewWarning(config.maxRounds)} Tell the user this in your next message.` : ''
}

export const SAME_MODEL_HINT = "reviewers share the implementer's model; a different model may catch more"

/** The start reply's advice for a run that writes code when every reviewer is an `agent` reviewer on the implementer's model; empty otherwise. */
export function sameModelNotice(input: RunInput, config: GrannyConfig, host: Exclude<HostName, 'claude-code'>): string {
  if (input.goal !== undefined) return ''
  const modelOf = (spec: ModelSpec | undefined) => resolveModel(spec, host)?.split('#')[0]
  const implementer = modelOf(config.roles.implementer.model)
  const shared = config.reviewers.every(rv => rv.engine === 'agent' && modelOf(rv.model) === implementer)
  return shared ? `\n${SAME_MODEL_HINT}. Mention this to the user in your next message; do not change a model unless the user asks.` : ''
}

/** The config files a run reads, in layer order, as the start reply and refusals name them. */
export const layerSources = (repo: string): string[] => [globalConfigPath(), join(repo, 'granny.config.json'), "the run's config"]

const AGENT_ROLES: ConfigRole[] = ['granny', 'helper', 'planner', 'implementer', 'judge']
/** The roles a judge run uses, besides its reviewers: `granny` is the extraction agent. */
export const JUDGE_ROLES: ConfigRole[] = ['granny', 'judge']
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The role and agent-reviewer models this host cannot run, one line each, checked at launch instead of at the
 * role's first call. `problem` says what is wrong with a model, given whether it was keyed to this host.
 */
export function hostModelErrors(
  config: GrannyConfig,
  layers: unknown[],
  host: Exclude<HostName, 'claude-code'>,
  problem: (model: string, keyed: boolean) => string | undefined,
  sources: string[],
  checked: ConfigRole[] = AGENT_ROLES,
): string[] {
  const from = (set: (layer: Record<string, any>) => boolean) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (isObject(layer) && set(layer)) return ` (from ${sources[i] ?? `config layer ${i + 1}`})`
    }
    return ''
  }
  const check = (what: string, spec: ModelSpec | undefined, where: string): string[] => {
    const model = resolveModel(spec, host)
    const wrong = model === undefined ? undefined : problem(model, typeof spec !== 'string')
    if (!wrong) return []
    const claude = typeof spec === 'string' ? spec : (spec?.['claude-code'] ?? model)
    return [`${what} "${model}"${where} - ${wrong}; give a host-keyed model, e.g. { "claude-code": "${claude}", "${host}": "<provider/model>" }`]
  }
  const roles = checked.flatMap(role =>
    check(`roles.${role}.model:`, config.roles[role].model, from(l => isObject(l.roles) && isObject(l.roles[role]) && l.roles[role].model !== undefined)),
  )
  const reviewers = config.reviewers.flatMap((rv, i) => (rv.engine === 'agent' ? check(`reviewers[${i}] "${rv.name}": model`, rv.model, from(l => Array.isArray(l.reviewers))) : []))
  return [...roles, ...reviewers]
}

const USER_SETTINGS =
  "roles.*.model, roles.*.effort, reviewers, threshold, maxRounds and checks come from the user's config files: override them in config only when the user asked for that change in this conversation. If a provider limit or error blocks the run, stop and ask the user which model to use instead of switching models yourself."

export const RUN_TOOL_DESCRIPTION = `granny-workflow: start the implement → review → judge → fix loop in the background and return a run id. The granny-workflow skill, when installed, describes the inputs and the preflight. Send only the fields you set: leave an optional field out instead of sending "", [], {} or a default - an empty value is not a missing one (stages[].checks [] runs no checks, stages[].after [] starts the stage at once). Set config planReview only when the user asked for a plan review in this request - it costs many tokens and much time. ${USER_SETTINGS}`

const shown = (value: unknown): string => {
  if (value === undefined) return 'default'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

const reviewersText = (list: GrannyConfig['reviewers'], host: HostName) =>
  list.map(rv => `${rv.name} (${[rv.engine, resolveModel(rv.model, host)].filter(Boolean).join(', ')})`).join(', ')

/** The start reply's line naming what the run's own config changed from the config files; empty when it changed nothing. */
export function overridesNotice(layers: unknown[], host: HostName): string {
  if (layers.at(-1) === undefined) return ''
  const after = resolveConfig(layers, host)
  let before: GrannyConfig
  try {
    before = resolveConfig(layers.slice(0, -1), host)
  } catch {
    before = resolveConfig([], host)
  }
  const changes: string[] = []
  const note = (key: string, now: string, was: string) => {
    if (now !== was) changes.push(`${key} ${now} (config: ${was})`)
  }
  for (const role of Object.keys(after.roles) as ConfigRole[]) {
    note(`roles.${role}.model`, shown(resolveModel(after.roles[role].model, host)), shown(resolveModel(before.roles[role].model, host)))
    note(`roles.${role}.effort`, shown(after.roles[role].effort), shown(before.roles[role].effort))
  }
  for (const key of Object.keys(after) as Array<keyof GrannyConfig>) {
    if (key === 'roles') continue
    if (key === 'reviewers') note(key, reviewersText(after.reviewers, host), reviewersText(before.reviewers, host))
    else if (key === 'checks') note(key, after.checks.map(c => c.name).join(', ') || 'none', before.checks.map(c => c.name).join(', ') || 'none')
    else note(key, shown(after[key]), shown(before[key]))
  }
  return changes.length ? `\noverrides: ${changes.join(', ')} - show this line to the user in your next message; they did not set these values in their config files.` : ''
}

const isEmpty = (v: unknown) => v === '' || (Array.isArray(v) && !v.length) || (!!v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)

/**
 * Models that fill every optional tool field (seen with GPT models on omp) send "", [] and {} for the
 * fields they do not mean to set, and checkInput then refuses the run - a "" goal is not a missing goal.
 * Drops those placeholders where empty has no meaning of its own; stages[].checks and stages[].after keep
 * theirs, since [] there means "no checks" and "start at once".
 */
export function dropPlaceholders<T extends RunInput | JudgeInput>(input: T): T {
  if (!input || typeof input !== 'object') return input
  const out: Record<string, unknown> = { ...input }
  for (const key of ['base', 'goal', 'context', 'plan', 'repos', 'config']) if (isEmpty(out[key])) delete out[key]
  if (out.fromStage === 0) delete out.fromStage
  if (Array.isArray(out.stages)) {
    out.stages = out.stages.map(stage => {
      if (!stage || typeof stage !== 'object') return stage
      const st: Record<string, unknown> = { ...stage }
      for (const key of ['name', 'task', 'repo']) if (st[key] === '') delete st[key]
      return st
    })
  }
  return out as unknown as T
}

export const RUN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo; the run files go to <repo>/<workDir>/runs/' },
    branch: {
      type: 'string',
      description: 'Feature branch. With config worktree on (default) granny reuses its worktree or creates one - do not check it out yourself; with worktree off it must be checked out in repo',
    },
    base: { type: 'string', description: 'Branch never to touch; defaults to config.base' },
    repos: {
      type: 'array',
      description: 'Other repos the work spans. Stages name the one they work in with repo; each repo gets its own worktree on the same branch',
      items: {
        type: 'object',
        properties: { repo: { type: 'string', description: 'Absolute path' }, base: { type: 'string', description: 'Its base branch; defaults to config.base' } },
        required: ['repo'],
      },
    },
    goal: {
      type: 'string',
      description: 'What to build, when there is no plan yet: the planner writes the plan (to plan, default <repo>/<workDir>/plans/<branch-slug>.md) and proposes stages, the plan review runs, and the run stops for the user to approve. Exclusive with stages and fromStage',
    },
    context: { type: 'string', description: 'Files every agent reads first (work orders, notes) and override notes' },
    plan: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute paths of the plan files (with goal: where the planner writes the plan). Every agent reads them; with config planReview on the reviewers review them before stage 1 and the implementer fixes them in place, uncommitted. planReview is off by default: set it only when the user explicitly asked for a plan review in this request - every round is a review + judge + fix and costs many tokens and much time',
    },
    stages: {
      type: 'array',
      description: 'One entry per stop-and-review point; required unless goal is given',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          task: { type: 'string', description: 'Exactly which work orders / sections this stage does; required unless implement is false' },
          implement: { type: 'boolean', description: 'false makes a review-only stage: review base...HEAD, then fix' },
          review: { type: 'boolean', description: 'false skips the review loop for this stage' },
          repo: { type: 'string', description: 'Absolute path of the repo this stage works in: repo (default) or one of repos' },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of the config checks this stage runs before its review and after each fix; omitted: all of them, []: none',
          },
          after: {
            type: 'array',
            items: { type: 'number' },
            description: '1-based numbers of earlier stages this one waits for; [] starts it right away. Omitted: it waits for the previous stage in the same repo. Independent stages run in parallel (config parallel, on by default), a same-repo one in its own worktree that is merged back',
          },
        },
      },
    },
    fromStage: { type: 'number', description: 'Only to resume an interrupted run: 1-based stage to resume from; earlier stages are skipped. Leave it out on a new run' },
    config: {
      type: 'object',
      additionalProperties: true,
      description: `Per-run overrides of granny.config.json (same shape). planReview is off by default: set it only when the user explicitly asked for a plan review in this request - it costs many tokens and much time. ${USER_SETTINGS}`,
    },
  },
  required: ['repo', 'branch'],
}

/** What differs between a full run and a judge run; the rest of a run's life is `launch`. */
export interface Launch<R> {
  input: { repo: string }
  layers: unknown[]
  config: GrannyConfig
  branch: string
  outline: RunOutline
  engine: (host: Host) => Promise<R>
  /** The finish message after its first line. */
  finished: (result: R, id: string) => string
  /** The start reply. */
  started: (id: string, journalPath: string) => string
}

export const JUDGE_TOOL_DESCRIPTION = `granny-workflow: a review-only run ("granny judge"), in the background. One review of the checkout's <base>...HEAD and one tagging of its findings by another agent, saved as a markdown report under <workDir>/reviews/ (default .granny/reviews/). It changes nothing else: no fix, commit, push, branch or worktree. The reviewers and the judge model must be in the user's config files; when they are not, it refuses, and you ask the user as the skill's references/judge.md says - never choose a model yourself. Send only the fields you set. ${USER_SETTINGS}`

export const JUDGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the checkout to review, on the branch to review; the run files and the report go to <repo>/<workDir>/' },
    base: { type: 'string', description: 'The branch to diff against; defaults to config.base' },
    context: { type: 'string', description: 'What the user wants looked at, or a plan to check against' },
    config: {
      type: 'object',
      additionalProperties: true,
      description: `Per-run overrides of granny.config.json (same shape). They do not answer a refusal: what is missing goes to the config files, from the user. ${USER_SETTINGS}`,
    },
  },
  required: ['repo'],
}

const ASK_FOR_MODELS = "Ask the user for these per the skill's references/judge.md and write them to the config. Do not choose a model yourself."

export interface JudgeLaunch {
  layers: unknown[]
  config: GrannyConfig
  /** What the views call the checkout: its branch, or the short SHA the engine names a detached HEAD by. */
  branch: string
}

/**
 * What a judge run starts with, or why it may not start. Only the config files answer the gate: the run's own
 * config comes from the parent agent, which is not to choose the models. There is no preflight: a dirty tree is
 * allowed and no branch is required.
 */
export function prepareJudge(
  input: JudgeInput,
  host: Exclude<HostName, 'claude-code'>,
  problem: (model: string, keyed: boolean) => string | undefined,
): JudgeLaunch | { refused: string } {
  const refused = (problems: string[], end = '') => ({ refused: `granny_judge refused:\n- ${problems.join('\n- ')}${end}` })
  const problems = checkJudgeInput(input)
  if (problems.length) return refused(problems)
  const files = [readJson(globalConfigPath()), readJson(join(input.repo, 'granny.config.json'))]
  const layers = [...files, input.config]
  const gaps = [...new Set([...judgeConfigGaps(files, host), ...judgeConfigGaps(layers, host)])]
  if (gaps.length) return refused(gaps, `\n${ASK_FOR_MODELS}`)
  const config = resolveConfig(layers, host)
  const badModels = hostModelErrors(config, layers, host, problem, layerSources(input.repo), JUDGE_ROLES)
  if (badModels.length) return refused(badModels)
  try {
    return { layers, config, branch: git(input.repo, ['branch', '--show-current']) || git(input.repo, ['rev-parse', 'HEAD']).slice(0, 8) }
  } catch (e) {
    return refused([(e as Error).message])
  }
}

/** The first line of a judge run's start reply. */
export function judgeStartLine(id: string, input: JudgeInput, branch: string, config: GrannyConfig, host: HostName): string {
  const reviews = `${input.base ?? config.base}...HEAD by ${reviewersText(config.reviewers, host)}, tagged by ${resolveModel(config.roles.judge.model, host)}`
  return `granny judge run ${id} started on ${input.repo} (${branch}): one review of ${reviews}. Nothing will be changed: no fix, commit, push, branch or worktree, only a report under ${config.workDir.replace(/\/+$/, '')}/reviews/. Uncommitted files are not reviewed.`
}

export interface RetryPolicy {
  delays: number[]
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface HostOptions extends RetryPolicy {
  killGraceMs: number
  /** How often a running command journals a heartbeat. */
  heartbeatMs: number
}

export const HEARTBEAT_MS = 60_000

interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const intervals: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * Runs `work`, calling `beat` every `everyMs` until it settles: a command journals one entry when it starts and
 * nothing while it runs, and a run view would otherwise take a long check for a dead run.
 */
export async function withHeartbeat<T>(work: () => Promise<T>, beat: () => void, everyMs: number, timers: IntervalTimers = intervals): Promise<T> {
  const handle = timers.setInterval(() => {
    try {
      beat()
    } catch {}
  }, everyMs)
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
  try {
    return await work()
  } finally {
    timers.clearInterval(handle)
  }
}

export const DEFAULT_DELAYS = [30_000, 120_000, 300_000, 600_000]

export const KILL_GRACE_MS = 5_000

export function signalGroup(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, name)
  } catch {}
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function runCommand(command: string, cwd: string, signal: AbortSignal, killGraceMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve({ code: 130, output: 'cancelled' })
    const child = spawn('bash', ['-c', command], { cwd, env: process.env, detached: true })
    let output = ''
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      resolve(result)
    }
    const cancel = () => {
      signalGroup(child, 'SIGTERM')
      // Not cleared on close: a member that ignores SIGTERM may not hold our pipes.
      setTimeout(() => {
        signalGroup(child, 'SIGKILL')
        finish({ code: 130, output: `${output}\ncancelled` })
      }, killGraceMs).unref()
    }
    child.stdout?.on('data', d => (output += d))
    child.stderr?.on('data', d => (output += d))
    child.on('error', e => finish({ code: 127, output: String(e) }))
    child.on('close', code => finish(signal.aborted ? { code: 130, output: `${output}\ncancelled` } : { code: code ?? 1, output }))
    if (child.pid !== undefined) signal.addEventListener('abort', cancel, { once: true })
  })
}

/** The run directory granny_status reads: the run by id, else the latest run in `repo`. */
export function runDir(runs: Map<string, { dir: string }>, runIdArg?: string, repo?: string): string | undefined {
  if (runIdArg && runs.has(runIdArg)) return runs.get(runIdArg)!.dir
  if (!repo) return undefined
  const config = resolveConfig([readJson(globalConfigPath()), readJson(join(repo, 'granny.config.json'))])
  const root = join(repo, config.workDir, 'runs')
  const ids = existsSync(root) ? readdirSync(root).sort() : []
  const pick = runIdArg ?? ids.at(-1)
  return pick && ids.includes(pick) ? join(root, pick) : undefined
}

const isHeartbeat = (line: string): boolean => {
  try {
    return JSON.parse(line)?.type === 'heartbeat'
  } catch {
    return false
  }
}

/** The last `count` journal lines that are not heartbeats, parsing from the end only as far as it takes. */
function journalTail(journal: string, count: number): string {
  const tail: string[] = []
  let end = journal.trimEnd().length
  while (end > 0 && tail.length < count) {
    const start = journal.lastIndexOf('\n', end - 1)
    const line = journal.slice(start + 1, end)
    if (!isHeartbeat(line)) tail.push(line)
    end = Math.max(start, 0)
  }
  return tail.reverse().join('\n')
}

export function runStatus(runs: Map<string, { dir: string }>, runIdArg?: string, repo?: string): string {
  const dir = runDir(runs, runIdArg, repo)
  if (!dir) return 'No such granny run. Pass runId, or repo to see the latest run in that repo.'
  const read = (f: string) => (existsSync(join(dir!, f)) ? readFileSync(join(dir!, f), 'utf8') : '')
  const tail = journalTail(read('journal.jsonl'), 40)
  const result = read('result.json')
  return [
    `status: ${read('status.json')}`,
    `journal (last 40 lines, without heartbeats):\n${tail}`,
    result ? `result (${join(dir, 'result.json')}):\n${result.length > 30000 ? result.slice(0, 30000) + '\n...truncated, read the file' : result}` : '',
  ].filter(Boolean).join('\n\n')
}
