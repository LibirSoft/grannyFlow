import type { GrannyConfig } from './config'
import type { Declined, Finding, Implementation, TrailFinding, TrailFix, TrailOutcome, TrailReviewer, TrailRound } from './types'

const FINDING_KEYS = [
  'id',
  'reviewer',
  'severity',
  'file',
  'line',
  'title',
  'detail',
  'verdict',
  'impact',
  'likelihood',
  'fixCost',
  'scope',
  'evidence',
  'priority',
  'reason',
  'decision',
  'duplicates',
  'repeatOf',
] as const satisfies ReadonlyArray<keyof Finding>

/** What a review loop knows when one of its rounds ends. */
export interface RoundFacts {
  loop: string
  name: string
  round: number
  base: string
  reviewedSha?: string
  reviewers: TrailReviewer[]
  findings: Finding[]
  /** The findings sent to the fixer; absent when the round was never routed. */
  sent?: Finding[]
  blockers?: ReadonlySet<string>
  overruled?: ReadonlyArray<{ id: string; said: string }>
  fix?: { label: string; work?: Pick<Implementation, 'startSha' | 'headSha' | 'commits'>; refused?: Declined[]; said?: string }
  outcome?: TrailOutcome
  note?: string
}

const trimmed = (path: string) => path.replace(/\/+$/, '')

export const trailDir = (config: Pick<GrannyConfig, 'workDir'>, cwd: string) => `${trimmed(cwd)}/${trimmed(config.workDir)}/trail`

export const trailId = (loop: string, round: number) => `${loop}-r${round}`

export const trailPath = (config: Pick<GrannyConfig, 'workDir'>, cwd: string, loop: string, round: number) => `${trailDir(config, cwd)}/${trailId(loop, round)}.json`

function trailFinding(f: Finding, r: RoundFacts, sent: Set<string> | undefined): TrailFinding {
  const out: Record<string, unknown> = {}
  for (const key of FINDING_KEYS) if (f[key] !== undefined) out[key] = f[key]
  if (sent) out.route = sent.has(f.id) ? 'sent' : 'residual'
  if (r.blockers?.has(f.id)) out.blocker = true
  const said = r.overruled?.find(o => o.id === f.id)?.said
  if (said !== undefined) out.overruled = said
  return out as unknown as TrailFinding
}

function trailFix(fix: NonNullable<RoundFacts['fix']>): TrailFix {
  const { work } = fix
  return {
    label: fix.label,
    ...(work?.startSha ? { startSha: work.startSha } : {}),
    ...(work?.headSha ? { headSha: work.headSha } : {}),
    ...(Array.isArray(work?.commits) ? { commits: work.commits } : {}),
    ...(fix.refused?.length ? { declined: fix.refused } : {}),
    ...(fix.said ? { deviations: fix.said } : {}),
  }
}

export function trailRound(r: RoundFacts): TrailRound {
  const sent = r.sent ? new Set(r.sent.map(f => f.id)) : undefined
  return {
    version: 1,
    loop: r.loop,
    name: r.name,
    round: r.round,
    base: r.base,
    ...(r.reviewedSha ? { reviewedSha: r.reviewedSha } : {}),
    reviewers: r.reviewers,
    findings: r.findings.map(f => trailFinding(f, r, sent)),
    ...(r.fix ? { fix: trailFix(r.fix) } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.note ? { note: r.note } : {}),
  }
}

export const trailText = (record: TrailRound) => `${JSON.stringify(record, null, 2)}\n`
