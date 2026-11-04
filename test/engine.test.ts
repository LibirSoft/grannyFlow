import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { commandReviewPrompt } from '../src/core/prompts'
import { alive, brokerCompanion, records, sessionEndHook, until } from './fake-companion'
import { fakeHost, finding, review, reviewerOf, type FakeOptions, withCodex } from './fake-host'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
  })

const GLM = { name: 'glm', engine: 'command', command: 'glm-review {prompt}' }
const CORE_TASK = { number: 1, total: 1, name: 'core', task: 'Do WP-01.' }

describe('runGranny', () => {
  it('ends a stage clean when the first review has no findings', async () => {
    const f = fakeHost({ reviews: ['No findings.'] })
    const r = await runGranny(f.host, input())
    expect(r.stages).toHaveLength(1)
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'clean', rounds: 1 })
    expect(f.calls.map(c => c.kind)).toEqual(['implementation', 'final'])
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0]).toContain('codex exec review --base deadbee1 -o .granny/review-core-r1-codex.md')
    expect(f.phases).toEqual(['Worktree', 'Implement', 'Review', 'PR ready'])
    expect(r.final?.gatesGreen).toBe(true)
  })

  it('sends P0/P1 unjudged and others above the threshold, keeps the rest as residual', async () => {
    const f = fakeHost({
      reviews: [review(finding('P1', 'Blocker bug'), finding('P2', 'Borderline'), finding('P2', 'Real issue')), 'No findings.'],
      scores: [{ 'codex-F2': 70, 'codex-F3': 71 }],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const fix = f.calls.find(c => c.label === 'fix core r1')!
    expect(fix.prompt).toContain('Blocker bug')
    expect(fix.prompt).toContain('Real issue')
    expect(fix.prompt).not.toContain('Borderline')
    expect(f.logs.some(l => l.includes('not sent: codex-F2(70)'))).toBe(true)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.score)).toEqual([undefined, 70, 71])
    expect(r.stages[0]!.residual).toHaveLength(1)
    expect(r.stages[0]!.residual[0]).toMatchObject({ id: 'codex-F2', title: 'Borderline', score: 70 })
  })

  it('keeps an earlier round\'s residual when a later round repeats it, once and in its latest version', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue'), finding('P3', 'Nit')), review(finding('P3', 'Nit again'))],
      scores: [{ 'codex-F1': 90, 'codex-F2': 20 }, { 'codex-F1': { score: 15, repeatOf: 'r1/codex-F2' } }],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toHaveLength(1)
    expect(r.stages[0]!.residual[0]).toMatchObject({ title: 'Nit again', score: 15, repeatOf: 'r1/codex-F2' })
    const judge = f.calls.find(c => c.label === 'judge core r2')!.prompt
    expect(judge).toContain('Round 1 kept as residual')
    expect(judge).toContain('"label": "r1/codex-F2"')
  })

  it('keeps one residual finding when a third round repeats the first round\'s version of it', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue'), finding('P3', 'Nit')), review(finding('P2', 'Other issue'), finding('P3', 'Nit 2')), review(finding('P3', 'Nit 3'))],
      scores: [
        { 'codex-F1': 90, 'codex-F2': 20 },
        { 'codex-F1': 90, 'codex-F2': { score: 20, repeatOf: 'r1/codex-F2' } },
        { 'codex-F1': { score: 20, repeatOf: 'r1/codex-F2' } },
      ],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 3 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Nit 3'])
  })

  it('follows a residual repeat the judge merged into another finding', async () => {
    const f = fakeHost({
      reviews: [
        review(finding('P2', 'Real issue'), finding('P3', 'Nit')),
        review(finding('P2', 'Other issue'), finding('P3', 'Nit 2'), finding('P3', 'Nit 2 from elsewhere')),
        review(finding('P3', 'Nit 3')),
      ],
      scores: [
        { 'codex-F1': 90, 'codex-F2': 20 },
        { 'codex-F1': 90, 'codex-F2': { score: 20, repeatOf: 'r1/codex-F2', duplicateOf: 'codex-F3' }, 'codex-F3': 20 },
        { 'codex-F1': { score: 20, repeatOf: 'r1/codex-F2' } },
      ],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 3 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Nit 3'])
  })

  it('drops an earlier residual finding once a later round sent its repeat to the fixer', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real issue'), finding('P3', 'Nit')), review(finding('P2', 'Nit, worse')), 'No findings.'],
      scores: [{ 'codex-F1': 90, 'codex-F2': 60 }, { 'codex-F1': { score: 80, repeatOf: 'r1/codex-F2' } }],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3, residual: [] })
    expect(f.calls.find(c => c.label === 'fix core r2')!.prompt).toContain('Nit, worse')
  })

  it('stops with residual-only when nothing is above the threshold', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Meh'), finding('P3', 'Nit'))], scores: [{ 'codex-F1': 40, 'codex-F2': 70 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Meh', 'Nit'])
    expect(f.calls.some(c => c.label.startsWith('fix'))).toBe(false)
  })

  it('honours a configured threshold', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Meh')), 'No findings.'], scores: [{ 'codex-F1': 40 }] })
    const r = await runGranny(f.host, input({ config: { threshold: 30 } }))
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
  })

  it('hits the round cap and reports the last findings as unresolved', async () => {
    const bad = review(finding('P2', 'Still broken'))
    const f = fakeHost({ reviews: [bad, bad], scores: [{ 'codex-F1': 90 }, { 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ config: { maxRounds: 2 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 2 })
    expect(r.stages[0]!.unresolved.map(x => x.title)).toEqual(['Still broken'])
    expect(f.calls.filter(c => c.label.startsWith('fix')).length).toBe(2)
    expect(f.logs).toContainEqual(expect.stringContaining('2-round cap'))
  })

  it('keeps the earlier rounds\' residual at the round cap; the last round\'s findings stay unresolved', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Still broken'), finding('P3', 'Nit')), review(finding('P2', 'Still broken'), finding('P3', 'Late nit'))],
      scores: [{ 'codex-F1': 90, 'codex-F2': 10 }, { 'codex-F1': 90, 'codex-F2': 10 }],
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 2 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 2 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Nit'])
    expect(r.stages[0]!.unresolved.map(x => x.title)).toEqual(['Still broken', 'Late nit'])
  })

  it('stops the loop when the review command fails twice instead of inventing findings', async () => {
    const f = fakeHost({ reviews: [{ code: 1, output: 'codex: not logged in' }, { code: 1, output: 'codex: still not logged in' }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(f.commands).toHaveLength(2)
    expect(r.stages[0]!.note).toContain('codex: review command exited 1')
    expect(r.stages[0]!.note).toContain('still not logged in')
    expect(f.calls.some(c => c.kind === 'score')).toBe(false)
  })

  it('fails the review instead of reporting clean when Codex returned no structured result', async () => {
    const render = '# Codex Adversarial Review\n\nCodex did not return valid structured JSON.\n\n- Parse error: Unexpected end of JSON input\n'
    const f = fakeHost({ reviews: [render, render] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('Codex did not return valid structured JSON.')
    expect(r.stages[0]!.note).toContain('Unexpected end of JSON input')
    expect(f.calls.some(c => c.kind === 'score' || c.kind === 'findings')).toBe(false)
  })

  it('fails the review instead of reporting clean when the Codex plugin review printed nothing', async () => {
    const render = '# Codex Review\n\nTarget: branch diff against deadbee1\n\nCodex review completed without any stdout output.\n'
    const f = fakeHost({ reviews: [render, render] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('reviewer returned no usable result (Codex review completed without any stdout output.)')
    expect(f.calls.some(c => c.kind === 'score' || c.kind === 'findings')).toBe(false)
  })

  it('sends every finding when the judge returns nothing, and says so', async () => {
    const f = fakeHost({ reviews: [review(finding('P3', 'Nit'), finding('P3', 'Other nit')), 'No findings.'], scores: [null] })
    await runGranny(f.host, input())
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
    expect(f.logs).toContain('core r1: judge returned nothing - all 2 finding(s) go to the implementer unscored')
  })

  it('does not report an unscored send when the judge answers', async () => {
    const f = fakeHost({ reviews: [review(finding('P3', 'Nit')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    await runGranny(f.host, input())
    expect(f.logs.some(l => l.includes('judge returned nothing'))).toBe(false)
  })

  it('skips the review loop for stages marked review: false', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ stages: [{ task: 'docs only', review: false }] }))
    expect(r.stages[0]).toMatchObject({ stage: 'stage 1', outcome: 'review-skipped', rounds: 0 })
    expect(f.commands).toHaveLength(0)
  })

  it('resumes from a later stage', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2 }))
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'skipped'], ['b', 'clean']])
    const impl = f.calls.find(c => c.kind === 'implementation')!
    expect(impl.prompt).toContain('Stage 2/2: "b"')
    expect(impl.prompt).toContain('Earlier stages are done')
  })

  it('reviews an existing branch against the base in a review-only stage, then fixes', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Existing bug')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ stages: [{ name: 'audit', implement: false }] }))
    expect(r.stages[0]).toMatchObject({ stage: 'audit', outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.implementation).toBeUndefined()
    expect(f.calls.map(c => c.label)).toEqual(['judge audit r1', 'fix audit r1', 'pr-ready check'])
    expect(f.commands[0]).toContain('codex exec review --base main -o')
    expect(f.phases).toEqual(['Worktree', 'Review', 'PR ready'])
  })

  it('rejects a stage with nothing to do, and a working stage without a task', async () => {
    const f = fakeHost()
    await expect(runGranny(f.host, input({ stages: [{ implement: false, review: false }] }))).rejects.toThrow('nothing to do')
    await expect(runGranny(f.host, input({ stages: [{ name: 'x' }] }))).rejects.toThrow('stages[0].task is required')
    expect(f.calls).toHaveLength(0)
  })

  it('does not ask for an extraction when a finding detail quotes a [Px] bullet', async () => {
    const f = fakeHost({ reviews: [review(`${finding('P2', 'Real one')}\n  - [P1] quoted from an earlier round`), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input())
    expect(f.calls.some(c => c.kind === 'findings')).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Real one'])
  })

  it('reads findings from CRLF review output instead of reporting the stage clean', async () => {
    const crlf = review(finding('P2', 'Native form'), '- [high] Adversarial form (src/b.ts:12-14)\n  Body.\n  Recommendation: Fix it.').replace(/\n/g, '\r\n')
    const f = fakeHost({ reviews: [crlf, 'No findings.'], scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.severity, x.title, x.file, x.line, x.detail])).toEqual([
      ['P2', 'Native form', 'src/a.ts', 3, 'Native form detail.'],
      ['P1', 'Adversarial form', 'src/b.ts', 12, 'Body.\nRecommendation: Fix it.'],
    ])
    expect(f.calls.some(c => c.kind === 'findings')).toBe(false)
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
  })

  it('falls back to an extraction agent when the parser misses findings', async () => {
    const f = fakeHost({
      reviews: ['- [P1] no location here\n  detail', 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      override: req =>
        req.kind === 'findings' ? { findings: [{ id: 'F1', severity: 'P1', file: 'x.ts', title: 'Extracted', detail: 'd' }] } : undefined,
    })
    const r = await runGranny(f.host, input())
    const extract = f.calls.find(c => c.kind === 'findings')!
    expect(extract.role).toBe('granny')
    expect(extract.access).toBe('read-only')
    expect(extract.label).toBe('extract core r1 codex')
    expect(r.stages[0]!.history[0]!.findings[0]).toMatchObject({ id: 'codex-F1', reviewer: 'codex', title: 'Extracted' })
  })

  for (const [label, extracted] of [['an empty list', { findings: [] }], ['nothing', null]] as const) {
    it(`fails the review instead of reporting clean when extraction returns ${label}`, async () => {
      const f = fakeHost({
        reviews: ['- [P1] no location here\n  detail', '- [P1] no location here\n  detail'],
        override: req => (req.kind === 'findings' ? extracted : undefined),
      })
      const r = await runGranny(f.host, input())
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(r.stages[0]!.note).toContain('1 finding marker(s), parser read 0')
      expect(r.stages[0]!.note).toContain('no location here')
      expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
    })
  }

  it('fails the review rather than fixing only the parsed part when extraction returns nothing', async () => {
    const partial = review(finding('P2', 'Parsed one'), '- [P1] unparseable\n  d')
    const f = fakeHost({ reviews: [partial, partial] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 1')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  const extracted = (...titles: string[]) => ({
    findings: titles.map((title, i) => ({ id: `F${i + 1}`, severity: 'P1', file: 'x.ts', title, detail: 'd' })),
  })
  const twoUnparseable = '- [P1] first without a location\n  d\n- [P2] second without a location\n  d'

  it('asks again with the expected count when extraction recovers fewer findings than markers', async () => {
    const answers = [extracted('Only one'), extracted('One', 'Two')]
    const f = fakeHost({
      reviews: [twoUnparseable, 'No findings.'],
      scores: [{ 'codex-F1': 90, 'codex-F2': 90 }],
      override: req => (req.kind === 'findings' ? answers.shift() : undefined),
    })
    const r = await runGranny(f.host, input())
    const extracts = f.calls.filter(c => c.kind === 'findings')
    expect(extracts.map(c => c.label)).toEqual(['extract core r1 codex', 'extract core r1 codex retry'])
    expect(extracts[1]!.prompt).toContain('2 finding marker(s)')
    expect(extracts[1]!.prompt).toContain('returned 1')
    expect(f.logs).toContain('core r1 codex: extraction recovered 1/2 findings - asking once more with the expected count')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['One', 'Two'])
  })

  it('runs the reviewer again when extraction stays short after its retry, then fails the review with both counts', async () => {
    const f = fakeHost({ reviews: [twoUnparseable, twoUnparseable], override: req => (req.kind === 'findings' ? extracted('Only one') : undefined) })
    const r = await runGranny(f.host, input())
    expect(f.commands).toHaveLength(2)
    expect(f.calls.filter(c => c.kind === 'findings').map(c => c.label)).toEqual([
      'extract core r1 codex',
      'extract core r1 codex retry',
      'extract core r1 codex #2',
      'extract core r1 codex #2 retry',
    ])
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 0')
    expect(r.stages[0]!.note).toContain('extraction recovered 1, then 1 on a retry that named the count')
    expect(r.stages[0]!.note).toContain('second without a location')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  it('does not drop the unparsed rest when extraction returns only what the parser already read', async () => {
    const partial = review(finding('P2', 'Parsed one'), '- [P1] unparseable\n  d')
    const f = fakeHost({
      reviews: [partial, partial],
      override: req => (req.kind === 'findings' ? extracted('Parsed one') : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 1')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  it('accepts an extraction that recovers more findings than markers', async () => {
    const f = fakeHost({
      reviews: ['- [P1] no location here\n  detail', 'No findings.'],
      scores: [{ 'codex-F1': 90, 'codex-F2': 90 }],
      override: req => (req.kind === 'findings' ? extracted('A', 'B') : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(1)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['A', 'B'])
  })

  describe('a review with no finding bullets', () => {
    const prose = 'I looked at the diff. The cache key ignores the locale in src/a.ts:3, so French users get English pages.'

    it('is clean without an extraction when it says No findings., also inside a Codex plugin render', async () => {
      const plugin = '[granny] reviewer: codex-plugin adversarial-review (/c)\n# Codex Adversarial Review\n\nTarget: branch diff against deadbee1\nVerdict: approve\n\nLooks right.\n\nNo material findings.\n'
      const rendered = `[granny] reviewer: codex-plugin adversarial-review (/c)\n${readFileSync(join(FIXTURES, 'codex-plugin-adversarial-review-clean.md'), 'utf8')}`
      for (const output of ['No findings.', '  no findings  ', plugin, rendered]) {
        const f = fakeHost({ reviews: [output] })
        const r = await runGranny(f.host, input())
        expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
        expect(f.calls.some(c => c.kind === 'findings')).toBe(false)
      }
    })

    it('asks an agent to extract findings from prose and goes on with them', async () => {
      const f = fakeHost({
        reviews: [prose, 'No findings.'],
        scores: [{ 'codex-F1': 90 }],
        override: req => (req.kind === 'findings' ? extracted('Locale missing from the cache key') : undefined),
      })
      const r = await runGranny(f.host, input())
      const extract = f.calls.find(c => c.kind === 'findings')!
      expect(extract.label).toBe('extract core r1 codex')
      expect(extract.prompt).toContain(prose)
      expect(f.logs).toContain('core r1 codex: no finding in the expected form and not just "No findings." - asking an agent to extract findings')
      expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
      expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Locale missing from the cache key'])
    })

    it('extracts a prose finding that another section of the output follows with No findings.', async () => {
      const sections = '## Correctness\n**P1** Null deref in src/a.ts:3 - crashes on empty input.\n## Security\nNo findings.\n'
      const f = fakeHost({
        reviews: [sections, 'No findings.'],
        override: req => (req.kind === 'findings' ? { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'Null deref', detail: 'crashes on empty input' }] } : undefined),
      })
      const r = await runGranny(f.host, input())
      const extract = f.calls.find(c => c.kind === 'findings')!
      expect(extract.label).toBe('extract core r1 codex')
      expect(extract.prompt).toContain(sections)
      expect(extract.prompt).toContain('has no finding bullets (`- [P1] Title — path:line`) and is not just "No findings.", so read its prose')
      expect(f.logs).toContain('core r1 codex: no finding in the expected form and not just "No findings." - asking an agent to extract findings')
      expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
      expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
      expect(r.stages[0]!.history[0]!.findings.map(x => [x.severity, x.title])).toEqual([['P1', 'Null deref']])
    })

    it('extracts from a needs-attention Codex plugin render even when it says No material findings.', async () => {
      const render = '# Codex Adversarial Review\n\nTarget: branch diff against deadbee1\nVerdict: needs-attention\n\nThe cache key in src/a.ts:3 ignores the locale.\n\nNo material findings.\n'
      const f = fakeHost({ reviews: [render, 'No findings.'], scores: [{ 'codex-F1': 90 }], override: req => (req.kind === 'findings' ? extracted('Locale missing from the cache key') : undefined) })
      const r = await runGranny(f.host, input())
      expect(f.calls.filter(c => c.kind === 'findings').map(c => c.label)).toEqual(['extract core r1 codex'])
      expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Locale missing from the cache key'])
    })

    it('is clean when the extraction finds none and confirms the review says the change has no problems', async () => {
      const f = fakeHost({ reviews: ['The change is correct; I found nothing to flag.'], override: req => (req.kind === 'findings' ? { findings: [], clean: true } : undefined) })
      const r = await runGranny(f.host, input())
      expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
      expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(1)
    })

    it("keeps a native Codex review that says in its own words it found nothing clean, through the extraction's confirmation", async () => {
      const native = '# Codex Review\n\nTarget: branch diff against deadbee1\n\nThe change threads the locale through the cache key and updates its tests; I did not find any discrete, actionable issues.\n'
      const real = `[granny] reviewer: codex-plugin review (/c)\n${readFileSync(join(FIXTURES, 'codex-plugin-review-clean.md'), 'utf8')}`
      for (const output of [native, real, 'The patch looks correct. No issues were found in the changed code.']) {
        const f = fakeHost({ reviews: [output], override: req => (req.kind === 'findings' ? { findings: [], clean: true } : undefined) })
        const r = await runGranny(f.host, input())
        expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
        const extract = f.calls.find(c => c.kind === 'findings')!
        expect(extract.prompt).toContain(output)
        expect(extract.prompt).toContain('set clean to true only if the output is a finished review that clearly says the changes have no problems')
      }
    })

    it('fails the review instead of reporting clean when the extraction finds none and does not confirm it', async () => {
      const f = fakeHost({ reviews: [prose, prose] })
      const r = await runGranny(f.host, input())
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(2)
      expect(r.stages[0]!.note).toContain('reviewer output had no findings in the expected form and was not just No findings, and an extraction found none in it')
      expect(r.stages[0]!.note).toContain('French users')
      expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
    })
  })

  it('uses an agent reviewer when configured, with no shell command', async () => {
    const f = fakeHost({
      override: req => (req.kind === 'findings' ? { findings: [] } : undefined),
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'glm', engine: 'agent', model: { opencode: 'zai/glm-5' } }] } }))
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(f.commands).toHaveLength(0)
    const rev = f.calls.find(c => c.role === 'reviewer')!
    expect(rev).toMatchObject({ kind: 'findings', access: 'read-only', model: 'zai/glm-5', label: 'review core r1 glm' })
    expect(rev.prompt).toContain('git diff deadbee1...HEAD')
  })

  it('runs the review command through a granny agent on hosts without a shell', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: ['No findings.'] })
    await runGranny(f.host, input())
    const runner = f.calls.find(c => c.kind === 'command')!
    expect(runner.role).toBe('granny')
    expect(runner.label).toBe('review core r1 codex')
    expect(runner.prompt).toContain(
      '; mkdir -p .granny && rm -f .granny/review-core-r1-codex.md .granny/review-core-r1-codex.log .granny/review-core-r1-codex.out .granny/review-core-r1-codex.exit .granny/review-core-r1-codex.pid && { set -m; nohup bash -c \'echo $$ > .granny/review-core-r1-codex.pid; (codex_plugins="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex"; companion_version=$(',
    )
    expect(runner.prompt).not.toContain('sort -V')
    expect(runner.prompt).toContain('node "$companion" review --wait --base deadbee1 --scope branch > .granny/review-core-r1-codex.md 2> .granny/review-core-r1-codex.log;')
    expect(runner.prompt).toContain('codex exec review --base deadbee1 -o .granny/review-core-r1-codex.md > .granny/review-core-r1-codex.log 2>&1;')
    expect(f.commands[0]).toStartWith('cd /work/repo && codex_plugins=')
  })

  it('logs the reviewer backend it knows without running anything to find out', async () => {
    const f = fakeHost({ reviews: ['No findings.'] })
    await runGranny(f.host, input())
    expect(f.commands[0]).not.toContain('companion')
    expect(f.logs).toContain('core r1 codex: reviewer: codex CLI (codex exec review)')
  })

  it('refuses adversarial-review on engine auto on opencode before starting, where auto means the Codex CLI', async () => {
    const config = { reviewers: [{ mode: 'adversarial-review' }] }
    const oc = fakeHost()
    await expect(runGranny(oc.host, input({ config }))).rejects.toThrow('on opencode engine "auto" means the Codex CLI')
    expect(oc.calls).toHaveLength(0)
    const cc = fakeHost({ name: 'claude-code', direct: false })
    await runGranny(cc.host, input({ config }))
    expect(cc.calls.find(c => c.kind === 'command')!.prompt).toContain('node "$companion" adversarial-review --wait --base deadbee1 --scope branch >')
  })

  it('shell-quotes the repo, the work dir and the base in every generated command', async () => {
    const repo = "/work/my repo's"
    const config = { workDir: ".granny dir's" }
    const r = `'/work/my repo'\\''s'`
    const wd = (file = '') => `'.granny dir'\\''s${file}'`

    const direct = fakeHost({ reviews: ['No findings.'] })
    await runGranny(direct.host, input({ repo, config, base: 'feat;main' }))
    expect(direct.calls[0]!.prompt).toContain(`Prefix EVERY shell command with \`cd ${r} &&\``)
    expect(direct.calls.find(c => c.kind === 'final')!.prompt).toContain(`git log 'feat;main'..HEAD`)
    expect(direct.commands[0]).toBe(
      `mkdir -p ${wd()} && rm -f ${wd('/review-core-r1-codex.md')} ${wd('/review-core-r1-codex.log')} && codex exec review --base deadbee1 -o ${wd('/review-core-r1-codex.md')} > ${wd('/review-core-r1-codex.log')} 2>&1; code=$?; if [ -s ${wd('/review-core-r1-codex.md')} ]; then cat ${wd('/review-core-r1-codex.md')}; else cat ${wd('/review-core-r1-codex.log')}; fi; exit $code`,
    )

    const runner = fakeHost({ name: 'claude-code', direct: false, reviews: ['No findings.'] })
    await runGranny(runner.host, input({ repo, config }))
    expect(runner.calls.find(c => c.kind === 'command')!.prompt).toContain(`\ncd ${r} && if [ -s ${wd('/review-core-r1-codex.pid')} ] && [ ! -s ${wd('/review-core-r1-codex.exit')} ]; then `)
    expect(runner.calls.find(c => c.kind === 'command')!.prompt).toContain(`; mkdir -p ${wd()} && rm -f ${wd('/review-core-r1-codex.md')} `)
    expect(runner.commands[0]).toStartWith(`cd ${r} && codex_plugins=`)

    const agent = fakeHost({ override: req => (req.kind === 'findings' ? { findings: [] } : undefined) })
    await runGranny(agent.host, input({ repo, config: { ...config, reviewers: [{ engine: 'agent' }] }, stages: [{ name: 'audit', implement: false }], base: "it's" }))
    expect(agent.calls.find(c => c.role === 'reviewer')!.prompt).toContain(`\`cd ${r} && git diff 'it'\\''s'...HEAD\``)
  })

  it('resolves role models per host and applies effort', async () => {
    const config = {
      roles: {
        implementer: { model: { 'claude-code': 'opus', opencode: 'anthropic/claude-opus-5-5' }, effort: 'high' },
        granny: { model: 'haiku' },
      },
    }
    const cc = fakeHost({ name: 'claude-code', direct: false })
    await runGranny(cc.host, input({ config }))
    expect(cc.calls.find(c => c.role === 'implementer')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(cc.calls.find(c => c.kind === 'final')).toMatchObject({ role: 'granny', model: 'haiku', access: 'write' })

    const oc = fakeHost({ reviews: [review(finding('P2', 'x')), 'No findings.'], scores: [{ 'codex-F1': 99 }] })
    await runGranny(oc.host, input({ config }))
    expect(oc.calls.find(c => c.role === 'implementer')!.model).toBe('anthropic/claude-opus-5-5')
    expect(oc.calls.find(c => c.role === 'judge')!.model).toBeUndefined()
    expect(cc.calls.find(c => c.role === 'judge')).toBeUndefined()
  })

  it('defaults the judge to sonnet on claude-code', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: [review(finding('P2', 'x')), 'No findings.'], scores: [{ 'codex-F1': 99 }] })
    await runGranny(f.host, input())
    expect(f.calls.find(c => c.role === 'judge')).toMatchObject({ model: 'sonnet', access: 'read-only' })
  })

  it('applies config layers in order and bakes rules into prompts', async () => {
    const f = fakeHost()
    await runGranny(
      f.host,
      input({
        config: [{ gates: ['make test'], aiAttribution: true }, { rules: ['Use tabs.'], language: 'Turkish' }],
        context: 'Read plans/x.md first.',
      }),
    )
    const p = f.calls.find(c => c.kind === 'implementation')!.prompt
    expect(p).toContain('`make test`')
    expect(p).toContain('Use tabs.')
    expect(p).toContain('in Turkish.')
    expect(p).toContain('Read plans/x.md first.')
    expect(p).not.toContain('NO Co-Authored-By')
    expect(f.calls.find(c => c.kind === 'final')!.prompt).not.toContain('co-authored-by')
  })

  it('forbids AI attribution by default', async () => {
    const f = fakeHost()
    await runGranny(f.host, input())
    expect(f.calls[0]!.prompt).toContain('NO Co-Authored-By')
    expect(f.calls.find(c => c.kind === 'final')!.prompt).toContain('co-authored-by')
  })

  it('throws when the implementer returns nothing', async () => {
    const f = fakeHost({ override: req => (req.kind === 'implementation' ? null : undefined) })
    await expect(runGranny(f.host, input())).rejects.toThrow('implementer returned nothing')
  })

  it('rejects invalid input and config before spawning anything', async () => {
    const f = fakeHost()
    await expect(runGranny(f.host, { repo: 'rel', branch: '', stages: [] } as RunInput)).rejects.toThrow(/repo must be an absolute path[\s\S]*branch is required[\s\S]*stages must be/)
    await expect(runGranny(f.host, input({ config: { treshold: 1 } }))).rejects.toThrow('unknown key "treshold"')
    await expect(runGranny(f.host, input({ config: { roles: { reviewer: { engine: 'agent' } } } }))).rejects.toThrow('roles.reviewer was replaced by "reviewers"')
    expect(f.calls).toHaveLength(0)
    expect(f.setups).toHaveLength(0)
  })
})

describe('the base a stage review diffs against', () => {
  const lying = (req: { kind: string }) =>
    req.kind === 'implementation' ? { startSha: 'made-up', headSha: 'h', gatesGreen: true, gates: 'ok', commits: ['c'], untested: '' } : undefined

  it('is the HEAD the engine read before the implementer ran, not the start the implementer reports', async () => {
    const f = fakeHost({ override: lying })
    const r = await runGranny(f.host, input())
    expect(f.probes[0]).toBe('git rev-parse --verify HEAD')
    expect(f.probes[1]).toBe('git rev-list --count deadbee1..HEAD')
    expect(f.commands[0]).toContain('codex exec review --base deadbee1 -o')
    expect(f.logs).toContain('core: the implementer reported startSha made-up, but HEAD was deadbee1 before it ran - reviewing deadbee1...HEAD')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', implementation: { startSha: 'made-up' } })
  })

  it('reads HEAD through a granny helper agent on hosts without a shell', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, override: lying })
    await runGranny(f.host, input())
    expect(f.probes).toEqual([`cd /work/repo && git rev-parse --verify HEAD`, `cd /work/repo && git rev-list --count deadbee1..HEAD`, `cd /work/repo && git status --porcelain`])
    expect(f.calls.find(c => c.label === 'review core r1 codex')!.prompt).toContain('--base deadbee1')
  })

  it('falls back to the base, and says so, when HEAD cannot be read', async () => {
    const f = fakeHost({ override: lying })
    const run = f.host.run!
    f.host.run = async (command, cwd) => (command.includes('git rev-parse --verify HEAD') ? { code: 128, output: 'fatal: not a git repository' } : run(command, cwd))
    const r = await runGranny(f.host, input())
    expect(f.logs.some(l => l.startsWith('core: could not read HEAD before the implementer ran - reviewing main...HEAD instead (exit 128): fatal: not a git repository'))).toBe(true)
    expect(f.commands[0]).toContain('codex exec review --base main -o')
    expect(f.probes).toEqual(['git rev-list --count main..HEAD', 'git status --porcelain'])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
  })

  it('ends the stage no-changes without a review when the implementer made no commit', async () => {
    const f = fakeHost({ commits: 0 })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'no-changes', rounds: 0, residual: [], unresolved: [], history: [] })
    expect(r.stages[0]!.note).toBe('the implementer made no commit: deadbee1..HEAD is empty, so there was nothing to review')
    expect(f.probes).toEqual(['git rev-parse --verify HEAD', 'git rev-list --count deadbee1..HEAD', 'git status --porcelain'])
    expect(f.calls.filter(c => c.kind === 'implementation')).toHaveLength(1)
    expect(f.commands).toHaveLength(0)
    expect(f.calls.some(c => c.label.startsWith('review'))).toBe(false)
    expect(r.final).not.toBeNull()
  })

  it('does not start the stages that build on a no-changes stage, and runs the others', async () => {
    const f = fakeHost({ commits: base => (base === 'deadbee1' ? 0 : 1) })
    const r = await runGranny(
      f.host,
      input({ stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B', after: [1] }, { name: 'c', task: 'C', after: [] }, { name: 'd', task: 'D', after: [2] }], config: { maxParallel: 1 } }),
    )
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'no-changes'], ['b', 'skipped'], ['c', 'clean'], ['d', 'skipped']])
    expect(r.stages[1]!.note).toBe('not started: it builds on 1 (a), which ended no-changes')
    expect(r.stages[3]!.note).toBe('not started: it builds on 2 (b), which was not started')
    expect(f.calls.filter(c => c.kind === 'implementation').map(c => c.label)).toEqual(['implement a', 'implement c'])
  })

  it('keeps running the later stages of a sequential run that do not build on the no-changes stage', async () => {
    const f = fakeHost({ commits: base => (base === 'deadbee1' ? 0 : 1) })
    const other = '/work/other'
    const r = await runGranny(
      f.host,
      input({ repos: [other], stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B', repo: other }], config: { parallel: false } }),
    )
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'no-changes'], ['b', 'clean']])
  })

  it('reviews <base>...HEAD when the first resumed stage makes no new commit, and runs the stages after it', async () => {
    const f = fakeHost({ commits: base => (base === 'deadbee1' ? 0 : 1) })
    const r = await runGranny(f.host, input({ fromStage: 2, stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }, { name: 'c', task: 'C' }] }))
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'skipped'], ['b', 'clean'], ['c', 'clean']])
    expect(f.logs).toContain('b: no new commit on resume - reviewing main...HEAD instead')
    expect(f.probes.slice(0, 4)).toEqual(['git rev-parse --verify HEAD', 'git rev-list --count deadbee1..HEAD', 'git status --porcelain', 'git rev-list --count main..HEAD'])
    expect(f.commands[0]).toContain('codex exec review --base main -o')
    expect(f.commands[0]).toContain('review-b-r1')
    expect(f.calls.filter(c => c.kind === 'implementation').map(c => c.label)).toEqual(['implement b', 'implement c'])
  })

  it('still ends the first resumed stage no-changes when <base>...HEAD is empty too', async () => {
    const f = fakeHost({ commits: 0 })
    const r = await runGranny(f.host, input({ fromStage: 2, stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }, { name: 'c', task: 'C' }] }))
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'skipped'], ['b', 'no-changes'], ['c', 'skipped']])
    expect(r.stages[1]!.note).toBe('the implementer made no commit: deadbee1..HEAD is empty, and so is main..HEAD on this resume, so there was nothing to review')
    expect(f.probes).toContain('git rev-list --count main..HEAD')
    expect(f.commands.filter(c => c.includes('review-b-r1'))).toEqual([])
  })

  it('ends a later resumed stage no-changes when it makes no commit', async () => {
    const f = fakeHost({ commits: base => (base === 'deadbee2' ? 0 : 1) })
    const r = await runGranny(f.host, input({ fromStage: 2, stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }, { name: 'c', task: 'C' }] }))
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'skipped'], ['b', 'clean'], ['c', 'no-changes']])
    expect(f.probes).not.toContain('git rev-list --count main..HEAD')
  })
})

describe('a review command on Claude Code', () => {
  const cc = (extra: FakeOptions = {}) => fakeHost({ name: 'claude-code', direct: false, ...extra })
  const steps = (f: ReturnType<typeof fakeHost>) => f.calls.filter(c => c.kind === 'command' && c.label.startsWith('review ')).map(c => c.label)
  const promptOf = (f: ReturnType<typeof fakeHost>, label: string) => f.calls.find(c => c.label === label)!.prompt
  const waits = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `review ${tag} wait ${i + 1}`)
  const md = '.granny/review-core-r1-codex'

  it('starts the review detached, waits for it in engine steps until it is done, then reads its output', async () => {
    const f = cc({ reviews: [review(finding('P2', 'Off by one')), 'No findings.'], scores: [{ 'codex-F1': 90 }], wait: (_, n) => (n < 3 ? 'pending\n' : 'done\n') })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Off by one'])
    expect(steps(f)).toEqual([
      'review core r1 codex',
      ...waits('core r1 codex', 3),
      'review core r1 codex read',
      'review core r2 codex',
      ...waits('core r2 codex', 3),
      'review core r2 codex read',
    ])
    const start = promptOf(f, 'review core r1 codex')
    expect(start).toContain(`\ncd /work/repo && if [ -s ${md}.pid ] && [ ! -s ${md}.exit ]; then kill -TERM -- "-$(cat ${md}.pid)" 2>/dev/null || kill -TERM "$(cat ${md}.pid)" 2>/dev/null; fi; mkdir -p .granny && rm -f ${md}.md ${md}.log ${md}.out ${md}.exit ${md}.pid && { set -m; nohup bash -c 'echo $$ > ${md}.pid; (`)
    expect(start).toContain(`) > ${md}.out 2>&1; echo $? > ${md}.exit' > /dev/null 2>&1 < /dev/null & } && echo started\n`)
    expect(f.commands[0]!.startsWith('cd /work/repo && codex_plugins="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex"; companion_version=$(')).toBe(true)
    expect(f.commands[0]).toContain(`node "$companion" review --wait --base deadbee1 --scope branch > ${md}.md 2> ${md}.log;`)
    expect(promptOf(f, 'review core r1 codex wait 2')).toContain(
      `\ncd /work/repo && bash -c 'until [ -s ${md}.exit ] || [ "$SECONDS" -ge 540 ]; do sleep 5; done'; if [ -s ${md}.exit ]; then echo done; else echo pending; fi\n`,
    )
    expect(promptOf(f, 'review core r1 codex read')).toContain(`\ncd /work/repo && code=$(cat ${md}.exit); cat ${md}.out; exit "\${code:-1}"\n`)
  })

  it('keeps every rm out of the detached script, where the helper shell cannot check it', async () => {
    const f = cc()
    await runGranny(f.host, input())
    const detached = /nohup bash -c ('(?:[^']|'\\'')*')/.exec(promptOf(f, 'review core r1 codex'))![1]!
    expect(detached).not.toMatch(/\brm\b/)
    expect(f.commands[0]).not.toMatch(/\brm -f\b/)
  })

  it('gives each step a fixed command and leaves no choice of how to wait to the helper', async () => {
    const f = cc({ wait: (_, n) => (n < 2 ? 'pending\n' : 'done\n') })
    await runGranny(f.host, input())
    const prompts = f.calls.filter(c => c.kind === 'command' && c.label.startsWith('review ')).map(c => c.prompt)
    expect(prompts).toHaveLength(4)
    for (const p of prompts) {
      expect(p).not.toContain('pgrep')
      expect(p).not.toContain('background mode')
      expect(p).not.toContain('wait for it to finish')
      expect(p).toContain('Run exactly this')
    }
    expect(promptOf(f, 'review core r1 codex')).toContain('Run exactly this, once, in the foreground - it detaches the review itself and returns at once:\n')
    const [wait1, wait2] = [promptOf(f, 'review core r1 codex wait 1'), promptOf(f, 'review core r1 codex wait 2')]
    expect(wait1).toContain('wait 1 of at most 7')
    expect(wait2).toContain('wait 2 of at most 7')
    expect(wait1).toContain("in the foreground (never in the background), with your shell tool's timeout set to 600000 ms (10 minutes)")
  })

  it('counts a wait whose helper returned nothing or failed as still pending', async () => {
    const f = cc({ wait: (_, n) => (n === 1 ? null : n === 2 ? { code: 1, output: 'bash: oops' } : 'done\n') })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
    expect(steps(f)).toEqual(['review core r1 codex', ...waits('core r1 codex', 3), 'review core r1 codex read'])
  })

  it('stops a review still running after 7 waits, retries it once, then ends the stage review-failed', async () => {
    const f = cc({ wait: () => 'pending\n' })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('codex: review command still running after 7 waits of up to 9 minutes (63 minutes) - stopped it')
    expect(steps(f)).toEqual([
      'review core r1 codex',
      ...waits('core r1 codex', 7),
      'review core r1 codex stop',
      'review core r1 codex #2',
      ...waits('core r1 codex #2', 7),
      'review core r1 codex #2 stop',
    ])
    expect(promptOf(f, 'review core r1 codex stop')).toContain(
      `\ncd /work/repo && if [ -s ${md}.pid ]; then kill -TERM -- "-$(cat ${md}.pid)" 2>/dev/null || kill -TERM "$(cat ${md}.pid)" 2>/dev/null; fi; rm -f ${md}.pid; echo stopped\n`,
    )
    expect(f.logs.some(l => l.startsWith('core r1 codex: did not run - retrying once. review command still running after 7 waits'))).toBe(true)
  })

  it('fails the attempt without waiting when the review did not start', async () => {
    const f = cc({ override: req => (req.label === 'review core r1 codex' ? { ran: false, exitCode: 127, output: 'nohup: command not found', note: 'no nohup' } : undefined) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
    expect(steps(f)).toEqual(['review core r1 codex', 'review core r1 codex #2', 'review core r1 codex #2 wait 1', 'review core r1 codex #2 read'])
    expect(f.logs).toContain('core r1 codex: did not run - retrying once. review command did not start (exit 127) (no nohup): nohup: command not found')
  })

  it('runs a command reviewer the same way, and its exit code comes from the read', async () => {
    const f = cc({ reviews: [{ code: 3, output: 'glm: quota exceeded' }, 'No findings.'] })
    const r = await runGranny(f.host, input({ config: { reviewers: [GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
    expect(steps(f)).toEqual(['review core r1 glm', 'review core r1 glm wait 1', 'review core r1 glm read', 'review core r1 glm #2', 'review core r1 glm #2 wait 1', 'review core r1 glm #2 read'])
    expect(f.logs.some(l => l.startsWith('core r1 glm: did not run - retrying once. review command exited 3') && l.endsWith('glm: quota exceeded'))).toBe(true)
  })

  it('keeps running the review command directly where the host has a shell', async () => {
    const f = fakeHost({ reviews: ['No findings.'] })
    await runGranny(f.host, input())
    expect(f.calls.some(c => c.kind === 'command')).toBe(false)
    expect(f.commands[0]).toStartWith('mkdir -p .granny && rm -f .granny/review-core-r1-codex.md .granny/review-core-r1-codex.log && codex exec review')
  })
})

describe("the Claude Code helper's note", () => {
  const helper = (extra: FakeOptions = {}) => fakeHost({ name: 'claude-code', direct: false, ...extra })
  const reviewBase = (f: ReturnType<typeof fakeHost>) => /--base (\S+)/.exec(f.calls.find(c => c.label === 'review core r1 codex')!.prompt)?.[1]
  const printing = (f: ReturnType<typeof fakeHost>, edit: (prompt: string, output: string) => string) => {
    const agent = f.host.agent.bind(f.host)
    f.host.agent = async req => {
      const r = (await agent(req)) as { output?: unknown } | null
      return req.kind === 'command' && r && typeof r.output === 'string' ? { ...r, output: edit(req.prompt, r.output) } : r
    }
  }

  it('stays out of the HEAD and commit-count reads when the command ran', async () => {
    const f = helper({ note: 'Ran the command via the helper.' })
    const r = await runGranny(f.host, input())
    expect(reviewBase(f)).toBe('deadbee1')
    expect(f.logs.filter(l => l.includes('could not'))).toEqual([])
    expect(f.logs).toContain("head core: the helper's note, kept out of the command's output: Ran the command via the helper.")
    expect(r.stages[0]!.outcome).toBe('clean')
  })

  it('does not hide an empty stage: no commit still ends it no-changes', async () => {
    const f = helper({ note: 'Ran the command via the helper.', commits: 0 })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'no-changes', note: 'the implementer made no commit: deadbee1..HEAD is empty, so there was nothing to review' })
    expect(f.calls.some(c => c.label.startsWith('review'))).toBe(false)
  })

  it('never becomes the review base when it is one word', async () => {
    const f = helper({ note: 'Done' })
    await runGranny(f.host, input())
    expect(reviewBase(f)).toBe('deadbee1')
  })

  it('takes the SHA and the count from the line that has their shape, not the last line', async () => {
    const f = helper({ commits: 0 })
    printing(f, (prompt, output) => (prompt.includes('git rev-parse --verify HEAD') ? `${output}Done\n` : prompt.includes('git rev-list --count') ? `${output}that is the count\n` : output))
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'no-changes', note: 'the implementer made no commit: deadbee1..HEAD is empty, so there was nothing to review' })
  })

  it('reads no SHA from a word that is not hex, and falls back to the base', async () => {
    const f = helper()
    printing(f, (prompt, output) => (prompt.includes('git rev-parse --verify HEAD') ? 'Done\n' : output))
    await runGranny(f.host, input())
    expect(reviewBase(f)).toBe('main')
    expect(f.logs.some(l => l.startsWith('core: could not read HEAD before the implementer ran - reviewing main...HEAD instead'))).toBe(true)
  })

  it('is still in the output when the command did not run', async () => {
    const f = helper()
    const agent = f.host.agent.bind(f.host)
    f.host.agent = async req => (req.kind === 'command' && req.prompt.includes('git rev-parse --verify HEAD') ? { ran: false, exitCode: 127, output: '', note: 'git is not installed' } : agent(req))
    await runGranny(f.host, input())
    expect(f.logs.some(l => l.startsWith('core: could not read HEAD before the implementer ran - reviewing main...HEAD instead (exit 127)') && l.endsWith('git is not installed'))).toBe(true)
  })
})

describe('red gates', () => {
  const gates = (red: string[]) => (req: { kind: string; label: string }) =>
    req.kind === 'implementation'
      ? { startSha: 'deadbee1', headSha: 'h', gatesGreen: !red.includes(req.label), gates: red.includes(req.label) ? `${req.label}: 3 tests fail` : 'all green', commits: ['c'], untested: '' }
      : undefined

  it('end a stage gates-red, not clean, when the review finds nothing after an implementer left them red', async () => {
    const f = fakeHost({ override: gates(['implement core']) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'gates-red', rounds: 1, residual: [], unresolved: [] })
    expect(r.stages[0]!.note).toBe('the review found nothing to fix, but the implementer left the gates red: implement core: 3 tests fail')
    expect(f.logs).toContain('core: gates-red - the review found nothing to fix, but the implementer left the gates red: implement core: 3 tests fail')
  })

  it('end it gates-red when the last fix left them red, keeping the residual findings', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Real'), finding('P3', 'Nit')), review(finding('P3', 'Nit'))],
      scores: [{ 'codex-F1': 90, 'codex-F2': 10 }, { 'codex-F1': { score: 10, repeatOf: 'r1/codex-F2' } }],
      override: gates(['fix core r1']),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'gates-red', rounds: 2 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Nit'])
    expect(r.stages[0]!.note).toBe('the review found nothing to fix, but the last fix (fix core r1) left the gates red: fix core r1: 3 tests fail')
  })

  it('do not count once a later fix turned them green', async () => {
    const f = fakeHost({ reviews: [review(finding('P1', 'Broken')), 'No findings.'], override: gates(['implement core']) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.note).toBeUndefined()
  })
})

describe('the worktree', () => {
  const WT = '/work/repo-worktrees/feat-x'
  const opus = { name: 'opus', engine: 'agent', model: 'opus' }

  it('sets up the worktree before the first stage, then works only in it', async () => {
    const f = fakeHost({
      worktree: WT,
      reviews: [review(finding('P2', 'Absolute path', `${WT}/src/b.ts`)), 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      override: req => (req.role === 'reviewer' ? { findings: [] } : undefined),
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, opus] } }))
    expect(f.setups.map(s => s.cwd)).toEqual(['/work/repo'])
    expect(f.logs[0]).toBe(`worktree: ${WT}`)
    expect(r).toMatchObject({ repo: '/work/repo', worktree: WT })
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings[0]).toMatchObject({ file: 'src/b.ts', title: 'Absolute path' })

    expect(f.cwds).toEqual([WT, WT])
    expect(f.calls.map(c => c.cwd)).toEqual(f.calls.map(() => WT))
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'review core r1 opus', 'judge core r1', 'fix core r1', 'review core r2 opus', 'pr-ready check'])
    for (const c of f.calls) {
      expect(c.prompt).not.toContain('/work/repo ')
      expect(c.prompt).not.toContain('/work/repo,')
    }
    for (const label of ['implement core', 'fix core r1', 'pr-ready check']) {
      const prompt = f.calls.find(c => c.label === label)!.prompt
      expect(prompt).toContain(`Working repo: ${WT}, branch \`feat/x\``)
      expect(prompt).toContain(`Prefix EVERY shell command with \`cd ${WT} &&\``)
    }
    expect(f.calls.find(c => c.label === 'review core r1 opus')!.prompt).toContain(`\`cd ${WT} && git diff deadbee1...HEAD\``)
    expect(f.calls.find(c => c.label === 'judge core r1')!.prompt).toContain(`Repo ${WT}, branch feat/x`)
  })

  it('hands command reviewers a {prompt} that names the worktree', async () => {
    const f = fakeHost({ worktree: WT })
    await runGranny(f.host, input({ config: { reviewers: [GLM] } }))
    expect(f.commands[0]).toContain(`Repo ${WT}, branch`)
    expect(f.commands[0]).toContain(`cd ${WT} && git diff deadbee1...HEAD`)
    expect(f.commands[0]).not.toContain('/work/repo ')
  })

  it('runs the review command from the worktree on Claude Code, through the review runner', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, worktree: WT })
    await runGranny(f.host, input())
    const runner = f.calls.find(c => c.label === 'review core r1 codex')!
    expect(runner.prompt).toContain(`\ncd ${WT} && if [ -s .granny/review-core-r1-codex.pid ]`)
    expect(f.calls.find(c => c.label === 'review core r1 codex wait 1')!.prompt).toContain(`\ncd ${WT} && bash -c `)
    expect(f.calls.find(c => c.label === 'review core r1 codex read')!.prompt).toContain(`\ncd ${WT} && code=$(cat .granny/review-core-r1-codex.exit)`)
    expect(runner.prompt).toContain(`Stage "core" of repo ${WT}, branch`)
  })

  it('runs the setup script on Claude Code through a granny helper agent that may write', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, worktree: WT })
    const r = await runGranny(f.host, input({ config: { roles: { granny: { model: 'haiku' } } } }))
    expect(r.worktree).toBe(WT)
    expect(f.setups).toHaveLength(1)
    expect(f.setups[0]!.request).toMatchObject({ role: 'granny', kind: 'command', label: 'worktree', phase: 'Worktree', access: 'write', model: 'haiku', cwd: '/work/repo' })
    expect(f.setups[0]!.request!.prompt).toContain('branch `feat/x`')
    expect(f.setups[0]!.command.startsWith('cd /work/repo && ')).toBe(true)
    expect(f.phases[0]).toBe('Worktree')
  })

  it('builds a setup script that reuses the branch worktree, or adds one for the branch or from the base', async () => {
    const f = fakeHost()
    await runGranny(f.host, input({ base: 'develop' }))
    const script = f.setups[0]!.command
    expect(script).toContain('git worktree list --porcelain')
    expect(script).toContain(`if [ "\${l#branch refs/heads/}" = feat/x ]`)
    expect(script).toContain('git show-ref --verify --quiet refs/heads/feat/x')
    expect(script).toContain(`git worktree add "$wt" feat/x`)
    expect(script).toContain(`git worktree add -b feat/x "$wt" develop`)
    expect(script).toContain(`wt=${WT};`)
    expect(script).toContain(`printf '%s\\n' /.granny/ >> "$ex"`)
    expect(script).not.toContain('\n')
  })

  it('places the worktree under worktreeDir and quotes every path in the setup script', async () => {
    const f = fakeHost()
    await runGranny(f.host, input({ repo: "/work/my repo's", branch: "fix/it's", config: { worktreeDir: 'trees here', workDir: '.granny dir' } }))
    const script = f.setups[0]!.command
    expect(script).toContain(`wt='/work/trees here/fix-it-s';`)
    expect(script).toContain(`= 'fix/it'\\''s' ]`)
    expect(script).toContain(`printf '%s\\n' '/.granny dir/' >> "$ex"`)
  })

  it('fails before any agent runs when the setup fails, with what it printed', async () => {
    const f = fakeHost({ worktree: { code: 1, output: '[granny] worktree failed: /w has feat/x checked out with uncommitted changes\n?? dirty.txt\n' } })
    await expect(runGranny(f.host, input())).rejects.toThrow(/worktree setup failed \(exit 1\)[\s\S]*uncommitted changes[\s\S]*dirty\.txt/)
    expect(f.calls).toHaveLength(0)
    expect(f.commands).toHaveLength(0)

    const cc = fakeHost({ name: 'claude-code', direct: false, worktree: { code: 1, output: 'fatal: not a git repository' } })
    await expect(runGranny(cc.host, input())).rejects.toThrow(/worktree setup failed \(exit 1\)[\s\S]*not a git repository/)
    expect(cc.calls).toHaveLength(0)
  })

  it('fails when the setup exits 0 without naming an absolute worktree path', async () => {
    for (const output of ['Preparing worktree\n', '[granny] worktree: relative/path\n']) {
      const f = fakeHost({ worktree: { code: 0, output } })
      await expect(runGranny(f.host, input())).rejects.toThrow('worktree setup failed (exit 0)')
      expect(f.calls).toHaveLength(0)
    }
  })

  it('sets the worktree up again on fromStage, so a resumed run reuses it', async () => {
    const f = fakeHost({ worktree: WT })
    const r = await runGranny(f.host, input({ stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2 }))
    expect(f.setups).toHaveLength(1)
    expect(r.worktree).toBe(WT)
    expect(f.calls.find(c => c.kind === 'implementation')!.prompt).toContain(`Working repo: ${WT}`)
  })

  it('works in the repo itself with worktree off', async () => {
    const f = fakeHost({ worktree: WT })
    const r = await runGranny(f.host, input({ config: { worktree: false } }))
    expect(f.setups).toHaveLength(0)
    expect(r).toMatchObject({ repo: '/work/repo', worktree: '/work/repo' })
    expect(f.cwds).toEqual(['/work/repo'])
    expect(f.calls.every(c => c.cwd === '/work/repo')).toBe(true)
    expect(f.calls[0]!.prompt).toContain('Working repo: /work/repo, branch')
    expect(f.phases).toEqual(['Implement', 'Review', 'PR ready'])
  })
})

describe('several reviewers', () => {
  const three = [{ name: 'codex' }, { name: 'opus', engine: 'agent', model: 'opus' }, GLM]

  it('runs every reviewer of a round at the same time', async () => {
    let started = 0
    let release!: () => void
    const everyone = new Promise<void>(resolve => (release = resolve))
    const seen: Array<[string, number]> = []
    const arrive = async (who: string) => {
      if (++started === 3) release()
      await Promise.race([everyone, Bun.sleep(500)])
      seen.push([who, started])
    }
    const f = fakeHost({
      reviews: async command => {
        await arrive(reviewerOf(command)!)
        return 'No findings.'
      },
      override: async req => {
        if (req.role !== 'reviewer') return undefined
        await arrive('opus')
        return { findings: [] }
      },
    })
    const r = await runGranny(f.host, input({ config: { reviewers: three } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
    expect(seen.map(([, n]) => n)).toEqual([3, 3, 3])
    expect(seen.map(([who]) => who).sort()).toEqual(['codex', 'glm', 'opus'])
  })

  it('gives every reviewer its own output files and logs its backend under its name', async () => {
    const f = fakeHost()
    await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, { name: 'cli-2', engine: 'codex', model: 'gpt-5.5' }, GLM] } }))
    expect(f.commands).toHaveLength(3)
    expect(f.commands[0]).toContain('rm -f .granny/review-core-r1-codex.md .granny/review-core-r1-codex.log && codex exec review --base deadbee1 -o .granny/review-core-r1-codex.md > .granny/review-core-r1-codex.log 2>&1;')
    expect(f.commands[1]).toContain('codex exec review --base deadbee1 -m gpt-5.5 -o .granny/review-core-r1-cli-2.md > .granny/review-core-r1-cli-2.log 2>&1;')
    expect(f.commands[2]).toContain('rm -f .granny/review-core-r1-glm.md .granny/review-core-r1-glm.log && glm-review ')
    expect(f.logs).toContain('core r1 codex: reviewer: codex CLI (codex exec review)')
    expect(f.logs).toContain('core r1 cli-2: reviewer: codex CLI (codex exec review)')
    expect(f.logs).toContain('core r1 glm: reviewer: custom command')
  })

  it('fills {prompt} with a one-line review prompt that demands the finding format', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false })
    await runGranny(f.host, input({ context: 'Read plans/x.md first.\nThen plans/y.md.', config: { reviewers: [GLM] } }))
    const prompt = commandReviewPrompt(
      { repo: '/work/repo', branch: 'feat/x', base: 'main', context: 'Read plans/x.md first.\nThen plans/y.md.', config: resolveConfig([{ reviewers: [GLM] }]) },
      'core',
      'deadbee1',
      CORE_TASK,
    )
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('git diff deadbee1...HEAD')
    expect(prompt).toContain('- [P1] Title — path/to/file.ts:12')
    expect(prompt).toContain('Read plans/x.md first. Then plans/y.md.')
    expect(f.calls.find(c => c.kind === 'command')!.label).toBe('review core r1 glm')
    expect(f.commands[0]).toContain(`glm-review '${prompt.replaceAll("'", `'\\''`)}' > .granny/review-core-r1-glm.log 2>&1;`)
  })

  it('hands the stage task to an agent reviewer, a command reviewer and the judge', async () => {
    const task = 'Do WP-02: add the cache layer.\nLeave the eviction policy to stage 3.'
    const f = fakeHost({
      name: 'claude-code',
      direct: false,
      reviews: { glm: ['No findings.', review(finding('P2', 'Meh')), 'No findings.'] },
      scores: [{ 'glm-F1': 90 }],
      override: req => (req.role === 'reviewer' ? { findings: [] } : undefined),
    })
    await runGranny(f.host, input({ stages: [{ name: 'one', task: 'Do WP-01.' }, { name: 'cache', task }], config: { reviewers: [{ name: 'opus', engine: 'agent' }, GLM] } }))
    const agent = f.calls.find(c => c.label === 'review cache r1 opus')!.prompt
    expect(agent).toContain('Stage 2/2 "cache"')
    expect(agent).toContain(`TASK:\n${task}`)
    expect(agent).toContain('work the task leaves to other stages is not a finding')
    expect(agent).toContain('scope creep')
    expect(agent).toContain('needless abstraction')
    const glm = f.commands.find(c => c.includes('review-cache-r1-glm'))!
    expect(glm).toContain('TASK: Do WP-02: add the cache layer. Leave the eviction policy to stage 3.')
    expect(glm).toContain('work the task leaves to other stages is not a finding')
    const judge = f.calls.find(c => c.label === 'judge cache r1')!.prompt
    expect(judge).toContain('Stage 2/2 "cache"')
    expect(judge).toContain(`TASK:\n${task}`)
    expect(judge).toContain('another stage owns scores low')
  })

  it('passes the task of a review-only stage and leaves the task section out when a stage has none', async () => {
    const agent = { name: 'opus', engine: 'agent' }
    const withTask = fakeHost({ override: req => (req.role === 'reviewer' ? { findings: [] } : undefined) })
    await runGranny(withTask.host, input({ stages: [{ name: 'audit', task: 'Audit the auth module.', implement: false }], config: { reviewers: [agent] } }))
    expect(withTask.calls.find(c => c.role === 'reviewer')!.prompt).toContain('TASK:\nAudit the auth module.')

    const bare = fakeHost({
      name: 'claude-code',
      direct: false,
      reviews: { glm: [review(finding('P2', 'Meh'))] },
      scores: [{ 'glm-F1': 10 }],
      override: req => (req.role === 'reviewer' ? { findings: [] } : undefined),
    })
    await runGranny(bare.host, input({ stages: [{ name: 'audit', implement: false }], config: { reviewers: [agent, GLM] } }))
    const prompts = [bare.calls.find(c => c.role === 'reviewer')!.prompt, bare.commands.find(c => c.includes('review-audit-r1-glm'))!, bare.calls.find(c => c.role === 'judge')!.prompt]
    for (const prompt of prompts) {
      expect(prompt).not.toContain('TASK')
      expect(prompt).not.toContain('leaves to other stages')
    }
    expect(prompts[0]).toContain('needless abstraction')
  })

  it('prefixes finding ids with the reviewer and keeps the attribution through the judge, the fix and the residual', async () => {
    const f = fakeHost({
      reviews: { codex: [review(finding('P2', 'From codex'), finding('P3', 'Second from codex')), 'No findings.'], glm: [review(finding('P2', 'From glm')), 'No findings.'] },
      scores: [{ 'codex-F1': 90, 'codex-F2': 10, 'glm-F1': 95 }],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.reviewer, x.title, x.score])).toEqual([
      ['codex-F1', 'codex', 'From codex', 90],
      ['codex-F2', 'codex', 'Second from codex', 10],
      ['glm-F1', 'glm', 'From glm', 95],
    ])
    const judge = f.calls.find(c => c.role === 'judge')!.prompt
    expect(judge).toContain('"id": "glm-F1"')
    expect(judge).toContain('"reviewer": "glm"')
    const fix = f.calls.find(c => c.label === 'fix core r1')!.prompt
    expect(fix).toContain('"id": "codex-F1"')
    expect(fix).toContain('"id": "glm-F1"')
    expect(fix).toContain('"reviewer": "glm"')
    expect(fix).not.toContain('codex-F2')
    expect(f.logs.some(l => l.includes('not sent: codex-F2(10)'))).toBe(true)
  })

  it('numbers an agent reviewer\'s findings under its own name, whatever ids it chose', async () => {
    const f = fakeHost({
      override: req =>
        req.role === 'reviewer'
          ? { findings: [{ id: 'F1', severity: 'P2', file: 'a.ts', title: 'One', detail: 'd' }, { id: 'F1', severity: 'P3', file: 'b.ts', title: 'Two', detail: 'd' }] }
          : undefined,
      scores: [{ 'opus-F1': 10, 'opus-F2': 10 }],
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 1, reviewers: [{ name: 'opus', engine: 'agent' }] } }))
    expect(r.stages[0]!.residual.map(x => [x.id, x.reviewer, x.title])).toEqual([
      ['opus-F1', 'opus', 'One'],
      ['opus-F2', 'opus', 'Two'],
    ])
  })

  it("runs agent reviewers with the reviewer entry's own model and effort", async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, override: req => (req.role === 'reviewer' ? { findings: [] } : undefined) })
    await runGranny(
      f.host,
      input({
        config: {
          roles: { judge: { model: 'haiku', effort: 'low' }, granny: { model: 'haiku', effort: 'low' } },
          reviewers: [
            { name: 'opus', engine: 'agent', model: { 'claude-code': 'opus', opencode: 'anthropic/claude-opus-5-5' }, effort: 'high' },
            { name: 'sonnet', engine: 'agent', model: 'sonnet' },
          ],
        },
      }),
    )
    expect(f.calls.filter(c => c.role === 'reviewer').map(c => [c.label, c.model, c.effort])).toEqual([
      ['review core r1 opus', 'opus', 'high'],
      ['review core r1 sonnet', 'sonnet', undefined],
    ])
  })

  it('is clean only when every reviewer ran and none reported findings', async () => {
    const failing = { code: 2, output: 'glm: provider error' }
    const f = fakeHost({ reviews: { codex: ['No findings.'], glm: [failing, failing] } })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1, unresolved: [] })
    expect(r.stages[0]!.note).toContain('reviewer(s) that did not run, also on a retry: glm')
    expect(r.stages[0]!.note).toContain('glm: review command exited 2')
    expect(r.stages[0]!.note).not.toContain('codex:')
  })

  it('ends review-failed when a reviewer fails twice, keeping the findings of the reviewers that ran', async () => {
    const notLoggedIn = { code: 1, output: 'codex: not logged in' }
    const f = fakeHost({
      reviews: { codex: [notLoggedIn, notLoggedIn], glm: [review(finding('P2', 'Kept'))] },
      override: req => (req.role === 'reviewer' ? null : undefined),
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, { name: 'opus', engine: 'agent' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.unresolved.map(x => [x.id, x.reviewer, x.title])).toEqual([['glm-F1', 'glm', 'Kept']])
    expect(r.stages[0]!.note).toContain('reviewer(s) that did not run, also on a retry: codex, opus')
    expect(r.stages[0]!.note).toContain('codex: review command exited 1')
    expect(r.stages[0]!.note).toContain('opus: reviewer agent returned nothing')
    expect(f.calls.filter(c => c.role === 'reviewer').map(c => c.label)).toEqual(['review core r1 opus', 'review core r1 opus #2'])
    expect(f.commands.filter(c => reviewerOf(c) === 'codex')).toHaveLength(2)
    expect(f.commands.filter(c => reviewerOf(c) === 'glm')).toHaveLength(1)
    expect(f.calls.some(c => c.role === 'judge' || c.label.startsWith('fix'))).toBe(false)
  })

  it('retries a reviewer that failed once and goes on with its second answer', async () => {
    const f = fakeHost({
      reviews: { codex: [{ code: 1, output: 'codex: stream disconnected' }, review(finding('P2', 'Found on the retry'))], glm: [review(finding('P2', 'From glm'))] },
      scores: [{ 'codex-F1': 90, 'glm-F1': 90 }],
    })
    const r = await runGranny(f.host, input({ config: { maxRounds: 1, reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 1 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.title])).toEqual([
      ['codex-F1', 'Found on the retry'],
      ['glm-F1', 'From glm'],
    ])
    expect(f.logs).toContain('core r1 codex: did not run - retrying once. review command exited 1: codex: stream disconnected')
    expect(f.logs).toContain('core r1 codex #2: reviewer: codex CLI (codex exec review)')
    expect(f.commands.filter(c => reviewerOf(c) === 'codex')).toHaveLength(2)
  })

  it('retries an agent reviewer that returned nothing, and a review runner on Claude Code', async () => {
    let opus = 0
    const f = fakeHost({
      name: 'claude-code',
      direct: false,
      reviews: [{ code: 1, output: 'codex: boom' }, 'No findings.'],
      override: req => (req.role === 'reviewer' ? (++opus === 1 ? null : { findings: [] }) : undefined),
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, { name: 'opus', engine: 'agent' }] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
    expect(f.calls.filter(c => c.label.startsWith('review')).map(c => c.label).sort()).toEqual([
      'review core r1 codex',
      'review core r1 codex #2',
      'review core r1 codex #2 read',
      'review core r1 codex #2 wait 1',
      'review core r1 codex read',
      'review core r1 codex wait 1',
      'review core r1 opus',
      'review core r1 opus #2',
    ])
    expect(f.logs).toContain('core r1 opus: did not run - retrying once. reviewer agent returned nothing')
  })

  describe('when a reviewer call throws', () => {
    const failOnce = () => {
      let calls = 0
      return () => {
        if (++calls === 1) throw new Error('session request failed: 502')
      }
    }
    const onRetry = review(finding('P1', 'Found on the retry'))
    const paths: Array<[string, (fail: () => void) => FakeOptions, Record<string, unknown>]> = [
      [
        'an agent reviewer',
        fail => ({
          override: req => {
            if (req.role !== 'reviewer') return undefined
            fail()
            return { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'Found on the retry', detail: 'd' }] }
          },
        }),
        { name: 'rv', engine: 'agent' },
      ],
      [
        'a review command',
        fail => ({
          reviews: async () => {
            fail()
            return onRetry
          },
        }),
        { name: 'rv', engine: 'codex' },
      ],
      [
        'a review runner on Claude Code',
        fail => ({
          name: 'claude-code',
          direct: false,
          reviews: [onRetry],
          override: req => {
            if (req.kind === 'command') fail()
            return undefined
          },
        }),
        { name: 'rv', engine: 'codex' },
      ],
    ]
    for (const [label, options, reviewer] of paths) {
      it(`retries ${label} that threw and goes on with its second answer`, async () => {
        const f = fakeHost(options(failOnce()))
        const r = await runGranny(f.host, input({ config: { maxRounds: 1, reviewers: [reviewer] } }))
        expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 1 })
        expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.reviewer, x.title])).toEqual([['rv-F1', 'rv', 'Found on the retry']])
        expect(f.logs).toContain('core r1 rv: did not run - retrying once. reviewer call failed: session request failed: 502')
      })
    }

    it('waits for the other reviewers and keeps their findings when it throws on the retry too', async () => {
      const events: string[] = []
      let thrown = 0
      let release!: () => void
      const bothThrown = new Promise<void>(resolve => (release = resolve))
      const f = fakeHost({
        reviews: async () => {
          await Promise.race([bothThrown, Bun.sleep(1000)])
          events.push('codex done')
          return review(finding('P2', 'Kept'))
        },
        override: req => {
          if (req.kind === 'final') events.push('final')
          if (req.role !== 'reviewer') return undefined
          events.push('opus threw')
          if (++thrown === 2) release()
          throw new Error('session request failed: 502')
        },
      })
      const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, { name: 'opus', engine: 'agent' }] } }))
      expect(events).toEqual(['opus threw', 'opus threw', 'codex done', 'final'])
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(r.stages[0]!.unresolved.map(x => [x.id, x.reviewer, x.title])).toEqual([['codex-F1', 'codex', 'Kept']])
      expect(r.stages[0]!.note).toContain('reviewer(s) that did not run, also on a retry: opus')
      expect(r.stages[0]!.note).toContain('opus: reviewer call failed: session request failed: 502')
      expect(f.calls.filter(c => c.role === 'reviewer').map(c => c.label)).toEqual(['review core r1 opus', 'review core r1 opus #2'])
      expect(f.calls.some(c => c.role === 'judge' || c.label.startsWith('fix'))).toBe(false)
    })
  })

  it('sends P0/P1 findings straight to the implementer and judges only the rest', async () => {
    const f = fakeHost({
      reviews: { codex: [review(finding('P1', 'Codex blocker'), finding('P2', 'Codex nit')), 'No findings.'], glm: [review(finding('critical', 'Glm crash'), finding('P3', 'Glm style')), 'No findings.'] },
      scores: [{ 'codex-F2': 90, 'glm-F2': 10 }],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const judge = f.calls.find(c => c.role === 'judge')!.prompt
    expect(judge).toContain('Codex nit')
    expect(judge).toContain('Glm style')
    expect(judge).not.toContain('Codex blocker')
    expect(judge).not.toContain('Glm crash')
    const fix = f.calls.find(c => c.label === 'fix core r1')!.prompt
    for (const title of ['Codex blocker', 'Glm crash', 'Codex nit']) expect(fix).toContain(title)
    expect(fix).not.toContain('Glm style')
    expect(f.logs).toContain('core r1: 2 P0/P1 finding(s) go to the implementer without the judge: codex-F1, glm-F1')
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.score])).toEqual([
      ['codex-F1', undefined],
      ['codex-F2', 90],
      ['glm-F1', undefined],
      ['glm-F2', 10],
    ])
    expect(f.logs).toContain('core r1: 1 finding(s) <= 70 and not P0/P1, not sent: glm-F2(10)')
  })

  it('does not call the judge when every finding is P0/P1', async () => {
    const f = fakeHost({ reviews: { codex: [review(finding('P0', 'Data loss')), 'No findings.'], glm: [review(finding('high', 'Auth bypass')), 'No findings.'] } })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(f.calls.some(c => c.role === 'judge')).toBe(false)
    expect(f.calls.find(c => c.label === 'fix core r1')!.prompt).toContain('Auth bypass')
    expect(r.stages[0]!.history[0]).toMatchObject({ round: 1, score: null })
  })

  it('merges the duplicates the judge marks and reports each problem once, with every reviewer that found it', async () => {
    const f = fakeHost({
      reviews: {
        codex: [review(finding('P2', 'Off by one in totals'), finding('P2', 'Unrelated')), 'No findings.'],
        opus: [review(finding('P2', 'Totals skip the first item')), 'No findings.'],
        glm: [review(finding('P3', 'First cart item ignored')), 'No findings.'],
      },
      scores: [{ 'codex-F1': 90, 'codex-F2': 20, 'opus-F1': { score: 88, duplicateOf: 'codex-F1' }, 'glm-F1': { score: 60, duplicateOf: 'opus-F1' } }],
    })
    const reviewers = [{ name: 'codex' }, { name: 'opus', engine: 'command', command: 'opus-review {prompt}' }, GLM]
    const r = await runGranny(f.host, input({ config: { reviewers } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.score, x.duplicates])).toEqual([
      ['codex-F1', 90, ['opus-F1', 'glm-F1']],
      ['codex-F2', 20, undefined],
    ])
    expect(f.logs).toContain('core r1: judge merged opus-F1 into codex-F1 (duplicate)')
    expect(f.logs).toContain('core r1: judge merged glm-F1 into codex-F1 (duplicate)')
    const fix = f.calls.find(c => c.label === 'fix core r1')!.prompt
    expect(fix).toContain('Off by one in totals')
    expect(fix).toContain('"duplicates": [')
    expect(fix).not.toContain('"title": "Totals skip the first item"')
    expect(f.logs).toContain('core r1: 1 finding(s) <= 70 and not P0/P1, not sent: codex-F2(20)')
  })

  it('keeps a finding the judge scored low when a duplicate merged into it scored high', async () => {
    const f = fakeHost({
      reviews: { codex: [review(finding('P2', 'Weakly worded')), 'No findings.'], glm: [review(finding('P2', 'Same, well argued')), 'No findings.'] },
      scores: [{ 'codex-F1': 30, 'glm-F1': { score: 85, duplicateOf: 'codex-F1' } }],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]!.history[0]!.findings).toEqual([expect.objectContaining({ id: 'codex-F1', score: 85, reason: 'reason glm-F1', duplicates: ['glm-F1'] })])
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
  })

  it('ignores a duplicateOf that points at a P0/P1, an unknown id, itself or back in a cycle', async () => {
    const f = fakeHost({
      reviews: {
        codex: [review(finding('P1', 'Blocker'), finding('P2', 'Loop a'), finding('P2', 'Loop b')), 'No findings.'],
        glm: [review(finding('P2', 'Same as the blocker'), finding('P2', 'Points nowhere'), finding('P2', 'Points at itself')), 'No findings.'],
      },
      scores: [
        {
          'codex-F2': { score: 80, duplicateOf: 'codex-F3' },
          'codex-F3': { score: 80, duplicateOf: 'codex-F2' },
          'glm-F1': { score: 80, duplicateOf: 'codex-F1' },
          'glm-F2': { score: 80, duplicateOf: 'glm-F9' },
          'glm-F3': { score: 80, duplicateOf: 'glm-F3' },
        },
      ],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.duplicates])).toEqual([
      ['codex-F1', undefined],
      ['codex-F2', undefined],
      ['codex-F3', undefined],
      ['glm-F1', undefined],
      ['glm-F2', undefined],
      ['glm-F3', undefined],
    ])
    expect(f.logs.some(l => l.includes('merged'))).toBe(false)
  })

  it('tells the judge about duplicateOf and asks for it in the score schema', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'x')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    await runGranny(f.host, input())
    const judge = f.calls.find(c => c.role === 'judge')!
    expect(judge.prompt).toContain('duplicateOf')
    expect(judge.prompt).toContain('P0/P1 findings are not in this list')
    const item = (judge.schema.properties.perFinding as { items: { properties: Record<string, unknown>; required: string[] } }).items
    expect(item.properties.duplicateOf).toMatchObject({ type: 'string' })
    expect(item.required).not.toContain('duplicateOf')
  })

  it('keeps the last round findings of a reviewer that stops running in a later round', async () => {
    const crashed = { code: 1, output: 'codex: crashed' }
    const f = fakeHost({
      reviews: {
        codex: [review(finding('P2', 'Codex round one')), crashed, crashed],
        glm: [review(finding('P2', 'Glm round one')), review(finding('P2', 'Glm round two'))],
      },
      scores: [{ 'codex-F1': 90, 'glm-F1': 90 }],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 2 })
    expect(r.stages[0]!.unresolved.map(x => [x.id, x.title])).toEqual([
      ['glm-F1', 'Glm round two'],
      ['codex-F1', 'Codex round one'],
    ])
  })

  it('keeps a failed reviewer finding that the judge merged into the finding of a reviewer that is now clean', async () => {
    const crashed = { code: 1, output: 'glm: crashed' }
    const f = fakeHost({
      reviews: {
        codex: [review(finding('P2', 'Totals off by one')), 'No findings.'],
        glm: [review(finding('P2', 'Totals skip the first item')), crashed, crashed],
      },
      scores: [{ 'codex-F1': 90, 'glm-F1': { score: 80, duplicateOf: 'codex-F1' } }],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.duplicates])).toEqual([['codex-F1', ['glm-F1']]])
    expect(r.stages[0]!.unresolved).toEqual([expect.objectContaining({ id: 'glm-F1', reviewer: 'glm', title: 'Totals skip the first item', score: 80 })])
  })

  it('reports the merged findings of a failed reviewer under its own ids, next to what the others found this round', async () => {
    const crashed = { code: 1, output: 'glm: crashed' }
    const f = fakeHost({
      reviews: {
        codex: [review(finding('P2', 'Totals off by one'), finding('P2', 'Cache not invalidated')), review(finding('P2', 'New in round two'))],
        glm: [review(finding('P2', 'Totals skip the first item'), finding('P2', 'Stale cache')), crashed, crashed],
      },
      scores: [
        {
          'codex-F1': 90,
          'codex-F2': { score: 75, duplicateOf: 'glm-F2' },
          'glm-F1': { score: 80, duplicateOf: 'codex-F1' },
          'glm-F2': 90,
        },
      ],
    })
    const r = await runGranny(f.host, input({ config: { reviewers: [{ name: 'codex' }, GLM] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 2 })
    expect(r.stages[0]!.unresolved.map(x => [x.id, x.reviewer, x.title, x.duplicates])).toEqual([
      ['codex-F1', 'codex', 'New in round two', undefined],
      ['glm-F1', 'glm', 'Totals skip the first item', undefined],
      ['glm-F2', 'glm', 'Stale cache', ['codex-F2']],
    ])
  })
})

const FAKE_CODEX = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    *) shift ;;
  esac
done
echo 'codex progress' >&2
printf '%s\\n' "- [P1] Reviewed $base — a.ts:1" '  detail' > "$out"
`

const FAKE_LLM = `#!/usr/bin/env bash
model=
while [ $# -gt 1 ]; do
  case "$1" in
    -m) model=$2; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$1" > "$GRANNY_PROMPT_RECORD"
printf '%s\\n' "- [P2] Reviewed with $model — a.ts:1" '  detail'
`

const FIXTURES = join(import.meta.dir, 'fixtures')

const fakeCompanion = (version: string, record: string, stdout?: string) => `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
process.stderr.write('[codex] progress\\n')
const fixture = process.argv[2] === 'adversarial-review' ? 'codex-plugin-adversarial-review.md' : 'codex-plugin-review.md'
process.stdout.write(${stdout === undefined ? `readFileSync(${JSON.stringify(FIXTURES)} + '/' + fixture, 'utf8')` : JSON.stringify(stdout)})
`

describe('the review script in a real shell', () => {
  let repo: string
  let bin: string
  let home: string
  const workDir = "review dir's $& $HOME"
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "granny repo's "))
    bin = mkdtempSync(join(tmpdir(), 'granny-bin-'))
    home = mkdtempSync(join(tmpdir(), 'granny home '))
    writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const shell = (env: Record<string, string> = {}) => ({ env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: '', ...env } })
  const companionDir = (version: string, root = join(home, '.claude')) => join(root, 'plugins/cache/openai-codex/codex', version, 'scripts')
  const installCompanion = (version: string, stdout?: string, root?: string) => {
    mkdirSync(companionDir(version, root), { recursive: true })
    writeFileSync(join(companionDir(version, root), 'codex-companion.mjs'), fakeCompanion(version, join(home, 'calls.jsonl'), stdout))
  }
  const installCompanions = () => {
    installCompanion('1.0.9', '- [P0] Old companion ran — old.js:1\n')
    installCompanion('1.0.10')
  }
  const companionCalls = () =>
    existsSync(join(home, 'calls.jsonl')) ? readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  const missing = () => `no Codex plugin companion at ${home}/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`
  const noNode = () => `node is not on PATH for the Codex plugin companion at ${companionDir('1.0.10')}/codex-companion.mjs`
  const withoutNode = () => {
    const tools = join(home, 'tools without node')
    mkdirSync(tools)
    for (const tool of ['bash', 'cat', 'mkdir', 'nohup', 'rm', 'sleep', 'sort', 'tail']) symlinkSync(Bun.which(tool)!, join(tools, tool))
    return shell({ PATH: `${bin}:${tools}` })
  }
  const titles = (r: Awaited<ReturnType<typeof runGranny>>) => r.stages[0]!.history[0]!.findings.map(x => [x.severity, x.title])

  it('runs the newest Codex plugin companion on Claude Code with engine auto, and says so', async () => {
    installCompanions()
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(titles(r)).toEqual([
      ['P1', 'Include the first item in the cart total'],
      ['P2', 'Restore discount percentage bounds validation'],
    ])
    expect(companionCalls()).toEqual([{ version: '1.0.10', argv: ['review', '--wait', '--base', 'deadbee1', '--scope', 'branch'], cwd: realpathSync(repo) }])
    expect(f.logs).toContain(`core r1 codex: reviewer: codex-plugin review (${companionDir('1.0.10')}/codex-companion.mjs)`)
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.md'), 'utf8')).toBe(readFileSync(join(FIXTURES, 'codex-plugin-review.md'), 'utf8'))
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.log'), 'utf8')).toBe('[codex] progress\n')
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.exit'), 'utf8')).toBe('0\n')
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.out'), 'utf8')).toStartWith(`[granny] reviewer: codex-plugin review (`)
  })

  it('stops a detached review still running at the wait cap on Claude Code, and leaves no process behind', async () => {
    const slow = { name: 'slow', engine: 'command', command: 'sleep 37.25; echo "No findings against {base}."' }
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), wait: () => 'pending\n' })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [slow] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(f.stops).toHaveLength(2)
    await new Promise(res => setTimeout(res, 200))
    expect(Bun.spawnSync(['pgrep', '-f', '^sleep 37\\.25$']).exitCode).toBe(1)
    expect(existsSync(join(repo, workDir, 'review-core-r1-slow.pid'))).toBe(false)
    expect(existsSync(join(repo, workDir, 'review-core-r1-slow.exit'))).toBe(false)
  })

  it('looks for the companion under CLAUDE_CONFIG_DIR instead of ~/.claude when it is set', async () => {
    installCompanions()
    const config = join(home, 'relocated claude config')
    installCompanion('1.0.3', undefined, config)
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell({ CLAUDE_CONFIG_DIR: config }), scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(companionCalls().map(c => c.version)).toEqual(['1.0.3'])
    expect(f.logs).toContain(`core r1 codex: reviewer: codex-plugin review (${companionDir('1.0.3', config)}/codex-companion.mjs)`)
  })

  it('names the CLAUDE_CONFIG_DIR it searched when it falls back to the Codex CLI', async () => {
    installCompanions()
    const config = join(home, 'empty claude config')
    mkdirSync(config)
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell({ CLAUDE_CONFIG_DIR: config }), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(titles(r)).toEqual([['P1', 'Reviewed deadbee1']])
    expect(companionCalls()).toEqual([])
    expect(f.logs).toContain(
      `core r1 codex: reviewer: codex CLI (codex exec review) - no Codex plugin companion at ${config}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`,
    )
  })

  it('picks the highest companion version with a sort that has no -V, as on BSD and macOS', async () => {
    writeFileSync(
      join(bin, 'sort'),
      `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in -*V*|--version-sort|--sort=*) echo "sort: invalid option -- 'V'" >&2; exit 2 ;; esac; done\nexec ${Bun.which('sort')} "$@"\n`,
      { mode: 0o755 },
    )
    for (const version of ['0.99.99', '1.0.9', '1.9.3', '1.0.10']) installCompanion(version, '- [P0] Older companion ran — old.js:1\n')
    installCompanion('1.10.0')
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(companionCalls().map(c => c.version)).toEqual(['1.10.0'])
    expect(titles(r).map(([, title]) => title)).toEqual(['Include the first item in the cart total', 'Restore discount percentage bounds validation'])
  })

  it('fails the review when the companion exits 0 but Codex printed no review', async () => {
    installCompanion('1.0.10', '# Codex Review\n\nTarget: branch diff against deadbee1\n\nCodex review completed without any stdout output.\n')
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell() })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('Codex review completed without any stdout output.')
    expect(companionCalls()).toHaveLength(2)
  })

  it('falls back to the Codex CLI on Claude Code with engine auto when no companion is installed, and says why', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(titles(r)).toEqual([['P1', 'Reviewed deadbee1']])
    expect(f.logs).toContain(`core r1 codex: reviewer: codex CLI (codex exec review) - ${missing()}`)
  })

  it('falls back to the Codex CLI on Claude Code with engine auto when a companion is installed but node is not on PATH', async () => {
    installCompanions()
    const f = fakeHost({ name: 'claude-code', direct: false, shell: withoutNode(), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(titles(r)).toEqual([['P1', 'Reviewed deadbee1']])
    expect(companionCalls()).toEqual([])
    expect(f.logs).toContain(`core r1 codex: reviewer: codex CLI (codex exec review) - ${noNode()}`)
  })

  for (const [label, host, reviewer] of [
    ['engine codex-plugin on Claude Code', 'claude-code', { engine: 'codex-plugin' }],
    ['engine codex-plugin on opencode', 'opencode', { engine: 'codex-plugin' }],
    ['adversarial-review on engine auto', 'claude-code', { mode: 'adversarial-review' }],
  ] as const) {
    it(`fails the review with a clear note when node is not on PATH for ${label} - no CLI fallback`, async () => {
      installCompanions()
      const mode = 'mode' in reviewer ? reviewer.mode : 'review'
      const f = fakeHost({ name: host, direct: host === 'opencode', shell: withoutNode() })
      const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'codex', ...reviewer }] } }))
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(r.stages[0]!.note).toContain(`codex-plugin ${mode} unavailable - ${noNode()}; install Node.js`)
      expect(r.stages[0]!.note).not.toContain('Reviewed')
      expect(r.stages[0]!.note).not.toContain('command not found')
      expect(companionCalls()).toEqual([])
      expect(f.logs.some(l => l.startsWith(`core r1 codex: reviewer: codex-plugin ${mode} unavailable - node is not on PATH`))).toBe(true)
    })
  }

  describe("the Codex plugin's app-server broker", () => {
    const brokers: number[] = []
    afterEach(() => {
      for (const pid of brokers.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    })
    const installBroker = (record: string, exit = 0) => {
      mkdirSync(companionDir('1.0.10'), { recursive: true })
      writeFileSync(join(companionDir('1.0.10'), 'codex-companion.mjs'), brokerCompanion(record, { exit }))
      writeFileSync(join(companionDir('1.0.10'), 'session-lifecycle-hook.mjs'), sessionEndHook(record))
    }
    for (const [label, exit] of [['the review ends', 0], ['the companion fails', 1]] as const) {
      it(`is stopped when ${label}, and is kept out of the session's plugin data`, async () => {
        const userData = join(home, 'user plugin data')
        const record = join(home, 'broker.jsonl')
        installBroker(record, exit)
        const f = fakeHost({ name: 'claude-code', direct: false, shell: shell({ CLAUDE_PLUGIN_DATA: userData }), scores: [{ 'codex-F1': 90 }] })
        const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
        const all = records(record)
        const companions = all.filter(e => e.event === 'companion')
        brokers.push(...companions.map(c => c.broker))
        const data = join(realpathSync(repo), workDir, 'codex-plugin-codex')
        const hook = { event: 'hook', argv: ['SessionEnd'], cwd: realpathSync(repo), data }
        expect(all.map(e => ({ ...e, data: realpathSync(e.data) }))).toEqual(
          companions.flatMap(c => [{ event: 'companion', data, broker: c.broker }, hook]),
        )
        expect(companions).toHaveLength(exit ? 2 : 1)
        for (const c of companions) expect(await until(() => !alive(c.broker))).toBe(true)
        expect(existsSync(userData)).toBe(false)
        if (exit) expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
        else expect(titles(r)).toEqual([['P2', 'Reviewed by the plugin']])
      })
    }

    it('gives each Codex plugin reviewer its own broker, stopped by its own SessionEnd, while they run side by side', async () => {
      const record = join(home, 'broker.jsonl')
      installBroker(record)
      const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'one-F1': 90, 'two-F1': 90 }] })
      const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'one', engine: 'codex-plugin' }, { name: 'two', engine: 'codex-plugin' }] } }))
      const all = records(record).map(e => ({ ...e, data: realpathSync(e.data) }))
      const companions = all.filter(e => e.event === 'companion')
      brokers.push(...companions.map(c => c.broker))
      const dir = (name: string) => join(realpathSync(repo), workDir, `codex-plugin-${name}`)
      expect(companions.map(c => c.data).sort()).toEqual([dir('one'), dir('two')])
      expect(all.filter(e => e.event === 'hook').map(h => h.data).sort()).toEqual([dir('one'), dir('two')])
      for (const c of companions) expect(await until(() => !alive(c.broker))).toBe(true)
      expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.title])).toEqual([
        ['one-F1', 'Reviewed by the plugin'],
        ['two-F1', 'Reviewed by the plugin'],
      ])
      for (const name of ['one', 'two']) expect(f.logs).toContain(`core r1 ${name}: reviewer: codex-plugin review (${companionDir('1.0.10')}/codex-companion.mjs)`)
    })

    it('is not touched when engine auto runs the Codex CLI', async () => {
      const record = join(home, 'broker.jsonl')
      mkdirSync(companionDir('1.0.10'), { recursive: true })
      writeFileSync(join(companionDir('1.0.10'), 'session-lifecycle-hook.mjs'), sessionEndHook(record))
      const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90 }] })
      const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
      expect(titles(r)).toEqual([['P1', 'Reviewed deadbee1']])
      expect(records(record)).toEqual([])
    })
  })

  it('runs the Codex CLI on opencode with engine auto even when a companion is installed', async () => {
    installCompanions()
    const f = fakeHost({ shell: shell(), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(titles(r)).toEqual([['P1', 'Reviewed deadbee1']])
    expect(companionCalls()).toEqual([])
    expect(f.logs).toContain('core r1 codex: reviewer: codex CLI (codex exec review)')
  })

  it('runs the companion on opencode with engine codex-plugin, passing the reviewer model', async () => {
    installCompanions()
    const f = fakeHost({ shell: shell(), scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'codex', engine: 'codex-plugin', model: 'gpt-5.5' }] } }))
    expect(titles(r).map(([, title]) => title)).toEqual(['Include the first item in the cart total', 'Restore discount percentage bounds validation'])
    expect(companionCalls().map(c => [c.version, c.argv])).toEqual([['1.0.10', ['review', '--wait', '--base', 'deadbee1', '--scope', 'branch', '-m', 'gpt-5.5']]])
  })

  for (const [label, host] of [['Claude Code', 'claude-code'], ['opencode', 'opencode']] as const) {
    it(`fails the review with a clear note when engine codex-plugin finds no companion on ${label} - no CLI fallback`, async () => {
      const f = fakeHost({ name: host, direct: host === 'opencode', shell: shell() })
      const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'codex', engine: 'codex-plugin' }] } }))
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(r.stages[0]!.note).toContain(`codex-plugin review unavailable - ${missing()}; install OpenAI's Codex plugin for Claude Code`)
      expect(r.stages[0]!.note).not.toContain('Reviewed')
      expect(r.stages[0]!.note).not.toContain('No such file')
      expect(existsSync(join(repo, workDir, 'review-core-r1-codex.md'))).toBe(false)
      expect(f.logs.some(l => l.startsWith('core r1 codex: reviewer: codex-plugin review unavailable'))).toBe(true)
    })
  }

  it('runs adversarial-review with the focus text after --, and reads its high findings as P1', async () => {
    installCompanions()
    const focus = "don't skip $HOME; -x `id`"
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90, 'codex-F2': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'codex', mode: 'adversarial-review', focus, model: 'gpt-5.5' }] } }))
    expect(companionCalls().map(c => c.argv)).toEqual([['adversarial-review', '--wait', '--base', 'deadbee1', '--scope', 'branch', '-m', 'gpt-5.5', '--', focus]])
    expect(titles(r)).toEqual([
      ['P1', 'Cart totals exclude the first item'],
      ['P1', 'Out-of-range discounts now produce invalid totals'],
    ])
    expect(f.logs).toContain(`core r1 codex: reviewer: codex-plugin adversarial-review (${companionDir('1.0.10')}/codex-companion.mjs)`)
  })

  it('fails adversarial-review on engine auto when no companion is installed instead of running a plain CLI review', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell() })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'codex', mode: 'adversarial-review' }] } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain(`codex-plugin adversarial-review unavailable - ${missing()}`)
    expect(r.stages[0]!.note).not.toContain('Reviewed')
  })

  it('runs a command reviewer on Claude Code without looking for the plugin', async () => {
    installCompanions()
    const command = `test -n {base} && printf '%s\\n' '- [P2] Custom — b.ts:2' '  d' > {out}`
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'mine-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'mine', engine: 'command', command }] } }))
    expect(titles(r)).toEqual([['P2', 'Custom']])
    expect(companionCalls()).toEqual([])
    expect(f.logs).toContain('core r1 mine: reviewer: custom command')
  })

  for (const [label, host] of [['opencode', 'opencode'], ['Claude Code', 'claude-code']] as const) {
    it(`runs a command reviewer that takes {prompt}, handing the CLI the whole prompt as one argument, on ${label}`, async () => {
      writeFileSync(join(bin, 'fake-llm'), FAKE_LLM, { mode: 0o755 })
      const promptFile = join(home, 'prompt.txt')
      const context = "Read plans/x.md first.\nIt's `important`: $HOME and $(id)."
      const glm = { name: 'glm', engine: 'command', command: 'fake-llm -m {model} {prompt}', model: 'opencode/glm-5.3-flash-free' }
      const f = fakeHost({ name: host, direct: host === 'opencode', shell: shell({ GRANNY_PROMPT_RECORD: promptFile }), scores: [{ 'glm-F1': 90 }] })
      const r = await runGranny(f.host, input({ repo, context, config: { maxRounds: 1, workDir, reviewers: [glm] } }))
      const expected = commandReviewPrompt({ repo, branch: 'feat/x', base: 'main', context, config: resolveConfig([{ reviewers: [glm] }]) }, 'core', 'deadbee1', CORE_TASK)
      expect(readFileSync(promptFile, 'utf8')).toBe(expected)
      expect(expected).toContain("It's `important`: $HOME and $(id).")
      expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.reviewer, x.title])).toEqual([['glm-F1', 'glm', 'Reviewed with opencode/glm-5.3-flash-free']])
      expect(f.logs).toContain('core r1 glm: reviewer: custom command')
    })
  }

  it('runs the default codex command in a repo and work dir with spaces and a quote', async () => {
    const f = fakeHost({ shell: shell(), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Reviewed deadbee1'])
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.md'), 'utf8')).toContain('Reviewed deadbee1')
    expect(readFileSync(join(repo, workDir, 'review-core-r1-codex.log'), 'utf8')).toBe('codex progress\n')
  })

  it('runs the cd-prefixed command a granny agent is given from outside the repo', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(f.commands[0]!.startsWith('cd ')).toBe(true)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Reviewed deadbee1'])
    expect(existsSync(join(repo, workDir, 'review-core-r1-codex.md'))).toBe(true)
  })

  it('substitutes a quoted {out} into a command template', async () => {
    const command = `{ test -n {base} && printf '%s\\n' '- [P2] Custom — b.ts:2' '  d' > {out}; }`
    const f = fakeHost({ shell: {}, scores: [{ 'mine-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, reviewers: [{ name: 'mine', engine: 'command', command }] } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Custom'])
    expect(readFileSync(join(repo, workDir, 'review-core-r1-mine.md'), 'utf8')).toContain('Custom')
  })

  it('reads what a command reviewer printed, not a review file an earlier run left behind', async () => {
    mkdirSync(join(repo, '.granny'))
    writeFileSync(join(repo, '.granny/review-core-r1-mine.md'), review(finding('P2', 'Stale from an earlier run')))
    writeFileSync(join(repo, '.granny/review-core-r1-mine.log'), 'stale log\n')
    const command = `test -n {base} && printf '%s\\n' '- [P1] Fresh — a.ts:1' '  printed to stdout'`
    const f = fakeHost({ shell: {}, scores: [{ 'mine-F1': 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, reviewers: [{ name: 'mine', engine: 'command', command }] } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Fresh'])
    expect(existsSync(join(repo, '.granny/review-core-r1-mine.md'))).toBe(false)
    expect(readFileSync(join(repo, '.granny/review-core-r1-mine.log'), 'utf8')).not.toContain('stale log')
  })
})

describe('the default reviewer', () => {
  it('is one agent reviewer on the host model that gets the stage task, and no Codex command runs', async () => {
    for (const name of ['claude-code', 'opencode'] as const) {
      const f = fakeHost({ name, direct: name === 'opencode' })
      const r = await runGranny(f.host, { repo: '/work/repo', branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'Do WP-01.' }] })
      expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
      const rv = f.calls.find(c => c.label === 'review core r1 reviewer')!
      expect(rv).toMatchObject({ role: 'reviewer', kind: 'findings', access: 'read-only' })
      expect(rv.model).toBeUndefined()
      expect(rv.prompt).toContain('TASK:\nDo WP-01.')
      expect(f.commands.some(c => c.includes('codex'))).toBe(false)
    }
  })
})
