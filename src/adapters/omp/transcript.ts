// A role's omp session file (`sessions/<n>-<label>/<time>_<uuid>.jsonl`) as readable lines, one
// session entry at a time.

const MAX_ENTRY_CHARS = 2 * 1024 * 1024
const PROMPT_LINES = 12
const THINKING_LINES = 3
const RESULT_LINES = 8
const ARGS_CHARS = 300
const PAD = ' '.repeat(10)

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

const clean = (text: string) => text.replace(/\t/g, '  ').replace(ANSI, '').replace(CONTROL, '')

const split = (text: string) => clean(text).split('\n')

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function clock(value: unknown): string {
  const d = new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8)
}

function head(lines: string[], max: number, indent: string, tail = ''): string[] {
  const out = lines.slice(0, max).map(l => `${indent}${l}`)
  if (lines.length > max) out.push(`${indent}… ${lines.length - max} more lines${tail}`)
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
}

function toolCall(part: any): string[] {
  const args = part?.arguments && typeof part.arguments === 'object' ? { ...part.arguments } : {}
  const intent = typeof part?.intent === 'string' && part.intent.trim() ? part.intent : typeof args.i === 'string' && args.i.trim() ? args.i : undefined
  delete args.i
  delete args.intent
  let json: string
  try {
    json = JSON.stringify(args) ?? ''
  } catch {
    json = ''
  }
  const name = clean(String(part?.name ?? 'tool'))
  return [`▸ ${name}${intent ? `: ${clean(intent).replace(/\s+/g, ' ').trim()}` : ''}`, `  ${cut(clean(json), ARGS_CHARS)}`]
}

function assistant(message: any): string[] {
  const out: string[] = []
  const parts = Array.isArray(message?.content) ? message.content : []
  for (const part of parts) {
    if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
      const lines = split(part.thinking.trim())
      if (part.summary === true) {
        const [first, ...rest] = lines.map(l => l.replace(/\*\*/g, ''))
        out.push(`» ${first}`, ...rest.map(l => `  ${l}`))
      } else out.push('∴ thinking', ...head(lines, THINKING_LINES, '  '))
    } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      const [first, ...rest] = split(part.text.trim())
      out.push(`✎ ${first}`, ...rest.map(l => `  ${l}`))
    } else if (part?.type === 'toolCall') out.push(...toolCall(part))
  }
  if (message?.stopReason === 'error') out.push(`✗ error: ${clean(String(message.errorMessage ?? 'unknown error'))}`)
  return out
}

function toolResult(message: any): string[] {
  const out = [`  ← ${clean(String(message?.toolName ?? 'tool'))} ${message?.isError === true ? '✗' : '✓'}`]
  const parts = Array.isArray(message?.content) ? message.content : []
  const text = textOf(parts)
  if (text) out.push(...head(split(text), RESULT_LINES, '    ', ` (${text.length} chars)`))
  for (const part of parts) if (part?.type === 'image') out.push('    [image]')
  return out
}

function messageLines(message: any): string[] {
  switch (message?.role) {
    case 'user':
      return ['▶ prompt', ...head(split(textOf(message.content).trim()), PROMPT_LINES, '  ')]
    case 'assistant':
      return assistant(message)
    case 'toolResult':
      return toolResult(message)
  }
  return []
}

/** One session JSONL line as readable lines; anything it does not know renders nothing. */
export function sessionEntryLines(line: string): string[] {
  if (line.length > MAX_ENTRY_CHARS) return [`(entry of ${Math.round(line.length / 1024)} KB not shown)`]
  if (!line.trim()) return []
  let entry: any
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  switch (entry?.type) {
    case 'session':
      return [`── session ${clean(String(entry.id ?? '?'))} · ${clean(String(entry.cwd ?? ''))}`]
    case 'model_change':
      return [`· model ${clean(String(entry.model ?? '?'))}`]
    case 'thinking_level_change':
      return [`· thinking ${clean(String(entry.thinkingLevel ?? '?'))}`]
    case 'message': {
      const lines = messageLines(entry.message)
      return lines.map((l, i) => (i === 0 ? `${clock(entry.timestamp)}  ${l}` : `${PAD}${l}`))
    }
  }
  return []
}

/** The last `max` lines of a view; when it dropped some, `lines()` says so first. */
export class LineBuffer {
  dropped = 0
  version = 0
  private kept: string[] = []
  private view?: string[]

  constructor(private readonly max = 5000) {}

  push(lines: readonly string[]) {
    if (!lines.length) return
    for (const line of lines) this.kept.push(line)
    if (this.kept.length > this.max) {
      const over = this.kept.length - this.max
      this.kept.splice(0, over)
      this.dropped += over
    }
    this.view = undefined
    this.version++
  }

  lines(): string[] {
    this.view ??= this.dropped ? [`… ${this.dropped} earlier lines not kept`, ...this.kept] : this.kept.slice()
    return this.view
  }
}
