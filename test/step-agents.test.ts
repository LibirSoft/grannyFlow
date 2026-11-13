import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest, Implementation, StageSpec } from '../src/core/types'
import { fakeHost } from './fake-host'

const steps: NonNullable<StageSpec['steps']> = [
  { name: 'schema', task: 'WP-01a: the schema' },
  { name: 'route', task: 'WP-01b: the route' },
  { name: 'docs', task: 'WP-01c: the docs' },
]
const run = (stages: StageSpec[], extra: Partial<RunInput> = {}): RunInput => ({ repo: '/work/repo', branch: 'feat/x', stages, ...extra })
const on = { config: { stepAgents: true } }
const implementations = (f: { calls: AgentRequest[] }) => f.calls.filter(c => c.kind === 'implementation').map(c => c.label)
const statusLabels = (f: { requests: AgentRequest[] }) => f.requests.map(r => r.label).filter(l => l.startsWith('status core'))

describe('step agents', () => {
  it('builds each step with its own agent, in order, and reviews the stage once', async () => {
    const f = fakeHost()
    await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(implementations(f)).toEqual(['implement core step 1/3', 'implement core step 2/3', 'implement core step 3/3'])
    expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(1)
  })

  it('reviews the diff from the HEAD read before step 1', async () => {
    const f = fakeHost()
    await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(f.calls.find(c => c.kind === 'findings')!.prompt).toContain('deadbee1...HEAD')
  })

  it('reads the status after steps 1 and 2, then once for the stage, when the tree is clean', async () => {
    const f = fakeHost({ direct: false })
    await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(statusLabels(f)).toEqual(['status core step 1/3', 'status core step 2/3', 'status core implement'])
  })

  it('has the commit step commit a step that left work before the next step starts', async () => {
    const f = fakeHost({ status: [' M a.txt', ''] })
    await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(implementations(f)).toEqual(['implement core step 1/3', 'commit core step 1/3', 'implement core step 2/3', 'implement core step 3/3'])
  })

  it('runs the next step when the work a step leaves stays uncommitted, and says so in the stage note', async () => {
    const f = fakeHost({ status: ['', ' M b.txt', ' M b.txt', ''] })
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(implementations(f)).toEqual(['implement core step 1/3', 'implement core step 2/3', 'commit core step 2/3', 'implement core step 3/3'])
    expect(r.stages[0]!.note).toContain('uncommitted changes after step 2/3: M b.txt - step 3/3 started on them')
  })

  it('fails the run when a step returns nothing, as a single implementer does', async () => {
    const f = fakeHost({ override: req => (req.label === 'implement core step 2/3' ? null : undefined) })
    await expect(runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))).rejects.toThrow('implement core step 2/3: implementer returned nothing')
    expect(implementations(f)).not.toContain('implement core step 3/3')
  })

  it('keeps one agent for a stage without steps, and for a stage with one step', async () => {
    const plain = fakeHost()
    const r0 = await runGranny(plain.host, run([{ name: 'core', task: 'WP-01' }], on))
    expect(implementations(plain)).toEqual(['implement core'])
    expect(plain.calls.find(c => c.label === 'implement core')!.prompt).not.toContain('Its steps')
    expect(r0.stages[0]).not.toHaveProperty('steps')

    const one = fakeHost()
    const r1 = await runGranny(one.host, run([{ name: 'core', task: 'WP-01', steps: [{ task: 'WP-01a' }] }], on))
    expect(implementations(one)).toEqual(['implement core'])
    expect(one.calls.find(c => c.label === 'implement core')!.prompt).toContain('1. step 1: WP-01a')
    expect(r1.stages[0]).not.toHaveProperty('steps')
  })

  it('gives one agent the steps in order when stepAgents is off', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }]))
    expect(implementations(f)).toEqual(['implement core'])
    const prompt = f.calls.find(c => c.label === 'implement core')!.prompt
    expect(prompt.indexOf('1. schema: WP-01a')).toBeLessThan(prompt.indexOf('2. route: WP-01b'))
    expect(prompt.indexOf('2. route: WP-01b')).toBeLessThan(prompt.indexOf('3. docs: WP-01c'))
    expect(r.stages[0]).not.toHaveProperty('steps')
  })

  it('merges the steps into one implementation, keeps each step, and prefixes what the steps said', async () => {
    const reports: Record<string, Implementation> = {
      'implement core step 1/3': { startSha: 's1', headSha: 'h1', gatesGreen: true, gates: 'g1', commits: ['c1'], untested: '' },
      'implement core step 2/3': { startSha: 'h1', headSha: 'h2', gatesGreen: true, gates: 'g2', commits: ['c2'], untested: 'no end-to-end run', deviations: 'moved x' },
      'implement core step 3/3': { startSha: 'h2', headSha: 'h3', gatesGreen: true, gates: 'lint green', commits: ['c3'], untested: '', deviations: 'none', declined: [{ id: 'F1', reason: 'out of scope' }] },
    }
    const f = fakeHost({ override: req => (req.kind === 'implementation' ? reports[req.label] : undefined) })
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(r.stages[0]!.implementation).toEqual({
      startSha: 's1',
      headSha: 'h3',
      gatesGreen: true,
      gates: 'lint green',
      commits: ['c1', 'c2', 'c3'],
      untested: 'step 2 (route): no end-to-end run',
      deviations: 'step 2 (route): moved x',
      declined: [{ id: 'F1', reason: 'step 3 (docs): out of scope' }],
    })
    expect(r.stages[0]!.steps!.map(s => [s.name, s.implementation.headSha])).toEqual([
      ['schema', 'h1'],
      ['route', 'h2'],
      ['docs', 'h3'],
    ])
  })

  it('keeps the steps and the note of leftover work when a stage ends with no changes', async () => {
    const f = fakeHost({ commits: 0, status: [' M b.txt', ' M b.txt', ''] })
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(r.stages[0]).toMatchObject({ outcome: 'no-changes' })
    expect(r.stages[0]!.steps!.map(s => s.name)).toEqual(['schema', 'route', 'docs'])
    expect(r.stages[0]!.note).toContain('the implementer made no commit')
    expect(r.stages[0]!.note).toContain('uncommitted changes after step 1/3: M b.txt - step 2/3 started on them')
  })

  it('keeps the steps and the note of leftover work when a stage ends with checks failed', async () => {
    const f = fakeHost({ status: [' M b.txt', ' M b.txt', '', ' M b.txt', ''] })
    const config = { stepAgents: true, maxRepairs: 0, checks: [{ name: 'tests', run: 'run-tests' }] }
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], { config }))
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed' })
    expect(r.stages[0]!.steps!.map(s => s.name)).toEqual(['schema', 'route', 'docs'])
    expect(r.stages[0]!.note).toContain('uncommitted changes after step 1/3: M b.txt - step 2/3 started on them')
  })

  it('runs the next step when the status cannot be read after a step, and says so in the stage note', async () => {
    const failed = { code: 128, output: 'fatal: index file corrupt\n' }
    const f = fakeHost({ status: [failed, failed, ''] })
    const r = await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(implementations(f)).toEqual(['implement core step 1/3', 'implement core step 2/3', 'implement core step 3/3'])
    expect(r.stages[0]!.note).toContain('working tree status unreadable after step 1/3 (exit 128: fatal: index file corrupt)')
  })

  it('logs a step that ends with red gates, and still runs the next step', async () => {
    const red = { startSha: 'deadbee1', headSha: 'head1', gatesGreen: false, gates: 'lint RED', commits: ['c1'], untested: '' }
    const f = fakeHost({ override: req => (req.label === 'implement core step 1/3' ? red : undefined) })
    await runGranny(f.host, run([{ name: 'core', task: 'WP-01', steps }], on))
    expect(f.logs).toContain('core: step 1/3 ended with RED gates')
    expect(implementations(f)).toEqual(['implement core step 1/3', 'implement core step 2/3', 'implement core step 3/3'])
  })
})
