import { describe, expect, it } from 'bun:test'
import { isBlocker, parseCodexReview, triage } from '../src/core/review'
import type { Finding } from '../src/core/types'

const REAL = `The patch changes the existing add function to perform subtraction, introducing an arithmetic regression.

Review comment:

- [P1] Restore addition in add — /tmp/repo/math.js:2-2
  \`add\` now subtracts its second argument instead of adding it, breaking its existing behavior. For example, \`add(2, 3)\` returns \`-1\` instead of \`5\`. Restore \`a + b\`.
`

describe('parseCodexReview', () => {
  it('reads a real codex exec review output', () => {
    const { findings, markers } = parseCodexReview(REAL, '/tmp/repo')
    expect(markers).toBe(1)
    expect(findings).toEqual([
      {
        id: 'F1',
        severity: 'P1',
        file: 'math.js',
        line: 2,
        title: 'Restore addition in add',
        detail: '`add` now subtracts its second argument instead of adding it, breaking its existing behavior. For example, `add(2, 3)` returns `-1` instead of `5`. Restore `a + b`.',
      },
    ])
  })

  it('reads several findings, multi-line details, and locations without a line', () => {
    const text = `Review comments:

- [P0] Crash on empty input — src/a.ts:10-14
  First line.
  Second line.
- [P3] Typo in README — README.md
  Fix spelling.

Some closing words.`
    const { findings, markers } = parseCodexReview(text)
    expect(markers).toBe(2)
    expect(findings.map(f => [f.id, f.severity, f.file, f.line, f.detail])).toEqual([
      ['F1', 'P0', 'src/a.ts', 10, 'First line.\nSecond line.'],
      ['F2', 'P3', 'README.md', undefined, 'Fix spelling.'],
    ])
  })

  it('reports clean output as zero markers and zero findings', () => {
    expect(parseCodexReview('I did not find any issues with this change.')).toEqual({ findings: [], markers: 0 })
  })

  it('counts markers it cannot parse so the engine can fall back to extraction', () => {
    const { findings, markers } = parseCodexReview('- [P1] title without a location\n  detail')
    expect(markers).toBe(1)
    expect(findings).toEqual([])
  })
})

describe('triage', () => {
  const f = (id: string, severity: string, score?: number): Finding => ({ id, severity, file: 'a', title: id, detail: '', score })

  it('sends P0/P1 regardless of score and others strictly above the threshold', () => {
    const { accepted, residual } = triage(
      [f('a', 'P1', 5), f('b', 'P2', 70), f('c', 'P2', 71), f('d', 'P3', undefined), f('e', 'critical', 0), f('g', 'P2', 69)],
      70,
    )
    expect(accepted.map(x => x.id)).toEqual(['a', 'c', 'd', 'e'])
    expect(residual.map(x => x.id)).toEqual(['b', 'g'])
  })

  it('recognises blocker severities case-insensitively', () => {
    expect(['P0', 'p1', 'High', 'CRITICAL: x'].every(severity => isBlocker({ severity }))).toBe(true)
    expect(['P2', 'P3', 'medium', ''].some(severity => isBlocker({ severity }))).toBe(false)
  })
})
