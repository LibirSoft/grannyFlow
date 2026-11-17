import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { judgePrompt, planJudgePrompt, tagPrompt, type EarlierRound } from '../src/core/prompts'
import { SCHEMAS } from '../src/core/schemas'
import type { AgentRequest, Finding } from '../src/core/types'
import { fakeHost, finding as reviewLine, review, withCodex } from './fake-host'

const withTags = resolveConfig([
  { tags: { typo: { description: 'a misspelled word in a comment, a string or a doc', fix: true }, naming: { description: 'a name that says something other than what the code does', points: 20 } } },
])
const plain = resolveConfig([])
const context = (config = plain) => ({ repo: '/work/repo', branch: 'feat/x', base: 'main', config })
const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, severity: 'P2', file: 'src/a.ts', line: 3, title: id, detail: 'd', ...extra })

const TAGS_BLOCK = [
  'TAGS - names the user gave to kinds of findings. Classify every finding first, exactly as above: a tag never changes a class. Then, when a finding is of one of these kinds, set its tag to that name; when several fit, the first one listed; when none fits, leave tag out. Use only these names:',
  '- typo: a misspelled word in a comment, a string or a doc',
  '- naming: a name that says something other than what the code does',
].join('\n')

describe('config tags in the judge prompts', () => {
  it('adds no TAGS block to a judge prompt without tags, and none to the plan judge or the tagging judge with tags', () => {
    expect(judgePrompt(context(), 'base', [finding('a')])).not.toContain('TAGS - ')
    expect(planJudgePrompt(context(withTags), ['/plans/v1.md'], [finding('a')])).not.toContain('TAGS - ')
    expect(tagPrompt(context(withTags), 'base', [finding('a')])).not.toContain('TAGS - ')
  })

  it('lists each tag by its name and description after the rubric, and never its points or fix', () => {
    const prompt = judgePrompt(context(withTags), 'base', [finding('a')])
    expect(prompt).toContain(TAGS_BLOCK)
    expect(prompt.indexOf(TAGS_BLOCK)).toBeGreaterThan(prompt.indexOf('Example:'))
    expect(prompt.indexOf(TAGS_BLOCK) + TAGS_BLOCK.length).toBeLessThan(prompt.indexOf('REVIEW:'))
    expect(prompt).not.toContain('points')
  })

  it('shows the tag of an earlier finding in EARLIER DECISIONS, and no tag key for one without a tag', () => {
    const decided = { verdict: 'confirmed', impact: 'minor', likelihood: 'edge', fixCost: 'trivial', scope: 'in-scope', evidence: 'src/a.ts:3 - x', priority: 40 } as const
    const tagged = finding('codex-F1', { ...decided, tag: 'typo', decision: { rule: 10, action: 'fix', why: 'tag typo is marked fix (minor/edge/trivial -> 40)' } })
    const untagged = finding('codex-F2', { ...decided, decision: { rule: 8, action: 'residual', why: 'under the bar: minor/edge/trivial -> 40' } })
    const earlier = (f: Finding): EarlierRound[] => [{ round: 1, sent: [f] }]
    expect(judgePrompt(context(withTags), 'base', [finding('x')], earlier(tagged))).toContain('"tag":"typo"')
    expect(judgePrompt(context(withTags), 'base', [finding('x')], earlier(untagged))).not.toContain('"tag"')
  })

  it('declares an optional string tag on each judged finding', () => {
    const item = (SCHEMAS.judge.properties.perFinding as { items: { properties: Record<string, { type: string }>; required: string[] } }).items
    expect(item.properties.tag!.type).toBe('string')
    expect(item.required).not.toContain('tag')
  })
})

describe('config tags in a run', () => {
  const TYPO = { typo: { description: 'a misspelled word in a comment, a string or a doc', fix: true } }
  const run = (extra: Partial<RunInput> = {}): RunInput =>
    withCodex({ repo: '/work/repo', branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'Do WP-01.' }], ...extra })
  const labelled = (calls: AgentRequest[], label: string) => calls.find(c => c.label === label)?.prompt
  const declineIn = (label: string) => (req: AgentRequest) =>
    req.label === label
      ? { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'all green', commits: [], untested: '', declined: [{ id: 'codex-F1', reason: 'the null check in parse() stops it' }] }
      : undefined

  it('sends a tagged finding to the fixer as rule 10, and the stage ends clean after the fix round', async () => {
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Misspelt word')), 'No findings.'], scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }] })
    const r = await runGranny(f.host, run({ config: { tags: TYPO } }))
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
    expect(labelled(f.calls, 'judge core r1')).toContain('TAGS - ')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings[0]).toMatchObject({ tag: 'typo', decision: { rule: 10, action: 'fix' } })
  })

  it('sends nothing for a tag the config does not define: no fix round, no tag, no log line about a tag', async () => {
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Misspelt word')), 'No findings.'], scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }] })
    const r = await runGranny(f.host, run())
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.stages[0]!.residual[0]).not.toHaveProperty('tag')
    expect(f.logs.filter(l => /\btag/.test(l))).toEqual([])
  })

  it('starts a fix round for a tagged finding in every round, up to maxRounds', async () => {
    const f = fakeHost({
      reviews: [review(reviewLine('P2', 'Misspelt one')), review(reviewLine('P2', 'Misspelt two')), 'No findings.'],
      scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }, { 'codex-F1': { score: 40, tag: 'typo' } }],
    })
    const r = await runGranny(f.host, run({ config: { tags: TYPO } }))
    expect(f.calls.map(c => c.label).filter(l => l.startsWith('fix core'))).toEqual(['fix core r1', 'fix core r2'])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 3 })
  })

  it('ends a stage at round-cap when maxRounds is reached, and lists the tagged finding of the last round as unresolved', async () => {
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Misspelt word'))], scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }] })
    const r = await runGranny(f.host, run({ config: { tags: TYPO, maxRounds: 1 } }))
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 1 })
    expect(r.stages[0]!.unresolved).toEqual([expect.objectContaining({ id: 'codex-F1', decision: expect.objectContaining({ rule: 10 }) })])
  })

  it('sends a major finding and a tagged one to the same fix round', async () => {
    const f = fakeHost({
      reviews: [review(reviewLine('P2', 'Major problem'), reviewLine('P3', 'Misspelt word', 'src/c.ts', 5)), 'No findings.'],
      scores: [
        {
          'codex-F1': { verdict: 'confirmed', impact: 'major', likelihood: 'common', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - x' },
          'codex-F2': { score: 40, tag: 'typo' },
        },
      ],
    })
    const r = await runGranny(f.host, run({ config: { tags: TYPO } }))
    const fix = labelled(f.calls, 'fix core r1')!
    expect(fix).toContain('"id":"codex-F1"')
    expect(fix).toContain('"id":"codex-F2"')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
  })

  it('logs the tag names the config does not have once a round, and sends nothing for them', async () => {
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Odd word')), 'No findings.'], scores: [{ 'codex-F1': { score: 40, tag: 'nit' } }] })
    const r = await runGranny(f.host, run({ config: { tags: TYPO } }))
    expect(f.logs).toContain('core r1: the judge named tag(s) the config does not have - ignored: codex-F1 "nit"')
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.stages[0]!.residual[0]!.decision).toMatchObject({ rule: 8 })
  })

  it('logs an unknown tag on one line, cut to 40 characters', async () => {
    const odd = `odd\nname ${'x'.repeat(100)}`
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Odd word')), 'No findings.'], scores: [{ 'codex-F1': { score: 40, tag: odd } }] })
    await runGranny(f.host, run({ config: { tags: TYPO } }))
    expect(f.logs).toContain(`core r1: the judge named tag(s) the config does not have - ignored: codex-F1 "odd\\nname ${'x'.repeat(31)}..."`)
  })

  it('logs nothing for a tag of none', async () => {
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Odd word')), 'No findings.'], scores: [{ 'codex-F1': { score: 40, tag: 'none' } }] })
    await runGranny(f.host, run({ config: { tags: TYPO } }))
    expect(f.logs.filter(l => l.includes('named tag'))).toEqual([])
  })

  it('keeps a repeat of a finding the fixer declined residual with no tag, even when the judge names one again', async () => {
    const phantom = review(reviewLine('P2', 'Misspelt word'))
    const f = fakeHost({
      reviews: [phantom, phantom, 'No findings.'],
      scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }, { 'codex-F1': { score: 40, tag: 'typo', repeatOf: 'r1/codex-F1' } }],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, run({ config: { tags: TYPO, maxRounds: 3 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toEqual([expect.objectContaining({ repeatOf: 'r1/codex-F1', decision: expect.objectContaining({ rule: 8 }) })])
    expect(r.stages[0]!.residual[0]).not.toHaveProperty('tag')
  })

  it('does not send a repeat of a declined finding to the fixer through a tagged duplicate of it', async () => {
    const f = fakeHost({
      reviews: [review(reviewLine('P2', 'Misspelt word')), review(reviewLine('P2', 'Misspelt word again'), reviewLine('P3', 'Misspelt word', 'src/c.ts', 5)), 'No findings.'],
      scores: [
        { 'codex-F1': { verdict: 'confirmed', impact: 'moderate', likelihood: 'common', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - misspelt word' } },
        {
          'codex-F1': { verdict: 'confirmed', impact: 'moderate', likelihood: 'edge', fixCost: 'large', scope: 'in-scope', evidence: 'src/a.ts:3 - misspelt word', repeatOf: 'r1/codex-F1' },
          'codex-F2': { score: 40, tag: 'typo', duplicateOf: 'codex-F1' },
        },
      ],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, run({ config: { tags: TYPO, maxRounds: 3 } }))
    expect(f.calls.some(c => c.label === 'fix core r2')).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toEqual([expect.objectContaining({ repeatOf: 'r1/codex-F1', decision: expect.objectContaining({ rule: 8 }) })])
    expect(r.stages[0]!.residual[0]).not.toHaveProperty('tag')
  })

  it('does not send a declined repeat to the fixer through a tagged finding it is merged into', async () => {
    const f = fakeHost({
      reviews: [review(reviewLine('P2', 'Misspelt word')), review(reviewLine('P2', 'Misspelt word again'), reviewLine('P3', 'Misspelt word', 'src/c.ts', 5)), 'No findings.'],
      scores: [
        { 'codex-F1': { verdict: 'confirmed', impact: 'moderate', likelihood: 'common', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - misspelt word' } },
        {
          'codex-F1': { verdict: 'confirmed', impact: 'moderate', likelihood: 'edge', fixCost: 'large', scope: 'in-scope', evidence: 'src/a.ts:3 - misspelt word', repeatOf: 'r1/codex-F1', duplicateOf: 'codex-F2' },
          'codex-F2': { score: 40, tag: 'typo' },
        },
      ],
      override: declineIn('fix core r1'),
    })
    const r = await runGranny(f.host, run({ config: { tags: TYPO, maxRounds: 3 } }))
    expect(f.calls.some(c => c.label === 'fix core r2')).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 2 })
    expect(r.stages[0]!.residual).toEqual([expect.objectContaining({ id: 'codex-F2', duplicates: ['codex-F1'], decision: expect.objectContaining({ rule: 8 }) })])
    expect(r.stages[0]!.residual[0]).not.toHaveProperty('tag')
  })

  it('keeps tags out of the plan review judge, and a plan finding it tags stays residual', async () => {
    const PLAN = '/plans/v1.md'
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Misspelt plan word', PLAN))], scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }] })
    const r = await runGranny(f.host, run({ plan: PLAN, config: { tags: TYPO, planReview: true, maxRounds: 1 } }))
    expect(labelled(f.calls, 'judge plan review r1')).toBeDefined()
    expect(labelled(f.calls, 'judge plan review r1')).not.toContain('TAGS - ')
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.plan!.residual[0]).toMatchObject({ decision: { rule: 8 } })
    expect(r.plan!.residual[0]).not.toHaveProperty('tag')
  })

  it('logs no unknown tag in the plan review, where no tag applies', async () => {
    const PLAN = '/plans/v1.md'
    const f = fakeHost({ reviews: [review(reviewLine('P2', 'Odd plan word', PLAN))], scores: [{ 'codex-F1': { score: 40, tag: 'nit' } }] })
    const r = await runGranny(f.host, run({ plan: PLAN, config: { tags: TYPO, planReview: true, maxRounds: 1 } }))
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(f.logs.filter(l => l.includes('named tag'))).toEqual([])
  })

  it('gives the final review judge the TAGS block too', async () => {
    const f = fakeHost({ reviews: ['No findings.', 'No findings.', review(reviewLine('P2', 'Misspelt word'))], scores: [{ 'codex-F1': { score: 40, tag: 'typo' } }] })
    await runGranny(f.host, run({ stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [1] }], config: { tags: TYPO } }))
    expect(labelled(f.calls, 'judge final review r1')).toContain('TAGS - ')
  })
})
