import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, type WatchMode } from '../../core/config'
import { GrannyCancelled, isCancelled } from '../../core/cancel'
import { checkInput, runGranny, stageCheckErrors, type RunInput } from '../../core/engine'
import { checkShape, SCHEMAS } from '../../core/schemas'
import type { AgentRequest, Host, ResultKind } from '../../core/types'
import { DEFAULT_DELAYS, dropPlaceholders, globalConfigPath, type HostOptions, KILL_GRACE_MS, pause, planReviewNotice, preflight, readJson, RUN_INPUT_SCHEMA, RUN_TOOL_DESCRIPTION, runCommand, runDir, runId, runStatus, signalGroup, stageRepos, stamp, SUBMIT, summarize } from '../common'
import { lineType, LiveRun, type LiveOptions, PARSED_EVENTS, type RoleActivity, type RoleOutcome } from './panel'
import { Navigator } from './navigator'
import { EventLog } from './watch'

// The omp (oh-my-pi) host. One file, two modes: in the user's omp session it registers granny_run,
// granny_status, granny_wait and granny_cancel and runs the loop; every role runs as its own `omp --mode json`
// process that loads this same file with GRANNY_OMP_CHILD set, where it registers only the role's
// submit tool and a tool_call guard.

type Access = AgentRequest['access']

interface ChildSpec {
  tool: string
  kind: ResultKind
  out: string
  access: Access
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
}

interface OmpTool {
  name: string
  label: string
  description: string
  parameters: unknown
  loadMode?: 'essential' | 'discoverable'
  interruptible?: boolean
  execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any): Promise<ToolResult>
}

export interface OmpApi {
  registerTool(tool: OmpTool): void
  on(event: 'tool_call', handler: (event: { toolName: string; input: any }) => Promise<{ block: true; reason: string } | undefined>): void
  on(event: 'session_start', handler: (event: unknown, ctx: any) => Promise<void>): void
  getActiveTools?(): string[]
  setActiveTools?(toolNames: string[]): Promise<void>
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: 'aside' } | { triggerTurn: false }): void
  registerCommand?(
    name: string,
    options: {
      description?: string
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null
      handler: (args: string, ctx: any) => Promise<void>
    },
  ): void
  registerShortcut?(shortcut: string, options: { description?: string; handler: (ctx: any) => Promise<void> | void }): void
}

type Status = 'running' | 'done' | 'failed' | 'cancelled'

interface RunState {
  id: string
  dir: string
  status: Status
  cancelled: boolean
  abort: AbortController
  children: Set<ChildProcess>
  agents: number
  reply?: string
  /** Pending granny_wait calls; set at the moment the run ends, so a run reports either to them or by notice. */
  waiters: Set<(reply: string) => void>
  live: LiveRun
  watch: WatchMode
}

// omp re-runs the factory for every session in the process; runs started in one must stay visible to all.
const SHARED = Symbol.for('granny-workflow.omp.state')
const shared: { runs: Map<string, RunState>; clearStatus?: () => void; hidden?: boolean; navigating?: boolean } = ((globalThis as any)[SHARED] ??= { runs: new Map() })
const { runs } = shared

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

const WAIT_DEFAULT_SECONDS = 1800
const WAIT_MAX_SECONDS = 7200

export function waitSeconds(value: unknown): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(WAIT_MAX_SECONDS, Math.max(1, Math.round(n))) : WAIT_DEFAULT_SECONDS
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'ast_grep', 'lsp', 'bash', 'web_search', 'todo', 'think', 'wait', 'yield'])
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'nohup'])
const PREFIX_OPTIONS_WITH_VALUE = new Map<string, Set<string>>([
  ['time', new Set(['-f', '-o'])],
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'])],
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['xargs', new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
const GITHUB_DENIED_OPS = new Set(['pr_create', 'pr_push', 'pr_checkout'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])

function closingParen(line: string, from: number): number {
  let depth = 1
  for (let k = from; k < line.length; k++) {
    if (line[k] === '\\') k++
    else if (line[k] === '(') depth++
    else if (line[k] === ')' && --depth === 0) return k
  }
  return line.length
}

function closingBacktick(line: string, from: number): number {
  for (let k = from; k < line.length; k++) {
    if (line[k] === '\\') k++
    else if (line[k] === '`') return k
  }
  return line.length
}

function simpleCommands(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const end = close < 0 ? line.length : close
      word += line.slice(i + 1, end)
      inWord = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) word += line[++j]
        else if ((line[j] === '$' && line[j + 1] === '(') || line[j] === '`') {
          const start = line[j] === '`' ? j + 1 : j + 2
          const end = line[j] === '`' ? closingBacktick(line, start) : closingParen(line, start)
          commands.push(...simpleCommands(line.slice(start, end)))
          j = end
        } else word += line[j]
      }
      inWord = true
      i = j
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (c === '$' && line[i + 1] === '(') {
      endCommand()
      i++
    } else if (';&|()`\n'.includes(c)) {
      endCommand()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

function shellCommandString(args: string[]): string | undefined {
  let c = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (SHELL_OPTIONS_WITH_VALUE.has(a)) k++
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes('c')) c = true
      if (/[oO]/.test(a)) k++
    } else if (/^(\+[A-Za-z]+|--.+)$/.test(a)) continue
    else return c ? (a === '--' ? args[k + 1] : a) : undefined
  }
  return undefined
}

function commandBlock(words: string[], access: Access): string | undefined {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    const withValue = PREFIX_OPTIONS_WITH_VALUE.get(w)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) i++
    else if (withValue) {
      i++
      for (let o = words[i]; o?.startsWith('-'); o = words[i]) {
        if (w === 'env' && /^(-S|--split-string)/.test(o)) {
          const inline = o.startsWith('--') ? o.slice('--split-string='.length) : o.slice(2)
          const split = inline || words[i + 1] || ''
          return bashBlock([split, ...words.slice(inline ? i + 1 : i + 2)].join(' '), access)
        }
        i += withValue.has(o) ? 2 : 1
        if (o === '--') break
      }
      if (w === 'timeout') i++
    } else break
  }
  const program = basename(words[i] ?? '')
  const rest = words.slice(i + 1)
  const shellCommand = SHELLS.has(program) ? shellCommandString(rest) : undefined
  if (shellCommand !== undefined) return bashBlock(shellCommand, access)
  if (program === 'eval') return bashBlock(rest.join(' '), access)
  if (program === 'gh') {
    let j = 0
    while (rest[j]?.startsWith('-')) j += rest[j] === '-R' || rest[j] === '--repo' ? 2 : 1
    return rest[j] === 'pr' ? '`gh pr` is not allowed in a granny role - the user opens pull requests' : undefined
  }
  if (program !== 'git') return undefined
  let j = 0
  while (rest[j]?.startsWith('-')) j += GIT_OPTIONS_WITH_VALUE.has(rest[j]!) ? 2 : 1
  const sub = rest[j]
  const args = rest.slice(j + 1)
  const denied =
    sub === 'push' || sub === 'stash' || sub === 'rebase' ||
    (sub === 'reset' && args.includes('--hard')) ||
    (sub === 'remote' && args.find(a => !a.startsWith('-')) === 'add')
  if (denied) return `\`git ${sub}${sub === 'reset' ? ' --hard' : sub === 'remote' ? ' add' : ''}\` is not allowed in a granny role - granny never pushes, stashes, rebases, hard-resets or adds remotes; the user does`
  if (access === 'read-only' && (sub === 'add' || sub === 'commit')) return `\`git ${sub}\` is not allowed: this role is read-only`
  return undefined
}

function bashBlock(command: string, access: Access): string | undefined {
  for (const words of simpleCommands(command)) {
    const reason = commandBlock(words, access)
    if (reason) return reason
  }
  return undefined
}

/** Why a role's tool call is blocked, or undefined when it may run. */
export function blockReason(toolName: string, input: any, access: Access, submitTool: string): string | undefined {
  if (toolName === 'ask') return 'granny: no one answers questions in a granny role - decide yourself and say what you assumed in your result'
  if (toolName === 'github' && GITHUB_DENIED_OPS.has(String(input?.op))) {
    return `granny: the github tool's ${input.op} is not allowed in a granny role - granny never pushes or touches pull requests; the user does`
  }
  if (access === 'read-only' && toolName !== submitTool && !READ_ONLY_TOOLS.has(toolName)) {
    return `granny: this role is read-only - the ${toolName} tool is not allowed`
  }
  if (toolName !== 'bash') return undefined
  const reason = bashBlock(String(input?.command ?? ''), access)
  return reason ? `granny: ${reason}` : undefined
}

const TRANSIENT = /\b(429|502|503|504|529)\b|rate.?limit|too many requests|overloaded|quota|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|connection|other side closed|network|fetch failed/i

export function isTransient(message: string): boolean {
  return TRANSIENT.test(message)
}

export type { RetryPolicy } from '../common'

export type ExtensionOptions = HostOptions & LiveOptions

const STATUS_KEEP_MS = 60_000

const WATCH_HELP =
  "granny-workflow: watch granny runs - /granny (or alt+w) opens the run navigator: this process's runs, their phases and agents, and the selected one's live events or transcript; /granny <runId> opens it on that run; /granny off|on hides or shows the run panel in this session"

const OVERLAY = { width: '100%', maxHeight: '100%', margin: 0, fullscreen: true, mouseTracking: false }

interface Turn {
  code: number
  assistant?: { stopReason?: string; errorMessage?: string }
  stderr: string
}

function turnError(turn: Turn): string | undefined {
  if (turn.assistant?.stopReason === 'error') return turn.assistant.errorMessage || 'unknown provider error'
  if (!turn.assistant && turn.code !== 0) return `omp exited ${turn.code}${turn.stderr.trim() ? `: ${turn.stderr.trim().slice(-1000)}` : ''}`
  return undefined
}

function readSubmission(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'agent'

const SUBAGENT_SUBMIT = "granny: only the role's top-level agent submits the result - return your findings to the agent that spawned you."

// omp runs this factory again for every task subagent of a role, in the same process, so the role's
// submit tool and guard reach the subagents too.
function registerChild(pi: OmpApi, spec: ChildSpec) {
  pi.registerTool({
    name: spec.tool,
    label: spec.tool,
    description: `granny-workflow: submit your final ${spec.kind} result. Call it exactly once, when your task is done.`,
    parameters: SCHEMAS[spec.kind],
    loadMode: 'essential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (ctx?.agent?.kind === 'sub') return text(SUBAGENT_SUBMIT)
      mkdirSync(dirname(spec.out), { recursive: true })
      writeFileSync(spec.out, JSON.stringify(params))
      return text('Recorded. You are done - stop now.')
    },
  })
  pi.on('tool_call', async event => {
    const reason = blockReason(event.toolName, event.input, spec.access, spec.tool)
    return reason ? { block: true, reason } : undefined
  })
  pi.on('session_start', async (_event, ctx) => {
    if (ctx?.agent?.kind !== 'sub') return
    try {
      const active = pi.getActiveTools?.()
      if (active?.includes(spec.tool)) await pi.setActiveTools?.(active.filter(name => name !== spec.tool))
    } catch {}
  })
}

export const createGrannyExtension =
  ({ delays = DEFAULT_DELAYS, sleep = pause, killGraceMs = KILL_GRACE_MS, now = Date.now, renderEveryMs = 1000 }: Partial<ExtensionOptions> = {}) =>
  (pi: OmpApi): void => {
    const child = process.env.GRANNY_OMP_CHILD
    if (child) return registerChild(pi, JSON.parse(child) as ChildSpec)

    const startRun = (input: RunInput, ctx: any): string => {
      const problems = checkInput(input)
      if (problems.length) return `granny_run refused:\n- ${problems.join('\n- ')}`

      const layers = [readJson(globalConfigPath()), readJson(join(input.repo, 'granny.config.json')), input.config]
      const config = resolveConfig(layers, 'omp')
      const unknownChecks = stageCheckErrors(input.stages, config.checks)
      if (unknownChecks.length) return `granny_run refused:\n- ${unknownChecks.join('\n- ')}`
      const blockers = preflight(input.repo, input.branch, config.workDir, config.worktree)
      for (const repo of stageRepos(input)) blockers.push(...preflight(repo, input.branch, config.workDir, config.worktree).map(b => `${repo}: ${b}`))
      if (blockers.length) return `granny_run refused:\n- ${blockers.join('\n- ')}`

      const id = runId()
      const dir = join(input.repo, config.workDir, 'runs', id)
      mkdirSync(dir, { recursive: true })
      shared.clearStatus?.()
      shared.clearStatus = undefined
      const { watch } = config
      const live = new LiveRun(id, watch !== 'off' && ctx?.hasUI === true ? ctx.ui : undefined, { now, renderEveryMs }, !shared.hidden)
      const run: RunState = { id, dir, status: 'running', cancelled: false, abort: new AbortController(), children: new Set(), agents: 0, waiters: new Set(), live, watch }
      runs.set(id, run)
      const journal = (type: string, data: Record<string, unknown>) =>
        appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ t: stamp(), type, ...data }) + '\n')
      const writeStatus = (extra: Record<string, unknown> = {}) =>
        writeFileSync(join(dir, 'status.json'), JSON.stringify({ id, status: run.status, repo: input.repo, branch: input.branch, ...extra }, null, 2))
      writeFileSync(join(dir, 'input.json'), JSON.stringify({ ...input, config: layers }, null, 2))
      writeStatus({ startedAt: stamp() })

      const parentModel: string | undefined = ctx?.model?.provider && ctx?.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined
      const bin = process.env.GRANNY_OMP_BIN ?? 'omp'
      const extensionFile = process.env.GRANNY_OMP_EXTENSION ?? fileURLToPath(import.meta.url)

      const omp = (args: string[], prompt: string, cwd: string, spec: ChildSpec, view: RoleActivity) =>
        new Promise<Turn>((resolve, reject) => {
          if (run.cancelled) return reject(new GrannyCancelled())
          const proc = spawn(bin, args, { cwd, env: { ...process.env, GRANNY_OMP_CHILD: JSON.stringify(spec) }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
          run.children.add(proc)
          live.start(view)
          let pending = ''
          let stderr = ''
          let assistant: Turn['assistant']
          const scan = (line: string) => {
            try {
              const type = lineType(line)
              if (type !== undefined && !PARSED_EVENTS.has(type)) {
                view.stream(type, line, now())
                return live.touch()
              }
              const event = JSON.parse(line)
              if (event?.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message
              const agents = view.event(event, now())
              if (agents) journal('subagent', { label: view.info.label, agents })
              live.touch()
            } catch {}
          }
          proc.stdout!.on('data', d => {
            pending += d
            let nl: number
            while ((nl = pending.indexOf('\n')) >= 0) {
              scan(pending.slice(0, nl))
              pending = pending.slice(nl + 1)
            }
          })
          proc.stderr!.on('data', d => (stderr = (stderr + d).slice(-4000)))
          proc.stdin!.on('error', () => {})
          proc.on('error', (e: NodeJS.ErrnoException) => {
            run.children.delete(proc)
            live.stop(view)
            reject(e.code === 'ENOENT' ? new Error(`cannot run omp: "${bin}" was not found - install omp or set GRANNY_OMP_BIN to its path`) : e)
          })
          proc.on('close', code => {
            run.children.delete(proc)
            if (pending) scan(pending)
            view.exit(code ?? 1)
            live.stop(view)
            resolve({ code: code ?? 1, assistant, stderr })
          })
          proc.stdin!.end(prompt)
        })

      const converse = async (req: AgentRequest, spec: ChildSpec, args: string[], session: string, view: RoleActivity) => {
        const { tool } = spec
        let prompt = `${req.prompt}\n\nWhen done, call the \`${tool}\` tool exactly once with your result. That call is your final answer: the caller receives only its arguments.`
        let misses = 0
        let backoffs = 0
        let resume = false
        while (misses < 3) {
          rmSync(spec.out, { force: true })
          const turn = await omp(resume ? [...args, '--continue'] : args, prompt, req.cwd, spec, view)
          resume = true
          if (run.cancelled) throw new GrannyCancelled()
          const got = readSubmission(spec.out)
          if (got !== undefined) {
            const errors = checkShape(req.schema, got)
            if (!errors.length) return got
            prompt = `Your ${tool} call was invalid: ${errors.join('; ')}. Call ${tool} again with the corrected, complete result.`
          } else {
            const error = turnError(turn)
            if (error) {
              const transient = isTransient(error)
              const backoffMs = transient ? delays[backoffs] : undefined
              journal('provider-error', { label: req.label, session, error, transient, ...(backoffMs !== undefined ? { backoffMs } : {}) })
              if (backoffMs === undefined) {
                journal('agent-failed', { label: req.label, session, error })
                return null
              }
              backoffs++
              await sleep(backoffMs, run.abort.signal)
              if (run.cancelled) throw new GrannyCancelled()
              prompt = `Your previous turn ended on a provider error (${error.slice(0, 300)}). Continue the task where it stopped; when you are done, call \`${tool}\` exactly once with your result.`
              continue
            }
            prompt = `You stopped without calling ${tool}. Call it now with your result.`
          }
          journal('retry', { label: req.label, attempt: ++misses, reason: prompt.slice(0, 200) })
        }
        journal('agent-failed', { label: req.label, session })
        return null
      }

      const host: Host = {
        name: 'omp',
        async agent(req) {
          if (run.cancelled) throw new GrannyCancelled()
          const tool = SUBMIT[req.kind]
          if (!tool) throw new Error(`no submit tool for result kind "${req.kind}"`)
          const model = req.model ?? parentModel
          const session = join(dir, 'sessions', `${++run.agents}-${slug(req.label)}`)
          mkdirSync(session, { recursive: true })
          const spec: ChildSpec = { tool, kind: req.kind, out: join(session, 'submission.json'), access: req.access }
          const args = [
            '--mode', 'json', '--no-title', '--no-extensions',
            '-e', extensionFile,
            '--approval-mode', 'yolo',
            '--session-dir', session,
            ...(model ? ['--model', model] : []),
            ...(req.effort ? ['--thinking', req.effort] : []),
          ]
          journal('agent', { label: req.label, role: req.role, phase: req.phase, session, model: model ?? null, ...(req.effort ? { effort: req.effort } : {}) })
          const path = join(session, 'events.jsonl')
          const log =
            watch === 'full'
              ? new EventLog(path, now, e => journal('event-log-failed', { label: req.label, path, error: String((e as Error)?.message ?? e) }))
              : undefined
          const view = live.role({ label: req.label, role: req.role, model, effort: req.effort, session, phase: req.phase, ...(log ? { log: path } : {}) }, log && (entry => log.write(entry)))
          const end = (outcome: RoleOutcome, error?: string) => {
            view.outcome = outcome
            if (error !== undefined) view.error = error
            try {
              journal('agent-end', { label: req.label, session, outcome, ...(error !== undefined ? { error } : {}) })
            } catch {}
          }
          try {
            const result = await converse(req, spec, args, session, view)
            end(result === null ? 'failed' : 'done')
            return result
          } catch (e) {
            if (isCancelled(e)) end('cancelled')
            else end('failed', String((e as Error)?.message ?? e))
            throw e
          }
        },
        cancelled: () => run.cancelled,
        async run(command, cwd) {
          if (run.cancelled) return { code: 130, output: 'cancelled' }
          journal('command', { command })
          return runCommand(command, cwd, run.abort.signal, killGraceMs)
        },
        log: message => journal('log', { message }),
        phase: title => {
          journal('phase', { title })
          live.setPhase(title)
        },
      }

      const notify = (content: string) => {
        try {
          pi.sendMessage({ customType: 'granny-workflow', content, display: true }, { deliverAs: 'aside' })
        } catch (e) {
          journal('notify-failed', { error: String((e as Error)?.message ?? e) })
        }
      }

      const writeResult = (result: unknown) => writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))

      const settle = (reply: string, notice: string | undefined) => {
        run.reply = reply
        const clear = live.close(run.status)
        shared.clearStatus = clear
        setTimeout(clear, STATUS_KEEP_MS).unref()
        const waiting = [...run.waiters]
        run.waiters.clear()
        for (const deliver of waiting) deliver(reply)
        if (waiting.length) journal('notified-via-wait', { waits: waiting.length })
        else if (notice) notify(notice)
      }

      void runGranny(host, { ...input, config: layers })
        .then(result => {
          run.status = 'done'
          writeStatus({ finishedAt: stamp() })
          writeResult(result)
          const reply = `[granny] Run ${id} finished.\n${summarize(result, config.worktree)}\nCall granny_status with runId "${id}" for the full result, verify load-bearing claims yourself, report to the user and wait. Do not push.`
          settle(reply, reply)
        })
        .catch(error => {
          if (run.reply !== undefined) return
          run.status = run.cancelled ? 'cancelled' : 'failed'
          const finishedAt = stamp()
          const message = String(error?.message ?? error)
          const reply = run.cancelled ? `Run ${id} was cancelled.` : `[granny] Run ${id} failed: ${message}\nCall granny_status with runId "${id}" and report to the user.`
          try {
            writeStatus({ finishedAt, error: String(error?.stack ?? error) })
            journal('error', { error: message })
            writeResult({ id, status: run.status, finishedAt, error: message })
          } finally {
            settle(reply, run.cancelled ? undefined : reply)
          }
        })
        .catch(() => {})

      return `granny run ${id} started on ${input.repo} (${input.branch}), ${input.goal !== undefined ? 'planning only' : `${input.stages?.length ?? 0} stage(s)${config.parallel ? `, up to ${config.maxParallel} in parallel` : ''}`}, threshold ${config.threshold}, maxRounds ${config.maxRounds}.
Journal: ${join(dir, 'journal.jsonl')}
To wait in this turn, call granny_wait { runId: "${id}" }; otherwise end your turn - the finish message starts a new one. Never write your own watcher, sleep or poll loop on the run files. Use granny_status { runId: "${id}" } for progress and granny_cancel to stop it.${planReviewNotice(input, config)}`
    }

    pi.registerTool({
      name: 'granny_run',
      label: 'granny run',
      description: RUN_TOOL_DESCRIPTION,
      parameters: RUN_INPUT_SCHEMA,
      loadMode: 'essential',
      async execute(_id, params: RunInput, _signal, _onUpdate, ctx) {
        try {
          return text(startRun(dropPlaceholders(params), ctx))
        } catch (e) {
          return text(`granny_run failed to start: ${(e as Error).message}`)
        }
      },
    })
    pi.registerTool({
      name: 'granny_status',
      label: 'granny status',
      description: 'granny-workflow: status, journal tail and result of a granny run.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' }, repo: { type: 'string', description: 'Absolute repo path; finds the latest run when runId is omitted' } },
      },
      loadMode: 'essential',
      async execute(_id, params: { runId?: string; repo?: string }) {
        try {
          const status = runStatus(runs, params.runId, params.repo)
          const dir = runDir(runs, params.runId, params.repo)
          const run = [...runs.values()].find(r => r.dir === dir && r.status === 'running')
          return text(run ? `${status}\n\nlive (this omp process):\n${run.live.lines(Number.POSITIVE_INFINITY).join('\n')}` : status)
        } catch (e) {
          return text(`granny_status failed: ${(e as Error).message}`)
        }
      },
    })
    pi.registerTool({
      name: 'granny_wait',
      label: 'granny wait',
      description: `granny-workflow: wait in this turn until a granny run ends and return its result, or return when timeoutSeconds (default ${WAIT_DEFAULT_SECONDS}) pass - use it instead of your own watcher, sleep or poll loop on the run files.`,
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          timeoutSeconds: { type: 'number', description: `Seconds to wait while the run is still going, 1 to ${WAIT_MAX_SECONDS}; default ${WAIT_DEFAULT_SECONDS}` },
        },
        required: ['runId'],
      },
      loadMode: 'essential',
      interruptible: true,
      async execute(_id, params: { runId: string; timeoutSeconds?: number }, signal) {
        const run = runs.get(params.runId)
        if (!run) {
          return text(`No granny run "${params.runId}" in this omp process. granny_wait waits only for a run started in this process - the run table is in memory; call granny_status({ repo }) to read a run's files.`)
        }
        if (run.reply !== undefined) return text(run.reply)
        const stopped = `Stopped waiting; run ${run.id} is still running.`
        if (signal?.aborted) return text(stopped)
        const seconds = waitSeconds(params.timeoutSeconds)
        return new Promise<ToolResult>(resolve => {
          const done = (reply: string) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            run.waiters.delete(done)
            resolve(text(reply))
          }
          const onAbort = () => done(stopped)
          const timer = setTimeout(
            () => done(`Run ${run.id} is still running after ${seconds} s. Call granny_wait again to keep waiting, or end your turn - the finish message will start a new one.`),
            seconds * 1000,
          )
          run.waiters.add(done)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    })
    const say = (ctx: any, message: string) => {
      try {
        if (ctx?.hasUI === true) ctx.ui.notify(message, 'info')
        else pi.sendMessage({ customType: 'granny-workflow', content: message, display: true }, { triggerTurn: false })
      } catch {}
    }

    const watchRun = async (args: string, ctx: any) => {
      const arg = args.trim()
      if (arg === 'off' || arg === 'on') {
        shared.hidden = arg === 'off'
        for (const run of runs.values()) if (run.status === 'running') run.live.setVisible(!shared.hidden)
        return say(ctx, shared.hidden ? 'granny: the run panel is hidden in this session - /granny on shows it again.' : 'granny: the run panel is shown in this session.')
      }
      const all = [...runs.values()]
      const run = arg ? runs.get(arg) : (all.filter(r => r.status === 'running').at(-1) ?? all.at(-1))
      if (!run) return say(ctx, arg ? `granny: no run "${arg}" in this omp process - /granny watches the runs started here.` : 'granny: no granny run in this omp process yet.')
      if (run.watch !== 'full') {
        return say(ctx, `granny: watching is off for run ${run.id} (watch: "${run.watch}") - set "watch": "full" in granny.config.json or the run's config to log each role and watch it with /granny.`)
      }
      const tui = ctx?.hasUI === true && typeof ctx.ui?.custom === 'function' && (ctx.mode === undefined || ctx.mode === 'tui')
      if (!tui) {
        const roles = run.live.roles
        if (!roles.length) return say(ctx, `granny: run ${run.id} has started no role yet.`)
        return say(ctx, [`granny run ${run.id} - event log per role:`, ...roles.map(r => `  ${r.info.label} (${r.info.role}): ${r.info.log}`)].join('\n'))
      }
      if (shared.navigating) return
      shared.navigating = true
      let navigator: Navigator | undefined
      try {
        await ctx.ui.custom(
          (tuiHost: any, theme: unknown, keys: any, done: (value: undefined) => void) =>
            (navigator = new Navigator({
              runs: () => [...runs.values()].filter(r => r.watch === 'full'),
              runId: run.id,
              tui: tuiHost,
              theme,
              keys,
              done: () => done(undefined),
              now,
              tickMs: renderEveryMs,
            })),
          { overlay: true, overlayOptions: OVERLAY },
        )
      } finally {
        navigator?.dispose()
        shared.navigating = false
      }
    }

    pi.registerCommand?.('granny', {
      description: WATCH_HELP,
      getArgumentCompletions: prefix => {
        const items = ['off', 'on', ...runs.keys()].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value }))
        return items.length ? items : null
      },
      handler: async (args, ctx) => {
        try {
          await watchRun(args ?? '', ctx)
        } catch (e) {
          say(ctx, `granny: /granny failed: ${(e as Error)?.message ?? e}`)
        }
      },
    })
    try {
      pi.registerShortcut?.('alt+w', {
        description: 'granny-workflow: open the run navigator',
        handler: ctx => {
          void watchRun('', ctx).catch(() => {})
        },
      })
    } catch {}

    pi.registerTool({
      name: 'granny_cancel',
      label: 'granny cancel',
      description: 'granny-workflow: cancel a running granny run.',
      parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      loadMode: 'essential',
      async execute(_id, params: { runId: string }) {
        const run = runs.get(params.runId)
        if (!run || run.status !== 'running') return text(`No running granny run "${params.runId}".`)
        run.cancelled = true
        run.abort.abort()
        for (const proc of run.children) {
          signalGroup(proc, 'SIGTERM')
          setTimeout(() => run.children.has(proc) && signalGroup(proc, 'SIGKILL'), killGraceMs).unref()
        }
        return text(`Cancelling ${params.runId}; every running step is interrupted and nothing further starts.`)
      },
    })
  }

export default createGrannyExtension()
