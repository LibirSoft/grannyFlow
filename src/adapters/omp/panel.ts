// The live view of a granny run in the omp session that started it: what each role process is
// doing right now, read from its `omp --mode json` stdout. Shown as a TUI widget and status line,
// and appended to granny_status.

export interface PanelUi {
  setWidget(key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void
  setStatus(key: string, text: string | undefined): void
}

export interface LiveOptions {
  now: () => number
  renderEveryMs: number
}

export interface RoleInfo {
  label: string
  role: string
  model?: string
  effort?: string
  /** The role's events.jsonl, when the run keeps one. */
  log?: string
}

/** One condensed entry of a role's event log. */
export type LogEntry =
  | { type: 'state'; state: string }
  | { type: 'heading'; text: string }
  | { type: 'tool'; name: string; intent?: string; arg?: string }
  | { type: 'tool-end'; name: string; error?: true }
  | { type: 'text'; text: string }
  | { type: 'subagents'; agents: string[] }
  | { type: 'exit'; code: number }

export type LogSink = (entry: LogEntry) => void

/** Events the extension parses in full; every other line is classified from its text. */
export const PARSED_EVENTS = new Set(['message_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_start', 'turn_end'])

const HEAD = 200
const MAX_LINES = 8
const THINKING_TAIL = 4000
const LOG_ARG = 200
const LOG_TEXT = 4000

function stringAfter(text: string, marker: string): string | undefined {
  const i = text.indexOf(marker)
  if (i < 0) return undefined
  const start = i + marker.length
  const end = text.indexOf('"', start)
  return end < 0 ? undefined : text.slice(start, end)
}

/** The `type` of a JSON event line, read from its first bytes without parsing the line. */
export function lineType(line: string): string | undefined {
  return stringAfter(line.slice(0, HEAD), '"type":"')
}

/** The `assistantMessageEvent.type` of a `message_update` line, without parsing the line. */
export function streamType(line: string): string | undefined {
  return stringAfter(line, '"assistantMessageEvent":{"type":"')
}

function deltaOf(line: string): string {
  const marker = '"delta":"'
  const at = line.indexOf(marker)
  if (at < 0) return ''
  const start = at + marker.length
  for (let j = start; j < line.length; j++) {
    if (line[j] === '\\') j++
    else if (line[j] === '"') {
      try {
        return JSON.parse(line.slice(start - 1, j + 1))
      } catch {
        return ''
      }
    }
  }
  return ''
}

export function oneLine(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const ARG_KEYS = ['path', 'file_path', 'file', 'pattern', 'command', 'query', 'url', 'op']

function subagents(args: any): string[] {
  const items: any[] = Array.isArray(args?.tasks) ? args.tasks : [args]
  return items.map(t => oneLine(String(t?.name || t?.agent || 'task'), 40))
}

interface ToolCall {
  name: string
  detail?: string
  intent?: boolean
}

function argOf(args: any, max: number): string | undefined {
  const key = ARG_KEYS.find(k => typeof args?.[k] === 'string' && args[k].trim())
  return key ? oneLine(args[key], max) : undefined
}

function toolEntry(event: any): LogEntry {
  const intent = typeof event?.intent === 'string' && event.intent.trim() ? oneLine(event.intent, LOG_ARG) : undefined
  const arg = argOf(event?.args, LOG_ARG)
  return { type: 'tool', name: String(event?.toolName ?? 'tool'), ...(intent ? { intent } : {}), ...(arg ? { arg } : {}) }
}

function finalText(message: any): string {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
    .trim()
    .slice(0, LOG_TEXT)
}

function describe(event: any): ToolCall {
  const name = String(event?.toolName ?? 'tool')
  if (typeof event?.intent === 'string' && event.intent.trim()) return { name, detail: oneLine(event.intent), intent: true }
  if (name === 'task') return { name, detail: oneLine(subagents(event?.args).join(', ')) }
  return { name, detail: argOf(event?.args, 60) }
}

const HEADING = /(?:^|\n)[ \t]*\*\*([^*\n]+)\*\*/g

export class RoleActivity {
  state = 'starting'
  since: number
  heading?: string
  lastTool?: { text: string; at: number; error: boolean }
  task?: { id: string; agents: string[]; mark?: string }
  startedAt?: number
  endedAt?: number
  active = false
  private thinking = ''
  private unscanned = false
  private running = new Map<string, ToolCall>()

  constructor(readonly info: RoleInfo, now: number, private readonly log?: LogSink) {
    this.since = now
  }

  private set(state: string, now: number) {
    if (state === this.state) return
    this.state = state
    this.since = now
    this.log?.({ type: 'state', state })
  }

  begin(now: number) {
    this.running.clear()
    this.startedAt ??= now
    this.active = true
    this.set('starting', now)
  }

  end(now: number) {
    this.active = false
    this.endedAt = now
  }

  /** The role process closed with this exit code. */
  exit(code: number) {
    this.log?.({ type: 'exit', code })
  }

  /** A `message_update` (or other unparsed) line. */
  stream(type: string, line: string, now: number) {
    if (type !== 'message_update') return
    switch (streamType(line)) {
      case 'thinking_start':
        this.thinking = ''
        this.unscanned = false
        this.heading = undefined
        this.set('thinking', now)
        break
      case 'thinking_delta': {
        const delta = deltaOf(line)
        this.thinking += delta
        if (delta.includes('*')) this.unscanned = true
        if ((this.unscanned && this.log) || this.thinking.length > 2 * THINKING_TAIL) this.flush()
        this.set('thinking', now)
        break
      }
      case 'text_start':
      case 'text_delta':
        this.set('writing', now)
        break
      case 'toolcall_start':
      case 'toolcall_delta':
        this.set('preparing a tool call', now)
        break
    }
  }

  /** A parsed event; returns the subagent names when it starts a `task` call. */
  event(event: any, now: number): string[] | undefined {
    switch (event?.type) {
      case 'turn_start':
        this.set('waiting for model', now)
        return undefined
      case 'message_start':
        if (event.message?.role === 'assistant') this.set('waiting for model', now)
        return undefined
      case 'message_end': {
        if (event.message?.role !== 'assistant' || !this.log) return undefined
        const text = finalText(event.message)
        if (text) this.log({ type: 'text', text })
        return undefined
      }
      case 'tool_execution_start': {
        const call = describe(event)
        this.running.set(String(event.toolCallId), call)
        this.set(running(call), now)
        this.log?.(toolEntry(event))
        if (call.name !== 'task') return undefined
        const agents = subagents(event.args)
        this.task = { id: String(event.toolCallId), agents }
        this.log?.({ type: 'subagents', agents })
        return agents
      }
      case 'tool_execution_end': {
        const id = String(event.toolCallId)
        const call = this.running.get(id) ?? describe(event)
        this.running.delete(id)
        const error = event.isError === true
        this.lastTool = { text: call.intent || !call.detail ? (call.detail ?? call.name) : `${call.name}: ${call.detail}`, at: now, error }
        if (this.task?.id === id) this.task.mark = error ? '✗' : '✓'
        this.log?.({ type: 'tool-end', name: call.name, ...(error ? { error: true as const } : {}) })
        const other = [...this.running.values()].at(-1)
        this.set(other ? running(other) : 'waiting for model', now)
        return undefined
      }
    }
    return undefined
  }

  /** Characters of thinking text held for the heading search. */
  get retainedChars(): number {
    return this.thinking.length
  }

  /** Keeps the latest `**heading**` of the thinking text and trims the text to its tail. */
  flush() {
    if (this.unscanned) {
      this.unscanned = false
      let heading: string | undefined
      for (const m of this.thinking.matchAll(HEADING)) heading = m[1]
      const text = heading?.trim() ? oneLine(heading) : undefined
      if (text && text !== this.heading) {
        this.heading = text
        this.log?.({ type: 'heading', text })
      }
    }
    if (this.thinking.length > THINKING_TAIL) this.thinking = this.thinking.slice(-THINKING_TAIL)
  }

  /** Model, what the role does now (or `done`) and how long it has run, for the /granny list. */
  summary(now: number): string {
    const { model, effort } = this.info
    const doing = this.active ? `${this.state} ${duration(now - this.since)}` : 'done'
    const ran = this.startedAt === undefined ? '' : ` · ${duration((this.active ? now : (this.endedAt ?? now)) - this.startedAt)}`
    return `${model ?? 'default model'}${effort ? `/${effort}` : ''} · ${doing}${ran}`
  }

  lines(now: number): string[] {
    const { label, role, model, effort } = this.info
    const heading = this.state === 'thinking' && this.heading ? ` · "${this.heading}"` : ''
    const out = [`  ${label} (${role}) · ${model ?? 'default model'}${effort ? `/${effort}` : ''} · ${this.state} ${duration(now - this.since)}${heading}`]
    if (this.lastTool) out.push(`    last tool: ${this.lastTool.text}${this.lastTool.error ? ' ✗' : ''} (${duration(now - this.lastTool.at)} ago)`)
    if (this.task) out.push(`    └ task: ${this.task.agents.map(a => `${a} ${this.task!.mark ?? '…'}`).join(', ')}`)
    return out
  }
}

const running = (call: ToolCall) => `running ${call.name}${call.detail ? `: ${call.detail}` : ''}`

export class LiveRun {
  phase = 'Starting'
  readonly startedAt: number
  /** Every role process of the run, in start order. */
  readonly roles: RoleActivity[] = []
  private readonly active = new Set<RoleActivity>()
  private lastDraw = Number.NEGATIVE_INFINITY
  private closed = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    readonly id: string,
    private readonly ui: PanelUi | undefined,
    private readonly options: LiveOptions,
    private visible = true,
  ) {
    this.startedAt = options.now()
  }

  get key(): string {
    return `granny-${this.id}`
  }

  now(): number {
    return this.options.now()
  }

  role(info: RoleInfo, log?: LogSink): RoleActivity {
    const role = new RoleActivity(info, this.options.now(), log)
    this.roles.push(role)
    return role
  }

  start(role: RoleActivity) {
    role.begin(this.options.now())
    this.active.add(role)
    this.touch()
  }

  stop(role: RoleActivity) {
    role.end(this.options.now())
    this.active.delete(role)
    this.touch()
  }

  /** Shows or hides the widget and status line for the rest of the run. */
  setVisible(visible: boolean) {
    if (visible === this.visible || this.closed) return
    this.visible = visible
    if (visible) {
      this.lastDraw = Number.NEGATIVE_INFINITY
      return this.touch()
    }
    this.call(ui => ui.setWidget(this.key, undefined))
    this.call(ui => ui.setStatus(this.key, undefined))
  }

  setPhase(title: string) {
    this.phase = title
    this.touch()
  }

  /** Header and active roles, at most `max` lines with the overflow collapsed to "+N more". */
  lines(max = MAX_LINES): string[] {
    const now = this.options.now()
    const out = [`granny ${this.id} · ${this.phase} · ${duration(now - this.startedAt)}`]
    const roles = [...this.active]
    if (!roles.length) out.push('  no role process running')
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i]!
      role.flush()
      const more = roles.length - i - 1
      const room = max - out.length - (more ? 1 : 0)
      const lines = role.lines(now)
      if (i > 0 && lines.length > room) {
        out.push(`  +${roles.length - i} more`)
        break
      }
      out.push(...lines.slice(0, Math.max(1, room)))
    }
    return out
  }

  status(): string {
    return `granny ${this.id} · ${this.phase} · ${this.active.size} active · ${duration(this.options.now() - this.startedAt)}`
  }

  private call(fn: (ui: PanelUi) => void) {
    if (!this.ui) return
    try {
      fn(this.ui)
    } catch {}
  }

  /** Redraws the widget, at most once per `renderEveryMs`. */
  touch() {
    if (!this.ui || this.closed || !this.visible) return
    if (!this.timer) {
      this.timer = setInterval(() => this.touch(), Math.max(10, Math.min(250, this.options.renderEveryMs)))
      this.timer.unref?.()
    }
    const now = this.options.now()
    if (now - this.lastDraw < this.options.renderEveryMs) return
    this.lastDraw = now
    const lines = this.lines()
    const status = this.status()
    this.call(ui => ui.setWidget(this.key, lines, { placement: 'aboveEditor' }))
    this.call(ui => ui.setStatus(this.key, status))
  }

  /** Removes the widget and leaves a one-line status; returns the function that clears that status. */
  close(outcome: string): () => void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.active.clear()
    if (!this.visible) return () => {}
    this.call(ui => ui.setWidget(this.key, undefined))
    this.call(ui => ui.setStatus(this.key, `granny ${this.id}: ${outcome}`))
    let cleared = !this.ui
    return () => {
      if (cleared) return
      cleared = true
      this.call(ui => ui.setStatus(this.key, undefined))
    }
  }
}
