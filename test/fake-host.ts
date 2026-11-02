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
  worktree?: string | CommandResult | 'git' | ((command: string, cwd: string) => string)
  /** Commits the engine's base..HEAD probe sees after an implementer ran (default 1); 'git' runs the probes in a real shell. */
  commits?: number | 'git' | ((base: string) => number)
}

export interface Setup {
  command: string
  cwd: string
  request?: AgentRequest
}

const CLEAN: CommandResult = { code: 0, output: 'No findings.' }
const asResult = (r: Review): CommandResult => (typeof r === 'string' ? { code: 0, output: r } : r)

export const reviewerOf = (command: string) => /review-.+?-r\d+-([a-z0-9-]+)\.md/.exec(command)?.[1]

const isWorktreeSetup = (command: string) => command.includes('git worktree list --porcelain')
const HEAD_PROBE = 'git rev-parse --verify HEAD'
const COMMITS_PROBE = /git rev-list --count (\S+)\.\.HEAD/
const isProbe = (command: string) => command.includes(HEAD_PROBE) || COMMITS_PROBE.test(command)

const cdTarget = (line: string) => {
  const quoted = /^cd ((?:'[^']*'(?:\\''[^']*')*)|\S+) && /.exec(line)?.[1] ?? ''
  return quoted.startsWith("'") ? quoted.slice(1, -1).replaceAll(`'\\''`, "'") : quoted
}

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
  const cwds: string[] = []
  const setups: Setup[] = []
  const logs: string[] = []
  const phases: string[] = []
  const probes: string[] = []
  let impl = 0
  const probe = async (command: string, cwd: string): Promise<CommandResult> => {
    probes.push(command)
    const c = opts.commits ?? 1
    if (c === 'git') return bash(command, cwd, opts.shell?.env)
    if (command.includes(HEAD_PROBE)) return { code: 0, output: `start${impl + 1}\n` }
    const base = COMMITS_PROBE.exec(command)![1]!
    return { code: 0, output: `${typeof c === 'function' ? c(base) : c}\n` }
  }
  const setUp = async (command: string, cwd: string, repo: string): Promise<CommandResult> => {
    const w = opts.worktree
    if (w === 'git') return bash(command, cwd, opts.shell?.env)
    if (typeof w === 'function') return { code: 0, output: `[granny] worktree: ${w(command, cwd)}\n` }
    if (typeof w === 'object') return w
    return { code: 0, output: `[granny] worktree: ${w ?? repo}\n` }
  }
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
      if (req.label === 'worktree' || (req.kind === 'command' && req.label.startsWith('worktree '))) {
        const line = /Run exactly this:\n(.+)\n/.exec(req.prompt)?.[1] ?? ''
        setups.push({ command: line, cwd: '/', request: req })
        const r = await setUp(line, '/', cdTarget(line))
        return { ran: r.code === 0, exitCode: r.code, output: r.output }
      }
      if (req.kind === 'command' && isProbe(req.prompt)) {
        const r = await probe(/Run exactly this:\n(.+)\n/.exec(req.prompt)?.[1] ?? '', req.cwd)
        return { ran: r.code === 0, exitCode: r.code, output: r.output }
      }
      calls.push(req)
      const custom = await opts.override?.(req)
      if (custom !== undefined) return custom
      switch (req.kind) {
        case 'implementation':
          impl++
          return { startSha: `start${impl}`, headSha: `head${impl}`, gatesGreen: true, gates: 'all green', commits: [`commit ${impl}`], untested: '' }
        case 'draft':
          return { files: ['/work/repo/.granny/plans/feat-x.md'], stages: [{ name: 'core', task: 'WP-01' }], summary: 'one stage' }
        case 'planFix':
          return { files: ['/plans/v1.md'], changes: 'fixed' }
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
          const script = /never cut it short\):\n(.+)\n/.exec(req.prompt)?.[1] ?? /Run exactly this:\n(.+)\n/.exec(req.prompt)?.[1] ?? ''
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
      if (isWorktreeSetup(command)) {
        setups.push({ command, cwd })
        return setUp(command, cwd, cwd)
      }
      if (isProbe(command)) return probe(command, cwd)
      commands.push(command)
      cwds.push(cwd)
      return nextReview(command, cwd)
    }
  }
  return { host, calls, commands, cwds, setups, logs, phases, probes }
}

export const finding = (severity: string, title: string, file = 'src/a.ts', line = 3) =>
  `- [${severity}] ${title} — ${file}:${line}-${line}\n  ${title} detail.`

export const review = (...items: string[]) => `Review comments:\n\n${items.join('\n')}\n`
