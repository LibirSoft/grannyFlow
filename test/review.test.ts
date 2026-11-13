import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decide, declinedOf, isBlocker, mergeDuplicates, parseCodexReview, priorityOf, reviewFailure, rideAlong, saysNoFindings, triage } from '../src/core/review'
import type { Finding, Impact } from '../src/core/types'

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

  it('recognises a review that is only the no-findings sentence, inside a known wrapper', () => {
    const clean = [
      'No findings.',
      'no findings',
      '  No Findings.  \n',
      'No material findings.',
      '# Codex Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nNo material findings.\n',
      '[granny] reviewer: codex CLI\nNo findings.',
      '[granny] reviewer: codex-plugin review (/c)\n# Codex Review\n\nTarget: branch diff against abc\n\nNo findings.\n',
      fixture('codex-plugin-adversarial-review-clean.md'),
      `[granny] reviewer: codex-plugin adversarial-review (/c)\n${fixture('codex-plugin-adversarial-review-clean.md')}`,
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nNo material findings.\n\nNext steps:\n- Ship it.\n\nReasoning:\n- Read the diff.\n',
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: approve\n\nNo material findings.\n',
    ]
    for (const text of clean) {
      expect(saysNoFindings(text)).toBe(true)
      expect(saysNoFindings(crlf(text))).toBe(true)
    }
  })

  it('does not read output with anything besides the sentence and its wrapper as clean', () => {
    const prose = '## Correctness\n**P1** Null deref in src/a.ts:3 - crashes on empty input.\n## Security\nNo findings.\n'
    const notClean = [
      '',
      'I did not find any issues with this change.',
      'No findings. But the cache key is wrong.',
      'Findings: none worth a fix',
      prose,
      'No findings.\nBut the cache key in src/a.ts:3 ignores the locale.',
      'The cache key in src/a.ts:3 ignores the locale.\n\nNo findings.',
      '[granny] reviewer: codex CLI\nThe cache key ignores the locale.\nNo findings.',
      '# Codex Review\n\nTarget: x\n\nThe cache key ignores the locale.\n\nNo findings.\n',
      '# Notes\n\nNo findings.',
      fixture('codex-plugin-review-clean.md'),
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: needs-attention\n\nThe cache key in src/a.ts:3 ignores the locale.\n\nNo material findings.\n',
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nBut src/a.ts:3 drops the locale.\n\nNo material findings.\n',
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nNo material findings.\n\nThe cache key in src/a.ts:3 ignores the locale.\n',
      '# Codex Adversarial Review\n\nTarget: x\nVerdict: approve\n\nFine.\n\nNo material findings.\n\nNext steps:\n- Ship it.\nAlso src/a.ts:3 drops the locale.\n',
    ]
    for (const text of notClean) {
      expect(saysNoFindings(text)).toBe(false)
      expect(saysNoFindings(crlf(text))).toBe(false)
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
  const policy = { threshold: 70, alwaysFix: ['critical', 'major'] as Impact[] }
  const f = (id: string, severity: string): Finding => ({ id, severity, file: 'a', title: id, detail: '' })
  const low = { verdict: 'confirmed', impact: 'minor', likelihood: 'common', fixCost: 'large', scope: 'in-scope', evidence: 'a:1 - x' }
  const scored = (findings: Finding[], entry: Record<string, unknown> | undefined, repeatsDeclined?: (f: Finding) => boolean) =>
    triage(findings.map(x => decide(x, entry, policy, repeatsDeclined)))

  it('takes a bare number without classes for no judgement: P0/P1 by rule 1, the rest by rule 2', () => {
    const { accepted, residual } = scored([f('a', 'P1'), f('b', 'P2'), f('c', 'P3')], { score: 10, reason: 'old answer' })
    expect(residual).toEqual([])
    expect(accepted.map(x => [x.id, x.decision])).toEqual([
      ['a', { rule: 1, action: 'fix', why: 'P0/P1' }],
      ['b', { rule: 2, action: 'fix', why: 'not judged' }],
      ['c', { rule: 2, action: 'fix', why: 'not judged' }],
    ])
    expect(accepted.every(x => x.priority === undefined && !('score' in x))).toBe(true)
  })

  it('keeps a P0/P1 at or below the threshold residual only when it repeats a declined finding', () => {
    const repeat = (id: string, of: string): Finding => ({ ...f(id, 'P1'), repeatOf: of })
    const { accepted, residual } = scored([repeat('a', 'r1/x-F1'), repeat('b', 'r1/x-F2'), f('c', 'P1')], low, x => x.repeatOf === 'r1/x-F1')
    expect(accepted.map(x => x.id)).toEqual(['b', 'c'])
    expect(residual.map(x => x.id)).toEqual(['a'])
  })

  it('recognises blocker severities case-insensitively', () => {
    expect(['P0', 'p1', 'High', 'CRITICAL: x'].every(severity => isBlocker({ severity }))).toBe(true)
    expect(['P2', 'P3', 'medium', ''].some(severity => isBlocker({ severity }))).toBe(false)
  })
})

describe('the decision table', () => {
  const policy = { threshold: 70, alwaysFix: ['critical', 'major'] as Impact[] }
  const f = (id: string, severity = 'P2'): Finding => ({ id, severity, file: 'src/a.ts', line: 3, title: id, detail: '' })
  const judge = (c: Record<string, unknown>) => ({
    verdict: 'confirmed',
    impact: 'moderate',
    likelihood: 'common',
    fixCost: 'small',
    scope: 'in-scope',
    evidence: 'src/a.ts:3 - call save twice',
    reason: 'real',
    ...c,
  })
  const decided = (c: Record<string, unknown>, opts: { severity?: string; policy?: typeof policy; declined?: boolean } = {}) =>
    decide(f('x', opts.severity), judge(c), opts.policy ?? policy, () => opts.declined ?? false)

  it('gives the four findings of the measured run their exact priority and outcome', () => {
    const run = [
      ['save race', { impact: 'critical', likelihood: 'edge', fixCost: 'small', evidence: 'Editor.tsx:225 - save, go back in history, the late response arrives, save again' }],
      ['session lock', { impact: 'major', likelihood: 'edge', fixCost: 'small', evidence: 'Editor.tsx:252 - session expires, cancel the leave prompt, Save stays dead' }],
      ['YAML merge', { impact: 'critical', likelihood: 'rare', fixCost: 'trivial', evidence: 'markdown.ts:108 - `<<: *defaults` drops published: false' }],
      ['0 ay', { impact: 'minor', likelihood: 'edge', fixCost: 'trivial', evidence: 'format.ts:21 - exactly 30 days says 0 months' }],
    ] as const
    expect(run.map(([name, c]) => { const d = decided(c); return [name, d.priority, d.decision] })).toEqual([
      ['save race', 95, { rule: 6, action: 'fix', why: 'impact critical is in alwaysFix (critical/edge/small -> 95)' }],
      ['session lock', 80, { rule: 6, action: 'fix', why: 'impact major is in alwaysFix (major/edge/small -> 80)' }],
      ['YAML merge', 100, { rule: 6, action: 'fix', why: 'impact critical is in alwaysFix (critical/rare/trivial -> 100)' }],
      ['0 ay', 40, { rule: 8, action: 'residual', why: 'under the bar: minor/edge/trivial -> 40' }],
    ])
  })

  it('computes the priority from the impact x likelihood table and the fix cost, clamped to 0..100', () => {
    const table: Record<string, [number, number, number]> = {
      critical: [100, 95, 90],
      major: [90, 80, 65],
      moderate: [75, 55, 35],
      minor: [35, 25, 15],
      none: [0, 0, 0],
    }
    for (const [impact, row] of Object.entries(table)) {
      ;(['common', 'edge', 'rare'] as const).forEach((likelihood, i) => {
        expect({ impact, likelihood, p: priorityOf(impact as Impact, likelihood, 'small') }).toEqual({ impact, likelihood, p: row[i]! })
        expect(priorityOf(impact as Impact, likelihood, 'trivial')).toBe(impact === 'none' ? 0 : Math.min(100, row[i]! + 15))
        expect(priorityOf(impact as Impact, likelihood, 'large')).toBe(impact === 'none' ? 0 : row[i]! - 15)
      })
    }
  })

  it('rule 1: a P0/P1 is fixed unless it repeats a finding the fixer declined', () => {
    expect(decide(f('x', 'P1'), undefined, policy).decision).toEqual({ rule: 1, action: 'fix', why: 'P0/P1' })
    expect(decided({ verdict: 'refuted' }, { severity: 'P0' }).decision).toEqual({ rule: 1, action: 'fix', why: 'P0/P1' })
    expect(decided({ verdict: 'refuted' }, { severity: 'P1', declined: true }).decision).toEqual({ rule: 3, action: 'residual', why: 'refuted' })
    expect(decided({ impact: 'critical' }, { severity: 'P1', declined: true }).decision!.rule).toBe(6)
  })

  it('rule 2: a finding without a classification, or with an invalid one, is fixed', () => {
    expect(decide(f('x'), undefined, policy).decision).toEqual({ rule: 2, action: 'fix', why: 'not judged' })
    expect(decide(f('x'), { reason: 'r' }, policy).decision).toEqual({ rule: 2, action: 'fix', why: 'not judged' })
    expect(decided({ impact: 'severe', evidence: undefined }).decision).toEqual({
      rule: 2,
      action: 'fix',
      why: 'invalid classification: impact "severe", evidence missing',
    })
    expect(decided({ scope: undefined, likelihood: 'never' }).decision).toEqual({ rule: 2, action: 'fix', why: 'invalid classification: likelihood "never", scope missing' })
    expect(decided({ verdict: 'refuted', score: 10, fixCost: 'huge' }).decision!.rule).toBe(2)
  })

  it('rules 3 to 5: refuted, other-stage and pre-existing findings stay residual, a critical or major pre-existing one flagged', () => {
    expect(decided({ verdict: 'refuted', impact: 'critical' }).decision).toEqual({ rule: 3, action: 'residual', why: 'refuted' })
    expect(decided({ scope: 'other-stage', impact: 'critical' }).decision).toEqual({ rule: 4, action: 'residual', why: 'left to the stage that owns it' })
    expect(decided({ scope: 'pre-existing', impact: 'moderate' }).decision).toEqual({ rule: 5, action: 'residual', why: 'pre-existing' })
    expect(decided({ scope: 'pre-existing', impact: 'critical' }).decision).toEqual({ rule: 5, action: 'residual', why: 'pre-existing - ATTENTION: impact critical', attention: true })
    expect(decided({ scope: 'pre-existing', impact: 'major' }).decision!.attention).toBe(true)
  })

  it('rule 6: an impact in alwaysFix is fixed whatever its likelihood, cost and the threshold', () => {
    const d = decided({ impact: 'major', likelihood: 'rare', fixCost: 'large' }, { policy: { threshold: 99, alwaysFix: ['critical', 'major'] } })
    expect([d.priority, d.decision]).toEqual([50, { rule: 6, action: 'fix', why: 'impact major is in alwaysFix (major/rare/large -> 50)' }])
    expect(decided({ impact: 'moderate', likelihood: 'rare' }, { policy: { threshold: 70, alwaysFix: ['moderate'] } }).decision!.rule).toBe(6)
  })

  it('rules 7 and 8: the threshold cuts the priority strictly', () => {
    expect(decided({ impact: 'moderate', likelihood: 'common', fixCost: 'small' }).decision).toEqual({ rule: 7, action: 'fix', why: 'priority 75 > threshold 70 (moderate/common/small)' })
    expect(decided({ impact: 'moderate', likelihood: 'common' }, { policy: { threshold: 75, alwaysFix: [] } }).decision).toEqual({
      rule: 8,
      action: 'residual',
      why: 'under the bar: moderate/common/small -> 75',
    })
  })

  it('with alwaysFix [] only the threshold decides', () => {
    const pure = { threshold: 70, alwaysFix: [] as Impact[] }
    expect(decided({ impact: 'critical', likelihood: 'edge' }, { policy: pure }).decision!.rule).toBe(7)
    expect(decided({ impact: 'major', likelihood: 'rare' }, { policy: pure }).decision).toEqual({ rule: 8, action: 'residual', why: 'under the bar: major/rare/small -> 65' })
  })

  it('keeps the fix-storm guards: minor never passes the default threshold, moderate only when common and not large', () => {
    for (const likelihood of ['common', 'edge', 'rare']) {
      for (const fixCost of ['trivial', 'small', 'large']) {
        expect({ likelihood, fixCost, action: decided({ impact: 'minor', likelihood, fixCost }).decision!.action }).toEqual({ likelihood, fixCost, action: 'residual' })
        const moderate = decided({ impact: 'moderate', likelihood, fixCost }).decision!.action
        expect({ likelihood, fixCost, moderate }).toEqual({ likelihood, fixCost, moderate: likelihood === 'common' && fixCost !== 'large' ? 'fix' : 'residual' })
      }
    }
    expect(decided({ impact: 'minor', likelihood: 'common', fixCost: 'trivial' }).priority).toBe(50)
    expect(decided({ impact: 'moderate', likelihood: 'edge', fixCost: 'trivial' })).toMatchObject({ priority: 70, decision: { rule: 8, action: 'residual' } })
    for (const c of [{ verdict: 'refuted' }, { scope: 'other-stage' }]) {
      expect(decided({ impact: 'critical', likelihood: 'common', fixCost: 'trivial', ...c }).decision!.action).toBe('residual')
    }
  })

  it('reads evidence without a path:line as unverified and lowers an unverified impact one class', () => {
    const d = decided({ impact: 'critical', likelihood: 'edge', evidence: 'save twice and it breaks' })
    expect([d.verdict, d.impact, d.priority, d.decision]).toEqual([
      'unverified',
      'major',
      80,
      { rule: 6, action: 'fix', why: 'impact major is in alwaysFix (major/edge/small -> 80) - no path:line in the evidence, so unverified: impact lowered from critical' },
    ])
    expect(decided({ verdict: 'unverified', impact: 'major', likelihood: 'edge' })).toMatchObject({ verdict: 'unverified', impact: 'moderate', priority: 55, decision: { rule: 8 } })
    expect(decided({ verdict: 'refuted', impact: 'critical', likelihood: 'common', evidence: 'not real' })).toMatchObject({ verdict: 'unverified', impact: 'major', decision: { rule: 6, action: 'fix' } })
    expect(decided({ verdict: 'unverified', impact: 'none' })).toMatchObject({ impact: 'none', priority: 0 })
    expect(decided({ evidence: 'a.ts:12 - x' }).verdict).toBe('confirmed')
  })

  it('keeps the classification, the priority and the reason on the finding', () => {
    expect(decided({ impact: 'minor' })).toMatchObject({
      id: 'x',
      verdict: 'confirmed',
      impact: 'minor',
      likelihood: 'common',
      fixCost: 'small',
      scope: 'in-scope',
      evidence: 'src/a.ts:3 - call save twice',
      reason: 'real',
      priority: 35,
    })
  })
})

describe('the ratchet', () => {
  const policy = { threshold: 70, alwaysFix: ['critical', 'major'] as Impact[] }
  const earlier: Finding = {
    id: 'codex-F1',
    severity: 'P2',
    file: 'src/a.ts',
    line: 3,
    title: 'late save',
    detail: '',
    verdict: 'confirmed',
    impact: 'major',
    likelihood: 'edge',
    fixCost: 'small',
    scope: 'in-scope',
    evidence: 'src/a.ts:3 - save twice',
    priority: 80,
    decision: { rule: 6, action: 'fix', why: 'impact major is in alwaysFix (major/edge/small -> 80)' },
  }
  const repeat = (c: Record<string, unknown>, of: Finding | null = earlier) =>
    decide(
      { id: 'codex-F2', severity: 'P2', file: 'src/a.ts', line: 3, title: 'late save', detail: '', repeatOf: 'r1/codex-F1' },
      { verdict: 'confirmed', impact: 'moderate', likelihood: 'rare', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - save twice', ...c },
      policy,
      () => false,
      f => (f.repeatOf === 'r1/codex-F1' ? (of ?? undefined) : undefined),
    )

  it('raises a repeat whose impact and likelihood dropped below the earlier entry back to it, before the priority', () => {
    const d = repeat({})
    expect([d.impact, d.likelihood, d.priority]).toEqual(['major', 'edge', 80])
    expect(d.decision).toEqual({
      rule: 6,
      action: 'fix',
      why: 'impact major is in alwaysFix (major/edge/small -> 80)',
      raised: 'repeat of r1/codex-F1: impact moderate -> major, likelihood rare -> edge',
    })
  })

  it('raises only the class that dropped, and leaves a repeat at or above the earlier entry alone', () => {
    expect(repeat({ impact: 'critical', likelihood: 'rare' })).toMatchObject({ impact: 'critical', likelihood: 'edge', decision: { raised: 'repeat of r1/codex-F1: likelihood rare -> edge' } })
    const same = repeat({ impact: 'major', likelihood: 'common' })
    expect([same.impact, same.likelihood, same.decision!.raised]).toEqual(['major', 'common', undefined])
  })

  it('raises an unverified repeat after normalization lowered it', () => {
    expect(repeat({ verdict: 'unverified', impact: 'major', likelihood: 'edge' })).toMatchObject({
      verdict: 'unverified',
      impact: 'major',
      priority: 80,
      decision: { rule: 6, raised: 'repeat of r1/codex-F1: impact moderate -> major' },
    })
  })

  it('lets a repeat drop only when it is refuted with a path:line the earlier evidence did not have', () => {
    const fresh = repeat({ verdict: 'refuted', impact: 'none', evidence: 'src/guard.ts:9 - the guard rejects a second save' })
    expect([fresh.impact, fresh.likelihood, fresh.decision]).toEqual(['none', 'rare', { rule: 3, action: 'residual', why: 'refuted' }])
    const stale = repeat({ verdict: 'refuted', impact: 'none', evidence: 'src/a.ts:3 - not a problem' })
    expect([stale.impact, stale.likelihood, stale.decision]).toEqual([
      'major',
      'edge',
      { rule: 3, action: 'residual', why: 'refuted', raised: 'repeat of r1/codex-F1: impact none -> major, likelihood rare -> edge' },
    ])
    expect(repeat({ verdict: 'refuted', impact: 'none', evidence: 'see `a.ts:3-4` (unchanged)' }).decision!.raised).toBe('repeat of r1/codex-F1: impact none -> major, likelihood rare -> edge')
    expect(repeat({ verdict: 'refuted', impact: 'none', evidence: 'src/a.ts:3:10 - not a problem' }).decision!.raised).toBe('repeat of r1/codex-F1: impact none -> major, likelihood rare -> edge')
  })

  it('has no floor when the earlier entry carries no classification, or the repeat none', () => {
    const unjudged: Finding = { id: 'codex-F1', severity: 'P1', file: 'src/a.ts', title: 'x', detail: '', decision: { rule: 1, action: 'fix', why: 'P0/P1' } }
    expect(repeat({}, unjudged)).toMatchObject({ impact: 'moderate', likelihood: 'rare', priority: 35, decision: { rule: 8 } })
    expect(repeat({}, null).decision!.raised).toBeUndefined()
    const numberOnly = decide({ id: 'codex-F2', severity: 'P2', file: 'a', title: 'x', detail: '', repeatOf: 'r1/codex-F1' }, { score: 20 }, policy, () => false, () => earlier)
    expect(numberOnly).toMatchObject({ decision: { rule: 2, action: 'fix', why: 'not judged' } })
    expect(numberOnly.decision!.raised).toBeUndefined()
    expect(numberOnly.impact).toBeUndefined()
  })
})

describe('mergeDuplicates', () => {
  const policy = { threshold: 70, alwaysFix: ['critical', 'major'] as Impact[] }
  const judged = (id: string, c: Record<string, unknown>): Finding =>
    decide(
      { id, severity: 'P2', file: 'a.ts', line: 1, title: id, detail: '' },
      { verdict: 'confirmed', impact: 'moderate', likelihood: 'common', fixCost: 'small', scope: 'in-scope', evidence: 'a.ts:1 - x', reason: `reason ${id}`, ...c },
      policy,
    )

  it('keeps the strongest copy: a fix one first, then the higher priority', () => {
    const { findings } = mergeDuplicates(
      [judged('a', { impact: 'minor' }), judged('b', { impact: 'moderate', likelihood: 'common' }), judged('c', { impact: 'major', likelihood: 'rare', fixCost: 'large' })],
      new Map([['b', 'a'], ['c', 'a']]),
    )
    expect(findings).toEqual([expect.objectContaining({ id: 'a', title: 'a', duplicates: ['b', 'c'], impact: 'moderate', priority: 75, reason: 'reason b', decision: expect.objectContaining({ rule: 7 }) })])
  })

  it('prefers a fix copy over a residual one with a higher priority', () => {
    const { findings } = mergeDuplicates(
      [judged('a', { impact: 'critical', scope: 'other-stage' }), judged('b', { impact: 'major', likelihood: 'rare' })],
      new Map([['b', 'a']]),
    )
    expect(findings).toEqual([expect.objectContaining({ id: 'a', title: 'a', impact: 'major', priority: 65, decision: expect.objectContaining({ action: 'fix', rule: 6 }) })])
  })

  it('keeps a not-judged copy fixed and drops the stale fields of the keeper', () => {
    const keeper = judged('a', { impact: 'minor' })
    const unjudged = decide({ id: 'b', severity: 'P2', file: 'a.ts', title: 'b', detail: '' }, undefined, policy)
    const { findings } = mergeDuplicates([keeper, unjudged], new Map([['b', 'a']]))
    expect(findings[0]).toEqual({ id: 'a', severity: 'P2', file: 'a.ts', line: 1, title: 'a', detail: '', duplicates: ['b'], decision: { rule: 2, action: 'fix', why: 'not judged' } })
  })
})

describe('rideAlong', () => {
  const policy = { threshold: 70, alwaysFix: ['critical', 'major'] as Impact[], rideAlong: 55 as number | false }
  const judged = (id: string, c: Record<string, unknown>, severity = 'P2'): Finding =>
    decide(
      { id, severity, file: 'a.ts', line: 1, title: id, detail: '' },
      { verdict: 'confirmed', impact: 'moderate', likelihood: 'edge', fixCost: 'small', scope: 'in-scope', evidence: 'a.ts:1 - x', reason: `reason ${id}`, ...c },
      policy,
    )
  const fixed = judged('fix', { impact: 'major' })
  const actions = (findings: Finding[]) => findings.map(f => `${f.id}:${f.decision!.rule}:${f.decision!.action}`)

  it('sends the rule-8 findings at or above the bar with a round that has a fix, and says why', () => {
    const out = rideAlong([fixed, judged('at', {}), judged('above', { fixCost: 'trivial' }), judged('below', { likelihood: 'rare', fixCost: 'trivial' }), judged('nit', { impact: 'minor', likelihood: 'common', fixCost: 'trivial' })], policy)
    expect(actions(out)).toEqual(['fix:6:fix', 'at:9:fix', 'above:9:fix', 'below:8:residual', 'nit:8:residual'])
    expect(out[1]!.decision!.why).toBe("rides along with this round's fixes: priority 55 >= rideAlong 55 (moderate/edge/small)")
    expect(out[1]).toMatchObject({ impact: 'moderate', likelihood: 'edge', priority: 55, reason: 'reason at' })
    expect(triage(out).accepted.map(f => f.id)).toEqual(['fix', 'at', 'above'])
  })

  it('sends nothing in a round without a fix: riders never start one', () => {
    const round = [judged('at', {}), judged('above', { fixCost: 'trivial' })]
    expect(rideAlong(round, policy)).toBe(round)
    expect(actions(rideAlong(round, policy))).toEqual(['at:8:residual', 'above:8:residual'])
  })

  it('counts an unjudged P0/P1 as the fix that pays for the round', () => {
    const blocker = decide({ id: 'p1', severity: 'P1', file: 'a.ts', title: 'p1', detail: '' }, undefined, policy)
    expect(actions(rideAlong([blocker, judged('at', {})], policy))).toEqual(['p1:1:fix', 'at:9:fix'])
  })

  it('leaves refuted, pre-existing and other-stage findings and the excepted ones residual', () => {
    const round = [fixed, judged('refuted', { verdict: 'refuted' }), judged('old', { scope: 'pre-existing' }), judged('theirs', { scope: 'other-stage' }), judged('declined', {})]
    expect(actions(rideAlong(round, policy, f => f.id === 'declined'))).toEqual(['fix:6:fix', 'refuted:3:residual', 'old:5:residual', 'theirs:4:residual', 'declined:8:residual'])
  })

  it('is off with rideAlong false or unset', () => {
    const round = [fixed, judged('at', {})]
    expect(rideAlong(round, { ...policy, rideAlong: false })).toBe(round)
    expect(rideAlong(round, { threshold: 70, alwaysFix: ['critical', 'major'] })).toBe(round)
  })
})

describe('declinedOf', () => {
  const sent: Finding[] = [
    { id: 'x-F1', severity: 'P1', file: 'a', title: 'a', detail: '' },
    { id: 'x-F2', severity: 'P2', file: 'b', title: 'b', detail: '', duplicates: ['y-F1'] },
  ]

  it('keeps the ids the fixer was sent, a merged duplicate under the finding it was merged into', () => {
    expect(declinedOf([{ id: 'x-F1', reason: 'wrong' }, { id: 'y-F1', reason: 'dup' }, { id: 'x-F1', reason: 'again' }], sent)).toEqual({
      declined: [
        { id: 'x-F1', reason: 'wrong' },
        { id: 'x-F2', reason: 'dup' },
      ],
      unknown: [],
    })
  })

  it('reports ids it was not sent and skips malformed entries', () => {
    expect(declinedOf([{ id: 'x-F9', reason: 'r' }, { reason: 'no id' }, 'x-F1', { id: 'x-F2' }], sent)).toEqual({
      declined: [{ id: 'x-F2', reason: '' }],
      unknown: ['x-F9'],
    })
  })

  it('reads a missing or non-array value as nothing declined', () => {
    expect(declinedOf(undefined, sent)).toEqual({ declined: [], unknown: [] })
    expect(declinedOf('x-F1', sent)).toEqual({ declined: [], unknown: [] })
  })
})
