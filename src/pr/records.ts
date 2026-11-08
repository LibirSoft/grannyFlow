import type { TrailRound } from '../core/types'

const SAFE = /^[A-Za-z0-9._-]+$/
const SHA = /^[0-9a-f]{4,64}$/i
const ROUTES = ['sent', 'residual']
const OUTCOMES = ['clean', 'residual-only', 'round-cap', 'review-failed', 'checks-failed']

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) > 0
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v)

/** Why `value` is not a trail record the poster can use, or undefined when it is one. */
export function trailProblem(value: unknown): string | undefined {
  if (!isObject(value)) return 'not a JSON object'
  if (value.version !== 1) return `version ${JSON.stringify(value.version)} is not 1`
  if (!isString(value.loop) || !SAFE.test(value.loop)) return 'loop is missing or not a plain id'
  if (!isString(value.name)) return 'name is missing'
  if (!isCount(value.round)) return 'round is not a positive integer'
  if (!isString(value.base)) return 'base is missing'
  if (!optional(value.reviewedSha, v => isString(v) && SHA.test(v))) return 'reviewedSha is not a commit id'
  if (!Array.isArray(value.reviewers) || !value.reviewers.every(r => isObject(r) && isString(r.name))) return 'reviewers is not a list of named reviewers'
  if (!Array.isArray(value.findings)) return 'findings is not a list'
  for (const [i, f] of value.findings.entries()) {
    const at = `findings[${i}]`
    if (!isObject(f)) return `${at} is not an object`
    if (!isString(f.id) || !SAFE.test(f.id)) return `${at}.id is missing or not a plain id`
    for (const key of ['severity', 'file', 'title', 'detail']) if (!isString(f[key])) return `${at}.${key} is not a string`
    if (!optional(f.line, isCount)) return `${at}.line is not a positive integer`
    if (!optional(f.route, v => ROUTES.includes(v as string))) return `${at}.route is not sent or residual`
    if (!optional(f.decision, d => isObject(d) && Number.isInteger(d.rule) && isString(d.action) && isString(d.why))) return `${at}.decision is malformed`
    if (!optional(f.duplicates, d => Array.isArray(d) && d.every(isString))) return `${at}.duplicates is not a list of ids`
  }
  const fix = value.fix
  if (!optional(fix, v => isObject(v) && isString(v.label))) return 'fix has no label'
  if (fix && !optional(fix.commits, c => Array.isArray(c))) return 'fix.commits is not a list'
  if (fix && !optional(fix.declined, d => Array.isArray(d) && d.every(x => isObject(x) && isString(x.id)))) return 'fix.declined is malformed'
  if (!optional(value.outcome, v => OUTCOMES.includes(v as string))) return `outcome ${JSON.stringify(value.outcome)} is unknown`
  return undefined
}

function loopRank(loop: string): [number, number, string] {
  if (loop === 'plan') return [0, 0, '']
  const stage = /^s(\d+)$/.exec(loop)
  if (stage) return [1, Number(stage[1]), '']
  if (loop === 'final') return [2, 0, '']
  return [3, 0, loop]
}

/** Plan review, then the stages by number, then the final reviews; rounds ascending. */
export function byTrailOrder(a: TrailRound, b: TrailRound): number {
  const [ka, na, sa] = loopRank(a.loop)
  const [kb, nb, sb] = loopRank(b.loop)
  return ka - kb || na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0) || a.round - b.round
}
