import type { TrailRound } from '../core/types'
import { failure, plural, type PosterIo } from './io'
import { type PlannedReview, planRound, type Target } from './plan'
import { roundMarker, short } from './render'

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

export interface PostRequest {
  records: TrailRound[]
  toplevel: string
  pr?: number
  dryRun: boolean
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
  const failed: string[] = []
  for (const r of records) {
    const at = `${r.loop} r${r.round}`
    if (posted.includes(roundMarker(r))) {
      io.print(`${at}: skipped, already posted`)
      continue
    }
    const review = buildReview(io, r, records, pr, toplevel)
    if (!review) {
      io.print(`${at}: clean, nothing to post`)
      continue
    }
    const moved = r.loop !== 'plan' && review.commit_id !== r.reviewedSha ? `, on the PR head ${short(pr.headRefOid)}` : ''
    const what = r.findings.length ? `${plural(review.comments.length, 'line comment')}, ${r.findings.length - review.comments.length} in body${moved}` : `the round's ${r.outcome ?? 'clean'} note`
    if (dryRun) {
      io.print(`${at}: would post ${what}`)
      io.print(JSON.stringify(review, null, 2))
      continue
    }
    const post = (payload: ReviewPayload) => io.exec('gh', ['api', '--method', 'POST', reviewsPath(pr), '--input', '-'], JSON.stringify(payload))
    const sent = post(review)
    if (sent.code === 0) {
      io.print(`${at}: posted ${what}`)
      continue
    }
    // One line GitHub cannot place rejects the whole review: post the round once more with every finding in its body.
    const flat = review.comments.length ? buildReview(io, r, records, pr, toplevel, failure(sent)) : undefined
    const again = flat ? post(flat) : undefined
    if (again?.code === 0) io.print(`${at}: posted with all ${r.findings.length} in body - GitHub refused the line comments: ${failure(sent)}`)
    else {
      io.print(`${at}: FAILED to post - ${failure(again ?? sent)}`)
      failed.push(at)
    }
  }
  io.print(pr.url)
  if (failed.length) {
    io.print(`not posted: ${failed.join(', ')} - run the script again to post only what is missing`)
    return 1
  }
  return 0
}
