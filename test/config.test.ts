import { describe, expect, it } from 'bun:test'
import { DEFAULT_CONFIG, resolveConfig, resolveEffort, resolveModel } from '../src/core/config'
import type { HostName } from '../src/core/types'
import { cliCommand } from '../src/core/reviewer'

describe('resolveConfig', () => {
  it('returns the defaults for no layers', () => {
    expect(resolveConfig([])).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig([undefined, null])).toEqual(DEFAULT_CONFIG)
  })

  it('applies layers in order, merging roles per key and replacing arrays', () => {
    const c = resolveConfig([
      { threshold: 60, roles: { judge: { model: 'opus' }, implementer: { model: 'opus', effort: 'high' } }, gates: ['bun test'] },
      { threshold: 75, roles: { implementer: { effort: 'max' } }, rules: [] },
    ])
    expect(c.threshold).toBe(75)
    expect(c.roles.implementer).toEqual({ model: 'opus', effort: 'max' })
    expect(c.roles.judge).toEqual({ model: 'opus' })
    expect(c.reviewers).toEqual([{ name: 'reviewer', engine: 'agent' }])
    expect(c.gates).toEqual(['bun test'])
    expect(c.rules).toEqual([])
    expect(DEFAULT_CONFIG.threshold).toBe(70)
  })

  it('gives the helper role haiku at low effort on Claude Code, which a layer overrides', () => {
    const helper = resolveConfig([]).roles.helper
    expect(helper).toEqual({ model: { 'claude-code': 'haiku' }, effort: 'low' })
    expect(resolveModel(helper.model, 'claude-code')).toBe('haiku')
    expect(resolveModel(helper.model, 'opencode')).toBeUndefined()
    expect(resolveConfig([{ roles: { helper: { model: 'sonnet', effort: 'medium' } } }]).roles.helper).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(resolveConfig([{ roles: { helper: { effort: null } } }]).roles.helper).toEqual({ model: { 'claude-code': 'haiku' } })
    expect(() => resolveConfig([{ roles: { helper: { modle: 'haiku' } } }])).toThrow('unknown key "roles.helper.modle"')
    expect(() => resolveConfig([{ roles: { helper: { effort: 'tiny' } } }])).toThrow('roles.helper.effort must be one of')
  })

  it('gives the judge haiku on Claude Code only, which a layer overrides', () => {
    const judge = resolveConfig([]).roles.judge
    expect(judge).toEqual({ model: { 'claude-code': 'haiku' } })
    expect(resolveModel(judge.model, 'claude-code')).toBe('haiku')
    expect(resolveModel(judge.model, 'opencode')).toBeUndefined()
    expect(resolveConfig([{ roles: { judge: { model: 'sonnet' } } }]).roles.judge).toEqual({ model: 'sonnet' })
  })

  it('drops a role key set to null', () => {
    expect(resolveConfig([{ roles: { judge: { model: null } } }]).roles.judge).toEqual({})
  })

  it('rejects typos and bad values with every problem listed', () => {
    const run = () =>
      resolveConfig([
        { treshold: 70, roles: { jduge: {} }, reviewers: [{ engine: 'gpt' }, { engine: 'command', command: 'codex review' }] },
        { threshold: 120, maxRounds: 0, gates: 'yes', workDir: '../x', roles: { judge: { effort: 'huge', model: { cursor: 'x' } } } },
      ])
    expect(run).toThrow(/unknown key "treshold"/)
    try {
      run()
    } catch (e) {
      const message = (e as Error).message
      for (const part of [
        'unknown role "jduge" (expected granny, helper, planner, implementer, judge)',
        'threshold must be',
        'maxRounds must be',
        'gates must be',
        'workDir must be',
        'roles.judge.effort',
        'unknown host "cursor"',
        'reviewers[0].engine must be one of "auto", "codex", "codex-plugin", "agent", "command", "opencode"',
        'reviewers[1].command must be a string containing {base} or {prompt}',
      ]) {
        expect(message).toContain(part)
      }
    }
  })
})

describe('reviewers', () => {
  const reviewers = (list: unknown, host?: HostName) => () => resolveConfig([{ reviewers: list }], host)
  const one = (r: Record<string, unknown>, host?: HostName) => reviewers([r], host)

  it('defaults to one agent reviewer on the host model, not Codex', () => {
    expect(DEFAULT_CONFIG.reviewers).toEqual([{ name: 'reviewer', engine: 'agent' }])
    expect('reviewer' in DEFAULT_CONFIG.roles).toBe(false)
  })

  it('replaces the list across layers instead of merging it', () => {
    const c = resolveConfig([
      { reviewers: [{ name: 'codex' }, { name: 'opus', engine: 'agent', model: 'opus' }] },
      { reviewers: [{ name: 'glm', engine: 'command', command: 'opencode run -m opencode/glm-5.3-flash-free {prompt}' }] },
    ])
    expect(c.reviewers).toEqual([{ name: 'glm', engine: 'command', command: 'opencode run -m opencode/glm-5.3-flash-free {prompt}' }])
  })

  it('fills in engine auto and derives a missing name from the engine and the 1-based position', () => {
    const c = resolveConfig([{ reviewers: [{}, { engine: 'agent', model: 'opus' }, { name: 'mine', engine: 'codex' }, { engine: 'command', command: 'x {prompt}' }] }])
    expect(c.reviewers.map(r => [r.name, r.engine])).toEqual([
      ['auto-1', 'auto'],
      ['agent-2', 'agent'],
      ['mine', 'codex'],
      ['command-4', 'command'],
    ])
  })

  it('does not change the layer objects it was given', () => {
    const layer = { reviewers: [{ engine: 'agent' }] }
    resolveConfig([layer])
    expect(layer).toEqual({ reviewers: [{ engine: 'agent' }] })
  })

  it('accepts every working combination', () => {
    for (const r of [
      { engine: 'codex-plugin' },
      { engine: 'codex-plugin', mode: 'adversarial-review', focus: 'auth and retries' },
      { engine: 'auto', mode: 'adversarial-review' },
      { mode: 'review' },
      { engine: 'codex', model: 'gpt-5.5' },
      { engine: 'codex', model: { opencode: 'gpt-5.5' } },
      { engine: 'agent', model: { 'claude-code': 'opus', opencode: 'zai/glm-5' }, effort: 'high' },
      { engine: 'command', command: 'my-review {base}' },
      { engine: 'command', command: 'claude -p {prompt}', model: 'opus' },
      { engine: 'command', command: 'gemini -p {prompt} > {out}' },
    ]) {
      expect(one(r)).not.toThrow()
      expect(one(r, 'claude-code')).not.toThrow()
    }
    expect(one({ engine: 'codex-plugin', mode: 'adversarial-review' }, 'opencode')).not.toThrow()
    expect(resolveConfig([{ reviewers: [{ name: 'adv', engine: 'codex-plugin', mode: 'adversarial-review', focus: 'x' }] }]).reviewers).toEqual([
      { name: 'adv', engine: 'codex-plugin', mode: 'adversarial-review', focus: 'x' },
    ])
  })

  it('runs an opencode reviewer on every host, omp included, on a provider/model with an effort or a #variant', () => {
    for (const r of [
      { engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro' },
      { engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' },
      { engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro#max' },
      { engine: 'opencode', model: 'openrouter/moonshotai/kimi-k3' },
      { engine: 'opencode', model: { 'claude-code': 'zai/glm-5.3', opencode: 'zai/glm-5.3', omp: 'zai/glm-5.3' } },
    ]) {
      expect(one(r)).not.toThrow()
      for (const host of ['claude-code', 'opencode', 'omp'] as const) expect(one(r, host)).not.toThrow()
    }
    const keyed = { name: 'kimi', engine: 'opencode' as const, model: { 'claude-code': 'zai/glm-5.3#max', omp: 'zai/glm-5.3' }, effort: { omp: 'high' } }
    expect(resolveConfig([{ reviewers: [keyed] }], 'omp').reviewers).toEqual([keyed])
    expect(resolveConfig([{ reviewers: [{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' }] }], 'omp').reviewers).toEqual([
      { name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' },
    ])
    expect(resolveConfig([{ reviewers: [{ engine: 'opencode', model: 'zai/glm-5.3' }] }]).reviewers[0]!.name).toBe('opencode-1')
  })

  it('accepts any number of reviewers of any engine', () => {
    const list = [
      { name: 'codex' },
      { name: 'plugin', engine: 'codex-plugin' },
      { name: 'cli', engine: 'codex' },
      { name: 'opus', engine: 'agent', model: 'opus' },
      { name: 'glm', engine: 'command', command: 'opencode run -m opencode/glm-5.3-flash-free {prompt}' },
    ]
    expect(resolveConfig([{ reviewers: list }], 'claude-code').reviewers.map(r => r.name)).toEqual(['codex', 'plugin', 'cli', 'opus', 'glm'])
  })

  it('names roles.reviewer and the way to migrate it', () => {
    const run = () => resolveConfig([{ roles: { reviewer: { engine: 'codex', command: 'r {base}' } } }])
    expect(run).toThrow('config layer 1: roles.reviewer was replaced by "reviewers": [{ "name": "codex", ...the same keys }]')
    expect(run).toThrow('a custom command needs "engine": "command"')
    expect(() => resolveConfig([{}, { roles: { reviewer: null } }])).toThrow('config layer 2: roles.reviewer was replaced by "reviewers"')
  })

  const rejects: Array<[string, unknown, string, HostName?]> = [
    ['a list that is not an array', { name: 'codex' }, 'reviewers must be a non-empty array of reviewer objects'],
    ['an empty list', [], 'reviewers must be a non-empty array of reviewer objects'],
    ['an entry that is not an object', ['codex'], 'reviewers[0] must be an object'],
    ['a misspelt key', [{ engine: 'codex-plugin', mode: 'adversarial-review', focs: 'x' }], 'unknown key "reviewers[0].focs"'],
    ['a name with capitals', [{ name: 'Opus' }], 'reviewers[0].name must be a non-empty string of a-z, 0-9 and -'],
    ['a name with a space', [{ name: 'my reviewer' }], 'reviewers[0].name must be a non-empty string of a-z, 0-9 and -'],
    ['an empty name', [{ name: '' }], 'reviewers[0].name must be a non-empty string of a-z, 0-9 and -'],
    ['two reviewers with one name', [{ name: 'codex' }, { name: 'x', engine: 'agent' }, { name: 'codex', engine: 'agent' }], 'reviewers[2].name "codex" is already used by reviewers[0]'],
    ['an explicit name equal to a derived one', [{ engine: 'agent' }, { name: 'agent-1', engine: 'agent' }], 'reviewers[1].name "agent-1" is already used by reviewers[0]'],
    ['a bad model', [{ engine: 'agent', model: { cursor: 'x' } }], 'reviewers[0].model: unknown host "cursor"'],
    ['a model that is not a string', [{ engine: 'agent', model: 5 }], 'reviewers[0].model must be a string or an object keyed by host'],
    ['a bad effort', [{ engine: 'agent', effort: 'huge' }], 'reviewers[0].effort must be one of low, medium, high, xhigh, max'],
    ['an unknown mode', [{ mode: 'strict' }], 'reviewers[0].mode must be "review" or "adversarial-review"'],
    ['an empty focus', [{ mode: 'adversarial-review', focus: ' ' }], 'reviewers[0].focus must be a non-empty string'],
    ['a focus that is not a string', [{ mode: 'adversarial-review', focus: 42 }], 'reviewers[0].focus must be a non-empty string'],
    ['a mode on the Codex CLI', [{ engine: 'codex', mode: 'adversarial-review' }], 'reviewers[0].mode needs the Codex plugin; engine "codex" cannot run it'],
    ['a mode on an agent reviewer', [{ engine: 'agent', mode: 'review' }], 'reviewers[0].mode needs the Codex plugin; engine "agent" cannot run it'],
    ['a mode on a command reviewer', [{ engine: 'command', command: 'r {base}', mode: 'adversarial-review' }], 'reviewers[0].mode needs the Codex plugin; engine "command" cannot run it'],
    ['a focus on a plain review', [{ engine: 'codex-plugin', focus: 'auth' }], 'reviewers[0].focus only works with mode "adversarial-review"'],
    ['a focus with the default mode', [{ focus: 'auth' }], 'reviewers[0].focus only works with mode "adversarial-review"'],
    ['a command reviewer without a command', [{ engine: 'command' }], 'reviewers[0].command is required for engine "command"'],
    ['a command without {base} or {prompt}', [{ engine: 'command', command: 'codex review' }], 'reviewers[0].command must be a string containing {base} or {prompt}'],
    ['a command that is not a string', [{ engine: 'command', command: ['r', '{base}'] }], 'reviewers[0].command must be a string containing {base} or {prompt}'],
    ['a command on the Codex CLI engine', [{ engine: 'codex', command: 'r {base}' }], 'reviewers[0].command needs "engine": "command"'],
    ['a command on engine auto', [{ command: 'r {base}' }], 'reviewers[0].command needs "engine": "command"'],
    ['a command on the Codex plugin', [{ engine: 'codex-plugin', command: 'r {base}' }], 'reviewers[0].command needs "engine": "command"'],
    ['a command on an agent reviewer', [{ engine: 'agent', command: 'r {prompt}' }], 'reviewers[0].command needs "engine": "command"'],
    ['adversarial-review on auto on opencode', [{ name: 'c' }, { mode: 'adversarial-review' }], 'reviewers[1].mode "adversarial-review" needs the Codex plugin, and on opencode engine "auto" means the Codex CLI - set reviewers[1].engine to "codex-plugin"', 'opencode'],
    ['an entry without engine on omp', [{ engine: 'agent' }, { name: 'c' }], 'reviewers[1].engine "auto" (the engine of an entry that names none) runs Codex, which granny does not run on omp - use "engine": "agent" with an omp model, e.g. "model": { "omp": "openai-codex/gpt-6.1-sol" }, "engine": "opencode" for a model opencode reaches and omp does not, e.g. "model": "openai/gpt-6.1-sol", or "engine": "command"', 'omp'],
    ['engine auto on omp', [{ engine: 'auto', mode: 'adversarial-review' }], 'reviewers[0].engine "auto" runs Codex, which granny does not run on omp', 'omp'],
    ['the Codex CLI on omp', [{ engine: 'codex' }], 'reviewers[0].engine "codex" runs Codex, which granny does not run on omp', 'omp'],
    ['the Codex plugin on omp', [{ engine: 'codex-plugin' }], 'reviewers[0].engine "codex-plugin" runs Codex, which granny does not run on omp', 'omp'],
    ['an opencode reviewer without a model', [{ engine: 'opencode' }], 'reviewers[0].model is required for engine "opencode": an opencode model "provider/model", e.g. "zai/glm-5.3" - `opencode models` lists them'],
    ['an opencode model without a provider', [{ engine: 'opencode', model: 'glm-5.3' }], 'reviewers[0].model "glm-5.3" is not an opencode model "provider/model" (optionally "#variant") - `opencode models` lists them'],
    ['an opencode model with an empty variant', [{ engine: 'opencode', model: 'zai/glm-5.3#' }], 'reviewers[0].model "zai/glm-5.3#" is not an opencode model "provider/model"'],
    ['an opencode model with a space', [{ engine: 'opencode', model: { opencode: 'zai/glm 5.3' } }], 'reviewers[0].model "zai/glm 5.3" is not an opencode model "provider/model"'],
    ['an opencode model with a variant and an effort', [{ engine: 'opencode', model: 'zai/glm-5.3#max', effort: 'high' }], 'reviewers[0]: model "zai/glm-5.3#max" names the variant "max" and effort "high" names another - keep one of them'],
    ['an opencode model with a variant and a host-keyed effort', [{ engine: 'opencode', model: 'zai/glm-5.3#max', effort: { omp: 'high' } }], 'reviewers[0]: model "zai/glm-5.3#max" names the variant "max" and effort "high" names another - keep one of them'],
    [
      'an opencode model with a variant on the host its effort is keyed to',
      [{ engine: 'opencode', model: { 'claude-code': 'zai/glm-5.3', omp: 'zai/glm-5.3#max' }, effort: { omp: 'high' } }],
      'reviewers[0]: model "zai/glm-5.3#max" names the variant "max" and effort "high" names another - keep one of them',
    ],
    ['an opencode model keyed to other hosts only', [{ engine: 'opencode', model: { opencode: 'zai/glm-5.3' } }], 'reviewers[0].model has no entry for claude-code - engine "opencode" needs a model on every host it runs on; a plain string applies to all of them', 'claude-code'],
    ['a mode on an opencode reviewer', [{ engine: 'opencode', model: 'zai/glm-5.3', mode: 'review' }], 'reviewers[0].mode needs the Codex plugin; engine "opencode" cannot run it'],
    ['a focus on an opencode reviewer', [{ engine: 'opencode', model: 'zai/glm-5.3', focus: 'auth' }], 'reviewers[0].focus only works with mode "adversarial-review"'],
    ['a command on an opencode reviewer', [{ engine: 'opencode', model: 'zai/glm-5.3', command: 'r {prompt}' }], 'reviewers[0].command needs "engine": "command"; engine "opencode" runs its own reviewer'],
  ]
  for (const [label, list, message, host] of rejects) {
    it(`rejects ${label}`, () => {
      expect(reviewers(list, host)).toThrow(message)
    })
  }
})

describe('worktree', () => {
  it('is on by default, with the worktree dir derived from the repo at run time', () => {
    expect(DEFAULT_CONFIG.worktree).toBe(true)
    expect(resolveConfig([]).worktreeDir).toBeUndefined()
  })

  it('takes worktree and an absolute or relative worktreeDir from any layer', () => {
    expect(resolveConfig([{ worktree: false }]).worktree).toBe(false)
    expect(resolveConfig([{ worktreeDir: '/srv/wt' }, { worktree: true }])).toMatchObject({ worktree: true, worktreeDir: '/srv/wt' })
    expect(resolveConfig([{ worktreeDir: '/srv/wt' }, { worktreeDir: 'my worktrees' }]).worktreeDir).toBe('my worktrees')
  })

  for (const [label, layer, message] of [
    ['a worktree that is not a boolean', { worktree: 'yes' }, 'worktree must be a boolean'],
    ['an empty worktreeDir', { worktreeDir: ' ' }, 'worktreeDir must be a non-empty path'],
    ['a worktreeDir that is not a string', { worktreeDir: 5 }, 'worktreeDir must be a non-empty path'],
    ['a worktreeDir that starts with ~', { worktreeDir: '~/wt' }, 'worktreeDir is not expanded by a shell - write the absolute path instead of ~'],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => resolveConfig([layer])).toThrow(message)
    })
  }
})

describe('planReview', () => {
  it('is off by default and takes a boolean from any layer', () => {
    expect(DEFAULT_CONFIG.planReview).toBe(false)
    expect(resolveConfig([]).planReview).toBe(false)
    expect(resolveConfig([{ planReview: true }]).planReview).toBe(true)
    expect(resolveConfig([{ planReview: true }, { planReview: false }]).planReview).toBe(false)
  })

  it('rejects a planReview that is not a boolean', () => {
    expect(() => resolveConfig([{ planReview: 'yes' }])).toThrow('planReview must be a boolean')
  })
})

describe('finalReview', () => {
  it('is on by default and takes a boolean from any layer', () => {
    expect(DEFAULT_CONFIG.finalReview).toBe(true)
    expect(resolveConfig([]).finalReview).toBe(true)
    expect(resolveConfig([{ finalReview: false }]).finalReview).toBe(false)
    expect(resolveConfig([{ finalReview: false }, { finalReview: true }]).finalReview).toBe(true)
  })

  it('rejects a finalReview that is not a boolean', () => {
    expect(() => resolveConfig([{ finalReview: 'no' }])).toThrow('finalReview must be a boolean')
  })
})

describe('trail', () => {
  it('is on by default and takes a boolean from any layer', () => {
    expect(DEFAULT_CONFIG.trail).toBe(true)
    expect(resolveConfig([]).trail).toBe(true)
    expect(resolveConfig([{ trail: false }]).trail).toBe(false)
    expect(resolveConfig([{ trail: false }, { trail: true }]).trail).toBe(true)
  })

  it('rejects a trail that is not a boolean', () => {
    expect(() => resolveConfig([{ trail: 'no' }])).toThrow('trail must be a boolean')
  })
})

describe('resolveModel', () => {
  it('uses a plain string on every host and picks the host key from an object', () => {
    expect(resolveModel('sonnet', 'claude-code')).toBe('sonnet')
    expect(resolveModel('sonnet', 'opencode')).toBe('sonnet')
    const spec = { 'claude-code': 'opus', opencode: 'anthropic/claude-opus-5-5' }
    expect(resolveModel(spec, 'claude-code')).toBe('opus')
    expect(resolveModel(spec, 'opencode')).toBe('anthropic/claude-opus-5-5')
    expect(resolveModel({ 'claude-code': 'opus' }, 'opencode')).toBeUndefined()
    expect(resolveModel(undefined, 'opencode')).toBeUndefined()
  })

  it('takes an omp key in role and reviewer models and resolves it on omp only, while an unknown host key still fails', () => {
    const c = resolveConfig(
      [{ roles: { judge: { model: { omp: 'anthropic/claude-sonnet-5-5' } } }, reviewers: [{ engine: 'agent', model: { opencode: 'zai/glm-5', omp: 'zai/glm-5.3' } }] }],
      'omp',
    )
    expect(resolveModel(c.roles.judge.model, 'omp')).toBe('anthropic/claude-sonnet-5-5')
    expect(resolveModel(c.roles.judge.model, 'opencode')).toBeUndefined()
    expect(resolveModel(c.roles.judge.model, 'claude-code')).toBeUndefined()
    expect(resolveModel(c.reviewers[0]!.model, 'omp')).toBe('zai/glm-5.3')
    expect(resolveModel(resolveConfig([], 'omp').roles.helper.model, 'omp')).toBeUndefined()
    expect(() => resolveConfig([{ roles: { judge: { model: { pi: 'x' } } } }], 'omp')).toThrow('roles.judge.model: unknown host "pi"')
  })

  it('runs agent and command reviewers on omp, and the Codex engines on the other hosts only', () => {
    expect(resolveConfig([], 'omp').reviewers).toEqual([{ name: 'reviewer', engine: 'agent' }])
    const omp = [{ reviewers: [{ name: 'gpt', engine: 'agent', model: { omp: 'openai-codex/gpt-6.1-sol' } }, { name: 'glm', engine: 'command', command: 'opencode run {prompt}' }] }]
    expect(resolveConfig(omp, 'omp').reviewers.map(r => r.engine)).toEqual(['agent', 'command'])
    for (const host of ['claude-code', 'opencode'] as const) {
      expect(resolveConfig([{ reviewers: [{ engine: 'codex' }, { engine: 'codex-plugin' }, {}] }], host).reviewers.map(r => r.engine)).toEqual(['codex', 'codex-plugin', 'auto'])
    }
  })
})

describe('effort per host', () => {
  const hosts = ['claude-code', 'opencode', 'omp'] as const
  const errorOf = (layers: unknown[]) => {
    try {
      resolveConfig(layers)
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('expected resolveConfig to throw')
  }

  it('uses a plain string on every host and picks the host key from an object', () => {
    for (const host of hosts) expect(resolveEffort('high', host)).toBe('high')
    const spec = { 'claude-code': 'high', omp: 'medium' }
    expect(resolveEffort(spec, 'claude-code')).toBe('high')
    expect(resolveEffort(spec, 'omp')).toBe('medium')
    expect(resolveEffort(spec, 'opencode')).toBeUndefined()
    for (const host of hosts) {
      expect(resolveEffort(undefined, host)).toBeUndefined()
      expect(resolveEffort({}, host)).toBeUndefined()
    }
  })

  it('accepts the host-keyed form in a role and a reviewer entry on every host and keeps it as written', () => {
    const layers = [{ roles: { implementer: { effort: { 'claude-code': 'high', omp: 'medium' } } }, reviewers: [{ engine: 'agent', effort: { omp: 'xhigh', opencode: 'low' } }] }]
    for (const host of hosts) {
      const c = resolveConfig(layers, host)
      expect(c.roles.implementer.effort).toEqual({ 'claude-code': 'high', omp: 'medium' })
      expect(c.reviewers[0]!.effort).toEqual({ omp: 'xhigh', opencode: 'low' })
    }
  })

  it('replaces a lower layer\'s effort whole, string or object', () => {
    const effort = (layers: unknown[]) => resolveConfig(layers).roles.implementer.effort
    expect(effort([{ roles: { implementer: { effort: 'high' } } }, { roles: { implementer: { effort: { omp: 'medium' } } } }])).toEqual({ omp: 'medium' })
    expect(effort([{ roles: { implementer: { effort: { omp: 'medium' } } } }, { roles: { implementer: { effort: 'high' } } }])).toBe('high')
    expect(effort([{ roles: { implementer: { effort: { 'claude-code': 'high' } } } }, { roles: { implementer: { effort: { omp: 'medium' } } } }])).toEqual({ omp: 'medium' })
    const helper = resolveConfig([{ roles: { helper: { effort: { omp: 'medium' } } } }]).roles.helper
    expect(resolveEffort(helper.effort, 'claude-code')).toBeUndefined()
    expect(resolveEffort(helper.effort, 'omp')).toBe('medium')
    expect(effort([{ roles: { implementer: { effort: { omp: 'medium' } } } }, { roles: { implementer: { effort: null } } }])).toBeUndefined()
  })

  it('rejects an unknown host and a bad value with the entry and the config layer', () => {
    expect(errorOf([{}, { roles: { judge: { effort: { cursor: 'high' } } } }])).toContain('config layer 2: roles.judge.effort: unknown host "cursor"')
    expect(errorOf([{ roles: { judge: { effort: { omp: 'huge' } } } }])).toContain('config layer 1: roles.judge.effort.omp must be one of low, medium, high, xhigh, max')
    expect(errorOf([{ roles: { judge: { effort: { opencode: 'huge' } } } }])).toContain('config layer 1: roles.judge.effort.opencode must be one of low, medium, high, xhigh, max')
    for (const effort of [5, ['high'], true, 'huge']) {
      expect(errorOf([{ roles: { judge: { effort } } }])).toContain(
        'config layer 1: roles.judge.effort must be one of low, medium, high, xhigh, max, or an object of those keyed by host',
      )
    }
    const both = errorOf([{ reviewers: [{ engine: 'agent' }] }, { reviewers: [{ engine: 'agent', effort: { omp: 'huge', pi: 'low' } }] }])
    expect(both).toContain('config layer 2: reviewers[0].effort.omp must be one of low, medium, high, xhigh, max')
    expect(both).toContain('config layer 2: reviewers[0].effort: unknown host "pi"')
    expect(errorOf([{ reviewers: [{ engine: 'agent', effort: null }] }])).toContain('config layer 1: reviewers[0].effort must be one of')
  })

  it('names the last layer that set the effort, and ignores a bad one a higher layer replaced', () => {
    expect(errorOf([{ roles: { judge: { effort: 'low' } } }, {}, { roles: { judge: { effort: { omp: 'x' } } } }, { roles: { judge: { model: 'opus' } } }])).toContain(
      'config layer 3: roles.judge.effort.omp',
    )
    expect(() => resolveConfig([{ reviewers: [{ engine: 'agent', effort: 'huge' }] }, { reviewers: [{ engine: 'agent' }] }])).not.toThrow()
    expect(() => resolveConfig([{ roles: { judge: { effort: 'huge' } } }, { roles: { judge: { effort: 'low' } } }])).not.toThrow()
  })
})

describe('cliCommand', () => {
  const reviewer = (r: Record<string, unknown>) => resolveConfig([{ reviewers: [r] }]).reviewers[0]!

  it('builds the default codex command with and without a model', () => {
    expect(cliCommand(reviewer({ engine: 'codex' }), 'opencode', 'abc123', '.granny/r.md')).toBe('codex exec review --base abc123 -o .granny/r.md')
    expect(cliCommand(reviewer({ engine: 'codex', model: 'gpt-5.5' }), 'opencode', 'abc', 'o.md')).toBe('codex exec review --base abc -m gpt-5.5 -o o.md')
  })

  it("picks the host's model from a per-host model object", () => {
    const rv = reviewer({ engine: 'codex', model: { opencode: 'gpt-5.5' } })
    expect(cliCommand(rv, 'opencode', 'abc', 'o.md')).toBe('codex exec review --base abc -m gpt-5.5 -o o.md')
    expect(cliCommand(rv, 'claude-code', 'abc', 'o.md')).toBe('codex exec review --base abc -o o.md')
  })

  it('fills a command template', () => {
    expect(cliCommand(reviewer({ engine: 'command', command: 'my-review --since {base} --out {out}' }), 'opencode', 'abc', 'o.md')).toBe('my-review --since abc --out o.md')
  })

  it('fills {prompt} with the review prompt as one shell word', () => {
    const rv = reviewer({ engine: 'command', command: 'opencode run -m {model} {prompt}', model: 'opencode/glm-5.3-flash-free' })
    expect(cliCommand(rv, 'opencode', 'abc', 'o.md', "Review `git diff abc...HEAD`; it's $HOME")).toBe(
      `opencode run -m opencode/glm-5.3-flash-free 'Review \`git diff abc...HEAD\`; it'\\''s $HOME'`,
    )
  })

  it('shell-quotes every substituted value, once, and keeps replacement patterns literal', () => {
    const rv = reviewer({ engine: 'command', model: 'my model', command: 'r --base {base} --out {out} -m {model} {out} {prompt}' })
    expect(cliCommand(rv, 'opencode', 'b{out}', "dir's $& $'/r.md", '{base} $&')).toBe(
      `r --base 'b{out}' --out 'dir'\\''s $& $'\\''/r.md' -m 'my model' 'dir'\\''s $& $'\\''/r.md' '{base} $&'`,
    )
    expect(cliCommand(reviewer({ engine: 'codex' }), 'opencode', 'abc', 'my dir/r.md')).toBe(`codex exec review --base abc -o 'my dir/r.md'`)
  })
})

describe('alwaysFix', () => {
  it('fixes critical and major findings by default and takes any list of impact classes from a layer', () => {
    expect(resolveConfig([]).alwaysFix).toEqual(['critical', 'major'])
    expect(resolveConfig([{ alwaysFix: [] }]).alwaysFix).toEqual([])
    expect(resolveConfig([{ alwaysFix: ['critical'] }, { alwaysFix: ['critical', 'moderate'] }]).alwaysFix).toEqual(['critical', 'moderate'])
  })

  it.each([
    ['an unknown impact class', ['critical', 'severe'], 'alwaysFix must be an array of impact classes (critical, major, moderate, minor, none)'],
    ['a string', 'critical', 'alwaysFix must be an array of impact classes'],
    ['a non-string entry', [1], 'alwaysFix must be an array of impact classes'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => resolveConfig([{ alwaysFix: value }])).toThrow(message)
  })
})

describe('watch', () => {
  it('defaults to "full" and takes "panel" or "off" from a layer', () => {
    expect(resolveConfig([]).watch).toBe('full')
    expect(resolveConfig([{ watch: 'panel' }]).watch).toBe('panel')
    expect(resolveConfig([{ watch: 'off' }, { watch: 'full' }]).watch).toBe('full')
  })

  it.each([['an unknown mode', 'live'], ['a boolean', false], ['null', null]])('rejects %s with the allowed values', (_label, value) => {
    expect(() => resolveConfig([{ watch: value }])).toThrow('watch must be "full", "panel" or "off"')
  })

  it('is accepted, and ignored, on Claude Code and opencode', () => {
    for (const host of ['claude-code', 'opencode', 'omp'] as HostName[]) expect(resolveConfig([{ watch: 'off' }], host).watch).toBe('off')
  })
})
