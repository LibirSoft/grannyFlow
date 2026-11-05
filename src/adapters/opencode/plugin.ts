import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../../core/config'
import { GrannyCancelled, isCancelled } from '../../core/cancel'
import { checkInput, runGranny, stageCheckErrors, type RunInput } from '../../core/engine'
import { checkShape, SCHEMAS } from '../../core/schemas'
import type { AgentRequest, Host, ResultKind } from '../../core/types'
import { DEFAULT_DELAYS, dropPlaceholders, globalConfigPath, type HostOptions, KILL_GRACE_MS, pause, planReviewNotice, preflight, readJson, RUN_INPUT_SCHEMA, RUN_TOOL_DESCRIPTION, runCommand, runDir, runId, runStatus, stageRepos, stamp, statusError, SUBMIT, summarize } from '../common'
import { duration } from '../runview/format'
import { runOutline } from '../runview/outline'

export { globalConfigPath, pause, preflight, stageRepos, summarize } from '../common'
export type { RetryPolicy } from '../common'

type Status = 'running' | 'done' | 'failed' | 'cancelled'

interface RunState {
  id: string
  repo: string
  dir: string
  status: Status
  cancelled: boolean
  abort: AbortController
  sessions: Set<string>
  parent: string
  linked: boolean
  active: Map<string, ActiveRole>
}

interface ActiveRole {
  label: string
  role: string
  model: string | null
  since: number
}

type ModelRef = { providerID: string; id: string; variant?: string }

export const modelText = (model: ModelRef | undefined): string | null =>
  model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` : null

const norm = (dir: unknown) => (typeof dir === 'string' ? dir.replace(/\/+$/, '') : dir)

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

export type PluginOptions = HostOptions

export const createGrannyPlugin = ({ delays = DEFAULT_DELAYS, sleep = pause, killGraceMs = KILL_GRACE_MS }: Partial<PluginOptions> = {}) => ({
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
      const run: RunState = {
        id,
        repo: input.repo,
        dir,
        status: 'running',
        cancelled: false,
        abort: new AbortController(),
        sessions: new Set(),
        parent: parentSession,
        linked: true,
        active: new Map(),
      }
      runs.set(id, run)
      const journal = (type: string, data: Record<string, unknown>) =>
        appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ t: stamp(), type, ...data }) + '\n')
      const outline = runOutline(input, config)
      const writeStatus = (extra: Record<string, unknown> = {}) =>
        writeFileSync(join(dir, 'status.json'), JSON.stringify({ id, status: run.status, repo: input.repo, branch: input.branch, parent: parentSession, watch: config.watch, outline, ...extra }, null, 2))
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
          if (run.cancelled) throw new GrannyCancelled()
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
              if (run.cancelled) throw new GrannyCancelled()
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

      const createRoleSession = async (req: AgentRequest, model: ModelRef | undefined): Promise<{ id: string; linked: boolean }> => {
        const base = {
          title: `granny · ${req.label}`,
          agent: 'build',
          ...(model ? { model } : {}),
          permissions: permissions(req.access),
          metadata: {
            'granny-workflow': { run: id, dir, parent: parentSession, label: req.label, role: req.role, phase: req.phase, model: modelText(model) },
          },
        }
        const make = async (input: Record<string, unknown>) => {
          const session = await ctx.session.create(input)
          run.sessions.add(session.id)
          if (run.cancelled) {
            run.sessions.delete(session.id)
            throw new GrannyCancelled()
          }
          return session
        }
        if (run.linked) {
          let sessionID: string | undefined
          try {
            const session = await make({ ...base, parentID: parentSession })
            sessionID = session.id
            if (norm(session.location?.directory) === norm(req.cwd)) return { id: session.id, linked: true }
            await ctx.session.move({ sessionID, directory: req.cwd })
            await ctx.session.wait({ sessionID })
            if (run.cancelled) throw new GrannyCancelled()
            const info = await ctx.session.get({ sessionID })
            if (norm(info?.location?.directory) !== norm(req.cwd)) {
              throw new Error(`session ${sessionID} is in ${info?.location?.directory} after the move, not in ${req.cwd}`)
            }
            return { id: session.id, linked: true }
          } catch (e) {
            if (sessionID !== undefined) run.sessions.delete(sessionID)
            if (isCancelled(e) || run.cancelled) throw isCancelled(e) ? e : new GrannyCancelled()
            if (run.linked) {
              run.linked = false
              journal('link-failed', { label: req.label, error: String((e as Error)?.message ?? e) })
            }
            if (sessionID !== undefined) {
              try {
                await ctx.session.remove({ sessionID })
              } catch {}
            }
          }
        }
        const session = await make({ ...base, location: { directory: req.cwd } })
        return { id: session.id, linked: false }
      }

      const host: Host = {
        name: 'opencode',
        async agent(req) {
          if (run.cancelled) throw new GrannyCancelled()
          const tool = SUBMIT[req.kind]
          if (!tool) throw new Error(`no submit tool for result kind "${req.kind}"`)
          const model = modelRef(req.model) ?? parentModel
          const session = await createRoleSession(req, model)
          journal('agent', { label: req.label, role: req.role, phase: req.phase, session: session.id, model: model ?? null, linked: session.linked, cwd: req.cwd })
          run.active.set(session.id, { label: req.label, role: req.role, model: modelText(model), since: Date.now() })
          const end = (outcome: 'done' | 'failed' | 'cancelled', error?: string) => {
            run.active.delete(session.id)
            try {
              journal('agent-end', { label: req.label, session: session.id, outcome, ...(error !== undefined ? { error } : {}) })
            } catch {}
          }
          try {
            if (run.cancelled) throw new GrannyCancelled()
            const result = await converse(req, tool, session.id)
            end(result === null ? 'failed' : 'done')
            return result
          } catch (e) {
            if (isCancelled(e)) end('cancelled')
            else end('failed', String((e as Error)?.message ?? e))
            throw e
          } finally {
            run.sessions.delete(session.id)
          }
        },
        cancelled: () => run.cancelled,
        async run(command, cwd) {
          if (run.cancelled) return { code: 130, output: 'cancelled' }
          journal('command', { command })
          return runCommand(command, cwd, run.abort.signal, killGraceMs)
        },
        log: message => journal('log', { message }),
        phase: title => journal('phase', { title }),
        stage: ({ number, name, event, outcome }) => journal('stage', { number, name, event, ...(outcome ? { outcome } : {}) }),
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
          writeStatus({ finishedAt: stamp(), error: statusError(error, run.cancelled) })
          journal('error', { error: String(error?.message ?? error) })
          if (!run.cancelled) await notify(`[granny] Run ${id} failed: ${String(error?.message ?? error)}\nCall granny_status with runId "${id}" and report to the user.`)
        })

      return `granny run ${id} started on ${input.repo} (${input.branch}), ${input.goal !== undefined ? 'planning only' : `${input.stages?.length ?? 0} stage(s)${config.parallel ? `, up to ${config.maxParallel} in parallel` : ''}`}, threshold ${config.threshold}, maxRounds ${config.maxRounds}.
Journal: ${join(dir, 'journal.jsonl')}
You will receive a message when it finishes. Use granny_status { runId: "${id}" } to check progress and granny_cancel to stop it. Do not poll in a loop.${planReviewNotice(input, config)}`
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
        description: RUN_TOOL_DESCRIPTION,
        input: RUN_INPUT_SCHEMA,
        execute: async (value: RunInput, context: any) => {
          try {
            return { content: await startRun(dropPlaceholders(value), context.sessionID) }
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
            const status = runStatus(runs, value.runId, value.repo)
            const dir = runDir(runs, value.runId, value.repo)
            const run = [...runs.values()].find(r => r.dir === dir && r.status === 'running')
            const now = Date.now()
            const active = [...(run?.active ?? [])].map(
              ([session, a]) => `- ${a.label} (${a.role}${a.model ? `, ${a.model}` : ''}) session ${session} · ${duration(now - a.since)}`,
            )
            return { content: active.length ? `${status}\n\nactive roles:\n${active.join('\n')}` : status }
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
