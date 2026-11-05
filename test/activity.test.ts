import { describe, expect, it } from 'bun:test'
import { activityLines, argOf, ARG_KEYS, type NowState, nowLine, summarise } from '../src/adapters/runview/activity'
import { clock } from '../src/adapters/runview/format'
import { at, end, S, SCREEN, state, tool, WT } from './activity-fixture'

describe('summarise', () => {
  const now = at(157)
  const s = summarise(SCREEN, now, { cwd: WT })

  it('puts the running tool, its intent and the latest heading in NOW, and no state change anywhere else', () => {
    expect(s.now).toEqual({ text: '● bash · 7s', tone: 'info', detail: 'Checking integrated build and full behavioral suite', heading: 'Comparing recovery source against clean foundation' })
  })

  it('lists one row per tool or burst, newest first, with relative paths and the task and failure markers', () => {
    expect(s.recent.map(r => [clock(r.t), r.tool, r.text, r.tone])).toEqual([
      [clock(at(137)), 'read', 'tests/auth/cookie-security.test.ts  (2×)', 'base'],
      [clock(at(61)), 'bash', 'Running recovered auth suite for actual failures ✗', 'error'],
      [clock(at(53)), 'read', '7 files · tests/auth/auth-http.test.ts, tests/auth/session-store.test.ts, tests/auth/cookie-security.test.ts, tests/auth/csrf.test.ts, tests/auth/oauth.test.ts, tests/auth/tokens.test.ts, tests/auth/roles.test.ts', 'base'],
      [clock(at(52)), 'bash', 'Installing recovered locked auth dependencies', 'base'],
      [clock(at(48)), 'bash', 'Carrying interrupted auth work into recovery branch', 'base'],
      [clock(at(10)), 'task', 'AuthRecoveryAudit ✓', 'base'],
      [clock(at(8)), 'read', '5 skill refs · auth.md, database-and-caching.md, testing.md, sessions.md, cookies.md', 'base'],
    ])
  })

  it('keeps the latest todo list and what the agent said last', () => {
    expect(s.todo).toEqual([
      { text: 'Tracking complete auth recovery stage', state: 'done' },
      { text: 'Advancing to durable session completion', state: 'active' },
      { text: 'Final checks', state: 'pending' },
    ])
    expect(s.lastSaid).toBe('Stage 1 foundation is green; resuming the auth cutover from the recovery branch where the interrupted run stopped. Next I check the build.')
  })

  it('updates NOW without adding rows when only the state changes', () => {
    const more = summarise([...SCREEN, end(160, 'bash', { id: 'b4' }), state(161, 'thinking')], at(170), { cwd: WT })
    expect(more.now).toEqual({ text: '● thinking 9s', tone: 'info', heading: 'Comparing recovery source against clean foundation' })
    expect(more.recent).toHaveLength(s.recent.length + 1)
    const churn = summarise([...SCREEN, end(160, 'bash', { id: 'b4' }), state(161, 'thinking'), state(162, 'waiting for model'), state(163, 'writing')], at(170), { cwd: WT })
    expect(churn.recent).toEqual(more.recent)
    expect(churn.now?.text).toBe('● writing 7s')
  })

  it('takes the live state over the stream when the host knows it', () => {
    const live: NowState = { state: 'waiting', since: at(150) }
    expect(summarise(SCREEN, now, { cwd: WT, live }).now).toEqual({ text: '… waiting for model 7s', tone: 'muted', heading: 'Comparing recovery source against clean foundation' })
  })

  it('shows the outcome of a finished agent on the NOW line', () => {
    expect(summarise(SCREEN, now, { end: { state: 'done', start: at(0) - 15 * 60 * S, end: at(180) } }).now).toEqual({ text: '✓ done in 18m00s', tone: 'success' })
    expect(summarise(SCREEN, now, { end: { state: 'failed', start: at(0), end: at(60), error: 'boom\nstack' } }).now).toEqual({ text: '✗ failed after 1m00s: boom', tone: 'error' })
    expect(summarise(SCREEN, now, { end: { state: 'cancelled', start: at(0), end: at(60) } }).now).toEqual({ text: '⊘ cancelled after 1m00s', tone: 'warning' })
  })

  it('keeps a shell command without an intent to its first 40 characters, without the cd', () => {
    const r = summarise([tool(0, 'bash', { arg: `cd ${WT} && bun test tests/auth/a-very-long-file-name.test.ts --timeout 9000` }), end(1, 'bash')], at(1), { cwd: WT })
    expect(r.recent[0]!.text).toBe('bun test tests/auth/a-very-long-file-na…')
  })

  it('shows a journal note and a failed tool with its error, and names the subagents of a running task', () => {
    const r = summarise(
      [
        tool(0, 'task', { id: 't' }),
        { t: at(0), kind: 'subagents', names: ['A', 'B'] },
        tool(5, 'edit', { id: 'e', arg: `${WT}/src/a.ts` }),
        { t: at(6), kind: 'error', name: 'edit', text: 'old string not found\nmore' },
        { t: at(7), kind: 'note', text: '↻ retry 1: You stopped without calling granny_submit' },
      ],
      at(8),
      { cwd: WT },
    )
    expect(r.recent.map(x => [x.tool, x.text, x.tone])).toEqual([
      ['', '↻ retry 1: You stopped without calling granny_submit', 'warning'],
      ['edit', 'src/a.ts ✗ old string not found', 'error'],
      ['task', 'A, B …', 'base'],
    ])
  })

  it('does not merge calls of one tool more than a few seconds apart or with another tool between', () => {
    const r = summarise([tool(0, 'read', { arg: '/a.ts' }), tool(10, 'read', { arg: '/b.ts' }), tool(11, 'grep', { arg: 'x' }), tool(12, 'read', { arg: '/c.ts' }), end(12, 'read')], at(13))
    expect(r.recent.map(x => x.text)).toEqual(['/c.ts', 'x', '/b.ts', '/a.ts'])
  })

  it('keeps at most the newest max rows', () => {
    const many = Array.from({ length: 50 }, (_, i) => [tool(i * 10, i % 2 ? 'read' : 'grep', { arg: `f${i}` }), end(i * 10 + 1, i % 2 ? 'read' : 'grep')]).flat()
    const r = summarise(many, at(600), { max: 20 })
    expect(r.recent).toHaveLength(20)
    expect(r.recent[0]!.text).toBe('f49')
  })

  it('shows the running tool only in NOW, and in RECENT once it ended', () => {
    const running = summarise([tool(0, 'read', { arg: '/a.ts' }), end(1, 'read'), tool(2, 'bash', { intent: 'Testing' })], at(3))
    expect(running.recent.map(r => r.text)).toEqual(['/a.ts'])
    expect(running.now).toEqual({ text: '● bash · 1s', tone: 'info', detail: 'Testing' })
    const ended = summarise([tool(0, 'read', { arg: '/a.ts' }), end(1, 'read'), tool(2, 'bash', { intent: 'Testing' })], at(3), { end: { state: 'failed', start: at(0) } })
    expect(ended.recent.map(r => r.text)).toEqual(['Testing', '/a.ts'])
  })

  it('keeps the finished calls of a burst in RECENT while its last call still runs', () => {
    const reads = [1, 2, 3, 4, 5, 6].flatMap(i => [tool(i, 'read', { id: `r${i}`, arg: `/f${i}.ts` }), end(i, 'read', { id: `r${i}` })])
    const r = summarise([...reads, tool(7, 'read', { id: 'r7', arg: '/f7.ts' })], at(8))
    expect(r.recent.map(x => [clock(x.t), x.text])).toEqual([[clock(at(6)), '6 files · /f1.ts, /f2.ts, /f3.ts, /f4.ts, /f5.ts, /f6.ts']])
    expect(r.now).toEqual({ text: '● read · 1s', tone: 'info', detail: '/f7.ts' })
    const same = summarise([tool(1, 'read', { arg: '/a.ts' }), end(1, 'read'), tool(2, 'read', { arg: '/a.ts' }), end(2, 'read'), tool(3, 'read', { arg: '/a.ts' })], at(4))
    expect(same.recent.map(x => x.text)).toEqual(['/a.ts  (2×)'])
  })

  it('has nothing to say about an empty stream', () => {
    expect(summarise([], at(0))).toEqual({ recent: [] })
  })
})

describe('nowLine', () => {
  const at0 = at(0)
  it('says what the agent does and for how long', () => {
    expect(nowLine({ state: 'thinking', since: at0 - 42 * S, heading: 'Reading the plan' }, at0)).toBe('● thinking 42s · "Reading the plan"')
    expect(nowLine({ state: 'writing', since: at0 - 5 * S }, at0)).toBe('● writing 5s')
    expect(nowLine({ state: 'running', tool: 'bash', arg: `cd ${WT} && bun test test/GameService.test.ts`, since: at0 - 12 * S }, at0, WT)).toBe('● running bash: bun test test/GameService.test.ts 12s')
    expect(nowLine({ state: 'running', tool: 'bash', intent: 'Running the tests', since: at0 - 12 * S }, at0)).toBe('● running bash: Running the tests 12s')
    expect(nowLine({ state: 'waiting', since: at0 - 3 * S }, at0)).toBe('… waiting for model 3s')
    expect(nowLine({ state: 'starting', since: at0 }, at0)).toBe('… starting 0s')
    expect(nowLine({ state: 'preparing', since: at0 - S }, at0)).toBe('● preparing a tool call 1s')
  })
})

describe('activityLines', () => {
  it('lists every event in order, for the verbose view', () => {
    const lines = activityLines(
      [
        state(0, 'thinking'),
        { t: at(1), kind: 'heading', text: 'Reading the plan' },
        tool(2, 'read', { arg: `${WT}/src/a.ts` }),
        tool(3, 'bash', { intent: 'Running tests', arg: `cd ${WT} && bun test` }),
        end(4, 'bash', { failed: true }),
        { t: at(5), kind: 'error', name: 'edit', text: 'no match\nmore' },
        { t: at(6), kind: 'subagents', names: ['A', 'B'] },
        { t: at(7), kind: 'text', text: '\n\x1b[1mDone\x1b[0m with it.\nsecond line' },
        { t: at(7), kind: 'text', text: 'Done with it.' },
        { t: at(8), kind: 'todo', todos: [{ text: 'a', state: 'done' }, { text: 'b', state: 'active' }] },
        { t: at(9), kind: 'note', text: '! provider error: 429' },
        { t: at(10), kind: 'exit', code: 0 },
      ],
      WT,
    )
    expect(lines).toEqual([
      `${clock(at(0))}  · thinking`,
      `${clock(at(1))}  » Reading the plan`,
      `${clock(at(2))}  ▸ read   src/a.ts`,
      `${clock(at(3))}  ▸ bash   Running tests · bun test`,
      `${clock(at(4))}  ✗ bash failed`,
      `${clock(at(5))}  ✗ edit failed: no match`,
      `${clock(at(6))}  └ task: A, B`,
      `${clock(at(7))}  ✎ "Done with it."`,
      `${clock(at(8))}  ▸ todo   ✓ a  ● b`,
      `${clock(at(9))}  ! provider error: 429`,
      `${clock(at(10))}  ■ process exited 0`,
    ])
  })

  it('cuts a said text at 120 characters', () => {
    const [line] = activityLines([{ t: at(0), kind: 'text', text: 'x'.repeat(200) }])
    expect(line).toBe(`${clock(at(0))}  ✎ "${'x'.repeat(119)}…"`)
  })
})

describe('argOf', () => {
  it('takes the first argument a person would recognise a call by', () => {
    expect(ARG_KEYS).toEqual(['path', 'file_path', 'file', 'pattern', 'command', 'query', 'url', 'description', 'op'])
    expect(argOf({ command: 'bun  test\n x', path: '' })).toBe('bun test x')
    expect(argOf({ file_path: '/a.ts', pattern: 'x' })).toBe('/a.ts')
    expect(argOf({ other: 1 })).toBeUndefined()
    expect(argOf('nope')).toBeUndefined()
  })
})
