import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveConfig } from '../../core/config'
import { checkInput, runGranny, stageCheckErrors, type RunInput } from '../../core/engine'
import { checkShape, SCHEMAS } from '../../core/schemas'
import type { AgentRequest, CommandResult, Host, PlanResult, Recheck, ResultKind, RunResult } from '../../core/types'

type Status = 'running' | 'done' | 'failed' | 'cancelled'

interface RunState {
  id: string
  repo: string
  dir: string
  status: Status
  cancelled: boolean
  abort: AbortController
  sessions: Set<string>
}

type ModelRef = { providerID: string; id: string; variant?: string }

const SUBMIT: Partial<Record<ResultKind, string>> = {
  implementation: 'granny_submit_implementation',
  draft: 'granny_submit_plan',
  planFix: 'granny_submit_plan_fix',
  findings: 'granny_submit_findings',
  score: 'granny_submit_score',
  final: 'granny_submit_final',
}

// opencode re-imports the plugin as a new module on reload while earlier runs keep going.
const SHARED = Symbol.for('granny-workflow.state')
const shared: { runs: Map<string, RunState>; submissions: Map<string, unknown> } = ((globalThis as any)[SHARED] ??= {
  runs: new Map(),
  submissions: new Map(),
})
const { runs, submissions } = shared

export function modelRef(spec: string | undefined): ModelRef | undefined {
  if (!spec) return undefined
  const [main, variant] = spec.split('#')
  const slash = main!.indexOf('/')
  if (slash <= 0 || slash === main!.length - 1) {
    throw new Error(`opencode models are "provider/model[#variant]", got "${spec}" - set roles.<role>.model.opencode in granny.config.json`)
  }
  return { providerID: main!.slice(0, slash), id: main!.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export function permissions(access: AgentRequest['access']) {
  const rules = [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'question', resource: '*', effect: 'deny' },
    ...['git push *', 'git remote add *', 'git stash *', 'git rebase *', 'git reset --hard *', 'gh pr *'].map(resource => ({
      action: 'shell',
      resource,
      effect: 'deny',
    })),
  ]
  if (access === 'read-only') {
    rules.push(
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'git add *', effect: 'deny' },
      { action: 'shell', resource: 'git commit *', effect: 'deny' },
    )
  }
  return rules
}

export function globalConfigPath(): string {
  if (process.env.GRANNY_CONFIG) return process.env.GRANNY_CONFIG
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'granny', 'config.json')
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${(e as Error).message})`)
  }
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

export function preflight(repo: string, branch: string, workDir: string, worktree: boolean): string[] {
  const problems: string[] = []
  let current = ''
  try {
    current = git(repo, ['branch', '--show-current'])
  } catch (e) {
    return [(e as Error).message]
  }
  if (!worktree && current !== branch) problems.push(`repo is on branch "${current}", expected "${branch}" - create and check it out first`)
  const dirty = !worktree || current === branch
    ? git(repo, ['status', '--porcelain'])
        .split('\n')
        .filter(l => l && !l.slice(3).startsWith(`${workDir}/`) && l.slice(3) !== workDir && l.slice(3) !== `${workDir}/`)
    : []
  if (dirty.length) problems.push(`working tree is not clean:\n${dirty.join('\n')}`)
  if (!problems.length) {
    const commonDir = git(repo, ['rev-parse', '--git-common-dir'])
    const exclude = join(isAbsolute(commonDir) ? commonDir : join(repo, commonDir), 'info', 'exclude')
    const entry = `/${workDir}/`
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes(entry)) {
      mkdirSync(join(exclude, '..'), { recursive: true })
      appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`)
    }
  }
  return problems
}

export function stageRepos(input: RunInput): string[] {
  const top = (p: string) => p.replace(/\/+$/, '') || '/'
  const primary = top(input.repo)
  return [...new Set((input.stages ?? []).flatMap(st => (typeof st.repo === 'string' && top(st.repo) !== primary ? [top(st.repo)] : [])))]
}

function stamp(): string {
  return new Date().toISOString()
}

function runId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`
}

export function summarize(result: RunResult, worktree: boolean): string {
  const line = (s: PlanResult, name: string) => {
    const extra = [
      s.residual.length ? `${s.residual.length} residual` : '',
      s.unresolved.length ? `${s.unresolved.length} unresolved` : '',
    ].filter(Boolean).join(', ')
    const left = s.note?.split('\n').find(l => l.startsWith('uncommitted changes after') || l.startsWith('working tree status unreadable after'))
    const warned = s.note?.split('\n').find(l => l.startsWith('the checks passed, but '))
    return `- ${name}: ${s.outcome}, ${s.rounds} review round(s)${extra ? ` (${extra})` : ''}${left ? ` - ${left}` : ''}${warned ? ` - ${warned}` : ''}`
  }
  const lines = result.stages.map(
    s =>
      `${line(s, s.repo ? `${s.stage} (${s.repo})` : s.stage)}${(s.outcome === 'checks-failed' || s.outcome === 'no-changes') && s.note ? ` - ${s.note.split('\n')[0]}` : ''}${s.note && s.note.includes('in parallel on') ? ` - ${s.note.split('\n').at(-1)}` : ''}`,
  )
  if (result.draft) {
    lines.push(`- plan written: ${result.draft.files.join(', ')} - ${result.draft.stages.length} proposed stage(s)${result.draft.questions ? ', open questions for the user' : ''}`)
    if (result.plan) lines.push(line(result.plan, 'plan review'))
    lines.push('- stopped after planning, nothing was implemented: show the user the plan, the stages and the questions, and wait for their approval')
  } else if (result.plan) {
    const stopped = result.plan.outcome === 'round-cap' || result.plan.outcome === 'review-failed'
    lines.unshift(`${line(result.plan, 'plan review')}${stopped ? ' - stopped before stage 1, nothing was implemented' : ''}`)
  }
  const reviewLine = (s: PlanResult, name: string) =>
    `${line(s, name)}${s.outcome === 'skipped' || s.outcome === 'review-skipped' ? ` - ${s.note ?? 'not run'}` : s.outcome === 'round-cap' || s.outcome === 'review-failed' ? ' - the branch still has unresolved findings; the final check ran anyway' : s.outcome === 'checks-failed' ? ` - NOT PR-ready, the checks fail: ${s.note ?? ''}; the final check ran anyway` : ''}`
  if (result.finalReview) lines.push(reviewLine(result.finalReview, 'final review'))
  for (const r of result.repos?.slice(1) ?? []) if (r.finalReview) lines.push(reviewLine(r.finalReview, `final review ${r.repo}`))
  const recheckLine = (r: Recheck, name: string) =>
    `- ${name}: ${r.passed ? 'green on the HEAD the pr-ready check left' : `RED - NOT PR-ready after the pr-ready check moved HEAD: ${r.note ?? ''}`}`
  if (result.final) lines.push(`- final: gates ${result.final.gatesGreen ? 'green' : 'RED'}, PR body ${result.final.prBodyPath}${result.final.issues ? `, issues: ${result.final.issues}` : ''}`)
  if (result.recheck) lines.push(recheckLine(result.recheck, 'checks after the final check'))
  for (const r of result.repos?.slice(1) ?? []) {
    lines.push(`- final ${r.repo}: ${r.final ? `gates ${r.final.gatesGreen ? 'green' : 'RED'}, PR body ${r.final.prBodyPath}${r.final.issues ? `, issues: ${r.final.issues}` : ''}` : 'returned nothing'}`)
    if (r.recheck) lines.push(recheckLine(r.recheck, `checks after the final check ${r.repo}`))
  }
  if (worktree) lines.push(`- worktree: ${result.worktree}${result.repos?.length ? ` (and ${result.repos.slice(1).map(r => r.worktree).join(', ')})` : ''} - review and push from there; granny never removes it`)
  return lines.join('\n')
}

const RUN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo; the run files go to <repo>/<workDir>/runs/' },
    branch: {
      type: 'string',
      description: 'Feature branch. With config worktree on (default) granny reuses its worktree or creates one - do not check it out yourself; with worktree off it must be checked out in repo',
    },
    base: { type: 'string', description: 'Branch never to touch; defaults to config.base' },
    repos: {
      type: 'array',
      description: 'Other repos the work spans. Stages name the one they work in with repo; each repo gets its own worktree on the same branch',
      items: {
        type: 'object',
        properties: { repo: { type: 'string', description: 'Absolute path' }, base: { type: 'string', description: 'Its base branch; defaults to config.base' } },
        required: ['repo'],
      },
    },
    goal: {
      type: 'string',
      description: 'What to build, when there is no plan yet: the planner writes the plan (to plan, default <repo>/<workDir>/plans/<branch-slug>.md) and proposes stages, the plan review runs, and the run stops for the user to approve. Exclusive with stages and fromStage',
    },
    context: { type: 'string', description: 'Files every agent reads first (work orders, notes) and override notes' },
    plan: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute paths of the plan files (with goal: where the planner writes the plan). Every agent reads them; with config planReview on (off by default) the reviewers review them before stage 1 and the implementer fixes them in place, uncommitted',
    },
    stages: {
      type: 'array',
      description: 'One entry per stop-and-review point; required unless goal is given',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          task: { type: 'string', description: 'Exactly which work orders / sections this stage does; required unless implement is false' },
          implement: { type: 'boolean', description: 'false makes a review-only stage: review base...HEAD, then fix' },
          review: { type: 'boolean', description: 'false skips the review loop for this stage' },
          repo: { type: 'string', description: 'Absolute path of the repo this stage works in: repo (default) or one of repos' },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of the config checks this stage runs before its review and after each fix; omitted: all of them, []: none',
          },
          after: {
            type: 'array',
            items: { type: 'number' },
            description: '1-based numbers of earlier stages this one waits for; [] starts it right away. Omitted: it waits for the previous stage in the same repo. Independent stages run in parallel (config parallel, on by default), a same-repo one in its own worktree that is merged back',
          },
        },
      },
    },
    fromStage: { type: 'number', description: '1-based stage to resume from; earlier stages are skipped' },
    config: { type: 'object', description: 'Per-run overrides of granny.config.json (same shape)' },
  },
  required: ['repo', 'branch'],
}

export interface ProviderError {
  type: string
  message: string
  status?: number
}

export function providerError(messages: unknown): ProviderError | undefined {
  const list: any[] = Array.isArray(messages) ? messages : Array.isArray((messages as any)?.data) ? (messages as any).data : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.type === 'user') return undefined
    if (m?.type !== 'assistant') continue
    if (m.finish !== 'error' && !m.error) return undefined
    const e = m.error ?? {}
    return { type: String(e.type ?? 'unknown'), message: String(e.message ?? ''), ...(typeof e.status === 'number' ? { status: e.status } : {}) }
  }
  return undefined
}

const TRANSIENT_TYPES = new Set(['provider.quota', 'provider.rate-limit', 'provider.timeout', 'provider.transport'])
const TRANSIENT_STATUS = new Set([429, 502, 503, 504, 529])

export function isTransient(error: ProviderError): boolean {
  return TRANSIENT_TYPES.has(error.type) || TRANSIENT_STATUS.has(error.status ?? 0) || /overloaded/i.test(error.message)
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function runCommand(command: string, cwd: string, signal: AbortSignal, killGraceMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve({ code: 130, output: 'cancelled' })
    const child = spawn('bash', ['-c', command], { cwd, env: process.env, detached: true })
    let output = ''
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      resolve(result)
    }
    const signalGroup = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name)
      } catch {}
    }
    const cancel = () => {
      signalGroup('SIGTERM')
      // Not cleared on close: a member that ignores SIGTERM may not hold our pipes.
      setTimeout(() => {
        signalGroup('SIGKILL')
        finish({ code: 130, output: `${output}\ncancelled` })
      }, killGraceMs).unref()
    }
    child.stdout?.on('data', d => (output += d))
    child.stderr?.on('data', d => (output += d))
    child.on('error', e => finish({ code: 127, output: String(e) }))
    child.on('close', code => finish(signal.aborted ? { code: 130, output: `${output}\ncancelled` } : { code: code ?? 1, output }))
    if (child.pid !== undefined) signal.addEventListener('abort', cancel, { once: true })
  })
}

export interface RetryPolicy {
  delays: number[]
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface PluginOptions extends RetryPolicy {
  killGraceMs: number
}

const DEFAULT_DELAYS = [30_000, 120_000, 300_000, 600_000]

export const createGrannyPlugin = ({ delays = DEFAULT_DELAYS, sleep = pause, killGraceMs = 5_000 }: Partial<PluginOptions> = {}) => ({
  id: 'granny-workflow',
  async setup(ctx: any) {
    const startRun = async (input: RunInput, parentSession: string): Promise<string> => {
      const problems = checkInput(input)
      if (problems.length) return `granny_run refused:\n- ${problems.join('\n- ')}`

      const layers = [readJson(globalConfigPath()), readJson(join(input.repo, 'granny.config.json')), input.config]
      const config = resolveConfig(layers, 'opencode')
      const unknownChecks = stageCheckErrors(input.stages, config.checks)
      if (unknownChecks.length) return `granny_run refused:\n- ${unknownChecks.join('\n- ')}`
      const blockers = preflight(input.repo, input.branch, config.workDir, config.worktree)
      for (const repo of stageRepos(input)) blockers.push(...preflight(repo, input.branch, config.workDir, config.worktree).map(b => `${repo}: ${b}`))
      if (blockers.length) return `granny_run refused:\n- ${blockers.join('\n- ')}`

      const id = runId()
      const dir = join(input.repo, config.workDir, 'runs', id)
      mkdirSync(dir, { recursive: true })
      const run: RunState = { id, repo: input.repo, dir, status: 'running', cancelled: false, abort: new AbortController(), sessions: new Set() }
      runs.set(id, run)
      const journal = (type: string, data: Record<string, unknown>) =>
        appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ t: stamp(), type, ...data }) + '\n')
      const writeStatus = (extra: Record<string, unknown> = {}) =>
        writeFileSync(join(dir, 'status.json'), JSON.stringify({ id, status: run.status, repo: input.repo, branch: input.branch, ...extra }, null, 2))
      writeFileSync(join(dir, 'input.json'), JSON.stringify({ ...input, config: layers }, null, 2))
      writeStatus({ startedAt: stamp() })

      let parentModel: ModelRef | undefined
      try {
        parentModel = (await ctx.session.get({ sessionID: parentSession }))?.model
      } catch {}

      const readProviderError = async (sessionID: string, label: string) => {
        try {
          return providerError(await ctx.session.context({ sessionID }))
        } catch (e) {
          journal('context-failed', { label, session: sessionID, error: String((e as Error)?.message ?? e) })
          return undefined
        }
      }

      const converse = async (req: AgentRequest, tool: string, session: string) => {
        let text = `${req.prompt}\n\nWhen done, call the \`${tool}\` tool exactly once with your result. That call is your final answer: the caller receives only its arguments.`
        let misses = 0
        let backoffs = 0
        while (misses < 3) {
          submissions.delete(session)
          await ctx.session.prompt({ sessionID: session, text })
          await ctx.session.wait({ sessionID: session })
          if (run.cancelled) throw new Error('cancelled')
          const got = submissions.get(session)
          if (got !== undefined) {
            const errors = checkShape(req.schema, got)
            if (!errors.length) return got
            text = `Your ${tool} call was invalid: ${errors.join('; ')}. Call ${tool} again with the corrected, complete result.`
          } else {
            const error = await readProviderError(session, req.label)
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
              text = `Your previous turn ended on a provider error (${error.type}${error.message ? `: ${error.message.slice(0, 300)}` : ''}). Continue the task where it stopped; when you are done, call \`${tool}\` exactly once with your result.`
              continue
            }
            text = `You stopped without calling ${tool}. Call it now with your result.`
          }
          journal('retry', { label: req.label, attempt: ++misses, reason: text.slice(0, 200) })
        }
        journal('agent-failed', { label: req.label, session })
        return null
      }

      const host: Host = {
        name: 'opencode',
        async agent(req) {
          if (run.cancelled) throw new Error('cancelled')
          const tool = SUBMIT[req.kind]
          if (!tool) throw new Error(`no submit tool for result kind "${req.kind}"`)
          const model = modelRef(req.model) ?? parentModel
          const session = await ctx.session.create({
            title: `granny · ${req.label}`,
            agent: 'build',
            ...(model ? { model } : {}),
            location: { directory: req.cwd },
            permissions: permissions(req.access),
          })
          run.sessions.add(session.id)
          journal('agent', { label: req.label, role: req.role, session: session.id, model: model ?? null })
          try {
            if (run.cancelled) throw new Error('cancelled')
            return await converse(req, tool, session.id)
          } finally {
            run.sessions.delete(session.id)
          }
        },
        async run(command, cwd) {
          if (run.cancelled) return { code: 130, output: 'cancelled' }
          journal('command', { command })
          return runCommand(command, cwd, run.abort.signal, killGraceMs)
        },
        log: message => journal('log', { message }),
        phase: title => journal('phase', { title }),
      }

      const notify = async (text: string) => {
        try {
          await ctx.session.prompt({ sessionID: parentSession, text })
        } catch (e) {
          journal('notify-failed', { error: String(e) })
        }
      }

      void runGranny(host, { ...input, config: layers })
        .then(async result => {
          run.status = 'done'
          writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
          writeStatus({ finishedAt: stamp() })
          await notify(`[granny] Run ${id} finished.\n${summarize(result, config.worktree)}\nCall granny_status with runId "${id}" for the full result, verify load-bearing claims yourself, report to the user and wait. Do not push.`)
        })
        .catch(async error => {
          run.status = run.cancelled ? 'cancelled' : 'failed'
          writeStatus({ finishedAt: stamp(), error: String(error?.stack ?? error) })
          journal('error', { error: String(error?.message ?? error) })
          if (!run.cancelled) await notify(`[granny] Run ${id} failed: ${String(error?.message ?? error)}\nCall granny_status with runId "${id}" and report to the user.`)
        })

      return `granny run ${id} started on ${input.repo} (${input.branch}), ${input.goal !== undefined ? 'planning only' : `${input.stages?.length ?? 0} stage(s)${config.parallel ? `, up to ${config.maxParallel} in parallel` : ''}`}, threshold ${config.threshold}, maxRounds ${config.maxRounds}.
Journal: ${join(dir, 'journal.jsonl')}
You will receive a message when it finishes. Use granny_status { runId: "${id}" } to check progress and granny_cancel to stop it. Do not poll in a loop.`
    }

    const status = (runIdArg?: string, repo?: string): string => {
      let dir: string | undefined
      if (runIdArg && runs.has(runIdArg)) dir = runs.get(runIdArg)!.dir
      else if (repo) {
        const config = resolveConfig([readJson(globalConfigPath()), readJson(join(repo, 'granny.config.json'))])
        const root = join(repo, config.workDir, 'runs')
        const ids = existsSync(root) ? readdirSync(root).sort() : []
        const pick = runIdArg ?? ids.at(-1)
        if (pick && ids.includes(pick)) dir = join(root, pick)
      }
      if (!dir) return 'No such granny run. Pass runId, or repo to see the latest run in that repo.'
      const read = (f: string) => (existsSync(join(dir!, f)) ? readFileSync(join(dir!, f), 'utf8') : '')
      const tail = read('journal.jsonl').trim().split('\n').slice(-40).join('\n')
      const result = read('result.json')
      return [
        `status: ${read('status.json')}`,
        `journal (last 40 lines):\n${tail}`,
        result ? `result (${join(dir, 'result.json')}):\n${result.length > 30000 ? result.slice(0, 30000) + '\n...truncated, read the file' : result}` : '',
      ].filter(Boolean).join('\n\n')
    }

    await ctx.tool.transform((editor: any) => {
      for (const [kind, name] of Object.entries(SUBMIT)) {
        editor.add({
          name,
          description: `granny-workflow: submit your final ${kind} result. Only call this when a granny-workflow prompt asks you to.`,
          input: SCHEMAS[kind as ResultKind],
          execute: async (value: unknown, context: any) => {
            submissions.set(context.sessionID, value)
            return { content: 'Recorded. You are done - stop now.' }
          },
        })
      }
      editor.add({
        name: 'granny_run',
        description: 'granny-workflow: start the implement → review → judge → fix loop in the background and return a run id. The granny-workflow skill, when installed, describes the inputs and the preflight.',
        input: RUN_INPUT_SCHEMA,
        execute: async (value: RunInput, context: any) => {
          try {
            return { content: await startRun(value, context.sessionID) }
          } catch (e) {
            return { content: `granny_run failed to start: ${(e as Error).message}` }
          }
        },
      })
      editor.add({
        name: 'granny_status',
        description: 'granny-workflow: status, journal tail and result of a granny run.',
        input: {
          type: 'object',
          properties: { runId: { type: 'string' }, repo: { type: 'string', description: 'Absolute repo path; finds the latest run when runId is omitted' } },
        },
        execute: async (value: { runId?: string; repo?: string }) => {
          try {
            return { content: status(value.runId, value.repo) }
          } catch (e) {
            return { content: `granny_status failed: ${(e as Error).message}` }
          }
        },
      })
      editor.add({
        name: 'granny_cancel',
        description: 'granny-workflow: cancel a running granny run.',
        input: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        execute: async (value: { runId: string }) => {
          const run = runs.get(value.runId)
          if (!run || run.status !== 'running') return { content: `No running granny run "${value.runId}".` }
          run.cancelled = true
          run.abort.abort()
          await Promise.all([...run.sessions].map(sessionID => ctx.session.interrupt({ sessionID, resume: false }).catch(() => {})))
          return { content: `Cancelling ${value.runId}; every running step is interrupted and nothing further starts.` }
        },
      })
    })
  },
})

export default createGrannyPlugin()
