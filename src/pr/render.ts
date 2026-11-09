import { body, oneLine, severityOf } from '../core/report'
import type { TrailFinding, TrailRound } from '../core/types'

/** GitHub refuses a review or comment body longer than 65536 characters. */
export const MAX_BODY = 65000

const code = (text: string) => `\`${text}\``
export const short = (sha: string) => sha.slice(0, 7)
const sha8 = (r: TrailRound) => (r.reviewedSha ?? 'unknown').slice(0, 8)

/** Agents' text: no heading or open fence, no HTML comment that could pass for a marker, no @mention that would notify someone. */
export function agentText(text: unknown): string {
  return body(String(text ?? '').trim())
    .replace(/<!--/g, '&lt;!--')
    .replace(/(^|[^\w`])@(?=\w)/g, '$1@\u200b')
}

const agentLine = (text: unknown) => agentText(oneLine(text))

export function loopTitle(r: Pick<TrailRound, 'loop' | 'name'>): string {
  if (r.loop === 'plan') return 'plan review'
  const stage = /^s(\d+)$/.exec(r.loop)
  if (stage) return `Stage ${stage[1]} (${agentLine(r.name)})`
  if (r.loop === 'final') return 'final review'
  if (r.loop.startsWith('final-')) return `final review (${r.loop.slice(6)})`
  return agentLine(r.name) || r.loop
}

export const roundMarker = (r: TrailRound) => `<!-- granny-trail ${r.loop}/r${r.round}@${sha8(r)} -->`
export const findingMarker = (r: TrailRound, f: Pick<TrailFinding, 'id'>) => `<!-- granny-trail ${r.loop}/r${r.round}@${sha8(r)}/${f.id} -->`

function fitted(text: string, marker: string): string {
  if (text.length + marker.length + 1 <= MAX_BODY) return `${text}\n${marker}`
  return `${text.slice(0, MAX_BODY - marker.length - 40)}\n\n... (cut: too long for GitHub)\n${marker}`
}

function judgeLine(f: TrailFinding): string {
  const tags =
    f.impact === undefined ? code('not judged') : [[f.verdict, f.impact, f.likelihood, f.fixCost, f.scope].filter(Boolean).map(t => code(String(t))).join(' '), `priority ${f.priority ?? '?'}`].join(' · ')
  const d = f.decision
  const rule = d ? ` · rule ${d.rule} → ${d.action}: ${agentLine(d.why)}${d.raised ? ` (ratchet raised ${agentLine(d.raised)})` : ''}` : ''
  return `**Judge:** ${tags}${rule}`
}

function fixRange(r: TrailRound): string | undefined {
  const fix = r.fix
  if (!fix?.startSha || !fix.headSha) return undefined
  const n = fix.commits?.length ?? 0
  return `${short(fix.startSha)}..${short(fix.headSha)} (${n} commit${n === 1 ? '' : 's'})`
}

/** The labels a later round's `repeatOf` names this finding by: its own loop drops the loop id. */
function labelsOf(f: TrailFinding, r: TrailRound): { own: Set<string>; other: Set<string> } {
  const ids = [f.id, ...(f.duplicates ?? [])]
  const own = new Set(ids.map(id => `r${r.round}/${id}`))
  return { own, other: new Set([...own].map(l => `${r.loop}/${l}`)) }
}

function cameBack(f: TrailFinding, r: TrailRound, records: TrailRound[]): string | undefined {
  const { own, other } = labelsOf(f, r)
  const repeats = records.flatMap(later =>
    later.findings
      .filter(x => x.repeatOf !== undefined && (later.loop === r.loop ? later.round > r.round && own.has(x.repeatOf) : other.has(x.repeatOf)))
      .map(x => `${later.loop === r.loop ? '' : `${loopTitle(later)} `}round ${later.round} as ${x.id}`),
  )
  return repeats.length ? `came back in ${repeats.join(', ')}` : undefined
}

/** What became of a finding, worked out from the records alone. */
export function outcomeLine(f: TrailFinding, r: TrailRound, records: TrailRound[]): string {
  const parts: string[] = []
  if (f.blocker) parts.push('P0/P1: sent straight to the implementer, the judge did not route it')
  if (f.overruled !== undefined) parts.push(`the judge overruled the fixer's earlier decline (${agentLine(f.overruled) || 'no reason given'})`)
  if (f.route === 'sent') {
    const declined = r.fix?.declined?.find(d => d.id === f.id)
    const range = fixRange(r)
    const fix = `fix r${r.round}`
    if (declined) parts.push(`the fixer declined it: ${agentLine(declined.reason) || 'no reason given'}`)
    else if (range) parts.push(`fixed in ${fix}: ${range}`)
    else if (r.fix && r.loop === 'plan') parts.push(`fixed in the plan by ${fix}`)
    else parts.push(r.fix ? `sent to ${fix}` : 'sent to the implementer')
  } else if (f.route === 'residual') {
    const d = f.decision
    parts.push(`kept as residual${d ? ` (rule ${d.rule}: ${agentLine(d.why)})` : ''}`)
    if (d?.attention) parts.push(`ATTENTION: pre-existing, impact ${f.impact ?? 'unknown'}`)
  } else {
    parts.push(r.outcome ? `not routed: the round ended the loop with ${code(r.outcome)}` : 'not routed')
  }
  if (r.outcome && f.route !== undefined && !r.findings.some(x => x.route === 'sent')) parts.push(`the loop ended ${code(r.outcome)}`)
  const back = cameBack(f, r, records)
  if (back) parts.push(back)
  if (f.duplicates?.length) parts.push(`also reported as ${f.duplicates.map(code).join(', ')}`)
  return parts.join('; ')
}

/** One finding as a line comment, or as an entry of the round review's body. */
export function findingComment(f: TrailFinding, r: TrailRound, records: TrailRound[]): string {
  const by = [...(f.reviewer ? [`reviewer ${code(f.reviewer)}`] : []), severityOf(f)].join(', ')
  const lines = [
    `**granny · ${loopTitle(r)} · round ${r.round} · ${code(f.id)}** (${by})`,
    `**${agentLine(f.title) || '(no title)'}**`,
    ...(String(f.detail ?? '').trim() ? ['', agentText(f.detail)] : []),
    '',
    '---',
    judgeLine(f),
    ...(f.evidence?.trim() ? [`**Evidence:** ${agentText(f.evidence)}`] : []),
    ...(f.reason?.trim() ? [`**Judge's reason:** ${agentText(f.reason)}`] : []),
    `**What happened:** ${outcomeLine(f, r, records)}`,
  ]
  return fitted(lines.join('\n'), findingMarker(r, f))
}

export const place = (f: Pick<TrailFinding, 'file' | 'line'>) => (oneLine(f.line === undefined ? f.file : `${f.file}:${f.line}`) || '(no file)').replace(/`/g, "'")

export interface RoundLayout {
  /** The findings that are not line comments, in the body. */
  inBody: TrailFinding[]
  /** Set when the reviewed commit is not in the PR, so the line comments sit on the PR head. */
  notInPr?: boolean
  /** Set when the platform refused the round's line comments, so every finding is in the body; the platform's error. */
  refused?: string
  /** Names a GitLab MR instead of a GitHub PR. */
  gitlab?: boolean
}

function header(r: TrailRound): string {
  const reviewer = (x: TrailRound['reviewers'][number]) => `${code(x.name)} (${[x.engine, x.model].filter(Boolean).join(', ')})`
  const count = (route: string) => r.findings.filter(f => f.route === route).length
  const declined = r.fix?.declined?.length ?? 0
  const range = fixRange(r)
  return [
    `**granny · ${loopTitle(r)} · round ${r.round}**`,
    `reviewers: ${r.reviewers.length ? r.reviewers.map(reviewer).join(', ') : 'none ran'}`,
    `reviewed at ${r.reviewedSha ? code(short(r.reviewedSha)) : 'an unrecorded commit'}`,
    `${count('sent')} sent, ${count('residual')} residual, ${declined} declined`,
    ...(r.fix ? [`fix r${r.round}${range ? `: ${range}` : ''}`] : []),
  ].join(' · ')
}

/** The review a round posts: its header, what ended the loop, and every finding that is not a line comment. */
export function roundBody(r: TrailRound, records: TrailRound[], layout: RoundLayout): string {
  const parts = [header(r)]
  if (r.outcome) parts.push(`The loop ended here: ${code(r.outcome)}${r.note ? ` - ${agentLine(r.note)}` : ''}`)
  if (r.fix?.deviations) parts.push(`**The fixer's deviations:** ${agentText(r.fix.deviations)}`)
  const [pr, platform] = layout.gitlab ? ['MR', 'GitLab'] : ['PR', 'GitHub']
  if (layout.notInPr) {
    const at = r.reviewedSha ? code(short(r.reviewedSha)) : 'a commit the record does not name'
    parts.push(`Reviewed at ${at}, which is not in this ${pr}'s history: the line comments sit on the ${pr}'s head.`)
  }
  if (layout.refused) parts.push(`${platform} refused this round's line comments (${agentLine(layout.refused)}), so every finding is below.`)
  if (layout.inBody.length) {
    const title = r.loop === 'plan' ? '### Findings on the plan' : '### Not on a changed line'
    parts.push(title, ...layout.inBody.map(f => `#### ${code(place(f))}\n\n${findingComment(f, r, records)}`))
  }
  return fitted(parts.join('\n\n'), roundMarker(r))
}

/** The one line a clean round posts when it ends a loop that had findings. */
export const cleanBody = (r: TrailRound) => fitted(`**granny · ${loopTitle(r)} · round ${r.round}: clean** - the review found nothing more`, roundMarker(r))
