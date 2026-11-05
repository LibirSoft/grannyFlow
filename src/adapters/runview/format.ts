// Time and text helpers shared by every host's run view.

export function clock(value: unknown): string {
  const d = new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8)
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

export const clean = (text: string) => text.replace(/\t/g, '  ').replace(ANSI, '').replace(CONTROL, '')

/** `text` cut with … to `width` columns; the one cut every run view uses. */
export function fit(text: string, width: number): string {
  const flat = text.replace(/\t/g, '  ')
  if (width < 1) return ''
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

export const pad = (text: string, width: number) => fit(text, width).padEnd(Math.max(0, width))

/** `provider/id#variant` as `id`, `/variant` unless it is `default`, then `/effort`. */
export function shortModel(model?: string, effort?: string): string {
  if (!model) return effort ? `default model/${effort}` : 'default model'
  const [main = '', variant] = model.split('#')
  const id = main.slice(main.lastIndexOf('/') + 1)
  return [id, variant && variant !== 'default' ? variant : undefined, effort].filter(Boolean).join('/')
}

const CD = /^cd\s+('(?:[^']|'\\'')*'|"[^"]*"|\S+)\s*&&\s*/
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BOUNDARY = `(^|[\\s'"=(:])`

/** A tool argument without a leading `cd <dir> && `, with paths under `cwd` relative and under `home` as `~/…`, on one line; never cut. */
export function shortArg(text: string, cwd?: string, home?: string): string {
  let out = clean(text).trim().replace(CD, '')
  const dir = cwd?.replace(/\/+$/, '')
  if (dir) {
    out = out.replace(new RegExp(`${BOUNDARY}${escape(dir)}/`, 'g'), '$1').replace(new RegExp(`${BOUNDARY}${escape(dir)}(?=$|[\\s'"])`, 'g'), '$1.')
  }
  const root = home?.replace(/\/+$/, '')
  if (root) out = out.replace(new RegExp(`${BOUNDARY}${escape(root)}/`, 'g'), '$1~/')
  return out.replace(/\s+/g, ' ').trim()
}

const dateOf = (value: unknown) => new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN)

export function stamp(value: unknown): string | undefined {
  const d = dateOf(value)
  return Number.isNaN(d.getTime()) ? undefined : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`
}
