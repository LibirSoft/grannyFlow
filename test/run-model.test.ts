import { describe, expect, it } from 'bun:test'
import { judgeOutline, type RunOutline } from '../src/adapters/runview/outline'
import { resolveConfig } from '../src/core/config'
import { duration, fit } from '../src/adapters/runview/format'
import { AGENT_MARKERS, buildRunTree, focusStage, GROUP_MARKERS, type JournalEntry, placeOf, type Row, visibleRows } from '../src/adapters/runview/tree'

const BASE = Date.parse('2026-11-05T20:30:25.000Z')
const S = 1000
const j = (sec: number, type: string, data: Record<string, unknown> = {}): JournalEntry => ({ t: new Date(BASE + sec * S).toISOString(), type, ...data })
const WT = '/w/asena-peer-pong-worktrees/feat-pause'
const S1 = 'Server pause domain, lifecycle, and real-socket proof'
const S2 = 'Client pause UI and e2e'

const stageOutline = (name: string, number: number, over: Partial<RunOutline['stages'][number]> = {}) => ({ number, name, implement: true, review: true, checks: true, ...over })
const outlineOf = (over: Partial<RunOutline> = {}): RunOutline => ({
  kind: 'implement',
  branch: 'feat/pause',
  worktree: true,
  planReview: false,
  finalReview: true,
  reviewers: ['a', 'b'],
  fromStage: 1,
  stages: [stageOutline(S1, 1), stageOutline(S2, 2)],
  ...over,
})

let n = 0
const agent = (sec: number, label: string, role: string, phase: string, extra: Record<string, unknown> = {}) => {
  const session = `ses_${++n}`
  return { session, entry: j(sec, 'agent', { label, role, phase, session, model: { providerID: 'kimi-code-plan-global', id: 'k3.1-pro', variant: 'default' }, cwd: WT, linked: true, ...extra }) }
}
const ended = (sec: number, a: { session: string; entry: JournalEntry }, outcome = 'done') => j(sec, 'agent-end', { label: a.entry.label, session: a.session, outcome })

function twoStages() {
  n = 0
  const impl1 = agent(3, `implement ${S1}`, 'implementer', 'Implement')
  const commit1 = agent(101, `commit ${S1} implement`, 'implementer', 'Implement')
  const ra = agent(132, `review ${S1} r1 a`, 'reviewer', 'Review')
  const rb = agent(132, `review ${S1} r1 b`, 'reviewer', 'Review')
  const judge = agent(201, `judge ${S1} r1`, 'judge', 'Review')
  const fix = agent(232, `fix ${S1} r1`, 'implementer', 'Implement')
  const impl2 = agent(303, `implement ${S2}`, 'implementer', 'Implement')
  const entries = [
    j(0, 'phase', { title: 'Worktree' }),
    j(0, 'command', { command: 'git worktree add' }),
    j(1, 'log', { message: `worktree: ${WT}` }),
    j(2, 'stage', { number: 1, name: S1, event: 'start' }),
    j(2, 'phase', { title: 'Implement' }),
    impl1.entry,
    ended(100, impl1),
    commit1.entry,
    ended(110, commit1),
    j(111, 'phase', { title: 'Checks' }),
    j(111, 'command', { command: 'bun test' }),
    j(130, 'log', { message: `${S1}: checks green (implement: test)` }),
    j(131, 'phase', { title: 'Review' }),
    ra.entry,
    rb.entry,
    ended(200, ra),
    ended(200, rb),
    judge.entry,
    ended(230, judge),
    j(231, 'phase', { title: 'Implement' }),
    fix.entry,
    ended(300, fix),
    j(301, 'stage', { number: 1, name: S1, event: 'end', outcome: 'clean' }),
    j(302, 'stage', { number: 2, name: S2, event: 'start' }),
    j(302, 'phase', { title: 'Implement' }),
    impl2.entry,
  ]
  return { entries, impl2 }
}

const NOW = BASE + 400 * S
const RUN = { id: '20261105-203025-7i5w', status: 'running', startedAt: BASE, branch: 'feat/pause' }
const view = (over: Partial<Parameters<typeof visibleRows>[1]> = {}) => ({ run: RUN.id, folded: new Set<string>(), opened: new Set<string>(), runs: 'one' as const, ...over })
const span = (start: number | undefined, end: number | undefined, now: number) => (start === undefined ? undefined : duration((end ?? now) - start))

/** `left` cut to leave room for `right`, right-aligned at `width`; `right` is dropped below 24 columns. */
function aligned(left: string, right: string | undefined, width: number): string {
  if (!right || width < 24) return fit(left, width)
  const room = width - right.length - 2
  return `${fit(left, room).padEnd(room)}  ${right}`
}

/** The row model as text, to read the tree's shape from. */
function rowText(row: Row, now: number, width: number): string {
  const indent = '  '.repeat(row.depth)
  switch (row.kind) {
    case 'group': {
      const g = row.group!
      const name = g.number !== undefined ? `${g.number} ${g.title}` : g.title
      if (g.state === 'upcoming') return fit(`    ${name}`, width)
      const head = `${row.folded ? '▸' : '▾'} ${GROUP_MARKERS[g.state]} `
      const right = span(g.start, g.end, now)
      const tail = g.state === 'failed' && g.outcome ? ` ${g.outcome}` : ''
      const full = `${head}${name}${tail}`
      const room = width - (right && width >= 24 ? right.length + 2 : 0)
      if (!tail || full.length <= room || room - head.length - tail.length < 8) return aligned(tail && full.length > room ? `${head}${name}` : full, right, width)
      return aligned(`${head}${fit(name, room - head.length - tail.length)}${tail}`, right, width)
    }
    case 'agent': {
      const a = row.agent!
      return aligned(`${indent}${AGENT_MARKERS[a.state]} ${a.action}`, span(a.start, a.end, now), width)
    }
    case 'checks': {
      const c = row.group!.checks
      const text = !c ? 'checks' : c.state === 'running' ? 'checks …' : c.state === 'passed' ? 'checks ✓' : `checks ✗${c.failed.length ? ` ${c.failed.join(', ')}` : ''}`
      return fit(`${indent}${text}`, width)
    }
    case 'sub':
      return fit(`${indent}└ ${AGENT_MARKERS[row.agent!.state]} ${row.sub!.name}`, width)
    case 'label':
      return fit('runs', width)
    case 'run':
      return row.details ? fit('run details', width) : aligned(`${row.run.status === 'running' ? '●' : '✓'} ${row.run.id.slice(-4)} · ${row.run.status}${row.shown ? ' (shown)' : ''}`, duration((row.run.end ?? now) - row.run.start), width)
  }
}

const listing = (rows: Row[], width: number, now = NOW) => rows.map(r => rowText(r, now, width))
const right = (left: string, time: string, width = 60) => `${left.padEnd(width - time.length - 2)}  ${time}`

describe('the stage-grouped run tree', () => {
  it('lists a stage per group with its agents, a checks row and the stages and steps still to come', () => {
    const { entries, impl2 } = twoStages()
    const tree = buildRunTree(RUN, entries, new Map([[impl2.session, { active: true }]]), NOW, new Map(), outlineOf())
    const focus = focusStage(tree)
    expect(focus).toBe(2)
    expect(listing(visibleRows([tree], view({ focus })), 60)).toEqual([
      right('▸ ✓ 1 Server pause domain, lifecycle, and real-socke…', '4m59s'),
      right('▾ ● 2 Client pause UI and e2e', '1m38s'),
      right('  ● implement', '1m37s'),
      '    Final review',
      '    PR ready',
      'run details',
    ])
    const opened = listing(visibleRows([tree], view({ focus, opened: new Set([`group:${RUN.id}:stage:1`]) })), 60)
    expect(opened.slice(1, 9)).toEqual([
      right('  ✓ implement', '1m37s'),
      right('  ✓ commit', '9s'),
      '  checks ✓',
      right('  ✓ review r1 a', '1m08s'),
      right('  ✓ review r1 b', '1m08s'),
      right('  ✓ judge r1', '29s'),
      right('  ✓ fix r1', '1m08s'),
      right('▾ ● 2 Client pause UI and e2e', '1m38s'),
    ])
    for (const width of [24, 36, 60]) for (const line of opened.map((_, i) => rowText(visibleRows([tree], view({ focus, opened: new Set([`group:${RUN.id}:stage:1`]) }))[i]!, NOW, width))) expect(line.length).toBeLessThanOrEqual(width)
    expect(tree.agents.every(a => a.cwd === WT)).toBe(true)
    expect(tree.groups.map(g => [g.key, g.state])).toEqual([
      ['stage:1', 'done'],
      ['stage:2', 'running'],
      ['final-review', 'upcoming'],
      ['pr-ready', 'upcoming'],
    ])
    expect(tree.running).toEqual([2])
  })

  it('drops the reviewer from the action when the run has one reviewer, and leaves Worktree and commands out', () => {
    const { entries } = twoStages()
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf({ reviewers: ['a'] }))
    const rows = visibleRows([tree], view({ opened: new Set([`group:${RUN.id}:stage:1`]) }))
    expect(rows.filter(r => r.kind === 'agent').map(r => r.agent!.action)).toEqual(['implement', 'commit', 'review r1', 'review r1', 'judge r1', 'fix r1', 'implement'])
    expect(listing(rows, 200).some(l => /Worktree|git worktree|bun test/.test(l))).toBe(false)
  })

  it('keeps the logs of a stage in its group, and the checks lines with its checks', () => {
    const { entries } = twoStages()
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf())
    const g = tree.groups[0]!
    expect(g.lines.some(l => l.endsWith(`${S1}: checks green (implement: test)`))).toBe(true)
    expect(g.lines.some(l => l.endsWith('▸ implement started'))).toBe(true)
    expect(g.lines.some(l => l.endsWith('■ judge r1 done 29s'))).toBe(true)
    expect(g.checks).toMatchObject({ state: 'passed', failed: [], lines: [expect.stringContaining('checks green')] })
    expect(g.checks!.after?.action).toBe('commit')
    expect(tree.groups[1]!.lines.some(l => l.includes('checks green'))).toBe(false)
  })

  it('lists the stages that have not started without a fold arrow, and knows an agent\'s round', () => {
    n = 0
    const impl = agent(3, `implement ${S1}`, 'implementer', 'Implement')
    const outline = outlineOf({ stages: [stageOutline(S1, 1), stageOutline(S2, 2), stageOutline('Docs', 3)] })
    const entries = [j(0, 'phase', { title: 'Worktree' }), j(2, 'stage', { number: 1, name: S1, event: 'start' }), j(2, 'phase', { title: 'Implement' }), impl.entry]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outline)
    const rows = visibleRows([tree], view({ focus: 1 }))
    expect(listing(rows, 60).slice(2, 4)).toEqual(['    2 Client pause UI and e2e', '    3 Docs'])
    expect(rows[2]!.folded).toBeUndefined()
    const review = agent(130, `review ${S1} r1 a`, 'reviewer', 'Review')
    const later = buildRunTree(RUN, [...entries, ended(100, impl), j(129, 'phase', { title: 'Review' }), review.entry], new Map(), NOW, new Map(), outline)
    expect(later.agents.at(-1)).toMatchObject({ action: 'review r1 a', round: 1 })
  })

  it('places the agents of parallel stages by their labels, not the phase they were journalled in', () => {
    n = 0
    const impl1 = agent(3, `implement ${S1}`, 'implementer', 'Implement')
    const review1 = agent(60, `review ${S1} r1 a`, 'reviewer', 'Review')
    const impl2 = agent(62, `implement ${S2}`, 'implementer', 'Implement')
    const entries = [
      j(2, 'stage', { number: 1, name: S1, event: 'start' }),
      j(2, 'stage', { number: 2, name: S2, event: 'start' }),
      j(2, 'phase', { title: 'Implement' }),
      impl1.entry,
      ended(50, impl1),
      j(59, 'phase', { title: 'Review' }),
      review1.entry,
      j(61, 'phase', { title: 'Implement' }),
      impl2.entry,
    ]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf())
    expect(tree.agents.map(a => [a.action, a.group])).toEqual([
      ['implement', 'stage:1'],
      ['review r1 a', 'stage:1'],
      ['implement', 'stage:2'],
    ])
    expect(tree.running).toEqual([1, 2])
    expect(focusStage(tree, `agent:${impl2.session}`)).toBe(2)
    expect(focusStage(tree, `agent:${review1.session}`)).toBe(1)
    expect(focusStage(tree, `group:${RUN.id}:stage:1`)).toBe(1)
    expect(focusStage(tree, `checks:${RUN.id}:2`)).toBe(2)
    expect(focusStage(tree)).toBe(2)
  })

  it('groups a planning run as Plan and Plan review, with the steps of a planning run', () => {
    n = 0
    const plan = agent(2, 'plan', 'planner', 'Plan')
    const review = agent(70, 'review plan review r1 a', 'reviewer', 'Plan review')
    const judge = agent(90, 'judge plan review r1', 'judge', 'Plan review')
    const fix = agent(100, 'fix plan review r1', 'implementer', 'Plan review')
    const entries = [j(0, 'phase', { title: 'Worktree' }), j(1, 'phase', { title: 'Plan' }), plan.entry, ended(60, plan), j(61, 'phase', { title: 'Plan review' }), review.entry, ended(80, review), judge.entry, ended(95, judge), fix.entry]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf({ kind: 'plan', planReview: true, finalReview: false, reviewers: ['a'], stages: [] }))
    expect(tree.groups.map(g => [g.title, g.state, g.agents.map(a => a.action)])).toEqual([
      ['Plan', 'done', ['plan']],
      ['Plan review', 'running', ['review r1', 'judge r1', 'fix r1']],
    ])
  })

  it('marks a stage that ended checks-failed, one not started and a stage of a cancelled run', () => {
    n = 0
    const impl = agent(3, `implement ${S1}`, 'implementer', 'Implement')
    const repair = agent(60, `repair ${S1} implement #1`, 'implementer', 'Implement')
    const entries = [
      j(0, 'phase', { title: 'Worktree' }),
      j(2, 'stage', { number: 1, name: S1, event: 'start' }),
      j(2, 'phase', { title: 'Implement' }),
      impl.entry,
      ended(50, impl),
      j(51, 'phase', { title: 'Checks' }),
      j(55, 'log', { message: `${S1}: check test failed (exit 1) - repair 1/1` }),
      j(55, 'log', { message: `${S1}: check lint failed (exit 2) - repair 1/1` }),
      repair.entry,
      ended(90, repair),
      j(91, 'phase', { title: 'Checks' }),
      j(95, 'log', { message: `${S1}: check test failed (exit 1) - repair 2/1` }),
      j(95, 'log', { message: `${S1}: checks-failed - test (exit 1)` }),
      j(96, 'stage', { number: 1, name: S1, event: 'end', outcome: 'checks-failed' }),
      j(96, 'log', { message: `${S2}: not started: 1 (${S1}) ended checks-failed and left its red commits` }),
      j(96, 'stage', { number: 2, name: S2, event: 'end', outcome: 'skipped' }),
    ]
    const tree = buildRunTree({ ...RUN, status: 'running' }, entries, new Map(), NOW, new Map(), outlineOf())
    const [one, two] = tree.groups
    expect([one!.state, one!.outcome, one!.checks?.state, one!.checks?.failed]).toEqual(['failed', 'checks-failed', 'failed', ['test']])
    expect(two!.state).toBe('skipped')
    const rows = visibleRows([tree], view({ opened: new Set([`group:${RUN.id}:stage:1`]) }))
    expect(listing(rows, 80).slice(0, 5)).toEqual([
      right(`▾ ✗ 1 ${S1} checks-failed`, '1m34s', 80),
      right('  ✓ implement', '47s', 80),
      right('  ✓ repair #1', '30s', 80),
      '  checks ✗ test',
      '▸ ⊘ 2 Client pause UI and e2e',
    ])
    expect(rowText(rows[0]!, NOW, 50)).toBe(right('▾ ✗ 1 Server pause domain, l… checks-failed', '1m34s', 50))

    const cancelled = buildRunTree({ ...RUN, status: 'cancelled', endedAt: BASE + 99 * S }, twoStages().entries, new Map(), NOW, new Map(), outlineOf())
    expect(cancelled.groups[1]!.state).toBe('cancelled')
    expect(rowText(visibleRows([cancelled], view())[1]!, NOW, 60)).toStartWith('▸ ⊘ 2 Client')
  })

  it('shows only the latest batch of failed checks, and checks running again once a repair starts', () => {
    n = 0
    const impl = agent(3, `implement ${S1}`, 'implementer', 'Implement')
    const repair = agent(60, `repair ${S1} implement #1`, 'implementer', 'Implement')
    const head = [
      j(2, 'stage', { number: 1, name: S1, event: 'start' }),
      j(2, 'phase', { title: 'Implement' }),
      impl.entry,
      ended(50, impl),
      j(51, 'phase', { title: 'Checks' }),
      j(55, 'log', { message: `${S1}: check test failed (exit 1) - repair 1/2` }),
      j(55, 'log', { message: `${S1}: check lint failed (exit 2) - repair 1/2` }),
      repair.entry,
    ]
    const checksOf = (entries: JournalEntry[]) => {
      const g = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf()).groups[0]!
      return [g.checks?.state, g.checks?.failed]
    }
    expect(checksOf(head)).toEqual(['running', []])
    expect(checksOf([...head, ended(90, repair), j(95, 'log', { message: `${S1}: check test failed (exit 1) - repair 2/2` })])).toEqual(['failed', ['test']])
  })

  it('reads a journal written before stages were journalled, with no outline and no cwd', () => {
    n = 0
    const impl1 = agent(3, 'implement one', 'implementer', 'Implement', { cwd: undefined })
    const review = agent(60, 'review one r1 codex', 'reviewer', 'Review', { cwd: undefined })
    const fix = agent(90, 'fix one r1', 'implementer', 'Implement', { cwd: undefined })
    const impl2 = agent(130, 'implement two', 'implementer', 'Implement', { cwd: undefined })
    const odd = agent(140, 'tidy things', 'granny', 'Review', { cwd: undefined })
    const entries = [j(0, 'phase', { title: 'Implement' }), impl1.entry, ended(50, impl1), j(59, 'phase', { title: 'Review' }), review.entry, ended(80, review), j(85, 'phase', { title: 'Implement' }), fix.entry, ended(120, fix), impl2.entry, j(139, 'phase', { title: 'Review' }), odd.entry]
    const tree = buildRunTree({ id: 'old', status: 'running', startedAt: BASE }, entries, new Map(), NOW)
    expect(tree.groups.map(g => [g.key, g.title, g.state, g.agents.map(a => a.action)])).toEqual([
      ['stage:1', 'one', 'done', ['implement', 'review r1 codex', 'fix r1']],
      ['stage:2', 'two', 'running', ['implement']],
      ['other:Review', 'Review', 'running', ['tidy things']],
    ])
    expect(tree.agents.every(a => a.cwd === undefined)).toBe(true)
    expect(listing(visibleRows([tree], { run: 'old', folded: new Set(), opened: new Set(), runs: 'one' }), 40).map(l => l.trimEnd().replace(/\s+\S+$/, ''))[0]).toBe('▸ ✓ 1 one')
  })

  it('keeps an agent\'s retries, provider errors, failure and failed link as its notes, and its linked flag', () => {
    n = 0
    const judge = agent(5, 'judge one r1', 'judge', 'Review', { linked: false })
    const entries = [
      j(0, 'stage', { number: 1, name: 'one', event: 'start' }),
      j(4, 'link-failed', { label: 'judge one r1', error: 'move failed\nstack' }),
      judge.entry,
      j(10, 'retry', { label: 'judge one r1', attempt: 1, reason: 'You stopped without calling granny_submit_judgement.\nmore' }),
      j(20, 'provider-error', { label: 'judge one r1', session: judge.session, error: { type: 'provider.rate-limit', message: '429 slow down' }, transient: true, backoffMs: 30000 }),
      j(60, 'agent-failed', { label: 'judge one r1', session: judge.session, error: 'gave up' }),
    ]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf({ stages: [stageOutline('one', 1)] }))
    const a = tree.agents[0]!
    expect(a.linked).toBe(false)
    expect(a.notes.map(x => [x.t - BASE, x.text])).toEqual([
      [4000, '! not linked to the parent session: move failed'],
      [10000, '↻ retry 1: You stopped without calling granny_submit_judgement.'],
      [20000, '! provider error (retry in 30s): 429 slow down'],
      [60000, '✗ failed: gave up'],
    ])
  })

  it('lists the runs at the bottom when there is more than one, the shown one marked', () => {
    const { entries } = twoStages()
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf())
    const other = buildRunTree({ id: '20261105-190000-q6ie', status: 'done', startedAt: BASE - 600 * S, endedAt: BASE - 60 * S }, [], new Map(), NOW)
    const rows = visibleRows([tree, other], view({ runs: 'list' }))
    expect(listing(rows, 60).slice(-3)).toEqual(['runs', right('● 7i5w · running (shown)', '6m40s'), right('✓ q6ie · done', '9m00s')])
    expect(rows.at(-3)!.selectable).toBe(false)
    expect(rows.slice(-2).map(r => r.key)).toEqual([`run:${RUN.id}`, 'run:20261105-190000-q6ie'])
  })

  it('folds a running group the user folded and opens a finished one the user opened, and drops the elapsed below 24 columns', () => {
    const { entries } = twoStages()
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf())
    const rows = visibleRows([tree], view({ folded: new Set([`group:${RUN.id}:stage:2`]) }))
    expect(rows.filter(r => r.kind === 'agent')).toHaveLength(0)
    expect(rowText(rows[1]!, NOW, 23)).toBe('▸ ● 2 Client pause UI …')
  })
})

describe('placeOf', () => {
  const stages = [
    { number: 1, name: 'core' },
    { number: 2, name: 'core api' },
    { number: 3, name: 'fix r2 bugs' },
  ]
  const cases: Array<[string, string | undefined, string | undefined, number?]> = [
    ['plan', 'plan', 'plan'],
    ['implement core', 'stage:1', 'implement'],
    ['implement core api', 'stage:2', 'implement'],
    ['commit core implement', 'stage:1', 'commit'],
    ['commit core fix r1 #2', 'stage:1', 'commit #2'],
    ['commit core api final', 'stage:2', 'commit'],
    ['repair core implement #1', 'stage:1', 'repair #1'],
    ['repair core fix r2 #3', 'stage:1', 'repair #3'],
    ['review core r1 codex', 'stage:1', 'review r1 codex'],
    ['review core r1 codex #2', 'stage:1', 'review r1 codex #2'],
    ['review core api r2 terra', 'stage:2', 'review r2 terra'],
    ['judge core r1', 'stage:1', 'judge r1'],
    ['judge core r1 retry', 'stage:1', 'judge r1 retry'],
    ['fix core r3', 'stage:1', 'fix r3'],
    ['extract core r1 codex', 'stage:1', 'extract r1 codex'],
    ['extract core r1 codex retry', 'stage:1', 'extract r1 codex retry'],
    ['resolve merge core api', 'stage:2', 'resolve merge'],
    ['implement fix r2 bugs', 'stage:3', 'implement'],
    ['review fix r2 bugs r1 codex', 'stage:3', 'review r1 codex'],
    ['fix fix r2 bugs r2', 'stage:3', 'fix r2'],
    ['review plan review r1 codex', 'plan-review', 'review r1 codex'],
    ['judge plan review r2 retry', 'plan-review', 'judge r2 retry'],
    ['fix plan review r1', 'plan-review', 'fix r1'],
    ['extract plan review r1 codex', 'plan-review', 'extract r1 codex'],
    ['review final review r1 codex', 'final-review', 'review r1 codex'],
    ['review final review web r1 codex', 'final-review', 'review r1 codex'],
    ['judge final review web r1', 'final-review', 'judge r1'],
    ['fix final review r2', 'final-review', 'fix r2'],
    ['pr-ready check', 'pr-ready', 'pr-ready check'],
    ['pr-ready check web', 'pr-ready', 'pr-ready check web'],
    ['review core r1 codex', 'stage:1', 'review r1', 1],
    ['tidy things', undefined, undefined],
    ['implement nothing known', undefined, undefined],
  ]
  for (const [label, group, action, reviewers] of cases) {
    it(`places "${label}"`, () => {
      const placed = placeOf(label, stages, reviewers)
      expect(placed ? [placed.group, placed.action] : undefined).toEqual(group === undefined ? undefined : [group, action ?? ""])
    })
  }

  it('puts an agent of two stages with one name in the lowest that has not ended', () => {
    const twins = [
      { number: 1, name: 'core' },
      { number: 2, name: 'core' },
    ]
    expect(placeOf('implement core', twins)?.group).toBe('stage:1')
    expect(placeOf('implement core', twins, undefined, numbers => numbers.find(x => x !== 1)!)?.group).toBe('stage:2')
  })
})

describe('the lines of a work group', () => {
  it('keeps them in time order, a multi-line log with its continuation lines', () => {
    n = 0
    const impl = agent(3, 'implement one', 'implementer', 'Implement')
    const entries = [j(0, 'stage', { number: 1, name: 'one', event: 'start' }), impl.entry, j(5, 'log', { message: 'one: first\nsecond' }), ended(9, impl)]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf({ stages: [stageOutline('one', 1)] }))
    expect(tree.groups[0]!.lines.map(l => l.slice(10))).toEqual(['▸ implement started', 'one: first', 'second', '■ implement done 6s'])
  })
})

describe('a long journal', () => {
  it('keeps the newest 200 lines of a group and the newest 50 check lines of a stage', () => {
    const entries = [j(0, 'stage', { number: 1, name: 'one', event: 'start' }), ...Array.from({ length: 300 }, (_, i) => j(1 + i, 'log', { message: `one: check test failed (exit ${i}) - repair` }))]
    const tree = buildRunTree(RUN, entries, new Map(), NOW, new Map(), outlineOf({ stages: [stageOutline('one', 1)] }))
    const g = tree.groups[0]!
    expect(g.lines).toHaveLength(200)
    expect(g.lines.at(-1)).toEndWith('one: check test failed (exit 299) - repair')
    expect(g.checks!.lines).toHaveLength(50)
    expect(g.checks!.lines[0]).toEndWith('(exit 250) - repair')
  })
})

describe('a judge run', () => {
  const outline = judgeOutline('feat/pause', resolveConfig([{ reviewers: [{ name: 'a', engine: 'agent' }, { name: 'b', engine: 'agent' }] }]))
  const running = { ...RUN, status: 'running' }

  function reviewed() {
    n = 0
    const ra = agent(1, 'review feat/pause r1 a', 'reviewer', 'Review')
    const rb = agent(1, 'review feat/pause r1 b', 'reviewer', 'Review')
    const extract = agent(20, 'extract feat/pause r1 b', 'granny', 'Review')
    const tag = agent(40, 'tag feat/pause', 'judge', 'Judge')
    return { ra, rb, extract, tag }
  }

  it('has no stages, no worktree and the reviewers of the config', () => {
    expect(outline).toEqual({ kind: 'judge', branch: 'feat/pause', worktree: false, planReview: false, finalReview: false, reviewers: ['a', 'b'], fromStage: 1, stages: [] })
  })

  it('shows the steps review, tag and report before anything ran, with the groups upcoming', () => {
    const tree = buildRunTree(running, [], new Map(), NOW, new Map(), outline)
    expect(tree.groups.map(g => [g.title, g.state])).toEqual([['Review', 'upcoming'], ['Tag', 'upcoming'], ['Report', 'upcoming']])
  })

  it('moves through the steps, with the agents under their group by their short action', () => {
    const { ra, rb, extract, tag } = reviewed()
    const review = [j(0, 'phase', { title: 'Review' }), ra.entry, rb.entry, ended(10, ra), ended(20, rb), extract.entry]
    const atReview = buildRunTree(running, review, new Map([[extract.session, { active: true }]]), NOW, new Map(), outline)
    expect(atReview.groups[0]).toMatchObject({ key: 'review', state: 'running' })
    expect(atReview.groups[0]!.agents.map(a => a.action)).toEqual(['review r1 a', 'review r1 b', 'extract r1 b'])

    const judging = [...review, ended(30, extract), j(39, 'phase', { title: 'Judge' }), tag.entry]
    const atTag = buildRunTree(running, judging, new Map([[tag.session, { active: true }]]), NOW, new Map(), outline)
    expect(atTag.groups.map(g => [g.title, g.state, g.agents.map(a => a.action)])).toEqual([
      ['Review', 'done', ['review r1 a', 'review r1 b', 'extract r1 b']],
      ['Tag', 'running', ['tag']],
      ['Report', 'upcoming', []],
    ])

    const done = [...judging, ended(50, tag), j(51, 'phase', { title: 'Report' }), j(52, 'command', { command: 'mkdir -p .granny/reviews' }), j(53, 'log', { message: 'report written: /r/.granny/reviews/x.md' })]
    const atReport = buildRunTree(running, done, new Map(), NOW, new Map(), outline)
    expect(atReport.groups[2]).toMatchObject({ key: 'report', state: 'running' })
    expect(atReport.groups[2]!.lines.at(-1)).toEndWith('report written: /r/.granny/reviews/x.md')

    const finished = buildRunTree({ ...RUN, status: 'done', endedAt: BASE + 60 * S }, done, new Map(), NOW, new Map(), outline)
    expect(finished.groups.map(g => g.state)).toEqual(['done', 'done', 'done'])
  })

  it('names a retried reviewer and a retried tagging', () => {
    n = 0
    const again = agent(1, 'review feat/pause r1 a #2', 'reviewer', 'Review')
    const tag = agent(2, 'tag feat/pause retry', 'judge', 'Judge')
    const tree = buildRunTree(running, [j(0, 'phase', { title: 'Review' }), again.entry, j(2, 'phase', { title: 'Judge' }), tag.entry], new Map(), NOW, new Map(), outline)
    expect(tree.groups.map(g => g.agents.map(a => a.action))).toEqual([['review r1 a #2'], ['tag retry'], []])
  })

  it('skips the tagging of a review without findings, and everything after a review with no changes or no reviewer', () => {
    n = 0
    const ra = agent(1, 'review feat/pause r1 a', 'reviewer', 'Review')
    const clean = [j(0, 'phase', { title: 'Review' }), ra.entry, ended(5, ra), j(6, 'phase', { title: 'Report' })]
    const noFindings = buildRunTree({ ...RUN, status: 'done', endedAt: BASE + 7 * S }, clean, new Map(), NOW, new Map(), outline)
    expect(noFindings.groups.map(g => g.state)).toEqual(['done', 'skipped', 'done'])

    const stopped = buildRunTree({ ...RUN, status: 'done', endedAt: BASE + 7 * S }, [j(0, 'phase', { title: 'Review' })], new Map(), NOW, new Map(), outline)
    expect(stopped.groups.map(g => g.state)).toEqual(['done', 'skipped', 'skipped'])
  })

  it('marks where a cancelled or failed run stopped', () => {
    const { ra, tag } = reviewed()
    const entries = [j(0, 'phase', { title: 'Review' }), ra.entry, ended(5, ra), j(6, 'phase', { title: 'Judge' }), tag.entry]
    const cancelled = buildRunTree({ ...RUN, status: 'cancelled', endedAt: BASE + 7 * S }, entries, new Map(), NOW, new Map(), outline)
    expect(cancelled.groups.map(g => g.state)).toEqual(['done', 'cancelled', 'skipped'])
    const failed = buildRunTree({ ...RUN, status: 'failed', endedAt: BASE + 7 * S }, entries, new Map(), NOW, new Map(), outline)
    expect(failed.groups.map(g => g.state)).toEqual(['done', 'failed', 'skipped'])
  })

  it('leaves the review and report phases of a normal run alone', () => {
    const tree = buildRunTree(running, [j(0, 'phase', { title: 'Review' })], new Map(), NOW, new Map(), outlineOf())
    expect(tree.groups.map(g => g.key)).toEqual(['stage:1', 'stage:2', 'final-review', 'pr-ready'])
  })
})
