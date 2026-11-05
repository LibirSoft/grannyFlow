// Text helpers shared by the omp watch log, transcript and navigator.
export { clock } from '../runview/format'

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

export const clean = (text: string) => text.replace(/\t/g, '  ').replace(ANSI, '').replace(CONTROL, '')

const dateOf = (value: unknown) => new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN)

export function stamp(value: unknown): string | undefined {
  const d = dateOf(value)
  return Number.isNaN(d.getTime()) ? undefined : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`
}
