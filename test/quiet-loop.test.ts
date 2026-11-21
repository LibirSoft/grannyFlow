import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import { isPrBody } from '../src/core/review'
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
    for (const file of ['.granny/PR-BODY.md', './.granny/PR-BODY.md', '/w/repo/.granny/PR-BODY.md', '.granny/PR-BODY.md:13', '.granny/PR-BODY.md:13-20', '.granny/pr-body.md', '/w/main/.granny/PR-BODY-s2-api.md', ' .granny/PR-BODY.md ', '.granny\\PR-BODY.md']) {
      expect([file, isPrBody(file, '.granny')]).toEqual([file, true])
    }
    expect(isPrBody('tmp/granny work/PR-BODY.md', './tmp/granny work/')).toBe(true)
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

  it('keeps the set-aside findings in the trail record, which the poster still accepts', () => {
    const aside = f0('opus-F1', { file: '.granny/PR-BODY.md' })
    const record = trailRound({ loop: 's1', name: 'core', round: 1, base: 'main', reviewers: [{ name: 'opus', engine: 'agent' }], findings: [], setAside: [aside], outcome: 'clean' })
    expect(record.setAside).toEqual([aside])
    expect(trailProblem(JSON.parse(JSON.stringify(record)))).toBeUndefined()
    expect(trailRound({ loop: 's1', name: 'core', round: 1, base: 'main', reviewers: [], findings: [] })).not.toHaveProperty('setAside')
  })
})
