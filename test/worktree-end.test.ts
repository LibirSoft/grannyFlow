import { describe, expect, it } from 'bun:test'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost, finding, review, type FakeOptions, type Review } from './fake-host'

const A = '/work/a'
const B = '/work/b'
const WT = '/work/a-worktrees/feat-x'
const SAVED = '/work/a/.granny/branches/feat%2Fx'
const DONE = ['owned', 'on branch', 'clean'].map(m => `[granny] run worktree ${m}\n`).join('') + '[granny] work dir saved\n[granny] run worktree removed\n'
const isRemoval = (command: string) => command.includes('git worktree remove') && !command.includes('--force')
const lanePath = (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd
const input: RunInput = { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }] }
const host = (opts: FakeOptions = {}, removal: Review = DONE) => fakeHost({ worktree: lanePath, made: true, checks: c => (isRemoval(c) ? removal : undefined), ...opts })
const laneInput: RunInput = { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', after: [] }] }
const laneHost = (cleanup: string) =>
  fakeHost({
    worktree: lanePath,
    made: true,
    reviews: (command: string) => (command.includes('--force') ? { code: 1, output: cleanup } : 'No findings.'),
    override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
  })

describe('the end of a run', () => {
  it('removes the worktree granny made, from the repo, and points the result at the saved files', async () => {
    const f = host()
    const r = await runGranny(f.host, input)
    expect(r.worktree).toBe(WT)
    expect(r.worktreeEnd).toEqual({ removed: true, saved: SAVED })
    expect(r.trail!.dir).toBe(`${SAVED}/trail`)
    expect(r.final!.prBodyPath).toBe(`${SAVED}/PR-BODY.md`)
    const at = f.commands.findIndex(isRemoval)
    expect(at).toBe(f.commands.length - 1)
    expect(f.cwds[at]).toBe(A)
  })

  it('asks nothing of a worktree it did not make, with keepWorktree on, or with the worktree off', async () => {
    for (const [opts, config, kept] of [
      [{ made: false }, {}, 'granny did not create it'],
      [{}, { keepWorktree: true }, 'keepWorktree is on'],
    ] as const) {
      const f = host(opts)
      const r = await runGranny(f.host, { ...input, config })
      expect(r.worktreeEnd).toEqual({ removed: false, kept })
      expect(f.commands.some(isRemoval)).toBe(false)
      expect(r.trail!.dir).toBe(`${WT}/.granny/trail`)
    }
    const off = host()
    const r = await runGranny(off.host, { ...input, config: { worktree: false } })
    expect('worktreeEnd' in r).toBe(false)
    expect(off.commands.some(isRemoval)).toBe(false)
  })

  it('leaves every worktree when the run did not end PR-ready', async () => {
    const capped = host({ reviews: [review(finding('P1', 'bug')), review(finding('P1', 'bug'))] })
    const r = await runGranny(capped.host, { ...input, config: { maxRounds: 2, reviewers: [{ name: 'codex', engine: 'auto' }] } })
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: stage 1 (one) ended round-cap' })
    expect(capped.commands.some(isRemoval)).toBe(false)
    const red = host({ override: req => (req.kind === 'final' ? { gatesGreen: false, gates: 'red', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' } : undefined) })
    expect((await runGranny(red.host, input)).worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: the final check left the gates red' })
    const silent = host({ override: req => (req.kind === 'final' ? null : undefined) })
    expect((await runGranny(silent.host, input)).worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: the final check returned nothing' })
  })

  it('says why a removal stopped, and never fails the run over it', async () => {
    const f = host({}, { code: 1, output: '[granny] run worktree owned\n[granny] run worktree is not where the run starts\n[granny] run worktree on branch\n?? left.txt\n' })
    const r = await runGranny(f.host, input)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'uncommitted changes in the worktree' })
    expect(r.final!.prBodyPath).toBe('.granny/PR-BODY.md')
    expect(f.logs).toContainEqual(expect.stringContaining(`worktree left in place: ${WT} - uncommitted changes in the worktree: `))
    const thrown = fakeHost({ worktree: lanePath, made: true, checks: c => { if (isRemoval(c)) throw new Error('boom'); return undefined } })
    expect((await runGranny(thrown.host, input)).worktreeEnd).toEqual({ removed: false, kept: 'the removal step failed: boom' })
  })

  it('keeps a worktree the run was started in, and starts no removal in it', async () => {
    const f = host({ worktree: A })
    const r = await runGranny(f.host, input)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the run was started in this worktree' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('rewrites a prBodyPath under the removed worktree to the saved copy, and leaves any other form as the agent gave it', async () => {
    for (const [prBodyPath, moved] of [[`${WT}/.granny/PR-BODY.md`, `${SAVED}/PR-BODY.md`], ['docs/PR.md', 'docs/PR.md']] as const) {
      const f = host({ override: req => (req.kind === 'final' ? { gatesGreen: true, gates: 'all green', commits: [], prBodyPath, issues: '' } : undefined) })
      const r = await runGranny(f.host, input)
      expect(r.worktreeEnd).toEqual({ removed: true, saved: SAVED })
      expect(r.final!.prBodyPath).toBe(moved)
    }
  })

  it('treats each repo on its own', async () => {
    const f = fakeHost({ worktree: lanePath, made: true, checks: c => (isRemoval(c) ? (c.includes('/work/b-') ? { code: 1, output: '[granny] run worktree owned\n[granny] run worktree is not where the run starts\n' } : DONE) : undefined) })
    const r = await runGranny(f.host, { repo: A, repos: [B], branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', repo: B }] })
    expect(r.repos!.map(x => x.worktreeEnd)).toEqual([{ removed: true, saved: SAVED }, { removed: false, kept: 'it is not on feat/x' }])
    expect(r.worktreeEnd).toEqual({ removed: true, saved: SAVED })
    const removals = f.commands.map((c, i) => [c, f.cwds[i]] as const).filter(([c]) => isRemoval(c))
    expect(removals.map(([, cwd]) => cwd)).toEqual([A, B])
    expect(removals[1]![0]).toContain('/work/b/.granny/branches/feat%2Fx')
    expect(removals[1]![0]).toContain('wt=/work/b-worktrees/feat-x; ')
  })

  it('keeps the run worktree when a lane worktree was left in place', async () => {
    const f = laneHost('[granny] lane merged\n')
    const r = await runGranny(f.host, laneInput)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'a lane worktree was left in place (/work/a-worktrees/feat-x--s2-two), and the removal could not be confirmed' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('keeps the run worktree when a lane cleanup only quotes the marker of a removed lane worktree', async () => {
    const f = laneHost("echo '[granny] lane worktree removed'\n")
    const r = await runGranny(f.host, laneInput)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'a lane worktree was left in place (/work/a-worktrees/feat-x--s2-two), and the removal could not be confirmed' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('says the lane worktree was left, not removed, when its marker shares its line with other text, and keeps the run worktree', async () => {
    const f = laneHost('Helper: [granny] lane worktree removed\n')
    const r = await runGranny(f.host, laneInput)
    expect(f.logs).toContainEqual(expect.stringContaining('merge two: left /work/a-worktrees/feat-x--s2-two (feat/x--s2-two) in place'))
    expect(r.stages[1]!.note).toBe('ran in parallel on feat/x--s2-two, merged; its worktree /work/a-worktrees/feat-x--s2-two and branch feat/x--s2-two were left in place (the cleanup could not confirm the merge)')
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'a lane worktree was left in place (/work/a-worktrees/feat-x--s2-two), and the removal could not be confirmed' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('runs the removal through a helper agent on Claude Code', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, worktree: lanePath, made: true, checks: c => (isRemoval(c) ? DONE : undefined) })
    const r = await runGranny(f.host, input)
    expect(r.worktreeEnd).toEqual({ removed: true, saved: SAVED })
    const call = f.requests.at(-1)!
    expect([call.label, call.role, call.kind, call.phase, call.model, call.effort, call.access, call.cwd]).toEqual(['remove worktree', 'helper', 'command', 'PR ready', 'haiku', 'low', 'write', A])
    expect(call.prompt).toContain(`\n( cd ${A} && { wt=${WT}; `)
    expect(call.prompt).toContain("copies the run's work dir files into the repo and then removes the worktree granny created for the run")
  })

  it('reports a removal whose helper returned nothing as a runner failure, not as a failed ownership check', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, worktree: lanePath, made: true, override: req => (req.label === 'remove worktree' ? null : undefined) })
    const r = await runGranny(f.host, input)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the removal did not run: its runner returned no exit code' })
    expect(f.logs.some(l => l.includes('the removal did not run') && l.includes('the remove worktree runner returned nothing'))).toBe(true)
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('keeps the worktree when the final review ends round-cap, and names the review', async () => {
    const f = host({
      override: req => (req.label.startsWith('review final review') ? { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'broken merge', detail: 'd' }] } : undefined),
    })
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b' }], config: { maxRounds: 1 } })
    expect(r.finalReview!.outcome).toBe('round-cap')
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: the final review ended round-cap' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('keeps the worktree when the final checks fail, and names the final review', async () => {
    let runs = 0
    const f = host({
      checks: c => {
        if (isRemoval(c)) return DONE
        if (!c.includes('run-tests')) return undefined
        return ++runs >= 3 ? { code: 1, output: 'red\n' } : undefined
      },
    })
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b' }], config: { checks: [{ name: 'tests', run: 'run-tests' }] } })
    expect(r.finalReview!.outcome).toBe('checks-failed')
    expect(f.logs.some(l => l.includes('final review not run - the final checks failed'))).toBe(true)
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: the final review ended checks-failed' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('keeps the worktree when the checks are red after the pr-ready check', async () => {
    let moved = false
    const f: ReturnType<typeof fakeHost> = fakeHost({
      worktree: lanePath,
      made: true,
      checks: c => (isRemoval(c) ? DONE : moved && c.includes('run-tests') ? { code: 1, output: 'red\n' } : undefined),
      override: async req => {
        if (req.kind === 'final' && !moved) {
          moved = true
          await f.host.agent({ ...req, kind: 'implementation' } as AgentRequest)
        }
        return undefined
      },
    })
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }], config: { checks: [{ name: 'tests', run: 'run-tests' }] } })
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the run did not end PR-ready: the checks after the final check are red' })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('names the repo of a final check that left its gates red', async () => {
    const f = host({
      override: req => (req.kind === 'final' && req.cwd.startsWith('/work/b-') ? { gatesGreen: false, gates: 'red', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' } : undefined),
    })
    const r = await runGranny(f.host, { repo: A, repos: [B], branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', repo: B }] })
    const kept = 'the run did not end PR-ready: the final check in b left the gates red'
    expect(r.repos!.map(x => x.worktreeEnd)).toEqual([{ removed: false, kept }, { removed: false, kept }])
    expect(r.worktreeEnd).toEqual({ removed: false, kept })
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('stops before stage 1 when the plan review ends round-cap, and keeps the worktree', async () => {
    const f = host({
      override: req => (req.label.startsWith('review plan review') ? { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'bad plan', detail: 'd' }] } : undefined),
    })
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', plan: '/work/a/.granny/plans/feat-x.md', stages: [{ name: 'one', task: 'a' }], config: { planReview: true, maxRounds: 1 } })
    expect(r.plan!.outcome).toBe('round-cap')
    expect(r.stages).toEqual([])
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the plan review ended round-cap, so the run stopped before stage 1' })
    expect(f.logs).toContain(`worktree left in place: ${WT} - the plan review ended round-cap, so the run stopped before stage 1`)
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('stops before stage 1 when no reviewer can review the plan, and keeps the worktree', async () => {
    const f = host()
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', plan: '/work/a/.granny/plans/feat-x.md', stages: [{ name: 'one', task: 'a' }], config: { planReview: true, reviewers: [{ name: 'cmd', engine: 'command', command: 'echo {base}' }] } })
    expect(r.plan!.outcome).toBe('review-failed')
    expect(r.stages).toEqual([])
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'the plan review ended review-failed, so the run stopped before stage 1' })
    expect(f.logs).toContain(`worktree left in place: ${WT} - the plan review ended review-failed, so the run stopped before stage 1`)
    expect(f.commands.some(isRemoval)).toBe(false)
  })

  it('keeps the worktree of a planning run, for the implement run to remove', async () => {
    const f = host()
    const r = await runGranny(f.host, { repo: A, branch: 'feat/x', goal: 'add a thing' })
    expect(r.draft).toBeDefined()
    expect(r.worktreeEnd).toEqual({ removed: false, kept: 'a planning run keeps its worktree for the implement run' })
    expect(f.logs).toContain(`worktree left in place: ${WT} - a planning run keeps its worktree for the implement run`)
    expect(f.commands.some(isRemoval)).toBe(false)
  })
})
