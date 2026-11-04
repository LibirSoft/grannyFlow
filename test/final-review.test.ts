import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost } from './fake-host'

const A = '/work/a'
const B = '/work/b'
const MAIN = '/work/a-worktrees/feat-x'
const lanePath = (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd
const agentReviewer = { reviewers: [{ name: 'opus', engine: 'agent' }] }

const parallelRun = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: A,
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [] }],
  config: agentReviewer,
  ...extra,
})

const slowOne = (more?: (req: AgentRequest) => unknown) => async (req: AgentRequest) => {
  if (req.label === 'implement one') return new Promise(r => setTimeout(() => r(undefined), 15))
  return more?.(req)
}

const labels = (calls: AgentRequest[]) => calls.map(c => c.label)

describe('final review', () => {
  it('reviews the whole branch after a parallel run with a lane merge, before the pr-ready check', async () => {
    const f = fakeHost({ worktree: lanePath, override: slowOne() })
    const r = await runGranny(f.host, parallelRun())
    const all = labels(f.calls)
    const review = f.calls.find(c => c.label === 'review final review r1 opus')!
    expect(review).toBeDefined()
    expect(review.cwd).toBe(MAIN)
    expect(review.phase).toBe('Final review')
    expect(review.prompt).toContain('git diff main...HEAD')
    expect(review.prompt).toContain('whole-branch review')
    expect(review.prompt).toContain('merge commits')
    expect(f.commands.some(c => c.startsWith('git merge --no-edit feat/x--s2-two'))).toBe(true)
    expect(all.indexOf('review final review r1 opus')).toBeLessThan(all.indexOf('pr-ready check'))
    expect(f.phases).toContain('Final review')
    expect(f.phases.indexOf('Final review')).toBeLessThan(f.phases.indexOf('PR ready'))
    expect(r.finalReview?.outcome).toBe('clean')
    expect(r.final).not.toBeNull()
  })

  it('sends accepted final-review findings to the implementer on the main branch before the final check', async () => {
    let reviews = 0
    const f = fakeHost({
      worktree: lanePath,
      scores: [{ 'opus-F1': 90 }],
      override: slowOne(req => {
        if (req.label.startsWith('review final review') && reviews++ === 0) {
          return { findings: [{ id: 'F1', severity: 'P2', file: 'src/a.ts', line: 3, title: 'duplicated helper across stages', detail: 'd' }] }
        }
        return undefined
      }),
    })
    const r = await runGranny(f.host, parallelRun())
    const all = labels(f.calls)
    const fix = f.calls.find(c => c.label === 'fix final review r1')!
    expect(fix.kind).toBe('implementation')
    expect(fix.cwd).toBe(MAIN)
    expect(fix.prompt).toContain('branch `feat/x`')
    expect(all.indexOf('fix final review r1')).toBeLessThan(all.indexOf('pr-ready check'))
    const judge = f.calls.find(c => c.label === 'judge final review r1')!
    expect(judge.prompt).toContain('whole-branch review')
    expect(r.finalReview?.outcome).toBe('clean')
    expect(r.finalReview?.rounds).toBe(2)
  })

  it('still runs the final check when the final review hits the round cap, and reports it', async () => {
    const f = fakeHost({
      worktree: lanePath,
      override: slowOne(req =>
        req.label.startsWith('review final review') ? { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'broken merge', detail: 'd' }] } : undefined,
      ),
    })
    const r = await runGranny(f.host, parallelRun({ config: { ...agentReviewer, maxRounds: 1 } }))
    expect(r.finalReview?.outcome).toBe('round-cap')
    expect(r.finalReview?.unresolved.map(x => x.title)).toEqual(['broken merge'])
    expect(r.final).not.toBeNull()
    expect(f.logs.some(l => l.includes('final review ended round-cap') && l.includes('the final check still runs'))).toBe(true)
  })

  it('reviews a repo whose stages ran one after another', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, parallelRun({ stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(f.calls.some(c => c.label === 'review final review r1 opus')).toBe(true)
    expect(r.finalReview?.outcome).toBe('clean')
  })

  it('is skipped for a repo with a single stage and no lane merge', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, parallelRun({ stages: [{ name: 'one', task: 'WP-01' }] }))
    expect(f.calls.some(c => c.label.includes('final review'))).toBe(false)
    expect(r.finalReview?.outcome).toBe('skipped')
    expect(r.finalReview?.note).toContain('one stage')
    expect(f.logs.some(l => l.startsWith('final review skipped') && l.includes('one stage'))).toBe(true)
  })

  it('is skipped with finalReview: false', async () => {
    const f = fakeHost({ worktree: lanePath, override: slowOne() })
    const r = await runGranny(f.host, parallelRun({ config: { ...agentReviewer, finalReview: false } }))
    expect(f.calls.some(c => c.label.includes('final review'))).toBe(false)
    expect(r.finalReview?.outcome).toBe('review-skipped')
    expect(f.logs).toContain('final review off (finalReview: false)')
  })

  it('does not run when a stage failed', async () => {
    const f = fakeHost({ worktree: lanePath, override: async req => (req.label === 'implement two' ? null : undefined) })
    await expect(runGranny(f.host, parallelRun())).rejects.toThrow('implement two: implementer returned nothing')
    expect(f.calls.some(c => c.label.includes('final review'))).toBe(false)
    expect(f.phases).not.toContain('Final review')
  })

  it('reviews each repo that had stages, labelled per repo, and leaves a stage-less primary alone', async () => {
    const f = fakeHost({ worktree: lanePath })
    const r = await runGranny(f.host, {
      repo: A,
      branch: 'feat/x',
      base: 'main',
      repos: [B],
      stages: [{ name: 'bee one', task: 'x', repo: B }, { name: 'bee two', task: 'y', repo: B }],
      config: agentReviewer,
    })
    const review = f.calls.find(c => c.label === 'review final review b r1 opus')!
    expect(review.cwd).toBe('/work/b-worktrees/feat-x')
    expect(f.calls.some(c => c.label === 'review final review r1 opus')).toBe(false)
    expect(r.finalReview).toBeUndefined()
    expect(r.repos?.map(x => [x.repo, x.finalReview?.outcome])).toEqual([
      [A, undefined],
      [B, 'clean'],
    ])
  })
})

describe('the decision ledger across review loops', () => {
  const sequential = (extra: Partial<RunInput> = {}) => parallelRun({ stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }], ...extra })
  const found = (...items: Array<[string, string, string, number]>) => ({
    findings: items.map(([severity, title, file, line], n) => ({ id: `F${n + 1}`, severity, file, line, title, detail: 'd' })),
  })
  const judged = (impact: string, likelihood: string, evidence: string, extra: Record<string, unknown> = {}) => ({
    verdict: 'confirmed',
    impact,
    likelihood,
    fixCost: 'small',
    scope: 'in-scope',
    evidence,
    ...extra,
  })

  it("shows the final review's judge a stage's fixed and residual decisions as EARLIER DECISIONS, and ratchets a repeat of one", async () => {
    const f = fakeHost({
      scores: [
        { 'opus-F1': judged('major', 'edge', 'src/Editor.tsx:225 - save, go back, save again'), 'opus-F2': judged('minor', 'edge', 'src/format.ts:21 - exactly 30 days', { fixCost: 'trivial' }) },
        { 'opus-F1': judged('moderate', 'rare', 'src/Editor.tsx:225 - only when the response is late', { repeatOf: 's1/r1/opus-F1' }) },
      ],
      override: req => {
        if (req.label === 'review one r1 opus') return found(['P2', 'Late save re-binds the editor', 'src/Editor.tsx', 225], ['P3', 'Countdown says 0 months', 'src/format.ts', 21])
        if (req.label === 'review final review r1 opus') return found(['P2', 'Late save still re-binds', 'src/Editor.tsx', 225])
        return undefined
      },
    })
    const r = await runGranny(f.host, sequential())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const judge = f.calls.find(c => c.label === 'judge final review r1')!.prompt
    expect(judge).toContain('EARLIER DECISIONS')
    expect(judge).toContain('Stage 1 (one), round 1')
    expect(judge).toContain('"label":"s1/r1/opus-F1"')
    expect(judge).toContain('"label":"s1/r1/opus-F2"')
    expect(judge).toContain('"decision":"residual - rule 8: under the bar: minor/edge/trivial -> 40"')
    expect(r.finalReview?.history[0]!.findings[0]).toMatchObject({
      repeatOf: 's1/r1/opus-F1',
      impact: 'major',
      likelihood: 'edge',
      priority: 80,
      decision: { rule: 6, action: 'fix', raised: 'repeat of s1/r1/opus-F1: impact moderate -> major, likelihood rare -> edge' },
    })
    expect(f.logs).toContain('final review r1: the ratchet raised opus-F1 - repeat of s1/r1/opus-F1: impact moderate -> major, likelihood rare -> edge')
    expect(f.calls.some(c => c.label === 'fix final review r1')).toBe(true)
  })

  it('lets the final review keep a repeat of a P1 a stage fixer declined residual, when the judge refutes it', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('critical', 'edge', 'src/a.ts:3 - the guard in parse() at src/a.ts:1 stops it', { verdict: 'refuted', repeatOf: 's1/r1/opus-F1' }) }],
      override: req => {
        if (req.label === 'review one r1 opus' || req.label === 'review final review r1 opus') return found(['P1', 'Phantom crash', 'src/a.ts', 3])
        if (req.label === 'fix one r1') {
          return { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', declined: [{ id: 'opus-F1', reason: 'parse() checks it at src/a.ts:1' }] }
        }
        return undefined
      },
    })
    const r = await runGranny(f.host, sequential())
    expect(f.calls.find(c => c.label === 'judge final review r1')!.prompt).toContain('- s1/r1/opus-F1: parse() checks it at src/a.ts:1')
    expect(r.finalReview).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.finalReview!.residual[0]).toMatchObject({ title: 'Phantom crash', repeatOf: 's1/r1/opus-F1', decision: { rule: 3, action: 'residual' } })
    expect(f.logs).toContain('final review r1: opus-F1 dropped as a repeat of s1/r1/opus-F1, which the fixer declined (rule 3: refuted) - kept as residual')
  })

  it('does not show one stage the decisions of another', async () => {
    const f = fakeHost({
      scores: [{ 'opus-F1': judged('minor', 'edge', 'src/format.ts:21 - x') }, { 'opus-F1': judged('minor', 'edge', 'src/format.ts:21 - x') }],
      override: req => (req.label === 'review one r1 opus' || req.label === 'review two r1 opus' ? found(['P3', 'Nit', 'src/format.ts', 21]) : undefined),
    })
    await runGranny(f.host, sequential())
    expect(f.calls.find(c => c.label === 'judge two r1')!.prompt).not.toContain('EARLIER DECISIONS')
  })
})
