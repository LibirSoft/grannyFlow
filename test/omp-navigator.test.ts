import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TailReader } from '../src/adapters/omp/tail'
import { LineBuffer, sessionEntryLines } from '../src/adapters/omp/transcript'
import { RoleActivity } from '../src/adapters/omp/panel'
import { buildRunTree, groupOf, type JournalEntry, nextAgent, rowText, subagentFiles, visibleRows } from '../src/adapters/omp/tree'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'granny-nav-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('TailReader', () => {
  it('returns appended lines once each, in order', () => {
    const path = join(tmp, 'a.jsonl')
    writeFileSync(path, 'one\ntwo\n')
    const r = new TailReader(path)
    expect(r.poll()).toEqual({ lines: ['one', 'two'], reset: false, skippedBytes: 0 })
    expect(r.poll().lines).toEqual([])
    appendFileSync(path, 'three\n')
    appendFileSync(path, 'four\nfive\n')
    expect(r.poll().lines).toEqual(['three', 'four', 'five'])
    expect(r.poll().lines).toEqual([])
    expect(r.offset).toBe(Buffer.byteLength('one\ntwo\nthree\nfour\nfive\n'))
  })

  it('reads only the new bytes after a large file grows', () => {
    const path = join(tmp, 'big.jsonl')
    writeFileSync(path, `${'x'.repeat(1023)}\n`.repeat(1024))
    const r = new TailReader(path)
    expect(r.poll().lines).toHaveLength(1024)
    const before = r.bytesRead
    expect(before).toBe(1024 * 1024)
    appendFileSync(path, `${'y'.repeat(99)}\n`)
    expect(r.poll().lines).toEqual(['y'.repeat(99)])
    expect(r.bytesRead - before).toBeLessThanOrEqual(100)
  })

  it('returns a partial line only after its newline arrives', () => {
    const path = join(tmp, 'p.jsonl')
    writeFileSync(path, 'done\nhal')
    const r = new TailReader(path)
    expect(r.poll().lines).toEqual(['done'])
    appendFileSync(path, 'f a ')
    expect(r.poll().lines).toEqual([])
    appendFileSync(path, 'line\nnext')
    expect(r.poll().lines).toEqual(['half a line'])
  })

  it('decodes a multi-byte character split across two appends', () => {
    const path = join(tmp, 'u.jsonl')
    const bytes = Buffer.from('ab ✎ ğ 😀 cd\n')
    const cut = bytes.indexOf(Buffer.from('😀')) + 2
    writeFileSync(path, bytes.subarray(0, cut))
    const r = new TailReader(path)
    expect(r.poll().lines).toEqual([])
    appendFileSync(path, bytes.subarray(cut))
    expect(r.poll().lines).toEqual(['ab ✎ ğ 😀 cd'])
  })

  it('starts over with reset when the file is truncated or replaced', () => {
    const path = join(tmp, 't.jsonl')
    writeFileSync(path, 'old one\nold two\n')
    const r = new TailReader(path)
    expect(r.poll().lines).toEqual(['old one', 'old two'])
    truncateSync(path, 0)
    appendFileSync(path, 'new\n')
    expect(r.poll()).toEqual({ lines: ['new'], reset: true, skippedBytes: 0 })
    writeFileSync(`${path}.new`, 'replaced a\nreplaced b\nreplaced c\n')
    renameSync(`${path}.new`, path)
    expect(r.poll()).toEqual({ lines: ['replaced a', 'replaced b', 'replaced c'], reset: true, skippedBytes: 0 })
  })

  it('reads a file larger than the first window from its last window, skipping the cut line', () => {
    const path = join(tmp, 'huge.jsonl')
    const line = (i: number) => `${String(i).padStart(8, '0')}${'z'.repeat(1015)}`
    writeFileSync(path, Array.from({ length: 10 * 1024 }, (_, i) => `${line(i)}\n`).join(''))
    const r = new TailReader(path, { firstWindowBytes: 1024 * 1024 + 10, maxReadBytes: 4 * 1024 * 1024 })
    const first = r.poll()
    expect(first.skippedBytes).toBe(9 * 1024 * 1024)
    expect(first.lines).toHaveLength(1024)
    expect(first.lines[0]).toBe(line(9 * 1024))
    expect(first.lines.at(-1)).toBe(line(10 * 1024 - 1))
    expect(r.bytesRead).toBeLessThanOrEqual(1024 * 1024 + 10)
  })

  it('reads at most maxReadBytes per poll and the rest on the next polls', () => {
    const path = join(tmp, 'm.jsonl')
    writeFileSync(path, `${'a'.repeat(99)}\n`.repeat(30))
    const r = new TailReader(path, { maxReadBytes: 1000 })
    const counts: number[] = []
    for (let i = 0; i < 4; i++) counts.push(r.poll().lines.length)
    expect(counts).toEqual([10, 10, 10, 0])
    expect(r.bytesRead).toBe(3000)
  })

  it('reads nothing for a missing file and picks it up once it exists', () => {
    const path = join(tmp, 'later.jsonl')
    const r = new TailReader(path)
    expect(r.poll()).toEqual({ lines: [], reset: false, skippedBytes: 0 })
    writeFileSync(path, 'here\n')
    expect(r.poll().lines).toEqual(['here'])
  })

  it('never throws when the path is a directory', () => {
    const path = join(tmp, 'dir')
    mkdirSync(path)
    const r = new TailReader(path)
    expect(() => r.poll()).not.toThrow()
    expect(r.poll().lines).toEqual([])
  })
})

const T = '2026-11-05T17:37:50.000Z'
const AT = new Date(T).toTimeString().slice(0, 8)
const PAD = ' '.repeat(10)
const entry = (value: unknown) => JSON.stringify(value)
const message = (msg: Record<string, unknown>) => entry({ type: 'message', id: 'm1', timestamp: T, message: msg })
const numbered = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n')

describe('sessionEntryLines', () => {
  it('renders the session header, model and thinking level changes', () => {
    expect(sessionEntryLines(entry({ type: 'session', version: 3, id: 'abc', timestamp: T, cwd: '/repo' }))).toEqual(['── session abc · /repo'])
    expect(sessionEntryLines(entry({ type: 'model_change', model: 'openai-codex/gpt-6.1-sol' }))).toEqual(['· model openai-codex/gpt-6.1-sol'])
    expect(sessionEntryLines(entry({ type: 'thinking_level_change', thinkingLevel: 'xhigh' }))).toEqual(['· thinking xhigh'])
  })

  it('shows nothing for the title line, custom entries, credential pins, unknown types and broken lines', () => {
    expect(sessionEntryLines(entry({ type: 'title', v: 1, title: 'Plan', updatedAt: T, pad: '    ' }))).toEqual([])
    expect(sessionEntryLines(entry({ type: 'custom', customType: 'tool_execution_start', data: {} }))).toEqual([])
    expect(sessionEntryLines(entry({ type: 'credential_pin', provider: 'x' }))).toEqual([])
    expect(sessionEntryLines(entry({ type: 'something_new', x: 1 }))).toEqual([])
    expect(sessionEntryLines('{"type":"message","timestamp":')).toEqual([])
    expect(sessionEntryLines('')).toEqual([])
  })

  it('shows the first 12 lines of a prompt and how many more there are', () => {
    const lines = sessionEntryLines(message({ role: 'user', content: [{ type: 'text', text: numbered(30) }] }))
    expect(lines[0]).toBe(`${AT}  ▶ prompt`)
    expect(lines.slice(1, 13)).toEqual(Array.from({ length: 12 }, (_, i) => `${PAD}  line ${i + 1}`))
    expect(lines[13]).toBe(`${PAD}  … 18 more lines`)
    expect(lines).toHaveLength(14)
    expect(sessionEntryLines(message({ role: 'user', content: 'short\tprompt' }))).toEqual([`${AT}  ▶ prompt`, `${PAD}  short  prompt`])
  })

  it('renders an assistant message part by part: summaries, thinking, text, tool calls, and its error', () => {
    const lines = sessionEntryLines(
      message({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '**Checking the stage order**\nfirst the plan', summary: true },
          { type: 'thinking', thinking: numbered(5, 'thought') },
          { type: 'text', text: 'I will read the plan.\nThen act.' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'plan.md', i: 'Reading the plan' } },
          { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'x'.repeat(400) }, intent: 'Running the gates' },
          { type: 'toolCall', id: 'c3', name: 'todo', arguments: {} },
        ],
        model: 'gpt',
        stopReason: 'error',
        errorMessage: '429 rate limit',
      }),
    )
    expect(lines).toEqual([
      `${AT}  » Checking the stage order`,
      `${PAD}  first the plan`,
      `${PAD}∴ thinking`,
      `${PAD}  thought 1`,
      `${PAD}  thought 2`,
      `${PAD}  thought 3`,
      `${PAD}  … 2 more lines`,
      `${PAD}✎ I will read the plan.`,
      `${PAD}  Then act.`,
      `${PAD}▸ read: Reading the plan`,
      `${PAD}  {"path":"plan.md"}`,
      `${PAD}▸ bash: Running the gates`,
      `${PAD}  ${`{"command":"${'x'.repeat(400)}"}`.slice(0, 299)}…`,
      `${PAD}▸ todo`,
      `${PAD}  {}`,
      `${PAD}✗ error: 429 rate limit`,
    ])
  })

  it('shows the first 8 lines of a tool result, how much more there is, and images as a marker', () => {
    const text = numbered(40)
    const lines = sessionEntryLines(message({ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text }], isError: false, details: {} }))
    expect(lines[0]).toBe(`${AT}    ← read ✓`)
    expect(lines.slice(1, 9)).toEqual(Array.from({ length: 8 }, (_, i) => `${PAD}    line ${i + 1}`))
    expect(lines[9]).toBe(`${PAD}    … 32 more lines (${text.length} chars)`)
    expect(lines).toHaveLength(10)
    const failed = sessionEntryLines(
      message({ role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: '\x1b[31mboom\x1b[0m' }, { type: 'image', data: 'xx' }], isError: true }),
    )
    expect(failed).toEqual([`${AT}    ← bash ✗`, `${PAD}    boom`, `${PAD}    [image]`])
  })

  it('does not parse an entry over 2 MB', () => {
    const big = `{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"${'a'.repeat(3 * 1024 * 1024)}"}]}}`
    const parse = spyOn(JSON, 'parse')
    try {
      expect(sessionEntryLines(big)).toEqual([`(entry of ${Math.round(big.length / 1024)} KB not shown)`])
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('renders the line after a broken one', () => {
    const lines = ['{"type":"message",', entry({ type: 'model_change', model: 'm2' })].flatMap(sessionEntryLines)
    expect(lines).toEqual(['· model m2'])
  })

  it('produces no ANSI codes or tabs', () => {
    const lines = sessionEntryLines(message({ role: 'assistant', content: [{ type: 'text', text: '\x1b[1mbold\x1b[22m\tand \x1b]8;;http://x\x07link' }] }))
    expect(lines).toEqual([`${AT}  ✎ bold  and link`])
  })
})

describe('LineBuffer', () => {
  it('keeps the last max lines and says how many it dropped', () => {
    const buffer = new LineBuffer(5000)
    const v0 = buffer.version
    buffer.push(Array.from({ length: 4000 }, (_, i) => `l${i}`))
    buffer.push(Array.from({ length: 2000 }, (_, i) => `l${4000 + i}`))
    expect(buffer.version).toBeGreaterThan(v0)
    expect(buffer.dropped).toBe(1000)
    const lines = buffer.lines()
    expect(lines).toHaveLength(5001)
    expect(lines[0]).toBe('… 1000 earlier lines not kept')
    expect(lines[1]).toBe('l1000')
    expect(lines.at(-1)).toBe('l5999')
    expect(buffer.lines()).toBe(lines)
  })

  it('has no dropped line while it holds everything', () => {
    const buffer = new LineBuffer(3)
    buffer.push(['a', 'b'])
    expect(buffer.lines()).toEqual(['a', 'b'])
    const version = buffer.version
    buffer.push([])
    expect(buffer.version).toBe(version)
  })
})

const BASE = Date.parse('2026-11-05T17:00:00.000Z')
const j = (sec: number, type: string, data: Record<string, unknown> = {}): JournalEntry => ({ t: new Date(BASE + sec * 1000).toISOString(), type, ...data })
const S = (n: number, label: string) => `/r/.granny/runs/R/sessions/${n}-${label.replace(/ /g, '-')}`
let sessions = 0
const agentEntries = (sec: number, label: string, role: string, phase: string | undefined, extra: Record<string, unknown> = {}) => {
  const session = S(++sessions, label)
  return { session, entry: j(sec, 'agent', { label, role, ...(phase ? { phase } : {}), session, model: null, ...extra }) }
}

function fixture() {
  sessions = 0
  const e: JournalEntry[] = []
  const sess: Record<string, string> = {}
  const agent = (sec: number, label: string, role: string, phase: string | undefined, extra: Record<string, unknown> = {}) => {
    const { session, entry } = agentEntries(sec, label, role, phase, extra)
    sess[label] = session
    e.push(entry)
  }
  const end = (sec: number, label: string, outcome: string) => e.push(j(sec, 'agent-end', { label, session: sess[label], outcome }))
  e.push(j(0, 'phase', { title: 'Worktree' }), j(0, 'command', { command: 'git worktree add ../wt feat/x\nsecond line' }))
  e.push(j(1, 'phase', { title: 'Plan' }))
  agent(1, 'plan', 'planner', 'Plan', { model: 'openai-codex/gpt-6.1-sol', effort: 'xhigh' })
  e.push(j(2, 'subagent', { label: 'plan', agents: ['BaselineGates', 'PublishedContracts'] }))
  end(60, 'plan', 'done')
  e.push(j(61, 'phase', { title: 'Plan review' }))
  agent(61, 'review plan review r1 terra', 'reviewer', 'Plan review')
  end(120, 'review plan review r1 terra', 'done')
  agent(121, 'judge plan review r1', 'judge', 'Plan review')
  end(150, 'judge plan review r1', 'done')
  agent(151, 'judge plan review r1 retry', 'judge', 'Plan review')
  end(170, 'judge plan review r1 retry', 'done')
  agent(171, 'fix plan review r1', 'implementer', 'Plan review')
  end(200, 'fix plan review r1', 'done')
  agent(201, 'review plan review r2 terra', 'reviewer', 'Plan review')
  end(230, 'review plan review r2 terra', 'done')
  e.push(j(231, 'log', { message: 'plan review: clean after 2 rounds\nno findings left' }))
  e.push(j(232, 'phase', { title: 'Implement' }))
  agent(232, 'implement one', 'implementer', 'Implement')
  end(300, 'implement one', 'done')
  e.push(j(301, 'phase', { title: 'Checks' }), j(301, 'command', { command: 'bun test' }))
  e.push(j(302, 'phase', { title: 'Review' }))
  agent(302, 'review one r1 terra', 'reviewer', undefined)
  end(330, 'review one r1 terra', 'done')
  agent(331, 'judge one r1', 'judge', 'Review')
  e.push(j(340, 'agent-failed', { label: 'judge one r1', session: sess['judge one r1'], error: '503' }))
  e.push(j(341, 'phase', { title: 'Review' }))
  e.push(j(342, 'phase', { title: 'Implement' }))
  agent(342, 'implement two', 'implementer', 'Implement')
  end(400, 'implement two', 'done')
  e.push(j(401, 'phase', { title: 'Review' }))
  agent(401, 'review two r1 terra', 'reviewer', 'Review')
  end(420, 'review two r1 terra', 'cancelled')
  e.push(j(421, 'phase', { title: 'Final review' }))
  agent(421, 'review final review r1 terra', 'reviewer', 'Final review')
  end(450, 'review final review r1 terra', 'done')
  e.push(j(451, 'phase', { title: 'PR ready' }))
  agent(451, 'pr-ready check', 'granny', 'PR ready')
  return { entries: e, sess }
}

const activity = (session: string, label: string, opts: { active: boolean; state?: string; since?: number; outcome?: 'done' | 'failed' | 'cancelled' }) => {
  const role = new RoleActivity({ label, role: 'x', session, phase: 'p' }, BASE)
  if (opts.active) role.begin(BASE)
  role.state = opts.state ?? role.state
  role.since = BASE + (opts.since ?? 0) * 1000
  if (opts.outcome) role.outcome = opts.outcome
  return role
}

const NOW = BASE + 500_000
const listing = (rows: ReturnType<typeof visibleRows>, now = NOW, width?: number) => rows.map(r => rowText(r, now, width))

describe('groupOf', () => {
  it('groups review, judge, fix and extraction agents by subject and round, and implementers by stage', () => {
    expect(groupOf('review one r1 terra')).toBe('one · round 1')
    expect(groupOf('review plan review r2 terra #2')).toBe('plan review · round 2')
    expect(groupOf('review final review r1 terra')).toBe('final review · round 1')
    expect(groupOf('judge plan review r1 retry')).toBe('plan review · round 1')
    expect(groupOf('fix one r3')).toBe('one · round 3')
    expect(groupOf('extract one r1 codex')).toBe('one · round 1')
    expect(groupOf('extract one r1 codex retry')).toBe('one · round 1')
    expect(groupOf('implement stage two')).toBe('stage two')
    for (const label of ['plan', 'pr-ready check', 'commit one fix r1', 'resolve merge one', 'review']) expect(groupOf(label)).toBeUndefined()
  })
})

describe('buildRunTree / visibleRows', () => {
  it('lays out phases, groups, agents and subagents with markers and elapsed times', () => {
    const { entries, sess } = fixture()
    const live = new Map([[sess['pr-ready check']!, activity(sess['pr-ready check']!, 'pr-ready check', { active: true, state: 'thinking', since: 480 })]])
    const tree = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, live, NOW)
    expect(tree.phase).toBe('PR ready')
    expect(listing(visibleRows([tree], new Set(), 'R'))).toEqual([
      '▾ run R · running · 8m20s',
      '  ✓ Worktree · 1s',
      '  ✓ Plan · 1m00s',
      '    ✓ plan  planner · openai-codex/gpt-6.1-sol/xhigh · 59s',
      '      └ BaselineGates (no transcript yet)',
      '      └ PublishedContracts (no transcript yet)',
      '  ✓ Plan review · 2m51s',
      '    plan review · round 1',
      '      ✓ review plan review r1 terra  reviewer · default model · 59s',
      '      ✓ judge plan review r1  judge · default model · 29s',
      '      ✓ judge plan review r1 retry  judge · default model · 19s',
      '      ✓ fix plan review r1  implementer · default model · 29s',
      '    plan review · round 2',
      '      ✓ review plan review r2 terra  reviewer · default model · 29s',
      '  ✓ Implement · 1m09s',
      '    one',
      '      ✓ implement one  implementer · default model · 1m08s',
      '  ✓ Checks · 1s',
      '  ✗ Review · 40s',
      '    one · round 1',
      '      ✓ review one r1 terra  reviewer · default model · 28s',
      '      ✗ judge one r1  judge · default model · 9s',
      '  ✓ Implement · 59s',
      '    two',
      '      ✓ implement two  implementer · default model · 58s',
      '  ⊘ Review · 20s',
      '    two · round 1',
      '      ⊘ review two r1 terra  reviewer · default model · 19s',
      '  ✓ Final review · 30s',
      '    final review · round 1',
      '      ✓ review final review r1 terra  reviewer · default model · 29s',
      '  ● PR ready · 49s',
      '    ● pr-ready check  granny · default model · 49s · thinking 20s',
    ])
    const rows = visibleRows([tree], new Set(), 'R')
    expect(rows.filter(r => r.kind === 'group').every(r => !r.selectable)).toBe(true)
    expect(rows.filter(r => r.kind !== 'group').every(r => r.selectable)).toBe(true)
    expect(rows.find(r => r.agent?.label === 'judge one r1')?.agent?.error).toBe('503')
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
    expect(rows.map(r => r.key).slice(0, 5)).toEqual(['run:R', 'phase:R:0', 'phase:R:1', `agent:${sess.plan}`, `sub:${sess.plan}:BaselineGates`])
  })

  it('keeps the journal lines of each phase: logs, commands, agents started and ended', () => {
    const { entries } = fixture()
    const tree = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)
    const clock = (sec: number) => new Date(BASE + sec * 1000).toTimeString().slice(0, 8)
    expect(tree.phases[0]!.lines).toEqual([`${clock(0)}  $ git worktree add ../wt feat/x`])
    expect(tree.phases[1]!.lines).toEqual([`${clock(1)}  ▸ plan started (planner · openai-codex/gpt-6.1-sol/xhigh)`, `${clock(60)}  ■ plan done 59s`])
    expect(tree.phases[2]!.lines.slice(-3)).toEqual([`${clock(230)}  ■ review plan review r2 terra done 29s`, `${clock(231)}  plan review: clean after 2 rounds`, `          no findings left`])
  })

  it('shows the subagent transcripts it found instead of the journalled names', () => {
    const { entries, sess } = fixture()
    const files = new Map([[sess.plan!, new Map([['BaselineGates', '/x/BaselineGates.jsonl']])]])
    const tree = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW, files)
    expect(tree.agents[0]!.subagents).toEqual([{ name: 'BaselineGates', path: '/x/BaselineGates.jsonl' }])
  })

  it('marks an agent with no process and no end … while the run runs, and takes an outcome from memory', () => {
    const { entries, sess } = fixture()
    const waiting = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map([[sess['pr-ready check']!, activity(sess['pr-ready check']!, 'pr-ready check', { active: false })]]), NOW)
    expect(waiting.agents.at(-1)!.state).toBe('waiting')
    expect(listing(visibleRows([waiting], new Set(), 'R')).at(-1)).toBe('    … pr-ready check  granny · default model · 49s')
    const noLive = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)
    expect(noLive.agents.at(-1)!.state).toBe('waiting')
    const remembered = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map([[sess['pr-ready check']!, activity(sess['pr-ready check']!, 'x', { active: false, outcome: 'failed' })]]), NOW)
    expect(remembered.agents.at(-1)!.state).toBe('failed')
  })

  it('marks open agents and the last phase ⊘ when the run was cancelled', () => {
    const { entries } = fixture()
    const tree = buildRunTree({ id: 'R', status: 'cancelled', startedAt: BASE, endedAt: BASE + 460_000 }, entries, new Map(), NOW)
    const rows = listing(visibleRows([tree], new Set(), 'R'))
    expect(rows[0]).toBe('▾ run R · cancelled · 7m40s')
    expect(rows.slice(-2)).toEqual(['  ⊘ PR ready · 9s', '    ⊘ pr-ready check  granny · default model · 9s'])
  })

  it('places a parallel lane\'s agent in the last phase of its own title, not the current one', () => {
    sessions = 0
    const a = agentEntries(0, 'implement a', 'implementer', 'Implement')
    const r = agentEntries(10, 'review a r1 x', 'reviewer', 'Review')
    const b = agentEntries(12, 'implement b', 'implementer', 'Implement')
    const c = agentEntries(15, 'implement c', 'implementer', 'Implement')
    const entries = [
      j(0, 'phase', { title: 'Implement' }),
      a.entry,
      j(1, 'phase', { title: 'Implement' }),
      j(10, 'agent-end', { label: 'implement a', session: a.session, outcome: 'done' }),
      j(10, 'phase', { title: 'Review' }),
      r.entry,
      j(12, 'phase', { title: 'Implement' }),
      b.entry,
      j(14, 'phase', { title: 'Review' }),
      c.entry,
    ]
    const tree = buildRunTree({ id: 'P', status: 'running', startedAt: BASE }, entries, new Map(), BASE + 20_000)
    expect(tree.phases.map(p => [p.title, p.groups.flatMap(g => g.agents.map(x => x.label))])).toEqual([
      ['Implement', ['implement a']],
      ['Review', ['review a r1 x']],
      ['Implement', ['implement b', 'implement c']],
      ['Review', []],
    ])
  })

  it('treats a run that is not expanded as one row, and folds a phase', () => {
    const { entries } = fixture()
    const tree = buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)
    const other = buildRunTree({ id: 'Q', status: 'done', startedAt: BASE - 100_000, endedAt: BASE - 40_000 }, [], new Map(), NOW)
    expect(listing(visibleRows([other, tree], new Set(), 'R')).slice(0, 2)).toEqual(['▸ run Q · done · 1m00s', '▾ run R · running · 8m20s'])
    expect(listing(visibleRows([other, tree], new Set(['run:R']), 'R'))).toEqual(['▸ run Q · done · 1m00s', '▸ run R · running · 8m20s'])
    const folded = listing(visibleRows([tree], new Set(['phase:R:2']), 'R'))
    expect(folded.slice(5, 8)).toEqual(['      └ PublishedContracts (no transcript yet)', '  ✓ Plan review · 2m51s · 5 agents folded', '  ✓ Implement · 1m09s'])
    expect(folded.some(l => l.includes('judge plan review'))).toBe(false)
  })

  it('moves to the next and previous agent across phases, skipping groups, phases and subagents', () => {
    const { entries, sess } = fixture()
    const rows = visibleRows([buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)], new Set(), 'R')
    expect(nextAgent(rows, `agent:${sess.plan}`, 1)).toBe(`agent:${sess['review plan review r1 terra']}`)
    expect(nextAgent(rows, `agent:${sess['review plan review r2 terra']}`, 1)).toBe(`agent:${sess['implement one']}`)
    expect(nextAgent(rows, `agent:${sess['implement one']}`, -1)).toBe(`agent:${sess['review plan review r2 terra']}`)
    expect(nextAgent(rows, `sub:${sess.plan}:BaselineGates`, 1)).toBe(`agent:${sess['review plan review r1 terra']}`)
    expect(nextAgent(rows, 'run:R', 1)).toBe(`agent:${sess.plan}`)
    expect(nextAgent(rows, `agent:${sess.plan}`, -1)).toBeUndefined()
    expect(nextAgent(rows, `agent:${sess['pr-ready check']}`, 1)).toBeUndefined()
  })

  it('drops the provider prefix of a model when the row is narrow', () => {
    const { entries } = fixture()
    const rows = visibleRows([buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)], new Set(), 'R')
    expect(rowText(rows[3]!, NOW, 40)).toBe('    ✓ plan  planner · gpt-6.1-sol/xhigh · 59s')
  })

  it('reads a journal written before agents had a phase into the current phase', () => {
    sessions = 0
    const a = agentEntries(1, 'implement one', 'implementer', undefined)
    const tree = buildRunTree({ id: 'O', status: 'done', startedAt: BASE, endedAt: BASE + 9000 }, [j(0, 'phase', { title: 'Implement' }), a.entry], new Map(), NOW)
    expect(tree.phases[0]!.groups[0]!.agents[0]).toMatchObject({ label: 'implement one', phase: 'Implement', state: 'done', end: BASE + 9000 })
  })
})

describe('subagentFiles', () => {
  it('finds <Name>.jsonl one level under the session directory, by name', () => {
    const session = join(tmp, '1-plan')
    mkdirSync(join(session, '2026-01-01T00-00-00-000Z_u', 'deeper'), { recursive: true })
    writeFileSync(join(session, 'events.jsonl'), '')
    writeFileSync(join(session, '2026-01-01T00-00-00-000Z_u.jsonl'), '')
    writeFileSync(join(session, '2026-01-01T00-00-00-000Z_u', 'PublishedContracts.jsonl'), '')
    writeFileSync(join(session, '2026-01-01T00-00-00-000Z_u', 'BaselineGates.jsonl'), '')
    writeFileSync(join(session, '2026-01-01T00-00-00-000Z_u', '1.read.log'), '')
    writeFileSync(join(session, '2026-01-01T00-00-00-000Z_u', 'deeper', 'Nested.jsonl'), '')
    expect([...subagentFiles(session)]).toEqual([
      ['BaselineGates', join(session, '2026-01-01T00-00-00-000Z_u', 'BaselineGates.jsonl')],
      ['PublishedContracts', join(session, '2026-01-01T00-00-00-000Z_u', 'PublishedContracts.jsonl')],
    ])
    expect(subagentFiles(join(tmp, 'missing')).size).toBe(0)
  })
})
