import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../../core/config'
import { checkInput, runGranny, stageCheckErrors, type RunInput } from '../../core/engine'
import { checkShape, SCHEMAS } from '../../core/schemas'
import type { AgentRequest, Host, ResultKind } from '../../core/types'
import { globalConfigPath, pause, preflight, readJson, RUN_INPUT_SCHEMA, runCommand, runId, runStatus, stageRepos, stamp, SUBMIT, summarize } from '../common'

// The omp (oh-my-pi) host. One file, two modes: in the user's omp session it registers granny_run,
// granny_status and granny_cancel and runs the loop; every role runs as its own `omp --mode json`
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
  execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any): Promise<ToolResult>
}

export interface OmpApi {
  registerTool(tool: OmpTool): void
  on(event: 'tool_call', handler: (event: { toolName: string; input: any }) => Promise<{ block: true; reason: string } | undefined>): void
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: 'followUp' }): void
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
}

// omp re-runs the factory for every session in the process; runs started in one must stay visible to all.
const SHARED = Symbol.for('granny-workflow.omp.state')
const shared: { runs: Map<string, RunState> } = ((globalThis as any)[SHARED] ??= { runs: new Map() })
const { runs } = shared

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

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

export interface RetryPolicy {
  delays: number[]
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface ExtensionOptions extends RetryPolicy {
  killGraceMs: number
}

const DEFAULT_DELAYS = [30_000, 120_000, 300_000, 600_000]

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

function signalGroup(child: ChildProcess, name: NodeJS.Signals) {
  try {
    process.kill(-child.pid!, name)
  } catch {}
}

function registerChild(pi: OmpApi, spec: ChildSpec) {
  pi.registerTool({
    name: spec.tool,
    label: spec.tool,
    description: `granny-workflow: submit your final ${spec.kind} result. Call it exactly once, when your task is done.`,
    parameters: SCHEMAS[spec.kind],
    loadMode: 'essential',
    async execute(_id, params) {
      mkdirSync(dirname(spec.out), { recursive: true })
      writeFileSync(spec.out, JSON.stringify(params))
      return text('Recorded. You are done - stop now.')
    },
  })
  pi.on('tool_call', async event => {
    const reason = blockReason(event.toolName, event.input, spec.access, spec.tool)
    return reason ? { block: true, reason } : undefined
  })
}

export const createGrannyExtension =
  ({ delays = DEFAULT_DELAYS, sleep = pause, killGraceMs = 5_000 }: Partial<ExtensionOptions> = {}) =>
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
      const run: RunState = { id, dir, status: 'running', cancelled: false, abort: new AbortController(), children: new Set(), agents: 0 }
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

      const omp = (args: string[], prompt: string, cwd: string, spec: ChildSpec) =>
        new Promise<Turn>((resolve, reject) => {
          if (run.cancelled) return reject(new Error('cancelled'))
          const proc = spawn(bin, args, { cwd, env: { ...process.env, GRANNY_OMP_CHILD: JSON.stringify(spec) }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
          run.children.add(proc)
          let pending = ''
          let stderr = ''
          let assistant: Turn['assistant']
          const scan = (line: string) => {
            try {
              const event = JSON.parse(line)
              if (event?.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message
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
            reject(e.code === 'ENOENT' ? new Error(`cannot run omp: "${bin}" was not found - install omp or set GRANNY_OMP_BIN to its path`) : e)
          })
          proc.on('close', code => {
            run.children.delete(proc)
            if (pending) scan(pending)
            resolve({ code: code ?? 1, assistant, stderr })
          })
          proc.stdin!.end(prompt)
        })

      const converse = async (req: AgentRequest, spec: ChildSpec, args: string[], session: string) => {
        const { tool } = spec
        let prompt = `${req.prompt}\n\nWhen done, call the \`${tool}\` tool exactly once with your result. That call is your final answer: the caller receives only its arguments.`
        let misses = 0
        let backoffs = 0
        let resume = false
        while (misses < 3) {
          rmSync(spec.out, { force: true })
          const turn = await omp(resume ? [...args, '--continue'] : args, prompt, req.cwd, spec)
          resume = true
          if (run.cancelled) throw new Error('cancelled')
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
              if (run.cancelled) throw new Error('cancelled')
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
          if (run.cancelled) throw new Error('cancelled')
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
          journal('agent', { label: req.label, role: req.role, session, model: model ?? null, ...(req.effort ? { effort: req.effort } : {}) })
          return converse(req, spec, args, session)
        },
        async run(command, cwd) {
          if (run.cancelled) return { code: 130, output: 'cancelled' }
          journal('command', { command })
          return runCommand(command, cwd, run.abort.signal, killGraceMs)
        },
        log: message => journal('log', { message }),
        phase: title => journal('phase', { title }),
      }

      const notify = (content: string) => {
        try {
          pi.sendMessage({ customType: 'granny-workflow', content, display: true }, { triggerTurn: true, deliverAs: 'followUp' })
        } catch (e) {
          journal('notify-failed', { error: String((e as Error)?.message ?? e) })
        }
      }

      void runGranny(host, { ...input, config: layers })
        .then(result => {
          run.status = 'done'
          writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
          writeStatus({ finishedAt: stamp() })
          notify(`[granny] Run ${id} finished.\n${summarize(result, config.worktree)}\nCall granny_status with runId "${id}" for the full result, verify load-bearing claims yourself, report to the user and wait. Do not push.`)
        })
        .catch(error => {
          run.status = run.cancelled ? 'cancelled' : 'failed'
          writeStatus({ finishedAt: stamp(), error: String(error?.stack ?? error) })
          journal('error', { error: String(error?.message ?? error) })
          if (!run.cancelled) notify(`[granny] Run ${id} failed: ${String(error?.message ?? error)}\nCall granny_status with runId "${id}" and report to the user.`)
        })
        .catch(() => {})

      return `granny run ${id} started on ${input.repo} (${input.branch}), ${input.goal !== undefined ? 'planning only' : `${input.stages?.length ?? 0} stage(s)${config.parallel ? `, up to ${config.maxParallel} in parallel` : ''}`}, threshold ${config.threshold}, maxRounds ${config.maxRounds}.
Journal: ${join(dir, 'journal.jsonl')}
You will receive a message when it finishes. Use granny_status { runId: "${id}" } to check progress and granny_cancel to stop it. Do not poll in a loop.`
    }

    pi.registerTool({
      name: 'granny_run',
      label: 'granny run',
      description: 'granny-workflow: start the implement → review → judge → fix loop in the background and return a run id. The granny-workflow skill, when installed, describes the inputs and the preflight.',
      parameters: RUN_INPUT_SCHEMA,
      loadMode: 'essential',
      async execute(_id, params: RunInput, _signal, _onUpdate, ctx) {
        try {
          return text(startRun(params, ctx))
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
          return text(runStatus(runs, params.runId, params.repo))
        } catch (e) {
          return text(`granny_status failed: ${(e as Error).message}`)
        }
      },
    })
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
