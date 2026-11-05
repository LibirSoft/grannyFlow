// What a role session is doing, from the messages opencode's TUI store holds for it: tool calls, said
// text and todo lists as the shared summariser's items, and the state of the unfinished last message.
// No opencode imports; anything malformed is skipped.
import { type ActivityItem, argOf, type NowState, type TodoItem } from '../runview/activity'

export interface MessageActivity {
  items: ActivityItem[]
  now?: NowState
  /** Changes when the messages do, cheaply: what the hub compares between ticks. */
  key: string
}

export interface MessageActivityOptions {
  maxMessages?: number
  maxItems?: number
}

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const timeOf = (v: unknown): Rec => (isRecord(v) && isRecord(v.time) ? v.time : {})
const partsOf = (m: Rec): unknown[] => (Array.isArray(m.content) ? m.content : [])

const TODO_STATES: Record<string, TodoItem['state']> = { completed: 'done', in_progress: 'active' }
const RUNNING = new Set(['pending', 'streaming', 'running'])

function errorText(error: unknown): string | undefined {
  const text = isRecord(error) ? str(error.message) : str(error)
  return text?.split('\n').map(l => l.trim()).find(Boolean)
}

function todosOf(input: unknown): TodoItem[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined
  return input.todos.flatMap(t => (isRecord(t) && str(t.content) ? [{ text: t.content as string, state: TODO_STATES[String(t.status)] ?? 'pending' }] : []))
}

function toolItems(part: Rec, fallback: number | undefined): ActivityItem[] {
  const name = str(part.name)
  if (!name) return []
  const state = isRecord(part.state) ? part.state : {}
  const time = timeOf(part)
  const t = num(time.created) ?? fallback
  const at = t !== undefined ? { t } : {}
  const id = str(part.id)
  const todos = name === 'todowrite' ? todosOf(state.input) : undefined
  if (todos) return [{ ...at, kind: 'todo', todos }]
  const arg = argOf(state.input)
  const out: ActivityItem[] = [{ ...at, kind: 'tool', name, ...(id ? { id } : {}), ...(arg ? { arg } : {}) }]
  const ended = num(time.completed) ?? t
  const endAt = ended !== undefined ? { t: ended } : {}
  if (state.status === 'completed') out.push({ ...endAt, kind: 'tool-end', name, ...(id ? { id } : {}) })
  else if (state.status === 'error') {
    const text = errorText(state.error)
    out.push({ ...endAt, kind: 'error', name, ...(id ? { id } : {}), ...(text ? { text } : {}) })
  }
  return out
}

/** The state of an assistant message that has not completed, from its last part. */
function nowOf(message: Rec): NowState | undefined {
  if (message.type !== 'assistant') return undefined
  const time = timeOf(message)
  if (num(time.completed) !== undefined) return undefined
  const created = num(time.created) ?? 0
  const last = partsOf(message).filter(isRecord).at(-1)
  if (!last) return { state: 'waiting', since: created }
  const pt = timeOf(last)
  const since = num(pt.created) ?? created
  if (last.type === 'reasoning' && num(pt.completed) === undefined) return { state: 'thinking', since }
  if (last.type === 'text' && num(pt.completed) === undefined) return { state: 'writing', since }
  if (last.type === 'tool') {
    const state = isRecord(last.state) ? last.state : {}
    if (RUNNING.has(String(state.status))) {
      const arg = argOf(state.input)
      return { state: 'running', ...(str(last.name) ? { tool: last.name as string } : {}), ...(arg ? { arg } : {}), since: num(pt.ran) ?? since }
    }
  }
  return { state: 'waiting', since: num(pt.completed) ?? since }
}

function keyOf(messages: readonly Rec[]): string {
  const last = messages.at(-1)
  if (!last) return '0'
  const parts = partsOf(last)
  const part = parts.at(-1)
  const p = isRecord(part) ? part : {}
  const state = isRecord(p.state) ? p.state : {}
  const ended = parts.filter(x => isRecord(x) && isRecord(x.state) && (x.state.status === 'completed' || x.state.status === 'error')).length
  const text = typeof p.text === 'string' ? p.text.length : 0
  return [messages.length, String(last.id ?? ''), num(timeOf(last).completed) ?? '', parts.length, String(p.type ?? ''), String(state.status ?? ''), text, ended].join('|')
}

/** The items, NOW and change key of a role session's messages, oldest first. */
export function messageActivity(messages: unknown, opts: MessageActivityOptions = {}): MessageActivity {
  const all = (Array.isArray(messages) ? messages : []).filter(isRecord)
  const items: ActivityItem[] = []
  for (const message of all.slice(-(opts.maxMessages ?? 8))) {
    if (message.type !== 'assistant') continue
    const created = num(timeOf(message).created)
    for (const part of partsOf(message)) {
      if (!isRecord(part)) continue
      if (part.type === 'tool') items.push(...toolItems(part, created))
      else if (part.type === 'text' && str(part.text)) {
        const t = num(timeOf(part).created) ?? created
        items.push({ ...(t !== undefined ? { t } : {}), kind: 'text', text: part.text as string })
      }
    }
  }
  const last = all.at(-1)
  const now = last ? nowOf(last) : undefined
  return { items: items.slice(-(opts.maxItems ?? 200)), ...(now ? { now } : {}), key: keyOf(all) }
}
