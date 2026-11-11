import type { TrailRound } from '../core/types'
import { plural, type PosterIo } from './io'
import type { PlannedReview } from './plan'
import { roundMarker, short } from './render'

export interface PostRequest {
  records: TrailRound[]
  toplevel: string
  pr?: number
  dryRun: boolean
}

/** What posting a round did: `refused` is the platform's error when only the all-in-body retry went through; `stuck` stops the run. */
export type Posted = { ok: true; refused?: string } | { ok: false; error: string; stuck?: string }

/** How one platform plans, previews and posts the rounds of a PR or MR. */
export interface RoundPoster {
  platform: 'GitHub' | 'GitLab'
  change: 'PR' | 'MR'
  url: string
  /** The PR or MR head commit. */
  head: string
  /** Every body already on the PR or MR, to find the markers of the rounds posted before. */
  posted: string
  planOf(r: TrailRound): PlannedReview | undefined
  /** Runs once, before the first round that has something to post; returns why the run stops. */
  prepare?(): string | undefined
  /** What `--dry-run` prints for a round instead of posting it. */
  preview(plan: PlannedReview): unknown
  post(r: TrailRound, plan: PlannedReview): Posted
}

/** What a round posts, as its output line names it. */
export function summary(r: TrailRound, plan: PlannedReview, poster: Pick<RoundPoster, 'change' | 'head'>): string {
  if (!r.findings.length) return `the round's ${r.outcome ?? 'clean'} note`
  const moved = r.loop !== 'plan' && plan.commit !== r.reviewedSha ? `, on the ${poster.change} head ${short(poster.head)}` : ''
  return `${plural(plan.comments.length, 'line comment')}, ${r.findings.length - plan.comments.length} in body${moved}`
}

/** Posts every round not yet on the PR or MR, one line of output per round; returns the exit code. */
export function postRounds(io: PosterIo, records: TrailRound[], dryRun: boolean, poster: RoundPoster): number {
  const failed: string[] = []
  let prepared = false
  for (const r of records) {
    const at = `${r.loop} r${r.round}`
    if (poster.posted.includes(roundMarker(r))) {
      io.print(`${at}: skipped, already posted`)
      continue
    }
    const plan = poster.planOf(r)
    if (!plan) {
      io.print(`${at}: clean, nothing to post`)
      continue
    }
    if (!prepared) {
      const stop = poster.prepare?.()
      if (stop !== undefined) {
        io.print(stop)
        io.print(poster.url)
        return 1
      }
      prepared = true
    }
    const what = summary(r, plan, poster)
    if (dryRun) {
      io.print(`${at}: would post ${what}`)
      io.print(JSON.stringify(poster.preview(plan), null, 2))
      continue
    }
    const sent = poster.post(r, plan)
    if (sent.ok && sent.refused === undefined) io.print(`${at}: posted ${what}`)
    else if (sent.ok) io.print(`${at}: posted with all ${r.findings.length} in body - ${poster.platform} refused the line comments: ${sent.refused}`)
    else {
      io.print(`${at}: FAILED to post - ${sent.error}`)
      failed.push(at)
      if (sent.stuck !== undefined) {
        io.print(`stopped: ${sent.stuck}`)
        break
      }
    }
  }
  io.print(poster.url)
  if (failed.length) {
    io.print(`not posted: ${failed.join(', ')} - run the script again to post only what is missing`)
    return 1
  }
  return 0
}
