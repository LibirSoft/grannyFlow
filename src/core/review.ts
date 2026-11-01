import type { Finding } from './types'

const MARKER = /^\s*[-*]\s*\[(P[0-3]|[A-Za-z]+)\](.*)$/
const WORD_SEVERITY = new Map([['critical', 'P0'], ['high', 'P1'], ['medium', 'P2'], ['low', 'P3']])
const LOCATION = /^(.+?)(?::(\d+)(?:-\d+)?)?$/
const PAREN_LOCATION = /^(.*\S)\s+\(([^()]+)\)$/
const FAILED_RENDER = /^Codex (?:did not return valid structured JSON|returned JSON with an unexpected review shape)\.$/m

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

export function reviewFailure(text: string): string | undefined {
  return FAILED_RENDER.exec(text)?.[0]
}

export const isBlocker =(f: Pick<Finding, 'severity'>): boolean =>
  /^\s*(p0|p1|critical|high)\b/i.test(String(f.severity ?? ''))

export function triage(findings: Finding[], threshold: number): { accepted: Finding[]; residual: Finding[] } {
  const accepted: Finding[] = []
  const residual: Finding[] = []
  for (const f of findings) {
    if (isBlocker(f) || f.score === undefined || f.score > threshold) accepted.push(f)
    else residual.push(f)
  }
  return { accepted, residual }
}
