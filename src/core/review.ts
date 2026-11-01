import type { Finding } from './types'

const MARKER = /^\s*[-*]\s*\[(P[0-3])\](.*)$/
const LOCATION = /^(.+?)(?::(\d+)(?:-\d+)?)?$/

export interface ParsedReview {
  findings: Finding[]
  markers: number
}

export function parseCodexReview(text: string, repo?: string): ParsedReview {
  const findings: Finding[] = []
  let markers = 0
  let item: { indent: number; finding: Finding | null } | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (item && indent > item.indent) {
      const f = item.finding
      if (f) f.detail = f.detail ? `${f.detail}\n${line.trim()}` : line.trim()
      continue
    }
    const marker = MARKER.exec(line)
    if (!marker) {
      item = null
      continue
    }
    markers++
    const finding = toFinding(marker[1]!, marker[2]!.trim(), findings.length + 1, repo)
    if (finding) findings.push(finding)
    item = { indent, finding }
  }
  return { findings, markers }
}

function toFinding(severity: string, rest: string, n: number, repo?: string): Finding | null {
  const sep = rest.lastIndexOf(' — ')
  if (sep < 0) return null
  const title = rest.slice(0, sep).trim()
  const loc = LOCATION.exec(rest.slice(sep + 3).trim())
  if (!title || !loc) return null
  let file = loc[1]!.trim()
  if (repo && file.startsWith(repo.replace(/\/$/, '') + '/')) file = file.slice(repo.replace(/\/$/, '').length + 1)
  const finding: Finding = { id: `F${n}`, severity, file, title, detail: '' }
  if (loc[2]) finding.line = Number(loc[2])
  return finding
}

export const isBlocker = (f: Pick<Finding, 'severity'>): boolean =>
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
