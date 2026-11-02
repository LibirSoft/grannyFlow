import { describe, expect, it } from 'bun:test'
import { DEFAULT_CONFIG, resolveConfig, resolveModel } from '../src/core/config'
import { cliCommand } from '../src/core/reviewer'

describe('resolveConfig', () => {
  it('returns the defaults for no layers', () => {
    expect(resolveConfig([])).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig([undefined, null])).toEqual(DEFAULT_CONFIG)
  })

  it('applies layers in order, merging roles per key and replacing arrays', () => {
    const c = resolveConfig([
      { threshold: 60, roles: { judge: { model: 'haiku' }, implementer: { model: 'opus', effort: 'high' } }, gates: ['bun test'] },
      { threshold: 75, roles: { implementer: { effort: 'max' } }, rules: [] },
    ])
    expect(c.threshold).toBe(75)
    expect(c.roles.implementer).toEqual({ model: 'opus', effort: 'max' })
    expect(c.roles.judge).toEqual({ model: 'haiku' })
    expect(c.reviewers).toEqual([{ name: 'codex', engine: 'auto' }])
    expect(c.gates).toEqual(['bun test'])
    expect(c.rules).toEqual([])
    expect(DEFAULT_CONFIG.threshold).toBe(70)
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
        'unknown role "jduge" (expected granny, planner, implementer, judge)',
        'threshold must be',
        'maxRounds must be',
        'gates must be',
        'workDir must be',
        'roles.judge.effort',
        'unknown host "cursor"',
        'reviewers[0].engine must be one of "auto", "codex", "codex-plugin", "agent", "command"',
        'reviewers[1].command must be a string containing {base} or {prompt}',
      ]) {
        expect(message).toContain(part)
      }
    }
  })
})

describe('reviewers', () => {
  const reviewers = (list: unknown, host?: 'claude-code' | 'opencode') => () => resolveConfig([{ reviewers: list }], host)
  const one = (r: Record<string, unknown>, host?: 'claude-code' | 'opencode') => reviewers([r], host)

  it('defaults to one Codex reviewer on engine auto', () => {
    expect(DEFAULT_CONFIG.reviewers).toEqual([{ name: 'codex', engine: 'auto' }])
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

  const rejects: Array<[string, unknown, string, ('claude-code' | 'opencode')?]> = [
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
