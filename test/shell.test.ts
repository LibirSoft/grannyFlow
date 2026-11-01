import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { shellQuote } from '../src/core/shell'

describe('shellQuote', () => {
  it('leaves plain paths, refs and model names as they are', () => {
    for (const s of ['/home/me/repo', '.granny/review-core-r1.md', 'main', 'feat/x', 'a1b2c3', 'gpt-5.5', 'user@host:1,2+3=4%']) {
      expect(shellQuote(s)).toBe(s)
    }
  })

  it('single-quotes everything else so bash reads back the exact string', () => {
    expect(shellQuote("my repo's")).toBe(`'my repo'\\''s'`)
    const nasty = ["my repo's", '', ' ', "'", "''", '$HOME', '`id`', '$(id)', 'a;b', 'a && b', 'x\ny', '*', '~', '!x', '\\', '"', "it's $HOME/`x` $& $'"]
    for (const s of nasty) {
      const quoted = shellQuote(s)
      expect(quoted.startsWith("'")).toBe(true)
      expect(spawnSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }).stdout).toBe(s)
    }
  })
})
