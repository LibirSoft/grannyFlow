import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveConfig } from '../core/config'
import type { RunInput } from '../core/engine'
import type { CommandResult, PlanResult, Recheck, ResultKind, RunResult } from '../core/types'

// Shared by the in-process host adapters (opencode, omp): config files, preflight, run ids,
// the completion summary, the granny_run input schema and the command runner.

export const SUBMIT: Partial<Record<ResultKind, string>> = {
  implementation: 'granny_submit_implementation',
  draft: 'granny_submit_plan',
  planFix: 'granny_submit_plan_fix',
  findings: 'granny_submit_findings',
  judge: 'granny_submit_judgement',
  final: 'granny_submit_final',
}

export function globalConfigPath(): string {
  if (process.env.GRANNY_CONFIG) return process.env.GRANNY_CONFIG
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'granny', 'config.json')
}

export function readJson(path: string): unknown {
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

export function stamp(): string {
  return new Date().toISOString()
}

export function runId(): string {
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

export const RUN_INPUT_SCHEMA = {
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

export function runCommand(command: string, cwd: string, signal: AbortSignal, killGraceMs: number): Promise<CommandResult> {
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

export function runStatus(runs: Map<string, { dir: string }>, runIdArg?: string, repo?: string): string {
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
