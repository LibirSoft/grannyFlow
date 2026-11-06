import { describe, expect, it } from 'bun:test'
import { summarise } from '../src/adapters/runview/activity'
import { clock } from '../src/adapters/runview/format'
import { agentEnd, agentHead, checksDetail, groupDetail, runDetail, summaryCells } from '../src/adapters/runview/layout'
import type { RunOutline } from '../src/adapters/runview/outline'
import { buildRunTree, type JournalEntry } from '../src/adapters/runview/tree'
import { at, SCREEN, WT } from './activity-fixture'

const BASE = Date.parse('2026-11-05T20:30:25.000Z')
const S = 1000
const j = (sec: number, type: string, data: Record<string, unknown> = {}): JournalEntry => ({ t: new Date(BASE + sec * S).toISOString(), type, ...data })
const S1 = 'Server pause domain, lifecycle, and real-socket proof'
const S2 = 'Client pause UI and e2e'
const stage = (number: number, name: string) => ({ number, name, implement: true, review: true, checks: true })
const outline = (over: Partial<RunOutline> = {}): RunOutline => ({ kind: 'implement', branch: 'feat/pause', worktree: true, planReview: false, finalReview: true, reviewers: ['a'], fromStage: 1, stages: [stage(1, S1), stage(2, S2)], ...over })
const kimi = { providerID: 'kimi-code-plan-global', id: 'k3.1-pro', variant: 'default' }
const implement = (sec: number, name: string, session: string) => j(sec, 'agent', { label: `implement ${name}`, role: 'implementer', phase: 'Implement', session, model: kimi, cwd: WT })
const RUN = { id: '20261105-203025-7i5w', status: 'running', startedAt: BASE, branch: 'feat/pause' }
const NOW = BASE + 100 * S
const live = (...sessions: string[]) => new Map(sessions.map(s => [s, { active: true }]))

const firstStage = () => buildRunTree(RUN, [j(0, 'phase', { title: 'Worktree' }), j(0, 'stage', { number: 1, name: S1, event: 'start' }), j(0, 'phase', { title: 'Implement' }), implement(0, S1, 'ses_impl')], live('ses_impl'), NOW, new Map(), outline())

describe('agentHead', () => {
  const tree = firstStage()
  const agent = tree.agents[0]!

  it('names the role, the short model and the time, and no session id', () => {
    const head = agentHead(agent, NOW)
    expect(head).toEqual([{ text: 'implementer · k3.1-pro · 1m40s', tone: 'base' }])
    expect(JSON.stringify(head)).not.toContain('ses_')
  })

  it('shows how a finished agent ended, a failure and a session not linked to its parent', () => {
    expect(agentHead({ ...agent, state: 'done', end: BASE + 70 * S, model: 'openai-codex/gpt-6.1-sol', effort: 'xhigh', role: 'reviewer' }, NOW)[0]!.text).toBe('reviewer · gpt-6.1-sol/xhigh · ✓ 1m10s')
    expect(agentHead({ ...agent, state: 'failed', end: BASE + 10 * S, error: 'no answer\nstack' }, NOW)).toEqual([
      { text: 'implementer · k3.1-pro · ✗ 10s', tone: 'base' },
      { text: '! no answer', tone: 'error' },
    ])
    expect(agentHead({ ...agent, linked: false }, NOW)[1]).toEqual({ text: '! not linked to the parent session - it is in the session list', tone: 'warning' })
    expect(agentHead(agent, NOW, { linked: false })).toHaveLength(2)
    expect(agentEnd(agent)).toBeUndefined()
    expect(agentEnd({ ...agent, state: 'failed', end: BASE + 10 * S, error: 'x' })).toEqual({ state: 'failed', start: BASE, end: BASE + 10 * S, error: 'x' })
  })
})

describe('summaryCells', () => {
  const summary = summarise(SCREEN, at(157), { cwd: WT })
  const t = (s: number) => clock(at(s))

  it('draws the screen the user saw as NOW, TODO, RECENT and LAST SAID at 100 columns', () => {
    expect(summaryCells(summary, 100).map(c => c.text)).toEqual([
      'NOW   ● bash · 7s',
      '      Checking integrated build and full behavioral suite',
      '      » Comparing recovery source against clean foundation',
      '',
      'TODO  ✓ Tracking complete auth recovery stage  ● Advancing to durable session completion  · Final c…',
      '',
      'RECENT',
      ` ${t(137)}  read   tests/auth/cookie-security.test.ts  (2×)`,
      ` ${t(61)}  bash   Running recovered auth suite for actual failures ✗`,
      ` ${t(53)}  read   7 files · tests/auth/auth-http.test.ts, tests/auth/session-store.test.ts, tests/a…`,
      ` ${t(52)}  bash   Installing recovered locked auth dependencies`,
      ` ${t(48)}  bash   Carrying interrupted auth work into recovery branch`,
      ` ${t(10)}  task   AuthRecoveryAudit ✓`,
      ` ${t(8)}  read   5 skill refs · auth.md, database-and-caching.md, testing.md, sessions.md, cookies…`,
      '',
      'LAST SAID  "Stage 1 foundation is green; resuming the auth cutover from the recovery branch where',
      '           the interrupted run stopped. Next I check the build."',
    ])
  })

  it('cuts every row to 60 and 160 columns, never wrapping one', () => {
    const narrow = summaryCells(summary, 60).map(c => c.text)
    expect(narrow[4]).toBe('TODO  ✓ Tracking complete auth recovery stage  ● Advancing …')
    expect(narrow[8]).toBe(` ${t(61)}  bash   Running recovered auth suite for actual f…`)
    expect(narrow.slice(-2)).toEqual(['LAST SAID  "Stage 1 foundation is green; resuming the auth', '           cutover from the recovery branch where the inte…"'])
    const wide = summaryCells(summary, 160).map(c => c.text)
    expect(wide.at(-1)).toBe('LAST SAID  "Stage 1 foundation is green; resuming the auth cutover from the recovery branch where the interrupted run stopped. Next I check the build."')
    for (const width of [60, 100, 160]) for (const c of summaryCells(summary, width)) expect(c.text.length).toBeLessThanOrEqual(width)
    expect(summaryCells(summary, 100).map(c => c.tone).slice(0, 3)).toEqual(['info', 'base', 'muted'])
    expect(summaryCells(summary, 100)[8]!.tone).toBe('error')
  })

  it('keeps NOW and LAST SAID on screen when RECENT does not fit', () => {
    const rows = summaryCells(summary, 100, 12).map(c => c.text)
    expect(rows).toHaveLength(12)
    expect(rows.slice(0, 3)[0]).toBe('NOW   ● bash · 7s')
    expect(rows.slice(6, 9)).toEqual(['RECENT', ` ${t(137)}  read   tests/auth/cookie-security.test.ts  (2×)`, ` ${t(61)}  bash   Running recovered auth suite for actual failures ✗`])
    expect(rows.at(-2)).toStartWith('LAST SAID  "Stage 1')
  })

  it('shows the outcome of a finished agent on the NOW line', () => {
    const done = summarise(SCREEN, at(157), { cwd: WT, end: { state: 'done', start: at(0) - 18 * 60 * S + 157 * S, end: at(157) } })
    expect(summaryCells(done, 100)[0]).toEqual({ text: 'NOW   ✓ done in 18m00s', tone: 'success' })
  })
})

describe('group, checks and run details', () => {
  const tree = buildRunTree(
    { ...RUN, status: 'failed', endedAt: BASE + 96 * S },
    [
      j(0, 'stage', { number: 1, name: S1, event: 'start' }),
      j(0, 'phase', { title: 'Implement' }),
      implement(0, S1, 'ses_impl'),
      j(40, 'agent-end', { label: `implement ${S1}`, session: 'ses_impl', outcome: 'done' }),
      j(41, 'phase', { title: 'Checks' }),
      j(55, 'log', { message: `${S1}: check test failed (exit 1) - repair 1/0` }),
      j(56, 'log', { message: `${S1}: checks-failed - test (exit 1)` }),
      j(56, 'stage', { number: 1, name: S1, event: 'end', outcome: 'checks-failed' }),
    ],
    new Map(),
    NOW,
    new Map(),
    outline(),
  )
  const group = tree.groups[0]!

  it('wraps the full stage name and gives state, time, outcome, checks and the journal lines', () => {
    const cells = groupDetail(tree, group, NOW, 40)
    expect(cells.slice(0, 4).map(c => c.text)).toEqual(['stage 1/2 · Server pause domain,', 'lifecycle, and real-socket proof', 'failed · 56s · checks-failed', 'checks ✗ test'])
    expect(cells.slice(5).map(c => c.text.slice(10))).toEqual(['▸ implement started', '■ implement done 40s', `${S1}: check test failed (exit 1) - repair 1/0`, `${S1}: checks-failed - test (exit 1)`])
  })

  it('lists the check lines of a stage', () => {
    expect(checksDetail(group).map(c => c.text.replace(/^\d\d:\d\d:\d\d {2}/, ''))).toEqual([`checks · stage 1 · ${S1}`, 'checks ✗ test', `${S1}: check test failed (exit 1) - repair 1/0`, `${S1}: checks-failed - test (exit 1)`])
  })

  it('names the run id only in the run detail', () => {
    const cells = runDetail(tree, { repo: '/w/repo', dir: '/w/repo/.granny/runs/x/', error: 'boom\nstack', reply: '[granny] Run x failed: boom' })
    expect(cells.map(c => c.text)).toEqual([
      `run ${RUN.id}`,
      'status   failed',
      'repo     /w/repo',
      'branch   feat/pause',
      expect.stringMatching(/^started {2}\d{4}-\d\d-\d\d /),
      expect.stringMatching(/^ended {4}\d{4}-\d\d-\d\d /),
      'result   /w/repo/.granny/runs/x/result.json',
      'error: boom',
      '',
      '[granny] Run x failed: boom',
    ])
  })
})
