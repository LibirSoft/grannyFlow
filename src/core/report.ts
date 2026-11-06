import type { Finding, Impact, JudgeCounts, ReportBucket } from './types'

const HEADINGS: Record<Exclude<Impact, 'none'>, ReportBucket> = { critical: 'P0', major: 'P1', moderate: 'P2', minor: 'P3' }
const P_HEADINGS = ['P0', 'P1', 'P2', 'P3'] as const
const ORDER: ReportBucket[] = [...P_HEADINGS, 'dismissed']
const NOTE_LENGTH = 300

const oneLine = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** The reviewer's own heading: its P number, and P2 for a severity without one. */
export function severityOf(f: Pick<Finding, 'severity'>): (typeof P_HEADINGS)[number] {
  const n = /^\s*p([0-3])\b/i.exec(String(f.severity ?? ''))?.[1]
  return n === undefined ? 'P2' : P_HEADINGS[Number(n)]!
}

export const isJudged = (f: Pick<Finding, 'impact'>) => f.impact !== undefined

/** The judge's classification decides the heading; a finding it left unclassified keeps the reviewer's severity. */
export function bucketOf(f: Finding): ReportBucket {
  if (f.impact === undefined) return severityOf(f)
  return f.verdict === 'refuted' || f.impact === 'none' ? 'dismissed' : HEADINGS[f.impact]
}

export const isDemoted = (f: Finding) => ORDER.indexOf(bucketOf(f)) > ORDER.indexOf(severityOf(f))

export function countsOf(findings: Finding[]): JudgeCounts {
  const counts: JudgeCounts = { P0: 0, P1: 0, P2: 0, P3: 0, dismissed: 0 }
  for (const f of findings) counts[bucketOf(f)]++
  return counts
}

/** UTF-8 bytes of a string, what `wc -c` says of the file: the Workflow sandbox may have no TextEncoder. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return bytes
}

export interface ReportMeta {
  branch: string
  base: string
  head: string
  commits: number
  repo: string
  when: string
  reviewers: Array<{ name: string; engine: string; model?: string }>
  judge?: string
  uncommitted: string[]
  failed: Array<{ name: string; note: string }>
}

const code = (text: string) => `\`${text}\``

function tags(f: Finding): string {
  const reviewer = `${code(`reviewer: ${severityOf(f)}`)}${isDemoted(f) ? ` ${code('demoted')}` : ''}`
  const place = f.file ? [code(f.line === undefined ? f.file : `${f.file}:${f.line}`)] : []
  const judged = isJudged(f)
    ? [[f.verdict!, f.impact!, f.likelihood!, f.fixCost!, f.scope!].map(code).join(' '), `priority ${f.priority}`]
    : [code('not judged')]
  const from = `from ${[f.id, ...(f.duplicates ?? [])].map(code).join(', ')}`
  return [...place, ...judged, reviewer, from].join(' · ')
}

function section(f: Finding): string {
  return [
    `### ${oneLine(f.title) || '(no title)'}`,
    tags(f),
    ...(String(f.detail ?? '').trim() ? [String(f.detail).trim()] : []),
    ...(f.evidence ? [`**Evidence:** ${f.evidence}`] : []),
    ...(f.reason?.trim() ? [`**Judge:** ${f.reason.trim()}`] : []),
  ].join('\n\n')
}

const byPriority = (a: Finding, b: Finding) =>
  (b.priority ?? -1) - (a.priority ?? -1) || (a.file === b.file ? 0 : a.file < b.file ? -1 : 1) || (a.line ?? 0) - (b.line ?? 0)

function heading(title: string, findings: Finding[]): string {
  return [`## ${title}`, ...(findings.length ? [...findings].sort(byPriority).map(section) : ['None.'])].join('\n\n')
}

export function renderReport(meta: ReportMeta, findings: Finding[]): string {
  const of = (bucket: ReportBucket) => findings.filter(f => bucketOf(f) === bucket)
  const c = countsOf(findings)
  const unjudged = findings.filter(f => !isJudged(f)).length
  const reviewer = (r: ReportMeta['reviewers'][number]) => `${r.name} (${r.engine}${r.model ? `, ${r.model}` : ''})`
  const header = [
    `- Reviewed: ${code(`${meta.base}...HEAD`)} at ${meta.head}, ${meta.commits} commit(s), in ${meta.repo}`,
    `- When: ${meta.when}`,
    `- Reviewers: ${meta.reviewers.map(reviewer).join(', ')} · Judge: ${meta.judge ?? 'none'}`,
    `- Totals: P0 ${c.P0}, P1 ${c.P1}, P2 ${c.P2}, P3 ${c.P3}, dismissed ${c.dismissed}`,
    ...(meta.uncommitted.length ? [`- Not reviewed: ${meta.uncommitted.join(', ')}`] : []),
    ...meta.failed.map(r => `- Did not run: ${r.name}: ${oneLine(r.note).slice(0, NOTE_LENGTH)}`),
    ...(unjudged ? [`- Not judged: the judge left ${unjudged} finding(s) unclassified; they stay under the reviewer's severity`] : []),
  ]
  return [
    `# Granny judge - ${meta.branch}`,
    header.join('\n'),
    ...P_HEADINGS.map(p => heading(p, of(p))),
    ...(c.dismissed ? [heading('Dismissed by the judge', of('dismissed'))] : []),
  ].join('\n\n') + '\n'
}
