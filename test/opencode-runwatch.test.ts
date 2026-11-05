import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chipText, discoverRuns, type FsLike, type RoleMeta, roleMeta, type RoleSession, RunWatch, sidebarLines, toastFor } from '../src/adapters/opencode/runwatch'
import type { LiveView } from '../src/adapters/runview/tree'

const BASE = Date.parse('2026-11-05T18:23:28.000Z')
const S = 1000
const M = 60 * S
const RUN = '20261105-182328-523r'
const kimi = { providerID: 'opencode', id: 'kimi-k3.1-pro' }

let tmp: string
let dir: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'granny-runwatch-'))
  dir = join(tmp, RUN)
  mkdirSync(dir)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const line = (ms: number, type: string, data: Record<string, unknown> = {}) => `${JSON.stringify({ t: new Date(BASE + ms).toISOString(), type, ...data })}\n`
const journal = (...lines: string[]) => appendFileSync(join(dir, 'journal.jsonl'), lines.join(''))
const status = (data: Record<string, unknown>) =>
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: RUN, status: 'running', repo: '/repo', branch: 'feat/x', parent: 'parent', watch: 'full', startedAt: new Date(BASE).toISOString(), ...data }, null, 2))

const meta = (over: Partial<RoleMeta> = {}): RoleMeta => ({ run: RUN, dir, parent: 'parent', label: 'plan', role: 'planner', phase: 'Plan', model: 'opencode/kimi-k3.1-pro', ...over })
const session = (id: string, m?: unknown) => ({ id, ...(m === undefined ? {} : { metadata: { 'granny-workflow': m } }) })

function countingFs() {
  const counts = { stat: 0, readText: 0 }
  const fs: FsLike = {
    stat(path) {
      counts.stat++
      const st = statSync(path)
      return { size: st.size, mtimeMs: st.mtimeMs }
    },
    readText(path) {
      counts.readText++
      return readFileSync(path, 'utf8')
    },
  }
  return { fs, counts }
}

const planRun = () => {
  status({})
  journal(
    line(0, 'phase', { title: 'Plan' }),
    line(1 * S, 'agent', { label: 'plan', role: 'planner', session: 'ses_plan', model: kimi, phase: 'Plan', linked: true }),
    line(31 * M, 'agent-end', { label: 'plan', session: 'ses_plan', outcome: 'done' }),
    line(31 * M, 'phase', { title: 'Plan review' }),
    line(31 * M + 1 * S, 'agent', { label: 'review plan review r2 terra', role: 'reviewer', session: 'ses_r', model: kimi, phase: 'Plan review', linked: true }),
    line(31 * M + 2 * S, 'agent', { label: 'review plan review r2 codex', role: 'reviewer', session: 'ses_c', model: { providerID: 'openai', id: 'gpt-5.5' }, phase: 'Plan review', linked: true }),
    line(32 * M, 'agent-end', { label: 'review plan review r2 codex', session: 'ses_c', outcome: 'done' }),
  )
}
const running = (...sessions: string[]) => new Map<string, LiveView>(sessions.map(s => [s, { active: true }]))

describe('roleMeta', () => {
  it('reads granny-workflow metadata and rejects malformed or foreign metadata', () => {
    expect(roleMeta(session('a', meta()))).toEqual(meta())
    expect(roleMeta(session('a', { ...meta(), model: undefined }))).toEqual({ ...meta(), model: null })
    expect(roleMeta(session('a', { ...meta(), model: null }))?.model).toBeNull()
    expect(roleMeta(session('a'))).toBeUndefined()
    expect(roleMeta({ id: 'a', metadata: { other: meta() } })).toBeUndefined()
    expect(roleMeta(session('a', { ...meta(), run: 7 }))).toBeUndefined()
    expect(roleMeta(session('a', { ...meta(), model: 3 }))).toBeUndefined()
    expect(roleMeta(session('a', 'nope'))).toBeUndefined()
    expect(roleMeta(undefined)).toBeUndefined()
  })
})

describe('discoverRuns', () => {
  it('groups role sessions by run and skips other sessions', () => {
    const other = join(tmp, 'other')
    const runs = discoverRuns([
      session('parent'),
      session('s1', meta()),
      session('s2', meta({ run: 'other', dir: other, label: 'implement one', role: 'implementer', phase: 'Implement' })),
      session('s3', meta({ label: 'review plan review r1 a', role: 'reviewer', phase: 'Plan review' })),
      session('s4', { ...meta(), dir: 1 }),
    ])
    expect([...runs.keys()]).toEqual([RUN, 'other'])
    expect(runs.get(RUN)).toMatchObject({ dir, parent: 'parent', sessions: ['s1', 's3'] })
    expect(runs.get(RUN)!.roles.map(r => r.meta.label)).toEqual(['plan', 'review plan review r1 a'])
    expect(runs.get('other')).toMatchObject({ dir: other, parent: 'parent', sessions: ['s2'] })
  })
})

describe('RunWatch', () => {
  it('reads only the new journal bytes on each poll', () => {
    planRun()
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running('ses_r'))
    const before = watch.journal.bytesRead
    const grow = line(32 * M + 10 * S, 'log', { message: 'x' })
    const pad = 100 - Buffer.byteLength(grow)
    const extra = line(32 * M + 10 * S, 'log', { message: 'x'.repeat(1 + pad) })
    expect(Buffer.byteLength(extra)).toBe(100)
    journal(extra)
    watch.poll(running('ses_r'))
    expect(watch.journal.bytesRead - before).toBe(100)
    expect(watch.snapshot.tree.phases.at(-1)!.lines.at(-1)).toContain('x'.repeat(1 + pad))
  })

  it('drops control characters from the status error, repo and branch', () => {
    planRun()
    status({ status: 'failed', error: 'Error: \x1b[31mboom\x1b[0m\r\n    at x\x07', repo: '/re\x07po', branch: 'feat/\x1b[1mx' })
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running())
    expect(watch.snapshot).toMatchObject({ error: 'Error: boom\n    at x', repo: '/repo', branch: 'feat/x' })
  })

  it('does not re-read an unchanged status.json and reports no change', () => {
    planRun()
    const { fs, counts } = countingFs()
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M, read: fs })
    expect(watch.poll(running('ses_r'))).toBe(true)
    expect(counts.readText).toBe(1)
    expect(watch.poll(running('ses_r'))).toBe(false)
    expect(counts.readText).toBe(1)
    status({ status: 'done', finishedAt: new Date(BASE + 33 * M).toISOString() })
    expect(watch.poll(running())).toBe(true)
    expect(counts.readText).toBe(2)
    expect(watch.snapshot.status).toBe('done')
  })

  it('reports a change when a live role starts or the clock passes a second', () => {
    planRun()
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running())
    expect(watch.poll(running())).toBe(false)
    expect(watch.poll(running('ses_r'))).toBe(true)
    now += 400
    expect(watch.poll(running('ses_r'))).toBe(false)
    now += 600
    expect(watch.poll(running('ses_r'))).toBe(true)
  })

  it('builds a snapshot from status.json and the journal', () => {
    planRun()
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running('ses_r'))
    const s = watch.snapshot
    expect(s).toMatchObject({ id: RUN, status: 'running', watch: 'full', parent: 'parent', phase: 'Plan review', start: BASE, readable: true, repo: '/repo', branch: 'feat/x' })
    expect(s.end).toBeUndefined()
    expect(s.tree.agents.map(a => [a.label, a.state, a.model])).toEqual([
      ['plan', 'done', 'opencode/kimi-k3.1-pro'],
      ['review plan review r2 terra', 'running', 'opencode/kimi-k3.1-pro'],
      ['review plan review r2 codex', 'done', 'openai/gpt-5.5'],
    ])
  })

  it('keeps the start time when the finished status.json no longer has it', () => {
    planRun()
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running('ses_r'))
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: RUN, status: 'done', parent: 'parent', watch: 'full', finishedAt: new Date(BASE + 34 * M).toISOString() }))
    now = BASE + 40 * M
    watch.poll(running())
    expect(watch.snapshot).toMatchObject({ status: 'done', start: BASE, end: BASE + 34 * M })
  })

  it('emits no events for the backlog, then phase, failed and ended events', () => {
    planRun()
    journal(line(31 * M + 5 * S, 'agent-end', { label: 'old', session: 'ses_old', outcome: 'failed', error: 'old' }))
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running('ses_r'))
    expect(watch.events).toEqual([])

    journal(line(33 * M, 'agent-end', { label: 'review plan review r2 terra', session: 'ses_r', outcome: 'done' }), line(33 * M, 'phase', { title: 'Review' }))
    now += S
    watch.poll(running())
    expect(watch.events.splice(0)).toEqual([{ type: 'phase', title: 'Review' }])

    journal(
      line(34 * M, 'agent', { label: 'judge one r1', role: 'judge', session: 'ses_j', model: null, phase: 'Review', linked: true }),
      line(35 * M, 'agent-failed', { label: 'judge one r1', session: 'ses_j', error: 'no answer\nmore' }),
      line(35 * M, 'agent-end', { label: 'judge one r1', session: 'ses_j', outcome: 'failed' }),
      line(35 * M, 'agent', { label: 'judge one r1 b', role: 'judge', session: 'ses_k', model: null, phase: 'Review', linked: true }),
      line(36 * M, 'agent-end', { label: 'judge one r1 b', session: 'ses_k', outcome: 'failed', error: 'boom' }),
    )
    now += S
    watch.poll(running())
    expect(watch.events.splice(0)).toEqual([
      { type: 'failed', label: 'judge one r1', error: 'no answer\nmore' },
      { type: 'failed', label: 'judge one r1 b', error: 'boom' },
    ])

    now += S
    watch.poll(running())
    expect(watch.events).toEqual([])

    status({ status: 'failed', finishedAt: new Date(BASE + 37 * M).toISOString(), error: 'Error: stage one failed\n    at x' })
    now += S
    watch.poll(running())
    expect(watch.events.splice(0)).toEqual([{ type: 'ended', status: 'failed' }])
    expect(watch.snapshot.error).toBe('Error: stage one failed\n    at x')
  })

  it('emits nothing for a run that is already over at the first poll', () => {
    planRun()
    status({ status: 'done', finishedAt: new Date(BASE + 33 * M).toISOString() })
    const watch = new RunWatch(dir, { now: () => BASE + 34 * M })
    watch.poll(running())
    watch.poll(running())
    expect(watch.events).toEqual([])
  })

  it('treats a journal backlog larger than one read as backlog', () => {
    status({})
    journal(line(0, 'phase', { title: 'Plan' }))
    for (let i = 0; i < 200; i++) journal(line(S, 'log', { message: 'y'.repeat(100) }))
    journal(line(2 * S, 'phase', { title: 'Plan review' }))
    const watch = new RunWatch(dir, { now: () => BASE + 3 * S, tail: { maxReadBytes: 4096 } })
    for (let i = 0; i < 20; i++) watch.poll(running())
    expect(watch.snapshot.phase).toBe('Plan review')
    expect(watch.events).toEqual([])
  })

  it('treats a journal that appears or is replaced later as backlog', () => {
    status({})
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now, roles: [{ id: 'ses_p', meta: meta() }] })
    watch.poll(running())
    now += S
    watch.poll(running())
    planRun()
    journal(line(32 * M, 'agent-end', { label: 'old', session: 'ses_old', outcome: 'failed' }))
    now += S
    watch.poll(running())
    expect(watch.snapshot.readable).toBe(true)
    expect(watch.events).toEqual([])

    writeFileSync(join(dir, 'journal.jsonl'), line(0, 'phase', { title: 'Plan' }) + line(S, 'agent-end', { label: 'again', session: 'ses_again', outcome: 'failed' }))
    now += S
    watch.poll(running())
    expect(watch.snapshot.phase).toBe('Plan')
    expect(watch.events).toEqual([])
    journal(line(2 * S, 'phase', { title: 'Plan review' }))
    now += S
    watch.poll(running())
    expect(watch.events).toEqual([{ type: 'phase', title: 'Plan review' }])
  })

  it('caps the cached journal entries', () => {
    status({})
    journal(line(0, 'phase', { title: 'Plan' }))
    let block = ''
    for (let i = 0; i < 5100; i++) block += line(S, 'log', { message: `m${i}` })
    journal(block)
    const watch = new RunWatch(dir, { now: () => BASE + 3 * S })
    watch.poll(running())
    expect(watch.entryCount).toBe(5000)
  })

  it('falls back to the role sessions when the run files cannot be read', () => {
    const roles: RoleSession[] = [
      { id: 'ses_p', meta: meta() },
      { id: 'ses_i', meta: meta({ label: 'implement one', role: 'implementer', phase: 'Implement', model: null }) },
    ]
    const watch = new RunWatch(join(tmp, 'missing'), { now: () => BASE, roles })
    watch.poll(running('ses_i'))
    const s = watch.snapshot
    expect(s.readable).toBe(false)
    expect(s.id).toBe(RUN)
    expect(s.parent).toBe('parent')
    expect(s.phase).toBe('Implement')
    expect(s.tree.phases.map(p => p.title)).toEqual(['Plan', 'Implement'])
    expect(s.tree.agents.map(a => [a.label, a.state, a.model])).toEqual([
      ['plan', 'waiting', 'opencode/kimi-k3.1-pro'],
      ['implement one', 'running', undefined],
    ])
  })

  it('treats a status.json without a journal as not readable and keeps its status', () => {
    status({ watch: 'panel' })
    const watch = new RunWatch(dir, { now: () => BASE, roles: [{ id: 'ses_p', meta: meta() }] })
    watch.poll(running('ses_p'))
    expect(watch.snapshot).toMatchObject({ readable: false, watch: 'panel', status: 'running', start: BASE })
    expect(watch.snapshot.tree.agents.map(a => a.label)).toEqual(['plan'])
  })

  it('keeps the last status when status.json is half written', () => {
    planRun()
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running())
    writeFileSync(join(dir, 'status.json'), '{"id": "x", "sta')
    watch.poll(running())
    expect(watch.snapshot).toMatchObject({ status: 'running', readable: true, parent: 'parent' })
  })

  it('reports watch off from status.json', () => {
    planRun()
    status({ watch: 'off' })
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running('ses_r'))
    expect(watch.snapshot.watch).toBe('off')
    expect(sidebarLines(watch.snapshot, BASE + 33 * M, 42)).toEqual([])
    expect(chipText(watch.snapshot, BASE + 33 * M)).toBe('')
  })

  it('takes watch full when status.json does not say', () => {
    planRun()
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: RUN, status: 'running', startedAt: new Date(BASE).toISOString() }))
    const watch = new RunWatch(dir, { now: () => BASE + 33 * M })
    watch.poll(running())
    expect(watch.snapshot.watch).toBe('full')
  })
})

const KIMI = { providerID: 'kimi-code-plan-global', id: 'k3.1-pro', variant: 'default' }
const stageOf = (number: number, name: string) => ({ number, name, implement: true, review: true, checks: false })
const OUTLINE = { kind: 'implement', branch: 'feat/x', worktree: true, planReview: false, finalReview: true, reviewers: ['a'], fromStage: 1, stages: [stageOf(1, 'one'), stageOf(2, 'two')] }

function stagedRun(outline: unknown = OUTLINE) {
  status({ outline })
  journal(
    line(0, 'phase', { title: 'Worktree' }),
    line(1 * S, 'stage', { number: 1, name: 'one', event: 'start' }),
    line(2 * S, 'phase', { title: 'Implement' }),
    line(2 * S, 'agent', { label: 'implement one', role: 'implementer', session: 'ses_i', model: KIMI, phase: 'Implement', cwd: '/w/feat-x', linked: true }),
  )
  const watch = new RunWatch(dir, { now: () => BASE + 100 * S })
  watch.poll(running('ses_i'))
  return watch.snapshot
}

describe('the run outline', () => {
  it('reads the outline from status.json into the snapshot and the tree', () => {
    const s = stagedRun()
    expect(s.outline).toEqual(OUTLINE as any)
    expect(s.tree.outline).toEqual(OUTLINE as any)
    expect(s.tree.branch).toBe('feat/x')
    expect(s.tree.groups.map(g => [g.key, g.state])).toEqual([
      ['stage:1', 'running'],
      ['stage:2', 'upcoming'],
      ['final-review', 'upcoming'],
      ['pr-ready', 'upcoming'],
    ])
    expect(s.tree.agents[0]).toMatchObject({ action: 'implement', group: 'stage:1', cwd: '/w/feat-x' })
  })

  it('leaves a malformed outline out and still builds the view', () => {
    const s = stagedRun({ ...OUTLINE, stages: 'one' })
    expect(s.outline).toBeUndefined()
    expect(s.tree.outline).toBeUndefined()
    expect(s.tree.agents.map(a => a.action)).toEqual(['implement'])
    expect(sidebarLines(s, BASE + 100 * S, 42).map(l => l.text)).toEqual(['granny 523r · running', 'Implement · 1m38s', '● implement  k3.1-pro · running 1m38s'])
  })

  it('names the stage of how many in the sidebar and the chip, with the short model and the action', () => {
    const s = stagedRun()
    const now = BASE + 100 * S
    expect(sidebarLines(s, now, 42).map(l => [l.text, l.tone])).toEqual([
      ['granny 523r · running', 'base'],
      ['stage 1/2 · Implement · 1m38s', 'muted'],
      ['● implement  k3.1-pro · running 1m38s', 'info'],
    ])
    expect(sidebarLines(s, now, 30).map(l => l.text)).toEqual(['granny 523r · running', 'stage 1/2 · Implement · 1m38s', '● implement · running 1m38s'])
    for (const l of sidebarLines(s, now, 30)) expect(l.text.length).toBeLessThanOrEqual(30)
    expect(chipText(s, now)).toBe('granny · stage 1/2 · Implement · 1 running · 1m40s')
    const text = JSON.stringify(sidebarLines(s, now, 60))
    expect(text).not.toContain('kimi-code-plan-global')
    expect(text).not.toContain('#default')
  })

  it('names every running stage of a parallel run, and no stage outside the stages', () => {
    status({ outline: { ...OUTLINE, stages: [stageOf(1, 'one'), stageOf(2, 'two'), stageOf(3, 'three')] } })
    journal(
      line(0, 'stage', { number: 1, name: 'one', event: 'start' }),
      line(0, 'stage', { number: 2, name: 'two', event: 'start' }),
      line(0, 'phase', { title: 'Implement' }),
      line(1 * S, 'agent', { label: 'implement one', role: 'implementer', session: 'a', model: KIMI, phase: 'Implement' }),
      line(1 * S, 'agent', { label: 'implement two', role: 'implementer', session: 'b', model: KIMI, phase: 'Implement' }),
    )
    const watch = new RunWatch(dir, { now: () => BASE + 60 * S })
    watch.poll(running('a', 'b'))
    expect(sidebarLines(watch.snapshot, BASE + 60 * S, 42)[1]!.text).toBe('stages 1+2/3 · Implement · 1m00s')
    expect(chipText(watch.snapshot, BASE + 60 * S)).toBe('granny · stages 1+2/3 · Implement · 2 running · 1m00s')
    journal(
      line(70 * S, 'stage', { number: 1, name: 'one', event: 'end', outcome: 'clean' }),
      line(70 * S, 'stage', { number: 2, name: 'two', event: 'end', outcome: 'clean' }),
      line(71 * S, 'phase', { title: 'Final review' }),
    )
    watch.poll(running())
    expect(sidebarLines(watch.snapshot, BASE + 80 * S, 42)[1]!.text).toBe('Final review · 9s')
    expect(chipText(watch.snapshot, BASE + 80 * S)).toBe('granny · Final review · 0 running · 1m20s')
  })
})

describe('a running run nothing writes to any more', () => {
  it('turns stale after 10 minutes without a change to status.json or the journal and without a running role session', () => {
    planRun()
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running())
    expect(watch.snapshot.stale).toBeUndefined()
    now += 10 * M - S
    watch.poll(running())
    expect(watch.snapshot.stale).toBeUndefined()
    now += S
    expect(watch.poll(running('ses_r'))).toBe(true)
    expect(watch.snapshot.stale).toBeUndefined()
    expect(watch.poll(running())).toBe(true)
    expect(watch.snapshot.stale).toBe(true)
    expect(watch.touched()).toBe(false)
    journal(line(44 * M, 'log', { message: 'alive' }))
    expect(watch.touched()).toBe(true)
    watch.poll(running())
    expect(watch.snapshot.stale).toBeUndefined()
  })

  it('never calls a run stale while a long command writes a heartbeat every minute, and redraws nothing for one', () => {
    planRun()
    journal(line(33 * M, 'command', { command: 'bun test' }))
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running())
    const entries = watch.entryCount
    for (let minute = 1; minute <= 15; minute++) {
      now = BASE + (33 + minute) * M
      journal(line(33 * M + minute * M, 'heartbeat', { command: 'bun test' }))
      watch.poll(running())
      expect(watch.snapshot.stale).toBeUndefined()
    }
    expect(watch.entryCount).toBe(entries)
    journal(line(49 * M, 'heartbeat', { command: 'bun test' }))
    expect(watch.poll(running())).toBe(false)
  })

  it('never calls a finished run stale', () => {
    planRun()
    status({ status: 'done', finishedAt: new Date(BASE + 33 * M).toISOString() })
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running())
    now += 60 * M
    watch.poll(running())
    expect(watch.snapshot.stale).toBeUndefined()
  })

  it('shows stale? in the sidebar header and the chip', () => {
    planRun()
    let now = BASE + 33 * M
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running())
    now += 10 * M
    watch.poll(running())
    expect(sidebarLines(watch.snapshot, now, 42)[0]).toEqual({ text: 'granny 523r · stale?', tone: 'warning', key: `run:${RUN}` })
    expect(chipText(watch.snapshot, now)).toBe('granny · Plan review · stale?')
  })
})

describe('sidebarLines / chipText / toastFor', () => {
  const now = BASE + 33 * M
  const snap = () => {
    planRun()
    const watch = new RunWatch(dir, { now: () => now })
    watch.poll(running('ses_r'))
    return watch.snapshot
  }

  it('lists the run, its phase and its current agents by action at width 42', () => {
    const lines = sidebarLines(snap(), now, 42)
    expect(lines.map(l => [l.text, l.tone])).toEqual([
      ['granny 523r · running', 'base'],
      ['Plan review · 2m00s', 'muted'],
      ['✓ review r2 codex  gpt-5.5 · done 58s', 'success'],
      ['● review r2 terra · running 1m59s', 'info'],
    ])
    expect(lines.every(l => l.text.length <= 42)).toBe(true)
    expect(lines.map(l => l.key)).toEqual([`run:${RUN}`, `phase:${RUN}:1`, 'agent:ses_c', 'agent:ses_r'])
  })

  it('fits every line to width 30', () => {
    const lines = sidebarLines(snap(), now, 30)
    expect(lines.map(l => l.text)).toEqual(['granny 523r · running', 'Plan review · 2m00s', '✓ review r2 codex · done 58s', '● review r2 t… · running 1m59s'])
    expect(lines.every(l => l.text.length <= 30)).toBe(true)
  })

  it('shows the model when it fits', () => {
    status({})
    journal(line(0, 'phase', { title: 'Implement' }), line(S, 'agent', { label: 'implement one', role: 'implementer', session: 'ses_i', model: kimi, phase: 'Implement' }))
    const watch = new RunWatch(dir, { now: () => BASE + 61 * S })
    watch.poll(running('ses_i'))
    expect(sidebarLines(watch.snapshot, BASE + 61 * S, 60).at(-1)!.text).toBe('● implement  kimi-k3.1-pro · running 1m00s')
  })

  it('lists at most 8 agents, newest first, and counts the rest', () => {
    status({})
    const lines = [line(0, 'phase', { title: 'Review' })]
    for (let i = 0; i < 11; i++) lines.push(line(i * S, 'agent', { label: `review one r1 a${i}`, role: 'reviewer', session: `s${i}`, model: null, phase: 'Review' }))
    journal(...lines)
    const watch = new RunWatch(dir, { now: () => BASE + 20 * S })
    watch.poll(running())
    const out = sidebarLines(watch.snapshot, BASE + 20 * S, 60)
    expect(out.slice(2, 4).map(l => l.text)).toEqual(['… review one r1 a10  default model · waiting 10s', '… review one r1 a9  default model · waiting 11s'])
    expect(out).toHaveLength(2 + 8 + 1)
    expect(out.at(-1)).toEqual({ text: '+3 more', tone: 'muted' })
  })

  it('says when the run files are not readable', () => {
    const watch = new RunWatch(join(tmp, 'missing'), { now: () => BASE, roles: [{ id: 'ses_p', meta: meta() }] })
    watch.poll(running('ses_p'))
    expect(sidebarLines(watch.snapshot, BASE, 42).map(l => l.text)).toEqual(['granny 523r · running', 'run files not readable', 'Plan · 0s', '● plan  kimi-k3.1-pro · running 0s'])
  })

  it('shows a finished run on one line for 60 seconds, then nothing', () => {
    planRun()
    status({ status: 'done', finishedAt: new Date(BASE + 34 * M).toISOString() })
    const watch = new RunWatch(dir, { now: () => BASE + 34 * M })
    watch.poll(running())
    const s = watch.snapshot
    expect(sidebarLines(s, BASE + 34 * M + 59 * S, 42)).toEqual([{ text: 'granny 523r · done · 34m00s', tone: 'success', key: `run:${RUN}` }])
    expect(chipText(s, BASE + 34 * M + 59 * S)).toBe('granny · done')
    expect(sidebarLines(s, BASE + 35 * M, 42)).toEqual([])
    expect(chipText(s, BASE + 35 * M)).toBe('')
  })

  it('writes the chip from the phase and running roles', () => {
    expect(chipText(snap(), now)).toBe('granny · Plan review · 1 running · 33m00s')
  })

  it('turns events into toasts addressed to the parent session in full mode only', () => {
    const s = snap()
    expect(toastFor({ type: 'phase', title: 'Review' }, s)).toEqual({ title: 'granny 523r', message: 'Review', variant: 'info', sessionID: 'parent' })
    expect(toastFor({ type: 'failed', label: 'judge one r1', error: 'no answer\nmore' }, s)).toEqual({ title: 'granny 523r', message: 'judge one r1 failed: no answer', variant: 'error', sessionID: 'parent' })
    expect(toastFor({ type: 'failed', label: 'judge one r1' }, s)?.message).toBe('judge one r1 failed')
    const done = { ...s, status: 'done', end: BASE + 34 * M }
    expect(toastFor({ type: 'ended', status: 'done' }, done)).toEqual({ title: 'granny 523r', message: `run ${RUN} done · 34m00s`, variant: 'success', sessionID: 'parent' })
    const failed = { ...s, status: 'failed', end: BASE + 34 * M, error: 'Error: stage one failed\n    at x' }
    expect(toastFor({ type: 'ended', status: 'failed' }, failed)).toEqual({ title: 'granny 523r', message: `run ${RUN} failed: Error: stage one failed`, variant: 'error', sessionID: 'parent' })
    expect(toastFor({ type: 'ended', status: 'cancelled' }, { ...s, status: 'cancelled', end: BASE + 34 * M })?.variant).toBe('warning')
    expect(toastFor({ type: 'phase', title: 'Review' }, { ...s, watch: 'panel' })).toBeUndefined()
    expect(toastFor({ type: 'phase', title: 'Review' }, { ...s, watch: 'off' })).toBeUndefined()
  })
})
