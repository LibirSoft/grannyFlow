import { describe, expect, it } from 'bun:test'
import { judgeConfigGaps } from '../src/core/config'
import { bucketOf, renderReport, utf8Length, type ReportMeta } from '../src/core/report'
import { heredocWriteScript } from '../src/core/shell'
import type { Finding } from '../src/core/types'

const agent = (model?: unknown) => ({ name: 'kimi', engine: 'agent', ...(model === undefined ? {} : { model }) })
const DATE = '20261106-171600'

/** The text of a heading, up to the next heading of its level. */
const under = (report: string, heading: string): string => {
  const at = report.indexOf(`\n## ${heading}\n`)
  if (at < 0) return ''
  const rest = report.slice(at + 1)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

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

describe('renderReport', () => {
  const judged = (over: Partial<Finding>): Finding => ({
    id: 'kimi-F1',
    severity: 'P2',
    file: 'src/a.ts',
    line: 12,
    title: 'A title',
    detail: 'The detail.',
    verdict: 'confirmed',
    impact: 'critical',
    likelihood: 'edge',
    fixCost: 'small',
    scope: 'in-scope',
    evidence: 'src/a.ts:12 - trigger',
    priority: 95,
    reason: 'real',
    ...over,
  })
  const META: ReportMeta = {
    branch: 'feat/x',
    base: 'main',
    head: 'abcd1234',
    commits: 2,
    repo: '/r',
    when: DATE,
    reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }, { name: 'codex', engine: 'auto' }],
    judge: 'haiku',
    uncommitted: [],
    failed: [],
  }

  it('renders the agreed shape', () => {
    const f = judged({ severity: 'P1', duplicates: ['codex-F2'] })
    expect(renderReport(META, [f])).toBe(`# Granny judge - feat/x

- Reviewed: \`main...HEAD\` at abcd1234, 2 commit(s), in /r
- When: ${DATE}
- Reviewers: kimi (agent, k), codex (auto) · Judge: haiku
- Totals: P0 1, P1 0, P2 0, P3 0, dismissed 0

## P0

### A title

\`src/a.ts:12\` · \`confirmed\` \`critical\` \`edge\` \`small\` \`in-scope\` · priority 95 · \`reviewer: P1\` · from \`kimi-F1\`, \`codex-F2\`

The detail.

**Evidence:** src/a.ts:12 - trigger

**Judge:** real

## P1

None.

## P2

None.

## P3

None.
`)
  })

  it('sorts by priority, then file and line', () => {
    const titles = (text: string) => [...text.matchAll(/^### (.*)$/gm)].map(m => m[1])
    const text = renderReport(META, [
      judged({ title: 'low', priority: 90 }),
      judged({ title: 'b-file', file: 'b.ts', priority: 95 }),
      judged({ title: 'a-line-9', file: 'a.ts', line: 9, priority: 95 }),
      judged({ title: 'a-line-2', file: 'a.ts', line: 2, priority: 95 }),
    ])
    expect(titles(text)).toEqual(['a-line-2', 'a-line-9', 'b-file', 'low'])
  })

  it('ends in one newline, whatever the last finding ends in, so the heredoc closes', () => {
    const text = renderReport(META, [judged({ impact: 'minor', detail: 'tail\n\n', reason: undefined, evidence: undefined })])
    expect(text.endsWith('tail\n')).toBe(true)
  })

  it('leaves out what a finding does not have', () => {
    const text = renderReport(META, [{ id: 'kimi-F1', severity: 'P3', file: 'a.ts', title: 't', detail: '' }])
    expect(under(text, 'P3')).toBe('## P3\n\n### t\n\n`a.ts` · `not judged` · `reviewer: P3` · from `kimi-F1`\n')
  })

  it('renders a finding missing its fields without throwing', () => {
    const text = renderReport(META, [{ id: 'kimi-F1', severity: 'P3' } as Finding])
    expect(text).toContain('### (no title)')
    expect(text).toContain('`not judged` · `reviewer: P3` · from `kimi-F1`')
  })

  it('counts a severity without a P number as P2, in the heading and the tag', () => {
    const f = { id: 'kimi-F1', severity: 'high', file: 'a.ts', title: 't', detail: '' }
    expect(bucketOf(f)).toBe('P2')
    expect(under(renderReport(META, [f]), 'P2')).toContain('`reviewer: P2`')
    expect(bucketOf({ ...f, severity: 'P1 must fix' })).toBe('P1')
    expect(bucketOf({ ...f, severity: 'p0' })).toBe('P0')
  })

  it('maps every impact to its bucket', () => {
    const bucket = (impact: Finding['impact'], verdict: Finding['verdict'] = 'confirmed') => bucketOf(judged({ impact, verdict }))
    expect(['critical', 'major', 'moderate', 'minor', 'none'].map(i => bucket(i as Finding['impact']))).toEqual(['P0', 'P1', 'P2', 'P3', 'dismissed'])
    expect(bucket('critical', 'refuted')).toBe('dismissed')
    expect(bucket('critical', 'unverified')).toBe('P0')
  })
})

describe('utf8Length', () => {
  it('matches the bytes a file holds, without TextEncoder', () => {
    for (const text of ['', 'abc\n', 'é', 'ğ', '日本語', '🦀', 'a\u{10FFFF}b', 'x\r\ny']) expect(utf8Length(text)).toBe(Buffer.byteLength(text))
  })
})

describe('heredocWriteScript', () => {
  it('picks a delimiter that does not occur in the text', () => {
    const script = heredocWriteScript('/r/a b/f.md', 'GRANNY_REPORT_END\nGRANNY_REPORT_END_x\n')
    expect(script).toStartWith("mkdir -p '/r/a b' && cat > '/r/a b/f.md' <<'GRANNY_REPORT_END__'\n")
    expect(script).toEndWith('\nGRANNY_REPORT_END__\n')
  })
})

