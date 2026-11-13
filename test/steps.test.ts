import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { implementPrompt, implementStepPrompt } from '../src/core/prompts'
import type { StageSpec } from '../src/core/types'

const p = { repo: '/work/repo', branch: 'feat/x', base: 'main', config: resolveConfig([]) }
const stage: StageSpec = {
  task: 'WP-01',
  steps: [{ name: 'schema', task: 'WP-01a: the schema' }, { task: 'WP-01b: the route' }, { name: 'docs', task: 'WP-01c: the docs' }],
}

describe('the implementer prompt of a stage with steps', () => {
  it('leaves the prompt of a stage without steps as it was', () => {
    expect(implementPrompt(p, { task: 'WP-01' }, 0, 1, 'core')).toContain('Do ONLY this stage, then stop:\nWP-01\n\nHow to build it:')
  })

  it('lists the steps in order after the task, a step without a name by its number', () => {
    expect(implementPrompt(p, stage, 0, 1, 'core')).toContain(
      'Do ONLY this stage, then stop:\nWP-01\n\nIts steps, in this order - commit each one before you start the next:\n1. schema: WP-01a: the schema\n2. step 2: WP-01b: the route\n3. docs: WP-01c: the docs\n\nHow to build it:',
    )
  })
})

describe('the step prompt', () => {
  it("gives a step its own task and the names of all the steps, and no other step's task", () => {
    const prompt = implementStepPrompt(p, stage, 0, 1, 'core', 1)
    expect(prompt).toContain('You are the IMPLEMENTER. Stage 1/1: "core", step 2 of 3: "step 2".')
    expect(prompt).toContain('The steps of this stage are built by one agent each, in this order: 1. schema, 2. step 2 (yours), 3. docs.')
    expect(prompt).toContain("Do ONLY step 2, then stop; the later steps are other agents' work:\nWP-01b: the route\n")
    expect(prompt).not.toContain('WP-01a')
    expect(prompt).not.toContain('WP-01c')
    expect(prompt).toContain('If the branch log shows this step is already committed, change nothing and say so in deviations.')
    expect(prompt).toContain('How to build it:')
  })

  it('has the first step read the earlier stages, and a later step read what the earlier steps committed', () => {
    const first = implementStepPrompt(p, stage, 1, 2, 'core', 0, true)
    expect(first).toContain('Earlier stages are done and reviewed: first read `git log --oneline main..HEAD`, the code and .granny/PR-BODY.md.')
    expect(first).not.toContain('The earlier steps of this stage')
    const later = implementStepPrompt(p, stage, 1, 2, 'core', 2, true)
    expect(later).toContain('The earlier steps of this stage are committed by other agents: first read `git log --oneline main..HEAD`, the code and .granny/PR-BODY.md.')
    expect(later).not.toContain('Earlier stages are done and reviewed')
  })

  it('writes the PR body when this step is committed', () => {
    expect(implementStepPrompt(p, stage, 0, 1, 'core', 2)).toContain("When this step's code is committed, bring .granny/PR-BODY.md up to date in one edit")
  })
})
