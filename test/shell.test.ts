import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { shellQuote } from '../src/core/shell'
import { exitMarked, markExit } from '../src/core/engine'

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

describe('the exit marker of a helper shell step', () => {
  const sh = (command: string) => spawnSync('bash', ['-c', markExit(command)], { encoding: 'utf8' }).stdout

  it('prints the exit code last, also when the script exits on its own or fails to cd', () => {
    expect(exitMarked(sh('cd / && echo hi; exit 3'))).toEqual({ code: 3, output: 'hi\n' })
    expect(exitMarked(sh('cd / && echo out; echo err >&2'))).toEqual({ code: 0, output: 'out\nerr\n' })
    expect(exitMarked(sh('cd /no/such/dir && echo never'))!.code).toBe(1)
  })

  it('reads a marker glued to output without a final newline, and the last of several', () => {
    expect(exitMarked(sh('cd / && printf ok'))).toEqual({ code: 0, output: 'ok' })
    expect(exitMarked('said [granny] exit=0\nmore\n[granny] exit=2\n')).toEqual({ code: 2, output: 'said [granny] exit=0\nmore\n' })
    expect(exitMarked('no marker\n')).toBeUndefined()
  })
})
