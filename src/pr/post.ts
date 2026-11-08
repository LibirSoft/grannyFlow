import type { TrailFinding, TrailRound } from '../core/types'
import { type Hunks, onChangedLine, parseHunks } from './hunks'
import { byTrailOrder, trailProblem } from './records'
import { cleanBody, findingComment, roundBody, roundMarker, short } from './render'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Everything the poster touches outside itself: git, gh, the trail files and its output. */
export interface PosterIo {
  exec(cmd: 'git' | 'gh', args: string[], input?: string): ExecResult
  /** The `*.json` names in `dir`, or undefined when it does not exist. */
  list(dir: string): string[] | undefined
  read(path: string): string
  /** The config's work dir for the checkout at `toplevel`; throws on an invalid config. */
  workDir(toplevel: string): string
  print(line: string): void
}

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

export const USAGE = 'usage: node pr-comments.mjs [--pr <number>] [--trail <dir>] [--dry-run]'

interface Options {
  pr?: number
  trail?: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Options | string {
  const options: Options = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--pr' || arg === '--trail') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`
      if (arg === '--trail') options.trail = value
      else if (/^[1-9]\d*$/.test(value)) options.pr = Number(value)
      else return `--pr takes a PR number, got ${value}`
    } else return `unknown argument ${arg}`
  }
  return options
}

const failure = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ') || `exit ${r.code}`

function readRecords(io: PosterIo, dir: string): TrailRound[] | undefined {
  const names = io.list(dir)
  if (names === undefined) return undefined
  const records: TrailRound[] = []
  for (const name of [...names].sort()) {
    let value: unknown
    try {
      value = JSON.parse(io.read(`${dir}/${name}`))
    } catch (e) {
      io.print(`skipped ${name}: ${(e as Error).message}`)
      continue
    }
    const problem = trailProblem(value)
    if (problem) io.print(`skipped ${name}: ${problem}`)
    else records.push(value as TrailRound)
  }
  return records.sort(byTrailOrder)
}

function prOf(io: PosterIo, pr: number | undefined): PrInfo | string {
  const r = io.exec('gh', ['pr', 'view', ...(pr === undefined ? [] : [String(pr)]), '--json', 'number,url,headRefOid,baseRefOid'])
  if (r.code !== 0) return failure(r)
  try {
    const info = JSON.parse(r.stdout) as PrInfo
    if (Number.isInteger(info.number) && typeof info.headRefOid === 'string' && typeof info.baseRefOid === 'string') return info
  } catch {}
  return `gh pr view printed no PR: ${r.stdout.trim().slice(0, 200)}`
}

const reviewsPath = (pr: PrInfo) => `repos/{owner}/{repo}/pulls/${pr.number}/reviews`

/** The PR's review bodies as one text, to find the markers of the rounds already posted. */
function postedBodies(io: PosterIo, pr: PrInfo): string | { error: string } {
  const r = io.exec('gh', ['api', '--paginate', reviewsPath(pr), '--jq', '.[].body'])
  return r.code === 0 ? r.stdout : { error: failure(r) }
}

/** Where a round's comments anchor: its reviewed commit when the PR contains it, else the PR's head. */
function anchorOf(io: PosterIo, r: TrailRound, pr: PrInfo): { commit: string; notInPr: boolean; hunks: Hunks } {
  const sha = r.reviewedSha
  const inPr = sha !== undefined && io.exec('git', ['merge-base', '--is-ancestor', sha, pr.headRefOid]).code === 0
  const commit = inPr ? sha! : pr.headRefOid
  const base = io.exec('git', ['merge-base', pr.baseRefOid, commit])
  const diff = base.code === 0 ? io.exec('git', ['-c', 'core.quotePath=false', 'diff', '--unified=3', base.stdout.trim(), commit]) : undefined
  return { commit, notInPr: !inPr, hunks: diff?.code === 0 ? parseHunks(diff.stdout) : new Map() }
}

function relative(file: string, toplevel: string): string {
  const root = `${toplevel.replace(/\/+$/, '')}/`
  return (file.startsWith(root) ? file.slice(root.length) : file).replace(/^(\.\/)+/, '')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function buildReview(io: PosterIo, r: TrailRound, records: TrailRound[], pr: PrInfo, toplevel: string): ReviewPayload | undefined {
  if (!r.findings.length) {
    const earlier = records.some(x => x.loop === r.loop && x.round < r.round && x.findings.length)
    if (r.outcome === 'clean' || r.outcome === undefined) {
      if (!earlier) return undefined
      const at = r.reviewedSha && io.exec('git', ['merge-base', '--is-ancestor', r.reviewedSha, pr.headRefOid]).code === 0 ? r.reviewedSha : pr.headRefOid
      return { commit_id: at, event: 'COMMENT', body: cleanBody(r), comments: [] }
    }
  }
  if (r.loop === 'plan') {
    return { commit_id: pr.headRefOid, event: 'COMMENT', body: roundBody(r, records, { inBody: r.findings }), comments: [] }
  }
  const { commit, notInPr, hunks } = anchorOf(io, r, pr)
  const comments: LineComment[] = []
  const inBody: TrailFinding[] = []
  for (const f of r.findings) {
    const path = relative(f.file, toplevel)
    if (onChangedLine(hunks, path, f.line)) comments.push({ path, line: f.line!, side: 'RIGHT', body: findingComment(f, r, records) })
    else inBody.push(f)
  }
  return { commit_id: commit, event: 'COMMENT', body: roundBody(r, records, { inBody, notInPr }), comments }
}

/** Posts one GitHub review per trail round not yet on the PR; returns the exit code. */
export function postTrail(argv: string[], io: PosterIo): number {
  const options = parseArgs(argv)
  if (typeof options === 'string') {
    io.print(`${options}\n${USAGE}`)
    return 1
  }
  const top = io.exec('git', ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    io.print(`not inside a git checkout: ${failure(top)}`)
    return 1
  }
  const toplevel = top.stdout.trim()
  let dir = options.trail
  if (dir === undefined) {
    try {
      dir = `${toplevel}/${io.workDir(toplevel).replace(/\/+$/, '')}/trail`
    } catch (e) {
      io.print(`${(e as Error).message}\npass the trail directory with --trail <dir>`)
      return 1
    }
  }
  const records = readRecords(io, dir)
  if (records === undefined) {
    io.print(`no trail at ${dir} - a granny run writes it there (config trail: true)`)
    return 1
  }
  const pr = prOf(io, options.pr)
  if (typeof pr === 'string') {
    io.print(`open the PR first (${pr})`)
    return 2
  }
  const posted = postedBodies(io, pr)
  if (typeof posted !== 'string') {
    io.print(`could not list the PR's reviews: ${posted.error}`)
    return 1
  }
  if (!records.length) io.print(`no trail records in ${dir}`)
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
    if (options.dryRun) {
      io.print(`${at}: would post ${what}`)
      io.print(JSON.stringify(review, null, 2))
      continue
    }
    const sent = io.exec('gh', ['api', '--method', 'POST', reviewsPath(pr), '--input', '-'], JSON.stringify(review))
    if (sent.code === 0) io.print(`${at}: posted ${what}`)
    else {
      io.print(`${at}: FAILED to post - ${failure(sent)}`)
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
