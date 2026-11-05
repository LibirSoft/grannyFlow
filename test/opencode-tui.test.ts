import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clock } from '../src/adapters/runview/format'
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
      '… review r2 codex · waiting 1m58s',
      '● review r2 terra · running 1m59s',
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

  const RUN2 = '20261105-185500-77xq'
  function secondRun(startMs: number) {
    const dir2 = join(tmp, RUN2)
    mkdirSync(dir2)
    writeFileSync(
      join(dir2, 'status.json'),
      JSON.stringify({ id: RUN2, status: 'running', repo: '/repo', branch: 'feat/y', parent: 'parent', watch: 'full', startedAt: new Date(BASE + startMs).toISOString() }),
    )
    appendFileSync(
      join(dir2, 'journal.jsonl'),
      line(startMs, 'phase', { title: 'Implement' }) + line(startMs + S, 'agent', { label: 'implement', role: 'implementer', session: 'ses_u', model: kimi, phase: 'Implement', linked: false }),
    )
    return role('ses_u', { run: RUN2, dir: dir2, label: 'implement', role: 'implementer', phase: 'Implement' }, undefined)
  }

  it('finds an unlinked run created next to a running linked run of the same session', async () => {
    planRun()
    const unlinked = secondRun(32 * M)
    const m = mount({ listed: [unlinked] })
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
    expect(m.fc.listCalls).toEqual([])
    m.fc.emit('session.created', { sessionID: 'ses_u' })
    m.timers.tick()
    expect(m.fc.listCalls).toEqual([{ parentID: null, order: 'desc', limit: 50 }])
    await Bun.sleep(0)
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 77xq · running')
    m.timers.tick()
    expect(m.fc.listCalls.length).toBe(1)
  })

  it('looks for unlinked runs once every linked run of the session has ended', async () => {
    planRun({ status: 'done', finishedAt: new Date(BASE + 32 * M).toISOString() })
    const unlinked = secondRun(32 * M + 30 * S)
    const m = mount({ listed: [unlinked], running: [] })
    m.timers.tick()
    m.now += 10 * S
    m.timers.tick()
    expect(m.fc.listCalls.length).toBe(1)
    await Bun.sleep(0)
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 77xq · running')
  })

  it('marks a running run whose files stop changing stale, lets the timer stop, and picks it up again when they change', () => {
    planRun()
    const m = mount({ running: [] })
    const sidebar = m.sidebar()
    const chip = m.chip()
    m.timers.tick()
    expect(texts(sidebar)[0]).toBe('granny 523r · running')
    m.now += 10 * M
    m.timers.tick()
    expect(texts(sidebar)[0]).toBe('granny 523r · stale?')
    expect(texts(chip)).toEqual(['granny · Plan review · stale?'])
    for (let i = 0; i < 5 && m.timers.intervals; i++) m.timers.tick()
    expect(m.timers.intervals).toBe(0)
    journal(line(44 * M, 'phase', { title: 'Review' }))
    m.fc.emit('session.updated', { sessionID: 'ses_r' })
    m.timers.tick()
    expect(texts(sidebar)[0]).toBe('granny 523r · running')
    expect(texts(sidebar)[1]).toStartWith('Review · ')
    expect(m.timers.intervals).toBe(1)
  })

  it('looks at a stale run again every 30 s with nothing else waking the timer, and revives it once its journal grows', () => {
    planRun()
    const m = mount({ running: [] })
    const sidebar = m.sidebar()
    m.timers.tick()
    m.now += 10 * M
    m.timers.tick()
    for (let i = 0; i < 5 && m.timers.intervals; i++) m.timers.tick()
    expect(m.timers.intervals).toBe(0)
    expect(m.timers.delays()).toEqual([30_000])
    m.timers.flush()
    for (let i = 0; i < 5 && m.timers.intervals; i++) m.timers.tick()
    expect(texts(sidebar)[0]).toBe('granny 523r · stale?')
    expect(m.timers.delays()).toEqual([30_000])
    journal(line(44 * M, 'phase', { title: 'Review' }))
    m.timers.flush()
    m.timers.tick()
    expect(texts(sidebar)[0]).toBe('granny 523r · running')
    expect(m.timers.intervals).toBe(1)
    m.cleanup()
    expect(m.timers.timeouts).toBe(0)
  })

  it('keeps a run whose files stopped changing live while one of its role sessions runs', () => {
    planRun()
    const m = mount({ running: ['ses_r'] })
    m.timers.tick()
    m.now += 30 * M
    m.timers.tick()
    expect(texts(m.sidebar())[0]).toBe('granny 523r · running')
    for (let i = 0; i < 5; i++) m.timers.tick()
    expect(m.timers.intervals).toBe(1)
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

describe('opencode TUI plugin: the /granny navigator', () => {
  const HELP = '↑↓ move · Enter open session · Tab next agent · Space fold · v details · p parent · Esc close'

  function view(m: ReturnType<typeof mount>, data: unknown) {
    const node = m.fc.routes.get('granny')!.render({ data })
    return {
      m,
      node,
      lines: () => texts(node),
      text: () => texts(node).join('\n'),
      left: () => texts(node).map(l => l.split(' │ ')[0]!).join('\n'),
      rows: () => render(node),
      key: (bind: string) => m.fc.bound(bind)!.run(),
      selected: () => render(node).find(r => r.parts?.some(p => p.bg !== undefined))?.text ?? '',
    }
  }

  function open(options: FakeCtxOptions = {}, dims = { width: 160, height: 30 }) {
    planRun()
    const fr = fakeRuntime(dims)
    const m = mount(options, fr)
    m.app()
    m.timers.tick()
    m.fc.command('granny.open').run('')
    const target = m.fc.navigations.at(-1) as { data: unknown }
    return view(m, target.data)
  }

  it('registers the granny route', () => {
    const m = mount()
    expect(m.fc.routes.has('granny')).toBe(true)
  })

  it('opens on the running agent with one header, the groups and the agent detail', () => {
    const v = open()
    const lines = v.lines()
    expect(lines[0]!.trimEnd()).toBe('granny · feat/x · Plan review · 33m00s')
    expect(lines[1]!.trimEnd()).toBe('Plan ✓ › Plan review ●')
    expect(lines.at(-1)!.trimEnd()).toBe(HELP)
    expect(v.selected()).toMatch(/^› +● review r2 terra /)
    const text = v.text()
    expect(text).toContain('▸ ✓ Plan')
    expect(text).toContain('▾ ● Plan review')
    expect(text).toContain('… review r2 codex')
    expect(text).toContain('reviewer · kimi-k3.1-pro · 1m59s')
    expect(text).toContain('NOW   … waiting for model 1m59s')
    expect(text).toContain('run details')
    for (const noise of ['ses_', 'linked', RUN, 'Enter open session · p parent session']) expect(text.split('\n').slice(0, -1).join('\n')).not.toContain(noise)
  })

  it('fits every row to the width and splits the panes from 100 columns', () => {
    for (const width of [60, 99, 100, 160]) {
      const v = open({}, { width, height: 24 })
      const lines = v.lines()
      expect(lines.length).toBe(24)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(width)
      expect(lines.some(l => l.includes(' │ '))).toBe(width >= 100)
      expect(v.text()).toContain('reviewer · kimi-k3.1-pro')
      v.m.cleanup()
      rmSync(join(dir, 'journal.jsonl'))
    }
  })

  it('moves with the keys and the detail follows', () => {
    const v = open()
    v.key('down,j')
    expect(v.selected()).toContain('review r2 codex')
    expect(v.text()).toContain('reviewer · gpt-5.5 · ')
    v.key('up,k')
    expect(v.selected()).toContain('review r2 terra')
    v.key('up,k')
    expect(v.selected()).toContain('▾ ● Plan review')
    expect(v.text()).toContain('running · 2m00s')
    v.key('down,j')
    v.key('[')
    expect(v.selected()).toContain('review r2 terra')
    v.key('tab,]')
    expect(v.selected()).toContain('review r2 codex')
    v.key('home')
    expect(v.selected()).toContain('▸ ✓ Plan')
    v.key('end')
    expect(v.selected()).toContain('run details')
    v.key('pageup')
    expect(v.selected()).toContain('▸ ✓ Plan')
    v.key('pagedown')
    expect(v.selected()).toContain('run details')
  })

  it('opens and folds a group with Space and Enter, and the choice holds across ticks', () => {
    const v = open()
    v.key('home')
    v.key('space')
    expect(v.selected()).toContain('▾ ✓ Plan')
    expect(v.left()).toContain('✓ plan')
    v.m.now += S
    v.m.timers.tick()
    expect(v.left()).toContain('✓ plan')
    v.key('return')
    expect(v.selected()).toContain('▸ ✓ Plan')
    expect(v.left()).not.toContain('✓ plan ')
    v.key('down,j')
    expect(v.lines().at(-1)!.trimEnd()).toBe('↑↓ move · Enter fold · Tab next agent · Space fold · p parent · Esc close')
    v.key('return')
    expect(v.selected()).toContain('▸ ● Plan review')
    expect(v.left()).not.toContain('review r2 terra')
    expect(v.text()).toContain('▸ review r2 terra started')
    v.key('space')
    expect(v.left()).toContain('review r2 terra')
  })

  it('opens the role session with Enter, comes back to it, and goes to the parent with p and back with Esc', () => {
    const v = open()
    v.key('return')
    expect(v.m.fc.navigations.at(-1)).toEqual({ type: 'session', sessionID: 'ses_r' })
    v.m.fc.route = { type: 'session', sessionID: 'parent' }
    v.m.fc.command('granny.open').run('')
    expect(v.m.fc.navigations.at(-1)).toEqual({ type: 'plugin', name: 'granny', data: { runId: RUN, select: 'agent:ses_r' } })

    v.m.fc.route = { type: 'session', sessionID: 'ses_c' }
    v.m.fc.command('granny.open').run('')
    const data = (v.m.fc.navigations.at(-1) as any).data
    expect(data).toEqual({ runId: RUN, select: 'agent:ses_c' })
    const node = v.m.fc.routes.get('granny')!.render({ data })
    expect(render(node).find(r => r.parts?.some(p => p.bg !== undefined))?.text).toContain('review r2 codex')

    v.m.fc.bound('p')!.run()
    expect(v.m.fc.navigations.at(-1)).toEqual({ type: 'session', sessionID: 'parent' })
    v.m.fc.bound('escape,q')!.run()
    expect(v.m.fc.navigations.at(-1)).toEqual({ type: 'session', sessionID: 'ses_c' })
  })

  it('goes back to the parent session on Esc when no route was saved', () => {
    planRun()
    const m = mount()
    m.timers.tick()
    m.fc.routes.get('granny')!.render({ data: { runId: RUN } })
    m.fc.bound('escape,q')!.run()
    expect(m.fc.navigations.at(-1)).toEqual({ type: 'session', sessionID: 'parent' })
  })

  it("lists a role session's own child sessions as subagents by title and opens them", () => {
    const sessions = [...familySessions(), { id: 'ses_sub', parentID: 'ses_r', title: 'Analyze pause architecture risks' }]
    const v = open({ sessions, running: ['ses_r', 'ses_sub'] })
    expect(v.text()).toContain('└ ● Analyze pause architecture risks')
    v.key('down,j')
    expect(v.selected()).toContain('Analyze pause architecture risks')
    const text = v.text()
    expect(text).toContain('subagent of review r2 terra')
    expect(text).not.toContain('ses_sub')
    expect(v.lines().at(-1)!.trimEnd()).toBe('↑↓ move · Enter open session · Tab next agent · Space fold · p parent · Esc close')
    v.key('return')
    expect(v.m.fc.navigations.at(-1)).toEqual({ type: 'session', sessionID: 'ses_sub' })
  })

  it('reads the session family once per refresh, however many agents the run has', () => {
    const v = open()
    const perKey = () => {
      const before = v.m.fc.familyCalls.length
      v.key('down,j')
      return v.m.fc.familyCalls.length - before
    }
    const few = perKey()
    const more = ['ses_x', 'ses_y', 'ses_z']
    for (const id of more) v.m.fc.sessions.set(id, role(id, { label: `review plan review r2 ${id}`, role: 'reviewer', phase: 'Plan review' }))
    journal(...more.map((id, i) => line(33 * M + i, 'agent', { label: `review plan review r2 ${id}`, role: 'reviewer', session: id, model: kimi, phase: 'Plan review', linked: true })))
    v.m.timers.tick()
    expect(v.text()).toContain('review r2 ses_z')
    expect(perKey()).toBe(few)
    expect(few).toBeLessThanOrEqual(2)
  })

  it('shows a new agent after a journal append and a tick, and re-renders without reading files', () => {
    const v = open()
    journal(line(33 * M, 'agent', { label: 'review plan review r2 zeta', role: 'reviewer', session: 'ses_z', model: kimi, phase: 'Plan review', linked: true }))
    v.m.timers.tick()
    expect(v.text()).toContain('review r2 zeta')
    const before = { ...v.m.counts }
    const first = v.lines()
    expect(v.lines()).toEqual(first)
    expect(v.m.counts).toEqual(before)
  })

  it('keeps the timer running while mounted and releases it on unmount', () => {
    const v = open()
    status({ status: 'done', finishedAt: new Date(BASE + 34 * M).toISOString() })
    v.m.now = BASE + 34 * M + S
    for (let i = 0; i < 5; i++) v.m.timers.tick()
    expect(v.m.timers.intervals).toBe(1)
    v.m.fr.unmount()
    for (let i = 0; i < 5 && v.m.timers.intervals; i++) v.m.timers.tick()
    expect(v.m.timers.intervals).toBe(0)
  })

  it('shows the run detail with its files and the degraded note when the files are unreadable', () => {
    const v = open()
    v.key('end')
    const text = v.text()
    expect(text).toContain(`run ${RUN}`)
    expect(text).toContain('repo     /repo')
    expect(text).toContain('branch   feat/x')
    expect(text).toContain(`result   ${join(dir, 'result.json')}`)
    expect(text).toContain(`granny_status { runId: "${RUN}" }`)

    const m = mount({ sessions: [{ id: 'parent' }, role('ses_q', { dir: join(tmp, 'missing') })], running: ['ses_q'] })
    m.timers.tick()
    const node = m.fc.routes.get('granny')!.render({ data: { runId: RUN } })
    expect(texts(node).join('\n')).toContain('run files not readable from this TUI - showing the role sessions only')
  })

  it('does not throw when navigating from a key fails', () => {
    const v = open({ throwNavigate: false })
    v.m.fc.opts.throwNavigate = true
    expect(() => v.key('return')).not.toThrow()
    expect(() => v.key('p')).not.toThrow()
    expect(() => v.key('escape,q')).not.toThrow()
  })

  describe('a staged run with live activity', () => {
    const S1 = 'Server pause domain, lifecycle, and real-socket proof'
    const S2 = 'Client pause UI and e2e'
    const WT = '/w/asena-peer-pong-worktrees/feat-pause'
    const K3 = { providerID: 'kimi-code-plan-global', id: 'k3.1-pro', variant: 'default' }
    const stageOf = (number: number, name: string) => ({ number, name, implement: true, review: true, checks: true })
    const outline = { kind: 'implement', branch: 'feat/pause', worktree: true, planReview: false, finalReview: true, reviewers: ['a'], fromStage: 1, stages: [stageOf(1, S1), stageOf(2, S2)] }
    const at = (s: number) => BASE + s * S
    const NOW = BASE + 100 * S
    const tool = (id: string, name: string, input: unknown, state: string, time: Record<string, number>) => ({ type: 'tool', id, name, state: { status: state, input }, time })
    const msg = (id: string, created: number, content: unknown[], completed?: number) => ({ id, type: 'assistant', time: { created, ...(completed !== undefined ? { completed } : {}) }, content })
    const implMessages = () => [
      msg('m1', at(5), [tool('t1', 'read', { path: `${WT}/src/services/GameService.ts` }, 'completed', { created: at(6), completed: at(7) })], at(8)),
      msg('m2', at(20), [tool('t2', 'edit', { path: `${WT}/src/game/protocol.ts`, oldString: 'a', newString: 'b' }, 'completed', { created: at(21), completed: at(22) })], at(23)),
      msg('m3', at(40), [{ type: 'text', text: 'Added pause/resume messages to the protocol.\nmore' }], at(41)),
      msg('m4', at(80), [tool('t3', 'shell', { command: `cd ${WT} && bun test test/GameService.test.ts`, workdir: WT }, 'running', { created: at(87), ran: at(88) })]),
    ]
    const implRole = () => role('ses_impl', { label: `implement ${S1}`, role: 'implementer', phase: 'Implement', model: 'kimi-code-plan-global/k3.1-pro' })

    function staged(options: FakeCtxOptions = {}, dims = { width: 160, height: 30 }, extra: string[] = []) {
      status({ branch: 'feat/pause', outline })
      journal(
        line(0, 'phase', { title: 'Worktree' }),
        line(0, 'stage', { number: 1, name: S1, event: 'start' }),
        line(0, 'phase', { title: 'Implement' }),
        line(0, 'agent', { label: `implement ${S1}`, role: 'implementer', session: 'ses_impl', model: K3, phase: 'Implement', cwd: WT, linked: true }),
        ...extra,
      )
      const fr = fakeRuntime(dims)
      const m = mount({ sessions: [{ id: 'parent', title: 'main' }, implRole()], running: ['ses_impl'], messages: { ses_impl: implMessages() }, ...options }, fr)
      m.now = NOW
      m.app()
      m.timers.tick()
      m.fc.command('granny.open').run('')
      const v = view(m, (m.fc.navigations.at(-1) as { data: unknown }).data)
      m.timers.tick()
      return v
    }

    it('draws the header, the stepper, the stage groups and the agent summary from the store', () => {
      const v = staged()
      const lines = v.lines().map(l => l.trimEnd())
      expect(lines[0]).toBe('granny · feat/pause · stage 1/2 · Implement · 1m40s')
      expect(lines[1]).toBe('Worktree ✓ › Implement ● › Checks › Review › Final review › PR ready')
      expect(lines[2]).toMatch(/^─+┬─+$/)
      const left = v.lines().slice(3, -2).map(l => l.split(' │ ')[0]!.trimEnd())
      expect(left.slice(0, 5)).toEqual([
        '  ▾ ● 1 Server pause domain, lifecycle, and real-soc…  1m40s',
        '›   ● implement                                        1m40s',
        '      2 Client pause UI and e2e',
        '      Final review',
        '      PR ready',
      ])
      const right = v.lines().slice(3, -2).map(l => l.split(' │ ')[1]!.trimEnd())
      expect(right.slice(0, 11)).toEqual([
        'implementer · k3.1-pro · 1m40s',
        '',
        'NOW   ● shell · 12s',
        '      bun test test/GameService.test.ts',
        '',
        'RECENT',
        ` ${clock(at(21))}  edit   src/game/protocol.ts`,
        ` ${clock(at(6))}  read   src/services/GameService.ts`,
        '',
        'LAST SAID  "Added pause/resume messages to the protocol. more"',
        '',
      ])
      expect(lines.at(-2)).toMatch(/^─+┴─+$/)
      expect(lines.at(-1)).toBe(HELP)
      const text = v.text()
      for (const noise of ['ses_', 'linked', 'kimi-code-plan-global', '#default', RUN]) expect(text).not.toContain(noise)
    })

    it('fits every row to the width at 60, 99, 100 and 160 columns', () => {
      for (const width of [60, 99, 100, 160]) {
        const v = staged({}, { width, height: 30 })
        const lines = v.lines()
        expect(lines).toHaveLength(30)
        for (const l of lines) expect(l.length).toBe(width)
        expect(v.text()).toContain('implementer · k3.1-pro · 1m40s')
        v.m.cleanup()
        rmSync(join(dir, 'journal.jsonl'))
      }
    })

    it('shows a new tool call once it reaches the store and the hub ticks', () => {
      const v = staged()
      const last = v.m.fc.messages.get('ses_impl')!.at(-1) as any
      last.content.push(tool('t4', 'read', { path: `${WT}/src/x.ts` }, 'running', { created: at(99), ran: at(99) }))
      expect(v.text()).not.toContain('src/x.ts')
      v.m.timers.tick()
      const text = v.text()
      expect(text).toContain('NOW   ● read · 1s')
      expect(text).toContain('      src/x.ts')
      expect(text).toContain(`${clock(at(87))}  shell  bun test test/GameService.test.ts`)
    })

    it('changes its version only when the store changed, once for many streamed deltas', () => {
      const v = staged()
      const version = v.m.fr.signal('granny.version')!
      const sets = version.sets
      v.m.timers.tick()
      expect(version.sets).toBe(sets)
      const last = v.m.fc.messages.get('ses_impl')!.at(-1) as any
      last.content.push({ type: 'reasoning', text: '', time: { created: at(99) } })
      for (let i = 0; i < 50; i++) last.content.at(-1).text += 'x'
      v.m.timers.tick()
      expect(version.sets).toBe(sets + 1)
      expect(v.text()).toContain('NOW   ● thinking 1s')
    })

    it('reads only the selected agent, and syncs a session the store has nothing for once', () => {
      const v = staged({ messages: {} })
      expect(v.m.fc.syncCalls).toEqual(['ses_impl'])
      v.m.timers.tick()
      v.m.timers.tick()
      expect(v.m.fc.syncCalls).toEqual(['ses_impl'])
      expect(new Set(v.m.fc.messageReads)).toEqual(new Set(['ses_impl']))
      v.m.fc.messages.set('ses_impl', implMessages())
      v.m.timers.tick()
      expect(v.text()).toContain('NOW   ● shell · 12s')
    })

    it('fetches the selected session through the client every 3 seconds when the TUI has no message store', async () => {
      const v = staged({ noMessageStore: true })
      expect(v.m.fc.fetchCalls).toEqual([{ sessionID: 'ses_impl', limit: 20, order: 'desc' }])
      await Bun.sleep(0)
      expect(v.text()).toContain('NOW   ● shell · 12s')
      expect(v.text()).toContain('read   src/services/GameService.ts')
      v.m.timers.tick()
      v.m.now += 2 * S
      v.m.timers.tick()
      expect(v.m.fc.fetchCalls).toHaveLength(1)
      v.m.now += S
      v.m.timers.tick()
      expect(v.m.fc.fetchCalls).toHaveLength(2)
      expect(v.m.fc.fetchCalls.every(c => c.sessionID === 'ses_impl')).toBe(true)
    })

    it('shows the head and the journal notes when every message read throws', async () => {
      for (const options of [{ throwMessages: true }, { throwMessages: true, noMessageStore: true }]) {
        const v = staged(options, undefined, [line(30 * S, 'retry', { label: `implement ${S1}`, attempt: 1, reason: 'rate limited\nmore' })])
        await Bun.sleep(0)
        expect(() => v.m.timers.tick()).not.toThrow()
        const text = v.text()
        expect(text).toContain('implementer · k3.1-pro · 1m40s')
        expect(text).toContain('↻ retry 1: rate limited')
        v.m.cleanup()
        rmSync(join(dir, 'journal.jsonl'))
      }
    })

    it('reads the newly selected agent on the next tick, and shows a finished one without a running NOW', () => {
      const ended = [
        line(50 * S, 'agent', { label: `review ${S1} r1 a`, role: 'reviewer', session: 'ses_rev', model: K3, phase: 'Review', cwd: WT, linked: false }),
        line(70 * S, 'agent-end', { label: `review ${S1} r1 a`, session: 'ses_rev', outcome: 'done' }),
      ]
      const review = [msg('r1', at(51), [tool('g1', 'grep', { pattern: 'pause', path: `${WT}/src` }, 'completed', { created: at(52), completed: at(53) })], at(54)), msg('r2', at(60), [{ type: 'text', text: 'No findings.' }], at(69))]
      const v = staged({ messages: { ses_impl: implMessages(), ses_rev: review } }, undefined, ended)
      expect(v.text()).toContain('✓ review r1')
      v.key('down,j')
      expect(v.selected()).toContain('✓ review r1')
      expect(v.m.fc.messageReads).not.toContain('ses_rev')
      v.m.timers.tick()
      expect(v.m.fc.messageReads.at(-1)).toBe('ses_rev')
      const text = v.text()
      expect(text).toContain('reviewer · k3.1-pro · ✓ 20s')
      expect(text).toContain('NOW   ✓ done in 20s')
      expect(text).toContain('grep   src')
      expect(text).toContain('LAST SAID  "No findings."')
      expect(text).toContain('! not linked to the parent session - it is in the session list')
      expect(text).not.toContain('NOW   ●')
    })

    it('toggles the verbose list with v', () => {
      const v = staged()
      v.key('v')
      const text = v.text()
      expect(text).toContain(`${clock(at(6))}  ▸ read   src/services/GameService.ts`)
      expect(text).toContain(`${clock(at(40))}  ✎ "Added pause/resume messages to the protocol."`)
      expect(text).toContain(`${clock(at(87))}  ▸ shell  bun test test/GameService.test.ts`)
      expect(text).not.toContain('RECENT')
      expect(v.lines().at(-1)!.trimEnd()).toBe(HELP.replace('v details', 'v summary'))
      v.key('v')
      expect(v.text()).toContain('RECENT')
    })

    it('moves the stepper and the header with the selected stage', () => {
      const v = staged()
      v.key('down,j')
      expect(v.selected()).toContain('2 Client pause UI and e2e')
      expect(v.lines()[0]!.trimEnd()).toBe('granny · feat/pause · stage 2/2 · Implement · 1m40s')
      expect(v.lines()[1]!.trimEnd()).toBe('Worktree ✓ › Implement › Checks › Review › Final review › PR ready')
      expect(v.text()).toContain('stage 2/2 · Client pause UI and e2e')
    })

    it('lists every known run at the bottom and switches the page to another with Enter', () => {
      const other = '20261105-183000-9zzz'
      const dir2 = join(tmp, other)
      mkdirSync(dir2)
      writeFileSync(join(dir2, 'status.json'), JSON.stringify({ id: other, status: 'running', branch: 'feat/other', parent: 'parent', watch: 'full', startedAt: new Date(at(30)).toISOString() }))
      appendFileSync(join(dir2, 'journal.jsonl'), line(30 * S, 'phase', { title: 'Plan' }) + line(31 * S, 'agent', { label: 'plan', role: 'planner', session: 'ses_other', model: kimi, phase: 'Plan', linked: true }))
      const sessions = [{ id: 'parent', title: 'main' }, implRole(), role('ses_other', { run: other, dir: dir2 })]
      const v = staged({ sessions })
      expect(v.lines()[0]!.trimEnd()).toBe('granny · feat/other · Plan · 1m10s')
      const left = v.left()
      expect(left).toContain('  runs')
      expect(left).toMatch(/● 523r · running +1m40s/)
      expect(left).toMatch(/● 9zzz · running \(shown\) +1m10s/)
      expect(left).not.toContain(other)
      v.key('end')
      expect(v.selected()).toContain('9zzz')
      expect(v.lines().at(-1)!.trimEnd()).toBe('↑↓ move · Tab next agent · Space fold · p parent · Esc close')
      v.key('up,k')
      expect(v.selected()).toContain('523r')
      expect(v.lines().at(-1)!.trimEnd()).toBe('↑↓ move · Enter switch run · Tab next agent · Space fold · p parent · Esc close')
      expect(v.text()).toContain(`run ${RUN}`)
      v.key('return')
      expect(v.lines()[0]!.trimEnd()).toBe('granny · feat/pause · stage 1/2 · Implement · 1m40s')
      expect(v.selected()).toContain('● implement')
      expect(v.left()).toMatch(/523r · running \(shown\)/)
      expect(v.left()).not.toContain('… plan')
    })
  })
})
