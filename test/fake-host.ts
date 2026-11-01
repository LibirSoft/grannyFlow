import { spawn } from 'node:child_process'
import type { AgentRequest, CommandResult, Host, HostName } from '../src/core/types'

export type Review = CommandResult | string
export type Reviews = Review[] | Record<string, Review[]> | ((command: string) => Review | Promise<Review>)

export interface FakeOptions {
  name?: HostName
  direct?: boolean
  reviews?: Reviews
  scores?: Array<Record<string, number | { score: number; duplicateOf?: string }> | null>
  override?: (req: AgentRequest) => unknown
  shell?: { env?: Record<string, string> }
}

const CLEAN: CommandResult = { code: 0, output: 'No issues found.' }
const asResult = (r: Review): CommandResult => (typeof r === 'string' ? { code: 0, output: r } : r)

export const reviewerOf = (command: string) => /review-.+?-r\d+-([a-z0-9-]+)\.md/.exec(command)?.[1]

function bash(command: string, cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { cwd, env: { ...process.env, ...env } })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    child.on('error', e => resolve({ code: 127, output: String(e) }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

export function fakeHost(opts: FakeOptions = {}) {
  const source = opts.reviews ?? []
  const queue = Array.isArray(source) ? [...source] : []
  const perReviewer = !Array.isArray(source) && typeof source === 'object' ? Object.fromEntries(Object.entries(source).map(([k, v]) => [k, [...v]])) : {}
  const scores = [...(opts.scores ?? [])]
  const calls: AgentRequest[] = []
  const commands: string[] = []
  const logs: string[] = []
  const phases: string[] = []
  let impl = 0
  const nextReview = async (command: string, cwd: string): Promise<CommandResult> => {
    if (opts.shell) return bash(command, cwd, opts.shell.env)
    if (typeof source === 'function') return asResult(await source(command))
    const list = Array.isArray(source) ? queue : perReviewer[reviewerOf(command) ?? ''] ?? []
    const next = list.shift()
    return next === undefined ? CLEAN : asResult(next)
  }

  const host: Host = {
    name: opts.name ?? 'opencode',
    async agent(req) {
      calls.push(req)
      const custom = await opts.override?.(req)
      if (custom !== undefined) return custom
      switch (req.kind) {
        case 'implementation':
          impl++
          return { startSha: `start${impl}`, headSha: `head${impl}`, gatesGreen: true, gates: 'all green', commits: [`commit ${impl}`], untested: '' }
        case 'score': {
          const s = scores.length ? scores.shift() : {}
          if (s === null) return null
          const perFinding = Object.entries(s ?? {}).map(([id, v]) => {
            const { score, duplicateOf } = typeof v === 'number' ? { score: v, duplicateOf: undefined } : v
            return { id, score, reason: `reason ${id}`, ...(duplicateOf ? { duplicateOf } : {}) }
          })
          return { score: 50, perFinding, rationale: 'r' }
        }
        case 'command': {
          const script = /never cut it short\):\n(.+)\n/.exec(req.prompt)?.[1] ?? ''
          commands.push(script)
          const r = await nextReview(script, '/')
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
