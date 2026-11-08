import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { trailDir, trailId, trailPath, trailRound, trailText } from '../src/core/trail'
import type { Finding } from '../src/core/types'

const judged = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  reviewer: 'codex',
  severity: 'P2',
  file: 'src/a.ts',
  line: 3,
  title: `${id} title`,
  detail: `${id} detail`,
  verdict: 'confirmed',
  impact: 'moderate',
  likelihood: 'common',
  fixCost: 'trivial',
  scope: 'in-scope',
  evidence: 'src/a.ts:3 - x',
  priority: 90,
  reason: `reason ${id}`,
  decision: { rule: 7, action: 'fix', why: 'priority 90 > threshold 70' },
  ...over,
})

describe('trailPath', () => {
  it('puts one file per loop and round under the work dir of the checkout', () => {
    const config = resolveConfig([])
    expect(trailDir(config, '/w/repo/')).toBe('/w/repo/.granny/trail')
    expect(trailPath(config, '/w/repo', 's1', 2)).toBe('/w/repo/.granny/trail/s1-r2.json')
    expect(trailPath(resolveConfig([{ workDir: 'tmp/g/' }]), '/w/repo', 'final', 1)).toBe('/w/repo/tmp/g/trail/final-r1.json')
    expect(trailId('plan', 3)).toBe('plan-r3')
  })
})

describe('trailRound', () => {
  const base = { loop: 's1', name: 'engine', round: 1, base: 'abc123', reviewers: [{ name: 'codex', engine: 'auto' }] }

  it('routes each finding, marks blockers and overruled repeats, and records the fix', () => {
    const sent = judged('codex-F1', { repeatOf: 's1/r1/codex-F9' })
    const kept = judged('codex-F2', { priority: 40, decision: { rule: 8, action: 'residual', why: 'under the bar', attention: true } })
    const blocker: Finding = { id: 'codex-F3', reviewer: 'codex', severity: 'P1', file: 'src/b.ts', line: 7, title: 't', detail: 'd', decision: { rule: 1, action: 'fix', why: 'P0/P1' }, duplicates: ['codex-F4'] }
    const record = trailRound({
      ...base,
      reviewedSha: 'r1sha',
      findings: [sent, kept, blocker],
      sent: [sent, blocker],
      blockers: new Set(['codex-F3']),
      overruled: [{ id: 'codex-F1', said: 'it cannot happen' }],
      fix: { label: 'fix engine r1', work: { startSha: 'aaa', headSha: 'bbb', commits: ['fix: one', 'fix: two'] }, refused: [{ id: 'codex-F3', reason: 'not real' }], said: 'kept the API' },
    })
    expect(record).toEqual({
      version: 1,
      loop: 's1',
      name: 'engine',
      round: 1,
      base: 'abc123',
      reviewedSha: 'r1sha',
      reviewers: [{ name: 'codex', engine: 'auto' }],
      findings: [
        { ...sent, route: 'sent', overruled: 'it cannot happen' },
        { ...kept, route: 'residual' },
        { ...blocker, route: 'sent', blocker: true },
      ],
      fix: { label: 'fix engine r1', startSha: 'aaa', headSha: 'bbb', commits: ['fix: one', 'fix: two'], declined: [{ id: 'codex-F3', reason: 'not real' }], deviations: 'kept the API' },
    })
  })

  it('keeps only the finding fields, and leaves the route unset for a round that was never routed', () => {
    const raw = { ...judged('codex-F1'), extra: 'from the reviewer' } as Finding
    const record = trailRound({ ...base, findings: [raw], outcome: 'review-failed', note: 'codex did not run' })
    expect(record.findings).toEqual([judged('codex-F1')])
    expect(record.findings[0]!.route).toBeUndefined()
    expect(record).toMatchObject({ outcome: 'review-failed', note: 'codex did not run' })
    expect('fix' in record).toBe(false)
    expect('reviewedSha' in record).toBe(false)
  })

  it('records a fix without commits, as a plan fix has none', () => {
    const f = judged('codex-F1')
    const record = trailRound({ ...base, loop: 'plan', name: 'plan review', findings: [f], sent: [f], fix: { label: 'fix plan review r1' }, outcome: 'round-cap' })
    expect(record.fix).toEqual({ label: 'fix plan review r1' })
    expect(record.outcome).toBe('round-cap')
  })

  it('serializes to indented JSON that ends in a newline', () => {
    const record = trailRound({ ...base, findings: [], outcome: 'clean' })
    const text = trailText(record)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(record)
    expect(text).toContain('\n  "loop": "s1",\n')
  })
})
