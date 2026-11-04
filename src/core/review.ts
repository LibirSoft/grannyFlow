import { FIX_COSTS, IMPACTS, LIKELIHOODS, SCOPES, VERDICTS } from './types'
import type { Decision, Declined, Finding, FixCost, Impact, Likelihood } from './types'

const MARKER = /^\s*[-*]\s*\[(P[0-3]|[A-Za-z]+)\](.*)$/
const WORD_SEVERITY = new Map([['critical', 'P0'], ['high', 'P1'], ['medium', 'P2'], ['low', 'P3']])
const LOCATION = /^(.+?)(?::(\d+)(?:-\d+)?)?$/
const PAREN_LOCATION = /^(.*\S)\s+\(([^()]+)\)$/
const FAILED_RENDER =
  /^Codex (?:did not return valid structured JSON|returned JSON with an unexpected review shape|review completed without any stdout output|did not return a final message)\.$/m

export interface ParsedReview {
  findings: Finding[]
  markers: number
}

export function parseCodexReview(text: string, repo?: string): ParsedReview {
  const findings: Finding[] = []
  let markers = 0
  let item: { indent: number; finding: Finding | null } | null = null

  for (const line of text.split(/\r\n?|\n/)) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (item && indent > item.indent) {
      const f = item.finding
      if (f) f.detail = f.detail ? `${f.detail}\n${line.trim()}` : line.trim()
      continue
    }
    const marker = MARKER.exec(line)
    const word = marker ? WORD_SEVERITY.get(marker[1]!.toLowerCase()) : undefined
    if (!marker || (!word && !/^P[0-3]$/.test(marker[1]!))) {
      item = null
      continue
    }
    markers++
    const finding = toFinding(word ?? marker[1]!, word !== undefined, marker[2]!.trim(), findings.length + 1, repo)
    if (finding) findings.push(finding)
    item = { indent, finding }
  }
  return { findings, markers }
}

function split(rest: string, paren: boolean): [string, string] | null {
  const inParens = paren ? PAREN_LOCATION.exec(rest) : null
  if (inParens) return [inParens[1]!, inParens[2]!]
  const sep = rest.lastIndexOf(' — ')
  return sep < 0 ? null : [rest.slice(0, sep), rest.slice(sep + 3)]
}

function toFinding(severity: string, paren: boolean, rest: string, n: number, repo?: string): Finding | null {
  const parts = split(rest, paren)
  if (!parts) return null
  const title = parts[0].trim()
  const loc = LOCATION.exec(parts[1].trim())
  if (!title || !loc) return null
  let file = loc[1]!.trim()
  if (repo && file.startsWith(repo.replace(/\/$/, '') + '/')) file = file.slice(repo.replace(/\/$/, '').length + 1)
  const finding: Finding = { id: `F${n}`, severity, file, title, detail: '' }
  if (loc[2]) finding.line = Number(loc[2])
  return finding
}

const NO_FINDINGS = /^no (?:material )?findings\.?$/i
const BACKEND_LINE = /^\[granny\] reviewer: /
const PLUGIN_HEADING = /^# Codex (?:Adversarial )?Review$/
const PLUGIN_LIST = /^(?:Next steps|Reasoning):$/

// The Codex plugin's structured render prints `No material findings.` because its findings array is empty; the
// one-paragraph summary before it and the `Next steps:` / `Reasoning:` bullet lists after it are part of its frame.
function approvedRender(lines: string[]): string[] | undefined {
  if (lines[0] !== 'Verdict: approve') return undefined
  let end = lines.length
  for (;;) {
    while (end > 1 && !lines[end - 1]) end--
    let start = end
    while (start > 1 && lines[start - 1]!.startsWith('- ')) start--
    if (start === end || !PLUGIN_LIST.test(lines[start - 1] ?? '') || lines[start - 2] !== '') break
    end = start - 1
  }
  const sentence = lines[end - 1] ?? ''
  if (end < 3 || !NO_FINDINGS.test(sentence) || lines[end - 2] !== '') return undefined
  const summary = lines.slice(1, end - 2)
  while (summary[0] === '') summary.shift()
  return summary.includes('') ? undefined : [sentence]
}

/** A review without finding bullets is clean only when, without a known wrapper, it is the no-findings sentence alone. */
export function saysNoFindings(text: string): boolean {
  let lines = text.split(/\r\n?|\n/).map(line => line.trim())
  while (lines.length && (!lines[0] || BACKEND_LINE.test(lines[0]))) lines.shift()
  if (PLUGIN_HEADING.test(lines[0] ?? '')) {
    let target = 1
    while (target < lines.length && !lines[target]) target++
    if (!lines[target]?.startsWith('Target: ')) return false
    lines = lines.slice(target + 1)
    lines = approvedRender(lines) ?? lines
  }
  const left = lines.filter(Boolean)
  return left.length === 1 && NO_FINDINGS.test(left[0]!)
}

export function reviewFailure(text: string): string | undefined {
  return FAILED_RENDER.exec(text)?.[0]
}

export const isBlocker =(f: Pick<Finding, 'severity'>): boolean =>
  /^\s*(p0|p1|critical|high)\b/i.test(String(f.severity ?? ''))

const JUDGED = ['verdict', 'impact', 'likelihood', 'fixCost', 'scope', 'evidence', 'score', 'priority', 'reason', 'decision'] as const

const fixes = (f: Finding) => f.decision?.action !== 'residual'
const rank = (f: Finding) => f.priority ?? f.score ?? -1

/** Of merged copies the strongest one's judgement wins: a fix one first, then the higher priority. */
export function mergeDuplicates(findings: Finding[], duplicateOf: Map<string, string>): { findings: Finding[]; merged: Array<{ id: string; into: string }> } {
  const ids = new Set(findings.map(f => f.id))
  const keeper = (id: string): string => {
    const seen = new Set([id])
    for (let current = id; ; ) {
      const next = duplicateOf.get(current)
      if (next === undefined || !ids.has(next)) return current
      if (seen.has(next)) return id
      seen.add(next)
      current = next
    }
  }
  const into = new Map<string, string>()
  for (const f of findings) {
    const k = keeper(f.id)
    if (k !== f.id) into.set(f.id, k)
  }
  const kept = findings
    .filter(f => !into.has(f.id))
    .map(f => {
      const dups = findings.filter(d => into.get(d.id) === f.id)
      if (!dups.length) return f
      const top = [f, ...dups].reduce((a, b) => (fixes(b) !== fixes(a) ? (fixes(b) ? b : a) : rank(b) > rank(a) ? b : a))
      const merged: Finding = { ...f, duplicates: dups.map(d => d.id) }
      for (const key of JUDGED) {
        if (top[key] === undefined) delete merged[key]
        else (merged as unknown as Record<string, unknown>)[key] = top[key]
      }
      return merged
    })
  return { findings: kept, merged: [...into].map(([id, k]) => ({ id, into: k })) }
}

export interface Policy {
  threshold: number
  alwaysFix: Impact[]
}

const PRIORITY: Record<Impact, Record<Likelihood, number>> = {
  critical: { common: 100, edge: 95, rare: 90 },
  major: { common: 90, edge: 80, rare: 65 },
  moderate: { common: 75, edge: 55, rare: 35 },
  minor: { common: 35, edge: 25, rare: 15 },
  none: { common: 0, edge: 0, rare: 0 },
}
const COST: Record<FixCost, number> = { trivial: 15, small: 0, large: -15 }

export function priorityOf(impact: Impact, likelihood: Likelihood, fixCost: FixCost): number {
  if (impact === 'none') return 0
  return Math.max(0, Math.min(100, PRIORITY[impact][likelihood] + COST[fixCost]))
}

const PATH_LINE = /\S+:\d+/
const ENUMS = { verdict: VERDICTS, impact: IMPACTS, likelihood: LIKELIHOODS, fixCost: FIX_COSTS, scope: SCOPES } as const
const lower = (impact: Impact): Impact => IMPACTS[Math.min(IMPACTS.indexOf(impact) + 1, IMPACTS.length - 1)]!

type Classified =
  | { kind: 'classified'; fields: Required<Pick<Finding, 'verdict' | 'impact' | 'likelihood' | 'fixCost' | 'scope' | 'evidence'>>; note: string }
  | { kind: 'score'; score: number }
  | { kind: 'none'; why: string }

function classify(entry: Record<string, unknown> | undefined): Classified {
  if (!entry) return { kind: 'none', why: 'not judged' }
  const keys = [...Object.keys(ENUMS), 'evidence'] as const
  if (keys.every(k => entry[k] === undefined)) {
    return typeof entry.score === 'number' && Number.isFinite(entry.score) ? { kind: 'score', score: entry.score } : { kind: 'none', why: 'not judged' }
  }
  const problems: string[] = []
  for (const [key, values] of Object.entries(ENUMS)) {
    const v = entry[key]
    if (v === undefined) problems.push(`${key} missing`)
    else if (!(values as readonly unknown[]).includes(v)) problems.push(`${key} ${JSON.stringify(v)}`)
  }
  const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : ''
  if (!evidence) problems.push(entry.evidence === undefined ? 'evidence missing' : `evidence ${JSON.stringify(entry.evidence)}`)
  if (problems.length) return { kind: 'none', why: `invalid classification: ${problems.join(', ')}` }
  const fields = { ...(entry as Required<Pick<Finding, 'verdict' | 'impact' | 'likelihood' | 'fixCost' | 'scope'>>), evidence }
  let note = ''
  if (fields.verdict !== 'unverified' && !PATH_LINE.test(evidence)) {
    fields.verdict = 'unverified'
    note = 'no path:line in the evidence, so unverified: '
  }
  if (fields.verdict === 'unverified' && fields.impact !== 'none') {
    note = ` - ${note || 'unverified: '}impact lowered from ${fields.impact}`
    fields.impact = lower(fields.impact)
  } else note = ''
  return {
    kind: 'classified',
    fields: { verdict: fields.verdict, impact: fields.impact, likelihood: fields.likelihood, fixCost: fields.fixCost, scope: fields.scope, evidence },
    note,
  }
}

/** The file:line spots evidence cites, by file name, so `a.ts:3` and src/a.ts:3 are one spot. */
const pathLines = (evidence = ''): string[] => (evidence.match(/[^\s`'"()[\]{}<>,;]+:\d+/g) ?? []).map(t => t.split('/').pop()!)

/**
 * A repeat cannot drop below the earlier entry's impact and likelihood (both lists run worst first) unless it is
 * refuted with a path:line the earlier evidence did not have. Returns what it raised.
 */
function ratchet(fields: { verdict: string; impact: Impact; likelihood: Likelihood; evidence: string }, label: string, earlier: Finding): string | undefined {
  if (!earlier.impact || !earlier.likelihood) return undefined
  const before = pathLines(earlier.evidence)
  if (fields.verdict === 'refuted' && pathLines(fields.evidence).some(p => !before.includes(p))) return undefined
  const raised: string[] = []
  if (IMPACTS.indexOf(fields.impact) > IMPACTS.indexOf(earlier.impact)) {
    raised.push(`impact ${fields.impact} -> ${earlier.impact}`)
    fields.impact = earlier.impact
  }
  if (LIKELIHOODS.indexOf(fields.likelihood) > LIKELIHOODS.indexOf(earlier.likelihood)) {
    raised.push(`likelihood ${fields.likelihood} -> ${earlier.likelihood}`)
    fields.likelihood = earlier.likelihood
  }
  return raised.length ? `repeat of ${label}: ${raised.join(', ')}` : undefined
}

/**
 * Applies the judge's entry for a finding (undefined when the judge did not judge it) and the decision table: the first
 * matching rule wins. A finding the judge scored the old way (a number, no classification) is cut by the threshold.
 * earlierOf finds the ledger entry a repeat names, for the ratchet.
 */
export function decide(
  f: Finding,
  entry: Record<string, unknown> | undefined,
  policy: Policy,
  repeatsDeclined: (f: Finding) => boolean = () => false,
  earlierOf: (f: Finding) => Finding | undefined = () => undefined,
): Finding {
  const out: Finding = { ...f }
  for (const key of JUDGED) delete out[key]
  if (typeof entry?.reason === 'string') out.reason = entry.reason
  const c = classify(entry)
  let raised: string | undefined
  const done = (rule: number, action: Decision['action'], why: string, attention?: boolean): Finding => ({
    ...out,
    decision: { rule, action, why, ...(attention ? { attention: true as const } : {}), ...(raised ? { raised } : {}) },
  })
  if (c.kind === 'classified') {
    const earlier = f.repeatOf === undefined ? undefined : earlierOf(f)
    if (earlier) raised = ratchet(c.fields, f.repeatOf!, earlier)
    Object.assign(out, c.fields)
    out.priority = priorityOf(c.fields.impact, c.fields.likelihood, c.fields.fixCost)
  } else if (c.kind === 'score') out.score = c.score
  if (isBlocker(f) && !repeatsDeclined(out)) return done(1, 'fix', 'P0/P1')
  if (c.kind === 'none') return done(2, 'fix', c.why)
  if (c.kind === 'score') {
    return c.score > policy.threshold
      ? done(7, 'fix', `score ${c.score} > threshold ${policy.threshold} (numeric score, no classification)`)
      : done(8, 'residual', `under the bar: score ${c.score} (numeric score, no classification)`)
  }
  const { verdict, impact, likelihood, fixCost, scope } = c.fields
  const p = out.priority!
  const classes = `${impact}/${likelihood}/${fixCost}`
  if (verdict === 'refuted') return done(3, 'residual', 'refuted')
  if (scope === 'other-stage') return done(4, 'residual', 'left to the stage that owns it')
  if (scope === 'pre-existing') {
    const attention = impact === 'critical' || impact === 'major'
    return done(5, 'residual', attention ? `pre-existing - ATTENTION: impact ${impact}` : 'pre-existing', attention)
  }
  if (policy.alwaysFix.includes(impact)) return done(6, 'fix', `impact ${impact} is in alwaysFix (${classes} -> ${p})${c.note}`)
  if (p > policy.threshold) return done(7, 'fix', `priority ${p} > threshold ${policy.threshold} (${classes})${c.note}`)
  return done(8, 'residual', `under the bar: ${classes} -> ${p}${c.note}`)
}

/** Splits decided findings; one without a decision is fixed. */
export function triage(findings: Finding[]): { accepted: Finding[]; residual: Finding[] } {
  return { accepted: findings.filter(fixes), residual: findings.filter(f => !fixes(f)) }
}

export function declinedOf(value: unknown, sent: Finding[]): { declined: Declined[]; unknown: string[] } {
  const declined: Declined[] = []
  const unknown: string[] = []
  for (const d of Array.isArray(value) ? value : []) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') continue
    const f = sent.find(s => s.id === d.id || s.duplicates?.includes(d.id))
    if (!f) unknown.push(d.id)
    else if (!declined.some(x => x.id === f.id)) declined.push({ id: f.id, reason: typeof d.reason === 'string' ? d.reason.trim() : '' })
  }
  return { declined, unknown }
}
