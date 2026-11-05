import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TailReader } from '../src/adapters/omp/tail'

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
