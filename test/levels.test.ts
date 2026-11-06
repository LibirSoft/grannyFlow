import { describe, expect, it } from 'bun:test'
import { detailSiblings, flowOf, levelFrame, LevelNav, type LevelView } from '../src/adapters/runview/levels'
import type { RunOutline } from '../src/adapters/runview/outline'
import { buildRunTree, type JournalEntry, type RunInfo, type RunTree } from '../src/adapters/runview/tree'
import { runGranny } from '../src/core/engine'
import { fakeHost, finding, review, withCodex } from './fake-host'

const BASE = Date.parse('2026-11-06T10:00:00.000Z')
const S = 1000
const j = (sec: number, type: string, data: Record<string, unknown> = {}): JournalEntry => ({ t: new Date(BASE + sec * S).toISOString(), type, ...data })
const NOW = BASE + 100 * S
const stage = (number: number, name: string, checks = true) => ({ number, name, implement: true, review: true, checks })
const OUTLINE: RunOutline = { kind: 'implement', branch: 'feat/pause', worktree: true, planReview: false, finalReview: true, reviewers: ['terra', 'sol'], fromStage: 1, maxRounds: 4, stages: [stage(1, 'Server'), stage(2, 'Client')] }
const RUN: RunInfo = { id: 'R', status: 'running', startedAt: BASE, branch: 'feat/pause' }
const agent = (sec: number, label: string, role: string) => j(sec, 'agent', { label, role, session: `s:${label}`, model: 'openai/gpt-x', phase: 'Review' })
const end = (sec: number, label: string) => j(sec, 'agent-end', { label, session: `s:${label}`, outcome: 'done' })
const sent = { id: 'terra-F1', sent: true, severity: 'P1', title: 'Pause survives a reconnect', reviewer: 'terra', file: 'a.ts', line: 3, detail: 'It never stops.', why: 'P0/P1' }
const kept = { id: 'sol-F1', sent: false, severity: 'P3', title: 'Hard-coded text', reviewer: 'sol', verdict: 'confirmed', impact: 'minor', priority: 42, why: 'not above the threshold' }

const JOURNAL: JournalEntry[] = [
  j(0, 'phase', { title: 'Worktree' }),
  j(1, 'stage', { number: 1, name: 'Server', event: 'start' }),
  j(1, 'phase', { title: 'Implement' }),
  agent(1, 'implement Server', 'implementer'),
  end(20, 'implement Server'),
  j(21, 'log', { message: 'Server: checks green after implement' }),
  j(22, 'phase', { title: 'Review' }),
  agent(22, 'review Server r1 terra', 'reviewer'),
  agent(22, 'review Server r1 sol', 'reviewer'),
  end(30, 'review Server r1 terra'),
  end(32, 'review Server r1 sol'),
  agent(32, 'judge Server r1', 'judge'),
  end(35, 'judge Server r1'),
  j(35, 'round', { subject: 'Server', round: 1, findings: [sent, kept] }),
  agent(35, 'fix Server r1', 'implementer'),
  end(50, 'fix Server r1'),
  agent(50, 'commit Server fix r1', 'implementer'),
  end(52, 'commit Server fix r1'),
  j(53, 'log', { message: 'Server: checks green after fix r1' }),
  agent(55, 'review Server r2 terra', 'reviewer'),
  agent(55, 'review Server r2 sol', 'reviewer'),
]

const LIVE = new Map([['s:review Server r2 terra', { active: true }], ['s:review Server r2 sol', { active: true }]])
const treeOf = (entries = JOURNAL, run = RUN, outline: RunOutline | undefined = OUTLINE) => buildRunTree(run, entries, LIVE, NOW, new Map(), outline)
const viewOf = (tree: RunTree, width = 140, height = 27): LevelView => ({ tree, trees: [tree], now: NOW, width, height })
const text = (nav: LevelNav, view: LevelView) => nav.layout(view).rows.map(cells => cells.map(c => c.text).join('').trimEnd().replace(/ {2,}/g, '  '))

describe('flowOf', () => {
  it('splits the agents before the loop from each round, by the round in their label', () => {
    const { build, rounds } = flowOf(treeOf().groups[0]!)
    expect(build.map(a => a.action)).toEqual(['implement'])
    expect(rounds.map(r => [r.number, r.state, r.review.length, r.judge.length, r.fix.length])).toEqual([
      [1, 'done', 2, 1, 2],
      [2, 'running', 2, 0, 0],
    ])
    expect(rounds[0]!.checks).toBe('passed')
    expect(rounds[0]!.result?.findings.map(f => f.id)).toEqual(['terra-F1', 'sol-F1'])
    expect(rounds[1]!.result).toBeUndefined()
  })

  it('takes the round of a commit or a repair of a fix, whatever the stage is called', () => {
    const named = buildRunTree(RUN, [j(0, 'stage', { number: 1, name: 'fix r9 thing', event: 'start' }), agent(1, 'implement fix r9 thing', 'implementer'), agent(2, 'repair fix r9 thing fix r2 #1', 'implementer')], new Map(), NOW, new Map(), { ...OUTLINE, stages: [stage(1, 'fix r9 thing')] })
    expect(named.agents.map(a => a.round)).toEqual([undefined, 2])
  })

  it('reads a run journalled before round entries: its rounds come from the labels, with no results', () => {
    const old = treeOf(JOURNAL.filter(e => e.type !== 'round'))
    const { rounds } = flowOf(old.groups[0]!)
    expect(rounds.map(r => r.number)).toEqual([1, 2])
    expect(rounds[0]!.result).toBeUndefined()
  })

  it('drops what is not a finding from a round entry, and keeps a round with none', () => {
    const tree = treeOf([...JOURNAL, j(60, 'round', { subject: 'Server', round: 2, findings: [null, 'x', { sent: true }, { id: 'a-F1', title: '\x1b[31mred\x1b[0m' }] }), j(61, 'round', { subject: 'nobody', round: 1, findings: [] })])
    const results = tree.groups[0]!.rounds!
    expect(results.map(r => r.round)).toEqual([1, 2])
    expect(results[1]!.findings).toEqual([{ id: 'a-F1', sent: false, title: 'red' }])
  })
})

describe('the levels', () => {
  it('goes stage, rounds, the agents of a round, one agent, and back, keeping each selection', () => {
    const nav = new LevelNav()
    const view = viewOf(treeOf())
    expect(text(nav, view).slice(0, 5)).toEqual(['  ✓ Worktree  1s', '  │', '› ● 1 Server  round 2 of 4  8 agents · 2 running  1m39s', '  │', '  · 2 Client  waiting'])
    nav.enter()
    const rounds = text(nav, view)
    expect(rounds).toContain('│  ✓ Round 1  2 findings: 1 sent back, 1 kept  5 agents  30s │')
    expect(rounds).toContain('│ › ● Round 2  reviewing  2 agents · 2 running  45s │')
    expect(rounds).toContain('│  · Round 3  only if round 2 sends findings back  │')
    expect(rounds).toContain('│  · Round 4  the last one  │')
    expect(rounds.at(-1)).toBe('  · Next  2 Client')
    nav.enter()
    const agents = text(nav, view)
    expect(agents[0]).toBe('  ● Review  2 agents at the same time')
    expect(agents.some(l => l.includes('● terra  45s') && l.includes('● sol  45s'))).toBe(true)
    expect(agents).toContain('  · Judge  after the reviewers')
    expect(agents).toContain('  · Fix  only if findings go back')
    expect(agents).toContain('  · Checks  after the fix')
    expect(agents.at(-1)).toBe('  · Next  Round 3, or the stage is done')
    expect(nav.selected).toBe('agent:s:review Server r2 terra')
    nav.move(1)
    expect(nav.selected).toBe('agent:s:review Server r2 sol')
    nav.enter()
    expect(nav.detail).toBe('agent:s:review Server r2 sol')
    expect(nav.layout(view).crumbs.map(c => c.text).join('')).toBe('granny › 1 Server › Round 2 of 4 › review r2 sol')
    expect(nav.back()).toBe(true)
    expect(nav.selected).toBe('agent:s:review Server r2 sol')
    expect(nav.back()).toBe(true)
    expect(nav.selected).toBe('round:stage:1:2')
    expect(nav.back()).toBe(true)
    expect(nav.back()).toBe(false)
  })

  it('shows a finished round by what it did, moves between rounds with [ ], and opens its findings', () => {
    const nav = new LevelNav()
    const tree = treeOf()
    const view = viewOf(tree)
    nav.layout(view)
    nav.enter()
    nav.layout(view)
    nav.enter()
    nav.layout(view)
    nav.findings(tree)
    expect(nav.screen.kind).toBe('round')
    nav.otherRound(tree, -1)
    const page = nav.layout(view)
    expect(page.help).toContain('f findings')
    const rows = text(nav, view)
    expect(rows[0]).toBe('  ✓ Review  2 findings')
    expect(rows.some(l => l.includes('✓ terra  8s') && l.includes('✓ sol  10s'))).toBe(true)
    expect(rows.filter(l => l.includes('1 finding'))).toHaveLength(1)
    expect(rows).toContain('  ✓ Judge  1 sent back, 1 kept  3s')
    expect(rows).toContain('  ✓ Fix  gpt-x  15s')
    expect(rows).toContain('  ✓ commit  gpt-x  2s')
    expect(rows.at(-1)).toBe('  ↺ Next  Round 2')
    nav.otherRound(tree, -1)
    expect(nav.screen).toEqual({ kind: 'round', group: 'stage:1', round: 1 })
    nav.findings(tree)
    const found = text(nav, view)
    expect(found[0]).toBe('› ↺ Pause survives a reconnect  sent back')
    expect(found[1]).toBe('  · Hard-coded text  kept')
    expect(found).toContain('WHERE a.ts:3')
    expect(found).toContain('SAID  terra P1: It never stops.')
    expect(found).toContain('WHY  P0/P1')
    nav.move(1)
    expect(text(nav, view)).toContain('JUDGE confirmed · minor · priority 42')
    nav.enter()
    expect(nav.detail).toBe('agent:s:review Server r1 sol')
  })

  it('stacks the cards when the width has room for one, and keeps every row inside the width', () => {
    const nav = new LevelNav()
    for (const width of [40, 60, 80, 100, 140, 200]) {
      const view = viewOf(treeOf(), width)
      nav.reset()
      for (const _ of [0, 1, 2]) {
        const page = nav.layout(view)
        for (const row of page.rows) expect(row.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(width)
        nav.enter()
      }
      nav.back()
    }
    const narrow = viewOf(treeOf(), 40)
    nav.reset()
    nav.layout(narrow)
    nav.enter()
    nav.layout(narrow)
    nav.enter()
    const rows = text(nav, narrow)
    expect(rows.filter(l => l.includes('terra')).some(l => l.includes('sol'))).toBe(false)
    expect(rows.some(l => l.includes('terra'))).toBe(true)
    expect(rows.some(l => l.includes('sol'))).toBe(true)
  })

  it('drops the connector rows when the page is short, and scrolls to the selection', () => {
    const nav = new LevelNav()
    const tall = text(nav, viewOf(treeOf(), 120, 27))
    expect(tall).toContain('  │')
    nav.reset()
    const short = text(nav, viewOf(treeOf(), 120, 6))
    expect(short).not.toContain('  │')
    const body = Array.from({ length: 20 }, (_, i) => [{ text: `row ${i}`, tone: 'base' as const }])
    const page = levelFrame([{ text: 'path', tone: 'base' }], body, 'help', 30, 8, 15).map(r => r.map(c => c.text).join('').trimEnd())
    expect(page).toHaveLength(8)
    expect(page[0]).toBe('path')
    expect(page.at(-1)).toBe('help')
    expect(page.slice(2, -1)).toContain('row 15')
    expect(page.every(l => l.length <= 30)).toBe(true)
  })

  it('opens the levels down to an agent, and Tab goes through its round with its subagents', () => {
    const tree = treeOf([...JOURNAL, j(56, 'subagent', { label: 'review Server r2 sol', agents: ['Audit'] })])
    const nav = new LevelNav()
    expect(nav.openAt(tree, 'agent:nobody')).toBe(false)
    expect(nav.openAt(tree, 'agent:s:review Server r2 terra')).toBe(true)
    expect(nav.layout(viewOf(tree)).crumbs.map(c => c.text).join('')).toBe('granny › 1 Server › Round 2 of 4 › review r2 terra')
    expect(detailSiblings(tree, nav.detail!)).toEqual(['agent:s:review Server r2 terra', 'agent:s:review Server r2 sol', 'sub:s:review Server r2 sol:Audit'])
    nav.stepDetail(tree, -1)
    expect(nav.detail).toBe('agent:s:review Server r2 terra')
    nav.stepDetail(tree, 1)
    nav.stepDetail(tree, 1)
    expect(nav.detail).toBe('sub:s:review Server r2 sol:Audit')
    nav.stepDetail(tree, 1)
    expect(nav.detail).toBe('sub:s:review Server r2 sol:Audit')
    nav.back()
    expect(nav.selected).toBe('agent:s:review Server r2 sol')
  })

  it('shows a clean round and what ended the stage', () => {
    const tree = treeOf(
      [...JOURNAL, end(60, 'review Server r2 terra'), end(60, 'review Server r2 sol'), j(60, 'round', { subject: 'Server', round: 2, findings: [] }), j(61, 'stage', { number: 1, name: 'Server', event: 'end', outcome: 'clean' })],
      { ...RUN, status: 'done', endedAt: BASE + 70 * S },
    )
    const nav = new LevelNav()
    const view = viewOf(tree)
    expect(text(nav, view).find(l => l.includes('1 Server'))).toMatch(/^. ✓ 1 Server {2}clean · 2 rounds {2}8 agents/)
    nav.openAt(tree, 'agent:s:review Server r2 terra')
    nav.back()
    const rows = text(nav, view)
    expect(rows[0]).toBe('  ✓ Review  no findings')
    expect(rows.at(-1)).toBe('  · Next  clean')
    expect(rows.join('\n')).not.toContain('Fix')
  })

  it('leaves the middle empty when a running group would repeat its name, and a stage keeps its action', () => {
    const live = (label: string) => new Map([[`s:${label}`, { active: true }]])
    const row = (tree: RunTree, name: string) => text(new LevelNav(), viewOf(tree)).find(l => l.includes(name))
    const planning: RunOutline = { kind: 'plan', branch: 'feat/x', worktree: false, planReview: false, finalReview: false, reviewers: [], fromStage: 1, stages: [] }
    const plan = buildRunTree(RUN, [j(0, 'phase', { title: 'Plan' }), agent(1, 'plan', 'planner')], live('plan'), NOW, new Map(), planning)
    expect(row(plan, 'Plan')).toBe('› ● Plan  1 agent · 1 running  1m40s')
    const judge: RunOutline = { ...planning, kind: 'judge' }
    const tag = buildRunTree(RUN, [j(0, 'phase', { title: 'Judge' }), { ...agent(1, 'tag feat/x', 'judge'), phase: 'Judge' }], live('tag feat/x'), NOW, new Map(), judge)
    expect(row(tag, 'Tag')).toBe('› ● Tag  1 agent · 1 running  1m40s')
    const building = [j(1, 'stage', { number: 1, name: 'Server', event: 'start' }), agent(1, 'implement Server', 'implementer')]
    expect(row(buildRunTree(RUN, building, live('implement Server'), NOW, new Map(), OUTLINE), '1 Server')).toBe('› ● 1 Server  implement  1 agent · 1 running  1m39s')
    const named = [j(1, 'stage', { number: 1, name: 'Implement', event: 'start' }), agent(1, 'implement Implement', 'implementer')]
    expect(row(buildRunTree(RUN, named, live('implement Implement'), NOW, new Map(), { ...OUTLINE, stages: [stage(1, 'Implement')] }), '1 Implement')).toBe('› ● 1 Implement  implement  1 agent · 1 running  1m39s')
  })
})

describe('the engine', () => {
  it('reports how each review round was routed, to the host, a clean one too', async () => {
    const f = fakeHost({ reviews: [review(finding('P1', 'Bad thing')), 'No findings.'] })
    await runGranny(f.host, withCodex({ repo: '/work/repo', branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 't' }] } as any) as any)
    expect(f.rounds.map(r => [r.subject, r.round, r.findings.length])).toEqual([['core', 1, 1], ['core', 2, 0]])
    expect(f.rounds[0]!.findings[0]).toMatchObject({ sent: true, severity: 'P1', title: 'Bad thing' })
  })
})
