import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrailFinding, TrailRound } from '../src/core/types'
import { diffLine, onChangedLine, parseDiff, parseHunks } from '../src/pr/hunks'
import { prTarget, type PrInfo, type ReviewPayload } from '../src/pr/github'
import { planRound, type Target } from '../src/pr/plan'
import { detectPlatform, hostOf } from '../src/pr/platform'
import { postTrail, type ExecResult, type PosterIo } from '../src/pr/post'
import { byTrailOrder, trailProblem } from '../src/pr/records'
import { agentText, cleanBody, findingComment, findingMarker, outcomeLine, roundBody, roundMarker } from '../src/pr/render'

const TOP = '/w/repo'
const DIR = `${TOP}/.granny/trail`
const SHA1 = '1111111aaaaaaaa'
const SHA2 = '2222222bbbbbbbb'
const SHA3 = '3333333cccccccc'
const HEAD = '9999999fffffff'
const BASE = '0000000eeeeeeee'
const PR: PrInfo = { number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: HEAD, baseRefOid: BASE }

const finding = (id: string, over: Partial<TrailFinding> = {}): TrailFinding => ({
  id,
  reviewer: 'codex',
  severity: 'P2',
  file: 'src/a.ts',
  line: 12,
  title: `${id} title`,
  detail: `${id} detail`,
  verdict: 'confirmed',
  impact: 'major',
  likelihood: 'common',
  fixCost: 'trivial',
  scope: 'in-scope',
  evidence: 'src/a.ts:12 - x is null',
  priority: 82,
  reason: `reason ${id}`,
  decision: { rule: 6, action: 'fix', why: 'impact major is in alwaysFix (major/common/trivial -> 82)' },
  route: 'sent',
  ...over,
})

const round = (over: Partial<TrailRound> = {}): TrailRound => ({
  version: 1,
  loop: 's1',
  name: 'engine',
  round: 1,
  base: BASE,
  reviewedSha: SHA1,
  reviewers: [{ name: 'codex', engine: 'auto' }],
  findings: [],
  ...over,
})

const fix = (startSha: string, headSha: string, commits: string[], over: Partial<NonNullable<TrailRound['fix']>> = {}) => ({ label: 'fix engine r1', startSha, headSha, commits, ...over })

const A_DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -8,6 +8,9 @@ x', ' a', '+b', ' c', ''].join('\n')

const MR = { iid: 5, web_url: 'https://gitlab.com/o/r/-/merge_requests/5', sha: HEAD, diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE } }
const MR_PATH = 'projects/:id/merge_requests/5'
const GLAB_POST = ['--method', 'POST', '--header', 'Content-Type: application/json', '--input', '-']

interface Draft {
  id: number
  note: string
  position?: Record<string, unknown>
}

/** What the fake GitLab holds for MR !5, and which of its calls fail. */
interface GitlabOpts {
  /** The open MRs the current branch is the source of. */
  mrs?: Array<{ iid: number; web_url: string }>
  /** `GET merge_requests/5`; null answers 404. */
  mr?: Record<string, unknown> | null
  notes?: string[]
  drafts?: Draft[]
  failDraft?: (d: Draft) => boolean
  /** Creates the draft but answers without its id. */
  noId?: (d: Draft) => boolean
  failPublish?: (note: string, drafts: Draft[]) => boolean
  failNote?: boolean
  failDelete?: (id: number) => boolean
}

interface GitlabState {
  drafts: Draft[]
  /** Each bulk publish: its note and the drafts it published. */
  published: Array<{ note: string; drafts: Draft[] }>
  /** Plain MR notes. */
  notes: string[]
  deleted: number[]
  next: number
}

interface Fake {
  io: PosterIo
  out: string[]
  calls: Array<{ cmd: string; args: string[]; input?: string }>
  posted: ReviewPayload[]
  written: Record<string, string>
  gl: GitlabState
}

const GLAB_400 = { code: 1, stdout: '', stderr: 'glab: 400 Bad Request (HTTP 400)' }

function fakeGitlab(opts: GitlabOpts, gl: GitlabState, args: string[], input: string | undefined): ExecResult {
  const ok = (value: unknown): ExecResult => ({ code: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: '' })
  const ndjson = (values: unknown[]): ExecResult => ({ code: 0, stdout: values.map(v => `${JSON.stringify(v)}\n`).join(''), stderr: '' })
  const path = args[1]!
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
  const body = input === undefined ? undefined : (JSON.parse(input) as Record<string, unknown>)
  if (method === 'GET' && path === 'projects/:id/merge_requests') return ndjson(opts.mrs ?? [{ iid: 5, web_url: MR.web_url }])
  if (method === 'GET' && path === MR_PATH) return opts.mr === null ? { code: 1, stdout: '', stderr: 'glab: 404 Not Found (HTTP 404)' } : ok(opts.mr ?? MR)
  if (method === 'GET' && path === `${MR_PATH}/notes`) return ndjson((opts.notes ?? []).map((b, i) => ({ id: 100 + i, body: b })))
  if (method === 'GET' && path === `${MR_PATH}/draft_notes`) return ndjson(gl.drafts)
  if (method === 'POST' && path === `${MR_PATH}/draft_notes`) {
    const draft = { id: gl.next++, note: String(body!.note), position: body!.position as Record<string, unknown> }
    if (opts.failDraft?.(draft)) return GLAB_400
    gl.drafts.push(draft)
    return opts.noId?.(draft) ? ok({ note: draft.note }) : ok(draft)
  }
  if (method === 'POST' && path === `${MR_PATH}/draft_notes/bulk_publish`) {
    if (opts.failPublish?.(String(body!.note), gl.drafts)) return GLAB_400
    gl.published.push({ note: String(body!.note), drafts: gl.drafts.splice(0) })
    return { code: 0, stdout: '', stderr: '' }
  }
  if (method === 'POST' && path === `${MR_PATH}/notes`) {
    if (opts.failNote) return { code: 1, stdout: '', stderr: 'glab: 500 Internal Server Error (HTTP 500)' }
    gl.notes.push(String(body!.body))
    return ok({ id: 300, body: body!.body })
  }
  const del = new RegExp(`^${MR_PATH}/draft_notes/(\\d+)$`).exec(path)
  if (method === 'DELETE' && del) {
    const id = Number(del[1])
    if (opts.failDelete?.(id)) return { code: 1, stdout: '', stderr: 'glab: 503 Service Unavailable (HTTP 503)' }
    gl.drafts = gl.drafts.filter(d => d.id !== id)
    gl.deleted.push(id)
    return { code: 0, stdout: '', stderr: '' }
  }
  throw new Error(`unexpected glab ${args.join(' ')}`)
}

function fake(opts: {
  records?: Record<string, unknown>
  pr?: PrInfo | null
  reviews?: string
  ancestors?: string[]
  diffs?: Record<string, string>
  failPost?: (p: ReviewPayload) => boolean
  workDir?: () => string
  remotes?: Record<string, string>
  tracks?: string
  glab?: ExecResult
  refs?: Record<string, string>
  branch?: string
  gitlab?: GitlabOpts
}): Fake {
  const out: string[] = []
  const calls: Fake['calls'] = []
  const posted: ReviewPayload[] = []
  const written: Record<string, string> = {}
  const gl: GitlabState = { drafts: [...(opts.gitlab?.drafts ?? [])], published: [], notes: [], deleted: [], next: 200 }
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
  const records = opts.records === undefined ? undefined : Object.fromEntries(Object.entries(opts.records).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  const ancestors = new Set(opts.ancestors ?? [SHA1, SHA2, SHA3])
  const io: PosterIo = {
    exec(cmd, args, input) {
      calls.push({ cmd, args, ...(input === undefined ? {} : { input }) })
      const line = args.join(' ')
      if (cmd === 'git' && line === 'rev-parse --show-toplevel') return ok(`${TOP}\n`)
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        const sha = (opts.refs ?? { 'HEAD^{commit}': HEAD, [`${HEAD}^{commit}`]: HEAD, [`${BASE}^{commit}`]: BASE })[args[3]!]
        return sha === undefined ? { code: 1, stdout: '', stderr: '' } : ok(`${sha}\n`)
      }
      if (cmd === 'git' && line === 'branch --show-current') return ok(`${opts.branch ?? 'feat/x'}\n`)
      if (cmd === 'git' && line === 'config --get branch.feat/x.remote') return opts.tracks === undefined ? { code: 1, stdout: '', stderr: '' } : ok(`${opts.tracks}\n`)
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        const url = (opts.remotes ?? { origin: 'git@github.com:o/r.git' })[args[2]!]
        return url === undefined ? { code: 2, stdout: '', stderr: `error: No such remote '${args[2]}'` } : ok(`${url}\n`)
      }
      if (cmd === 'glab' && line === 'auth status --all') return opts.glab ?? { code: 127, stdout: '', stderr: 'glab: spawn glab ENOENT' }
      if (cmd === 'glab' && args[0] === 'api') return fakeGitlab(opts.gitlab ?? {}, gl, args, input)
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') return { code: ancestors.has(args[2]!) && args[3] === HEAD ? 0 : 1, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'merge-base') return ok(`mb-${args[2]}\n`)
      if (cmd === 'git' && args.includes('diff')) return ok(opts.diffs?.[args.at(-1)!] ?? '')
      if (cmd === 'gh' && args[0] === 'pr') return opts.pr === null ? { code: 1, stdout: '', stderr: 'no pull requests found for branch "feat/x"' } : ok(JSON.stringify(opts.pr ?? PR))
      if (cmd === 'gh' && line.startsWith('api --paginate')) return ok(opts.reviews ?? '')
      if (cmd === 'gh' && line.startsWith('api --method POST')) {
        const payload = JSON.parse(input!) as ReviewPayload
        if (opts.failPost?.(payload)) return { code: 1, stdout: '', stderr: 'HTTP 422: Unprocessable Entity' }
        posted.push(payload)
        return ok('{}')
      }
      throw new Error(`unexpected ${cmd} ${line}`)
    },
    list: dir => (dir === DIR && records ? Object.keys(records) : undefined),
    read: path => records![path.slice(DIR.length + 1)]!,
    workDir: opts.workDir ?? (() => '.granny'),
    write: (path, text) => {
      written[path] = text
    },
    print: line => out.push(line),
  }
  return { io, out, calls, posted, written, gl }
}

describe('parseHunks', () => {
  it('reads the new-side range of an added file and of every hunk of a modified one', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
      'diff --git a/src/mod.ts b/src/mod.ts',
      '--- a/src/mod.ts',
      '+++ b/src/mod.ts',
      '@@ -10,7 +10,8 @@ function f() {',
      ' ctx',
      '-old',
      '+new',
      '+more',
      '@@ -40 +41 @@',
      '-x',
      '+y',
    ].join('\n')
    expect(parseHunks(diff)).toEqual(
      new Map([
        ['src/new.ts', [[1, 3]]],
        ['src/mod.ts', [[10, 17], [41, 41]]],
      ]),
    )
  })

  it('gives a deleted-only hunk and a deleted file no lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,2 +4,0 @@',
      '-gone',
      '-gone too',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n')
    expect(parseHunks(diff)).toEqual(new Map())
  })

  it('keys a renamed file by its new path, and a rename without changes has no lines', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -3,3 +3,4 @@',
      ' a',
      '+b',
      'diff --git a/src/x.ts b/src/y.ts',
      'similarity index 100%',
      'rename from src/x.ts',
      'rename to src/y.ts',
    ].join('\n')
    const hunks = parseHunks(diff)
    expect(hunks).toEqual(new Map([['src/new.ts', [[3, 6]]]]))
    expect(onChangedLine(hunks, 'src/old.ts', 4)).toBe(false)
  })

  it('counts context lines as part of the hunk', () => {
    const hunks = parseHunks(A_DIFF)
    expect(onChangedLine(hunks, 'src/a.ts', 8)).toBe(true)
    expect(onChangedLine(hunks, 'src/a.ts', 16)).toBe(true)
    expect(onChangedLine(hunks, 'src/a.ts', 17)).toBe(false)
    expect(onChangedLine(hunks, 'src/a.ts', 7)).toBe(false)
    expect(onChangedLine(hunks, 'src/a.ts', undefined)).toBe(false)
  })

  it('reads past "\\ No newline at end of file" and an added line that looks like a file header', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+++ b/src/evil.ts',
      '\\ No newline at end of file',
      '@@ -9,1 +9,2 @@',
      ' z',
      '+w',
      'diff --git "a/src/sp ace.ts" "b/src/sp ace.ts"',
      '--- "a/src/sp ace.ts"',
      '+++ "b/src/sp ace.ts"',
      '@@ -1 +1 @@',
      '-q',
      '+r',
    ].join('\n')
    expect(parseHunks(diff)).toEqual(
      new Map([
        ['src/a.ts', [[1, 2], [9, 10]]],
        ['src/sp ace.ts', [[1, 1]]],
      ]),
    )
  })
})

describe('diffLine', () => {
  it('tells an added line from a context line and maps a context line after an earlier hunk to its old number', () => {
    const diff = [
      'diff --git a/src/mod.ts b/src/mod.ts',
      '--- a/src/mod.ts',
      '+++ b/src/mod.ts',
      '@@ -3,3 +3,4 @@',
      ' keep',
      '-gone',
      '+new',
      '+more',
      ' tail',
      '\\ No newline at end of file',
      '@@ -20,5 +21,3 @@ f()',
      ' ctx',
      '-x',
      '-y',
      '-z',
      '+w',
      ' end',
    ].join('\n')
    const files = parseDiff(diff)
    expect(diffLine(files, 'src/mod.ts', 3)).toEqual({ oldPath: 'src/mod.ts', kind: 'context', oldLine: 3 })
    expect(diffLine(files, 'src/mod.ts', 4)).toEqual({ oldPath: 'src/mod.ts', kind: 'added' })
    expect(diffLine(files, 'src/mod.ts', 5)).toEqual({ oldPath: 'src/mod.ts', kind: 'added' })
    expect(diffLine(files, 'src/mod.ts', 6)).toEqual({ oldPath: 'src/mod.ts', kind: 'context', oldLine: 5 })
    expect(diffLine(files, 'src/mod.ts', 21)).toEqual({ oldPath: 'src/mod.ts', kind: 'context', oldLine: 20 })
    expect(diffLine(files, 'src/mod.ts', 22)).toEqual({ oldPath: 'src/mod.ts', kind: 'added' })
    expect(diffLine(files, 'src/mod.ts', 23)).toEqual({ oldPath: 'src/mod.ts', kind: 'context', oldLine: 24 })
    expect(diffLine(files, 'src/mod.ts', 7)).toBeUndefined()
    expect(diffLine(files, 'src/mod.ts', 24)).toBeUndefined()
    expect(diffLine(files, 'src/mod.ts', undefined)).toBeUndefined()
  })

  it("names a renamed file's old path, and a new file's own path", () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -3,2 +3,3 @@',
      ' a',
      '+b',
      ' c',
      'diff --git a/src/fresh.ts b/src/fresh.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/fresh.ts',
      '@@ -0,0 +1 @@',
      '+one',
    ].join('\n')
    const files = parseDiff(diff)
    expect(diffLine(files, 'src/new.ts', 5)).toEqual({ oldPath: 'src/old.ts', kind: 'context', oldLine: 4 })
    expect(diffLine(files, 'src/new.ts', 4)).toEqual({ oldPath: 'src/old.ts', kind: 'added' })
    expect(diffLine(files, 'src/old.ts', 4)).toBeUndefined()
    expect(diffLine(files, 'src/fresh.ts', 1)).toEqual({ oldPath: 'src/fresh.ts', kind: 'added' })
  })

  it('reads an added line that looks like a file header as an added line', () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' a', '+++ b/src/evil.ts'].join('\n')
    const files = parseDiff(diff)
    expect(diffLine(files, 'src/a.ts', 2)).toEqual({ oldPath: 'src/a.ts', kind: 'added' })
    expect(files.has('src/evil.ts')).toBe(false)
  })
})

describe('trail records', () => {
  it('accepts a record the engine writes and names what is wrong with one it did not', () => {
    expect(trailProblem(round({ findings: [finding('codex-F1')], fix: fix(SHA1, SHA2, ['c']) }))).toBeUndefined()
    expect(trailProblem([])).toBe('not a JSON object')
    expect(trailProblem({ ...round(), version: 2 })).toBe('version 2 is not 1')
    expect(trailProblem({ ...round(), loop: 's1 -->' })).toBe('loop is missing or not a plain id')
    expect(trailProblem({ ...round(), round: 0 })).toBe('round is not a positive integer')
    expect(trailProblem({ ...round(), reviewedSha: 'HEAD' })).toBe('reviewedSha is not a commit id')
    expect(trailProblem(round({ findings: [finding('x -->')] }))).toBe('findings[0].id is missing or not a plain id')
    expect(trailProblem(round({ findings: [finding('a', { line: 1.5 })] }))).toBe('findings[0].line is not a positive integer')
    expect(trailProblem(round({ findings: [finding('a', { route: 'lost' as never })] }))).toBe('findings[0].route is not sent or residual')
    expect(trailProblem({ ...round(), fix: {} })).toBe('fix has no label')
    expect(trailProblem({ ...round(), outcome: 'done' })).toBe('outcome "done" is unknown')
  })

  it('orders plan review, the stages by number, the final reviews, and rounds ascending', () => {
    const ids = ['final-other-r1', 's10-r1', 'final-r1', 's2-r1', 's1-r2', 'plan-r1', 's1-r1', 'plan-r2']
    const records = ids.map(id => {
      const [, loop, n] = /^(.*)-r(\d+)$/.exec(id)!
      return round({ loop: loop!, round: Number(n) })
    })
    expect(records.sort(byTrailOrder).map(r => `${r.loop}-r${r.round}`)).toEqual(['plan-r1', 'plan-r2', 's1-r1', 's1-r2', 's2-r1', 's10-r1', 'final-r1', 'final-other-r1'])
  })
})

describe('rendering', () => {
  it('renders a line comment with the reviewer, the judge block, the outcome and the marker', () => {
    const f = finding('codex-F2', { severity: 'P1' })
    const r = round({ findings: [f], fix: fix('a1b2c3d4e5', 'd4e5f6a7b8', ['fix: one', 'fix: two']) })
    expect(findingComment(f, r, [r])).toBe(
      [
        '**granny · Stage 1 (engine) · round 1 · `codex-F2`** (reviewer `codex`, P1)',
        '**codex-F2 title**',
        '',
        'codex-F2 detail',
        '',
        '---',
        '**Judge:** `confirmed` `major` `common` `trivial` `in-scope` · priority 82 · rule 6 → fix: impact major is in alwaysFix (major/common/trivial -> 82)',
        '**Evidence:** src/a.ts:12 - x is null',
        "**Judge's reason:** reason codex-F2",
        '**What happened:** fixed in fix r1: a1b2c3d..d4e5f6a (2 commits)',
        '<!-- granny-trail s1/r1@1111111a/codex-F2 -->',
      ].join('\n'),
    )
  })

  it('says a sent finding came back in a later round of its loop and in the final review', () => {
    const f = finding('codex-F1', { duplicates: ['opus-F3'] })
    const r1 = round({ findings: [f], fix: fix(SHA1, SHA2, ['c']) })
    const r2 = round({ round: 2, reviewedSha: SHA2, findings: [finding('codex-F4', { repeatOf: 'r1/opus-F3' })] })
    const other = round({ loop: 's2', name: 'ui', round: 2, findings: [finding('codex-F9', { repeatOf: 'r1/codex-F1' })] })
    const final = round({ loop: 'final', name: 'final review', findings: [finding('codex-F7', { repeatOf: 's1/r1/codex-F1' })] })
    expect(outcomeLine(f, r1, [r1, r2, other, final])).toBe(
      'fixed in fix r1: 1111111..2222222 (1 commit); came back in round 2 as codex-F4, final review round 1 as codex-F7; also reported as `opus-F3`',
    )
  })

  it('renders a declined, an overruled, a residual and a blocker finding', () => {
    const declined = finding('codex-F1')
    const overruled = finding('codex-F2', { overruled: 'cannot happen' })
    const residual = finding('codex-F3', { route: 'residual', scope: 'pre-existing', decision: { rule: 5, action: 'residual', why: 'pre-existing - ATTENTION: impact major', attention: true } })
    const blocker: TrailFinding = { id: 'codex-F4', reviewer: 'codex', severity: 'P0', file: 'src/b.ts', title: 't', detail: '', decision: { rule: 1, action: 'fix', why: 'P0/P1' }, route: 'sent', blocker: true }
    const r = round({ findings: [declined, overruled, residual, blocker], fix: fix(SHA1, SHA2, ['c'], { declined: [{ id: 'codex-F1', reason: 'parse() checks it' }] }) })
    expect(outcomeLine(declined, r, [r])).toBe('the fixer declined it: parse() checks it')
    expect(outcomeLine(overruled, r, [r])).toBe("the judge overruled the fixer's earlier decline (cannot happen); fixed in fix r1: 1111111..2222222 (1 commit)")
    expect(outcomeLine(residual, r, [r])).toBe('kept as residual (rule 5: pre-existing - ATTENTION: impact major); ATTENTION: pre-existing, impact major')
    expect(outcomeLine(blocker, r, [r])).toBe('P0/P1: sent straight to the implementer, the judge did not route it; fixed in fix r1: 1111111..2222222 (1 commit)')
    const comment = findingComment(blocker, r, [r])
    expect(comment).toContain('**Judge:** `not judged` · rule 1 → fix: P0/P1\n')
    expect(comment).not.toContain('**Evidence:**')
    expect(comment).not.toContain("**Judge's reason:**")
  })

  it('names the outcome of a round that ended the loop with nothing sent, and of a round that was never routed', () => {
    const kept = finding('codex-F1', { route: 'residual', decision: { rule: 8, action: 'residual', why: 'priority 40 <= threshold 70' } })
    const r = round({ findings: [kept], outcome: 'residual-only' })
    expect(outcomeLine(kept, r, [r])).toBe('kept as residual (rule 8: priority 40 <= threshold 70); the loop ended `residual-only`')
    const raw: TrailFinding = { id: 'codex-F1', reviewer: 'codex', severity: 'P2', file: 'src/a.ts', title: 't', detail: 'd' }
    const failed = round({ findings: [raw], outcome: 'review-failed', note: 'opus did not run' })
    expect(outcomeLine(raw, failed, [failed])).toBe('not routed: the round ended the loop with `review-failed`')
    expect(findingComment(raw, failed, [failed])).toContain('**Judge:** `not judged`\n')
  })

  it('says a plan fix fixed the plan, and a fix without commits was only sent', () => {
    const f = finding('codex-F1')
    const plan = round({ loop: 'plan', name: 'plan review', findings: [f], fix: { label: 'fix plan review r1' } })
    expect(outcomeLine(f, plan, [plan])).toBe('fixed in the plan by fix r1')
    const none = round({ findings: [f] })
    expect(outcomeLine(f, none, [none])).toBe('sent to the implementer')
  })

  it("keeps an agent's text from adding headings, closing the comment, faking a marker or mentioning anyone", () => {
    expect(agentText('# Title\nsee @octocat and a@b.com, `@types/node`\n<!-- granny-trail s1/r1@x -->\n```\nopen')).toBe(
      '\\# Title\nsee @​octocat and a@b.com, `@types/node`\n&lt;!-- granny-trail s1/r1@x -->\n```\nopen\n```',
    )
  })

  it('heads the round review with the reviewers, the reviewed sha, the counts and the fix range', () => {
    const sent = finding('codex-F1', { line: 99 })
    const kept = finding('codex-F2', { route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } })
    const r = round({
      reviewers: [{ name: 'codex', engine: 'auto' }, { name: 'opus', engine: 'agent', model: 'opus' }],
      findings: [sent, kept],
      fix: fix(SHA1, SHA2, ['a', 'b'], { declined: [{ id: 'codex-F1', reason: 'no' }], deviations: 'kept the API' }),
    })
    const text = roundBody(r, [r], { inBody: [sent], notInPr: true })
    expect(text.split('\n\n')[0]).toBe(
      '**granny · Stage 1 (engine) · round 1** · reviewers: `codex` (auto), `opus` (agent, opus) · reviewed at `1111111` · 1 sent, 1 residual, 1 declined · fix r1: 1111111..2222222 (2 commits)',
    )
    expect(text).toContain("**The fixer's deviations:** kept the API")
    expect(text).toContain("Reviewed at `1111111`, which is not in this PR's history: the line comments sit on the PR's head.")
    expect(text).toContain('### Not on a changed line\n\n#### `src/a.ts:99`\n\n**granny · Stage 1 (engine) · round 1 · `codex-F1`**')
    expect(text.endsWith('\n<!-- granny-trail s1/r1@1111111a -->')).toBe(true)
  })
})

describe('planRound', () => {
  const TARGET: Target = { head: HEAD, base: BASE }
  const RENAME_DIFF = ['diff --git a/src/old.ts b/src/new.ts', 'similarity index 90%', 'rename from src/old.ts', 'rename to src/new.ts', '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -3,2 +3,3 @@', ' a', '+b', ' c'].join('\n')

  it('plans an added and a context line as line comments on the reviewed commit and the rest in the body', () => {
    const added = finding('codex-F1', { line: 9 })
    const context = finding('codex-F2', { file: `${TOP}/src/a.ts`, line: 12 })
    const outside = finding('codex-F3', { line: 40, route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } })
    const r = round({ findings: [added, context, outside], fix: fix(SHA1, SHA2, ['c']) })
    const plan = planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, [r], TARGET, TOP)!
    expect(plan).toMatchObject({ loop: 's1', round: 1, marker: roundMarker(r), commit: SHA1, mergeBase: `mb-${SHA1}`, notInPr: false })
    expect(plan.comments).toEqual([
      { path: 'src/a.ts', oldPath: 'src/a.ts', line: 9, kind: 'added', body: findingComment(added, r, [r]), marker: findingMarker(r, added) },
      { path: 'src/a.ts', oldPath: 'src/a.ts', line: 12, oldLine: 11, kind: 'context', body: findingComment(context, r, [r]), marker: findingMarker(r, context) },
    ])
    expect(plan.body).toBe(roundBody(r, [r], { inBody: [outside], notInPr: false }))
  })

  it("plans a comment on a renamed file with the file's old path", () => {
    const r = round({ findings: [finding('codex-F1', { file: 'src/new.ts', line: 5 })] })
    const plan = planRound(fake({ diffs: { [SHA1]: RENAME_DIFF } }).io, r, [r], TARGET, TOP)!
    expect(plan.comments.map(c => [c.path, c.oldPath, c.line, c.oldLine, c.kind])).toEqual([['src/new.ts', 'src/old.ts', 5, 4, 'context']])
  })

  it("plans on the PR head and says so when the reviewed commit is not in the PR's history, or the record names none", () => {
    const r = round({ findings: [finding('codex-F1')] })
    const plan = planRound(fake({ ancestors: [], diffs: { [HEAD]: A_DIFF } }).io, r, [r], TARGET, TOP)!
    expect(plan).toMatchObject({ commit: HEAD, mergeBase: `mb-${HEAD}`, notInPr: true })
    expect(plan.comments.map(c => c.line)).toEqual([12])
    expect(plan.body).toContain("Reviewed at `1111111`, which is not in this PR's history")
    const unnamed = round({ findings: [finding('codex-F1')] })
    delete unnamed.reviewedSha
    expect(planRound(fake({ diffs: { [HEAD]: A_DIFF } }).io, unnamed, [unnamed], TARGET, TOP)).toMatchObject({ commit: HEAD, notInPr: true, marker: '<!-- granny-trail s1/r1@unknown -->' })
  })

  it('plans a plan-review round on the PR head with every finding in the body, without reading a diff', () => {
    const f = fake({})
    const r = round({ loop: 'plan', name: 'plan review', findings: [finding('codex-F1', { file: '/plans/p.md', line: 4 })] })
    const plan = planRound(f.io, r, [r], TARGET, TOP)!
    expect(plan).toEqual({ loop: 'plan', round: 1, marker: roundMarker(r), commit: HEAD, notInPr: false, body: roundBody(r, [r], { inBody: r.findings }), comments: [] })
    expect(f.calls).toEqual([])
  })

  it('plans a clean round only when it ends a loop that had findings, and a failed round that found nothing', () => {
    const lone = round({ outcome: 'clean' })
    expect(planRound(fake({}).io, lone, [lone], TARGET, TOP)).toBeUndefined()
    const r1 = round({ findings: [finding('codex-F1')] })
    const r2 = round({ round: 2, reviewedSha: SHA2, outcome: 'clean' })
    expect(planRound(fake({}).io, r2, [r1, r2], TARGET, TOP)).toEqual({ loop: 's1', round: 2, marker: roundMarker(r2), commit: SHA2, notInPr: false, body: cleanBody(r2), comments: [] })
    const failed = round({ outcome: 'review-failed', note: 'codex: timed out' })
    expect(planRound(fake({}).io, failed, [failed], TARGET, TOP)!.body).toContain('The loop ended here: `review-failed` - codex: timed out')
  })

  it("plans every finding in the body with the platform's error when it refused the line comments", () => {
    const r = round({ findings: [finding('codex-F1')] })
    const plan = planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, [r], TARGET, TOP, 'HTTP 422')!
    expect(plan.comments).toEqual([])
    expect(plan.body).toContain("refused this round's line comments (HTTP 422), so every finding is below.")
    expect(plan.body).toContain('`src/a.ts:12`')
  })

  it('names an MR and GitLab in the body of a round planned against a GitLab MR', () => {
    const r = round({ findings: [finding('codex-F1')] })
    const gitlab: Target = { ...TARGET, platform: 'gitlab' }
    const moved = planRound(fake({ ancestors: [], diffs: { [HEAD]: A_DIFF } }).io, r, [r], gitlab, TOP)!
    expect(moved.body).toContain("Reviewed at `1111111`, which is not in this MR's history: the line comments sit on the MR's head.")
    const refused = planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, [r], gitlab, TOP, '400 Bad Request')!
    expect(refused.body).toContain("GitLab refused this round's line comments (400 Bad Request), so every finding is below.")
    expect(planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, [r], TARGET, TOP, 'HTTP 422')!.body).toContain("GitHub refused this round's line comments")
  })
})

describe('platform', () => {
  it('reads the host of an https, an ssh and an scp-like remote URL, and none of a local path', () => {
    expect(hostOf('https://github.com/o/r.git')).toBe('github.com')
    expect(hostOf('https://user:token@GitLab.Example.com:8443/team/r.git')).toBe('gitlab.example.com')
    expect(hostOf('ssh://git@code.acme.io:2222/team/r.git')).toBe('code.acme.io')
    expect(hostOf('git@github.com:o/r.git')).toBe('github.com')
    expect(hostOf('code.acme.io:team/r.git')).toBe('code.acme.io')
    expect(hostOf('/srv/git/r.git')).toBeUndefined()
    expect(hostOf('file:///srv/git/r.git')).toBeUndefined()
    expect(hostOf('../r')).toBeUndefined()
  })

  it('takes github.com as GitHub and a host with gitlab in its name as GitLab, without asking glab', () => {
    const github = fake({ remotes: { origin: 'https://github.com/o/r.git' } })
    expect(detectPlatform(github.io)).toBe('github')
    const gitlab = fake({ remotes: { origin: 'git@gitlab.com:o/r.git' } })
    expect(detectPlatform(gitlab.io)).toBe('gitlab')
    expect([...github.calls, ...gitlab.calls].some(c => c.cmd === 'glab')).toBe(false)
  })

  it('takes a self-hosted host that glab lists as GitLab', () => {
    const glab = { code: 0, stdout: '', stderr: 'gitlab.com\n  ✓ Logged in to gitlab.com as me\ncode.acme.io\n  ✓ Logged in to code.acme.io as me\n' }
    const f = fake({ remotes: { origin: 'https://code.acme.io/team/r.git' }, glab })
    expect(detectPlatform(f.io)).toBe('gitlab')
    expect(f.calls.find(c => c.cmd === 'glab')!.args).toEqual(['auth', 'status', '--all'])
  })

  it('names an unknown host, and a remote with no host, instead of guessing', () => {
    const glab = { code: 0, stdout: '', stderr: 'gitlab.com\n  ✓ Logged in to gitlab.com as me\n' }
    expect(detectPlatform(fake({ remotes: { origin: 'https://bitbucket.org/o/r.git' }, glab }).io)).toEqual({ error: 'cannot tell the platform of bitbucket.org: pass --platform github|gitlab, or --out <file>' })
    expect(detectPlatform(fake({ remotes: { origin: 'https://acme.io/o/r.git' } }).io)).toEqual({ error: 'cannot tell the platform of acme.io: pass --platform github|gitlab, or --out <file>' })
    expect(detectPlatform(fake({ remotes: { origin: '/srv/git/r.git' } }).io)).toEqual({ error: 'cannot tell the platform of the remote origin (/srv/git/r.git): pass --platform github|gitlab, or --out <file>' })
    expect(detectPlatform(fake({ remotes: {} }).io)).toEqual({ error: "cannot tell the platform: the remote origin has no URL (error: No such remote 'origin'): pass --platform github|gitlab, or --out <file>" })
  })

  it('reads the remote the current branch tracks, else origin', () => {
    const f = fake({ remotes: { origin: 'https://github.com/o/r.git', upstream: 'https://gitlab.com/o/r.git' }, tracks: 'upstream' })
    expect(detectPlatform(f.io)).toBe('gitlab')
    expect(f.calls.filter(c => c.cmd === 'git').map(c => c.args.join(' '))).toEqual(['branch --show-current', 'config --get branch.feat/x.remote', 'remote get-url upstream'])
  })

  it('stops on a host it cannot place before reading the PR', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, remotes: { origin: 'https://bitbucket.org/o/r.git' } })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.out).toEqual(['cannot tell the platform of bitbucket.org: pass --platform github|gitlab, or --out <file>'])
    expect(f.calls.some(c => c.cmd === 'gh')).toBe(false)
  })

  it('takes --platform over the remote', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, remotes: { origin: 'https://bitbucket.org/o/r.git' } })
    expect(postTrail(['--platform', 'github'], f.io)).toBe(0)
    expect(f.posted).toHaveLength(1)
    expect(f.calls.some(c => c.args[0] === 'remote')).toBe(false)
  })

  it('refuses a platform it does not know', () => {
    const f = fake({ records: {} })
    expect(postTrail(['--platform', 'gerrit'], f.io)).toBe(1)
    expect(f.out[0]).toStartWith('--platform takes github or gitlab, got gerrit\n')
    expect(f.calls).toEqual([])
  })
})

describe('postTrail', () => {
  it('posts one COMMENT review per round, anchoring findings on changed lines of the reviewed commit and the rest in the body', () => {
    const inHunk = finding('codex-F1')
    const outside = finding('codex-F2', { line: 40, route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } })
    const elsewhere = finding('codex-F3', { file: `${TOP}/src/c.ts`, line: 2, route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } })
    const r = round({ findings: [inHunk, outside, elsewhere], fix: fix(SHA1, SHA2, ['c']) })
    const f = fake({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted).toHaveLength(1)
    const [review] = f.posted
    expect(review!.commit_id).toBe(SHA1)
    expect(review!.event).toBe('COMMENT')
    expect(review!.comments).toEqual([{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: findingComment(inHunk, r, [r]) }])
    expect(review!.body).toContain('#### `src/a.ts:40`')
    expect(review!.body).toContain(`#### \`${TOP}/src/c.ts:2\``)
    expect(review!.body).not.toContain("not in this PR's history")
    expect(f.calls.find(c => c.args.includes('diff'))!.args).toEqual(['-c', 'core.quotePath=false', 'diff', '--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', `mb-${SHA1}`, SHA1])
    expect(f.calls.find(c => c.args[0] === 'merge-base' && c.args[1] !== '--is-ancestor')!.args).toEqual(['merge-base', BASE, SHA1])
    expect(f.out).toEqual(['s1 r1: posted 1 line comment, 2 in body', PR.url])
    const post = f.calls.find(c => c.args[1] === '--method')!
    expect(post).toMatchObject({ cmd: 'gh', args: ['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', '-'] })
  })

  it('anchors on a changed line of a file the finding names by its absolute path', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1', { file: `${TOP}/src/a.ts` })] }) }, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted[0]!.comments.map(c => [c.path, c.line])).toEqual([['src/a.ts', 12]])
  })

  it("falls back to the PR head when the reviewed commit is not in the PR's history, and says so", () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, ancestors: [], diffs: { [HEAD]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    const [review] = f.posted
    expect(review!.commit_id).toBe(HEAD)
    expect(review!.comments.map(c => c.line)).toEqual([12])
    expect(review!.body).toContain("Reviewed at `1111111`, which is not in this PR's history")
    expect(f.out[0]).toBe('s1 r1: posted 1 line comment, 0 in body, on the PR head 9999999')
  })

  it('uses the PR head when the record names no reviewed commit', () => {
    const r = round({ findings: [finding('codex-F1')] })
    delete r.reviewedSha
    const f = fake({ records: { 's1-r1.json': r }, diffs: { [HEAD]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted[0]!.commit_id).toBe(HEAD)
    expect(f.posted[0]!.body).toContain('<!-- granny-trail s1/r1@unknown -->')
    expect(f.calls.some(c => c.args[1] === '--is-ancestor')).toBe(false)
  })

  it('puts every plan-review finding in the body, on the PR head, without reading a diff', () => {
    const f = fake({ records: { 'plan-r1.json': round({ loop: 'plan', name: 'plan review', findings: [finding('codex-F1', { file: '/plans/p.md', line: 4 })], fix: { label: 'fix plan review r1' } }) } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted[0]).toMatchObject({ commit_id: HEAD, comments: [] })
    expect(f.posted[0]!.body).toContain('### Findings on the plan\n\n#### `/plans/p.md:4`')
    expect(f.calls.some(c => c.cmd === 'git' && (c.args.includes('diff') || c.args[0] === 'merge-base'))).toBe(false)
    expect(f.out[0]).toBe('plan r1: posted 0 line comments, 1 in body')
  })

  it('posts the rounds in the order they happened', () => {
    const f = fake({
      records: {
        'final-r1.json': round({ loop: 'final', name: 'final review', findings: [finding('codex-F1')] }),
        's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1')] }),
        's1-r2.json': round({ round: 2, findings: [finding('codex-F1')] }),
        's1-r1.json': round({ findings: [finding('codex-F1')] }),
        'plan-r1.json': round({ loop: 'plan', findings: [finding('codex-F1')] }),
      },
    })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted.map(p => /<!-- granny-trail (\S+) -->$/.exec(p.body)![1])).toEqual(['plan/r1@1111111a', 's1/r1@1111111a', 's1/r2@1111111a', 's2/r1@1111111a', 'final/r1@1111111a'])
  })

  it('skips the rounds whose marker the PR already has and posts only the missing ones', () => {
    const r1 = round({ findings: [finding('codex-F1')], fix: fix(SHA1, SHA2, ['c']) })
    const r2 = round({ round: 2, reviewedSha: SHA2, findings: [finding('codex-F1')] })
    const f = fake({ records: { 's1-r1.json': r1, 's1-r2.json': r2 }, reviews: 'header\n<!-- granny-trail s1/r1@1111111a -->\nother review\n' })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted).toHaveLength(1)
    expect(f.posted[0]!.body).toContain('<!-- granny-trail s1/r2@2222222b -->')
    expect(f.out).toEqual(['s1 r1: skipped, already posted', 's1 r2: posted 0 line comments, 1 in body', PR.url])
    expect(f.calls.find(c => c.cmd === 'gh' && c.args[1] === '--paginate')!.args).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/pulls/7/reviews', '--jq', '.[].body'])
  })

  it('posts a clean round only when it ends a loop that had findings', () => {
    const f = fake({
      records: {
        's1-r1.json': round({ outcome: 'clean' }),
        's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1')], fix: fix(SHA1, SHA2, ['c']) }),
        's2-r2.json': round({ loop: 's2', round: 2, reviewedSha: SHA2, outcome: 'clean' }),
      },
    })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted).toHaveLength(2)
    expect(f.posted[1]).toEqual({ commit_id: SHA2, event: 'COMMENT', body: '**granny · Stage 2 (engine) · round 2: clean** - the review found nothing more\n<!-- granny-trail s2/r2@2222222b -->', comments: [] })
    expect(f.out).toEqual(['s1 r1: clean, nothing to post', 's2 r1: posted 0 line comments, 1 in body', "s2 r2: posted the round's clean note", PR.url])
  })

  it('posts a failed review round that found nothing, with its note', () => {
    const f = fake({ records: { 's1-r1.json': round({ outcome: 'review-failed', note: 'codex: timed out' }) } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted[0]!.body).toContain('The loop ended here: `review-failed` - codex: timed out')
  })

  it('prints every review and posts nothing on --dry-run', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail(['--dry-run'], f.io)).toBe(0)
    expect(f.calls.some(c => c.args[1] === '--method')).toBe(false)
    expect(f.out[0]).toBe('s1 r1: would post 1 line comment, 0 in body')
    expect(JSON.parse(f.out[1]!)).toMatchObject({ commit_id: SHA1, event: 'COMMENT', comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT' }] })
    expect(f.out.at(-1)).toBe(PR.url)
  })

  it('exits 2 and asks for the PR when there is none', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, pr: null })
    expect(postTrail([], f.io)).toBe(2)
    expect(f.out).toEqual(['open the PR first (no pull requests found for branch "feat/x")'])
  })

  it('asks gh for the PR given with --pr and reads the trail given with --trail', () => {
    const f = fake({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, workDir: () => { throw new Error('not read') } })
    expect(postTrail(['--pr', '7', '--trail', DIR], f.io)).toBe(0)
    expect(f.calls.find(c => c.args[0] === 'pr')!.args).toEqual(['pr', 'view', '7', '--json', 'number,url,headRefOid,baseRefOid'])
  })

  it('reads the trail under the configured work dir', () => {
    const f = fake({ records: {}, workDir: () => 'tmp/g/' })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.out).toEqual([`no trail at ${TOP}/tmp/g/trail - a granny run writes it there (config trail: true)`])
  })

  it('keeps posting after a round fails, names it and exits non-zero', () => {
    const f = fake({
      records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }), 's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1')] }) },
      failPost: p => p.body.includes('s1/r1@'),
    })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.posted).toHaveLength(1)
    expect(f.out).toEqual([
      's1 r1: FAILED to post - HTTP 422: Unprocessable Entity',
      's2 r1: posted 0 line comments, 1 in body',
      PR.url,
      'not posted: s1 r1 - run the script again to post only what is missing',
    ])
  })

  it('posts a round with every finding in the body when GitHub refuses its line comments', () => {
    const f = fake({
      records: { 's1-r1.json': round({ findings: [finding('codex-F1', { file: 'src/a.ts', line: 12 }), finding('codex-F2', { file: 'src/b.ts', line: 99 })] }) },
      diffs: { [SHA1]: A_DIFF },
      failPost: p => p.comments.length > 0,
    })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.posted).toHaveLength(1)
    expect(f.posted[0]!.comments).toEqual([])
    expect(f.posted[0]!.body).toContain("GitHub refused this round's line comments (HTTP 422: Unprocessable Entity), so every finding is below.")
    expect(f.posted[0]!.body).toContain('`src/a.ts:12`')
    expect(f.posted[0]!.body).toContain('`src/b.ts:99`')
    expect(f.out[0]).toBe('s1 r1: posted with all 2 in body - GitHub refused the line comments: HTTP 422: Unprocessable Entity')
  })

  it('skips and names a record that does not validate', () => {
    const f = fake({ records: { 'broken.json': '{', 'old.json': { ...round(), version: 2 }, 's1-r1.json': round({ findings: [finding('codex-F1')] }) } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.out[0]).toStartWith('skipped broken.json: ')
    expect(f.out[1]).toBe('skipped old.json: version 2 is not 1')
    expect(f.posted).toHaveLength(1)
  })

  it('refuses an unknown argument with the usage', () => {
    const f = fake({ records: {} })
    expect(postTrail(['--pr', 'abc'], f.io)).toBe(1)
    expect(f.out[0]).toBe('--pr takes a PR number, got abc\nusage: node pr-comments.mjs [--platform github|gitlab] [--pr <number>] [--trail <dir>] [--out <file> [--base <ref>]] [--dry-run]')
    expect(postTrail(['--push'], f.io)).toBe(1)
    expect(f.calls).toEqual([])
  })
})

describe('GitLab', () => {
  const GITLAB = { origin: 'git@gitlab.com:o/r.git' }
  const residual: Partial<TrailFinding> = { route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } }
  const gitlab = (opts: Parameters<typeof fake>[0] = {}) => fake({ remotes: GITLAB, ...opts })
  const writes = (f: Fake) => f.calls.filter(c => c.cmd === 'glab' && c.args[0] === 'api' && ['POST', 'DELETE'].includes(c.args[c.args.indexOf('--method') + 1]!))
  const position = (head: string, path = 'src/a.ts', oldPath = path) => ({ position_type: 'text', base_sha: `mb-${head}`, start_sha: `mb-${head}`, head_sha: head, old_path: oldPath, new_path: path })
  const LIST = ['--method', 'GET', '--paginate', '--output', 'ndjson']

  it('posts a round as one draft note per line comment and one bulk publish whose note is the round body', () => {
    const added = finding('codex-F1', { line: 9 })
    const context = finding('codex-F2', { line: 12 })
    const outside = finding('codex-F3', { line: 40, ...residual })
    const r = round({ findings: [added, context, outside], fix: fix(SHA1, SHA2, ['c']) })
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published).toEqual([
      {
        note: roundBody(r, [r], { inBody: [outside], notInPr: false, gitlab: true }),
        drafts: [
          { id: 200, note: findingComment(added, r, [r]), position: { ...position(SHA1), new_line: 9 } },
          { id: 201, note: findingComment(context, r, [r]), position: { ...position(SHA1), new_line: 12, old_line: 11 } },
        ],
      },
    ])
    expect(f.calls.filter(c => c.cmd === 'glab').map(c => c.args)).toEqual([
      ['api', 'projects/:id/merge_requests', '--method', 'GET', '--raw-field', 'source_branch=feat/x', '--raw-field', 'state=opened', '--paginate', '--output', 'ndjson'],
      ['api', MR_PATH],
      ['api', `${MR_PATH}/notes`, ...LIST],
      ['api', `${MR_PATH}/draft_notes`, ...LIST],
      ['api', `${MR_PATH}/draft_notes`, ...GLAB_POST],
      ['api', `${MR_PATH}/draft_notes`, ...GLAB_POST],
      ['api', `${MR_PATH}/draft_notes/bulk_publish`, ...GLAB_POST],
    ])
    expect(f.calls.find(c => c.args[0] === 'merge-base' && c.args[1] !== '--is-ancestor')!.args).toEqual(['merge-base', BASE, SHA1])
    expect(f.calls.some(c => c.cmd === 'gh')).toBe(false)
    expect(f.out).toEqual(['s1 r1: posted 2 line comments, 1 in body', MR.web_url])
  })

  it("places a comment on a renamed file by its old and new path", () => {
    const rename = ['diff --git a/src/old.ts b/src/new.ts', 'rename from src/old.ts', 'rename to src/new.ts', '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -3,2 +3,3 @@', ' a', '+b', ' c'].join('\n')
    const f = gitlab({ records: { 's1-r1.json': round({ findings: [finding('codex-F1', { file: 'src/new.ts', line: 5 }), finding('codex-F2', { file: 'src/new.ts', line: 4 })] }) }, diffs: { [SHA1]: rename } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published[0]!.drafts.map(d => d.position)).toEqual([
      { ...position(SHA1, 'src/new.ts', 'src/old.ts'), new_line: 5, old_line: 4 },
      { ...position(SHA1, 'src/new.ts', 'src/old.ts'), new_line: 4 },
    ])
  })

  it("anchors on the MR head and says so when the reviewed commit is not in the MR's history", () => {
    const f = gitlab({ records: { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }, ancestors: [], diffs: { [HEAD]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published[0]!.drafts.map(d => d.position)).toEqual([{ ...position(HEAD), new_line: 12, old_line: 11 }])
    expect(f.gl.published[0]!.note).toContain("Reviewed at `1111111`, which is not in this MR's history: the line comments sit on the MR's head.")
    expect(f.out[0]).toBe('s1 r1: posted 1 line comment, 0 in body, on the MR head 9999999')
  })

  it('finds no MR, several MRs, the MR given with --pr, and none on a detached HEAD', () => {
    const records = { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }
    const none = gitlab({ records, gitlab: { mrs: [] } })
    expect(postTrail([], none.io)).toBe(2)
    expect(none.out).toEqual(['open the MR first (no open merge request from feat/x)'])
    const several = gitlab({ records, gitlab: { mrs: [{ iid: 5, web_url: MR.web_url }, { iid: 6, web_url: 'https://gitlab.com/o/r/-/merge_requests/6' }] } })
    expect(postTrail([], several.io)).toBe(1)
    expect(several.out).toEqual([`feat/x is the source of 2 open MRs: !5 ${MR.web_url}, !6 https://gitlab.com/o/r/-/merge_requests/6 - pass --pr <iid>`])
    const given = gitlab({ records, gitlab: { mrs: [] } })
    expect(postTrail(['--pr', '5'], given.io)).toBe(0)
    expect(given.calls.filter(c => c.cmd === 'glab')[0]!.args).toEqual(['api', MR_PATH])
    const gone = gitlab({ records, gitlab: { mr: null } })
    expect(postTrail(['--pr', '5'], gone.io)).toBe(2)
    expect(gone.out).toEqual(['open the MR first (glab: 404 Not Found (HTTP 404))'])
    const detached = gitlab({ records, branch: '' })
    expect(postTrail([], detached.io)).toBe(2)
    expect(detached.out).toEqual(['open the MR first (no branch is checked out: pass --pr <iid>)'])
    expect([none, several, gone, detached].flatMap(writes)).toEqual([])
  })

  it('stops when GitLab has no diff for the MR yet, or its commits are not in the checkout, and never fetches', () => {
    const records = { 's1-r1.json': round({ findings: [finding('codex-F1')] }) }
    const pending = gitlab({ records, gitlab: { mr: { ...MR, diff_refs: null } } })
    expect(postTrail([], pending.io)).toBe(1)
    expect(pending.out).toEqual(['GitLab has no diff for !5 yet: run this again in a moment'])
    const target = gitlab({ records, refs: { [`${HEAD}^{commit}`]: HEAD } })
    expect(postTrail([], target.io)).toBe(1)
    expect(target.out).toEqual(["the MR's target commit 0000000 is not in this checkout: run git fetch, then run this again"])
    const both = gitlab({ records, refs: {} })
    expect(postTrail([], both.io)).toBe(1)
    expect(both.out).toEqual(["the MR's head commit 9999999 and target commit 0000000 are not in this checkout: run git fetch, then run this again"])
    for (const f of [pending, target, both]) {
      expect(f.calls.some(c => c.args[0] === 'fetch')).toBe(false)
      expect(f.calls.some(c => c.args[1]?.endsWith('/notes'))).toBe(false)
    }
  })

  it("skips the rounds whose marker the MR's notes already have", () => {
    const r1 = round({ findings: [finding('codex-F1')], fix: fix(SHA1, SHA2, ['c']) })
    const r2 = round({ round: 2, reviewedSha: SHA2, findings: [finding('codex-F1')] })
    const f = gitlab({ records: { 's1-r1.json': r1, 's1-r2.json': r2 }, gitlab: { notes: ['other', `header\n${roundMarker(r1)}`] } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published.map(p => p.note.split('\n').at(-1))).toEqual([roundMarker(r2)])
    expect(f.out).toEqual(['s1 r1: skipped, already posted', 's1 r2: posted 0 line comments, 1 in body', MR.web_url])
  })

  it('deletes the drafts an earlier run left behind before it posts, and leaves them alone when nothing is to post', () => {
    const r = round({ findings: [finding('codex-F1')] })
    const left = { id: 50, note: `old\n${findingMarker(r, { id: 'codex-F1' })}` }
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { drafts: [left] } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.deleted).toEqual([50])
    expect(f.gl.published[0]!.drafts.map(d => d.id)).toEqual([200])
    expect(f.calls.find(c => c.args.includes('DELETE'))!.args).toEqual(['api', `${MR_PATH}/draft_notes/50`, '--method', 'DELETE'])
    expect(f.out).toEqual(['deleted 1 leftover granny draft note', 's1 r1: posted 1 line comment, 0 in body', MR.web_url])
    const done = gitlab({ records: { 's1-r1.json': r }, gitlab: { drafts: [left], notes: [roundMarker(r)] } })
    expect(postTrail([], done.io)).toBe(0)
    expect(done.calls.some(c => c.args[1]?.endsWith('/draft_notes'))).toBe(false)
  })

  it("stops before posting anything when a draft note of the user's is not granny's", () => {
    const r = round({ findings: [finding('codex-F1')] })
    const drafts = [{ id: 50, note: `old\n${findingMarker(r, { id: 'codex-F1' })}` }, { id: 51, note: 'my own\nthought about this line' }]
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { drafts } })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.out).toEqual([
      'your draft notes on !5 that granny did not write: 51 ("my own thought about this line") - posting a round publishes all your drafts, so publish or delete them first',
      MR.web_url,
    ])
    expect(writes(f)).toEqual([])
  })

  it('publishes a plan-review round and an off-diff round with no draft, and posts a plain note when GitLab refuses an empty publish', () => {
    const plan = round({ loop: 'plan', name: 'plan review', findings: [finding('codex-F1', { file: '/plans/p.md', line: 4 })], fix: { label: 'fix plan review r1' } })
    const off = round({ findings: [finding('codex-F1', { line: 40 })] })
    const records = { 'plan-r1.json': plan, 's1-r1.json': off }
    const f = gitlab({ records, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published.map(p => [p.drafts.length, p.note.split('\n').at(-1)])).toEqual([
      [0, roundMarker(plan)],
      [0, roundMarker(off)],
    ])
    expect(f.gl.published[0]!.note).toContain('### Findings on the plan')
    expect(f.out).toEqual(['plan r1: posted 0 line comments, 1 in body', 's1 r1: posted 0 line comments, 1 in body', MR.web_url])
    const refused = gitlab({ records, diffs: { [SHA1]: A_DIFF }, gitlab: { failPublish: (_, drafts) => !drafts.length } })
    expect(postTrail([], refused.io)).toBe(0)
    expect(refused.gl.published).toEqual([])
    expect(refused.gl.notes).toEqual([f.gl.published[0]!.note, f.gl.published[1]!.note])
    expect(refused.calls.filter(c => c.args[1] === `${MR_PATH}/notes` && c.args.includes('POST'))[0]!.args).toEqual(['api', `${MR_PATH}/notes`, ...GLAB_POST])
    expect(refused.out).toEqual(f.out)
  })

  it("deletes the round's drafts and posts it once as a plain note with every finding when GitLab refuses a draft", () => {
    const r = round({ findings: [finding('codex-F1', { line: 9 }), finding('codex-F2', { line: 12 }), finding('codex-F3', { line: 40, ...residual })] })
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { failDraft: d => d.position?.new_line === 12 } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.deleted).toEqual([200])
    expect(f.gl.drafts).toEqual([])
    expect(f.gl.published).toEqual([])
    expect(f.gl.notes).toHaveLength(1)
    expect(f.gl.notes[0]).toContain("GitLab refused this round's line comments (glab: 400 Bad Request (HTTP 400)), so every finding is below.")
    for (const at of ['`src/a.ts:9`', '`src/a.ts:12`', '`src/a.ts:40`']) expect(f.gl.notes[0]).toContain(at)
    expect(f.out).toEqual(['s1 r1: posted with all 3 in body - GitLab refused the line comments: glab: 400 Bad Request (HTTP 400)', MR.web_url])
  })

  it('falls back the same way when GitLab refuses to publish the drafts', () => {
    const r = round({ findings: [finding('codex-F1')] })
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { failPublish: (_, drafts) => drafts.length > 0 } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.deleted).toEqual([200])
    expect(f.gl.notes[0]).toContain("GitLab refused this round's line comments")
    expect(f.out[0]).toBe('s1 r1: posted with all 1 in body - GitLab refused the line comments: glab: 400 Bad Request (HTTP 400)')
  })

  it('names a round whose plain note fails too, keeps posting the others and exits non-zero', () => {
    const records = { 's1-r1.json': round({ findings: [finding('codex-F1')] }), 's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1', { line: 40 })] }) }
    const f = gitlab({ records, diffs: { [SHA1]: A_DIFF }, gitlab: { failDraft: () => true, failNote: true } })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.gl.published.map(p => p.note.split('\n').at(-1))).toEqual(['<!-- granny-trail s2/r1@1111111a -->'])
    expect(f.out).toEqual([
      's1 r1: FAILED to post - glab: 500 Internal Server Error (HTTP 500)',
      's2 r1: posted 0 line comments, 1 in body',
      MR.web_url,
      'not posted: s1 r1 - run the script again to post only what is missing',
    ])
  })

  it('stops when it cannot delete the drafts of a refused round, so no later round publishes them', () => {
    const records = { 's1-r1.json': round({ findings: [finding('codex-F1', { line: 9 }), finding('codex-F2', { line: 12 })] }), 's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1', { line: 40 })] }) }
    const f = gitlab({ records, diffs: { [SHA1]: A_DIFF }, gitlab: { failDraft: d => d.position?.new_line === 12, failDelete: () => true } })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.gl.published).toEqual([])
    expect(f.gl.notes).toEqual([])
    expect(f.out).toEqual([
      "s1 r1: FAILED to post - GitLab refused a line comment (glab: 400 Bad Request (HTTP 400)) and its draft 200 could not be deleted: glab: 503 Service Unavailable (HTTP 503)",
      'stopped: the next round would publish that draft too',
      MR.web_url,
      'not posted: s1 r1 - run the script again to post only what is missing',
    ])
  })

  it('stops when a refused round has a draft whose id glab did not print, so no later round publishes it', () => {
    const records = {
      's1-r1.json': round({ findings: [finding('codex-F1', { line: 9 }), finding('codex-F2', { line: 10 }), finding('codex-F3', { line: 12 })] }),
      's2-r1.json': round({ loop: 's2', findings: [finding('codex-F1', { line: 40 })] }),
    }
    const f = gitlab({ records, diffs: { [SHA1]: A_DIFF }, gitlab: { noId: d => d.position?.new_line === 10, failDraft: d => d.position?.new_line === 12 } })
    expect(postTrail([], f.io)).toBe(1)
    expect(f.gl.deleted).toEqual([200])
    expect(f.gl.drafts.map(d => d.id)).toEqual([201])
    expect(f.gl.published).toEqual([])
    expect(f.gl.notes).toEqual([])
    expect(f.out[0]).toStartWith('s1 r1: FAILED to post - GitLab refused a line comment (glab: 400 Bad Request (HTTP 400)) and a draft it created could not be deleted: glab printed no draft id (')
    expect(f.out.slice(1)).toEqual(['stopped: the next round would publish that draft too', MR.web_url, 'not posted: s1 r1 - run the script again to post only what is missing'])
  })

  it('publishes a round whose draft id glab did not print when nothing is refused', () => {
    const r = round({ findings: [finding('codex-F1', { line: 9 }), finding('codex-F2', { line: 12 })] })
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { noId: d => d.position?.new_line === 9 } })
    expect(postTrail([], f.io)).toBe(0)
    expect(f.gl.published[0]!.drafts.map(d => d.id)).toEqual([200, 201])
    expect(f.out).toEqual(['s1 r1: posted 2 line comments, 0 in body', MR.web_url])
  })

  it('prints the planned GitLab calls on --dry-run and makes none of them', () => {
    const r = round({ findings: [finding('codex-F1')] })
    const left = { id: 50, note: `old\n${findingMarker(r, { id: 'codex-F1' })}` }
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF }, gitlab: { drafts: [left] } })
    expect(postTrail(['--dry-run'], f.io)).toBe(0)
    expect(writes(f)).toEqual([])
    expect(f.out[0]).toBe('would delete 1 leftover granny draft note')
    expect(f.out[1]).toBe('s1 r1: would post 1 line comment, 0 in body')
    expect(JSON.parse(f.out[2]!)).toEqual([
      { method: 'POST', path: `${MR_PATH}/draft_notes`, body: { note: findingComment(r.findings[0]!, r, [r]), position: { ...position(SHA1), new_line: 12, old_line: 11 } } },
      { method: 'POST', path: `${MR_PATH}/draft_notes/bulk_publish`, body: { note: roundBody(r, [r], { inBody: [], notInPr: false, gitlab: true }) } },
    ])
    expect(f.out.at(-1)).toBe(MR.web_url)
  })

  it('writes --out against the MR, and against --base when the branch has no MR', () => {
    const r = round({ findings: [finding('codex-F1')] })
    const f = gitlab({ records: { 's1-r1.json': r }, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail(['--out', 'o.json'], f.io)).toBe(0)
    const plan = planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, [r], { head: HEAD, base: BASE, platform: 'gitlab' }, TOP)
    expect(JSON.parse(f.written['o.json']!)).toEqual({ version: 1, reviews: [plan] })
    expect(writes(f)).toEqual([])
    const none = gitlab({ records: { 's1-r1.json': r }, gitlab: { mrs: [] }, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'o.json', '--base', 'main'], none.io)).toBe(0)
    expect(none.written['o.json']).toBeDefined()
    const missing = gitlab({ records: { 's1-r1.json': r }, gitlab: { mr: null }, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'o.json', '--base', 'main', '--pr', '5'], missing.io)).toBe(2)
    expect(missing.out).toEqual(['open the MR first (glab: 404 Not Found (HTTP 404))'])
    const stale = gitlab({ records: { 's1-r1.json': r }, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'o.json', '--base', 'main'], stale.io)).toBe(1)
    expect(stale.out[0]).toStartWith("the MR's head commit 9999999 and target commit 0000000 are not in this checkout")
  })
})

describe('--out', () => {
  const BITBUCKET = { origin: 'https://bitbucket.org/o/r.git' }
  const residual: Partial<TrailFinding> = { route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } }
  const trail = () => {
    const r1 = round({ findings: [finding('codex-F1'), finding('codex-F2', { line: 40, ...residual })], fix: fix(SHA1, SHA2, ['c']) })
    const r2 = round({ round: 2, reviewedSha: SHA2, outcome: 'clean' })
    const lone = round({ loop: 's2', outcome: 'clean' })
    return { r1, r2, lone, records: { 's1-r1.json': r1, 's1-r2.json': r2, 's2-r1.json': lone } }
  }

  it("writes every round's plan against the PR, posts nothing and reads no posted review", () => {
    const { r1, r2, records } = trail()
    const f = fake({ records, diffs: { [SHA1]: A_DIFF } })
    expect(postTrail(['--out', 'trail.json'], f.io)).toBe(0)
    const all = [r1, r2, trail().lone]
    const plans = [r1, r2].map(r => planRound(fake({ diffs: { [SHA1]: A_DIFF } }).io, r, all, prTarget(PR), TOP))
    expect(JSON.parse(f.written['trail.json']!)).toEqual({ version: 1, reviews: plans })
    expect(f.written['trail.json']!.endsWith('}\n')).toBe(true)
    expect(f.calls.filter(c => c.cmd === 'gh').map(c => c.args[0])).toEqual(['pr'])
    expect(f.out).toEqual(['wrote 2 reviews to trail.json'])
  })

  it('plans against --base and the checked-out commit when there is no PR, without asking gh on an unknown host', () => {
    const { r1, records } = trail()
    const f = fake({ records, remotes: BITBUCKET, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'trail.json', '--base', 'main'], f.io)).toBe(0)
    const { reviews } = JSON.parse(f.written['trail.json']!)
    expect(reviews[0]).toMatchObject({ loop: 's1', round: 1, commit: SHA1, mergeBase: `mb-${SHA1}`, marker: roundMarker(r1) })
    expect(f.calls.some(c => c.cmd === 'gh')).toBe(false)
    expect(f.calls.find(c => c.args[1] === '--is-ancestor')!.args).toEqual(['merge-base', '--is-ancestor', SHA1, HEAD])
    expect(f.calls.find(c => c.args[0] === 'merge-base' && c.args[1] !== '--is-ancestor')!.args).toEqual(['merge-base', BASE, SHA1])
  })

  it('falls back to --base when gh finds no PR, and takes the PR when there is one', () => {
    const none = fake({ records: trail().records, pr: null, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'o.json', '--base', 'main'], none.io)).toBe(0)
    expect(none.written['o.json']).toBeDefined()
    const pr = fake({ records: trail().records, refs: {} })
    expect(postTrail(['--out', 'o.json', '--base', 'main'], pr.io)).toBe(0)
    expect(pr.calls.some(c => c.args[0] === 'rev-parse' && c.args[1] === '--verify')).toBe(false)
  })

  it('stops and names --base when there is no PR to take the target branch from', () => {
    const f = fake({ records: trail().records, remotes: BITBUCKET })
    expect(postTrail(['--out', 'trail.json'], f.io)).toBe(1)
    expect(f.out).toEqual(['--out needs the target branch: open the PR, or pass --base <ref>'])
    expect(f.written).toEqual({})
  })

  it('stops on a --base that is not a commit, and on a --pr gh cannot find', () => {
    const bad = fake({ records: trail().records, remotes: BITBUCKET, refs: {} })
    expect(postTrail(['--out', 'trail.json', '--base', 'nope'], bad.io)).toBe(1)
    expect(bad.out).toEqual(['--base nope is not a commit'])
    const missing = fake({ records: trail().records, pr: null })
    expect(postTrail(['--out', 'trail.json', '--pr', '9'], missing.io)).toBe(2)
    expect(missing.out).toEqual(['open the PR first (no pull requests found for branch "feat/x")'])
    expect({ ...bad.written, ...missing.written }).toEqual({})
  })

  it('prints the file it would write on --dry-run', () => {
    const f = fake({ records: trail().records, remotes: BITBUCKET, refs: { 'main^{commit}': BASE, 'HEAD^{commit}': HEAD } })
    expect(postTrail(['--out', 'trail.json', '--base', 'main', '--dry-run'], f.io)).toBe(0)
    expect(f.written).toEqual({})
    expect(JSON.parse(f.out[0]!)).toMatchObject({ version: 1, reviews: [{ loop: 's1', round: 1 }, { loop: 's1', round: 2 }] })
    expect(f.out[1]).toBe('would write 2 reviews to trail.json')
  })

  it('takes --base only with --out', () => {
    const f = fake({ records: {} })
    expect(postTrail(['--base', 'main'], f.io)).toBe(1)
    expect(f.out[0]).toStartWith('--base goes with --out <file>\n')
    expect(f.calls).toEqual([])
  })
})

describe('postTrail in a real checkout', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

  function anchorUnder(config: (dir: string) => string[][], cwd = '') {
    const dir = mkdtempSync(join(tmpdir(), 'granny-hunks-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(join(repo, 'b'), { recursive: true })
      mkdirSync(join(repo, 'sub'))
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env })
        expect(r.status).toBe(0)
        return r.stdout.trim()
      }
      git('init', '-q', '-b', 'main')
      git('config', 'remote.origin.url', 'https://github.com/o/r.git')
      writeFileSync(join(repo, 'b/x.ts'), 'one\n')
      writeFileSync(join(repo, 'sub/keep.ts'), 'keep\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'b/x.ts'), 'one\ntwo\n')
      git('commit', '-q', '-am', 'two')
      const head = git('rev-parse', 'HEAD')
      for (const [key, value] of config(dir)) git('config', key!, value!)
      const trail = join(repo, '.granny/trail')
      mkdirSync(trail, { recursive: true })
      writeFileSync(join(trail, 's1-r1.json'), JSON.stringify(round({ base, reviewedSha: head, findings: [finding('codex-F1', { file: 'b/x.ts', line: 2 })] })))
      const posted: ReviewPayload[] = []
      const io: PosterIo = {
        exec(cmd, args, input) {
          if (cmd === 'gh' && args[0] === 'pr') return { code: 0, stdout: JSON.stringify({ ...PR, headRefOid: head, baseRefOid: base }), stderr: '' }
          if (cmd === 'gh' && args[1] === '--paginate') return { code: 0, stdout: '', stderr: '' }
          if (cmd === 'gh') {
            posted.push(JSON.parse(input!) as ReviewPayload)
            return { code: 0, stdout: '{}', stderr: '' }
          }
          const r = spawnSync(cmd, args, { cwd: join(repo, cwd), encoding: 'utf8', input, env })
          return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
        },
        list: d => (existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.json')) : undefined),
        read: path => readFileSync(path, 'utf8'),
        workDir: () => '.granny',
        write: () => {},
        print: () => {},
      }
      expect(postTrail([], io)).toBe(0)
      return posted[0]!.comments.map(c => [c.path, c.line])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('anchors a finding with no diff config set', () => {
    expect(anchorUnder(() => [])).toEqual([['b/x.ts', 2]])
  })

  it.each([
    ['diff.noprefix', () => [['diff.noprefix', 'true']]],
    ['diff.mnemonicPrefix', () => [['diff.mnemonicPrefix', 'true']]],
    ['color.diff=always', () => [['color.diff', 'always']]],
    ['diff.external', () => [['diff.external', 'true']]],
  ] as Array<[string, (dir: string) => string[][]]>)("anchors a finding whatever the user's %s says", (_, config) => {
    expect(anchorUnder(config)).toEqual([['b/x.ts', 2]])
  })

  it('anchors a finding when the file has a textconv driver', () => {
    const config = (dir: string) => {
      const conv = join(dir, 'conv.sh')
      writeFileSync(conv, '#!/bin/sh\nseq 10; cat "$1"\n')
      chmodSync(conv, 0o755)
      writeFileSync(join(dir, 'repo/.git/info/attributes'), '*.ts diff=conv\n')
      return [['diff.conv.textconv', conv]]
    }
    expect(anchorUnder(config)).toEqual([['b/x.ts', 2]])
  })

  it('anchors a finding outside the directory it runs in under diff.relative', () => {
    expect(anchorUnder(() => [['diff.relative', 'true']], 'sub')).toEqual([['b/x.ts', 2]])
  })
})
