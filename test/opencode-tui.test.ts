import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsLike, RoleMeta } from '../src/adapters/opencode/runwatch'
import { createTuiPlugin } from '../src/adapters/opencode/tui-plugin'
import { fakeCtx, type FakeCtxOptions, type FakeSession, fakeRuntime, fakeTimers, render, texts } from './fake-opentui'

const BASE = Date.parse('2026-11-05T18:23:28.000Z')
const S = 1000
const M = 60 * S
const RUN = '20261105-182328-523r'
const kimi = { providerID: 'opencode', id: 'kimi-k3.1-pro' }

let tmp: string
let dir: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'granny-tui-'))
  dir = join(tmp, RUN)
  mkdirSync(dir)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const line = (ms: number, type: string, data: Record<string, unknown> = {}) => `${JSON.stringify({ t: new Date(BASE + ms).toISOString(), type, ...data })}\n`
const journal = (...lines: string[]) => appendFileSync(join(dir, 'journal.jsonl'), lines.join(''))
const status = (data: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: RUN, status: 'running', repo: '/repo', branch: 'feat/x', parent: 'parent', watch: 'full', startedAt: new Date(BASE).toISOString(), ...data }, null, 2))

const meta = (over: Partial<RoleMeta> = {}): RoleMeta => ({ run: RUN, dir, parent: 'parent', label: 'plan', role: 'planner', phase: 'Plan', model: 'opencode/kimi-k3.1-pro', ...over })
const role = (id: string, over: Partial<RoleMeta> = {}, parentID: string | undefined = 'parent'): FakeSession => ({
  id,
  ...(parentID ? { parentID } : {}),
  title: `granny · ${over.label ?? 'plan'}`,
  metadata: { 'granny-workflow': meta(over) },
})

const reviewMeta = { label: 'review plan review r2 terra', role: 'reviewer', phase: 'Plan review' }
const codexMeta = { label: 'review plan review r2 codex', role: 'reviewer', phase: 'Plan review', model: 'openai/gpt-5.5' }

function planRun(extra: Record<string, unknown> = {}) {
  status(extra)
  journal(
    line(0, 'phase', { title: 'Plan' }),
    line(1 * S, 'agent', { label: 'plan', role: 'planner', session: 'ses_plan', model: kimi, phase: 'Plan', linked: true }),
    line(31 * M, 'agent-end', { label: 'plan', session: 'ses_plan', outcome: 'done' }),
    line(31 * M, 'phase', { title: 'Plan review' }),
    line(31 * M + 1 * S, 'agent', { label: reviewMeta.label, role: 'reviewer', session: 'ses_r', model: kimi, phase: 'Plan review', linked: true }),
    line(31 * M + 2 * S, 'agent', { label: codexMeta.label, role: 'reviewer', session: 'ses_c', model: { providerID: 'openai', id: 'gpt-5.5' }, phase: 'Plan review', linked: true }),
  )
}

const familySessions = (): FakeSession[] => [{ id: 'parent', title: 'main' }, role('ses_plan'), role('ses_r', reviewMeta), role('ses_c', codexMeta)]

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

function mount(options: FakeCtxOptions = {}, runtime = fakeRuntime()) {
  let now = BASE + 33 * M
  const timers = fakeTimers()
  const { fs, counts } = countingFs()
  const fc = fakeCtx({ sessions: familySessions(), running: ['ses_r'], ...options })
  const plugin = createTuiPlugin(runtime.rt, { now: () => now, tickMs: 10, fs, timers })
  const cleanup = plugin.setup(fc.ctx)
  return {
    plugin,
    fc,
    fr: runtime,
    timers,
    counts,
    cleanup,
    get now() {
      return now
    },
    set now(t: number) {
      now = t
    },
    sidebar: (sessionID = 'parent') => fc.slot('append', 'sidebar.content')!.render({ sessionID }),
    chip: (sessionID = 'parent') => fc.slot('append', 'prompt.footer.status')!.render({ sessionID }),
    app: () => fc.slot('append', 'app')!.render({}),
  }
}

describe('opencode TUI plugin: setup', () => {
  it('claims the sidebar, the prompt footer and the app slot and registers /granny', () => {
    const m = mount()
    expect(m.plugin.id).toBe('granny-workflow')
    expect(typeof m.cleanup).toBe('function')
    expect(m.fc.slot('append', 'sidebar.content')).toBeDefined()
    expect(m.fc.slot('append', 'prompt.footer.status')).toBeDefined()
    expect(m.fc.slot('append', 'app')).toBeDefined()
    expect(m.app()).toBeNull()
    const command = m.fc.command('granny.open')
    expect(command).toMatchObject({
      title: 'granny: run navigator',
      group: 'granny',
      palette: true,
      slash: { name: 'granny', arguments: true },
      bind: '<leader>j',
    })
    expect(m.fc.layers[0]!.mode).toBe('global')
  })

  it('registers the command without its key when the key is refused', () => {
    const m = mount({ refuseBind: '<leader>j' })
    m.app()
    const command = m.fc.command('granny.open')
    expect(command).toBeDefined()
    expect(command.bind).toBeUndefined()
    expect(command.slash).toEqual({ name: 'granny', arguments: true })
  })

  it('never throws out of setup when the ctx is broken', () => {
    const { rt } = fakeRuntime()
    const plugin = createTuiPlugin(rt, { timers: fakeTimers() })
    expect(() => plugin.setup({})).not.toThrow()
    expect(() => plugin.setup(null)).not.toThrow()
  })

  it('stops its timer on cleanup', () => {
    planRun()
    const m = mount()
    expect(m.timers.intervals).toBe(1)
    m.cleanup()
    expect(m.timers.intervals).toBe(0)
  })
})

describe('opencode TUI plugin: sidebar, chip and toasts', () => {
  it('shows the run of the session in the sidebar and the chip, and toasts what changes', () => {
    planRun()
    const m = mount()
    const sidebar = m.sidebar()
    const chip = m.chip()
    expect(texts(sidebar)).toEqual([])
    expect(texts(chip)).toEqual([])
    m.timers.tick()

    const lines = render(sidebar)
    expect(lines.map(l => l.text)).toEqual([
      'granny 523r · running',
      'Plan review · 2m00s',
      '… review plan review r2… · waiting 1m58s',
      '● review plan review r2… · running 1m59s',
    ])
    expect(lines.every(l => l.text.length <= 40)).toBe(true)
    expect(lines[0]!.fg).toBe('c:base')
    expect(lines[1]!.fg).toBe('c:muted')
    expect(lines[3]!.fg).toBe('c:info')
    expect(texts(chip)).toEqual(['granny · Plan review · 1 running · 33m00s'])
    expect(m.fc.toasts).toEqual([])

    journal(line(33 * M, 'agent-end', { label: reviewMeta.label, session: 'ses_r', outcome: 'failed', error: 'no answer\nmore' }), line(33 * M, 'phase', { title: 'Review' }))
    m.now += S
    m.timers.tick()
    expect(m.fc.toasts).toEqual([
      { title: 'granny 523r', message: 'Review', variant: 'info', sessionID: 'parent' },
      { title: 'granny 523r', message: 'review plan review r2 terra failed: no answer', variant: 'error', sessionID: 'parent' },
    ])
    expect(texts(sidebar)[1]).toBe('Review · 1s')

    status({ status: 'done', finishedAt: new Date(BASE + 34 * M).toISOString() })
    m.now = BASE + 34 * M + S
    m.timers.tick()
    expect(m.fc.toasts.at(-1)).toEqual({ title: 'granny 523r', message: `run ${RUN} done · 34m00s`, variant: 'success', sessionID: 'parent' })
    expect(texts(sidebar)).toEqual(['granny 523r · done · 34m00s'])
    expect(texts(chip)).toEqual(['granny · done'])
    for (let i = 0; i < 5 && m.timers.intervals; i++) m.timers.tick()
    expect(m.timers.intervals).toBe(0)
    m.now = BASE + 36 * M
    m.timers.flush()
    expect(texts(sidebar)).toEqual([])
    expect(texts(chip)).toEqual([])
  })

  it('shows each agent with its marker and model when the line has room', () => {
    status()
    journal(line(0, 'phase', { title: 'Plan' }), line(1 * S, 'agent', { label: 'plan', role: 'planner', session: 'ses_plan', model: kimi, phase: 'Plan', linked: true }))
    const m = mount({ running: ['ses_plan'] })
    m.timers.tick()
    expect(texts(m.sidebar())).toEqual(['granny 523r · running', 'Plan · 33m00s', '● plan  kimi-k3.1-pro · running 32m59s'])
  })

  it('emits no toasts for the backlog present at discovery', () => {
    planRun()
    journal(line(32 * M, 'agent-end', { label: 'old', session: 'ses_old', outcome: 'failed' }), line(32 * M, 'phase', { title: 'Review' }))
    const m = mount()
    m.timers.tick()
    m.timers.tick()
    expect(m.fc.toasts).toEqual([])
  })

  it('summarises more than three events of one tick in one toast', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    journal(
      line(33 * M, 'phase', { title: 'Review' }),
      ...['a', 'b', 'c', 'd'].map(x => line(33 * M, 'agent-end', { label: `judge ${x}`, session: `ses_${x}`, outcome: 'failed' })),
    )
    m.now += S
    m.timers.tick()
    expect(m.fc.toasts.map(t => t.message)).toEqual(['Review', 'judge a failed', '+3 more granny events'])
  })

  it('finds the run from a role session too', () => {
    planRun()
    const m = mount({ route: { type: 'session', sessionID: 'ses_r' } })
    m.timers.tick()
    expect(texts(m.sidebar('ses_r'))[0]).toBe('granny 523r · running')
  })

  it('keeps toasting a known run after you navigate elsewhere', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    m.fc.route = { type: 'session', sessionID: 'elsewhere' }
    journal(line(33 * M, 'phase', { title: 'Review' }))
    m.now += S
    m.timers.tick()
    expect(m.fc.toasts).toEqual([{ title: 'granny 523r', message: 'Review', variant: 'info', sessionID: 'parent' }])
  })

  it('folds the sidebar section to its header from the stored view state', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    const sidebar = m.sidebar()
    expect(texts(sidebar).length).toBe(4)
    ;(sidebar as any).props.onMouseDown()
    expect(m.fc.stores.get('view')).toEqual({ open: false })
    expect(texts(sidebar)).toEqual(['granny 523r · running'])
  })

  it('shows the sidebar and chip but no toasts with watch panel, and /granny says watching is off', () => {
    planRun({ watch: 'panel' })
    const m = mount()
    m.app()
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
    expect(texts(m.chip())[0]).toContain('granny · Plan review')
    journal(line(33 * M, 'phase', { title: 'Review' }))
    m.now += S
    m.timers.tick()
    expect(m.fc.toasts).toEqual([])
    m.fc.command('granny.open').run('')
    expect(m.fc.navigations).toEqual([])
    expect(m.fc.toasts).toEqual([
      { message: `granny: watching is off for run ${RUN} (watch: "panel") - set "watch": "full" in granny.config.json for the navigator.`, variant: 'info' },
    ])
  })

  it('shows nothing with watch off', () => {
    planRun({ watch: 'off' })
    const m = mount()
    m.timers.tick()
    journal(line(33 * M, 'phase', { title: 'Review' }))
    m.now += S
    m.timers.tick()
    expect(texts(m.sidebar())).toEqual([])
    expect(texts(m.chip())).toEqual([])
    expect(m.fc.toasts).toEqual([])
  })

  it('renders nothing without a run, and /granny says there is none', () => {
    const m = mount({ sessions: [{ id: 'parent' }], running: [] })
    m.app()
    m.timers.tick()
    expect(texts(m.sidebar())).toEqual([])
    expect(texts(m.chip())).toEqual([])
    m.fc.command('granny.open').run('')
    expect(m.fc.navigations).toEqual([])
    expect(m.fc.toasts).toEqual([
      { message: 'granny: no granny run in this session yet - role sessions appear once the run starts its first agent.', variant: 'warning' },
    ])
  })

  it('finds unlinked role sessions through the session list', async () => {
    planRun()
    const m = mount({ sessions: [{ id: 'parent' }], listed: [role('ses_plan', {}, undefined), role('ses_x', { parent: 'other' }, undefined)] })
    m.timers.tick()
    expect(m.fc.listCalls).toEqual([{ parentID: null, order: 'desc', limit: 50 }])
    await Bun.sleep(0)
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
    m.timers.tick()
    expect(m.fc.listCalls.length).toBe(1)
  })

  it('wakes its timer when a session is created', () => {
    const m = mount({ sessions: [{ id: 'parent' }], running: [] })
    m.timers.tick()
    for (let i = 0; i < 5 && m.timers.intervals; i++) m.timers.tick()
    expect(m.timers.intervals).toBe(0)
    planRun()
    for (const s of familySessions()) m.fc.sessions.set(s.id, s)
    m.fc.emit('session.created', { sessionID: 'ses_plan' })
    expect(m.timers.intervals).toBe(1)
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
  })

  it('survives a throwing family lookup and a throwing toast', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    const sidebar = m.sidebar()
    const before = texts(sidebar)
    m.fc.opts.throwFamily = true
    m.fc.opts.throwToast = true
    journal(line(33 * M, 'phase', { title: 'Review' }))
    m.now += S
    expect(() => m.timers.tick()).not.toThrow()
    expect(texts(sidebar)[0]).toBe(before[0]!)
    expect(texts(sidebar)[1]).toBe('Review · 1s')
  })

  it('changes its version once for many journal appends between two ticks', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    const version = m.fr.signal('granny.version')!
    const sets = version.sets
    for (let i = 0; i < 50; i++) journal(line(33 * M, 'log', { message: `m${i}` }))
    m.timers.tick()
    expect(version.sets).toBe(sets + 1)
  })

  it('toggles the sidebar and chip for this TUI with /granny off and on', () => {
    planRun()
    const m = mount()
    m.app()
    m.timers.tick()
    m.fc.command('granny.open').run('off')
    expect(texts(m.sidebar())).toEqual([])
    expect(texts(m.chip())).toEqual([])
    m.fc.command('granny.open').run('on')
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
  })

  it('opens the navigator route on the run of this session', () => {
    planRun()
    const m = mount()
    m.app()
    m.timers.tick()
    m.fc.command('granny.open').run('')
    expect(m.fc.navigations).toEqual([{ type: 'plugin', name: 'granny', data: { runId: RUN } }])
  })

  it('opens the navigator on a run named by id', () => {
    planRun()
    const m = mount({ route: { type: 'session', sessionID: 'elsewhere' } })
    m.app()
    m.fc.route = { type: 'session', sessionID: 'parent' }
    m.timers.tick()
    m.fc.route = { type: 'session', sessionID: 'elsewhere' }
    m.fc.command('granny.open').run(RUN)
    expect(m.fc.navigations).toEqual([{ type: 'plugin', name: 'granny', data: { runId: RUN } }])
  })

  it('does not throw when navigation fails', () => {
    planRun()
    const m = mount({ throwNavigate: true })
    m.app()
    m.timers.tick()
    expect(() => m.fc.command('granny.open').run('')).not.toThrow()
  })
})
