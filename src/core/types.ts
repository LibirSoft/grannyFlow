export const HOSTS = ['claude-code', 'opencode', 'omp'] as const
export type HostName = (typeof HOSTS)[number]

export type Role = 'granny' | 'helper' | 'planner' | 'implementer' | 'reviewer' | 'judge'

export const IMPACTS = ['critical', 'major', 'moderate', 'minor', 'none'] as const
export type Impact = (typeof IMPACTS)[number]

export const VERDICTS = ['confirmed', 'refuted', 'unverified'] as const
export type Verdict = (typeof VERDICTS)[number]
export const LIKELIHOODS = ['common', 'edge', 'rare'] as const
export type Likelihood = (typeof LIKELIHOODS)[number]
export const FIX_COSTS = ['trivial', 'small', 'large'] as const
export type FixCost = (typeof FIX_COSTS)[number]
export const SCOPES = ['in-scope', 'pre-existing', 'other-stage'] as const
export type Scope = (typeof SCOPES)[number]

export interface Decision {
  rule: number
  action: 'fix' | 'residual'
  why: string
  attention?: true
  /** What the ratchet raised on a repeat whose classes dropped below the earlier entry's. */
  raised?: string
}

export type ResultKind = 'draft' | 'implementation' | 'planFix' | 'findings' | 'judge' | 'command' | 'final'

export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface AgentRequest {
  role: Role
  kind: ResultKind
  label: string
  phase: string
  prompt: string
  schema: JsonSchema
  model?: string
  effort?: string
  access: 'write' | 'read-only'
  cwd: string
}

export interface CommandResult {
  code: number
  output: string
}

export interface StageEvent {
  number: number
  name: string
  event: 'start' | 'end'
  outcome?: StageOutcome
}

/** One finding of a review round, as a run view shows it. */
export interface RoundFinding {
  id: string
  sent: boolean
  severity?: string
  title?: string
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

/** How a review round of `subject` (a stage's name, `plan review`, `final review`) was routed. */
export interface RoundEvent {
  subject: string
  round: number
  findings: RoundFinding[]
}

export interface Host {
  readonly name: HostName
  agent(request: AgentRequest): Promise<any | null>
  run?(command: string, cwd: string): Promise<CommandResult>
  /** True once the run is cancelled; the engine then stops at the next step instead of reading what the step returned. */
  cancelled?(): boolean
  log(message: string): void
  phase(title: string): void
  /** A stage started or ended; a stage that never starts gets one `end` with outcome `skipped`. */
  stage?(event: StageEvent): void
  /** A review round was routed: clean, or each finding sent back or kept. */
  round?(event: RoundEvent): void
}

export interface Finding {
  id: string
  reviewer?: string
  severity: string
  file: string
  line?: number
  title: string
  detail: string
  verdict?: Verdict
  impact?: Impact
  likelihood?: Likelihood
  fixCost?: FixCost
  scope?: Scope
  evidence?: string
  priority?: number
  reason?: string
  decision?: Decision
  duplicates?: string[]
  repeatOf?: string
}

export interface Declined {
  id: string
  reason: string
}

export interface StageSpec {
  name?: string
  task?: string
  implement?: boolean
  review?: boolean
  repo?: string
  after?: number[]
  checks?: string[]
}

export interface Implementation {
  startSha: string
  headSha: string
  gatesGreen: boolean
  gates: string
  commits: string[]
  untested: string
  deviations?: string
  declined?: Declined[]
}

export interface RoundRecord {
  round: number
  findings: Finding[]
  deviations?: string
  declined?: Declined[]
}

export type StageOutcome = 'clean' | 'residual-only' | 'round-cap' | 'review-failed' | 'review-skipped' | 'gates-red' | 'no-changes' | 'checks-failed' | 'skipped'

export interface CheckResult {
  name: string
  passed: boolean
  code: number | string
  metric?: number
  note?: string
}

export interface CheckRun {
  at: string
  attempt: number
  head?: string
  results: CheckResult[]
}

export interface Recheck {
  passed: boolean
  note?: string
}

export interface StageResult {
  stage: string
  repo?: string
  outcome: StageOutcome
  rounds: number
  implementation?: Implementation
  residual: Finding[]
  unresolved: Finding[]
  history: RoundRecord[]
  note?: string
  checks?: CheckRun[]
}

export interface PlanFix {
  files: string[]
  changes: string
  deviations?: string
  declined?: Declined[]
}

export type PlanResult = Omit<StageResult, 'stage' | 'implementation'>

export interface PlanDraft {
  files: string[]
  stages: StageSpec[]
  summary: string
  questions?: string
}

export interface FinalReport {
  gatesGreen: boolean
  gates: string
  commits: string[]
  prBodyPath: string
  issues: string
}

export interface RepoResult {
  repo: string
  base: string
  worktree: string
  finalReview?: PlanResult
  checks?: CheckRun[]
  recheck?: Recheck
  final: FinalReport | null
}

export interface RunResult {
  repo: string
  branch: string
  base: string
  worktree: string
  draft?: PlanDraft
  plan?: PlanResult
  stages: StageResult[]
  finalReview?: PlanResult
  checks?: CheckRun[]
  recheck?: Recheck
  final: FinalReport | null
  repos?: RepoResult[]
}

export type ReportBucket = 'P0' | 'P1' | 'P2' | 'P3' | 'dismissed'
export type JudgeCounts = Record<ReportBucket, number>
export type JudgeOutcome = 'reviewed' | 'no-changes' | 'review-failed'

export interface JudgeResult {
  repo: string
  branch: string
  base: string
  head: string
  outcome: JudgeOutcome
  counts: JudgeCounts
  /** Ids of the findings a reviewer rated P0 or P1 and the judge placed lower or dismissed. */
  demoted: string[]
  findings: Finding[]
  failedReviewers: Array<{ name: string; note: string }>
  notJudged: string[]
  uncommitted: string[]
  reportPath?: string
  written: boolean
  report?: string
  note?: string
}
