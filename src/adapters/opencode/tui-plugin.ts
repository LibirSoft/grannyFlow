// The opencode TUI plugin: finds the granny runs of the session being viewed through the role
// sessions' metadata, watches their files on one timer, and shows them in the sidebar, the prompt
// footer, toasts and the /granny navigator. It never talks to the server plugin; every ctx call is
// guarded, so a broken or missing TUI API loses the view, never the run.
import { agentKey } from '../runview/tree'
import type { LiveView } from '../runview/tree'
import { chipText, discoverRuns, type FoundRun, type FsLike, type RoleSession, RunWatch, type SessionLike, sidebarLines, type Toast, toastFor, type Tone } from './runwatch'
import { type TuiRuntime, View } from './tui-view'

export type { TuiRuntime } from './tui-view'

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TuiOptions {
  now?: () => number
  tickMs?: number
  fs?: FsLike
  timers?: Timers
}

const ID = 'granny-workflow'
const ROUTE = 'granny'
const SIDEBAR_WIDTH = 40
const MAX_LIVE_RUNS = 8
const MAX_RUNS = 16
const MAX_TOASTS = 3
const LIST_EVERY_MS = 10_000
const LIST_LIMIT = 50
const WAKE_TICKS = 3
const FRESH_MS = 60_000
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const STATUS_TONES: Record<string, Tone> = { done: 'success', failed: 'error', cancelled: 'warning' }
const WAKE_EVENTS = ['session.created', 'session.updated']

export const NO_RUN = 'granny: no granny run in this session yet - role sessions appear once the run starts its first agent.'
export const watchingOff = (id: string, mode: string) => `granny: watching is off for run ${id} (watch: "${mode}") - set "watch": "full" in granny.config.json for the navigator.`

const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export interface KnownRun {
  id: string
  watch: RunWatch
  found: FoundRun
  ended: boolean
  polled: boolean
}

interface Route {
  type?: string
  name?: string
  sessionID?: string
  [key: string]: unknown
}

export class Hub {
  readonly runs = new Map<string, KnownRun>()
  readonly version: () => number
  /** The node to select when the navigator opens on a run again. */
  readonly selection = new Map<string, string>()
  savedRoute?: Route
  readonly view: View
  private readonly bump: () => void
  private readonly now: () => number
  private readonly tickMs: number
  private readonly timers: Timers
  private interval?: unknown
  private expiry?: unknown
  private wakeTicks = 0
  private mounted = 0
  private lastList = Number.NEGATIVE_INFINITY
  private lastRoot?: string
  private hidden: { get(): boolean; set(off: boolean): void }
  private readonly unsubscribe: Array<() => void> = []
  private disposed = false

  constructor(
    readonly rt: TuiRuntime,
    readonly ctx: any,
    private readonly opts: TuiOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.tickMs = Math.max(1, opts.tickMs ?? 1000)
    this.timers = opts.timers ?? realTimers
    const [version, setVersion] = rt.solid.createSignal(0, { name: 'granny.version', equals: false })
    this.version = version
    this.bump = () => void setVersion(v => v + 1)
    this.view = new View(rt, () => this.ctx?.theme)
    this.hidden = this.memoryFlag()
  }

  install() {
    const ui = this.ctx?.ui
    attempt(() =>
      ui.slot({
        append: 'sidebar.content',
        render: (input: any) => {
          this.wake()
          const [view, setView] = attempt(() => this.ctx.storage.store('view', { initial: { open: true } })) ?? [{ open: true }, undefined]
          return this.view.lines(
            () => {
              this.version()
              if (this.hidden.get()) return []
              const run = this.runFor(input?.sessionID)
              if (!run) return []
              const lines = sidebarLines(run.watch.snapshot, this.now(), SIDEBAR_WIDTH)
              return view?.open === false ? lines.slice(0, 1) : lines
            },
            () => {
              const toggled = setView?.((draft: { open: boolean }) => {
                draft.open = !draft.open
              })
              if (toggled && typeof toggled.catch === 'function') toggled.catch(() => {})
              this.bump()
            },
          )
        },
      }),
    )
    attempt(() =>
      ui.slot({
        append: 'prompt.footer.status',
        render: (input: any) => {
          this.wake()
          return this.view.chip(() => {
            this.version()
            if (this.hidden.get()) return undefined
            const run = this.runFor(input?.sessionID)
            if (!run) return undefined
            const s = run.watch.snapshot
            return { text: chipText(s, this.now()), tone: STATUS_TONES[s.status] ?? 'muted' }
          })
        },
      }),
    )
    attempt(() =>
      ui.slot({
        append: 'app',
        render: () => {
          this.registerCommand()
          return null
        },
      }),
    )
    for (const type of WAKE_EVENTS) {
      const off = attempt(() => this.ctx.data.on(type, () => this.wake()))
      if (typeof off === 'function') this.unsubscribe.push(off)
    }
    this.wake()
  }

  dispose() {
    this.disposed = true
    this.stop()
    if (this.expiry !== undefined) attempt(() => this.timers.clearTimeout(this.expiry))
    this.expiry = undefined
    for (const off of this.unsubscribe.splice(0)) attempt(off)
  }

  // --- timer ------------------------------------------------------------------------------------

  /** Makes sure the timer runs for at least a few ticks, so a new run gets discovered. */
  wake() {
    if (this.disposed) return
    this.wakeTicks = WAKE_TICKS
    if (this.interval !== undefined) return
    this.interval = attempt(() => this.timers.setInterval(() => this.tick(), this.tickMs))
  }

  private stop() {
    if (this.interval === undefined) return
    attempt(() => this.timers.clearInterval(this.interval))
    this.interval = undefined
  }

  mount() {
    this.mounted++
    this.wake()
  }

  unmount() {
    this.mounted = Math.max(0, this.mounted - 1)
  }

  private busy(): boolean {
    if (this.mounted > 0 || this.wakeTicks > 0) return true
    for (const run of this.runs.values()) if (!run.ended) return true
    return false
  }

  tick() {
    if (this.disposed) return
    try {
      let changed = false
      try {
        changed = this.discover()
      } catch {}
      const toasts: Toast[] = []
      for (const run of this.liveRuns()) {
        try {
          if (this.poll(run)) changed = true
          for (const event of run.watch.events.splice(0)) {
            const toast = toastFor(event, run.watch.snapshot)
            if (toast) toasts.push(toast)
          }
        } catch {}
      }
      this.toast(toasts)
      if (changed) this.bump()
    } catch {}
    if (this.wakeTicks > 0) this.wakeTicks--
    if (!this.busy()) this.stop()
  }

  private liveRuns(): KnownRun[] {
    return [...this.runs.values()].filter(run => !run.ended)
  }

  poll(run: KnownRun): boolean {
    const changed = run.watch.poll(this.liveOf(run))
    run.polled = true
    if (TERMINAL.has(run.watch.snapshot.status)) {
      run.ended = true
      this.expire(run)
    }
    return changed
  }

  /** Redraws once the finished run's line in the sidebar and chip is due to go. */
  private expire(run: KnownRun) {
    const end = run.watch.snapshot.end
    if (end === undefined) return
    const wait = end + FRESH_MS - this.now()
    if (wait <= 0) return
    if (this.expiry !== undefined) attempt(() => this.timers.clearTimeout(this.expiry))
    this.expiry = attempt(() =>
      this.timers.setTimeout(() => {
        this.expiry = undefined
        this.bump()
      }, wait + 1),
    )
  }

  private liveOf(run: KnownRun): Map<string, LiveView> {
    const live = new Map<string, LiveView>()
    const sessions = new Set([...run.found.sessions, ...run.watch.snapshot.tree.agents.map(a => a.session)])
    for (const session of sessions) {
      const status = attempt(() => this.ctx.data.session.status(session))
      live.set(session, { active: status === 'running' })
    }
    return live
  }

  private toast(toasts: Toast[]) {
    const shown: Toast[] =
      toasts.length > MAX_TOASTS
        ? [...toasts.slice(0, MAX_TOASTS - 1), { title: 'granny', message: `+${toasts.length - (MAX_TOASTS - 1)} more granny events`, variant: 'info' }]
        : toasts
    for (const toast of shown) this.show(toast)
  }

  show(toast: Partial<Toast> & { message: string; variant: Toast['variant'] }) {
    attempt(() => this.ctx.ui.toast.show(toast))
  }

  // --- discovery --------------------------------------------------------------------------------

  rootOf(session: string): string {
    const root = attempt(() => this.ctx.data.session.root(session))
    return typeof root === 'string' && root ? root : session
  }

  current(): Route | undefined {
    const route = attempt(() => this.ctx.ui.router.current())
    return route && typeof route === 'object' ? (route as Route) : undefined
  }

  private discover(): boolean {
    const route = this.current()
    const roots = new Set<string>()
    if (route?.type === 'session' && typeof route.sessionID === 'string') roots.add(this.rootOf(route.sessionID))
    if (this.lastRoot) roots.add(this.lastRoot)
    let changed = false
    for (const root of roots) {
      const ids = attempt(() => this.ctx.data.session.family(root))
      const sessions: SessionLike[] = []
      for (const id of Array.isArray(ids) ? ids : []) {
        const info = attempt(() => this.ctx.data.session.get(id))
        if (info) sessions.push({ id, metadata: info.metadata })
      }
      const found = discoverRuns(sessions)
      if (this.merge(found)) changed = true
      if (!found.size) this.listUnlinked(root)
    }
    return changed
  }

  /** Role sessions created top-level (linking failed) are roots of their own; look for them in the session list. */
  private listUnlinked(root: string) {
    const now = this.now()
    if (now - this.lastList < LIST_EVERY_MS) return
    this.lastList = now
    const pending = attempt(() => this.ctx.client.session.list({ parentID: null, order: 'desc', limit: LIST_LIMIT }))
    if (!pending || typeof pending.then !== 'function') return
    pending.then(
      (result: any) => {
        try {
          const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
          const found = discoverRuns(list.filter((s: any) => s && typeof s.id === 'string'))
          for (const [id, run] of found) if (run.parent !== root) found.delete(id)
          if (this.merge(found)) {
            this.bump()
            this.wake()
          }
        } catch {}
      },
      () => {},
    )
  }

  private merge(found: Map<string, FoundRun>): boolean {
    let changed = false
    for (const [id, run] of found) {
      const known = this.runs.get(id)
      if (known) {
        const roles = new Map<string, RoleSession>(known.watch.roles.map(r => [r.id, r]))
        for (const r of run.roles) roles.set(r.id, r)
        known.watch.roles = [...roles.values()]
        known.found = { ...run, sessions: [...new Set([...known.found.sessions, ...run.sessions])], roles: known.watch.roles }
        continue
      }
      const watch = new RunWatch(run.dir, { now: this.now, roles: run.roles, ...(this.opts.fs ? { read: this.opts.fs } : {}) })
      this.runs.set(id, { id, watch, found: run, ended: false, polled: false })
      changed = true
    }
    if (changed) this.trim()
    return changed
  }

  private trim() {
    const live = this.liveRuns()
    for (const run of live.slice(0, Math.max(0, live.length - MAX_LIVE_RUNS))) this.runs.delete(run.id)
    const all = [...this.runs.values()]
    for (const run of all.slice(0, Math.max(0, all.length - MAX_RUNS))) this.runs.delete(run.id)
  }

  /** The run to show for a session: the newest run of its root, a running one first. */
  runFor(sessionID: unknown): KnownRun | undefined {
    if (typeof sessionID !== 'string' || !sessionID) return undefined
    const root = this.rootOf(sessionID)
    this.lastRoot = root
    const mine = [...this.runs.values()].filter(run => {
      const parent = run.found.parent
      return parent === sessionID || parent === root || run.found.sessions.includes(sessionID) || (parent && this.rootOf(parent) === root)
    })
    mine.sort((a, b) => {
      const ra = a.watch.snapshot.status === 'running' ? 0 : 1
      const rb = b.watch.snapshot.status === 'running' ? 0 : 1
      return ra - rb || b.watch.snapshot.start - a.watch.snapshot.start
    })
    return mine[0]
  }

  // --- the /granny command ----------------------------------------------------------------------

  private registerCommand() {
    const command = {
      id: 'granny.open',
      title: 'granny: run navigator',
      description: 'Phases, rounds and roles of the granny runs of this session',
      group: 'granny',
      palette: true,
      slash: { name: 'granny', arguments: true },
      bind: '<leader>j',
      run: (arg?: unknown) => this.command(arg),
    }
    try {
      this.ctx.keymap.layer(() => ({ mode: 'global', commands: [command] }))
    } catch {
      const { bind: _bind, ...unbound } = command
      attempt(() => this.ctx.keymap.layer(() => ({ mode: 'global', commands: [unbound] })))
    }
  }

  command(arg?: unknown) {
    try {
      const text = typeof arg === 'string' ? arg.trim() : ''
      if (text === 'on' || text === 'off') {
        this.hidden.set(text === 'off')
        this.bump()
        return
      }
      const route = this.current()
      if (route?.type === 'plugin' && route.name === ROUTE) return
      this.wake()
      attempt(() => this.discover())
      const session = route?.type === 'session' && typeof route.sessionID === 'string' ? route.sessionID : undefined
      const run = (text ? this.runs.get(text) : undefined) ?? this.runFor(session)
      if (!run) return this.show({ message: NO_RUN, variant: 'warning' })
      if (!run.polled) attempt(() => this.poll(run))
      const mode = run.watch.snapshot.watch
      if (mode !== 'full') return this.show({ message: watchingOff(run.id, mode), variant: 'info' })
      const select = session && run.found.sessions.includes(session) ? agentKey(session) : this.selection.get(run.id)
      this.savedRoute = route ? { ...route } : undefined
      attempt(() => this.ctx.ui.dialog?.clear?.())
      this.ctx.ui.router.navigate({ type: 'plugin', name: ROUTE, data: { runId: run.id, ...(select ? { select } : {}) } })
    } catch {}
  }

  private memoryFlag(): { get(): boolean; set(off: boolean): void } {
    const stored = attempt(() => this.ctx.storage.memory('hidden', { initial: { off: false } }))
    if (Array.isArray(stored) && stored[0] && typeof stored[1] === 'function') {
      const [state, set] = stored
      return {
        get: () => attempt(() => state.off === true) ?? false,
        set: off =>
          void attempt(() =>
            set((draft: { off: boolean }) => {
              draft.off = off
            }),
          ),
      }
    }
    let off = false
    return { get: () => off, set: next => void (off = next) }
  }
}

export function createTuiPlugin(rt: TuiRuntime, opts: TuiOptions = {}) {
  return {
    id: ID,
    setup(ctx: any) {
      let hub: Hub | undefined
      try {
        hub = new Hub(rt, ctx, opts)
        hub.install()
      } catch {}
      return () => {
        try {
          hub?.dispose()
        } catch {}
      }
    },
  }
}
