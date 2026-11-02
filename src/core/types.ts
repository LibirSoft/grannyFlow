export type HostName = 'claude-code' | 'opencode'

export type Role = 'granny' | 'planner' | 'implementer' | 'reviewer' | 'judge'

export type ResultKind = 'draft' | 'implementation' | 'planFix' | 'findings' | 'score' | 'command' | 'final'

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

export interface Host {
  readonly name: HostName
  agent(request: AgentRequest): Promise<any | null>
  run?(command: string, cwd: string): Promise<CommandResult>
  log(message: string): void
  phase(title: string): void
}

export interface Finding {
  id: string
  reviewer?: string
  severity: string
  file: string
  line?: number
  title: string
  detail: string
  score?: number
  reason?: string
  duplicates?: string[]
}

export interface StageSpec {
  name?: string
  task?: string
  implement?: boolean
  review?: boolean
  repo?: string
  after?: number[]
}

export interface Implementation {
  startSha: string
  headSha: string
  gatesGreen: boolean
  gates: string
  commits: string[]
  untested: string
  deviations?: string
}

export interface RoundRecord {
  round: number
  score: number | null
  findings: Finding[]
}

export type StageOutcome = 'clean' | 'residual-only' | 'round-cap' | 'review-failed' | 'review-skipped' | 'gates-red' | 'no-changes' | 'skipped'

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
}

export interface PlanFix {
  files: string[]
  changes: string
  deviations?: string
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
  final: FinalReport | null
  repos?: RepoResult[]
}
