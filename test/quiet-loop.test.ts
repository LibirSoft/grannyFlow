import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { agentReviewPrompt, commandReviewPrompt, declinedKnown, judgePrompt, knownOf, planJudgePrompt, tagPrompt, type EarlierRound } from '../src/core/prompts'
import { decide, isPrBody, type Policy } from '../src/core/review'
import { SCHEMAS } from '../src/core/schemas'
import { trailRound } from '../src/core/trail'
import type { AgentRequest, Finding } from '../src/core/types'
import { trailProblem } from '../src/pr/records'
import { fakeHost, finding, review } from './fake-host'

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
const TWO_STAGES = { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }], config: { parallel: false } }
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
  const repeat = (entry: Record<string, unknown> | undefined, earlier: Finding = kept, severity = 'P2') => decide(f0('reviewer-F1', { severity, repeatOf: 'r3/reviewer-F2' }), entry, POLICY, () => false, () => ({ label: 'r3/reviewer-F2', finding: earlier }))

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
    expect(decide(f0('reviewer-F1', { repeatOf: 'r3/reviewer-F2' }), judged('critical', 'rare', 'large'), { threshold: 80, alwaysFix: [] }, () => false, () => ({ label: 'r3/reviewer-F2', finding: kept })).decision).toEqual({ rule: 8, action: 'residual', why: 'under the bar: critical/rare/large -> 75' })
    const unverified = repeat(judged('critical', 'edge', 'small', { evidence: 'no place given' }))
    expect(unverified).toMatchObject({ verdict: 'unverified', impact: 'minor', decision: { rule: 8, held: 'repeat of r3/reviewer-F2: major/edge/small -> minor/common/trivial' } })
    const notCode = decide(f0('reviewer-F2'), judged('moderate', 'edge', 'small', { scope: 'not-code' }), POLICY)
    expect(repeat(judged('critical', 'edge', 'small'), notCode).decision).toEqual({ rule: 6, action: 'fix', why: 'impact critical is in alwaysFix (critical/edge/small -> 95)' })
    expect(repeat({ ...judged('critical', 'edge', 'small'), scope: 'not-code' }, notCode).decision).toMatchObject({ rule: 11, action: 'residual' })
  })

  it('gets no config tag', () => {
    const typo = repeat({ ...judged('minor', 'common', 'trivial'), tag: 'typo' })
    expect([typo.priority, typo.tag, typo.decision!.rule]).toEqual([50, undefined, 8])
    expect(repeat({ ...judged('minor', 'edge', 'trivial'), tag: 'naming' })).toMatchObject({ priority: 40, decision: { rule: 8 } })
  })

  it('sends a P0/P1 that skipped the judge by rule 1', () => {
    expect(repeat(undefined, kept, 'P1').decision).toEqual({ rule: 1, action: 'fix', why: 'P0/P1' })
  })

  it('does not hold a judged P0/P1 that rule 1 sends, so the ledger keeps the classes the judge gave', () => {
    const d = repeat(judged('major', 'edge', 'small'), kept, 'P1')
    expect([d.impact, d.likelihood, d.fixCost, d.priority]).toEqual(['major', 'edge', 'small', 80])
    expect(d.decision).toEqual({ rule: 1, action: 'fix', why: 'P0/P1' })
    const declined = decide(f0('reviewer-F1', { severity: 'P1', repeatOf: 'r3/reviewer-F2' }), judged('major', 'edge', 'small'), POLICY, () => true, () => ({ label: 'r3/reviewer-F2', finding: kept }))
    expect(declined).toMatchObject({ impact: 'minor', decision: { rule: 8, held: 'repeat of r3/reviewer-F2: major/edge/small -> minor/common/trivial' } })
  })

  it('leaves a repeat the judge now scopes pre-existing or other-stage to rules 5 and 4, with no hold', () => {
    const pre = repeat(judged('major', 'edge', 'small', { scope: 'pre-existing' }))
    expect([pre.impact, pre.likelihood, pre.fixCost, pre.scope]).toEqual(['major', 'edge', 'small', 'pre-existing'])
    expect(pre.decision).toEqual({ rule: 5, action: 'residual', why: 'pre-existing - ATTENTION: impact major', attention: true })
    const notCode = decide(f0('reviewer-F2'), judged('moderate', 'edge', 'small', { scope: 'not-code' }), POLICY)
    expect(repeat(judged('moderate', 'common', 'small', { scope: 'pre-existing' }), notCode).decision).toEqual({ rule: 5, action: 'residual', why: 'pre-existing' })
    expect(repeat(judged('moderate', 'common', 'small', { scope: 'other-stage' }), notCode).decision).toEqual({ rule: 4, action: 'residual', why: 'left to the stage that owns it' })
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

  it('shows what was held in the EARLIER DECISIONS block, with the rule on repeats', () => {
    const text = judgePrompt(P, 'abc', [], [{ round: 1, sent: [], residual: [f0('a', { decision: { rule: 8, action: 'residual', why: 'w', held: 'repeat of r1/x: a -> b' } })] }])
    expect(text).toContain('"decision":"residual - rule 8: w (held: repeat of r1/x: a -> b)"')
    expect(text).toContain('is not a repeat: leave repeatOf out and say in reason what changed.')
    expect(text).toContain('The engine holds a repeat to the finding it repeats. A repeat of one kept as residual under the bar, or as not-code, is not rated above what that one was kept at, unless you rate its impact critical: being reported again is no reason to rate it higher.')
    expect(text).not.toContain('A repeat cannot drop below the impact and likelihood of the finding it repeats')
  })

  const twoRounds = (second: Record<string, Record<string, unknown>>, again: ReturnType<typeof found>) =>
    fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') }, second],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review core r2 opus') return again
        return undefined
      },
    })

  it('ends the stage residual-only when round 2 repeats the residual of round 1 with higher classes', async () => {
    const f = twoRounds({ 'opus-F1': judged('moderate', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) }, found(['P2', 'Long doc line again', 'src/m.rs', 19]))
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toEqual([expect.objectContaining({ id: 'opus-F1', priority: 50, decision: expect.objectContaining({ rule: 8, held: 'repeat of r1/opus-F2: moderate/edge/small -> minor/common/trivial' }) })])
    expect(f.logs).toContain('core r2: opus-F1 held - repeat of r1/opus-F2: moderate/edge/small -> minor/common/trivial')
    expect(f.calls.some(c => c.label === 'fix core r2')).toBe(false)
  })

  it('holds a fresh finding the judge merges with such a repeat', async () => {
    const f = twoRounds(
      { 'opus-F1': judged('moderate', 'common', 'small', { duplicateOf: 'opus-F2' }), 'opus-F2': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F2' }) },
      found(['P2', 'Doc line', 'src/m.rs', 19], ['P3', 'Long doc line', 'src/m.rs', 19]),
    )
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(f.calls.some(c => c.label === 'fix core r2')).toBe(false)
    expect(r.stages[0]!.history[1]!.findings).toEqual([expect.objectContaining({ id: 'opus-F2', duplicates: ['opus-F1'], decision: expect.objectContaining({ rule: 8, held: 'repeat of r1/opus-F2: moderate/common/small -> minor/common/trivial' }) })])
    expect(f.logs).toContain('core r2: opus-F2 held - repeat of r1/opus-F2: moderate/common/small -> minor/common/trivial')
  })

  it('reads the newest entry when a repeat names a kept finding whose later repeat was sent', async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
        { 'opus-F1': judged('major', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
      ],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review core r2 opus') return found(['P2', 'Doc line breaks the parser', 'src/m.rs', 19])
        if (req.label === 'review core r3 opus') return found(['P2', 'Doc line still breaks the parser', 'src/m.rs', 19])
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    const third = r.stages[0]!.history[2]!.findings[0]!
    expect(third.decision).toMatchObject({ rule: 6, action: 'fix', raised: 'repeat of r2/opus-F1: impact major -> critical' })
    expect(third.decision!.held).toBeUndefined()
    expect(f.calls.some(c => c.label === 'fix core r3')).toBe(true)
  })

  const threeRounds = (scores: Array<Record<string, Record<string, unknown>>>, r1: ReturnType<typeof found>, r2: ReturnType<typeof found>) =>
    fakeHost({
      scores,
      override: req => {
        if (req.label === 'review core r1 opus') return r1
        if (req.label === 'review core r2 opus') return r2
        if (req.label === 'review core r3 opus') return found(['P2', 'Doc line again', 'src/m.rs', 19])
        return undefined
      },
    })

  it('reads the sent repeat when one round both sent and held a repeat of the kept finding', async () => {
    const f = threeRounds(
      [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F2' }), 'opus-F2': judged('moderate', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
        { 'opus-F1': judged('major', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
      ],
      found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19]),
      found(['P2', 'Doc line breaks the parser', 'src/m.rs', 19], ['P3', 'Doc line too long', 'src/m.rs', 19]),
    )
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.history[1]!.findings.map(x => [x.id, x.decision!.rule])).toEqual([['opus-F1', 6], ['opus-F2', 8]])
    const third = r.stages[0]!.history[2]!.findings[0]!
    expect(third.decision).toMatchObject({ rule: 6, action: 'fix', raised: 'repeat of r2/opus-F1: impact major -> critical' })
    expect(third.decision!.held).toBeUndefined()
  })

  it('keeps holding to the kept finding when its newest repeat was refuted', async () => {
    const f = threeRounds(
      [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('none', 'rare', 'trivial', { verdict: 'refuted', repeatOf: 'r1/opus-F2' }), 'opus-F2': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('moderate', 'common', 'small', { repeatOf: 'r1/opus-F2' }) },
      ],
      found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19]),
      found(['P3', 'Doc line too long', 'src/m.rs', 19], ['P2', 'Lost write', 'src/b.ts', 7]),
    )
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.history[1]!.findings.map(x => [x.id, x.decision!.rule])).toEqual([['opus-F1', 3], ['opus-F2', 6]])
    const third = r.stages[0]!.history[2]!.findings[0]!
    expect(third).toMatchObject({ priority: 50, decision: { rule: 8, action: 'residual', held: 'repeat of r1/opus-F2: moderate/common/small -> minor/common/trivial' } })
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 3 })
  })

  it('holds a repeat whichever label of the chain the judge names', async () => {
    const r2: Record<string, Record<string, unknown>> = { 'opus-F1': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F1' }), 'opus-F2': judged('major', 'edge', 'small') }
    const run = (named: string) =>
      runGranny(
        threeRounds(
          [r2, { 'opus-F1': judged('moderate', 'common', 'small', { repeatOf: named }) }],
          found(['P1', 'Doc line breaks the build', 'src/m.rs', 19]),
          found(['P3', 'Long doc line', 'src/m.rs', 19], ['P2', 'Lost write', 'src/b.ts', 7]),
        ).host,
        input(),
      )
    for (const named of ['r1/opus-F1', 'r2/opus-F1']) {
      const r = await run(named)
      expect([named, r.stages[0]!.history[1]!.findings[0]!.decision!.rule]).toEqual([named, 8])
      expect([named, r.stages[0]!.history[2]!.findings[0]]).toEqual([
        named,
        expect.objectContaining({ priority: 50, decision: expect.objectContaining({ rule: 8, held: 'repeat of r2/opus-F1: moderate/common/small -> minor/common/trivial' }) }),
      ])
    }
  })

  it('lets a held repeat ride along with a fix round at the priority it was kept at', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('moderate', 'edge', 'small') }, { 'opus-F1': judged('major', 'common', 'small', { repeatOf: 's1/r1/opus-F1' }), 'opus-F2': judged('critical', 'edge', 'small') }],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P3', 'Missing test', 'src/m.rs', 19])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Missing test again', 'src/m.rs', 19], ['P2', 'Crash on save', 'src/a.ts', 3])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]!.residual[0]).toMatchObject({ priority: 55, decision: { rule: 8 } })
    const held = r.finalReview!.history[0]!.findings.find(x => x.id === 'opus-F1')!
    expect(held).toMatchObject({ impact: 'moderate', likelihood: 'edge', fixCost: 'small', priority: 55 })
    expect(held.decision).toMatchObject({ rule: 9, action: 'fix', held: 'repeat of s1/r1/opus-F1: major/common/small -> moderate/edge/small' })
    expect(prompt(f.calls, 'fix final review r1')).toContain('Missing test again')
  })

  it("holds a final-review repeat of a stage's residual finding", async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'common', 'trivial') }, { 'opus-F1': judged('moderate', 'common', 'small', { repeatOf: 's1/r1/opus-F1' }) }],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Long doc line again', 'src/m.rs', 19])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.finalReview).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.finalReview!.residual[0]).toMatchObject({ priority: 50, decision: { rule: 8, held: 'repeat of s1/r1/opus-F1: moderate/common/small -> minor/common/trivial' } })
    expect(f.logs).toContain('final review r1: opus-F1 held - repeat of s1/r1/opus-F1: moderate/common/small -> minor/common/trivial')
    expect(f.calls.some(c => c.label === 'fix final review r1')).toBe(false)
  })

  const declining = (id: string) => ({ startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', declined: [{ id, reason: 'parse() already checks it at src/p.ts:7' }] })

  it('sends a fresh P0/P1 by rule 1 when it leads a group with a repeat of a declined finding whose later repeat was kept', async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F1' }), 'opus-F2': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F1', duplicateOf: 'opus-F1' }) },
      ],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P1', 'Crash on load', 'src/m.rs', 19])
        if (req.label === 'review core r2 opus') return found(['P3', 'Crash on load again', 'src/m.rs', 19], ['P2', 'Lost write', 'src/b.ts', 7])
        if (req.label === 'review core r3 opus') return found(['P1', 'New crash on save', 'src/m.rs', 19], ['P3', 'Crash on load again', 'src/m.rs', 19])
        if (req.label === 'fix core r1') return declining('opus-F1')
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.history[1]!.findings.map(x => [x.id, x.decision!.rule])).toEqual([['opus-F1', 8], ['opus-F2', 6]])
    const third = r.stages[0]!.history[2]!.findings[0]!
    expect([third.id, third.decision]).toEqual(['opus-F1', { rule: 1, action: 'fix', why: 'P0/P1' }])
    expect(f.calls.some(c => c.label === 'fix core r3')).toBe(true)
    expect(f.logs.some(l => l.includes('core r3: opus-F1 dropped as a repeat'))).toBe(false)
  })

  it('overrules the fixer when the newest finding of a kept chain was sent and declined', async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
        { 'opus-F1': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F2', tag: 'typo' }) },
      ],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review core r2 opus') return found(['P2', 'Doc line breaks the parser', 'src/m.rs', 19])
        if (req.label === 'review core r3 opus') return found(['P3', 'Doc line again', 'src/m.rs', 19])
        if (req.label === 'fix core r2') return declining('opus-F1')
        return undefined
      },
    })
    const r = await runGranny(f.host, input({ config: { tags: { typo: { description: 'd', fix: true } } } }))
    const third = r.stages[0]!.history[2]!.findings[0]!
    expect(third.decision).toMatchObject({ rule: 6, action: 'fix', raised: 'repeat of r2/opus-F1: impact minor -> critical' })
    expect(third.tag).toBeUndefined()
    expect(f.logs).toContain('core r3: the judge overruled the fixer on opus-F1 (repeat of r2/opus-F1, rule 6: impact critical is in alwaysFix (critical/common/trivial -> 100))')
    expect(prompt(f.calls, 'fix core r3')).toContain('- opus-F1 (repeat of r2/opus-F1): reason opus-F1\n  you said: parse() already checks it at src/p.ts:7')
  })

  it('sends a P0/P1 repeat by rule 1 when only the newest finding of its kept chain was declined, not the one it names', async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
        { 'opus-F1': judged('none', 'rare', 'trivial', { verdict: 'refuted', evidence: 'src/p.ts:7 - parse() checks it first', repeatOf: 'r1/opus-F2' }) },
      ],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review core r2 opus') return found(['P2', 'Doc line breaks the parser', 'src/m.rs', 19])
        if (req.label === 'review core r3 opus') return found(['P1', 'Doc line crashes the parser', 'src/m.rs', 19])
        if (req.label === 'fix core r2') return declining('opus-F1')
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.history[2]!.findings[0]!.decision).toMatchObject({ rule: 1, action: 'fix', why: 'P0/P1' })
    expect(f.calls.some(c => c.label === 'fix core r3')).toBe(true)
    expect(prompt(f.calls, 'fix core r3')).not.toContain('OVERRULED')
    expect(f.logs.some(l => l.includes('dropped as a repeat'))).toBe(false)
  })

  it('does not hold a fresh finding merged with a repeat of a kept finding that the hold leaves alone', async () => {
    const f = twoRounds(
      { 'opus-F1': judged('minor', 'common', 'trivial', { repeatOf: 'r1/opus-F2', scope: 'pre-existing' }), 'opus-F2': judged('major', 'edge', 'small', { duplicateOf: 'opus-F1' }) },
      found(['P3', 'Long doc line', 'src/m.rs', 19], ['P2', 'Doc line breaks the parser', 'src/m.rs', 19]),
    )
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.history[1]!.findings[0]!.decision).toMatchObject({ rule: 6, action: 'fix' })
    expect(r.stages[0]!.history[1]!.findings[0]!.decision!.held).toBeUndefined()
    expect(f.calls.some(c => c.label === 'fix core r2')).toBe(true)
  })

  it("reads a stage's repeat chain from the final review, through the stage's own labels", async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F2' }) },
        { 'opus-F1': judged('major', 'edge', 'small', { repeatOf: 's1/r1/opus-F2' }) },
      ],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review one r2 opus') return found(['P2', 'Doc line breaks the parser', 'src/m.rs', 19])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Doc line still breaks the parser', 'src/m.rs', 19])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    const last = r.finalReview!.history[0]!.findings[0]!
    expect(last.decision).toMatchObject({ rule: 6, action: 'fix', raised: 'repeat of s1/r2/opus-F1: impact major -> critical' })
    expect(last.decision!.held).toBeUndefined()
  })
})

describe('what a reviewer is told to leave out', () => {
  it('ends an agent reviewer prompt with the not-findings sentence, after the severity tiers', () => {
    const text = agentReviewPrompt(P, 'core', 'abc')
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe('These are not findings, also when a rule or the plan asks for them, so leave them out: code comments and doc comments (wrong, outdated, missing, too long, or there against a rule; TODO notes and commented-out code too), commit messages and the commit history, the pull request description or its PR-BODY file, and how the work was done (the order tests and code were written in). A doc file such as the README is not a comment: review it like code.')
    expect(lines.at(-2)).toBe('- P3: naming, style, leftovers.')
    expect(text.indexOf('Do a thorough code review')).toBeLessThan(text.indexOf('These are not findings'))
    expect(text).not.toContain('Earlier review rounds')
  })

  it('lists the known findings last, one per line, a declined one with its reason', () => {
    const known = [knownOf(f0('x', { title: 'Doc line is\n too long', file: 'src/m.rs', line: 19 })), knownOf(f0('y', { title: 'Null check', line: undefined }), 'parse() checks it\nfirst')]
    expect(agentReviewPrompt(P, 'core', 'abc', undefined, undefined, known).split('\n').slice(-3)).toEqual([
      'Earlier review rounds raised the 2 finding(s) below, and they were left as they are on purpose. Do not report them again; report one the fixer declined only when its reason is wrong:',
      '- src/m.rs:19 - Doc line is too long',
      '- src/a.ts - Null check (the fixer declined it: parse() checks it first)',
    ])
    const command = commandReviewPrompt(P, 'core', 'abc', undefined, undefined, false, known)
    expect(command).not.toContain('\n')
    expect(command).toContain('7. Small things last: a name that breaks the convention of its file or schema, leftovers (debug output), a constant')
    expect(command).toContain('review it like code. Earlier review rounds raised the 2 finding(s) below')
    expect(command).toContain('reason is wrong: src/m.rs:19 - Doc line is too long; src/a.ts - Null check (the fixer declined it: parse() checks it first). Report each finding as one bullet line')
  })

  it('cuts each part at 160 characters and leaves out a line that is not a whole number', () => {
    const long = 'x'.repeat(200)
    const lines = agentReviewPrompt(P, 'core', 'abc', undefined, undefined, [
      knownOf(f0('a', { file: long, title: long }), long),
      knownOf(f0('b', { line: null as unknown as number })),
      knownOf(f0('c', { line: 2.5 })),
      knownOf(f0('d', { line: '7' as unknown as number })),
    ]).split('\n')
    const cut = 'x'.repeat(160)
    expect(lines.slice(-4)).toEqual([`- ${cut}:3 - ${cut} (the fixer declined it: ${cut})`, '- src/a.ts - t', '- src/a.ts - t', '- src/a.ts - t'])
  })

  it('lists the last 40 of more, and says how many there are', () => {
    const many = Array.from({ length: 45 }, (_, i) => knownOf(f0(`k${i}`, { title: `t${i}` })))
    const lines = agentReviewPrompt(P, 'core', 'abc', undefined, undefined, many).split('\n')
    expect(lines.filter(l => l.startsWith('- src/a.ts:3 - t')).length).toBe(40)
    expect(lines).toContain('Earlier review rounds raised the 45 finding(s) below, and they were left as they are on purpose (the last 40 are listed). Do not report them again:')
    expect(lines.at(-1)).toBe('- src/a.ts:3 - t44')
  })

  it('keeps a decline and its clause in the list when more than 40 findings were left', async () => {
    const minors = Array.from({ length: 41 }, (_, i): [string, string, string, number] => ['P3', `Nit ${i}`, 'src/n.ts', i + 1])
    const f = fakeHost({
      scores: [Object.fromEntries([['opus-F1', judged('major', 'edge', 'small')], ...minors.map((_, i) => [`opus-F${i + 2}`, judged('minor', 'common', 'trivial')])])],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Phantom crash', 'src/a.ts', 3], ...minors)
        if (req.label === 'fix core r1') return { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'g', commits: [], untested: '', declined: [{ id: 'opus-F1', reason: 'parse() checks it first' }] }
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const lines = prompt(f.calls, 'review core r2 opus').split('\n')
    expect(lines).toContain('Earlier review rounds raised the 42 finding(s) below, and they were left as they are on purpose (the last 40 are listed). Do not report them again; report one the fixer declined only when its reason is wrong:')
    expect(lines.at(-1)).toBe('- src/a.ts:3 - Phantom crash (the fixer declined it: parse() checks it first)')
  })

  it('counts a decline as known until a later round sends its repeat back or keeps it as residual', () => {
    const earlier: EarlierRound[] = [{ round: 1, sent: [f0('codex-F1', { title: 'Phantom' })], declined: [{ id: 'codex-F1', reason: 'no' }] }]
    expect(declinedKnown(earlier)).toEqual([{ file: 'src/a.ts', line: 3, title: 'Phantom', declined: 'no' }])
    expect(declinedKnown([...earlier, { round: 2, sent: [f0('codex-F4', { repeatOf: 'r1/codex-F1' })] }])).toEqual([])
    expect(declinedKnown([...earlier, { round: 2, sent: [f0('codex-F4')], residual: [f0('codex-F5', { repeatOf: 'r1/codex-F1' })] }])).toEqual([])
    expect(declinedKnown([...earlier, { round: 2, sent: [f0('codex-F4')], repeats: ['r1/codex-F1'] }])).toEqual([])
    expect(declinedKnown([{ round: 1, sent: [f0('codex-F1')], declined: [{ id: 'codex-F1', reason: '' }] }])[0]!.declined).toBe('no reason given')
  })

  it("reads a stage's own repeat labels as that stage's when the final review looks at its declines", () => {
    const loop = { id: 's1', name: 'Stage 1 (one)' }
    const staged: EarlierRound = { round: 1, sent: [f0('codex-F1', { title: 'Phantom' })], declined: [{ id: 'codex-F1', reason: 'no' }], loop }
    expect(declinedKnown([staged])).toEqual([{ file: 'src/a.ts', line: 3, title: 'Phantom', declined: 'no' }])
    expect(declinedKnown([staged, { round: 2, sent: [f0('codex-F4', { repeatOf: 'r1/codex-F1' })], loop }])).toEqual([])
    expect(declinedKnown([staged, { round: 1, sent: [f0('opus-F2', { repeatOf: 's1/r1/codex-F1' })] }])).toEqual([])
    const own: EarlierRound = { round: 1, sent: [f0('codex-F1', { title: 'Late save' })], declined: [{ id: 'codex-F1', reason: 'by design' }] }
    expect(declinedKnown([{ round: 2, sent: [f0('codex-F4', { repeatOf: 'r1/codex-F1' })], loop }, own])).toEqual([{ file: 'src/a.ts', line: 3, title: 'Late save', declined: 'by design' }])
  })

  const INTRO = 'Earlier review rounds raised the 1 finding(s) below, and they were left as they are on purpose. Do not report them again:'

  it('gives round 2 the residual of round 1, and round 1 no list', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') }],
      override: req => (req.label === 'review core r1 opus' ? found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19]) : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(prompt(f.calls, 'review core r1 opus')).not.toContain('Earlier review rounds')
    expect(prompt(f.calls, 'review core r2 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Long doc line'])
  })

  it('gives a command reviewer a declined finding with the reason of the fixer', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Phantom crash')), 'No findings.'],
      scores: [{ 'cli-F1': judged('major', 'edge', 'small') }],
      override: req => (req.label === 'fix core r1' ? { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'g', commits: [], untested: '', declined: [{ id: 'cli-F1', reason: 'parse() checks it first' }] } : undefined),
    })
    const r = await runGranny(f.host, { repo: '/work/repo', branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'Do WP-01.' }], config: { reviewers: [{ name: 'cli', engine: 'command', command: 'fake-llm {prompt}' }] } })
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(f.commands.find(c => c.includes('review-core-r1-cli'))).not.toContain('Earlier review rounds')
    expect(f.commands.find(c => c.includes('review-core-r2-cli'))).toContain('Do not report them again; report one the fixer declined only when its reason is wrong: src/a.ts:3 - Phantom crash (the fixer declined it: parse() checks it first). Report each finding')
  })

  it("gives the final review the stages' residual findings, without the other-stage ones", async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'common', 'trivial'), 'opus-F2': judged('major', 'edge', 'small', { scope: 'other-stage' }), 'opus-F3': judged('moderate', 'edge', 'small', { scope: 'not-code' }) }],
      override: req => (req.label === 'review one r1 opus' ? found(['P3', 'Long doc line', 'src/m.rs', 19], ['P2', 'Route missing', 'src/r.ts', 2], ['P3', 'Tests not red first', 'test/a.test.ts', 1]) : undefined),
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]!.residual.map(x => x.decision!.rule)).toEqual([8, 4, 11])
    expect(prompt(f.calls, 'review two r1 opus')).not.toContain('Earlier review rounds')
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-3)).toEqual([
      'Earlier review rounds raised the 2 finding(s) below, and they were left as they are on purpose. Do not report them again:',
      '- src/m.rs:19 - Long doc line',
      '- test/a.test.ts:1 - Tests not red first',
    ])
  })

  const declining = (label: string) => (req: AgentRequest) =>
    req.label === label ? { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'g', commits: [], untested: '', declined: [{ id: 'opus-F1', reason: 'parse() checks it first' }] } : undefined

  it('gives the final review a decline of a stage fixer that stood, with its reason', async () => {
    const decline = declining('fix one r1')
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small') }],
      override: req => decline(req) ?? (req.label === 'review one r1 opus' ? found(['P2', 'Phantom crash', 'src/a.ts', 3]) : undefined),
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(prompt(f.calls, 'review one r2 opus').split('\n').at(-1)).toBe('- src/a.ts:3 - Phantom crash (the fixer declined it: parse() checks it first)')
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').at(-1)).toBe('- src/a.ts:3 - Phantom crash (the fixer declined it: parse() checks it first)')
  })

  it('does not give the final review a stage decline that the judge overruled and the fixer then fixed', async () => {
    const decline = declining('fix one r1')
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small') }, { 'opus-F1': judged('major', 'edge', 'small', { repeatOf: 'r1/opus-F1' }) }],
      override: req => decline(req) ?? (req.label === 'review one r1 opus' || req.label === 'review one r2 opus' ? found(['P2', 'Phantom crash', 'src/a.ts', 3]) : undefined),
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.calls.some(c => c.label === 'fix one r2')).toBe(true)
    expect(prompt(f.calls, 'review one r3 opus')).not.toContain('the fixer declined it')
    expect(prompt(f.calls, 'review final review r1 opus')).not.toContain('Earlier review rounds')
  })

  it('gives the final review the residual-decided findings a stage left unresolved at the round cap, not the sent ones', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') }],
      override: req => (req.label === 'review one r1 opus' ? found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19]) : undefined),
    })
    const r = await runGranny(f.host, input({ ...TWO_STAGES, config: { parallel: false, maxRounds: 1 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', residual: [] })
    expect(r.stages[0]!.unresolved.map(x => [x.id, x.decision?.action])).toEqual([['opus-F1', 'fix'], ['opus-F2', 'residual']])
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Long doc line'])
  })

  it("gives each repo's final review only the residual findings and declines of its own stages", async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'common', 'trivial') }, { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') }],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review bee one r1 opus') return found(['P2', 'Phantom crash', 'src/b.ts', 3], ['P3', 'Odd name', 'src/n.ts', 5])
        if (req.label === 'fix bee one r1') return { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'g', commits: [], untested: '', declined: [{ id: 'opus-F1', reason: 'parse() checks it first' }] }
        return undefined
      },
    })
    const B = '/work/b'
    const stages = [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }, { name: 'bee one', task: 'WP-03', repo: B }, { name: 'bee two', task: 'WP-04', repo: B }]
    const r = await runGranny(f.host, input({ repos: [B], stages, config: { parallel: false } }))
    expect(r.stages.map(x => x.outcome)).toEqual(['residual-only', 'clean', 'clean', 'clean'])
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Long doc line'])
    expect(prompt(f.calls, 'review final review b r1 opus').split('\n').slice(-3)).toEqual([
      'Earlier review rounds raised the 2 finding(s) below, and they were left as they are on purpose. Do not report them again; report one the fixer declined only when its reason is wrong:',
      '- src/n.ts:5 - Odd name',
      '- src/b.ts:3 - Phantom crash (the fixer declined it: parse() checks it first)',
    ])
  })

  it('takes a stage residual off the final review list once a final round sends its repeat back', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'common', 'trivial') }, { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 's1/r1/opus-F1' }) }],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Long doc line breaks the parser', 'src/m.rs', 19])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.finalReview).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Long doc line'])
    expect(prompt(f.calls, 'review final review r2 opus')).not.toContain('Earlier review rounds')
  })

  it('keeps one residual when a later final round repeats a stage residual by the stage label after an earlier final round kept a finding merged with its repeat', async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('minor', 'common', 'trivial') },
        {
          'opus-F1': judged('minor', 'common', 'trivial'),
          'opus-F2': judged('minor', 'common', 'trivial', { repeatOf: 's1/r1/opus-F1', scope: 'pre-existing', duplicateOf: 'opus-F1' }),
          'opus-F3': judged('major', 'edge', 'small'),
        },
        { 'opus-F1': judged('minor', 'common', 'trivial', { repeatOf: 's1/r1/opus-F1' }) },
      ],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label === 'review final review r1 opus') return found(['P3', 'Doc line too wide', 'src/m.rs', 19], ['P3', 'Long doc line again', 'src/m.rs', 19], ['P2', 'Late save', 'src/a.ts', 3])
        if (req.label === 'review final review r2 opus') return found(['P3', 'Long doc line once more', 'src/m.rs', 19])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.finalReview).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(prompt(f.calls, 'review final review r2 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Doc line too wide'])
    expect(r.finalReview!.residual.map(x => x.title)).toEqual(['Long doc line once more'])
  })

  it('takes a stage residual off the final review list once a final round sends back a repeat that names an older finding of its chain', async () => {
    const decline = declining('fix one r1')
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('none', 'rare', 'trivial', { verdict: 'refuted', evidence: 'src/p.ts:7 - parse() checks it first', repeatOf: 'r1/opus-F1' }) },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 's1/r1/opus-F1' }) },
      ],
      override: req => {
        const declined = decline(req)
        if (declined) return declined
        if (req.label === 'review one r1 opus') return found(['P2', 'Phantom crash', 'src/a.ts', 3])
        if (req.label === 'review one r2 opus') return found(['P3', 'Phantom crash again', 'src/a.ts', 3])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Phantom crash loses data', 'src/a.ts', 3])
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/a.ts:3 - Phantom crash again'])
    expect(f.calls.some(c => c.label === 'fix final review r1')).toBe(true)
    expect(prompt(f.calls, 'review final review r2 opus')).not.toContain('Earlier review rounds')
  })

  it('takes a kept repeat off the list once a later round of the same loop sends back a repeat that names an older finding of its chain', async () => {
    const decline = declining('fix core r1')
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('none', 'rare', 'trivial', { verdict: 'refuted', evidence: 'src/p.ts:7 - parse() checks it first', repeatOf: 'r1/opus-F1' }), 'opus-F2': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('critical', 'edge', 'small', { repeatOf: 'r1/opus-F1' }) },
      ],
      override: req => {
        const declined = decline(req)
        if (declined) return declined
        if (req.label === 'review core r1 opus') return found(['P2', 'Phantom crash', 'src/a.ts', 3])
        if (req.label === 'review core r2 opus') return found(['P3', 'Phantom crash again', 'src/a.ts', 3], ['P2', 'Late save', 'src/b.ts', 7])
        if (req.label === 'review core r3 opus') return found(['P2', 'Phantom crash loses data', 'src/a.ts', 3])
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 4 })
    expect(prompt(f.calls, 'review core r3 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/a.ts:3 - Phantom crash again'])
    expect(prompt(f.calls, 'review core r4 opus')).not.toContain('Earlier review rounds')
  })

  it("gives the final review the residual of a stage whose review failed in a later round", async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('minor', 'common', 'trivial') }],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3], ['P3', 'Long doc line', 'src/m.rs', 19])
        if (req.label.startsWith('review one r2 opus')) return null
        return undefined
      },
    })
    const r = await runGranny(f.host, input(TWO_STAGES))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 2, residual: [] })
    expect(prompt(f.calls, 'review final review r1 opus').split('\n').slice(-2)).toEqual([INTRO, '- src/m.rs:19 - Long doc line'])
  })

  it('keeps a residual that repeats the same earlier finding as another residual when a later round repeats only the other', async () => {
    const old = { scope: 'pre-existing', repeatOf: 'r1/opus-F1' }
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('major', 'edge', 'small', old), 'opus-F2': judged('major', 'edge', 'small', old), 'opus-F3': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('major', 'edge', 'small', { scope: 'pre-existing', repeatOf: 'r2/opus-F1' }) },
      ],
      override: req => {
        if (req.label === 'review core r1 opus') return found(['P2', 'Late save', 'src/a.ts', 3])
        if (req.label === 'review core r2 opus') return found(['P2', 'Old A', 'src/b.ts', 9], ['P2', 'Old B', 'src/b.ts', 9], ['P2', 'Lost write', 'src/c.ts', 4])
        if (req.label === 'review core r3 opus') return found(['P2', 'Old A again', 'src/b.ts', 9])
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 3 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Old B', 'Old A again'])
  })

  it('drops a decline from the list once a later round sends back a repeat that names an older finding of its chain', () => {
    const earlier: EarlierRound[] = [
      { round: 1, sent: [f0('opus-F1', { title: 'Phantom' })], declined: [{ id: 'opus-F1', reason: 'no' }] },
      { round: 2, sent: [f0('opus-F4', { title: 'Phantom again', repeatOf: 'r1/opus-F1' })], declined: [{ id: 'opus-F4', reason: 'still no' }] },
    ]
    expect(declinedKnown(earlier)).toEqual([{ file: 'src/a.ts', line: 3, title: 'Phantom again', declined: 'still no' }])
    expect(declinedKnown([...earlier, { round: 3, sent: [f0('opus-F1', { repeatOf: 'r1/opus-F1' })] }])).toEqual([])
    const sibling: EarlierRound = { round: 2, sent: [f0('opus-F5', { title: 'Phantom elsewhere', repeatOf: 'r1/opus-F1' })], declined: [{ id: 'opus-F5', reason: 'by design' }] }
    expect(declinedKnown([earlier[0]!, { ...earlier[1]!, sent: [...earlier[1]!.sent, ...sibling.sent], declined: [...earlier[1]!.declined!, ...sibling.declined!] }, { round: 3, sent: [f0('opus-F1', { repeatOf: 'r2/opus-F4' })] }])).toEqual([
      { file: 'src/a.ts', line: 3, title: 'Phantom elsewhere', declined: 'by design' },
    ])
  })

  it('counts a repeat of a declined finding that the judge merged into another finding as a repeat', async () => {
    const decline = declining('fix core r1')
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'small') },
        { 'opus-F1': judged('major', 'edge', 'small'), 'opus-F2': judged('major', 'edge', 'small', { repeatOf: 'r1/opus-F1', duplicateOf: 'opus-F1' }) },
      ],
      override: req => {
        const declined = decline(req)
        if (declined) return declined
        if (req.label === 'review core r1 opus') return found(['P2', 'Phantom crash', 'src/a.ts', 3])
        if (req.label === 'review core r2 opus') return found(['P2', 'Crash on empty input', 'src/a.ts', 3], ['P2', 'Phantom crash', 'src/a.ts', 3])
        return undefined
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(r.stages[0]!.history[1]!.findings.map(x => [x.id, x.duplicates, x.decision?.action])).toEqual([['opus-F1', ['opus-F2'], 'fix']])
    expect(prompt(f.calls, 'review core r2 opus')).toContain('the fixer declined it')
    expect(prompt(f.calls, 'review core r3 opus')).not.toContain('Earlier review rounds')
  })
})
