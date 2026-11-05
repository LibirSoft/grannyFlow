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

const dateOf = (value: unknown) => new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN)

export function stamp(value: unknown): string | undefined {
  const d = dateOf(value)
  return Number.isNaN(d.getTime()) ? undefined : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`
}
