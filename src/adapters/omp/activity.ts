// A role's events.jsonl entries as the shared activity items the navigator's detail pane summarises.
import type { ActivityItem, TodoItem } from '../runview/activity'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)
const TODO_STATES = new Set<TodoItem['state']>(['done', 'active', 'pending'])

/** One event-log entry as an activity item; undefined for what the pane does not show or cannot read. */
export function eventItem(entry: unknown): ActivityItem | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as Record<string, unknown>
  const parsed = typeof e.t === 'string' ? Date.parse(e.t) : Number.NaN
  const t = Number.isNaN(parsed) ? {} : { t: parsed }
  const id = text(e.id) ? { id: e.id as string } : {}
  const name = text(e.name) ?? 'tool'
  switch (e.type) {
    case 'state': {
      const state = text(e.state)
      return state && !state.startsWith('running ') ? { ...t, kind: 'state', text: state } : undefined
    }
    case 'heading':
      return text(e.text) ? { ...t, kind: 'heading', text: e.text as string } : undefined
    case 'tool':
      return { ...t, kind: 'tool', name, ...id, ...(text(e.intent) ? { intent: e.intent as string } : {}), ...(text(e.arg) ? { arg: e.arg as string } : {}) }
    case 'tool-end':
      return { ...t, kind: 'tool-end', name, ...id, ...(e.error === true ? { failed: true } : {}) }
    case 'text':
      return text(e.text) ? { ...t, kind: 'text', text: e.text as string } : undefined
    case 'subagents':
      return { ...t, kind: 'subagents', names: Array.isArray(e.agents) ? e.agents.filter((a): a is string => typeof a === 'string') : [] }
    case 'todo': {
      const todos = Array.isArray(e.todos) ? e.todos.filter((x: any): x is TodoItem => typeof x?.text === 'string' && TODO_STATES.has(x.state)) : []
      return todos.length ? { ...t, kind: 'todo', todos } : undefined
    }
    case 'exit':
      return { ...t, kind: 'exit', ...(typeof e.code === 'number' ? { code: e.code } : {}) }
  }
  return undefined
}

/** A line of events.jsonl as an activity item; undefined for a blank or broken line. */
export function eventLine(line: string): ActivityItem | undefined {
  if (!line.trim()) return undefined
  try {
    return eventItem(JSON.parse(line))
  } catch {
    return undefined
  }
}
