import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { renderPrompts } from '../scripts/build'
import { commitPrompt, implementPrompt, implementStepPrompt } from '../src/core/prompts'
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

  it('has the first step read the earlier stages, and a later step read the earlier stages and what the earlier steps committed', () => {
    const first = implementStepPrompt(p, stage, 1, 2, 'core', 0, true)
    expect(first).toContain('Earlier stages are done and reviewed: first read `git log --oneline main..HEAD`, the code and .granny/PR-BODY.md.')
    expect(first).not.toContain('The earlier steps of this stage')
    const later = implementStepPrompt(p, stage, 1, 2, 'core', 2, true)
    expect(later).toContain('Earlier stages are done and reviewed: first read `git log --oneline main..HEAD`, the code and .granny/PR-BODY.md.')
    expect(later).toContain('The earlier steps of this stage are committed by other agents: first read `git log --oneline main..HEAD`, the code and .granny/PR-BODY.md.')
  })

  it('keeps the parallel-lane line in a later step too: the other stages commit nothing on this branch', () => {
    const later = implementStepPrompt(p, stage, 1, 2, 'core', 2, false)
    expect(later).toContain('This stage does not build on the other stages (they run in parallel, elsewhere or later): expect no commits from them on this branch.')
    expect(later).toContain('The earlier steps of this stage are committed by other agents')
  })

  it('writes the PR body when this step is committed', () => {
    expect(implementStepPrompt(p, stage, 0, 1, 'core', 2)).toContain("When this step's code is committed, bring .granny/PR-BODY.md up to date in one edit")
  })
})

describe('the commit prompt between steps', () => {
  const status = ' M a.txt'
  const stageTask = { number: 1, total: 1, name: 'core', task: 'WP-01' }
  const step = { number: 1, total: 3, name: 'schema', task: 'WP-01a: the schema' }

  it('names the step and its task, and leaves out the stage task, when a step is committed', () => {
    const prompt = commitPrompt(p, 'core', 'step 1/3', status, [], stageTask, step)
    expect(prompt).toContain(
      'You are the IMPLEMENTER, after step 1/3 ("schema") of stage "core". The working tree has uncommitted changes; granny checks and reviews only committed work.\nStep 1/3 "schema" - its TASK:\nWP-01a: the schema\n`git status --porcelain` printed:',
    )
    expect(prompt).toContain("Commit this step's work with explicit paths, gates green. Build nothing of the later steps: other agents do them.")
    expect(prompt).not.toContain('finishing stage')
    expect(prompt).not.toContain('Stage 1/1 "core"')
    expect(prompt).not.toContain('its TASK:\nWP-01\n')
    expect(prompt).not.toContain("Commit the stage's work")
  })

  it('keeps the commit prompt of a stage as it was when no step is given', () => {
    const prompt = commitPrompt(p, 'core', 'implement', status, [], stageTask)
    expect(prompt).toContain(
      'You are the IMPLEMENTER, finishing stage "core" (implement). The working tree has uncommitted changes; granny checks and reviews only committed work.\nStage 1/1 "core" - its TASK:\nWP-01\n`git status --porcelain` printed:',
    )
    expect(prompt).toContain("Commit the stage's work with explicit paths, gates green.")
    expect(prompt).not.toContain('after step')
  })
})

describe('the prompt reference', () => {
  it('renders the step prompts and the planner with stepAgents on', () => {
    const rendered = renderPrompts()
    expect(rendered).toContain('## Planner - a run with goal, with stepAgents on')
    expect(rendered).toContain('## Implementer - stage with steps, with stepAgents off or one step')
    expect(rendered).toContain('## Implementer - a step of a stage with steps, with stepAgents on')
  })

  it('shows the commit prompt of a step next to the stage one, and the stage one keeps its heading on main', () => {
    const rendered = renderPrompts()
    expect(rendered).toContain('## Implementer - commit after a step that is not the last of a stage with steps')
    expect(rendered).toContain('## Implementer - commit (`git status --porcelain` listed uncommitted changes before a check gate - label `commit <stage> <gate> #<n>`, a repair - or, with no checks or no commit at all, after the implementer')
  })
})
