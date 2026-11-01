import { describe, expect, it } from 'bun:test'
import { codexCommand, DEFAULT_CONFIG, resolveConfig, resolveModel } from '../src/core/config'

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
    expect(c.roles.reviewer).toEqual({ engine: 'auto' })
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
        { treshold: 70, roles: { jduge: {}, reviewer: { engine: 'gpt', command: 'codex review' } } },
        { threshold: 120, maxRounds: 0, gates: 'yes', workDir: '../x', roles: { judge: { effort: 'huge', model: { cursor: 'x' } } } },
      ])
    expect(run).toThrow(/unknown key "treshold"/)
    try {
      run()
    } catch (e) {
      const message = (e as Error).message
      for (const part of [
        'unknown role "jduge"',
        'threshold must be',
        'maxRounds must be',
        'gates must be',
        'workDir must be',
        'roles.judge.effort',
        'unknown host "cursor"',
        'roles.reviewer.engine must be one of "auto", "codex-plugin", "codex", "agent"',
        'must be a string containing {base}',
      ]) {
        expect(message).toContain(part)
      }
    }
  })
})

describe('reviewer engine, mode and focus', () => {
  const reviewer = (r: Record<string, unknown>, host?: 'claude-code' | 'opencode') => () => resolveConfig([{ roles: { reviewer: r } }], host)

  it('defaults to engine auto and accepts every working combination', () => {
    expect(DEFAULT_CONFIG.roles.reviewer).toEqual({ engine: 'auto' })
    for (const r of [
      { engine: 'codex-plugin' },
      { engine: 'codex-plugin', mode: 'adversarial-review', focus: 'auth and retries' },
      { engine: 'auto', mode: 'adversarial-review' },
      { mode: 'review' },
      { engine: 'codex', mode: 'review', command: 'my-review {base}' },
      { engine: 'auto', command: 'my-review {base}' },
      { engine: 'agent' },
    ]) {
      expect(reviewer(r)).not.toThrow()
      expect(reviewer(r, 'claude-code')).not.toThrow()
    }
    expect(reviewer({ engine: 'codex-plugin', mode: 'adversarial-review' }, 'opencode')).not.toThrow()
    expect(resolveConfig([{ roles: { reviewer: { engine: 'codex-plugin', mode: 'adversarial-review', focus: 'x' } } }]).roles.reviewer).toEqual({
      engine: 'codex-plugin',
      mode: 'adversarial-review',
      focus: 'x',
    })
  })

  const rejects: Array<[string, Record<string, unknown>, string, ('claude-code' | 'opencode')?]> = [
    ['an unknown mode', { mode: 'strict' }, 'roles.reviewer.mode must be "review" or "adversarial-review"'],
    ['an empty focus', { mode: 'adversarial-review', focus: ' ' }, 'roles.reviewer.focus must be a non-empty string'],
    ['a focus that is not a string', { mode: 'adversarial-review', focus: 42 }, 'roles.reviewer.focus must be a non-empty string'],
    ['adversarial-review on the Codex CLI', { engine: 'codex', mode: 'adversarial-review' }, 'mode "adversarial-review" needs the Codex plugin'],
    ['adversarial-review on an agent reviewer', { engine: 'agent', mode: 'adversarial-review' }, 'mode "adversarial-review" needs the Codex plugin'],
    ['a focus on a plain review', { engine: 'codex-plugin', focus: 'auth' }, 'roles.reviewer.focus only works with mode "adversarial-review"'],
    ['a focus with the default mode', { focus: 'auth' }, 'roles.reviewer.focus only works with mode "adversarial-review"'],
    ['a custom command with codex-plugin', { engine: 'codex-plugin', command: 'r {base}' }, 'roles.reviewer.command cannot be combined with engine "codex-plugin"'],
    ['a custom command with adversarial-review', { mode: 'adversarial-review', command: 'r {base}' }, 'a custom roles.reviewer.command runs instead of the plugin'],
    ['adversarial-review on auto on opencode', { mode: 'adversarial-review' }, 'on opencode engine "auto" means the Codex CLI', 'opencode'],
    ['a misspelt reviewer key', { mode: 'adversarial-review', focs: 'x' }, 'unknown key "roles.reviewer.focs"'],
  ]
  for (const [label, r, message, host] of rejects) {
    it(`rejects ${label}`, () => {
      expect(reviewer(r, host)).toThrow(message)
    })
  }
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

describe('codexCommand', () => {
  it('builds the default codex command with and without a model', () => {
    expect(codexCommand(resolveConfig([]), 'abc123', '.granny/r.md')).toBe('codex exec review --base abc123 -o .granny/r.md')
    expect(codexCommand(resolveConfig([{ roles: { reviewer: { model: 'gpt-5.5' } } }]), 'abc', 'o.md')).toBe(
      'codex exec review --base abc -m gpt-5.5 -o o.md',
    )
  })

  it('fills a custom command template', () => {
    const c = resolveConfig([{ roles: { reviewer: { command: 'my-review --since {base} --out {out}' } } }])
    expect(codexCommand(c, 'abc', 'o.md')).toBe('my-review --since abc --out o.md')
  })

  it('shell-quotes every substituted value, once, and keeps replacement patterns literal', () => {
    const c = resolveConfig([{ roles: { reviewer: { model: 'my model', command: 'r --base {base} --out {out} -m {model} {out}' } } }])
    expect(codexCommand(c, 'b{out}', "dir's $& $'/r.md")).toBe(
      `r --base 'b{out}' --out 'dir'\\''s $& $'\\''/r.md' -m 'my model' 'dir'\\''s $& $'\\''/r.md'`,
    )
    expect(codexCommand(resolveConfig([]), 'abc', 'my dir/r.md')).toBe(`codex exec review --base abc -o 'my dir/r.md'`)
  })
})
