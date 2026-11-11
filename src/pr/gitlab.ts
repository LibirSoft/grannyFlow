import { currentBranch, failure, plural, type ExecResult, type PosterIo } from './io'
import { type PlannedComment, type PlannedReview, planRound, type Target } from './plan'
import { MARKER_PREFIX, short } from './render'
import { type Posted, type PostRequest, postRounds } from './rounds'

export interface MrInfo {
  iid: number
  web_url: string
  sha: string
  state?: string
  diff_refs: { start_sha: string }
}

/** Why there is no MR to post to; `code` 2 when the branch has none. */
export interface MrProblem {
  error: string
  code: number
}

/** A GitLab API call: its method, glab's `:id`-relative path and its JSON body. */
export interface GitlabCall {
  method: 'POST' | 'DELETE'
  path: string
  body?: unknown
}

const mrPath = (iid: number) => `projects/:id/merge_requests/${iid}`

function call(io: PosterIo, c: GitlabCall): ExecResult {
  if (c.method === 'DELETE') return io.exec('glab', ['api', c.path, '--method', 'DELETE'])
  return io.exec('glab', ['api', c.path, '--method', 'POST', '--header', 'Content-Type: application/json', '--input', '-'], JSON.stringify(c.body))
}

/** Every value of a paginated list: glab prints one per line with `--output ndjson`. */
function list(io: PosterIo, path: string, fields: string[] = []): unknown[] | { error: string } {
  const r = io.exec('glab', ['api', path, '--method', 'GET', ...fields.flatMap(f => ['--raw-field', f]), '--paginate', '--output', 'ndjson'])
  if (r.code !== 0) return { error: failure(r) }
  try {
    return r.stdout
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => JSON.parse(line) as unknown)
  } catch (e) {
    return { error: `glab printed no JSON list: ${(e as Error).message}` }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** The MR given with `--pr`, else the one open MR the current branch is the source of. */
export function mrOf(io: PosterIo, iid: number | undefined): MrInfo | MrProblem {
  let id = iid
  if (id === undefined) {
    const branch = currentBranch(io)
    if (!branch) return { error: 'open the MR first (no branch is checked out: pass --pr <iid>)', code: 2 }
    const found = list(io, 'projects/:id/merge_requests', [`source_branch=${branch}`, 'state=opened'])
    if (!Array.isArray(found)) return { error: `open the MR first (${found.error})`, code: 2 }
    const mrs = found.filter(isRecord)
    if (!mrs.length) return { error: `open the MR first (no open merge request from ${branch})`, code: 2 }
    if (mrs.length > 1) return { error: `${branch} is the source of ${mrs.length} open MRs: ${mrs.map(m => `!${m.iid} ${m.web_url}`).join(', ')} - pass --pr <iid>`, code: 1 }
    id = Number(mrs[0]!.iid)
  }
  const r = io.exec('glab', ['api', mrPath(id)])
  if (r.code !== 0) return { error: `open the MR first (${failure(r)})`, code: 2 }
  let mr: unknown
  try {
    mr = JSON.parse(r.stdout)
  } catch {
    return { error: `glab printed no MR: ${r.stdout.trim().slice(0, 200)}`, code: 1 }
  }
  if (!isRecord(mr) || !Number.isInteger(mr.iid) || typeof mr.sha !== 'string') return { error: `glab printed no MR: ${r.stdout.trim().slice(0, 200)}`, code: 1 }
  if (!isRecord(mr.diff_refs) || typeof mr.diff_refs.start_sha !== 'string') return { error: `GitLab has no diff for !${mr.iid} yet: run this again in a moment`, code: 1 }
  return mr as unknown as MrInfo
}

const hasCommit = (io: PosterIo, sha: string) => io.exec('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).code === 0

/** What the MR's rounds are planned against; both commits must be in the checkout for `git merge-base`. */
export function mrTarget(io: PosterIo, mr: MrInfo): Target | MrProblem {
  const head = { what: 'head', sha: mr.sha }
  const target = { what: 'target', sha: mr.diff_refs.start_sha }
  const missing = [head, target].filter(c => !hasCommit(io, c.sha)).map(c => `${c.what} commit ${short(c.sha)}`)
  if (missing.length) return { error: `the MR's ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not in this checkout: run git fetch, then run this again`, code: 1 }
  return { head: mr.sha, base: mr.diff_refs.start_sha, platform: 'gitlab' }
}

function draftNote(plan: PlannedReview, c: PlannedComment) {
  const position = {
    position_type: 'text',
    base_sha: plan.mergeBase,
    start_sha: plan.mergeBase,
    head_sha: plan.commit,
    old_path: c.oldPath,
    new_path: c.path,
    new_line: c.line,
    ...(c.kind === 'context' ? { old_line: c.oldLine } : {}),
  }
  return { note: c.body, position }
}

/** The calls that post a round: a draft note per line comment, then one publish whose note is the round's body. */
export function roundCalls(iid: number, plan: PlannedReview): GitlabCall[] {
  const drafts = `${mrPath(iid)}/draft_notes`
  return [...plan.comments.map(c => ({ method: 'POST' as const, path: drafts, body: draftNote(plan, c) })), { method: 'POST', path: `${drafts}/bulk_publish`, body: { note: plan.body } }]
}

/**
 * Deletes the drafts an earlier run left behind, which the next publish would carry. A draft of the user's own
 * would be published too, so it stops on one instead; returns the reason it stopped.
 */
function clearDrafts(io: PosterIo, mr: MrInfo, dryRun: boolean): string | undefined {
  const drafts = list(io, `${mrPath(mr.iid)}/draft_notes`)
  if (!Array.isArray(drafts)) return `could not list your draft notes on !${mr.iid}: ${drafts.error}`
  const notes = drafts.filter(isRecord).map(d => ({ id: Number(d.id), note: String(d.note ?? '') }))
  if (notes.length !== drafts.length || notes.some(d => !Number.isInteger(d.id) || d.id <= 0)) return `could not read your draft notes on !${mr.iid}: glab listed a draft without an id`
  const foreign = notes.filter(d => !d.note.includes(MARKER_PREFIX))
  if (foreign.length) {
    const named = foreign.map(d => `${d.id} ("${d.note.replace(/\s+/g, ' ').trim().slice(0, 60)}")`).join(', ')
    return `your draft notes on !${mr.iid} that granny did not write: ${named} - posting a round publishes all your drafts, so publish or delete them first`
  }
  if (!notes.length) return undefined
  if (dryRun) {
    io.print(`would delete ${plural(notes.length, 'leftover granny draft note')}`)
    return undefined
  }
  for (const d of notes) {
    const r = call(io, { method: 'DELETE', path: `${mrPath(mr.iid)}/draft_notes/${d.id}` })
    if (r.code !== 0) return `could not delete the leftover granny draft note ${d.id}: ${failure(r)}`
  }
  io.print(`deleted ${plural(notes.length, 'leftover granny draft note')}`)
  return undefined
}

function draftId(stdout: string): number | undefined {
  try {
    const id = (JSON.parse(stdout) as { id?: unknown }).id
    return Number.isInteger(id) ? (id as number) : undefined
  } catch {
    return undefined
  }
}

const STUCK = 'the next round would publish that draft too'

/** Posts one round; when GitLab refuses a draft or the publish, deletes the round's drafts and posts its body alone. */
function postRound(io: PosterIo, mr: MrInfo, plan: PlannedReview, replan: (refused: string) => PlannedReview | undefined): Posted {
  const calls = roundCalls(mr.iid, plan)
  const publish = calls.pop()!
  const created: number[] = []
  let unknown: string | undefined
  let refused: string | undefined
  let what = 'a line comment'
  for (const c of calls) {
    const r = call(io, c)
    if (r.code !== 0) {
      refused = failure(r)
      break
    }
    const id = draftId(r.stdout)
    if (id === undefined) unknown ??= r.stdout.replace(/\s+/g, ' ').trim().slice(0, 200)
    else created.push(id)
  }
  const note = (body: string) => call(io, { method: 'POST', path: `${mrPath(mr.iid)}/notes`, body: { body } })
  if (refused === undefined) {
    const published = call(io, publish)
    if (published.code === 0) return { ok: true }
    if (!calls.length) {
      const plain = note(plan.body)
      return plain.code === 0 ? { ok: true } : { ok: false, error: failure(plain) }
    }
    refused = failure(published)
    what = 'the publish of the round'
  }
  for (const id of created) {
    const r = call(io, { method: 'DELETE', path: `${mrPath(mr.iid)}/draft_notes/${id}` })
    if (r.code !== 0) return { ok: false, error: `GitLab refused ${what} (${refused}) and its draft ${id} could not be deleted: ${failure(r)}`, stuck: STUCK }
  }
  if (unknown !== undefined) return { ok: false, error: `GitLab refused ${what} (${refused}) and a draft it created could not be deleted: glab printed no draft id (${unknown})`, stuck: STUCK }
  if (what !== 'a line comment') refused = `the publish failed: ${refused}`
  const flat = replan(refused)
  const plain = flat ? note(flat.body) : undefined
  return plain?.code === 0 ? { ok: true, refused } : { ok: false, error: plain ? failure(plain) : refused }
}

/** Posts one GitLab review (draft notes and a bulk publish) per trail round not yet on the MR; returns the exit code. */
export function postGitlab(io: PosterIo, { records, toplevel, pr: iid, dryRun }: PostRequest): number {
  const mr = mrOf(io, iid)
  if ('error' in mr) {
    io.print(mr.error)
    return mr.code
  }
  const target = mrTarget(io, mr)
  if ('error' in target) {
    io.print(target.error)
    return target.code
  }
  if (mr.state !== undefined && mr.state !== 'opened') io.print(`note: !${mr.iid} is ${mr.state}, not open`)
  const notes = list(io, `${mrPath(mr.iid)}/notes`)
  if (!Array.isArray(notes)) {
    io.print(`could not list the MR's notes: ${notes.error}`)
    return 1
  }
  const posted = notes
    .filter(isRecord)
    .map(n => String(n.body ?? ''))
    .join('\n')
  return postRounds(io, records, dryRun, {
    platform: 'GitLab',
    change: 'MR',
    url: mr.web_url,
    head: mr.sha,
    posted,
    planOf: r => planRound(io, r, records, target, toplevel),
    prepare: () => clearDrafts(io, mr, dryRun),
    preview: plan => roundCalls(mr.iid, plan),
    post: (r, plan) => postRound(io, mr, plan, refused => planRound(io, r, records, target, toplevel, refused)),
  })
}
