import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { judgePrompt, planJudgePrompt, tagPrompt } from '../src/core/prompts'
import { decide, isPrBody, type Policy } from '../src/core/review'
import { SCHEMAS } from '../src/core/schemas'
import { trailRound } from '../src/core/trail'
import type { AgentRequest, Finding } from '../src/core/types'
import { trailProblem } from '../src/pr/records'
import { fakeHost } from './fake-host'

const OPUS = { reviewers: [{ name: 'opus', engine: 'agent' }] }
const input = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
  config: [OPUS, ...(extra.config === undefined ? [] : [extra.config])],
})
const found = (...items: Array<[string, string, string, number?]>) => ({
  findings: items.map(([severity, title, file, line], n) => ({ id: `F${n + 1}`, severity, file, ...(line === undefined ? {} : { line }), title, detail: 'd' })),
})
const judged = (impact: string, likelihood: string, fixCost: string, extra: Record<string, unknown> = {}) => ({ verdict: 'confirmed', impact, likelihood, fixCost, scope: 'in-scope', evidence: 'src/a.ts:3 - x', ...extra })
const prompt = (calls: AgentRequest[], label: string) => calls.find(c => c.label === label)!.prompt
const f0 = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, severity: 'P3', file: 'src/a.ts', line: 3, title: 't', detail: '', ...extra })

describe('isPrBody', () => {
  it('is true for the PR body under the work dir, however the path is written', () => {
    for (const file of ['.granny/PR-BODY.md', './.granny/PR-BODY.md', '/w/repo/.granny/PR-BODY.md', '.granny/PR-BODY.md:13', '.granny/PR-BODY.md:13-20', '.granny/pr-body.md', '/w/main/.granny/PR-BODY-s2-api.md', ' .granny/PR-BODY.md ', '.granny\\PR-BODY.md', '/w/repo/.granny/PR-BODY.md:4']) {
      expect([file, isPrBody(file, '.granny', ['/w/repo', '/w/main/'])]).toEqual([file, true])
    }
    expect(isPrBody('tmp/granny work/PR-BODY.md', './tmp/granny work/')).toBe(true)
  })

  it('is false for a work dir nested under another folder, and for an absolute path outside the known worktrees', () => {
    for (const file of ['src/.granny/PR-BODY.md', 'packages/app/.granny/PR-BODY.md', './src/.granny/PR-BODY.md', '/w/repo/src/.granny/PR-BODY.md', '/w/other/.granny/PR-BODY.md', '/w/repo-x/.granny/PR-BODY.md', '/.granny/PR-BODY.md']) {
      expect([file, isPrBody(file, '.granny', ['/w/repo', '/w/main'])]).toEqual([file, false])
    }
    expect(isPrBody('/w/repo/.granny/PR-BODY.md', '.granny')).toBe(false)
  })

  it('is false for any other file, a file of that name elsewhere, and a value that is no path', () => {
    for (const file of ['PR-BODY.md', 'docs/PR-BODY.md', '.granny/PR-BODY.md.bak', '.granny/plans/PR-BODY.md', '.granny/PR-BODY', 'x.granny/PR-BODY.md', '.granny/trail/s1-r1.json', 'src/a.ts', '', undefined, 7]) {
      expect([file, isPrBody(file, '.granny')]).toEqual([file, false])
    }
    expect(isPrBody('.granny/PR-BODY.md', 'tmp/g')).toBe(false)
    expect(isPrBody('aXgranny/PR-BODY.md', 'a.granny')).toBe(false)
  })
})

describe('findings on the PR body', () => {
  it('sets a P1 on the PR body aside: the round is clean, with no judge and no fix', async () => {
    const f = fakeHost({ override: req => (req.label === 'review core r1 opus' ? found(['P1', 'PR body misses a section', '.granny/PR-BODY.md', 13]) : undefined) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1, residual: [], unresolved: [], history: [] })
    expect(f.calls.some(c => c.label.startsWith('fix ') || c.label.startsWith('judge '))).toBe(false)
    expect(f.logs).toContain('core r1: 1 finding(s) about the PR body set aside - not judged, not sent, not kept: opus-F1')
    expect(JSON.parse([...f.trail.values()][0]!)).toMatchObject({ outcome: 'clean', findings: [], setAside: [{ id: 'opus-F1', file: '.granny/PR-BODY.md' }] })
  })

  it('judges and sends the code finding of the same round without it', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F2': judged('major', 'edge', 'small') }],
      override: req => (req.label === 'review core r1 opus' ? found(['P3', 'PR body stale', '/work/repo/.granny/PR-BODY.md', 1], ['P2', 'Late save', 'src/a.ts', 3]) : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(prompt(f.calls, 'judge core r1')).not.toContain('PR body stale')
    expect(prompt(f.calls, 'fix core r1')).not.toContain('PR body stale')
    expect(r.stages[0]!.history[0]!.findings.map(x => x.id)).toEqual(['opus-F2'])
  })

  it('does not set aside a finding on a PR-BODY.md nested in the repo', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small') }],
      override: req => (req.label === 'review core r1 opus' ? found(['P3', 'Stale nested body', 'packages/app/.granny/PR-BODY.md', 2]) : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(f.logs.some(l => l.includes('set aside'))).toBe(false)
    expect(prompt(f.calls, 'judge core r1')).toContain('Stale nested body')
    expect(r.stages[0]!.history[0]!.findings.map(x => x.id)).toEqual(['opus-F1'])
  })

  it('sets aside the lane file of a parallel stage, filed by its absolute path in the main worktree', async () => {
    const body = '/work/repo-worktrees/feat-x/.granny/PR-BODY-s2-two.md'
    const f = fakeHost({
      worktree: (command, cwd) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd,
      override: req => (req.label === 'review two r1 opus' ? found(['P3', 'Lane notes stale', body, 1]) : undefined),
    })
    const r = await runGranny(f.host, input({ stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [] }] }))
    expect(f.calls.find(c => c.label === 'review two r1 opus')!.cwd).toBe('/work/repo-worktrees/feat-x--s2-two')
    expect(f.logs).toContain('two r1: 1 finding(s) about the PR body set aside - not judged, not sent, not kept: opus-F1')
    expect(r.stages[1]).toMatchObject({ outcome: 'clean', residual: [], unresolved: [] })
  })

  it('leaves a set-aside finding out of the unresolved ones when another reviewer failed', async () => {
    const f = fakeHost({
      reviews: [{ code: 1, output: 'codex: not logged in' }, { code: 1, output: 'codex: still not logged in' }],
      override: req => (req.label === 'review core r1 opus' ? found(['P2', 'PR body stale', '.granny/PR-BODY.md', 1], ['P2', 'Late save', 'src/a.ts', 3]) : undefined),
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex', engine: 'auto' }, { name: 'opus', engine: 'agent' }] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.unresolved.map(x => x.id)).toEqual(['opus-F2'])
    expect(JSON.parse([...f.trail.values()][0]!)).toMatchObject({ outcome: 'review-failed', findings: [{ id: 'opus-F2' }], setAside: [{ id: 'opus-F1', file: '.granny/PR-BODY.md' }] })
  })

  it('does not set aside a plan-review finding filed under the work dir: the judge still sees it', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'edge', 'small') }],
      override: req => (req.label === 'review plan review r1 opus' ? found(['P3', 'Plan names the wrong body', '.granny/PR-BODY.md', 1]) : req.label.startsWith('review core') ? { findings: [] } : undefined),
    })
    const r = await runGranny(f.host, input({ plan: '/plans/v1.md', config: { planReview: true } }))
    expect(f.logs.some(l => l.includes('set aside'))).toBe(false)
    expect(prompt(f.calls, 'judge plan review r1')).toContain('Plan names the wrong body')
    expect(r.plan!.history[0]!.findings.map(x => x.id)).toEqual(['opus-F1'])
  })

  it('keeps the set-aside findings in the trail record, which the poster still accepts', () => {
    const aside = f0('opus-F1', { file: '.granny/PR-BODY.md' })
    const record = trailRound({ loop: 's1', name: 'core', round: 1, base: 'main', reviewers: [{ name: 'opus', engine: 'agent' }], findings: [], setAside: [aside], outcome: 'clean' })
    expect(record.setAside).toEqual([aside])
    expect(trailProblem(JSON.parse(JSON.stringify(record)))).toBeUndefined()
    expect(trailRound({ loop: 's1', name: 'core', round: 1, base: 'main', reviewers: [], findings: [] })).not.toHaveProperty('setAside')
  })
})

const P = { repo: '/w/repo', branch: 'feat/x', base: 'main', config: resolveConfig([]) }
const POLICY: Policy = { threshold: 70, alwaysFix: ['critical', 'major'], rideAlong: 55, tags: { typo: { description: 'd', fix: true }, naming: { description: 'd', points: 40 } } }

describe('not-code findings', () => {
  it('keeps a not-code finding as residual by rule 11, whatever its classes and tag', () => {
    const d = decide(f0('a'), judged('major', 'common', 'trivial', { scope: 'not-code', tag: 'typo' }), POLICY)
    expect(d).toMatchObject({ scope: 'not-code', priority: 100, decision: { rule: 11, action: 'residual', why: 'not about the code or what it does' } })
    expect(d.tag).toBeUndefined()
  })

  it('leaves rules 1 and 3 in front of rule 11', () => {
    const p1 = f0('a', { severity: 'P1' })
    expect(decide(p1, judged('major', 'common', 'trivial', { scope: 'not-code' }), POLICY).decision).toMatchObject({ rule: 1, action: 'fix' })
    expect(decide(p1, judged('major', 'common', 'trivial', { scope: 'not-code' }), POLICY, () => true).decision).toMatchObject({ rule: 11, action: 'residual' })
    expect(decide(f0('a'), judged('major', 'common', 'trivial', { scope: 'not-code', verdict: 'refuted' }), POLICY).decision).toMatchObject({ rule: 3 })
  })

  it('names the not-code scope in every judge prompt, the schema and the trail check', () => {
    for (const text of [judgePrompt(P, 'abc', []), planJudgePrompt(P, ['/p.md'], []), tagPrompt(P, 'abc', [])]) {
      expect(text).toContain("| other-stage (another stage's job) | not-code (not about the code or what it does: a code comment or doc comment that is wrong, outdated, missing, too long or there against a rule, a TODO note or commented-out code included; a commit message or the commit history; the pull request description; how the work was done,")
      expect(text).toContain('A doc file such as the README is not a comment and stays in scope).')
    }
    expect((SCHEMAS.judge.properties.perFinding as { items: { properties: { scope: { enum: string[] } } } }).items.properties.scope.enum).toEqual(['in-scope', 'pre-existing', 'other-stage', 'not-code'])
    const record = trailRound({ loop: 's1', name: 'core', round: 1, base: 'main', reviewers: [], findings: [f0('a-F1', { scope: 'not-code' })] })
    expect(trailProblem(JSON.parse(JSON.stringify(record)))).toBeUndefined()
  })

  it('never lets a not-code finding ride along with a fix round, and leaves it out of the fix prompt', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('critical', 'common', 'small', { scope: 'not-code' }) }],
      override: req => (req.label === 'review core r1 opus' ? found(['P2', 'Late save', 'src/a.ts', 3], ['P2', 'Doc comment is stale', 'src/b.ts', 7]) : undefined),
    })
    const r = await runGranny(f.host, input())
    const round = r.stages[0]!.history[0]!.findings
    expect(round.map(x => [x.id, x.priority, x.decision?.rule, x.decision?.action])).toEqual([
      ['opus-F1', 80, 6, 'fix'],
      ['opus-F2', 100, 11, 'residual'],
    ])
    expect(prompt(f.calls, 'fix core r1')).toContain('Late save')
    expect(prompt(f.calls, 'fix core r1')).not.toContain('Doc comment is stale')
  })

  it('lets a code copy merged into a not-code copy ride along with a fix round', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('major', 'common', 'small', { scope: 'not-code' }), 'opus-F3': { ...judged('moderate', 'edge', 'small'), duplicateOf: 'opus-F2' } }],
      override: req => (req.label === 'review core r1 opus' ? found(['P2', 'Late save', 'src/a.ts', 3], ['P2', 'Doc says it returns null', 'src/b.ts', 7], ['P2', 'Throws instead of returning null', 'src/b.ts', 9]) : undefined),
    })
    const r = await runGranny(f.host, input())
    const round = r.stages[0]!.history[0]!.findings
    expect(round.map(x => [x.id, x.scope, x.priority, x.decision?.rule, x.decision?.action])).toEqual([
      ['opus-F1', 'in-scope', 80, 6, 'fix'],
      ['opus-F2', 'in-scope', 55, 9, 'fix'],
    ])
    expect(prompt(f.calls, 'fix core r1')).toContain('Doc says it returns null')
  })

  it('tells the stage judge that what the task asks of comments, commits and the PR description is not-code', () => {
    const text = judgePrompt(P, 'abc', [], [], { number: 1, total: 1, name: 'core', task: 'WP-01' })
    expect(text).toContain("a missing part of this stage's task is in-scope and major; what the task or a rule asks of comments, commits, the pull request description or the way of working is not-code.")
  })
})

describe('a repeat of a kept finding', () => {
  const kept = f0('reviewer-F2', { verdict: 'confirmed', impact: 'minor', likelihood: 'common', fixCost: 'trivial', scope: 'in-scope', evidence: 'src/a.ts:3 - x', priority: 50, decision: { rule: 8, action: 'residual', why: 'under the bar: minor/common/trivial -> 50' } })
  const repeat = (entry: Record<string, unknown>, earlier: Finding = kept, severity = 'P2') => decide(f0('reviewer-F1', { severity, repeatOf: 'r3/reviewer-F2' }), entry, POLICY, () => false, () => earlier)

  it('takes the kept classes when the judge rates it higher, and is not ratcheted', () => {
    const d = repeat(judged('moderate', 'edge', 'small'))
    expect(d).toMatchObject({ impact: 'minor', likelihood: 'common', fixCost: 'trivial', priority: 50 })
    expect(d.decision).toEqual({ rule: 8, action: 'residual', why: 'under the bar: minor/common/trivial -> 50', held: 'repeat of r3/reviewer-F2: moderate/edge/small -> minor/common/trivial' })
    expect(repeat(judged('major', 'edge', 'small')).decision).toMatchObject({ rule: 8, action: 'residual', held: 'repeat of r3/reviewer-F2: major/edge/small -> minor/common/trivial' })
  })

  it('takes them too when the impact is worse and the priority lower, and keeps a lower rating as judged', () => {
    const big: Finding = { ...kept, impact: 'moderate', likelihood: 'common', fixCost: 'large', priority: 60, decision: { rule: 8, action: 'residual', why: 'x' } }
    expect(repeat(judged('major', 'rare', 'large'), big)).toMatchObject({ impact: 'moderate', priority: 60, decision: { rule: 8, held: 'repeat of r3/reviewer-F2: major/rare/large -> moderate/common/large' } })
    const lower = repeat(judged('minor', 'rare', 'trivial'))
    expect([lower.impact, lower.likelihood, lower.priority, lower.decision!.held, lower.decision!.raised]).toEqual(['minor', 'rare', 30, undefined, undefined])
  })

  it('is decided by the normal rules, with no hold and no ratchet, when the judge now rates it critical', () => {
    const critical = repeat(judged('critical', 'rare', 'small'))
    expect(critical).toMatchObject({ impact: 'critical', likelihood: 'rare', priority: 90 })
    expect(critical.decision).toEqual({ rule: 6, action: 'fix', why: 'impact critical is in alwaysFix (critical/rare/small -> 90)' })
    expect(decide(f0('reviewer-F1', { repeatOf: 'r3/reviewer-F2' }), judged('critical', 'rare', 'large'), { threshold: 80, alwaysFix: [] }, () => false, () => kept).decision).toEqual({ rule: 8, action: 'residual', why: 'under the bar: critical/rare/large -> 75' })
    const unverified = repeat(judged('critical', 'edge', 'small', { evidence: 'no place given' }))
    expect(unverified).toMatchObject({ verdict: 'unverified', impact: 'minor', decision: { rule: 8, held: 'repeat of r3/reviewer-F2: major/edge/small -> minor/common/trivial' } })
    const notCode = decide(f0('reviewer-F2'), judged('moderate', 'edge', 'small', { scope: 'not-code' }), POLICY)
    expect(repeat(judged('critical', 'edge', 'small'), notCode).decision).toEqual({ rule: 6, action: 'fix', why: 'impact critical is in alwaysFix (critical/edge/small -> 95)' })
    expect(repeat({ ...judged('critical', 'edge', 'small'), scope: 'not-code' }, notCode).decision).toMatchObject({ rule: 11, action: 'residual' })
  })

  it('gets no config tag, and a P0/P1 that skipped the judge is still fixed', () => {
    const typo = repeat({ ...judged('minor', 'common', 'trivial'), tag: 'typo' })
    expect([typo.priority, typo.tag, typo.decision!.rule]).toEqual([50, undefined, 8])
    expect(repeat({ ...judged('minor', 'edge', 'trivial'), tag: 'naming' })).toMatchObject({ priority: 40, decision: { rule: 8 } })
    expect(repeat(judged('moderate', 'edge', 'small'), kept, 'P1').decision).toMatchObject({ rule: 1, action: 'fix' })
  })

  it('stays a not-code finding when the kept one was', () => {
    const notCode = decide(f0('reviewer-F2'), judged('moderate', 'edge', 'small', { scope: 'not-code' }), POLICY)
    expect(repeat(judged('moderate', 'edge', 'trivial'), notCode)).toMatchObject({ scope: 'not-code', decision: { rule: 11, action: 'residual', held: 'repeat of r3/reviewer-F2: scope in-scope -> not-code, moderate/edge/trivial -> moderate/edge/small' } })
  })

  it('leaves the ratchet on a repeat of a finding that was sent', () => {
    const sent: Finding = { ...kept, impact: 'moderate', likelihood: 'edge', fixCost: 'small', priority: 55, decision: { rule: 9, action: 'fix', why: 'x' } }
    const d = repeat(judged('minor', 'common', 'trivial'), sent)
    expect(d).toMatchObject({ impact: 'moderate', likelihood: 'common', decision: { raised: 'repeat of r3/reviewer-F2: impact minor -> moderate' } })
    expect(d.decision!.held).toBeUndefined()
  })
})
