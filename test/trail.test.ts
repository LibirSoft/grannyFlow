import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { trailDir, trailId, trailPath, trailRound, trailText } from '../src/core/trail'
import type { Finding, TrailRound } from '../src/core/types'
import { fakeHost, finding, review, withCodex } from './fake-host'

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

const REPO = '/work/repo'
const DIR = `${REPO}/.granny/trail`
const DECLINE = 'parse() already checks it at src/a.ts:1'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({ repo: REPO, branch: 'feat/x', base: 'main', stages: [{ name: 'engine', task: 'Do WP-01.' }], ...extra })

const recordOf = (f: ReturnType<typeof fakeHost>, file: string): TrailRound => {
  const text = f.trail.get(`${DIR}/${file}`)
  if (text === undefined) throw new Error(`no trail record ${file}; written: ${[...f.trail.keys()].join(', ')}`)
  return JSON.parse(text)
}
const headReads = (f: ReturnType<typeof fakeHost>) => f.probes.filter(p => p.includes('git rev-parse --verify HEAD')).length

describe('the review trail of a run', () => {
  it('writes one record per round of a stage, with the reviewed shas, the routes, the judge fields and the fix range', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue'), finding('P2', 'Borderline', 'src/b.ts', 9)), 'No findings.'], scores: [{ 'codex-F1': 90, 'codex-F2': 40 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect([...f.trail.keys()]).toEqual([`${DIR}/s1-r1.json`, `${DIR}/s1-r2.json`])
    expect(f.trailWrites.every(w => w.cwd === REPO)).toBe(true)

    const r1 = recordOf(f, 's1-r1.json')
    expect(r1).toMatchObject({ version: 1, loop: 's1', name: 'engine', round: 1, base: 'deadbee1', reviewedSha: 'deadbee2', reviewers: [{ name: 'codex', engine: 'auto' }] })
    expect(r1.findings.map(x => [x.id, x.route, x.file, x.line, x.priority])).toEqual([
      ['codex-F1', 'sent', 'src/a.ts', 3, 90],
      ['codex-F2', 'residual', 'src/b.ts', 9, 40],
    ])
    expect(r1.findings[0]).toMatchObject({ reviewer: 'codex', severity: 'P2', title: 'Real issue', verdict: 'confirmed', impact: 'moderate', scope: 'in-scope', evidence: 'src/a.ts:1 - fixture', reason: 'reason codex-F1', decision: { rule: 7, action: 'fix' } })
    expect(r1.findings[1]!.decision).toMatchObject({ rule: 8, action: 'residual' })
    expect(r1.fix).toEqual({ label: 'fix engine r1', startSha: 'deadbee2', headSha: 'head2', commits: ['commit 2'] })
    expect(r1.outcome).toBeUndefined()

    const r2 = recordOf(f, 's1-r2.json')
    expect(r2).toEqual({ version: 1, loop: 's1', name: 'engine', round: 2, base: 'deadbee1', reviewedSha: 'deadbee3', reviewers: [{ name: 'codex', engine: 'auto' }], findings: [], outcome: 'clean' })
    expect(r.trail).toEqual({ dir: DIR, written: 2, failed: [] })
  })

  it('records a declined finding in the fix and the overruled repeat in the next round', async () => {
    const late = review(finding('P2', 'Late save'))
    const f = fakeHost({
      reviews: [late, late, 'No findings.'],
      scores: [
        { 'codex-F1': { verdict: 'confirmed', impact: 'major', likelihood: 'rare', fixCost: 'trivial', scope: 'in-scope', evidence: 'src/a.ts:3 - late response' } },
        { 'codex-F1': { verdict: 'confirmed', impact: 'critical', likelihood: 'rare', fixCost: 'large', scope: 'in-scope', evidence: 'src/a.ts:3 - late response', repeatOf: 'r1/codex-F1' } },
      ],
      override: req =>
        req.label === 'fix engine r1'
          ? { startSha: 'f1', headSha: 'f1', gatesGreen: true, gates: 'green', commits: [], untested: '', deviations: 'none', declined: [{ id: 'codex-F1', reason: DECLINE }] }
          : undefined,
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
    const r1 = recordOf(f, 's1-r1.json')
    expect(r1.fix).toEqual({ label: 'fix engine r1', startSha: 'f1', headSha: 'f1', commits: [], declined: [{ id: 'codex-F1', reason: DECLINE }] })
    const r2 = recordOf(f, 's1-r2.json')
    expect(r2.findings[0]).toMatchObject({ id: 'codex-F1', route: 'sent', repeatOf: 'r1/codex-F1', overruled: DECLINE, impact: 'critical', decision: { rule: 6 } })
    expect(r2.findings[0]!.blocker).toBeUndefined()
    expect(recordOf(f, 's1-r3.json').outcome).toBe('clean')
  })

  it('marks a P0/P1 that went to the implementer without the judge as a blocker', async () => {
    const f = fakeHost({ reviews: [review(finding('P1', 'Blocker bug'), finding('P2', 'Nit')), 'No findings.'], scores: [{ 'codex-F2': 20 }] })
    await runGranny(f.host, input())
    const [blocker, nit] = recordOf(f, 's1-r1.json').findings
    expect(blocker).toMatchObject({ id: 'codex-F1', severity: 'P1', route: 'sent', blocker: true, decision: { rule: 1, action: 'fix' } })
    expect(blocker!.verdict).toBeUndefined()
    expect(nit).toMatchObject({ id: 'codex-F2', route: 'residual' })
    expect(nit!.blocker).toBeUndefined()
  })

  it('reads and writes nothing with trail off', async () => {
    const on = fakeHost({ reviews: ['No findings.'] })
    await runGranny(on.host, input())
    const off = fakeHost({ reviews: ['No findings.'] })
    const r = await runGranny(off.host, input({ config: { trail: false } }))
    expect(off.trail.size).toBe(0)
    expect(off.trailWrites).toEqual([])
    expect(r.trail).toBeUndefined()
    expect(headReads(off)).toBe(1)
    expect(headReads(on)).toBe(2)
    expect(recordOf(on, 's1-r1.json')).toMatchObject({ reviewedSha: 'deadbee2', outcome: 'clean' })
  })

  it('reuses the HEAD the check gate read instead of reading it again', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue')), 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      checks: command => (command === 'run-tests' ? 'ok' : undefined),
    })
    const r = await runGranny(f.host, input({ config: { checks: [{ name: 'tests', run: 'run-tests' }] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const heads = r.stages[0]!.checks!.map(c => c.head)
    expect(heads).toHaveLength(2)
    expect(recordOf(f, 's1-r1.json').reviewedSha).toBe(heads[0])
    expect(recordOf(f, 's1-r2.json').reviewedSha).toBe(heads[1])
    expect(recordOf(f, 's1-r1.json').fix).toMatchObject({ startSha: 'deadbee2', headSha: heads[1] })
    const off = fakeHost({
      reviews: [review(finding('P2', 'Real issue')), 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      checks: command => (command === 'run-tests' ? 'ok' : undefined),
    })
    await runGranny(off.host, input({ config: { trail: false, checks: [{ name: 'tests', run: 'run-tests' }] } }))
    expect(headReads(f)).toBe(headReads(off))
  })

  it('takes the fix range to the commit step when that is what committed the fix', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue')), 'No findings.'], scores: [{ 'codex-F1': 90 }], status: ['', ' M src/a.ts', ''] })
    await runGranny(f.host, input())
    expect(f.calls.map(c => c.label)).toContain('commit engine fix r1')
    expect(recordOf(f, 's1-r1.json').fix).toEqual({ label: 'fix engine r1', startSha: 'deadbee2', headSha: 'head3', commits: ['commit 2', 'commit 3'] })
  })

  it('records the findings that came in when a review fails, with no route', async () => {
    let reviews = 0
    const f = fakeHost({
      override: req => {
        if (req.role !== 'reviewer') return undefined
        reviews++
        if (req.label.endsWith(' codex') && reviews <= 2) return { findings: [{ severity: 'P2', file: 'src/a.ts', line: 3, title: 'Real issue', detail: 'd' }] }
        return null
      },
    })
    const r = await runGranny(f.host, { repo: REPO, branch: 'feat/x', base: 'main', stages: [{ name: 'engine', task: 'Do WP-01.' }], config: { reviewers: [{ name: 'codex', engine: 'agent' }, { name: 'glm', engine: 'agent' }] } })
    expect(r.stages[0]!.outcome).toBe('review-failed')
    const r1 = recordOf(f, 's1-r1.json')
    expect(r1).toMatchObject({ outcome: 'review-failed', reviewers: [{ name: 'codex', engine: 'agent' }] })
    expect(r1.note).toContain('glm')
    expect(r1.findings.map(x => [x.id, x.title, x.route])).toEqual([['codex-F1', 'Real issue', undefined]])
  })

  it('marks the last round of a loop that hit the round cap', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Real issue'))], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ config: { maxRounds: 1 } }))
    expect(r.stages[0]!.outcome).toBe('round-cap')
    expect(recordOf(f, 's1-r1.json')).toMatchObject({ outcome: 'round-cap', fix: { label: 'fix engine r1' }, findings: [{ id: 'codex-F1', route: 'sent' }] })
  })

  it('records a round whose fix left the checks red as checks-failed', async () => {
    let runs = 0
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue'))],
      scores: [{ 'codex-F1': 90 }],
      checks: command => (command === 'run-tests' ? (runs++ === 0 ? 'ok' : { code: 1, output: 'FAIL' }) : undefined),
    })
    const r = await runGranny(f.host, input({ config: { checks: [{ name: 'tests', run: 'run-tests', maxRepairs: 0 }] } }))
    expect(r.stages[0]!.outcome).toBe('checks-failed')
    const r1 = recordOf(f, 's1-r1.json')
    expect(r1).toMatchObject({ outcome: 'checks-failed', fix: { label: 'fix engine r1' } })
    expect(r1.note).toContain('checks failed at fix r1')
  })

  it('keeps the outcome when a record cannot be written, and names the round', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue')), 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      trailWrite: path => (path.endsWith('/s1-r1.json') ? { code: 1, output: 'No space left on device' } : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.final?.gatesGreen).toBe(true)
    expect(r.trail).toEqual({ dir: DIR, written: 1, failed: ['s1-r1'] })
    expect(f.logs.some(l => l.startsWith('engine r1: trail record not written') && l.includes(`${DIR}/s1-r1.json`))).toBe(true)
  })

  it('survives a host that throws on the write', async () => {
    const f = fakeHost({
      reviews: ['No findings.'],
      trailWrite: () => {
        throw new Error('host gone')
      },
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(r.trail).toEqual({ dir: DIR, written: 0, failed: ['s1-r1'] })
    expect(f.logs.some(l => l.includes('host gone'))).toBe(true)
  })

  it('leaves the reviewed sha out when the HEAD read for it fails', async () => {
    const f = fakeHost({ reviews: ['No findings.'] })
    const run = f.host.run!
    let heads = 0
    f.host.run = async (command, cwd) => {
      if (command.includes('git rev-parse --verify HEAD') && heads++ > 0) throw new Error('runner gone')
      return run(command, cwd)
    }
    const r = await runGranny(f.host, input())
    expect(r.stages[0]!.outcome).toBe('clean')
    const r1 = recordOf(f, 's1-r1.json')
    expect('reviewedSha' in r1).toBe(false)
    expect(r1.outcome).toBe('clean')
    expect(f.logs).toContain('head engine r1: could not read HEAD for the trail record: runner gone')
  })

  it('writes the records of parallel lanes into the main worktree, one file each', async () => {
    const lanePath = (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd
    const f = fakeHost({
      worktree: lanePath,
      override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
    })
    const r = await runGranny(f.host, input({ stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [] }] }))
    expect(r.stages[1]!.note).toContain('ran in parallel on feat/x--s2-two')
    const main = '/work/repo-worktrees/feat-x'
    const written = f.trailWrites.map(w => [w.path, w.cwd])
    expect(written).toEqual(
      expect.arrayContaining([
        [`${main}/.granny/trail/s1-r1.json`, main],
        [`${main}/.granny/trail/s2-r1.json`, main],
        [`${main}/.granny/trail/final-r1.json`, main],
      ]),
    )
    expect(written).toHaveLength(3)
    expect(r.trail).toEqual({ dir: `${main}/.granny/trail`, written: 3, failed: [] })
    expect(JSON.parse(f.trail.get(`${main}/.granny/trail/final-r1.json`)!)).toMatchObject({ loop: 'final', name: 'final review', base: 'main', outcome: 'clean' })
  })

  it('writes the plan review records as plan-r<n>', async () => {
    const PLAN = '/plans/v1.md'
    const f = fakeHost({ reviews: [review(finding('P2', 'Missing step', PLAN)), 'No findings.', 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    const p1 = recordOf(f, 'plan-r1.json')
    expect(p1).toMatchObject({ loop: 'plan', name: 'plan review', round: 1, base: 'main', fix: { label: 'fix plan review r1' }, findings: [{ id: 'codex-F1', route: 'sent', file: PLAN }] })
    expect(p1.fix!.startSha).toBeUndefined()
    expect(recordOf(f, 'plan-r2.json').outcome).toBe('clean')
    expect(recordOf(f, 's1-r1.json').outcome).toBe('clean')
  })

  it('names the final review of another repo after it', async () => {
    const f = fakeHost({})
    const r = await runGranny(
      f.host,
      input({
        repos: ['/work/web'],
        config: { parallel: false },
        stages: [
          { name: 'api', task: 'WP-01' },
          { name: 'ui', task: 'WP-02', repo: '/work/web' },
          { name: 'ui more', task: 'WP-03', repo: '/work/web' },
        ],
      }),
    )
    expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean', 'clean'])
    expect(f.trailWrites.map(w => w.path)).toEqual([`${DIR}/s1-r1.json`, '/work/web/.granny/trail/s2-r1.json', '/work/web/.granny/trail/s3-r1.json', '/work/web/.granny/trail/final-web-r1.json'])
  })

  it('writes through the helper on a host without a shell, and checks the bytes', async () => {
    const f = fakeHost({ direct: false, name: 'claude-code', reviews: ['No findings.'] })
    const r = await runGranny(f.host, input())
    expect(r.trail).toEqual({ dir: DIR, written: 1, failed: [] })
    const steps = f.requests.filter(q => q.label.startsWith('trail '))
    expect(steps.map(q => [q.label, q.role, q.phase])).toEqual([
      ['trail s1-r1', 'helper', 'Review'],
      ['trail s1-r1 size', 'helper', 'Review'],
    ])
    expect(steps[0]!.prompt).toContain('line breaks')
    expect(recordOf(f, 's1-r1.json')).toMatchObject({ loop: 's1', outcome: 'clean' })
  })
})
