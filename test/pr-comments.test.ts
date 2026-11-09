import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrailFinding, TrailRound } from '../src/core/types'
import { diffLine, onChangedLine, parseDiff, parseHunks } from '../src/pr/hunks'
import type { PrInfo, ReviewPayload } from '../src/pr/github'
import { planRound, type Target } from '../src/pr/plan'
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

interface Fake {
  io: PosterIo
  out: string[]
  calls: Array<{ cmd: string; args: string[]; input?: string }>
  posted: ReviewPayload[]
}

function fake(opts: {
  records?: Record<string, unknown>
  pr?: PrInfo | null
  reviews?: string
  ancestors?: string[]
  diffs?: Record<string, string>
  failPost?: (p: ReviewPayload) => boolean
  workDir?: () => string
}): Fake {
  const out: string[] = []
  const calls: Fake['calls'] = []
  const posted: ReviewPayload[] = []
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
  const records = opts.records === undefined ? undefined : Object.fromEntries(Object.entries(opts.records).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  const ancestors = new Set(opts.ancestors ?? [SHA1, SHA2, SHA3])
  const io: PosterIo = {
    exec(cmd, args, input) {
      calls.push({ cmd, args, ...(input === undefined ? {} : { input }) })
      const line = args.join(' ')
      if (cmd === 'git' && line === 'rev-parse --show-toplevel') return ok(`${TOP}\n`)
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
    print: line => out.push(line),
  }
  return { io, out, calls, posted }
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
    expect(f.out[0]).toBe('--pr takes a PR number, got abc\nusage: node pr-comments.mjs [--pr <number>] [--trail <dir>] [--dry-run]')
    expect(postTrail(['--push'], f.io)).toBe(1)
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
