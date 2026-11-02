import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isBlocker, parseCodexReview, reviewFailure, saysNoFindings, triage } from '../src/core/review'
import type { Finding } from '../src/core/types'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
const crlf = (text: string) => text.replace(/\n/g, '\r\n')

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

  it('recognises a review that says it has no findings, on a line of its own', () => {
    for (const text of ['No findings.', 'no findings', '  No Findings.  \n', '# Codex Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nNo material findings.\n', '[granny] reviewer: codex CLI\nNo findings.']) {
      expect(saysNoFindings(text)).toBe(true)
    }
    for (const text of ['', 'I did not find any issues with this change.', 'No findings. But the cache key is wrong.', 'Findings: none worth a fix']) {
      expect(saysNoFindings(text)).toBe(false)
    }
  })

  it('counts markers it cannot parse so the engine can fall back to extraction', () => {
    const { findings, markers } = parseCodexReview('- [P1] title without a location\n  detail')
    expect(markers).toBe(1)
    expect(findings).toEqual([])
  })

  it('reads a [Px] bullet nested in a finding detail as detail, not as another finding', () => {
    const text = `Review comments:

- [P2] Guard the cache — src/a.ts:3-3
  An earlier round reported:
  - [P1] stale entry survives a reload
  * [P0] Wrong file — src/b.ts:9
  and this one is still open, unlike the [P1] above.
- [P3] Typo — README.md
  Fix it.`
    const { findings, markers } = parseCodexReview(text)
    expect(markers).toBe(2)
    expect(findings.map(f => [f.id, f.severity, f.file, f.title])).toEqual([
      ['F1', 'P2', 'src/a.ts', 'Guard the cache'],
      ['F2', 'P3', 'README.md', 'Typo'],
    ])
    expect(findings[0]!.detail).toBe(
      'An earlier round reported:\n- [P1] stale entry survives a reload\n* [P0] Wrong file — src/b.ts:9\nand this one is still open, unlike the [P1] above.',
    )
  })

  it('keeps nested bullets inside an unparseable finding out of the marker count', () => {
    const { findings, markers } = parseCodexReview('- [P1] title without a location\n  - [P2] quoted line\n- [P2] Real — a.ts:1\n  d')
    expect(markers).toBe(2)
    expect(findings.map(f => f.title)).toEqual(['Real'])
  })

  it('reads CRLF output in the `[P1] Title — file:line` form', () => {
    const text = crlf('Review comments:\n\n- [P1] Restore addition — /tmp/repo/math.js:2-2\n  First line.\n  Second line.\n- [P3] Typo — README.md\n  Fix it.\n')
    const { findings, markers } = parseCodexReview(text, '/tmp/repo')
    expect(markers).toBe(2)
    expect(findings).toEqual([
      { id: 'F1', severity: 'P1', file: 'math.js', line: 2, title: 'Restore addition', detail: 'First line.\nSecond line.' },
      { id: 'F2', severity: 'P3', file: 'README.md', title: 'Typo', detail: 'Fix it.' },
    ])
    expect(parseCodexReview(crlf(REAL), '/tmp/repo')).toEqual(parseCodexReview(REAL, '/tmp/repo'))
  })

  it('still counts an indented list of findings', () => {
    const { findings, markers } = parseCodexReview('Review comments:\n  - [P1] A — a.ts:1\n    detail a\n  - [P2] B — b.ts:2\n    detail b')
    expect(markers).toBe(2)
    expect(findings.map(f => [f.title, f.detail])).toEqual([
      ['A', 'detail a'],
      ['B', 'detail b'],
    ])
  })
})

describe('parseCodexReview on Codex plugin output', () => {
  it('reads a real `codex-companion review` output', () => {
    const { findings, markers } = parseCodexReview(fixture('codex-plugin-review.md'), '/tmp/granny-fixture')
    expect(markers).toBe(2)
    expect(findings.map(f => [f.id, f.severity, f.file, f.line, f.title])).toEqual([
      ['F1', 'P1', 'cart.js', 3, 'Include the first item in the cart total'],
      ['F2', 'P2', 'cart.js', 8, 'Restore discount percentage bounds validation'],
    ])
    expect(findings[0]!.detail).toStartWith('Starting the loop at index 1 skips the first item')
  })

  it('reads a real `codex-companion adversarial-review` output, recommendation included, next steps left out', () => {
    const { findings, markers } = parseCodexReview(fixture('codex-plugin-adversarial-review.md'))
    expect(markers).toBe(2)
    expect(findings.map(f => [f.id, f.severity, f.file, f.line, f.title])).toEqual([
      ['F1', 'P1', 'cart.js', 3, 'Cart totals exclude the first item'],
      ['F2', 'P1', 'cart.js', 7, 'Out-of-range discounts now produce invalid totals'],
    ])
    expect(findings[0]!.detail).toBe(
      'Starting the loop at index 1 skips items[0] in every cart. A single item priced at 25 with quantity 2 returns 0 instead of 50; adding a second line worth 30 returns 30 instead of 80. Any downstream use of this total receives an understated amount.\nRecommendation: Start iteration at index 0 and add regression coverage for single-item and multiple-item totals.',
    )
    expect(findings.every(isBlocker)).toBe(true)
  })

  it('maps critical/high/medium/low to P0-P3 and reads the location from the last parentheses', () => {
    const text = `Findings:
- [critical] Token leaks — src/auth.ts:9
  Body.
- [High] Retry loop (re-entrant) ignores cancel (src/run.ts:4-6)
  Body.
  Recommendation: Check the signal.
- [medium] Cache never expires — split — here (cache.ts)
  Body.
- [LOW] Missing file in render (unknown)
  No details provided.

Next steps:
- Fix the leak first.

Reasoning:
- The [high] severity was chosen because tokens leak.`
    const { findings, markers } = parseCodexReview(text)
    expect(markers).toBe(4)
    expect(findings.map(f => [f.severity, f.file, f.line, f.title])).toEqual([
      ['P0', 'src/auth.ts', 9, 'Token leaks'],
      ['P1', 'src/run.ts', 4, 'Retry loop (re-entrant) ignores cancel'],
      ['P2', 'cache.ts', undefined, 'Cache never expires — split — here'],
      ['P3', 'unknown', undefined, 'Missing file in render'],
    ])
    expect(findings[1]!.detail).toBe('Body.\nRecommendation: Check the signal.')
  })

  it('reads CRLF output in the adversarial `[high] Title (file:12-14)` form', () => {
    const text = crlf('Findings:\n- [high] Retry loop ignores cancel (src/run.ts:12-14)\n  Body.\n  Recommendation: Check the signal.\n- [low] Nit (a.ts)\n  d\n\nNext steps:\n- Fix it.\n')
    const { findings, markers } = parseCodexReview(text)
    expect(markers).toBe(2)
    expect(findings).toEqual([
      { id: 'F1', severity: 'P1', file: 'src/run.ts', line: 12, title: 'Retry loop ignores cancel', detail: 'Body.\nRecommendation: Check the signal.' },
      { id: 'F2', severity: 'P3', file: 'a.ts', title: 'Nit', detail: 'd' },
    ])
    const real = fixture('codex-plugin-adversarial-review.md')
    expect(parseCodexReview(crlf(real))).toEqual(parseCodexReview(real))
  })

  it('keeps [Px] findings on the em-dash form and other bracketed words out of the count', () => {
    const { findings, markers } = parseCodexReview(
      '- [P1] Fix total() (cart.js:3)\n  d\n- [note] Not a finding (a.ts:1)\n- [Polish] Not one — a.ts:2\n- [constructor] Nor this — a.ts:3\n- [P2] Fix total() — cart.js:4',
    )
    expect(markers).toBe(2)
    expect(findings.map(f => [f.title, f.file, f.line])).toEqual([['Fix total()', 'cart.js', 4]])
  })
})

describe('reviewFailure', () => {
  it('recognises the companion render for a review without a structured result', () => {
    const noJson = `# Codex Adversarial Review

Codex did not return valid structured JSON.

- Parse error: Unexpected end of JSON input

Raw final message:

\`\`\`text
{"verdict": "needs-attention", "findings": [
\`\`\`
`
    const badShape = '# Codex Adversarial Review\n\nTarget: branch diff against abc\nCodex returned JSON with an unexpected review shape.\n\n- Validation error: Missing array `findings`.\n'
    expect(reviewFailure(noJson)).toBe('Codex did not return valid structured JSON.')
    expect(reviewFailure(badShape)).toBe('Codex returned JSON with an unexpected review shape.')
    expect(reviewFailure(crlf(noJson))).toBe('Codex did not return valid structured JSON.')
    expect(reviewFailure(crlf(badShape))).toBe('Codex returned JSON with an unexpected review shape.')
  })

  it('recognises the companion render for a native review that printed nothing', () => {
    const empty = '# Codex Review\n\nTarget: branch diff against abc\n\nCodex review completed without any stdout output.\n\nstderr:\n\n```text\nwarning: x\n```\n'
    expect(reviewFailure(empty)).toBe('Codex review completed without any stdout output.')
    expect(reviewFailure(crlf(empty))).toBe('Codex review completed without any stdout output.')
    expect(reviewFailure('- [P2] Parser — a.ts:1\n  Codex review completed without any stdout output.')).toBeUndefined()
  })

  it('ignores clean reviews and finding text that quotes the render', () => {
    expect(reviewFailure(fixture('codex-plugin-adversarial-review.md'))).toBeUndefined()
    expect(reviewFailure('No material findings.')).toBeUndefined()
    expect(reviewFailure('- [high] Parser — a.ts:1\n  Codex did not return valid structured JSON.')).toBeUndefined()
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
