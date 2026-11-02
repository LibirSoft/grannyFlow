import { describe, expect, it } from 'bun:test'
import { checkInput, runGranny, type RunInput } from '../src/core/engine'
import { resolveConfig } from '../src/core/config'
import { draftPrompt } from '../src/core/prompts'
import { fakeHost, finding, review } from './fake-host'

const goal = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  goal: 'Add login with OAuth.',
  ...extra,
})

describe('the goal input', () => {
  it('replaces stages and is exclusive with them and with fromStage', () => {
    expect(checkInput(goal())).toEqual([])
    expect(checkInput(goal({ stages: [{ task: 'x' }] }))).toEqual([
      'a run with goal plans the work and proposes the stages - drop stages, or drop goal and pass the plan',
    ])
    expect(checkInput(goal({ fromStage: 2 }))).toEqual(['fromStage has no stages to resume in a run with goal'])
    expect(checkInput(goal({ goal: '  ' }))).toEqual(['goal must be a non-empty string'])
    expect(checkInput({ repo: '/r', branch: 'b' })).toEqual(['stages must be a non-empty array (or pass goal to have the planner write the plan)'])
  })
})

describe('a planning run', () => {
  it('writes the plan with the planner, reviews it, and stops before implementing', async () => {
    const f = fakeHost({ reviews: [review(finding('P1', 'Missing step', '/work/repo/.granny/plans/feat-x.md', 4)), 'No issues.'] })
    const result = await runGranny(f.host, goal({ config: { planReview: true, roles: { planner: { model: 'opus', effort: 'high' } } } }))

    expect(f.phases).toEqual(['Worktree', 'Plan', 'Plan review'])
    expect(f.calls.map(c => c.label)).toEqual(['plan', 'fix plan review r1'])
    const planner = f.calls[0]!
    expect(planner).toMatchObject({ role: 'planner', kind: 'draft', access: 'write', model: 'opus', effort: 'high' })
    expect(planner.prompt).toContain('You are the PLANNER')
    expect(planner.prompt).toContain('Add login with OAuth.')
    expect(planner.prompt).toContain('/work/repo/.granny/plans/feat-x.md')
    expect(f.calls[1]!.prompt).toContain('Plan files - read them first: /work/repo/.granny/plans/feat-x.md')

    expect(result.draft).toEqual({ files: ['/work/repo/.granny/plans/feat-x.md'], stages: [{ name: 'core', task: 'WP-01' }], summary: 'one stage' })
    expect(result.plan?.outcome).toBe('clean')
    expect(result.stages).toEqual([])
    expect(result.final).toBeNull()
  })

  it('writes to the plan path it is given, under the main checkout, not the worktree', async () => {
    const f = fakeHost({ worktree: '/work/repo-worktrees/feat-x' })
    await runGranny(f.host, goal({ plan: '/work/repo/docs/oauth.md', config: { planReview: false } }))
    expect(f.calls[0]!.prompt).toContain('write the plan to /work/repo/docs/oauth.md')
    expect(f.calls[0]!.prompt).toContain('Working repo: /work/repo-worktrees/feat-x')

    const g = fakeHost({ worktree: '/work/repo-worktrees/feat-x' })
    await runGranny(g.host, goal({ config: { planReview: false } }))
    expect(g.calls[0]!.prompt).toContain('write the plan to /work/repo/.granny/plans/feat-x.md')
  })

  it('reports review-skipped with planReview off and still stops', async () => {
    const f = fakeHost()
    const result = await runGranny(f.host, goal({ config: { planReview: false } }))
    expect(f.calls.map(c => c.label)).toEqual(['plan'])
    expect(result.plan?.outcome).toBe('review-skipped')
    expect(result.stages).toEqual([])
  })

  it('passes the open questions through and drops stages without a task', async () => {
    const f = fakeHost({
      override: req =>
        req.kind === 'draft'
          ? { files: ['/p.md', 'rel.md'], stages: [{ name: 'a', task: 'WP-01' }, { name: 'b', task: ' ' }], summary: 's', questions: 'Which provider? Default GitHub.' }
          : undefined,
    })
    const result = await runGranny(f.host, goal({ config: { planReview: false } }))
    expect(result.draft).toEqual({ files: ['/p.md'], stages: [{ name: 'a', task: 'WP-01' }], summary: 's', questions: 'Which provider? Default GitHub.' })
  })

  for (const [label, value, message] of [
    ['nothing', null, 'planner returned nothing'],
    ['no absolute plan file', { files: ['plan.md'], stages: [{ name: 'a', task: 't' }], summary: '' }, 'planner reported no plan file'],
    ['no stage', { files: ['/p.md'], stages: [], summary: '' }, 'planner proposed no stage with a task'],
  ] as const) {
    it(`fails loudly when the planner returns ${label}`, async () => {
      const f = fakeHost({ override: req => (req.kind === 'draft' ? value : undefined) })
      await expect(runGranny(f.host, goal())).rejects.toThrow(message)
      expect(f.calls.map(c => c.label)).toEqual(['plan'])
    })
  }

  it('proposes stages that a second run takes as they are', async () => {
    const first = await runGranny(fakeHost().host, goal())
    const f = fakeHost()
    const second = await runGranny(f.host, {
      repo: '/work/repo',
      branch: 'feat/x',
      plan: first.draft!.files,
      stages: first.draft!.stages,
      config: { planReview: false },
    })
    expect(second.stages.map(s => s.stage)).toEqual(['core'])
    expect(f.calls[0]!.prompt).toContain('WP-01')
  })

  it('has a planner role in the config, inheriting the session model', () => {
    expect(resolveConfig([]).roles.planner).toEqual({})
    expect(() => resolveConfig([{ roles: { planner: { model: 'opus', effort: 'max' } } }])).not.toThrow()
    expect(() => resolveConfig([{ roles: { planner: { effort: 'huge' } } }])).toThrow('roles.planner.effort')
  })

  it('tells the planner not to commit or touch anything but the plan', () => {
    const prompt = draftPrompt({ repo: '/r', branch: 'b', base: 'main', config: resolveConfig([]) }, 'G', ['/r/.granny/plans/b.md'])
    expect(prompt).toContain('Change no other file, and never stage or commit the plan files')
  })
})
