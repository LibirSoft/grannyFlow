import { describe, expect, it } from 'bun:test'
import { dropPlaceholders, planReviewWarning, RUN_INPUT_SCHEMA, RUN_TOOL_DESCRIPTION } from '../src/adapters/common'
import { checkInput, type RunInput } from '../src/core/engine'

// The granny_run arguments gpt-5.6-luna sent through omp for a plain one-stage run: every optional
// field filled with an empty placeholder. checkInput refused them ("goal must be a non-empty string").
const filled = {
  repo: '/r',
  branch: 'feat/fix-add',
  base: 'main',
  repos: [],
  goal: '',
  context: '',
  plan: [],
  stages: [{ name: 'fix add', task: 'Fix add.', implement: true, review: true, repo: '', checks: [], after: [] }],
  fromStage: 1,
  config: {},
} as unknown as RunInput

describe('dropPlaceholders', () => {
  it('turns a placeholder-filled granny_run call into one checkInput accepts', () => {
    expect(checkInput(filled).length).toBeGreaterThan(0)
    const clean = dropPlaceholders(filled)
    expect(checkInput(clean)).toEqual([])
    expect(clean).not.toHaveProperty('goal')
    expect(clean).not.toHaveProperty('plan')
    expect(clean).not.toHaveProperty('repos')
    expect(clean).not.toHaveProperty('context')
    expect(clean).not.toHaveProperty('config')
    expect(clean.stages![0]).not.toHaveProperty('repo')
  })

  it('keeps the empty values that mean something and every real value', () => {
    const clean = dropPlaceholders(filled)
    expect(clean.stages![0]!.checks).toEqual([])
    expect(clean.stages![0]!.after).toEqual([])
    expect(clean.base).toBe('main')
    expect(clean.fromStage).toBe(1)
    const real = { repo: '/r', branch: 'b', goal: 'Build it', config: { maxRounds: 2 }, plan: ['/p.md'] } as unknown as RunInput
    expect(dropPlaceholders(real)).toEqual(real)
  })

  it('drops fromStage 0 and leaves non-object input alone', () => {
    expect(dropPlaceholders({ repo: '/r', branch: 'b', stages: [{ task: 't' }], fromStage: 0 } as RunInput)).not.toHaveProperty('fromStage')
    expect(dropPlaceholders(undefined as unknown as RunInput)).toBeUndefined()
  })
})

describe('the plan review warning', () => {
  it('names the round cap, the tokens and the time', () => {
    const text = planReviewWarning(3)
    expect(text).toContain('up to 3 round(s)')
    expect(text).toContain('tokens')
    expect(text).toContain('time')
    expect(planReviewWarning(1)).toContain('up to 1 round(s)')
  })

  it('tells the agent in the tool schema to turn plan review on only when the user asked', () => {
    const props = RUN_INPUT_SCHEMA.properties as Record<string, { description: string }>
    for (const text of [props.config!.description, props.plan!.description, RUN_TOOL_DESCRIPTION]) {
      expect(text).toContain('only when the user')
      expect(text).toContain('tokens')
    }
  })
})
