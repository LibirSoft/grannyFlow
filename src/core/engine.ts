import { resolveConfig, resolveModel, type GrannyConfig, type ReviewerConfig, type RoleConfig } from './config'
import {
  agentReviewPrompt,
  commandReviewPrompt,
  extractPrompt,
  finalPrompt,
  fixPrompt,
  implementPrompt,
  judgePrompt,
  reviewCommandPrompt,
  worktreeCommandPrompt,
  type PromptContext,
} from './prompts'
import { isBlocker, mergeDuplicates, parseCodexReview, reviewFailure, triage } from './review'
import { reportedBackend, reviewPlan, reviewStem } from './reviewer'
import { SCHEMAS } from './schemas'
import { shellQuote } from './shell'
import { reportedWorktree, worktreePath, worktreeScript } from './worktree'
import type {
  AgentRequest,
  FinalReport,
  Finding,
  Host,
  Implementation,
  ResultKind,
  Role,
  RoundRecord,
  RunResult,
  StageResult,
  StageSpec,
} from './types'

export interface RunInput {
  repo: string
  branch: string
  base?: string
  context?: string
  plan?: string | string[]
  stages: StageSpec[]
  fromStage?: number
  config?: unknown | unknown[]
}

interface ReviewerRound {
  reviewer: ReviewerConfig
  ran: boolean
  findings: Finding[]
  note?: string
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stage'

export function checkInput(input: RunInput): string[] {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return ['input must be an object']
  if (typeof input.repo !== 'string' || !input.repo.startsWith('/')) errors.push('repo must be an absolute path')
  if (typeof input.branch !== 'string' || !input.branch) errors.push('branch is required')
  if (!Array.isArray(input.stages) || !input.stages.length) errors.push('stages must be a non-empty array')
  else input.stages.forEach((s, i) => {
    if (!s || typeof s !== 'object') errors.push(`stages[${i}] must be an object`)
    else if (s.implement === false && s.review === false) errors.push(`stages[${i}] has nothing to do (implement and review are both false)`)
    else if (s.implement !== false && (typeof s.task !== 'string' || !s.task.trim())) errors.push(`stages[${i}].task is required`)
  })
  if (input.fromStage !== undefined && (!Number.isInteger(input.fromStage) || input.fromStage < 1 || input.fromStage > (input.stages?.length ?? 0))) {
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

const planFiles = (input: RunInput): string[] => (input.plan === undefined ? [] : Array.isArray(input.plan) ? input.plan : [input.plan])

export async function runGranny(host: Host, input: RunInput): Promise<RunResult> {
  const inputErrors = checkInput(input)
  if (inputErrors.length) throw new Error(`Invalid granny input:\n- ${inputErrors.join('\n- ')}`)

  const layers = Array.isArray(input.config) ? input.config : [input.config]
  const config = resolveConfig(layers, host.name)
  const base = input.base ?? config.base
  const fromStage = input.fromStage ?? 1
  let repo = input.repo

  const call = async (role: Role, kind: ResultKind, label: string, phase: string, prompt: string, access: AgentRequest['access'], rc: RoleConfig) =>
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
      cwd: repo,
    })

  const setUpWorktree = async (): Promise<string> => {
    const script = worktreeScript(config, input.branch, base, worktreePath(input.repo, input.branch, config.worktreeDir))
    let ran: boolean
    let code: number | string
    let output: string
    if (host.run) {
      const r = await host.run(script, input.repo)
      ran = r.code === 0
      code = r.code
      output = r.output
    } else {
      const prompt = worktreeCommandPrompt(input.repo, input.branch, `cd ${shellQuote(input.repo)} && ${script}`)
      const r = await call('granny', 'command', 'worktree', 'Worktree', prompt, 'write', config.roles.granny)
      ran = Boolean(r?.ran)
      code = r?.exitCode ?? (ran ? 0 : '?')
      output = r ? `${String(r.output ?? '')}${r.note ? `\n${r.note}` : ''}` : 'the worktree runner returned nothing'
    }
    const path = ran ? reportedWorktree(output) : undefined
    if (!path) throw new Error(`worktree setup failed (exit ${code}): ${output.slice(-2000)}`)
    host.log(`worktree: ${path}`)
    return path
  }

  if (config.worktree) {
    host.phase('Worktree')
    repo = await setUpWorktree()
  }
  const plans = planFiles(input)
  const context = [plans.length ? `Plan files - read them first: ${plans.join(', ')}` : '', input.context ?? ''].filter(Boolean).join('\n') || undefined
  const p: PromptContext = { repo, branch: input.branch, base, context, config }

  const implement = async (label: string, prompt: string): Promise<Implementation> => {
    const r = (await call('implementer', 'implementation', label, 'Implement', prompt, 'write', config.roles.implementer)) as Implementation | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: ${r.startSha.slice(0, 8)}..${r.headSha.slice(0, 8)}, gates ${r.gatesGreen ? 'green' : 'RED'} - ${r.gates}`)
    return r
  }

  const attribute = (rv: ReviewerConfig, findings: Finding[]): Finding[] =>
    findings.map((f, i) => ({ ...f, id: `${rv.name}-F${i + 1}`, reviewer: rv.name }))

  const review = async (rv: ReviewerConfig, name: string, reviewBase: string, round: number, attempt: number): Promise<Omit<ReviewerRound, 'reviewer'>> => {
    const tag = `${name} r${round} ${rv.name}${attempt > 1 ? ` #${attempt}` : ''}`
    if (rv.engine === 'agent') {
      const r = await call('reviewer', 'findings', `review ${tag}`, 'Review', agentReviewPrompt(p, name, reviewBase), 'read-only', rv)
      if (!r) return { ran: false, findings: [], note: 'reviewer agent returned nothing' }
      return { ran: true, findings: Array.isArray(r.findings) ? r.findings : [] }
    }

    const plan = reviewPlan(rv, config, host.name, reviewBase, reviewStem(config, slug(name), round, rv), commandReviewPrompt(p, name, reviewBase))
    let ran: boolean
    let output: string
    let note: string | undefined
    if (host.run) {
      const r = await host.run(plan.script, repo)
      ran = r.code === 0
      output = r.output
      if (!ran) note = `review command exited ${r.code}: ${r.output.slice(-2000)}`
    } else {
      const script = `cd ${shellQuote(repo)} && ${plan.script}`
      const r = await call('granny', 'command', `review ${tag}`, 'Review', reviewCommandPrompt(p, name, rv.name, script), 'read-only', config.roles.granny)
      ran = Boolean(r?.ran)
      output = String(r?.output ?? '')
      if (!ran) note = r ? `review command exited ${r.exitCode ?? '?'}${r.note ? ` (${r.note})` : ''}: ${output.slice(-2000)}` : 'review runner returned nothing'
    }
    host.log(`${tag}: reviewer: ${plan.backend ?? reportedBackend(output) ?? 'not reported'}`)
    if (!ran) return { ran, findings: [], note }
    const failure = reviewFailure(output)
    if (failure) return { ran: false, findings: [], note: `reviewer returned no usable result (${failure}): ${output.slice(-2000)}` }

    const parsed = parseCodexReview(output, repo)
    if (parsed.markers <= parsed.findings.length) return { ran, findings: parsed.findings }

    host.log(`${tag}: parser read ${parsed.findings.length}/${parsed.markers} findings - asking an agent to extract them`)
    const extract = async (label: string, prompt: string): Promise<Finding[]> => {
      const r = await call('granny', 'findings', label, 'Review', prompt, 'read-only', config.roles.granny)
      return Array.isArray(r?.findings) ? r.findings : []
    }
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

  const attempt = async (rv: ReviewerConfig, name: string, reviewBase: string, round: number, n: number): Promise<Omit<ReviewerRound, 'reviewer'>> => {
    try {
      return await review(rv, name, reviewBase, round, n)
    } catch (e) {
      return { ran: false, findings: [], note: `reviewer call failed: ${String((e as Error)?.message ?? e)}` }
    }
  }

  const reviewAll = (name: string, reviewBase: string, round: number): Promise<ReviewerRound[]> =>
    Promise.all(
      config.reviewers.map(async reviewer => {
        let r = await attempt(reviewer, name, reviewBase, round, 1)
        if (!r.ran) {
          host.log(`${name} r${round} ${reviewer.name}: did not run - retrying once. ${r.note ?? ''}`)
          r = await attempt(reviewer, name, reviewBase, round, 2)
        }
        return { reviewer, ...r, findings: attribute(reviewer, r.findings) }
      }),
    )

  const reviewLoop = async (name: string, reviewBase: string): Promise<Omit<StageResult, 'stage' | 'implementation'>> => {
    const history: RoundRecord[] = []
    let unmerged: Finding[] = []
    for (let round = 1; round <= config.maxRounds; round++) {
      const results = await reviewAll(name, reviewBase, round)
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

      const blockers = found.filter(isBlocker)
      const judged = found.filter(f => !isBlocker(f))
      if (blockers.length) {
        host.log(`${name} r${round}: ${blockers.length} P0/P1 finding(s) go to the implementer without the judge: ${blockers.map(f => f.id).join(', ')}`)
      }
      let findings = found
      unmerged = found
      let score: number | null = null
      if (judged.length) {
        const scored = await call('judge', 'score', `judge ${name} r${round}`, 'Review', judgePrompt(p, reviewBase, judged), 'read-only', config.roles.judge)
        if (!scored) host.log(`${name} r${round}: judge returned nothing - all ${judged.length} finding(s) go to the implementer unscored`)
        const per: Array<{ id: string; score: number; reason: string; duplicateOf?: string }> = Array.isArray(scored?.perFinding) ? scored.perFinding : []
        const judgedIds = new Set(judged.map(f => f.id))
        const duplicateOf = new Map(
          per.filter(x => judgedIds.has(x.id) && typeof x.duplicateOf === 'string' && judgedIds.has(x.duplicateOf)).map(x => [x.id, x.duplicateOf!]),
        )
        const withScores = found.map(f => {
          const s = judgedIds.has(f.id) ? per.find(x => x.id === f.id) : undefined
          return s ? { ...f, score: s.score, reason: s.reason } : { ...f }
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
      if (residual.length) {
        host.log(`${name} r${round}: ${residual.length} finding(s) <= ${config.threshold} and not P0/P1, not sent: ${residual.map(f => `${f.id}(${f.score})`).join(', ')}`)
      }
      if (!accepted.length) {
        host.log(`${name} r${round}: nothing actionable left - stage done with ${residual.length} residual finding(s) for the user`)
        return { outcome: 'residual-only', rounds: round, residual, unresolved: [], history }
      }

      const fix = await implement(`fix ${name} r${round}`, fixPrompt(p, name, round, accepted))
      if (!fix.gatesGreen) host.log(`${name} r${round}: WARNING fixer left gates red - ${fix.gates}`)
    }
    host.log(`${name}: hit the ${config.maxRounds}-round cap without a clean review`)
    return { outcome: 'round-cap', rounds: config.maxRounds, residual: [], unresolved: history.at(-1)?.findings ?? [], history }
  }

  const stages: StageResult[] = []
  for (let i = 0; i < input.stages.length; i++) {
    const st = input.stages[i]!
    const name = st.name || `stage ${i + 1}`
    if (i + 1 < fromStage) {
      stages.push({ stage: name, outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [] })
      continue
    }
    let impl: Implementation | undefined
    if (st.implement !== false) {
      host.phase('Implement')
      impl = await implement(`implement ${name}`, implementPrompt(p, st, i, input.stages.length, name))
      if (!impl.gatesGreen) host.log(`${name}: implementer ended with RED gates - review will see it`)
    } else {
      host.log(`${name}: review-only stage - reviewing ${base}...HEAD`)
    }

    host.phase('Review')
    const loop = st.review === false
      ? { outcome: 'review-skipped' as const, rounds: 0, residual: [], unresolved: [], history: [] }
      : await reviewLoop(name, impl?.startSha || base)
    stages.push({ stage: name, ...(impl ? { implementation: impl } : {}), ...loop })
  }

  host.phase('PR ready')
  const final = (await call('granny', 'final', 'pr-ready check', 'PR ready', finalPrompt(p), 'write', config.roles.granny)) as FinalReport | null
  if (!final) host.log('final check returned nothing')

  return { repo: input.repo, branch: input.branch, base, worktree: repo, stages, final }
}

export type { GrannyConfig }
