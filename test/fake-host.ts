import type { AgentRequest, CommandResult, Host, HostName } from '../src/core/types'

export interface FakeOptions {
  name?: HostName
  direct?: boolean
  reviews?: Array<CommandResult | string>
  scores?: Array<Record<string, number> | null>
  override?: (req: AgentRequest) => unknown
}

export function fakeHost(opts: FakeOptions = {}) {
  const reviews = [...(opts.reviews ?? [])].map(r => (typeof r === 'string' ? { code: 0, output: r } : r))
  const scores = [...(opts.scores ?? [])]
  const calls: AgentRequest[] = []
  const commands: string[] = []
  const logs: string[] = []
  const phases: string[] = []
  let impl = 0
  const nextReview = () => reviews.shift() ?? { code: 0, output: 'No issues found.' }

  const host: Host = {
    name: opts.name ?? 'opencode',
    async agent(req) {
      calls.push(req)
      const custom = opts.override?.(req)
      if (custom !== undefined) return custom
      switch (req.kind) {
        case 'implementation':
          impl++
          return { startSha: `start${impl}`, headSha: `head${impl}`, gatesGreen: true, gates: 'all green', commits: [`commit ${impl}`], untested: '' }
        case 'score': {
          const s = scores.length ? scores.shift() : {}
          if (s === null) return null
          return { score: 50, perFinding: Object.entries(s ?? {}).map(([id, score]) => ({ id, score, reason: `reason ${id}` })), rationale: 'r' }
        }
        case 'command': {
          const r = nextReview()
          return { ran: r.code === 0, exitCode: r.code, output: r.output }
        }
        case 'findings':
          return { findings: [] }
        case 'final':
          return { gatesGreen: true, gates: 'all green', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
      }
    },
    log: m => logs.push(m),
    phase: t => phases.push(t),
  }
  if (opts.direct !== false) {
    host.run = async (command: string) => {
      commands.push(command)
      return nextReview()
    }
  }
  return { host, calls, commands, logs, phases }
}

export const finding = (severity: string, title: string, file = 'src/a.ts', line = 3) =>
  `- [${severity}] ${title} — ${file}:${line}-${line}\n  ${title} detail.`

export const review = (...items: string[]) => `Review comments:\n\n${items.join('\n')}\n`
