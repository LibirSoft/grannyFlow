import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clean, clock, stamp } from '../src/adapters/omp/format'
import { TailReader } from '../src/adapters/runview/tail'
import { LineBuffer, sessionEntryLines } from '../src/adapters/omp/transcript'
import { LiveRun, RoleActivity } from '../src/adapters/omp/panel'
import { Navigator, type NavRun } from '../src/adapters/omp/navigator'
import { buildRunTree, groupOf, type JournalEntry, nextAgent, rowText, visibleRows } from '../src/adapters/runview/tree'
import { subagentFiles } from '../src/adapters/omp/subagents'

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

describe('format', () => {
  it('clock gives the local HH:MM:SS of a date string or epoch ms, else a placeholder', () => {
    const iso = '2026-11-05T17:37:50.000Z'
    const local = new Date(iso).toTimeString().slice(0, 8)
    expect(clock(iso)).toBe(local)
    expect(clock(Date.parse(iso))).toBe(local)
    for (const bad of [undefined, null, 'not a date', Number.NaN, {}]) expect(clock(bad)).toBe('--:--:--')
  })

  it('stamp gives the date and local time, or undefined', () => {
    const iso = '2026-11-05T17:37:50.000Z'
    const d = new Date(iso)
    expect(stamp(iso)).toBe(`${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`)
    expect(stamp(d.getTime())).toBe(stamp(iso))
    expect(stamp('nope')).toBeUndefined()
    expect(stamp(undefined)).toBeUndefined()
  })

  it('clean turns tabs into two spaces and drops ANSI and control codes', () => {
    expect(clean('a\tb \x1b[31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 \x07bell\r\nnext')).toBe('a  b red link bell\nnext')
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

  it('drops the provider prefix of a model when the row is narrow, then the role and model', () => {
    const { entries } = fixture()
    const rows = visibleRows([buildRunTree({ id: 'R', status: 'running', startedAt: BASE }, entries, new Map(), NOW)], new Set(), 'R')
    expect(rowText(rows[3]!, NOW, 58)).toBe('    ✓ plan  planner · openai-codex/gpt-6.1-sol/xhigh · 59s')
    expect(rowText(rows[3]!, NOW, 57)).toBe('    ✓ plan  planner · gpt-6.1-sol/xhigh · 59s')
    expect(rowText(rows[3]!, NOW, 44)).toBe('    ✓ plan · 59s')
    expect(rowText(rows.at(-1)!, NOW, 30)).toBe('    … pr-ready check · 49s')
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

describe('Navigator', () => {
  const T0 = Date.parse('2026-11-05T17:00:00.000Z')
  const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString()
  const line = (value: unknown) => `${JSON.stringify(value)}\n`
  const TREE_HELP = '↑↓ move · Enter/→ open · Space fold · Tab/] next agent · [ prev · Esc close'

  function setup(options: { theme?: any; matches?: (data: string, name: string) => boolean; rows?: number; twoRuns?: boolean } = {}) {
    const dir = join(tmp, 'runs', 'R1')
    const plan = join(dir, 'sessions', '1-plan')
    const impl = join(dir, 'sessions', '2-implement-one')
    mkdirSync(join(plan, '2026-11-05T17-00-01-000Z_u'), { recursive: true })
    mkdirSync(impl, { recursive: true })
    const journal = [
      { t: iso(0), type: 'phase', title: 'Plan' },
      { t: iso(1), type: 'agent', label: 'plan', role: 'planner', phase: 'Plan', session: plan, model: 'openai/gpt-x', effort: 'high' },
      { t: iso(2), type: 'subagent', label: 'plan', agents: ['BaselineGates'] },
      { t: iso(60), type: 'agent-end', label: 'plan', session: plan, outcome: 'done' },
      { t: iso(61), type: 'phase', title: 'Implement' },
      { t: iso(61), type: 'log', message: 'implementing stage one' },
      { t: iso(62), type: 'agent', label: 'implement one', role: 'implementer', phase: 'Implement', session: impl, model: 'openai/gpt-x' },
    ]
    writeFileSync(join(dir, 'journal.jsonl'), journal.map(line).join(''))
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: 'R1', status: 'running', repo: '/repo', branch: 'feat/x', startedAt: iso(0) }))
    writeFileSync(
      join(plan, '2026-11-05T17-00-01-000Z_u.jsonl'),
      [
        { type: 'title', v: 1, title: 'plan' },
        { type: 'session', version: 3, id: 'u', timestamp: iso(1), cwd: '/repo' },
        { type: 'message', timestamp: iso(2), message: { role: 'user', content: [{ type: 'text', text: 'Write the plan.' }] } },
        { type: 'message', timestamp: iso(59), message: { role: 'assistant', content: [{ type: 'text', text: 'Plan written.' }], stopReason: 'stop' } },
      ]
        .map(line)
        .join(''),
    )
    writeFileSync(join(plan, '2026-11-05T17-00-01-000Z_u', 'BaselineGates.jsonl'), line({ type: 'message', timestamp: iso(5), message: { role: 'assistant', content: [{ type: 'text', text: 'Gates are green.' }] } }))
    writeFileSync(join(plan, 'events.jsonl'), line({ t: iso(3), type: 'heading', text: 'Drafting the stages' }))
    writeFileSync(join(impl, 'events.jsonl'), [line({ t: iso(63), type: 'heading', text: 'Reading the plan' }), line({ t: iso(64), type: 'tool', name: 'read', intent: 'Reading the plan', arg: 'plan.md' })].join(''))

    const clock = { t: T0 }
    const live = new LiveRun('R1', undefined, { now: () => clock.t, renderEveryMs: 1000 })
    clock.t = T0 + 90_000
    const planRole = live.role({ label: 'plan', role: 'planner', session: plan, phase: 'Plan' })
    live.start(planRole)
    live.stop(planRole)
    planRole.outcome = 'done'
    const implRole = live.role({ label: 'implement one', role: 'implementer', session: impl, phase: 'Implement' })
    live.start(implRole)
    implRole.state = 'thinking'
    implRole.since = T0 + 80_000
    const run: NavRun = { id: 'R1', dir, status: 'running', live }
    const oldDir = join(tmp, 'runs', 'R0')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, 'journal.jsonl'),
      [
        { t: iso(-600), type: 'phase', title: 'Plan' },
        { t: iso(-599), type: 'agent', label: 'plan', role: 'planner', phase: 'Plan', session: join(oldDir, 'sessions', '1-plan'), model: null },
        { t: iso(-500), type: 'agent-end', label: 'plan', session: join(oldDir, 'sessions', '1-plan'), outcome: 'done' },
        { t: iso(-480), type: 'phase', title: 'PR ready' },
      ]
        .map(line)
        .join(''),
    )
    const earlier: NavRun = { id: 'R0', dir: oldDir, status: 'done', reply: 'R0 finished.', live: new LiveRun('R0', undefined, { now: () => T0 - 600_000, renderEveryMs: 1000 }) }
    const all = options.twoRuns ? [earlier, run] : [run]
    const renders = { count: 0, fail: false }
    const tui = {
      requestRender: () => {
        renders.count++
        if (renders.fail) throw new Error('stale tui')
      },
      terminal: { rows: options.rows ?? 30 },
    }
    let closed = 0
    const nav = new Navigator({
      runs: () => all,
      runId: 'R1',
      tui,
      theme: options.theme ?? {},
      keys: { matches: options.matches ?? (() => false) },
      done: () => void closed++,
      now: () => clock.t,
      tickMs: 60_000,
    })
    const text = (width = 160) => nav.render(width).join('\n')
    const selected = (width = 160) => nav.render(width).find(l => l.startsWith('›'))
    return { dir, plan, impl, run, live, clock, renders, nav, text, selected, closed: () => closed, implRole }
  }

  let nav: Navigator | undefined
  afterEach(() => nav?.dispose())
  const open = (options?: Parameters<typeof setup>[0]) => {
    const s = setup(options)
    nav = s.nav
    return s
  }

  it('opens on the run\'s running agent with its live events in the detail and the tree key help last', () => {
    const s = open()
    const lines = s.nav.render(160)
    expect(lines).toHaveLength(30)
    expect(lines[0]).toStartWith('granny R1 · Implement · running · 1m30s')
    expect(lines[0]).toEndWith('[tree]')
    expect(lines[1]).toStartWith('  ▾ run R1 · running · 1m30s')
    expect(s.selected()).toStartWith('›       ● implement one')
    const body = lines.join('\n')
    expect(body).toContain('│ implement one (implementer) · openai/gpt-x · thinking 10s · events · follow on')
    expect(body).toContain('» Reading the plan')
    expect(body).toContain('▸ read: Reading the plan (plan.md)')
    expect(lines.at(-1)).toBe(TREE_HELP)
  })

  it('keeps every row within the width and shows one pane below 100 columns', () => {
    const s = open()
    for (const width of [20, 60, 99, 100, 160]) {
      const lines = s.nav.render(width)
      expect(lines.every(l => l.length <= width)).toBe(true)
      expect(lines.some(l => l.includes(' │ '))).toBe(width >= 100)
    }
    const narrow = s.nav.render(60).join('\n')
    expect(narrow).toContain('run R1')
    expect(narrow).not.toContain('» Reading the plan')
    s.nav.handleInput('\r')
    const detail = s.nav.render(60).join('\n')
    expect(detail).toContain('» Reading the plan')
    expect(detail).not.toContain('run R1 · running')
  })

  it('moves the selection with the arrows, Home, End and the page keys, skipping group rows, and previews it', () => {
    const s = open()
    s.nav.handleInput('\x1b[A')
    expect(s.selected()).toStartWith('›   ● Implement')
    s.nav.tick()
    expect(s.text()).toContain('implementing stage one')
    s.nav.handleInput('k')
    expect(s.selected()).toStartWith('›       └ BaselineGates')
    s.nav.tick()
    expect(s.text()).toContain('✎ Gates are green.')
    s.nav.handleInput('\x1b[B')
    expect(s.selected()).toStartWith('›   ● Implement')
    s.nav.handleInput('\x1b[H')
    expect(s.selected()).toStartWith('› ▾ run R1')
    s.nav.handleInput('\x1b[F')
    expect(s.selected()).toStartWith('›       ● implement one')
    s.nav.handleInput('\x1b[5~')
    expect(s.selected()).toStartWith('› ▾ run R1')
    s.nav.handleInput('\x1b[6~')
    expect(s.selected()).toStartWith('›       ● implement one')
    s.nav.handleInput('j')
    expect(s.selected()).toStartWith('›       ● implement one')
  })

  it('opens the detail with Enter or →, goes back with Esc, closes once with Esc again or q', () => {
    const s = open()
    s.nav.handleInput('\r')
    let lines = s.nav.render(160)
    expect(lines[0]).toEndWith('[detail]')
    expect(lines.at(-1)).toBe('↑↓ PgUp/PgDn Home/End scroll · f follow (on) · t transcript · Tab/] [ agent · ←/Esc back · q close')
    s.nav.handleInput('\x1b')
    lines = s.nav.render(160)
    expect(lines[0]).toEndWith('[tree]')
    expect(lines.at(-1)).toBe(TREE_HELP)
    s.nav.handleInput('\x1b[C')
    expect(s.nav.render(160)[0]).toEndWith('[detail]')
    s.nav.handleInput('\x1b[D')
    s.nav.handleInput('\x1b')
    expect(s.closed()).toBe(1)
    expect(s.nav.disposed).toBe(true)
    s.nav.handleInput('\x1b')
    s.nav.handleInput('q')
    expect(s.closed()).toBe(1)
    const before = s.renders.count
    s.nav.tick()
    expect(s.renders.count).toBe(before)

    const t = open()
    t.nav.handleInput('\r')
    t.nav.handleInput('q')
    expect(t.closed()).toBe(1)
  })

  it('switches agents from the detail with Tab, ] and [, across phases, staying in the detail', () => {
    const s = open()
    s.nav.handleInput('\r')
    s.nav.handleInput('[')
    s.nav.tick()
    let lines = s.nav.render(160)
    expect(lines[0]).toEndWith('[detail]')
    expect(lines.join('\n')).toContain('│ plan (planner) · openai/gpt-x/high · done 59s · transcript · follow off')
    expect(lines.join('\n')).toContain('✎ Plan written.')
    s.nav.handleInput(']')
    expect(s.text()).toContain('│ implement one (implementer)')
    s.nav.handleInput('\x1b[Z')
    expect(s.text()).toContain('│ plan (planner)')
    s.nav.handleInput('\t')
    lines = s.nav.render(160)
    expect(lines.join('\n')).toContain('│ implement one (implementer)')
    expect(lines[0]).toEndWith('[detail]')
    s.nav.handleInput('\t')
    expect(s.text()).toContain('│ implement one (implementer)')
  })

  it('follows a running agent\'s new events, holds the view after scrolling up, and follows again with f', () => {
    const s = open({ rows: 20 })
    s.nav.handleInput('\r')
    const events = join(s.impl, 'events.jsonl')
    const read0 = s.nav.bytesRead
    const batch = Array.from({ length: 40 }, (_, i) => line({ t: iso(70 + i), type: 'heading', text: `step ${i}` })).join('')
    appendFileSync(events, batch)
    s.nav.tick()
    expect(s.nav.bytesRead - read0).toBe(Buffer.byteLength(batch))
    let lines = s.nav.render(160)
    expect(lines.at(-2)).toEndWith('» step 39')
    s.nav.handleInput('\x1b[A')
    lines = s.nav.render(160)
    expect(lines.at(-2)).toEndWith('» step 38')
    expect(lines.at(-1)).toContain('f follow (off)')
    const detailOf = (rows: readonly string[]) => rows.slice(2, -1).map(l => l.slice(l.indexOf(' │ ') + 3))
    const held = detailOf(lines)
    appendFileSync(events, line({ t: iso(200), type: 'heading', text: 'step 40' }))
    s.clock.t += 1000
    s.nav.tick()
    lines = s.nav.render(160)
    expect(detailOf(lines)).toEqual(held)
    s.nav.handleInput('f')
    lines = s.nav.render(160)
    expect(lines.at(-2)).toEndWith('» step 40')
    expect(lines.at(-1)).toContain('f follow (on)')
    s.nav.handleInput('\x1b[H')
    expect(s.nav.render(160).join('\n')).not.toContain('step 40')
    s.nav.handleInput('\x1b[F')
    expect(s.nav.render(160).at(-2)).toEndWith('» step 40')
  })

  it('shows a finished agent\'s transcript, toggles to its events with t, and opens a subagent\'s file', () => {
    const s = open()
    s.nav.handleInput('\x1b[H')
    s.nav.handleInput('\x1b[B')
    s.nav.handleInput('\x1b[B')
    expect(s.selected()).toStartWith('›     ✓ plan')
    s.nav.tick()
    expect(s.text()).toContain('▶ prompt')
    expect(s.text()).toContain('✎ Plan written.')
    s.nav.handleInput('\r')
    s.nav.handleInput('t')
    s.nav.tick()
    expect(s.text()).toContain('· events · follow off')
    expect(s.text()).toContain('» Drafting the stages')
    expect(s.text()).not.toContain('Plan written.')
    s.nav.handleInput('t')
    s.nav.tick()
    expect(s.text()).toContain('✎ Plan written.')
    s.nav.handleInput('\x1b')
    s.nav.handleInput('\x1b[B')
    s.nav.tick()
    expect(s.text()).toContain('BaselineGates · subagent of plan')
    expect(s.text()).toContain('✎ Gates are green.')
  })

  it('opens a finished agent\'s transcript at its end when it is drawn before its first read', () => {
    const s = open()
    const session = join(s.plan, '2026-11-05T17-00-01-000Z_u.jsonl')
    appendFileSync(session, Array.from({ length: 100 }, (_, i) => line({ type: 'message', timestamp: iso(60), message: { role: 'assistant', content: [{ type: 'text', text: `line ${i}` }] } })).join(''))
    s.nav.handleInput('[')
    expect(s.text()).toContain('(reading …)')
    s.nav.handleInput('\x1b[C')
    s.nav.render(160)
    s.nav.tick()
    const lines = s.nav.render(160)
    expect(lines.at(-2)).toEndWith('✎ line 99')
    expect(lines.join('\n')).not.toContain('▶ prompt')
  })

  it('keeps a phase\'s journal lines at their end as they arrive until the view is scrolled', () => {
    const s = open({ rows: 12 })
    s.nav.handleInput('\x1b[A')
    s.nav.render(160)
    s.nav.tick()
    s.nav.render(160)
    appendFileSync(join(s.dir, 'journal.jsonl'), Array.from({ length: 20 }, (_, i) => line({ t: iso(70 + i), type: 'log', message: `note ${i}` })).join(''))
    s.nav.tick()
    expect(s.nav.render(160).at(-2)).toEndWith('note 19')
  })

  it('holds the view where it is when follow is turned off with f', () => {
    const s = open({ rows: 12 })
    const events = join(s.impl, 'events.jsonl')
    const steps = (from: number) => Array.from({ length: 20 }, (_, i) => line({ t: iso(70 + from + i), type: 'heading', text: `step ${from + i}` })).join('')
    s.nav.handleInput('\r')
    appendFileSync(events, steps(0))
    s.nav.tick()
    s.nav.render(160)
    s.nav.handleInput('f')
    const before = s.nav.render(160)
    expect(before.at(-1)).toContain('f follow (off)')
    expect(before.at(-2)).toEndWith('» step 19')
    appendFileSync(events, steps(20))
    s.nav.tick()
    const after = s.nav.render(160)
    expect(after.slice(2, -1).map(l => l.slice(l.indexOf(' │ ') + 3))).toEqual(before.slice(2, -1).map(l => l.slice(l.indexOf(' │ ') + 3)))
  })

  it('reads a newly selected source right after the key, outside the key handler', async () => {
    const s = open()
    s.nav.handleInput('[')
    expect(s.text()).toContain('(reading …)')
    await Bun.sleep(20)
    expect(s.text()).toContain('✎ Plan written.')
  })

  it('shows a phase\'s journal lines and the run\'s result once it ends', () => {
    const s = open()
    s.nav.handleInput('\x1b[A')
    s.nav.tick()
    expect(s.text()).toContain('implementing stage one')
    expect(s.text()).toContain('▸ implement one started (implementer · openai/gpt-x)')
    s.nav.handleInput('\x1b[H')
    s.nav.tick()
    expect(s.text()).toContain('repo     /repo')
    expect(s.text()).toContain('branch   feat/x')
    expect(s.text()).toContain(`result   ${join(s.dir, 'result.json')}`)
    expect(s.text()).not.toContain('[granny] Run R1 finished.')
    s.run.status = 'done'
    s.run.reply = '[granny] Run R1 finished.\n- one: clean'
    s.live.stop(s.implRole)
    s.implRole.outcome = 'done'
    s.nav.tick()
    expect(s.text()).toContain('[granny] Run R1 finished.')
    expect(s.text()).toContain('- one: clean')
  })

  it('draws event text, journal lines and the run reply without control characters', () => {
    const s = open()
    appendFileSync(join(s.impl, 'events.jsonl'), line({ t: iso(70), type: 'text', text: '\x1b[31mred answer\x1b[0m\r\nbell\x07 line' }))
    appendFileSync(join(s.dir, 'journal.jsonl'), line({ t: iso(71), type: 'log', message: 'log \x1b[32mgreen\x1b[0m\r\x07' }))
    s.nav.tick()
    expect(s.text()).toContain('red answer')
    expect(s.text()).toContain('bell line')
    s.nav.handleInput('\x1b[A')
    s.nav.tick()
    expect(s.text()).toContain('log green')
    s.run.status = 'done'
    s.run.reply = '[granny] Run R1 \x1b[1mfinished\x1b[0m.\r\n- one: clean\x07'
    s.live.stop(s.implRole)
    s.implRole.outcome = 'done'
    s.nav.handleInput('\x1b[H')
    s.nav.tick()
    expect(s.text()).toContain('[granny] Run R1 finished.')
    expect(s.text()).toContain('- one: clean')
    for (const l of s.nav.render(160)) expect(l).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
  })

  it('redraws once per tick however much was written, at once on a key, and never reads files in render', () => {
    const s = open()
    const events = join(s.impl, 'events.jsonl')
    s.nav.tick()
    let before = s.renders.count
    for (let i = 0; i < 50; i++) appendFileSync(events, line({ t: iso(70), type: 'heading', text: `n${i}` }))
    expect(s.renders.count).toBe(before)
    s.nav.tick()
    expect(s.renders.count).toBe(before + 1)
    before = s.renders.count
    s.nav.handleInput('\x1b[A')
    expect(s.renders.count).toBe(before + 1)
    s.nav.handleInput('\x1b[B')
    s.nav.tick()
    const first = s.nav.render(160)
    expect(s.nav.render(160)).toBe(first)
    rmSync(s.dir, { recursive: true, force: true })
    s.nav.invalidate()
    expect(s.nav.render(160)).toEqual(first)
    expect(first.join('\n')).toContain('» n49')
  })

  it('consults the named key bindings and captures exactly the keys it handles', () => {
    const s = open({ matches: (data, name) => data === 'X!' && name === 'tui.select.up' })
    s.nav.handleInput('X!')
    expect(s.selected()).toStartWith('›   ● Implement')
    for (const key of ['\x1b[D', 'f', 't', '[', ']', '\t', '\x1b[Z', ' ', 'q', '\x1b', '\r', 'j', 'k', '\x1b[5~', 'X!']) expect(s.nav.capturesInput(key)).toBe(true)
    for (const key of ['x', 'c', 'b', '\x1b[1;5C']) expect(s.nav.capturesInput(key)).toBe(false)
  })

  it('lists the other runs folded and expands one with Enter or Space, folding the others', () => {
    const s = open({ twoRuns: true })
    let lines = s.nav.render(160)
    expect(lines[1]).toStartWith('  ▸ run R0 · done · 2m00s')
    expect(lines[2]).toStartWith('  ▾ run R1 · running · 1m30s')
    s.nav.handleInput('\x1b[H')
    expect(s.selected()).toStartWith('› ▸ run R0')
    s.nav.handleInput('\r')
    s.nav.tick()
    lines = s.nav.render(160)
    expect(lines[0]).toStartWith('granny R0 · PR ready · done · 2m00s')
    expect(lines[0]).toEndWith('[tree]')
    expect(lines.join('\n')).toContain('✓ plan  planner · default model · 1m39s')
    expect(lines.join('\n')).toContain('R0 finished.')
    expect(lines.some(l => l.startsWith('  ▸ run R1 · running'))).toBe(true)
    s.nav.handleInput('\x1b[F')
    expect(s.selected()).toStartWith('› ▸ run R1')
    s.nav.handleInput(' ')
    expect(s.nav.render(160)[0]).toStartWith('granny R1 · Implement')
    expect(s.text()).toContain('● implement one')
  })

  it('folds a phase with Space and jumps to the parent with ←', () => {
    const s = open()
    s.nav.handleInput('\x1b[D')
    expect(s.selected()).toStartWith('›   ● Implement')
    s.nav.handleInput(' ')
    expect(s.text()).not.toContain('● implement one')
    expect(s.text()).toContain('● Implement · 29s · 1 agent folded')
    s.nav.handleInput(' ')
    expect(s.text()).toContain('● implement one')
  })

  it('survives a throwing requestRender by closing itself once, and a throwing theme by drawing plain text', () => {
    const s = open()
    s.renders.fail = true
    expect(() => s.nav.tick()).not.toThrow()
    expect(s.nav.disposed).toBe(true)
    expect(s.closed()).toBe(1)
    expect(() => s.nav.handleInput('\x1b[A')).not.toThrow()
    const count = s.renders.count
    s.nav.tick()
    expect(s.renders.count).toBe(count)
    expect(s.closed()).toBe(1)

    const k = open()
    k.renders.fail = true
    expect(() => k.nav.handleInput('\x1b[A')).not.toThrow()
    expect(k.nav.disposed).toBe(true)
    expect(k.closed()).toBe(1)
    k.nav.handleInput('q')
    expect(k.closed()).toBe(1)

    const t = open({
      theme: {
        fg: () => {
          throw new Error('theme gone')
        },
        bg: () => {
          throw new Error('theme gone')
        },
      },
    })
    const lines = t.nav.render(160)
    expect(lines[0]).toStartWith('granny R1 · Implement')
    expect(t.selected()).toStartWith('›       ● implement one')
  })

  it('colours rows through the theme without changing their text', () => {
    const theme = { fg: (c: string, x: string) => `<${c}>${x}</>`, bg: (c: string, x: string) => `[${c}]${x}[/]`, bold: (x: string) => x }
    const s = open({ theme })
    const lines = s.nav.render(160)
    expect(lines[0]).toContain('<accent>granny R1')
    expect(lines.some(l => l.includes('[selectedBg]›       ● implement one'))).toBe(true)
  })
})
