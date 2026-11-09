import type { TrailRound } from '../core/types'
import { failure, type PosterIo } from './io'
import { type PlannedReview, planRound, type Target } from './plan'
import { type PostRequest, postRounds } from './rounds'

export interface PrInfo {
  number: number
  url: string
  headRefOid: string
  baseRefOid: string
}

export interface LineComment {
  path: string
  line: number
  side: 'RIGHT'
  body: string
}

export interface ReviewPayload {
  commit_id: string
  event: 'COMMENT'
  body: string
  comments: LineComment[]
}

export function prOf(io: PosterIo, pr: number | undefined): PrInfo | string {
  const r = io.exec('gh', ['pr', 'view', ...(pr === undefined ? [] : [String(pr)]), '--json', 'number,url,headRefOid,baseRefOid'])
  if (r.code !== 0) return failure(r)
  try {
    const info = JSON.parse(r.stdout) as PrInfo
    if (Number.isInteger(info.number) && typeof info.headRefOid === 'string' && typeof info.baseRefOid === 'string') return info
  } catch {}
  return `gh pr view printed no PR: ${r.stdout.trim().slice(0, 200)}`
}

export const prTarget = (pr: PrInfo): Target => ({ head: pr.headRefOid, base: pr.baseRefOid })

const reviewsPath = (pr: PrInfo) => `repos/{owner}/{repo}/pulls/${pr.number}/reviews`

/** The PR's review bodies as one text, to find the markers of the rounds already posted. */
function postedBodies(io: PosterIo, pr: PrInfo): string | { error: string } {
  const r = io.exec('gh', ['api', '--paginate', reviewsPath(pr), '--jq', '.[].body'])
  return r.code === 0 ? r.stdout : { error: failure(r) }
}

export const reviewPayload = (plan: PlannedReview): ReviewPayload => ({
  commit_id: plan.commit,
  event: 'COMMENT',
  body: plan.body,
  comments: plan.comments.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
})

/** `refused` (GitHub's error on the first try) puts every finding in the body, with no line comment. */
export function buildReview(io: PosterIo, r: TrailRound, records: TrailRound[], pr: PrInfo, toplevel: string, refused?: string): ReviewPayload | undefined {
  const plan = planRound(io, r, records, prTarget(pr), toplevel, refused)
  return plan && reviewPayload(plan)
}

/** Posts one GitHub review per trail round not yet on the PR; returns the exit code. */
export function postGithub(io: PosterIo, { records, toplevel, pr: prNumber, dryRun }: PostRequest): number {
  const pr = prOf(io, prNumber)
  if (typeof pr === 'string') {
    io.print(`open the PR first (${pr})`)
    return 2
  }
  const posted = postedBodies(io, pr)
  if (typeof posted !== 'string') {
    io.print(`could not list the PR's reviews: ${posted.error}`)
    return 1
  }
  const send = (payload: ReviewPayload) => io.exec('gh', ['api', '--method', 'POST', reviewsPath(pr), '--input', '-'], JSON.stringify(payload))
  return postRounds(io, records, dryRun, {
    platform: 'GitHub',
    change: 'PR',
    url: pr.url,
    head: pr.headRefOid,
    posted,
    planOf: r => planRound(io, r, records, prTarget(pr), toplevel),
    preview: reviewPayload,
    post(r, plan) {
      const sent = send(reviewPayload(plan))
      if (sent.code === 0) return { ok: true }
      // One line GitHub cannot place rejects the whole review: post the round once more with every finding in its body.
      const flat = plan.comments.length ? buildReview(io, r, records, pr, toplevel, failure(sent)) : undefined
      const again = flat ? send(flat) : undefined
      return again?.code === 0 ? { ok: true, refused: failure(sent) } : { ok: false, error: failure(again ?? sent) }
    },
  })
}
