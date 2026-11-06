import { describe, expect, it } from 'bun:test'
import { judgeConfigGaps } from '../src/core/config'

const agent = (model?: unknown) => ({ name: 'kimi', engine: 'agent', ...(model === undefined ? {} : { model }) })

describe('judgeConfigGaps', () => {
  it('counts the built-in reviewer list as no choice, and names one gap for it', () => {
    expect(judgeConfigGaps([], 'claude-code')).toEqual(['reviewers: no config sets who reviews'])
    expect(judgeConfigGaps([{ threshold: 80 }, undefined], 'claude-code')).toEqual(['reviewers: no config sets who reviews'])
  })

  it('names an agent reviewer with no model for this host', () => {
    const layer = { reviewers: [agent({ opencode: 'k' })], roles: { judge: { model: 'h' } } }
    expect(judgeConfigGaps([layer], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
    expect(judgeConfigGaps([layer], 'opencode')).toEqual([])
  })

  it('does not ask a model of a reviewer that is not an agent', () => {
    const layer = { reviewers: [{ name: 'codex', engine: 'codex' }, { name: 'cmd', engine: 'command', command: 'r {base}' }], roles: { judge: { model: 'h' } } }
    expect(judgeConfigGaps([layer], 'opencode')).toEqual([])
  })

  it('accepts the built-in haiku judge on Claude Code but not on a host it does not name', () => {
    const layer = { reviewers: [agent('k')] }
    expect(judgeConfigGaps([layer], 'claude-code')).toEqual([])
    expect(judgeConfigGaps([layer], 'omp')).toEqual(['roles.judge.model: no model for omp'])
    expect(judgeConfigGaps([layer], 'opencode')).toEqual(['roles.judge.model: no model for opencode'])
  })

  it('sees a judge model taken away by a later layer', () => {
    expect(judgeConfigGaps([{ reviewers: [agent('k')], roles: { judge: { model: null } } }], 'claude-code')).toEqual(['roles.judge.model: no model for claude-code'])
  })

  it('reads the reviewers and the judge across the layers, the last reviewers list winning', () => {
    const user = { reviewers: [agent()], roles: { judge: { model: { omp: 'h' } } } }
    expect(judgeConfigGaps([user], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
    expect(judgeConfigGaps([user, { reviewers: [agent({ omp: 'k' })] }], 'omp')).toEqual([])
  })

  it('names every gap at once', () => {
    expect(judgeConfigGaps([{ reviewers: [agent(), { ...agent(), name: 'other' }] }], 'omp')).toEqual([
      'reviewers[0] (kimi): no model for omp',
      'reviewers[1] (other): no model for omp',
      'roles.judge.model: no model for omp',
    ])
  })

  it('treats an empty model string as no model', () => {
    expect(judgeConfigGaps([{ reviewers: [agent('')], roles: { judge: { model: 'h' } } }], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
  })
})
