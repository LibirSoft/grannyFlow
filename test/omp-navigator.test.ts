import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TailReader } from '../src/adapters/omp/tail'
import { LineBuffer, sessionEntryLines } from '../src/adapters/omp/transcript'

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
