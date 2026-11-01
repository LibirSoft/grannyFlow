import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveConfig } from '../../core/config'
import { checkInput, runGranny, type RunInput } from '../../core/engine'
import { checkShape, SCHEMAS } from '../../core/schemas'
import type { AgentRequest, Host, ResultKind, RunResult } from '../../core/types'

type Status = 'running' | 'done' | 'failed' | 'cancelled'

interface RunState {
  id: string
  repo: string
  dir: string
  status: Status
  cancelled: boolean
  session?: string
  child?: ChildProcess
}

type ModelRef = { providerID: string; id: string; variant?: string }

const SUBMIT: Partial<Record<ResultKind, string>> = {
  implementation: 'granny_submit_implementation',
  findings: 'granny_submit_findings',
  score: 'granny_submit_score',
  final: 'granny_submit_final',
}

const runs = new Map<string, RunState>()
const submissions = new Map<string, unknown>()

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

export function preflight(repo: string, branch: string, workDir: string): string[] {
  const problems: string[] = []
  let current = ''
  try {
    current = git(repo, ['branch', '--show-current'])
  } catch (e) {
    return [(e as Error).message]
  }
  if (current !== branch) problems.push(`repo is on branch "${current}", expected "${branch}" - create and check it out first`)
  const dirty = git(repo, ['status', '--porcelain'])
    .split('\n')
    .filter(l => l && !l.slice(3).startsWith(`${workDir}/`) && l.slice(3) !== workDir && l.slice(3) !== `${workDir}/`)
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

function stamp(): string {
  return new Date().toISOString()
}

function runId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`
}

function summarize(result: RunResult): string {
  const lines = result.stages.map(s => {
    const extra = [
      s.residual.length ? `${s.residual.length} residual` : '',
      s.unresolved.length ? `${s.unresolved.length} unresolved` : '',
    ].filter(Boolean).join(', ')
    return `- ${s.stage}: ${s.outcome}, ${s.rounds} review round(s)${extra ? ` (${extra})` : ''}`
  })
  if (result.final) lines.push(`- final: gates ${result.final.gatesGreen ? 'green' : 'RED'}, PR body ${result.final.prBodyPath}${result.final.issues ? `, issues: ${result.final.issues}` : ''}`)
  return lines.join('\n')
}

const RUN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'Absolute path of the git repo or worktree' },
    branch: { type: 'string', description: 'Feature branch, already created and checked out' },
    base: { type: 'string', description: 'Branch never to touch; defaults to config.base' },
    context: { type: 'string', description: 'Files every agent reads first (plan, work orders) and override notes' },
    stages: {
      type: 'array',
      description: 'One entry per stop-and-review point',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          task: { type: 'string', description: 'Exactly which work orders / sections this stage does; required unless implement is false' },
          implement: { type: 'boolean', description: 'false makes a review-only stage: review base...HEAD, then fix' },
          review: { type: 'boolean', description: 'false skips the review loop for this stage' },
        },
      },
    },
    fromStage: { type: 'number', description: '1-based stage to resume from; earlier stages are skipped' },
    config: { type: 'object', description: 'Per-run overrides of granny.config.json (same shape)' },
  },
  required: ['repo', 'branch', 'stages'],
}

export default {
  id: 'granny-workflow',
  async setup(ctx: any) {
    const startRun = async (input: RunInput, parentSession: string): Promise<string> => {
      const problems = checkInput(input)
      if (problems.length) return `granny_run refused:\n- ${problems.join('\n- ')}`

      const layers = [readJson(globalConfigPath()), readJson(join(input.repo, 'granny.config.json')), input.config]
      const config = resolveConfig(layers)
      const blockers = preflight(input.repo, input.branch, config.workDir)
      if (blockers.length) return `granny_run refused:\n- ${blockers.join('\n- ')}`

      const id = runId()
      const dir = join(input.repo, config.workDir, 'runs', id)
      mkdirSync(dir, { recursive: true })
      const run: RunState = { id, repo: input.repo, dir, status: 'running', cancelled: false }
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
            location: { directory: input.repo },
            permissions: permissions(req.access),
          })
          run.session = session.id
          journal('agent', { label: req.label, role: req.role, session: session.id, model: model ?? null })
          let text = `${req.prompt}\n\nWhen you are done, call the \`${tool}\` tool exactly once with your result. That call is your final answer: its arguments are everything the caller receives.`
          for (let attempt = 1; attempt <= 3; attempt++) {
            submissions.delete(session.id)
            await ctx.session.prompt({ sessionID: session.id, text })
            await ctx.session.wait({ sessionID: session.id })
            if (run.cancelled) throw new Error('cancelled')
            const got = submissions.get(session.id)
            if (got !== undefined) {
              const errors = checkShape(req.schema, got)
              if (!errors.length) return got
              text = `Your ${tool} call was invalid: ${errors.join('; ')}. Call ${tool} again with the corrected, complete result.`
            } else {
              text = `You stopped without calling ${tool}. Call it now with your result.`
            }
            journal('retry', { label: req.label, attempt, reason: text.slice(0, 200) })
          }
          journal('agent-failed', { label: req.label, session: session.id })
          return null
        },
        run(command, cwd) {
          return new Promise(resolve => {
            if (run.cancelled) return resolve({ code: 130, output: 'cancelled' })
            journal('command', { command })
            const child = spawn('bash', ['-c', command], { cwd, env: process.env })
            run.child = child
            let output = ''
            child.stdout?.on('data', d => (output += d))
            child.stderr?.on('data', d => (output += d))
            child.on('error', e => resolve({ code: 127, output: String(e) }))
            child.on('close', code => {
              run.child = undefined
              resolve({ code: code ?? 1, output })
            })
          })
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
          await notify(`[granny] Run ${id} finished.\n${summarize(result)}\nCall granny_status with runId "${id}" for the full result, verify load-bearing claims yourself, report to the user and wait. Do not push.`)
        })
        .catch(async error => {
          run.status = run.cancelled ? 'cancelled' : 'failed'
          writeStatus({ finishedAt: stamp(), error: String(error?.stack ?? error) })
          journal('error', { error: String(error?.message ?? error) })
          if (!run.cancelled) await notify(`[granny] Run ${id} failed: ${String(error?.message ?? error)}\nCall granny_status with runId "${id}" and report to the user.`)
        })

      return `granny run ${id} started on ${input.repo} (${input.branch}), ${input.stages.length} stage(s), threshold ${config.threshold}, maxRounds ${config.maxRounds}.
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
          run.child?.kill('SIGTERM')
          if (run.session) await ctx.session.interrupt({ sessionID: run.session, resume: false }).catch(() => {})
          return { content: `Cancelling ${value.runId}; the current step is interrupted and nothing further starts.` }
        },
      })
    })
  },
}
