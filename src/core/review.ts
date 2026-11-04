import type { Declined, Finding } from './types'

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
      const group = [f, ...dups]
      const merged: Finding = { ...f, duplicates: dups.map(d => d.id) }
      if (group.some(g => g.score === undefined)) {
        delete merged.score
        delete merged.reason
      } else {
        const top = group.reduce((a, b) => (b.score! > a.score! ? b : a))
        merged.score = top.score
        merged.reason = top.reason
      }
      return merged
    })
  return { findings: kept, merged: [...into].map(([id, k]) => ({ id, into: k })) }
}

export function triage(findings: Finding[], threshold: number, repeatsDeclined: (f: Finding) => boolean = () => false): { accepted: Finding[]; residual: Finding[] } {
  const accepted: Finding[] = []
  const residual: Finding[] = []
  for (const f of findings) {
    if ((isBlocker(f) && !repeatsDeclined(f)) || f.score === undefined || f.score > threshold) accepted.push(f)
    else residual.push(f)
  }
  return { accepted, residual }
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
