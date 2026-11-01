import { spawnSync } from 'node:child_process'
import type { AgentRequest, CommandResult, Host, HostName } from '../src/core/types'

export interface FakeOptions {
  name?: HostName
  direct?: boolean
  reviews?: Array<CommandResult | string>
  scores?: Array<Record<string, number> | null>
  override?: (req: AgentRequest) => unknown
  shell?: { env?: Record<string, string> }
}

export function fakeHost(opts: FakeOptions = {}) {
  const reviews = [...(opts.reviews ?? [])].map(r => (typeof r === 'string' ? { code: 0, output: r } : r))
  const scores = [...(opts.scores ?? [])]
  const calls: AgentRequest[] = []
  const commands: string[] = []
  const logs: string[] = []
  const phases: string[] = []
  let impl = 0
  const bash = (command: string, cwd: string): CommandResult => {
    const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, ...opts.shell?.env } })
    return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` }
  }
  const nextReview = (command: string, cwd: string) =>
    opts.shell ? bash(command, cwd) : reviews.shift() ?? { code: 0, output: 'No issues found.' }

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
          const script = /never cut it short\):\n(.+)\n/.exec(req.prompt)?.[1] ?? ''
          commands.push(script)
          const r = nextReview(script, '/')
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
    host.run = async (command: string, cwd: string) => {
      commands.push(command)
      return nextReview(command, cwd)
    }
  }
  return { host, calls, commands, logs, phases }
}

export const finding = (severity: string, title: string, file = 'src/a.ts', line = 3) =>
  `- [${severity}] ${title} — ${file}:${line}-${line}\n  ${title} detail.`

export const review = (...items: string[]) => `Review comments:\n\n${items.join('\n')}\n`
