import { describe, expect, it } from 'bun:test'
import { checkInput, runGranny, type RunInput } from '../src/core/engine'
import { fakeHost, finding, review } from './fake-host'

const PLAN = '/plans/v1.md'

const input = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
})

describe('the plan input', () => {
  it('takes one absolute path or a list of them', () => {
    expect(checkInput(input({ plan: PLAN }))).toEqual([])
    expect(checkInput(input({ plan: [PLAN, '/plans/wo-2.md'] }))).toEqual([])
  })

  for (const [label, plan, message] of [
    ['a relative path', 'plans/v1.md', 'plan must be an absolute path or a non-empty array of absolute paths (got "plans/v1.md")'],
    ['a relative path in a list', [PLAN, './wo.md'], 'plan must be an absolute path or a non-empty array of absolute paths (got "./wo.md")'],
    ['an empty list', [], 'plan must be an absolute path or a non-empty array of absolute paths'],
    ['an empty string', '', 'plan must be an absolute path or a non-empty array of absolute paths'],
    ['a number in a list', [PLAN, 5], 'plan must be an absolute path or a non-empty array of absolute paths (got 5)'],
  ] as const) {
    it(`rejects ${label} before anything runs`, async () => {
      expect(checkInput(input({ plan: plan as any }))).toEqual([message])
      const f = fakeHost()
      await expect(runGranny(f.host, input({ plan: plan as any }))).rejects.toThrow(message)
      expect(f.calls).toHaveLength(0)
      expect(f.setups).toHaveLength(0)
    })
  }

  it('puts the plan files in every agent prompt and the {prompt} of a command reviewer', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Off by one')), 'No issues.'],
      scores: [{ 'glm-F1': 90 }],
    })
    await runGranny(
      f.host,
      input({
        plan: [PLAN, "/plans/it's wo-2.md"],
        context: 'Read docs/notes.md.',
        config: { planReview: false, reviewers: [{ name: 'glm', engine: 'command', command: 'glm-review {prompt}' }] },
      }),
    )
    const line = `Plan files - read them first: ${PLAN}, /plans/it's wo-2.md`
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'judge core r1', 'fix core r1', 'pr-ready check'])
    for (const c of f.calls) {
      expect(c.prompt).toContain(line)
      expect(c.prompt).toContain('Read docs/notes.md.')
    }
    expect(f.commands[0]).toContain(`Plan files - read them first: ${PLAN}, /plans/it'\\''s wo-2.md`)
  })
})
