import { describe, expect, it } from 'bun:test'
import { clock, fit, pad, shortArg, shortModel } from '../src/adapters/runview/format'
import { readOutline, runOutline } from '../src/adapters/runview/outline'
import { resolveConfig } from '../src/core/config'
import type { RunInput } from '../src/core/engine'
import { buildRunTree, type JournalEntry, type LiveView, rowText, visibleRows } from '../src/adapters/runview/tree'

const BASE = Date.parse('2026-11-05T18:23:28.000Z')
const S = 1000
const M = 60 * S
const j = (ms: number, type: string, data: Record<string, unknown> = {}): JournalEntry => ({ t: new Date(BASE + ms).toISOString(), type, ...data })
const kimi = { providerID: 'opencode', id: 'kimi-k3.1-pro' }

const opencodeJournal: JournalEntry[] = [
  j(0, 'phase', { title: 'Plan' }),
  j(1 * S, 'agent', { label: 'plan', role: 'planner', session: 'ses_plan', model: kimi, phase: 'Plan', linked: true }),
  j(31 * M, 'agent-end', { label: 'plan', session: 'ses_plan', outcome: 'done' }),
  j(31 * M, 'phase', { title: 'Plan review' }),
  j(31 * M + 1 * S, 'agent', { label: 'review plan review r1 terra', role: 'reviewer', session: 'ses_r1', model: { ...kimi, variant: 'high' }, phase: 'Plan review', linked: true }),
  j(32 * M, 'link-failed', { label: 'judge plan review r1', error: 'move failed' }),
  j(32 * M, 'agent', { label: 'judge plan review r1', role: 'judge', session: 'ses_j1', model: null, phase: 'Plan review', linked: false }),
  j(32 * M + 30 * S, 'agent-end', { label: 'judge plan review r1', session: 'ses_j1', outcome: 'failed', error: 'no answer' }),
]

describe('buildRunTree with an opencode journal', () => {
  const now = BASE + 33 * M
  const live = new Map<string, LiveView>([['ses_r1', { active: true }]])
  const tree = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, opencodeJournal, live, now)

  it('renders object models as provider/id[#variant] and ends agents from agent-end', () => {
    const rows = visibleRows([tree], new Set(), 'R')
    expect(rows.map(r => rowText(r, now))).toEqual([
      '▾ run R · running · 33m00s',
      '  ✓ Plan · 31m00s',
      '    ✓ plan  planner · opencode/kimi-k3.1-pro · 30m59s',
      '  ● Plan review · 2m00s',
      '    plan review · round 1',
      '      ● review plan review r1 terra  reviewer · opencode/kimi-k3.1-pro#high · 1m59s',
      '      ✗ judge plan review r1  judge · default model · 30s',
    ])
    expect(tree.agents.find(a => a.session === 'ses_j1')?.error).toBe('no answer')
  })

  it('marks a running agent without live state as running with no activity', () => {
    const agent = tree.agents.find(a => a.session === 'ses_r1')!
    expect(agent.state).toBe('running')
    expect(agent.activity).toBeUndefined()
  })

  it('takes the activity from a live view that has a state and since', () => {
    const busy = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, opencodeJournal, new Map([['ses_r1', { active: true, state: 'thinking', since: now - 5 * S }]]), now)
    expect(busy.agents.find(a => a.session === 'ses_r1')?.activity).toBe('thinking 5s')
  })

  it('shows link-failed as a line of its phase', () => {
    const review = tree.phases.find(p => p.title === 'Plan review')!
    expect(review.lines).toContain(`${clock(BASE + 32 * M)}  ! judge plan review r1: not linked to the parent session (move failed)`)
    expect(tree.phases.find(p => p.title === 'Plan')!.lines.some(l => l.includes('not linked'))).toBe(false)
  })

  it('lists an object model in the agent start line', () => {
    const plan = tree.phases.find(p => p.title === 'Plan')!
    expect(plan.lines[0]).toBe(`${clock(BASE + 1 * S)}  ▸ plan started (planner · opencode/kimi-k3.1-pro)`)
  })

  it('ignores a malformed object model', () => {
    const odd = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, [j(0, 'agent', { label: 'x', role: 'implementer', session: 's', model: { providerID: 'p' } })], new Map(), BASE)
    expect(odd.agents[0]!.model).toBeUndefined()
  })
})

describe('buildRunTree with control characters in the journal', () => {
  const DIRTY = /[\x00-\x08\x0b-\x1f\x7f]/
  it('drops ANSI codes, carriage returns and bells from log, command, error and agent text', () => {
    const tree = buildRunTree(
      { id: 'R', status: 'failed', startedAt: BASE },
      [
        j(0, 'phase', { title: 'Plan' }),
        j(1 * S, 'agent', { label: 'plan\x1b[1m', role: 'planner\x07', session: 'ses_plan', model: null, phase: 'Plan' }),
        j(2 * S, 'log', { message: '\x1b[31mred\x1b[0m line\r\nnext\x07' }),
        j(3 * S, 'command', { command: 'echo \x1b[31mhi\r' }),
        j(4 * S, 'agent-end', { label: 'plan', session: 'ses_plan', outcome: 'failed', error: 'boom\x1b[0m\r' }),
        j(5 * S, 'error', { error: 'broke\x07\r' }),
      ],
      new Map(),
      BASE + M,
    )
    const lines = tree.phases[0]!.lines
    expect(lines).toContain(`${clock(BASE + 2 * S)}  red line`)
    expect(lines).toContain('          next')
    expect(lines).toContain(`${clock(BASE + 3 * S)}  $ echo hi`)
    expect(lines).toContain(`${clock(BASE + 5 * S)}  ✗ run failed: broke`)
    for (const l of lines) expect(l).not.toMatch(DIRTY)
    expect(tree.agents[0]).toMatchObject({ label: 'plan', role: 'planner', error: 'boom' })
  })
})

describe('runOutline', () => {
  const run = (input: Partial<RunInput>, config: unknown = {}) =>
    runOutline({ repo: '/r', branch: 'feat/x', stages: [{ name: 'one', task: 't' }], ...input }, resolveConfig([config]))

  it('names the stages as the engine does and says which steps the run has', () => {
    expect(run({ stages: [{ name: 'one', task: 't' }, { task: 'u', checks: [] }, { name: 'r', review: false, implement: false }] }, { checks: [{ name: 'test', run: 'bun test' }] })).toEqual({
      kind: 'implement',
      branch: 'feat/x',
      worktree: true,
      planReview: false,
      finalReview: true,
      reviewers: ['reviewer'],
      fromStage: 1,
      stages: [
        { number: 1, name: 'one', implement: true, review: true, checks: true },
        { number: 2, name: 'stage 2', implement: true, review: true, checks: false },
        { number: 3, name: 'r', implement: false, review: false, checks: true },
      ],
    })
  })

  it('has no checks without configured checks, and no final review for one stage', () => {
    expect(run({}, { worktree: false })).toMatchObject({ worktree: false, finalReview: false, stages: [{ number: 1, name: 'one', implement: true, review: true, checks: false }] })
  })

  it('reviews the plan only in a planning run or with a plan and no later fromStage', () => {
    expect(run({}, { planReview: true }).planReview).toBe(false)
    expect(run({ plan: ['/p.md'] }, { planReview: true }).planReview).toBe(true)
    expect(run({ plan: ['/p.md'], stages: [{ task: 'a' }, { task: 'b' }], fromStage: 2 }, { planReview: true })).toMatchObject({ planReview: false, fromStage: 2 })
    expect(run({ plan: ['/p.md'] }).planReview).toBe(false)
    const plan = runOutline({ repo: '/r', branch: 'feat/x', goal: 'build it' }, resolveConfig([{ planReview: true, reviewers: [{ name: 'a', engine: 'agent' }, { name: 'b', engine: 'agent' }] }]))
    expect(plan).toMatchObject({ kind: 'plan', planReview: true, finalReview: false, stages: [], reviewers: ['a', 'b'] })
  })

  it('drops control characters from the names', () => {
    expect(run({ branch: 'feat/\x1b[1mx', stages: [{ name: 'o\rne', task: 't' }] }).stages[0]!.name).toBe('one')
  })
})

describe('readOutline', () => {
  const good = runOutline({ repo: '/r', branch: 'feat/x', stages: [{ name: 'one', task: 't' }] }, resolveConfig([]))

  it('reads back what runOutline wrote', () => {
    expect(readOutline(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })

  it('rejects anything malformed', () => {
    for (const bad of [undefined, null, 'x', [], { ...good, stages: 'one' }, { ...good, stages: [{ ...good.stages[0], name: 3 }] }, { ...good, kind: 'other' }, { ...good, reviewers: [1] }, { ...good, fromStage: '1' }, { ...good, planReview: 'yes' }]) {
      expect(readOutline(bad)).toBeUndefined()
    }
  })

  it('cleans the text it reads', () => {
    expect(readOutline({ ...good, branch: 'a\x07b', stages: [{ ...good.stages[0], name: 'o\x1b[0mne' }] })).toMatchObject({ branch: 'ab', stages: [{ name: 'one' }] })
  })
})

describe('fit and pad', () => {
  it('cuts with … to the width and pads to it', () => {
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('abc', 4)).toBe('abc')
    expect(fit('a\tb', 10)).toBe('a  b')
    expect(fit('abc', 0)).toBe('')
    expect(pad('abcdef', 4)).toBe('abc…')
    expect(pad('ab', 4)).toBe('ab  ')
  })
})

describe('shortModel', () => {
  it('drops the provider and #default, shows another variant and the effort', () => {
    expect(shortModel('kimi-code-plan-global/k3.1-pro#default')).toBe('k3.1-pro')
    expect(shortModel('openai-codex/gpt-6.1-sol', 'xhigh')).toBe('gpt-6.1-sol/xhigh')
    expect(shortModel('a/b#high')).toBe('b/high')
    expect(shortModel('sonnet')).toBe('sonnet')
    expect(shortModel(undefined)).toBe('default model')
    expect(shortModel(undefined, 'high')).toBe('default model/high')
  })
})

describe('shortArg', () => {
  it('drops a leading cd into a directory, the work directory and runs of whitespace', () => {
    expect(shortArg("cd '/w t' && bun test x", '/w t')).toBe('bun test x')
    expect(shortArg('cd /w && git   status\n  --short', '/w')).toBe('git status --short')
    expect(shortArg('/w/src/a.ts', '/w')).toBe('src/a.ts')
    expect(shortArg('/w/src/a.ts', '/w/')).toBe('src/a.ts')
    expect(shortArg('/w', '/w')).toBe('.')
    expect(shortArg('/wx/a.ts', '/w')).toBe('/wx/a.ts')
    expect(shortArg('grep -n x /w/src /w/test', '/w')).toBe('grep -n x src test')
  })

  it('writes a path under the home directory as ~/…, and never cuts', () => {
    expect(shortArg('/home/u/notes/a.md', '/w', '/home/u')).toBe('~/notes/a.md')
    expect(shortArg('x'.repeat(300))).toHaveLength(300)
  })

  it('drops control characters', () => {
    expect(shortArg('\x1b[31mred\x1b[0m\r')).toBe('red')
  })
})
