import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { priorityOf } from '../src/core/review'
import type { AgentRequest, CommandResult, Host, HostName, RoundEvent, StageEvent } from '../src/core/types'

export type Review = CommandResult | string
export type Reviews = Review[] | Record<string, Review[]> | ((command: string) => Review | Promise<Review>)

/**
 * A confirmed, in-scope classification below alwaysFix (moderate or minor) whose priority is exactly `priority`,
 * preferring likelihood common. Throws for a priority no such classification reaches.
 */
export function classesFor(priority: number): Record<string, string> {
  for (const likelihood of ['common', 'edge', 'rare'] as const) {
    for (const impact of ['moderate', 'minor'] as const) {
      for (const fixCost of ['small', 'trivial', 'large'] as const) {
        if (priorityOf(impact, likelihood, fixCost) === priority) return { verdict: 'confirmed', impact, likelihood, fixCost, scope: 'in-scope', evidence: 'src/a.ts:1 - fixture' }
      }
    }
  }
  throw new Error(`fake judge: no moderate/minor classification has priority ${priority}`)
}

export interface FakeOptions {
  name?: HostName
  direct?: boolean
  reviews?: Reviews
  /**
   * One judge answer per entry, by finding id. A number n stands for a confirmed, in-scope classification whose
   * computed priority is exactly n (see classesFor); `{ score: n, ...rest }` is that classification plus rest.
   */
  scores?: Array<Record<string, number | Record<string, unknown>> | null>
  override?: (req: AgentRequest) => unknown
  shell?: { env?: Record<string, string> }
  worktree?: string | CommandResult | 'git' | ((command: string, cwd: string) => string)
  /** Commits the engine's base..HEAD probe sees after an implementer ran (default 1); 'git' runs the probes in a real shell. */
  commits?: number | 'git' | ((base: string) => number)
  /** Answers a command before the reviews do; undefined passes it on. */
  checks?: (command: string) => Review | undefined
  /** What the engine's `git status --porcelain` probe prints, or a failed read, in order (the last one repeats; default clean); 'git' with commits runs it in a real shell. */
  status?: Array<string | CommandResult>
  /** What the engine's timeout probe prints (default `timeout`); with `shell` it runs in a real shell instead. */
  timeoutProbe?: Review
  /** A note the Claude Code helper adds to every command it reports (the worktree setup, the probes, checks and reviews). */
  note?: string | ((command: string) => string | undefined)
  /** What the Claude Code helper reports for the n-th wait of a detached review (default `done`); null for a helper that returned nothing. */
  wait?: (command: string, n: number) => Review | null
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
const STATUS_PROBE = /(^|&& )git status --porcelain( -- .*)?$/m
const TIMEOUT_PROBE = 'command -v gtimeout'
const isProbe = (command: string) => command.includes(HEAD_PROBE) || COMMITS_PROBE.test(command) || STATUS_PROBE.test(command) || command.includes(TIMEOUT_PROBE)

const unquote = (word: string) => (word.startsWith("'") ? word.slice(1, -1).replaceAll(`'\\''`, "'") : word)
const START = /nohup bash -c ('(?:[^']|'\\'')*') > \/dev\/null/
const JOB = /^echo \$\$ > .+?; \((.*)\) > .+? 2>&1; echo \$\? > (.+)$/s
const isWait = (command: string) => command.includes('echo pending')
const isRead = (command: string) => command.includes('exit "${code:-1}"')
const isStop = (command: string) => command.includes('echo stopped')
const jobOf = (command: string) => /review-[^\s']*?-r\d+-[a-z0-9-]+(?=\.(?:exit|out|pid))/.exec(command)?.[0] ?? ''

const MARK_HEAD = /^\( (?=cd )/
const MARK_TAIL = ' ) 2>&1; echo "[granny] exit=$?"'
/** The command inside the exit-code wrapper the engine puts around a helper's shell step. */
const unmarked = (line: string) => (MARK_HEAD.test(line) && line.endsWith(MARK_TAIL) ? line.slice(2, -MARK_TAIL.length) : line)
/** What the real wrapper adds: the exit code as a last line, right after the command's own output. */
const withMark = (r: unknown, on: boolean) => {
  if (!on || !r || typeof r !== 'object') return r
  const out = r as { output?: unknown; exitCode?: unknown }
  return typeof out.exitCode === 'number' ? { ...out, output: `${String(out.output ?? '')}[granny] exit=${out.exitCode}\n` } : r
}

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
  const statuses = [...(opts.status ?? [])]
  const calls: AgentRequest[] = []
  const requests: AgentRequest[] = []
  const commands: string[] = []
  const cwds: string[] = []
  const setups: Setup[] = []
  const logs: string[] = []
  const phases: string[] = []
  const stages: StageEvent[] = []
  const rounds: RoundEvent[] = []
  const probes: string[] = []
  let impl = 0
  const jobs = new Map<string, { script: string; result?: CommandResult; waits: number; exit?: string }>()
  const stops: string[] = []
  const noted = (command: string, r: CommandResult) => {
    const note = typeof opts.note === 'function' ? opts.note(command) : opts.note
    return { ran: r.code === 0, exitCode: r.code, output: r.output, ...(note === undefined ? {} : { note }) }
  }
  const probe = async (command: string, cwd: string): Promise<CommandResult> => {
    probes.push(command)
    if (command.includes(TIMEOUT_PROBE)) return opts.shell ? bash(command, cwd, opts.shell.env) : asResult(opts.timeoutProbe ?? 'timeout\n')
    const c = opts.commits ?? 1
    if (c === 'git') return bash(command, cwd, opts.shell?.env)
    if (STATUS_PROBE.test(command)) return asResult((statuses.length > 1 ? statuses.shift() : statuses[0]) ?? '')
    if (command.includes(HEAD_PROBE)) return { code: 0, output: `deadbee${impl + 1}\n` }
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
    const checked = opts.checks?.(command)
    if (checked !== undefined) return asResult(checked)
    if (opts.shell) return bash(command, cwd, opts.shell.env)
    if (typeof source === 'function') return asResult(await source(command))
    const list = Array.isArray(source) ? queue : perReviewer[reviewerOf(command) ?? ''] ?? []
    const next = list.shift()
    return next === undefined ? CLEAN : asResult(next)
  }

  /** `command` is the step without the exit-code wrapper; `line` is what the helper was asked to run. */
  const detached = async (command: string, line: string, marked: boolean): Promise<unknown> => {
    const r = await detachedStep(command, line)
    return withMark(r, marked && !opts.shell)
  }
  const detachedStep = async (command: string, line: string): Promise<unknown> => {
    const cwd = cdTarget(command)
    const key = `${cwd}\0${jobOf(command)}`
    if (START.test(command)) {
      const [, body, exit] = JOB.exec(unquote(START.exec(command)![1]!))!
      const script = `cd ${command.slice(3, command.indexOf(' && '))} && ${body}`
      commands.push(script)
      const file = unquote(exit!)
      const job: { script: string; result?: CommandResult; waits: number; exit?: string } = { script, waits: 0, exit: isAbsolute(file) ? file : join(cwd, file) }
      jobs.set(key, job)
      if (opts.shell) return noted(command, await bash(line, '/', opts.shell.env))
      job.result = await nextReview(script, '/')
      return { ran: true, exitCode: 0, output: 'started\n' }
    }
    const job = jobs.get(key)
    if (!job) throw new Error(`no detached review started for ${command}`)
    if (isWait(command)) {
      job.waits++
      if (opts.shell) {
        const file = opts.wait ? job.exit!.replace(/\.exit$/, '.pid') : job.exit!
        for (let i = 0; i < 500 && !(existsSync(file) && statSync(file).size > 0); i++) await new Promise(r => setTimeout(r, 20))
      }
      if (opts.wait) {
        const r = opts.wait(command, job.waits)
        return r === null ? null : noted(command, asResult(r))
      }
      if (opts.shell) return noted(command, await bash(line, '/', opts.shell.env))
      return noted(command, { code: 0, output: 'done\n' })
    }
    if (isStop(command)) {
      stops.push(command)
      return opts.shell ? noted(command, await bash(line, '/', opts.shell.env)) : { ran: true, exitCode: 0, output: 'stopped\n' }
    }
    if (opts.shell) return noted(job.script, await bash(line, '/', opts.shell.env))
    return noted(job.script, job.result ?? CLEAN)
  }
  const isDetached = (command: string) => START.test(command) || isWait(command) || isRead(command) || isStop(command)

  const host: Host = {
    name: opts.name ?? 'opencode',
    async agent(req) {
      requests.push(req)
      const marked = req.kind === 'command' && req.prompt.includes(MARK_TAIL)
      const plain = marked ? req.prompt.split('\n').map(unmarked).join('\n') : req.prompt
      if (req.label === 'worktree' || (req.kind === 'command' && req.label.startsWith('worktree '))) {
        const line = /Run exactly this:\n(.+)\n/.exec(plain)?.[1] ?? ''
        setups.push({ command: line, cwd: '/', request: req })
        return withMark(noted(line, await setUp(line, '/', cdTarget(line))), marked)
      }
      if (req.kind === 'command' && isProbe(plain)) {
        const line = /Run exactly this:\n(.+)\n/.exec(plain)?.[1] ?? ''
        return withMark(noted(line, await probe(line, req.cwd)), marked)
      }
      calls.push(req)
      const custom = await opts.override?.(req)
      if (custom !== undefined) return custom
      switch (req.kind) {
        case 'implementation':
          impl++
          return { startSha: `deadbee${impl}`, headSha: `head${impl}`, gatesGreen: true, gates: 'all green', commits: [`commit ${impl}`], untested: '' }
        case 'draft':
          return { files: ['/work/repo/.granny/plans/feat-x.md'], stages: [{ name: 'core', task: 'WP-01' }], summary: 'one stage' }
        case 'planFix':
          return { files: ['/plans/v1.md'], changes: 'fixed' }
        case 'judge': {
          const s = scores.length ? scores.shift() : {}
          if (s === null) return null
          const perFinding = Object.entries(s ?? {}).map(([id, v]) => {
            if (typeof v === 'number') return { id, reason: `reason ${id}`, ...classesFor(v) }
            const { score, ...rest } = v as Record<string, unknown>
            return { id, reason: `reason ${id}`, ...(typeof score === 'number' ? classesFor(score) : {}), ...rest }
          })
          return { perFinding, rationale: 'r' }
        }
        case 'command': {
          const line = /Run exactly this[^\n]*:\n(.+)\n/.exec(req.prompt)?.[1] ?? ''
          const step = unmarked(line)
          if (isDetached(step)) return detached(step, line, marked)
          const script = /never cut it short\):\n(.+)\n/.exec(plain)?.[1] ?? /Run exactly this:\n(.+)\n/.exec(plain)?.[1] ?? ''
          commands.push(script)
          return withMark(noted(script, await nextReview(script, '/')), marked)
        }
        case 'findings':
          return { findings: [] }
        case 'final':
          return { gatesGreen: true, gates: 'all green', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
      }
    },
    log: m => logs.push(m),
    phase: t => phases.push(t),
    round: e => rounds.push(e),
    stage: e => stages.push(e),
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
  return { host, calls, requests, commands, cwds, setups, logs, phases, stages, rounds, probes, stops }
}

export const finding = (severity: string, title: string, file = 'src/a.ts', line = 3) =>
  `- [${severity}] ${title} — ${file}:${line}-${line}\n  ${title} detail.`

export const review = (...items: string[]) => `Review comments:\n\n${items.join('\n')}\n`

export const CODEX_REVIEWER = { reviewers: [{ name: 'codex', engine: 'auto' }] }

/** Most engine tests drive the Codex reviewer path; the default reviewer is an agent. */
export const withCodex = <T extends { config?: unknown }>(i: T): T => ({
  ...i,
  config: [CODEX_REVIEWER, ...(Array.isArray(i.config) ? i.config : i.config === undefined ? [] : [i.config])],
})
