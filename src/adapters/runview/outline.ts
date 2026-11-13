// The shape of a run as the server knows it at launch - its kind, stages and optional steps - written
// to status.json so a run view can list stages that have not started and the steps still to come.
import type { GrannyConfig } from '../../core/config'
import type { RunInput } from '../../core/engine'
import { clean } from './format'

export interface StageOutline {
  number: number
  name: string
  implement: boolean
  review: boolean
  checks: boolean
  /** The step count, when the stage's steps run as step agents (config stepAgents, two or more steps). */
  steps?: number
}

export interface RunOutline {
  kind: 'plan' | 'implement' | 'judge'
  branch: string
  worktree: boolean
  planReview: boolean
  finalReview: boolean
  reviewers: string[]
  fromStage: number
  stages: StageOutline[]
  /** The round cap of a review loop; a run from before it has none. */
  maxRounds?: number
}

export function runOutline(input: RunInput, config: GrannyConfig): RunOutline {
  const kind = input.goal !== undefined ? 'plan' : 'implement'
  const fromStage = input.fromStage ?? 1
  const stages = (input.stages ?? []).map(
    (st, i): StageOutline => ({
      number: i + 1,
      name: clean(st.name || `stage ${i + 1}`),
      implement: st.implement !== false,
      review: st.review !== false,
      checks: (st.checks === undefined ? config.checks.length : st.checks.length) > 0,
      ...(config.stepAgents && st.steps && st.steps.length > 1 ? { steps: st.steps.length } : {}),
    }),
  )
  return {
    kind,
    branch: clean(input.branch),
    worktree: config.worktree,
    planReview: config.planReview && (kind === 'plan' || (input.plan !== undefined && fromStage === 1)),
    finalReview: config.finalReview && stages.length > 1,
    reviewers: config.reviewers.map(r => clean(r.name)),
    fromStage,
    stages,
    maxRounds: config.maxRounds,
  }
}

/** A review-only run: no stages and no worktree, on what the checkout has checked out. */
export function judgeOutline(branch: string, config: GrannyConfig): RunOutline {
  return { kind: 'judge', branch: clean(branch), worktree: false, planReview: false, finalReview: false, reviewers: config.reviewers.map(r => clean(r.name)), fromStage: 1, stages: [] }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1

function readStage(v: unknown): StageOutline | undefined {
  if (!isRecord(v) || !isCount(v.number) || typeof v.name !== 'string') return undefined
  if (typeof v.implement !== 'boolean' || typeof v.review !== 'boolean' || typeof v.checks !== 'boolean') return undefined
  return { number: v.number, name: clean(v.name), implement: v.implement, review: v.review, checks: v.checks, ...(isCount(v.steps) ? { steps: v.steps } : {}) }
}

/** The outline from status.json, or undefined when anything in it is malformed. */
export function readOutline(value: unknown): RunOutline | undefined {
  if (!isRecord(value)) return undefined
  const { kind, branch, worktree, planReview, finalReview, reviewers, fromStage, stages, maxRounds } = value
  if (kind !== 'plan' && kind !== 'implement' && kind !== 'judge') return undefined
  if (typeof branch !== 'string' || typeof worktree !== 'boolean' || typeof planReview !== 'boolean' || typeof finalReview !== 'boolean') return undefined
  if (!Array.isArray(reviewers) || !reviewers.every(r => typeof r === 'string') || !isCount(fromStage) || !Array.isArray(stages)) return undefined
  const read = stages.map(readStage)
  if (read.some(s => s === undefined)) return undefined
  return { kind, branch: clean(branch), worktree, planReview, finalReview, reviewers: reviewers.map(r => clean(r as string)), fromStage, stages: read as StageOutline[], ...(isCount(maxRounds) ? { maxRounds } : {}) }
}
