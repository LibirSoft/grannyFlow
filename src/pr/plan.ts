import { trimSlashes } from '../core/paths'
import type { TrailFinding, TrailRound } from '../core/types'
import { type DiffFiles, diffLine, parseDiff } from './hunks'
import type { PosterIo } from './io'
import { cleanBody, findingComment, findingMarker, roundBody, roundMarker } from './render'

/** The PR or MR a trail is planned against: its head commit and the commit of its target branch. */
export interface Target {
  head: string
  base: string
}

export interface PlannedComment {
  path: string
  /** The path before a rename; the same as `path` otherwise. */
  oldPath: string
  line: number
  /** Set on a context line only. */
  oldLine?: number
  kind: 'added' | 'context'
  body: string
  marker: string
}

/** One round as any platform posts it: the commit to anchor on, the round's body and its line comments. */
export interface PlannedReview {
  loop: string
  round: number
  marker: string
  commit: string
  /** The merge base of the target and `commit`, set when the round's diff was read. */
  mergeBase?: string
  /** Set when the reviewed commit is not in the PR, so `commit` is the PR's head. */
  notInPr: boolean
  body: string
  comments: PlannedComment[]
}

/** Pin every diff setting a user's git config could change, so the hunks are the ones GitHub shows. */
const DIFF_FLAGS = ['--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/']

/** A round's review commit: its reviewed commit when the PR contains it, else the PR's head. */
function commitFor(io: PosterIo, r: TrailRound, target: Target): { commit: string; notInPr: boolean } {
  const sha = r.reviewedSha
  const inPr = sha !== undefined && io.exec('git', ['merge-base', '--is-ancestor', sha, target.head]).code === 0
  return inPr ? { commit: sha!, notInPr: false } : { commit: target.head, notInPr: true }
}

/** Where a round's comments anchor, and the PR's diff at that commit. */
function anchorOf(io: PosterIo, r: TrailRound, target: Target): { commit: string; notInPr: boolean; mergeBase?: string; files: DiffFiles } {
  const { commit, notInPr } = commitFor(io, r, target)
  const base = io.exec('git', ['merge-base', target.base, commit])
  if (base.code !== 0) return { commit, notInPr, files: new Map() }
  const mergeBase = base.stdout.trim()
  const diff = io.exec('git', ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, mergeBase, commit])
  return { commit, notInPr, mergeBase, files: diff.code === 0 ? parseDiff(diff.stdout) : new Map() }
}

function relative(file: string, toplevel: string): string {
  const root = `${trimSlashes(toplevel)}/`
  return (file.startsWith(root) ? file.slice(root.length) : file).replace(/^(\.\/)+/, '')
}

/** The review a round posts, or undefined when it has nothing to say. `refused` (the platform's error on the first try) puts every finding in the body. */
export function planRound(io: PosterIo, r: TrailRound, records: TrailRound[], target: Target, toplevel: string, refused?: string): PlannedReview | undefined {
  const head = { loop: r.loop, round: r.round, marker: roundMarker(r) }
  if (!r.findings.length) {
    const earlier = records.some(x => x.loop === r.loop && x.round < r.round && x.findings.length)
    if (r.outcome === 'clean' || r.outcome === undefined) {
      if (!earlier) return undefined
      return { ...head, ...commitFor(io, r, target), body: cleanBody(r), comments: [] }
    }
  }
  if (r.loop === 'plan') {
    return { ...head, commit: target.head, notInPr: false, body: roundBody(r, records, { inBody: r.findings }), comments: [] }
  }
  const { commit, notInPr, mergeBase, files } = anchorOf(io, r, target)
  const comments: PlannedComment[] = []
  const inBody: TrailFinding[] = []
  for (const f of r.findings) {
    const path = relative(f.file, toplevel)
    const at = refused === undefined ? diffLine(files, path, f.line) : undefined
    if (at) comments.push({ path, oldPath: at.oldPath, line: f.line!, ...(at.kind === 'context' ? { oldLine: at.oldLine } : {}), kind: at.kind, body: findingComment(f, r, records), marker: findingMarker(r, f) })
    else inBody.push(f)
  }
  const body = roundBody(r, records, { inBody, notInPr, ...(refused === undefined ? {} : { refused }) })
  return { ...head, commit, ...(mergeBase === undefined ? {} : { mergeBase }), notInPr, body, comments }
}
