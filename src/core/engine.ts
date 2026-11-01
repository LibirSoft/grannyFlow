import { codexCommand, resolveConfig, resolveModel, reviewerEngine, type GrannyConfig } from './config'
import {
  agentReviewPrompt,
  extractPrompt,
  finalPrompt,
  fixPrompt,
  implementPrompt,
  judgePrompt,
  reviewCommandPrompt,
  type PromptContext,
} from './prompts'
import { parseCodexReview, triage } from './review'
import { SCHEMAS } from './schemas'
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
  stages: StageSpec[]
  fromStage?: number
  config?: unknown | unknown[]
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
  return errors
}

export async function runGranny(host: Host, input: RunInput): Promise<RunResult> {
  const inputErrors = checkInput(input)
  if (inputErrors.length) throw new Error(`Invalid granny input:\n- ${inputErrors.join('\n- ')}`)

  const layers = Array.isArray(input.config) ? input.config : [input.config]
  const config = resolveConfig(layers)
  const base = input.base ?? config.base
  const p: PromptContext = { repo: input.repo, branch: input.branch, base, context: input.context, config }
  const fromStage = input.fromStage ?? 1

  const call = async (role: Role, kind: ResultKind, label: string, phase: string, prompt: string, access: AgentRequest['access']) => {
    const rc = config.roles[role]
    return host.agent({
      role,
      kind,
      label,
      phase,
      prompt,
      schema: SCHEMAS[kind],
      model: resolveModel(rc.model, host.name),
      effort: rc.effort,
      access,
    })
  }

  const implement = async (label: string, prompt: string): Promise<Implementation> => {
    const r = (await call('implementer', 'implementation', label, 'Implement', prompt, 'write')) as Implementation | null
    if (!r) throw new Error(`${label}: implementer returned nothing`)
    host.log(`${label}: ${r.startSha.slice(0, 8)}..${r.headSha.slice(0, 8)}, gates ${r.gatesGreen ? 'green' : 'RED'} - ${r.gates}`)
    return r
  }

  const review = async (name: string, reviewBase: string, round: number): Promise<{ ran: boolean; findings: Finding[]; note?: string }> => {
    const label = `review ${name} r${round}`
    if (reviewerEngine(config) === 'agent') {
      const r = await call('reviewer', 'findings', label, 'Review', agentReviewPrompt(p, name, reviewBase), 'read-only')
      if (!r) return { ran: false, findings: [], note: 'reviewer agent returned nothing' }
      return { ran: true, findings: r.findings ?? [] }
    }

    const stem = `${config.workDir}/review-${slug(name)}-r${round}`
    const script = `mkdir -p ${config.workDir} && ${codexCommand(config, reviewBase, `${stem}.md`)} > ${stem}.log 2>&1; code=$?; if [ -s ${stem}.md ]; then cat ${stem}.md; else cat ${stem}.log; fi; exit $code`
    let ran: boolean
    let output: string
    let note: string | undefined
    if (host.run) {
      const r = await host.run(script, input.repo)
      ran = r.code === 0
      output = r.output
      if (!ran) note = `review command exited ${r.code}: ${r.output.slice(-2000)}`
    } else {
      const r = await call('granny', 'command', label, 'Review', reviewCommandPrompt(p, name, `cd ${input.repo} && ${script}`), 'read-only')
      ran = Boolean(r?.ran)
      output = String(r?.output ?? '')
      if (!ran) note = r?.note ?? 'review runner returned nothing'
    }
    if (!ran) return { ran, findings: [], note }

    const parsed = parseCodexReview(output, input.repo)
    if (parsed.markers > parsed.findings.length) {
      host.log(`${name} r${round}: parser read ${parsed.findings.length}/${parsed.markers} findings - asking an agent to extract them`)
      const r = await call('granny', 'findings', `extract ${name} r${round}`, 'Review', extractPrompt(name, output), 'read-only')
      if (r?.findings?.length) return { ran, findings: r.findings }
    }
    return { ran, findings: parsed.findings }
  }

  const reviewLoop = async (name: string, reviewBase: string): Promise<Omit<StageResult, 'stage' | 'implementation'>> => {
    const history: RoundRecord[] = []
    for (let round = 1; round <= config.maxRounds; round++) {
      const r = await review(name, reviewBase, round)
      if (!r.ran) {
        host.log(`${name} r${round}: review did not run - stopping this stage's loop. ${r.note ?? ''}`)
        return { outcome: 'review-failed', rounds: round, residual: [], unresolved: history.at(-1)?.findings ?? [], history, note: r.note }
      }
      if (!r.findings.length) {
        host.log(`${name} r${round}: clean`)
        return { outcome: 'clean', rounds: round, residual: [], unresolved: [], history }
      }

      const scored = await call('judge', 'score', `judge ${name} r${round}`, 'Review', judgePrompt(p, reviewBase, r.findings), 'read-only')
      const per: Array<{ id: string; score: number; reason: string }> = scored?.perFinding ?? []
      const findings: Finding[] = r.findings.map(f => {
        const s = per.find(x => x.id === f.id)
        return s ? { ...f, score: s.score, reason: s.reason } : { ...f }
      })
      const score = typeof scored?.score === 'number' ? scored.score : null
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
  const final = (await call('granny', 'final', 'pr-ready check', 'PR ready', finalPrompt(p), 'write')) as FinalReport | null
  if (!final) host.log('final check returned nothing')

  return { repo: input.repo, branch: input.branch, base, stages, final }
}

export type { GrannyConfig }
