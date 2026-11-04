import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost, finding, review, withCodex } from './fake-host'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
  })

const DECLINE = 'the null check already happens in parse() at src/a.ts:1, so the reported crash cannot occur.'

const fixed = (extra: object) => ({ startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', ...extra })

const declineIn = (label: string, ids = ['codex-F1']) => (req: AgentRequest) =>
  req.label === label ? fixed({ declined: ids.map(id => ({ id, reason: DECLINE })) }) : undefined

const prompt = (calls: AgentRequest[], label: string) => calls.find(c => c.label === label)?.prompt

describe('a finding the fixer declined', () => {
  it('drops a declined P1 the judge classifies refuted on the repeat, by rule 3, and ends residual-only', async () => {
    const phantom = review(finding('P1', 'Phantom blocker'))
    const confirmed = { verdict: 'confirmed', impact: 'critical', likelihood: 'edge', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - call it twice' }
    const f = fakeHost({
      reviews: [phantom, phantom, phantom],
      scores: [{ 'codex-F1': { ...confirmed, verdict: 'refuted', evidence: 'src/a.ts:3 - the guard on line 2 stops it', repeatOf: 'r1/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toEqual([expect.objectContaining({ title: 'Phantom blocker', verdict: 'refuted', repeatOf: 'r1/codex-F1', decision: { rule: 3, action: 'residual', why: 'refuted' } })])
    expect(f.logs).toContain('core r2: codex-F1 dropped as a repeat of r1/codex-F1, which the fixer declined (rule 3: refuted) - kept as residual')
  })

  it('overrules the fixer when the judge classifies the declined repeat critical', async () => {
    const phantom = review(finding('P2', 'Late save'))
    const f = fakeHost({
      reviews: [phantom, phantom, 'No findings.'],
      scores: [
        { 'codex-F1': 90 },
        { 'codex-F1': { verdict: 'confirmed', impact: 'critical', likelihood: 'rare', fixCost: 'large', scope: 'in-scope', evidence: 'src/a.ts:3 - late response', repeatOf: 'r1/codex-F1' } },
      ],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.logs).toContain('core r2: the judge overruled the fixer on codex-F1 (repeat of r1/codex-F1, rule 6: impact critical is in alwaysFix (critical/rare/large -> 75))')
  })

  it('shows the judge the earlier round and the findings the fixer declined, and ends residual-only when the judge agrees with the fixer', async () => {
    const phantom = review(finding('P2', 'Phantom crash'))
    const f = fakeHost({
      reviews: [phantom, phantom, phantom],
      scores: [{ 'codex-F1': 90 }, { 'codex-F1': { score: 20, repeatOf: 'r1/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toHaveLength(1)
    expect(r.stages[0]!.residual[0]).toMatchObject({ title: 'Phantom crash', score: 20, repeatOf: 'r1/codex-F1' })
    expect(f.calls.filter(c => c.label.startsWith('fix ')).map(c => c.label)).toEqual(['fix core r1'])

    const r1 = prompt(f.calls, 'judge core r1')!
    expect(r1).not.toContain('EARLIER DECISIONS')
    const r2 = prompt(f.calls, 'judge core r2')!
    expect(r2).toContain('EARLIER DECISIONS')
    expect(r2).toContain('r1/codex-F1')
    expect(r2).toContain(DECLINE)
    expect(r2).toContain('repeatOf')
    expect(f.logs).toContain('core r2: codex-F1 dropped as a repeat of r1/codex-F1, which the fixer declined (rule 8: under the bar: score 20 (numeric score, no classification)) - kept as residual')
    expect(r2).toContain(`- r1/codex-F1: ${DECLINE}`)
    expect(r.stages[0]!.history[0]!.declined).toEqual([{ id: 'codex-F1', reason: DECLINE }])
    expect(r.stages[0]!.history[0]!.deviations).toBeUndefined()
  })

  it('routes a repeated P0/P1 through the judge once the fixer declined, instead of looping to the round cap', async () => {
    const blocker = review(finding('P1', 'Phantom blocker'))
    const f = fakeHost({
      reviews: [blocker, blocker, blocker],
      scores: [{ 'codex-F1': { score: 15, repeatOf: 'r1/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Phantom blocker'])
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'fix core r1', 'judge core r2', 'pr-ready check'])
    const r2 = prompt(f.calls, 'judge core r2')!
    expect(r2).toContain('Phantom blocker')
    expect(r2).toContain(DECLINE)
    expect(f.logs.some(l => l.includes('codex-F1 dropped as a repeat of r1/codex-F1'))).toBe(true)
  })

  it('still sends a first-time P0/P1 the judge scored low, and one whose repeatOf names no earlier finding', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Phantom crash')), review(finding('P1', 'New blocker'), finding('P1', 'Other blocker', 'src/b.ts')), 'No findings.'],
      scores: [{ 'codex-F1': 90 }, { 'codex-F1': 10, 'codex-F2': { score: 10, repeatOf: 'r9/nope' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    const fix = prompt(f.calls, 'fix core r2')!
    expect(fix).toContain('New blocker')
    expect(fix).toContain('Other blocker')
    expect(r.stages[0]!.history[1]!.findings.every(x => x.repeatOf === undefined)).toBe(true)
  })

  it('keeps the P0/P1 bypass when no earlier fixer declined anything', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue')), review(finding('P1', 'Blocker')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'judge core r1', 'fix core r1', 'fix core r2', 'pr-ready check'])
  })

  it('does not count a "None." deviations text as declining', async () => {
    const none = (req: AgentRequest) => (req.label === 'fix core r1' ? fixed({ deviations: 'None.' }) : undefined)
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue')), review(finding('P1', 'Blocker')), 'No findings.'], scores: [{ 'codex-F1': 90 }], override: none })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'judge core r1', 'fix core r1', 'fix core r2', 'pr-ready check'])
  })

  it('does not take a deviations text for a decline: a repeated P0/P1 goes straight to the fixer again', async () => {
    const race = review(finding('P1', 'Race in save'))
    const f = fakeHost({
      reviews: [race, race, 'No findings.'],
      scores: [{ 'codex-F1': { score: 60, repeatOf: 'r1/codex-F1' } }],
      override: req => (req.label === 'fix core r1' ? fixed({ deviations: 'applied it via the helper' }) : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3, residual: [] })
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'fix core r1', 'fix core r2', 'pr-ready check'])
    expect(prompt(f.calls, 'fix core r2')).toContain('Race in save')
    expect(r.stages[0]!.history[0]!.deviations).toBe('applied it via the helper')
    expect(f.logs.some(l => l.includes('go to the judge too') || l.includes('dropped as a repeat'))).toBe(false)
  })

  it('drops only the repeat of the finding the fixer declined, not a repeat of one it fixed', async () => {
    const both = review(finding('P1', 'Phantom blocker'), finding('P1', 'Real blocker', 'src/b.ts'))
    const f = fakeHost({
      reviews: [both, both, 'No findings.'],
      scores: [{ 'codex-F1': { score: 15, repeatOf: 'r1/codex-F1' }, 'codex-F2': { score: 15, repeatOf: 'r1/codex-F2' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(r.stages[0]!.residual.map(x => [x.title, x.repeatOf])).toEqual([['Phantom blocker', 'r1/codex-F1']])
    const fix = prompt(f.calls, 'fix core r2')!
    expect(fix).toContain('Real blocker')
    expect(fix).not.toContain('Phantom blocker')
    expect(f.logs).toContain('core r2: codex-F1 dropped as a repeat of r1/codex-F1, which the fixer declined (rule 8: under the bar: score 15 (numeric score, no classification)) - kept as residual')
    expect(f.logs.some(l => l.includes('codex-F2 dropped'))).toBe(false)
  })

  it('sends a P0/P1 that repeats a residual repeat of a declined finding: only the declined finding itself can be dropped', async () => {
    const blocker = finding('P1', 'Phantom blocker')
    const f = fakeHost({
      reviews: [review(blocker), review(blocker, finding('P2', 'Other', 'src/b.ts')), review(blocker), 'No findings.'],
      scores: [{ 'codex-F1': { score: 15, repeatOf: 'r1/codex-F1' }, 'codex-F2': 90 }, { 'codex-F1': { score: 15, repeatOf: 'r2/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 4, residual: [] })
    expect(prompt(f.calls, 'fix core r2')).not.toContain('Phantom blocker')
    expect(prompt(f.calls, 'fix core r3')).toContain('Phantom blocker')
    expect(f.logs).toContain('core r2: codex-F1 dropped as a repeat of r1/codex-F1, which the fixer declined (rule 8: under the bar: score 15 (numeric score, no classification)) - kept as residual')
    expect(f.logs.some(l => l.startsWith('core r3: codex-F1 dropped'))).toBe(false)
  })

  it('ignores a declined id the fixer was not sent', async () => {
    const blocker = review(finding('P1', 'Phantom blocker'))
    const f = fakeHost({ reviews: [blocker, blocker, 'No findings.'], override: declineIn('fix core r1', ['codex-F9']) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'fix core r1', 'fix core r2', 'pr-ready check'])
    expect(f.logs).toContain('core r1: the fixer declined id(s) it was not sent - ignored: codex-F9')
    expect(r.stages[0]!.history[0]!.declined).toBeUndefined()
  })

  it('sends a repeated P0/P1 when the judge returns nothing', async () => {
    const blocker = review(finding('P1', 'Phantom blocker'))
    const f = fakeHost({ reviews: [blocker, blocker, 'No findings.'], scores: [null], override: declineIn('fix core r1') })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(prompt(f.calls, 'fix core r2')).toContain('Phantom blocker')
  })

  it('tells the fixer which of its deviations the judge overruled', async () => {
    const phantom = review(finding('P2', 'Phantom crash'))
    const f = fakeHost({
      reviews: [phantom, phantom, 'No findings.'],
      scores: [{ 'codex-F1': 90 }, { 'codex-F1': { score: 85, repeatOf: 'r1/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    const r1 = prompt(f.calls, 'fix core r1')!
    expect(r1).not.toContain('OVERRULED')
    expect(r1).toContain('list it in declined with its id and your reason')
    const r2 = prompt(f.calls, 'fix core r2')!
    expect(r2).toContain('OVERRULED')
    expect(r2).toContain(`  you said: ${DECLINE}`)
    expect(r2).toContain('codex-F1 (repeat of r1/codex-F1): reason codex-F1')
    expect(f.logs).toContain('core r2: the judge overruled the fixer on codex-F1 (repeat of r1/codex-F1, rule 7: score 85 > threshold 70 (numeric score, no classification))')
  })

  it('does not take a repeat of a residual finding for a repeat of a declined one', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Phantom crash'), finding('P3', 'Nit')), review(finding('P3', 'Nit'))],
      scores: [{ 'codex-F1': 90, 'codex-F2': 10 }, { 'codex-F1': { score: 10, repeatOf: 'r1/codex-F2' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual.map(x => [x.title, x.repeatOf])).toEqual([['Nit', 'r1/codex-F2']])
    expect(f.logs.some(l => l.includes('dropped as a repeat'))).toBe(false)
  })

  it('does the same in a plan review', async () => {
    const PLAN = '/plans/v1.md'
    const bad = review(finding('P2', 'Missing migration step', PLAN))
    const f = fakeHost({
      reviews: [bad, bad, bad],
      scores: [{ 'codex-F1': 90 }, { 'codex-F1': { score: 30, repeatOf: 'r1/codex-F1' } }],
      override: req => (req.label === 'fix plan review r1' ? { files: [PLAN], changes: 'none', declined: [{ id: 'codex-F1', reason: DECLINE }] } : undefined),
    })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, maxRounds: 3 } }))
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    const r2 = prompt(f.calls, 'judge plan review r2')!
    expect(r2).toContain('EARLIER DECISIONS')
    expect(r2).toContain(DECLINE)
    expect(r.stages[0]).toMatchObject({ stage: 'core' })
  })
})
