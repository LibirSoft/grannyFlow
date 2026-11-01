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
    expect(c.roles.reviewer).toEqual({ engine: 'codex' })
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
        'roles.reviewer.engine',
        'must be a string containing {base}',
      ]) {
        expect(message).toContain(part)
      }
    }
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
})
