import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/core/config'
import { judgePrompt, planJudgePrompt, tagPrompt, type EarlierRound } from '../src/core/prompts'
import { SCHEMAS } from '../src/core/schemas'
import type { Finding } from '../src/core/types'

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
