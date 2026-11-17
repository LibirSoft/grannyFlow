import { FIX_COSTS, IMPACTS, LIKELIHOODS, SCOPES, VERDICTS } from '../core/types'
import type { TrailRound } from '../core/types'

const SAFE = /^[A-Za-z0-9._-]+$/
/** A full commit id: an abbreviation may be ambiguous, and a platform takes it as given. */
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/i
const TAGS: Record<string, readonly string[]> = { verdict: VERDICTS, impact: IMPACTS, likelihood: LIKELIHOODS, fixCost: FIX_COSTS, scope: SCOPES }
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
  if (!optional(value.reviewedSha, v => isString(v) && SHA.test(v))) return 'reviewedSha is not a full commit id'
  if (!Array.isArray(value.reviewers) || !value.reviewers.every(r => isObject(r) && isString(r.name))) return 'reviewers is not a list of named reviewers'
  if (!Array.isArray(value.findings)) return 'findings is not a list'
  for (const [i, f] of value.findings.entries()) {
    const at = `findings[${i}]`
    if (!isObject(f)) return `${at} is not an object`
    if (!isString(f.id) || !SAFE.test(f.id)) return `${at}.id is missing or not a plain id`
    for (const key of ['severity', 'file', 'title', 'detail']) if (!isString(f[key])) return `${at}.${key} is not a string`
    if (!optional(f.line, isCount)) return `${at}.line is not a positive integer`
    for (const [key, known] of Object.entries(TAGS)) if (!optional(f[key], v => known.includes(v as string))) return `${at}.${key} ${JSON.stringify(f[key])} is unknown`
    if (!optional(f.priority, v => typeof v === 'number' && Number.isFinite(v))) return `${at}.priority is not a number`
    if (!optional(f.tag, isString)) return `${at}.tag is not a string`
    if (!optional(f.reviewer, isString)) return `${at}.reviewer is not a string`
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

/** A directory of this machine, and what stands in for it in posted text: '' reads a path under it from the repo root; `flat` keeps only the file name of a path under it. */
export type LocalRoot = [path: string, as: string, flat?: boolean]

/** `value` with every string freed of the roots, longest first: `<root>/x` reads `<as>/x` (or `x`), a bare `<root>` reads `<as>` (or `.`). */
export function withoutLocalPaths<T>(value: T, roots: LocalRoot[]): T {
  const part = '[^\\s/\'"`)\\],;:]'
  const cuts = roots
    .map(([path, as, flat]) => [path.replace(/\/+$/, ''), as, flat] as const)
    .filter(([path]) => path.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([path, as, flat]) => [new RegExp(`(?<![\\w.~-])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)${flat ? `((?:/${part}+)*)` : `(/(?=${part}))?`}`, 'g'), as, flat] as const)
  const cut = (as: string, flat: boolean | undefined, rest: string | undefined) => (!rest ? as || '.' : flat ? `${as}/${rest.slice(rest.lastIndexOf('/') + 1)}` : as ? `${as}/` : '')
  const clean = (text: string) => cuts.reduce((t, [at, as, flat]) => t.replace(at, (_, rest?: string) => cut(as, flat, rest)), text)
  const walk = (v: unknown): unknown => (isString(v) ? clean(v) : Array.isArray(v) ? v.map(walk) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v)
  return walk(value) as T
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
