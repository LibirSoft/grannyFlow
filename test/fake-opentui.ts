// A stand-in for opencode's TUI: the @opentui/solid node functions, solid-js signals, the plugin ctx
// and the timers, recording what the granny TUI plugin claims, shows and asks for.

export interface FakeNode {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

export interface Rendered {
  text: string
  fg?: unknown
  bg?: unknown
  parts?: Rendered[]
}

interface Dynamic {
  type: '#dyn'
  accessor: () => unknown
}

const isNode = (value: unknown): value is FakeNode => !!value && typeof value === 'object' && 'type' in value && 'children' in value

export interface FakeSignal {
  name?: string
  get(): unknown
  sets: number
}

export function fakeRuntime(dims?: { width: number; height: number }) {
  const cleanups: Array<() => void> = []
  const signals: FakeSignal[] = []
  const ui = {
    createElement: (type: string): FakeNode => ({ type, props: {}, children: [] }),
    createTextNode: (value: string): FakeNode => ({ type: '#text', props: { value: String(value) }, children: [] }),
    insertNode(parent: FakeNode, node: unknown) {
      parent.children.push(node)
    },
    insert(parent: FakeNode, accessor: unknown) {
      parent.children.push(typeof accessor === 'function' ? ({ type: '#dyn', accessor } as Dynamic) : accessor)
    },
    setProp(node: FakeNode, name: string, value: unknown) {
      node.props[name] = value
      return value
    },
    ...(dims ? { useTerminalDimensions: () => () => dims } : {}),
  }
  const solid = {
    createSignal<T>(value: T, options?: { name?: string }) {
      let current = value
      const signal: FakeSignal = { ...(options?.name ? { name: options.name } : {}), get: () => current, sets: 0 }
      signals.push(signal)
      const set = (next: T | ((prev: T) => T)) => {
        signal.sets++
        current = typeof next === 'function' ? (next as (prev: T) => T)(current) : next
        return current
      }
      return [() => current, set] as [() => T, (next: T | ((prev: T) => T)) => T]
    },
    onCleanup(fn: () => void) {
      cleanups.push(fn)
      return fn
    },
  }
  return {
    rt: { ui, solid },
    cleanups,
    signals,
    signal: (name: string) => signals.find(s => s.name === name),
    unmount() {
      for (const fn of cleanups.splice(0)) fn()
    },
  }
}

function expand(children: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  for (const child of children) {
    const value = child && typeof child === 'object' && (child as Dynamic).type === '#dyn' ? (child as Dynamic).accessor() : child
    if (Array.isArray(value)) out.push(...value.flat(Infinity))
    else if (value !== null && value !== undefined && value !== false) out.push(value)
  }
  return out
}

function textOf(node: FakeNode): string {
  return expand(node.children)
    .map(c => (isNode(c) ? (c.type === '#text' ? String(c.props.value) : textOf(c)) : String(c)))
    .join('')
}

/** Evaluates every inserted accessor and lays the nodes out as plain lines with their colours. */
export function render(node: unknown): Rendered[] {
  if (!isNode(node)) return node === null || node === undefined ? [] : [{ text: String(node) }]
  if (node.type === 'text') return [{ text: textOf(node), ...(node.props.fg !== undefined ? { fg: node.props.fg } : {}), ...(node.props.bg !== undefined ? { bg: node.props.bg } : {}) }]
  const kids = expand(node.children)
  if (node.props.flexDirection === 'row') {
    const parts = kids.flatMap(render)
    if (!parts.length) return []
    return [{ text: parts.map(p => p.text).join(''), ...(parts[0]!.fg !== undefined ? { fg: parts[0]!.fg } : {}), ...(parts[0]!.bg !== undefined ? { bg: parts[0]!.bg } : {}), parts }]
  }
  return kids.flatMap(render)
}

export const texts = (node: unknown) => render(node).map(l => l.text)

export function fakeTimers() {
  let next = 1
  const intervals = new Map<number, () => void>()
  const timeouts = new Map<number, () => void>()
  const delays = new Map<number, number>()
  return {
    setInterval(fn: () => void, _ms: number) {
      const id = next++
      intervals.set(id, fn)
      return id
    },
    clearInterval(id: unknown) {
      intervals.delete(id as number)
    },
    setTimeout(fn: () => void, ms: number) {
      const id = next++
      timeouts.set(id, fn)
      delays.set(id, ms)
      return id
    },
    clearTimeout(id: unknown) {
      timeouts.delete(id as number)
    },
    /** The delays of the pending timeouts. */
    delays() {
      return [...timeouts.keys()].map(id => delays.get(id))
    },
    get intervals() {
      return intervals.size
    },
    get timeouts() {
      return timeouts.size
    },
    /** Runs every interval once. */
    tick() {
      for (const fn of [...intervals.values()]) fn()
    },
    /** Runs every pending timeout once. */
    flush() {
      const due = [...timeouts.entries()]
      for (const [id] of due) timeouts.delete(id)
      for (const [, fn] of due) fn()
    },
  }
}

export interface FakeSession {
  id: string
  parentID?: string
  title?: string
  metadata?: unknown
}

export interface FakeCtxOptions {
  sessions?: FakeSession[]
  running?: string[]
  route?: Record<string, unknown>
  /** Sessions `client.session.list` returns. */
  listed?: FakeSession[]
  refuseBind?: string
  throwFamily?: boolean
  throwToast?: boolean
  throwNavigate?: boolean
  width?: number
  height?: number
  /** Each role session's messages in the TUI store, oldest first; the test may change them between ticks. */
  messages?: Record<string, unknown[]>
  /** A TUI without `data.session.message`: the plugin falls back to `client.message.list`. */
  noMessageStore?: boolean
  throwMessages?: boolean
}

export const THEME = {
  text: {
    base: 'c:base',
    muted: 'c:muted',
    feedback: { error: { base: 'c:error' }, success: { base: 'c:success' }, warning: { base: 'c:warning' }, info: { base: 'c:info' } },
  },
  background: { base: 'c:bg', raised: { base: 'c:raised' } },
}

export function fakeCtx(options: FakeCtxOptions = {}) {
  const sessions = new Map<string, FakeSession>()
  for (const s of options.sessions ?? []) sessions.set(s.id, s)
  const running = new Set(options.running ?? [])
  const slots: Array<Record<string, any>> = []
  const routes = new Map<string, { name: string; render(input: any): unknown }>()
  const toasts: Array<Record<string, unknown>> = []
  const layers: Array<{ mode?: string; commands: any[] }> = []
  const navigations: unknown[] = []
  const listCalls: unknown[] = []
  const familyCalls: string[] = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const stores = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, unknown[]>(Object.entries(options.messages ?? {}))
  const messageReads: string[] = []
  const syncCalls: string[] = []
  const fetchCalls: Array<Record<string, unknown>> = []
  const opts = { ...options }
  let route: Record<string, unknown> = options.route ?? { type: 'session', sessionID: 'parent' }

  const root = (id: string): string => {
    let at = id
    for (let i = 0; i < 50; i++) {
      const parent = sessions.get(at)?.parentID
      if (!parent) return at
      at = parent
    }
    return at
  }
  const storage = (key: string, init: { initial: Record<string, unknown> }) => {
    let state = stores.get(key)
    if (!state) {
      state = { ...init.initial }
      stores.set(key, state)
    }
    const value = state
    return [value, (fn: (draft: Record<string, unknown>) => void) => {
      fn(value)
      return Promise.resolve()
    }] as const
  }

  const ctx = {
    options: {},
    theme: THEME,
    renderer: { width: options.width ?? 120, height: options.height ?? 30 },
    ui: {
      slot(claim: Record<string, any>) {
        slots.push(claim)
        return () => {}
      },
      router: {
        register(def: { name: string; render(input: any): unknown }) {
          routes.set(def.name, def)
          return () => {}
        },
        navigate(target: Record<string, unknown>) {
          if (opts.throwNavigate) throw new Error('navigate broke')
          navigations.push(target)
          route = target
        },
        current: () => route,
      },
      toast: {
        show(toast: Record<string, unknown>) {
          if (opts.throwToast) throw new Error('toast broke')
          toasts.push(toast)
        },
      },
    },
    keymap: {
      layer(spec: () => { mode?: string; commands: any[] }) {
        const value = spec()
        if (opts.refuseBind && value.commands.some(c => c.bind === opts.refuseBind)) throw new Error(`invalid bind ${opts.refuseBind}`)
        layers.push(value)
        return () => {}
      },
    },
    data: {
      on(type: string, cb: (event: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), cb])
        return () => listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== cb))
      },
      session: {
        get: (id: string) => sessions.get(id),
        root,
        family(id: string) {
          familyCalls.push(id)
          if (opts.throwFamily) throw new Error('family broke')
          const top = root(id)
          return [...sessions.values()].filter(s => root(s.id) === top).map(s => s.id)
        },
        status: (id: string) => (running.has(id) ? 'running' : 'idle'),
        ...(options.noMessageStore
          ? {}
          : {
              message: {
                list(id: string) {
                  messageReads.push(id)
                  if (opts.throwMessages) throw new Error('list broke')
                  return messages.get(id) ?? []
                },
                sync(id: string) {
                  syncCalls.push(id)
                  if (opts.throwMessages) throw new Error('sync broke')
                  return Promise.resolve()
                },
              },
            }),
      },
    },
    client: {
      session: {
        async list(query: unknown) {
          listCalls.push(query)
          return { data: options.listed ?? [] }
        },
      },
      message: {
        async list(query: Record<string, unknown>) {
          fetchCalls.push(query)
          if (opts.throwMessages) throw new Error('fetch broke')
          return { data: [...(messages.get(String(query.sessionID)) ?? [])].reverse(), cursor: {} }
        },
      },
    },
    storage: { store: storage, memory: storage },
  }

  return {
    ctx,
    opts,
    sessions,
    running,
    slots,
    routes,
    toasts,
    layers,
    navigations,
    listCalls,
    familyCalls,
    listeners,
    stores,
    messages,
    messageReads,
    syncCalls,
    fetchCalls,
    get route() {
      return route
    },
    set route(next: Record<string, unknown>) {
      route = next
    },
    slot: (placement: string, target: string) => slots.find(s => s[placement] === target),
    command: (id: string) => layers.flatMap(l => l.commands).find(c => c.id === id),
    bound: (bind: string) => layers.flatMap(l => l.commands).filter(c => c.bind === bind).at(-1),
    emit(type: string, event: unknown = {}) {
      for (const cb of listeners.get(type) ?? []) cb(event)
    },
  }
}
