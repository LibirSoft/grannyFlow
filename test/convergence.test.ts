import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost, finding, review } from './fake-host'

const input = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
})

const DECLINE = 'codex-F1 not applied: the null check already happens in parse() at src/a.ts:1, so the reported crash cannot occur.'

const declineIn = (label: string) => (req: AgentRequest) =>
  req.label === label ? { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', deviations: DECLINE } : undefined

const prompt = (calls: AgentRequest[], label: string) => calls.find(c => c.label === label)?.prompt

describe('a finding the fixer declined', () => {
  it('shows the judge the earlier round and its deviations, and ends residual-only when the judge agrees with the fixer', async () => {
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
    expect(r1).not.toContain('EARLIER ROUNDS')
    const r2 = prompt(f.calls, 'judge core r2')!
    expect(r2).toContain('EARLIER ROUNDS')
    expect(r2).toContain('r1/codex-F1')
    expect(r2).toContain(DECLINE)
    expect(r2).toContain('repeatOf')
    expect(f.logs).toContain('core r2: codex-F1 dropped as a repeat of r1/codex-F1, which the fixer declined (score 20) - kept as residual')
    expect(r.stages[0]!.history[0]!.deviations).toBe(DECLINE)
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
    const none = (req: AgentRequest) =>
      req.label === 'fix core r1' ? { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', deviations: 'None.' } : undefined
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue')), review(finding('P1', 'Blocker')), 'No findings.'], scores: [{ 'codex-F1': 90 }], override: none })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'judge core r1', 'fix core r1', 'fix core r2', 'pr-ready check'])
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
    const r2 = prompt(f.calls, 'fix core r2')!
    expect(r2).toContain('OVERRULED')
    expect(r2).toContain(DECLINE)
    expect(r2).toContain('codex-F1 (repeat of r1/codex-F1): reason codex-F1')
    expect(f.logs).toContain('core r2: the judge overruled the fixer on codex-F1 (repeat of r1/codex-F1, score 85)')
  })

  it('does the same in a plan review', async () => {
    const PLAN = '/plans/v1.md'
    const bad = review(finding('P2', 'Missing migration step', PLAN))
    const f = fakeHost({
      reviews: [bad, bad, bad],
      scores: [{ 'codex-F1': 90 }, { 'codex-F1': { score: 30, repeatOf: 'r1/codex-F1' } }],
      override: req => (req.label === 'fix plan review r1' ? { files: [PLAN], changes: 'none', deviations: DECLINE } : undefined),
    })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, maxRounds: 3 } }))
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    const r2 = prompt(f.calls, 'judge plan review r2')!
    expect(r2).toContain('EARLIER ROUNDS')
    expect(r2).toContain(DECLINE)
    expect(r.stages[0]).toMatchObject({ stage: 'core' })
  })
})
