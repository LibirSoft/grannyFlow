import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAME_MODEL_HINT } from '../src/adapters/common'
import plugin, { createGrannyPlugin, isTransient, modelRef, pause, permissions, preflight, providerError, summarize } from '../src/adapters/opencode/plugin'
import { brokerCompanion, records, sessionEndHook } from './fake-companion'
import { planReviewWarning } from '../src/core/config'

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'granny-plugin-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'checkout', '-qb', 'feat/x')
  return repo
}

const CANNED: Record<string, unknown> = {
  granny_submit_implementation: { startSha: 'aaa', headSha: 'bbb', gatesGreen: true, gates: 'ok', commits: ['c1'], untested: '' },
  granny_submit_judgement: {
    perFinding: [{ id: 'codex-F1', verdict: 'confirmed', impact: 'critical', likelihood: 'edge', fixCost: 'small', scope: 'in-scope', evidence: 'a.txt:1 - real', reason: 'real' }],
    rationale: 'ok',
  },
  granny_submit_final: { gatesGreen: true, gates: 'ok', commits: ['c1'], prBodyPath: '.granny/PR-BODY.md', issues: '' },
  granny_submit_findings: { findings: [] },
  granny_submit_plan_fix: { files: ['/plan.md'], changes: 'fixed' },
}

type FakeError = { type: string; message: string; status?: number }

interface Behaviour {
  skipSubmitOnce?: boolean
  contextThrows?: boolean
  providerError?: (title: string, attempt: number) => FakeError | undefined
  hangUntilInterrupted?: (title: string) => boolean
  createFails?: (title: string) => boolean
  parentDir?: string
  moveFails?: (title: string) => boolean
  moveIgnored?: (title: string) => boolean
  hangMove?: (title: string) => boolean
  removeFails?: boolean
  promptFails?: (title: string) => boolean
}

function fakeContext(behaviour: Behaviour = {}) {
  const tools = new Map<string, any>()
  const created: any[] = []
  const creates: any[] = []
  const moves: Array<{ sessionID: string; directory: string }> = []
  const removed: string[] = []
  const calls: string[] = []
  const parent = { id: 'parent', model: { providerID: 'opencode', id: 'parent-model' }, location: { directory: behaviour.parentDir ?? '/parent-dir' } }
  const prompts: Array<{ sessionID: string; text: string }> = []
  const pending = new Map<string, string>()
  const messages = new Map<string, any[]>()
  const attempts = new Map<string, number>()
  const interrupted: string[] = []
  const wake = new Map<string, () => void>()
  let n = 0
  let skipped = false
  const ctx = {
    tool: {
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (t: any) => tools.set(t.name, t) })
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === 'parent') return structuredClone(parent)
        const s = created.find(c => c.id === sessionID)
        if (!s) throw new Error(`session.get: no session ${sessionID}`)
        return structuredClone(s)
      },
      create: async (input: any) => {
        creates.push(input)
        if (behaviour.createFails?.(input.title)) throw new Error('session.create: 503 Service Unavailable')
        const location = input.parentID ? parent.location : input.location
        const s = { id: `ses_${++n}`, ...input, location: structuredClone(location) }
        created.push(s)
        messages.set(s.id, [])
        return structuredClone(s)
      },
      move: async (input: { sessionID: string; directory: string }) => {
        moves.push(input)
        calls.push(`move ${input.sessionID}`)
        const s = created.find(c => c.id === input.sessionID)
        const title = s?.title ?? ''
        if (behaviour.moveFails?.(title)) throw new Error('session.move: directory not found')
        if (behaviour.hangMove?.(title)) {
          await new Promise<void>(resolve => wake.set(input.sessionID, resolve))
          return {}
        }
        if (!behaviour.moveIgnored?.(title)) s.location = { directory: input.directory }
        return {}
      },
      remove: ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID)
        if (behaviour.removeFails) throw new Error('session.remove: 500')
        return Promise.resolve(true)
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        if (behaviour.promptFails?.(created.find(c => c.id === input.sessionID)?.title ?? '')) throw new Error('session.prompt: 500 Internal Server Error')
        prompts.push(input)
        calls.push(`prompt ${input.sessionID}`)
        pending.set(input.sessionID, input.text)
        messages.get(input.sessionID)?.push({ type: 'user', text: input.text })
        return {}
      },
      wait: async ({ sessionID }: { sessionID: string }) => {
        if (!pending.has(sessionID)) return
        const text = pending.get(sessionID)!
        pending.delete(sessionID)
        const log = messages.get(sessionID) ?? []
        const attempt = (attempts.get(sessionID) ?? 0) + 1
        attempts.set(sessionID, attempt)
        const title = created.find(s => s.id === sessionID)?.title ?? ''
        if (behaviour.hangUntilInterrupted?.(title)) {
          await new Promise<void>(resolve => wake.set(sessionID, resolve))
          return
        }
        const error = behaviour.providerError?.(title, attempt)
        if (error) {
          log.push({ type: 'assistant', finish: 'error', error, content: [] }, { type: 'idle', outcome: 'failed' })
          return
        }
        log.push({ type: 'assistant', finish: 'stop', content: [] }, { type: 'idle', outcome: 'succeeded' })
        const name = /(granny_submit_\w+)/.exec(text)?.[1]
        if (!name) return
        if (behaviour.skipSubmitOnce && !skipped) {
          skipped = true
          return
        }
        const dir = created.find(s => s.id === sessionID)?.location?.directory
        if (name === 'granny_submit_implementation' && dir) git(dir, 'commit', '-q', '--allow-empty', '-m', `feat: ${title}`)
        await tools.get(name).execute(CANNED[name], { sessionID })
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        if (behaviour.contextThrows) throw new Error('context unavailable')
        return [...(messages.get(sessionID) ?? [])]
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        interrupted.push(sessionID)
        wake.get(sessionID)?.()
        return { interrupted: true }
      },
    },
  }
  return { ctx, tools, created, creates, moves, removed, calls, prompts, interrupted }
}

const REVIEW_ONCE = `test -n {base} && if [ -e .granny/reviewed ]; then echo "No findings." > {out}; else touch .granny/reviewed; printf '%s\\n' '- [P2] Real issue — a.txt:1' '  detail' > {out}; fi`

async function startRun(repo: string, f: ReturnType<typeof fakeContext>, extra: Record<string, unknown> = {}) {
  writeFileSync(join(repo, 'granny.config.json'), JSON.stringify({ reviewers: [{ name: 'codex', engine: 'command', command: REVIEW_ONCE }], ...extra }))
  git(repo, 'add', 'granny.config.json')
  git(repo, 'commit', '-qm', 'cfg')
  const started = await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }, { sessionID: 'parent' })
  const id = /granny run (\S+) started/.exec(started.content)?.[1]
  expect(id).toBeDefined()
  return { id: id!, dir: join(repo, '.granny/runs', id!) }
}

const readRun = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '')
const journalOf = (dir: string) => readRun(dir, 'journal.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

async function finished(dir: string) {
  await waitFor(() => existsSync(join(dir, 'result.json'))).catch(e => {
    throw new Error(`${e.message}\nstatus: ${readRun(dir, 'status.json')}\njournal:\n${readRun(dir, 'journal.jsonl')}`)
  })
  return JSON.parse(readRun(dir, 'result.json'))
}

const promptsTo = (f: ReturnType<typeof fakeContext>, title: string) => {
  const ids = f.created.filter(s => s.title === title).map(s => s.id)
  return f.prompts.filter(p => ids.includes(p.sessionID)).map(p => p.text)
}

async function waitFor(check: () => boolean, ms = 4000) {
  const until = performance.now() + ms
  while (!check()) {
    if (performance.now() > until) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

describe('opencode plugin helpers', () => {
  it('says in the finish summary that the branch is not PR-ready when the checks rerun after the final check are red', () => {
    const final = { gatesGreen: true, gates: 'ok', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
    const result = {
      repo: '/r',
      branch: 'feat/x',
      base: 'main',
      worktree: '/r',
      stages: [],
      final,
      recheck: { passed: false, note: 'checks failed at pr-ready after 0 repair(s): tests (exit 1); out of repairs: tests (0)' },
      repos: [
        { repo: '/r', base: 'main', worktree: '/r', final },
        { repo: '/s', base: 'main', worktree: '/s', recheck: { passed: true }, final },
      ],
    }
    const text = summarize(result, false)
    expect(text).toContain('- final: gates green, PR body .granny/PR-BODY.md\n- checks after the final check: RED - NOT PR-ready after the pr-ready check moved HEAD: checks failed at pr-ready after 0 repair(s): tests (exit 1); out of repairs: tests (0)')
    expect(text).toContain('- checks after the final check /s: green on the HEAD the pr-ready check left')
    expect(summarize({ ...result, recheck: undefined, repos: undefined }, false)).not.toContain('checks after the final check')
  })

  it('names work left uncommitted in the finish summary', () => {
    const final = { gatesGreen: true, gates: 'ok', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
    const left = 'uncommitted changes after implement: M src/a.ts - the review saw HEAD without them'
    const stage = { stage: 'one', outcome: 'clean' as const, rounds: 1, residual: [], unresolved: [], history: [], note: left }
    const finalReview = { outcome: 'clean' as const, rounds: 2, residual: [], unresolved: [], history: [], note: 'uncommitted changes after fix r1: ?? out.txt - the review saw HEAD without them' }
    const text = summarize(
      { repo: '/r', branch: 'feat/x', base: 'main', worktree: '/r', stages: [stage], finalReview, final, recheck: { passed: false, note: 'uncommitted changes after the checks at pr-ready: ?? out.txt' } },
      false,
    )
    expect(text).toContain(`- one: clean, 1 review round(s) - ${left}`)
    expect(text).toContain('- final review: clean, 2 review round(s) - uncommitted changes after fix r1: ?? out.txt - the review saw HEAD without them')
    expect(text).toContain('- checks after the final check: RED - NOT PR-ready after the pr-ready check moved HEAD: uncommitted changes after the checks at pr-ready: ?? out.txt')
  })

  it('names a working tree status that could not be read in the finish summary', () => {
    const final = { gatesGreen: true, gates: 'ok', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
    const unread = 'working tree status unreadable after implement (exit 128: fatal: index file corrupt) - the review saw HEAD and may have missed uncommitted work'
    const stage = { stage: 'one', outcome: 'clean' as const, rounds: 1, residual: [], unresolved: [], history: [], note: unread }
    const text = summarize({ repo: '/r', branch: 'feat/x', base: 'main', worktree: '/r', stages: [stage], final }, false)
    expect(text).toContain(`- one: clean, 1 review round(s) - ${unread}`)
  })

  it('names the red gates a checked stage reported in the finish summary', () => {
    const final = { gatesGreen: true, gates: 'ok', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
    const warned = 'the checks passed, but the implementer reported red gates: lint red'
    const stage = { stage: 'one', outcome: 'clean' as const, rounds: 1, residual: [], unresolved: [], history: [], note: warned }
    const text = summarize({ repo: '/r', branch: 'feat/x', base: 'main', worktree: '/r', stages: [stage], final }, false)
    expect(text).toContain(`- one: clean, 1 review round(s) - ${warned}`)
  })

  it('names the work a no-changes stage left uncommitted in the finish summary', () => {
    const final = { gatesGreen: true, gates: 'ok', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
    const note = 'the implementer made no commit: the work it left is uncommitted (?? f.txt), so there was nothing to review'
    const stage = { stage: 'one', outcome: 'no-changes' as const, rounds: 0, residual: [], unresolved: [], history: [], note }
    const text = summarize({ repo: '/r', branch: 'feat/x', base: 'main', worktree: '/r', stages: [stage], final }, false)
    expect(text).toContain(`- one: no-changes, 0 review round(s) - ${note}`)
  })

  it('parses provider/model#variant refs', () => {
    expect(modelRef('anthropic/claude-sonnet-5-5#high')).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-5-5', variant: 'high' })
    expect(modelRef('zai-coding-plan/glm-5.3')).toEqual({ providerID: 'zai-coding-plan', id: 'glm-5.3' })
    expect(modelRef(undefined)).toBeUndefined()
    expect(() => modelRef('sonnet')).toThrow('provider/model')
  })

  it('denies edits and commits to read-only roles and pushes to everyone', () => {
    const write = permissions('write')
    const ro = permissions('read-only')
    expect(write.at(0)).toEqual({ action: '*', resource: '*', effect: 'allow' })
    expect(write).toContainEqual({ action: 'shell', resource: 'git push *', effect: 'deny' })
    expect(write).toContainEqual({ action: 'question', resource: '*', effect: 'deny' })
    expect(write).not.toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
    expect(ro).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
    expect(ro).toContainEqual({ action: 'shell', resource: 'git commit *', effect: 'deny' })
  })

  it('reads the provider error of the latest turn only', () => {
    const quota = { type: 'provider.quota', message: 'Quota exceeded', status: 429 }
    const failed = [{ type: 'user', text: 'go' }, { type: 'assistant', finish: 'error', error: quota, content: [] }, { type: 'idle', outcome: 'failed' }]
    const succeeded = [{ type: 'user', text: 'go on' }, { type: 'assistant', finish: 'stop', content: [] }, { type: 'idle', outcome: 'succeeded' }]
    expect(providerError(failed)).toEqual(quota)
    expect(providerError({ data: failed })).toEqual(quota)
    expect(providerError([...failed, ...succeeded])).toBeUndefined()
    expect(providerError([...succeeded, ...failed])).toEqual(quota)
    expect(providerError([failed[0], failed[1], { type: 'assistant', finish: 'tool-calls', content: [] }, { type: 'idle', outcome: 'succeeded' }])).toBeUndefined()
    expect(providerError([{ type: 'user', text: 'go' }, { type: 'assistant', finish: 'error', content: [] }])).toEqual({ type: 'unknown', message: '' })
    expect(providerError(succeeded)).toBeUndefined()
    expect(providerError(undefined)).toBeUndefined()
  })

  it('treats quota, rate limits, timeouts, dropped connections and overload as transient', () => {
    for (const type of ['provider.quota', 'provider.rate-limit', 'provider.timeout', 'provider.transport']) {
      expect(isTransient({ type, message: '' })).toBe(true)
    }
    expect(isTransient({ type: 'provider.internal', message: 'Overloaded', status: 529 })).toBe(true)
    expect(isTransient({ type: 'provider.internal', message: 'overloaded_error: Overloaded' })).toBe(true)
    expect(isTransient({ type: 'provider.internal', message: 'Service Unavailable', status: 503 })).toBe(true)
    expect(isTransient({ type: 'provider.internal', message: 'boom', status: 500 })).toBe(false)
    for (const type of ['provider.auth', 'provider.content-filter', 'provider.invalid-request', 'provider.no-route', 'unknown']) {
      expect(isTransient({ type, message: 'nope' })).toBe(false)
    }
  })

  it('pauses until the time is up or the run is cancelled', async () => {
    const t0 = performance.now()
    await pause(20, new AbortController().signal)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(15)

    const ctl = new AbortController()
    const t1 = performance.now()
    const waiting = pause(60_000, ctl.signal)
    ctl.abort()
    await waiting
    await pause(60_000, ctl.signal)
    expect(performance.now() - t1).toBeLessThan(1000)
  })
})

describe('opencode plugin', () => {
  let repo: string
  beforeEach(() => {
    repo = makeRepo()
    process.env.GRANNY_CONFIG = join(repo, 'no-global-config.json')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(`${repo}-worktrees`, { recursive: true, force: true })
    delete process.env.GRANNY_CONFIG
  })

  it('preflight with the worktree off refuses the wrong branch and a dirty tree, then git-excludes the work dir', () => {
    git(repo, 'checkout', '-q', 'main')
    expect(preflight(repo, 'feat/x', '.granny', false)[0]).toContain('expected "feat/x"')
    git(repo, 'checkout', '-q', 'feat/x')
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    expect(preflight(repo, 'feat/x', '.granny', false)[0]).toContain('dirty.txt')
    rmSync(join(repo, 'dirty.txt'))
    expect(preflight(repo, 'feat/x', '.granny', false)).toEqual([])
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.granny/\n')
    expect(preflight(repo, 'feat/x', '.granny', false)).toEqual([])
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('/.granny/').length).toBe(2)
  })

  it('preflight with the worktree on accepts any branch in repo, and a dirty repo unless the branch is checked out there', () => {
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    expect(preflight(repo, 'feat/x', '.granny', true)).toEqual([])
    expect(preflight(repo, 'feat/new', '.granny', true)).toEqual([])
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('/.granny/').length).toBe(2)
    git(repo, 'checkout', '-q', 'feat/x')
    const problems = preflight(repo, 'feat/x', '.granny', true)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('working tree is not clean')
    expect(problems[0]).toContain('dirty.txt')
    rmSync(join(repo, 'dirty.txt'))
    expect(preflight(repo, 'feat/x', '.granny', true)).toEqual([])
  })

  it('registers the run, status, cancel and submit tools', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    expect([...f.tools.keys()].sort()).toEqual([
      'granny_cancel',
      'granny_judge',
      'granny_run',
      'granny_status',
      'granny_submit_final',
      'granny_submit_findings',
      'granny_submit_implementation',
      'granny_submit_judgement',
      'granny_submit_plan',
      'granny_submit_plan_fix',
    ])
  })

  describe('granny_judge', () => {
    const MODELS = { reviewers: [{ name: 'codex', engine: 'command', command: REVIEW_ONCE }], roles: { judge: { model: { opencode: 'prov/tag' } } } }
    const ASK = "Ask the user for these per the skill's references/judge.md and write them to the config. Do not choose a model yourself."
    const configure = (config: unknown) => {
      writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
      git(repo, 'add', 'granny.config.json')
      git(repo, 'commit', '-qm', 'cfg')
    }
    const call = async (f: ReturnType<typeof fakeContext>, params: Record<string, unknown> = {}) => (await f.tools.get('granny_judge').execute({ repo, ...params }, { sessionID: 'parent' })).content as string
    const tool = async (behaviour?: Parameters<typeof fakeContext>[0]) => {
      const f = fakeContext(behaviour)
      await plugin.setup(f.ctx)
      return f
    }
    const launch = async (f: ReturnType<typeof fakeContext>, params: Record<string, unknown> = {}) => {
      const started = await call(f, params)
      const id = /granny judge run (\S+) started/.exec(started)?.[1]
      if (!id) throw new Error(started)
      return { id, started, dir: join(repo, '.granny/runs', id) }
    }
    const toParent = (f: ReturnType<typeof fakeContext>) => f.prompts.filter(p => p.sessionID === 'parent').map(p => p.text)

    it('refuses without config, naming every gap and telling the agent to ask the user, before anything runs', async () => {
      const f = await tool()
      expect((await call(f)).split('\n')).toEqual(['granny_judge refused:', '- reviewers: no config sets who reviews', '- roles.judge.model: no model for opencode', ASK])
      expect(f.creates).toEqual([])
      expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
    })

    it('refuses an agent reviewer with no model for opencode', async () => {
      const f = await tool()
      configure({ ...MODELS, reviewers: [{ name: 'kimi', engine: 'agent', model: { omp: 'a/b' } }] })
      expect((await call(f)).split('\n')).toEqual(['granny_judge refused:', '- reviewers[0] (kimi): no model for opencode', ASK])
    })

    it('refuses no judge model for opencode', async () => {
      const f = await tool()
      configure({ reviewers: MODELS.reviewers })
      expect((await call(f)).split('\n')).toEqual(['granny_judge refused:', '- roles.judge.model: no model for opencode', ASK])
    })

    it('does not let the run\'s own config answer the gate, so the agent cannot pick the models itself', async () => {
      const f = await tool()
      const reply = await call(f, { config: MODELS })
      expect(reply).toStartWith('granny_judge refused:')
      expect(reply).toEndWith(ASK)
    })

    it('refuses a model opencode cannot run', async () => {
      const f = await tool()
      configure({ reviewers: [{ name: 'r', engine: 'agent', model: 'sonnet' }], roles: { judge: { model: 'haiku' } } })
      const reply = await call(f)
      expect(reply).toStartWith('granny_judge refused:')
      expect(reply).toContain('roles.judge.model: "haiku"')
      expect(reply).toContain('reviewers[0] "r": model "sonnet"')
      expect(reply).not.toContain(ASK)
      expect(f.creates).toEqual([])
    })

    it('does not refuse a bad implementer model, which a judge run never uses', async () => {
      const f = await tool()
      configure({ ...MODELS, roles: { ...MODELS.roles, implementer: { model: 'sonnet' } } })
      const { dir } = await launch(f)
      expect((await finished(dir)).outcome).toBe('reviewed')
    })

    it('refuses a relative repo and a directory that is not a git repository', async () => {
      const f = await tool()
      expect(await call(f, { repo: 'relative/path' })).toBe('granny_judge refused:\n- repo must be an absolute path')
      const plain = mkdtempSync(join(tmpdir(), 'granny-plain-'))
      writeFileSync(join(plain, 'granny.config.json'), JSON.stringify(MODELS))
      const reply = await call(f, { repo: plain })
      rmSync(plain, { recursive: true, force: true })
      expect(reply).toStartWith('granny_judge refused:')
      expect(reply).toContain('not a git repository')
    })

    it('ends with the report on disk, the exact bytes, read-only agents, and the path and counts in the finish message', async () => {
      const f = await tool()
      configure(MODELS)
      const head = git(repo, 'rev-parse', 'HEAD')
      const { id, dir } = await launch(f)
      const result = await finished(dir)
      expect(result).toMatchObject({ outcome: 'reviewed', branch: 'feat/x', base: 'main', written: true, counts: { P0: 1, P1: 0, P2: 0, P3: 0, dismissed: 0 } })
      expect(result.reportPath).toMatch(new RegExp(`^${repo}/\\.granny/reviews/\\d{8}-\\d{6}-feat-x\\.md$`))
      expect(readFileSync(result.reportPath)).toEqual(Buffer.from(result.report))
      await waitFor(() => toParent(f).length > 0)
      expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'done', branch: 'feat/x', parent: 'parent', outline: { kind: 'judge', branch: 'feat/x', worktree: false, reviewers: ['codex'], stages: [] } })
      expect(f.creates.map(c => c.title)).toEqual(['granny · tag feat/x'])
      expect(f.creates[0].permissions).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
      expect(f.creates[0].model).toEqual({ providerID: 'prov', id: 'tag' })
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(repo, 'status', '--short')).toBe('')
      expect(toParent(f)[0]).toStartWith(`[granny] Run ${id} finished.\n- report: ${result.reportPath}\n- counts: P0 1, P1 0, P2 0, P3 0, dismissed 0\n`)
      expect(toParent(f)[0]).toEndWith('Nothing was fixed or committed. Give the user the report path and the counts; do not fix anything unless they ask.')
    })

    it('names the reviewers and the judge model in the start reply, says nothing will change, and keeps the notify sentence and the overrides', async () => {
      const f = await tool({ hangUntilInterrupted: title => title === 'granny · tag feat/x' })
      configure(MODELS)
      const { id, dir, started } = await launch(f, { config: { language: 'Turkish' } })
      expect(started).toContain(`granny judge run ${id} started on ${repo} (feat/x)`)
      expect(started).toContain('main...HEAD by codex (command)')
      expect(started).toContain('tagged by prov/tag')
      expect(started).toContain('Nothing will be changed: no fix, commit, push, branch or worktree')
      expect(started).toContain('You will receive a message when it finishes.')
      expect(started).toContain('\noverrides: language Turkish')
      expect(started).not.toContain('threshold')
      await waitFor(() => f.creates.length > 0 && f.interrupted.length === 0)
      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => JSON.parse(readRun(dir, 'status.json')).status === 'cancelled')
    })

    it('starts on a dirty tree and lists what it did not review', async () => {
      const f = await tool()
      configure(MODELS)
      writeFileSync(join(repo, 'dirty.txt'), 'x')
      const { dir } = await launch(f)
      const result = await finished(dir)
      expect(result.uncommitted).toEqual(['dirty.txt'])
      expect(result.report).toContain('- Not reviewed: dirty.txt')
      await waitFor(() => toParent(f).length > 0)
      expect(toParent(f)[0]).toContain('- not reviewed, uncommitted: dirty.txt')
    })

    it('granny_cancel stops it, with no report', async () => {
      const f = await tool({ hangUntilInterrupted: title => title === 'granny · tag feat/x' })
      configure(MODELS)
      const { id, dir } = await launch(f)
      await waitFor(() => f.creates.some(c => c.title === 'granny · tag feat/x'))
      await Bun.sleep(30)
      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => JSON.parse(readRun(dir, 'status.json')).status === 'cancelled')
      expect(existsSync(join(repo, '.granny/reviews'))).toBe(false)
      expect(journalOf(dir).some(e => e.type === 'agent-end' && e.outcome === 'cancelled')).toBe(true)
      expect(toParent(f)).toEqual([])
    })

    it('reports no-changes with no agent and no report', async () => {
      process.env.GRANNY_CONFIG = join(repo, '.git', 'granny-config.json')
      writeFileSync(process.env.GRANNY_CONFIG, JSON.stringify(MODELS))
      git(repo, 'checkout', '-q', 'main')
      const f = await tool()
      const { dir } = await launch(f)
      expect(await finished(dir)).toMatchObject({ outcome: 'no-changes', written: false })
      expect(f.creates).toEqual([])
      await waitFor(() => toParent(f).length > 0)
      expect(toParent(f)[0]).toContain('- no report: main..HEAD has no commits')
    })

    it('tells the user how to watch it when watch is full', async () => {
      const f = await tool()
      configure({ ...MODELS, watch: 'full' })
      const { dir, started } = await launch(f)
      expect(started).toContain('/granny or <leader>j')
      await finished(dir)
    })
  })

  describe('with a plan', () => {
    const planReviewer = (always: boolean) => ({
      name: 'codex',
      engine: 'command',
      command: `test -n {prompt} && if [ -e .granny/plan-reviewed ] && ${!always}; then echo "No findings." > {out}; else touch .granny/plan-reviewed; printf '%s\\n' "- [${always ? 'P1' : 'P2'}] Plan misses a step — $PLAN_FILE:2" '  detail' > {out}; fi`,
    })
    const runWithPlan = async (f: ReturnType<typeof fakeContext>, config: Record<string, unknown>) => {
      const plan = join(repo, '.granny/plans/v1.md')
      mkdirSync(join(repo, '.granny/plans'), { recursive: true })
      writeFileSync(plan, '# plan\nstep 1\n')
      process.env.PLAN_FILE = plan
      writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
      git(repo, 'add', 'granny.config.json')
      git(repo, 'commit', '-qm', 'cfg')
      await plugin.setup(f.ctx)
      const started = await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', plan: [plan], stages: [{ name: 'one', task: 'Do it.' }] }, { sessionID: 'parent' })
      const id = /granny run (\S+) started/.exec(started.content)?.[1]
      expect(id).toBeDefined()
      return { id: id!, dir: join(repo, '.granny/runs', id!), plan, started: started.content as string }
    }

    it('reviews the plan, has a plan-fix session submit through granny_submit_plan_fix, then implements', async () => {
      const f = fakeContext()
      const { id, dir, plan, started } = await runWithPlan(f, { planReview: true, reviewers: [planReviewer(false)] })
      expect(started).toContain(`${planReviewWarning(4)} Tell the user this in your next message.`)
      const result = await finished(dir)
      delete process.env.PLAN_FILE
      expect(result.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
      expect(result.plan.history[0].findings[0]).toMatchObject({ id: 'codex-F1', file: plan, line: 2, priority: 95 })
      expect(f.created.map(s => s.title)).toEqual([
        'granny · judge plan review r1',
        'granny · fix plan review r1',
        'granny · implement one',
        'granny · pr-ready check',
      ])
      expect(f.created[1].permissions).not.toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
      expect(promptsTo(f, 'granny · fix plan review r1')[0]).toContain('call the `granny_submit_plan_fix` tool exactly once')
      expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'phase', title: 'Plan review' }))
      await waitFor(() => f.prompts.some(p => p.sessionID === 'parent'))
      const done = f.prompts.find(p => p.sessionID === 'parent')!.text
      expect(done).toContain(`[granny] Run ${id} finished.`)
      expect(done).toContain('- plan review: clean, 2 review round(s)\n- one: clean')
      expect(done).toContain('- final review: skipped, 0 review round(s) - one stage and no lane merge, so its stage review already covered the whole branch\n- final: gates green')
    })

    it('says nothing about a plan review in its start reply when planReview is off', async () => {
      const f = fakeContext()
      const { dir, started } = await runWithPlan(f, { reviewers: [planReviewer(false)] })
      expect(started).not.toContain('Plan review is on')
      expect(started).not.toContain('tokens')
      await finished(dir)
      delete process.env.PLAN_FILE
    })

    it('stops before stage 1 when the plan review hits the round cap, and says so', async () => {
      const f = fakeContext()
      const { id, dir } = await runWithPlan(f, { planReview: true, maxRounds: 1, reviewers: [planReviewer(true)] })
      const result = await finished(dir)
      delete process.env.PLAN_FILE
      expect(result.plan).toMatchObject({ outcome: 'round-cap', rounds: 1 })
      expect(result.stages).toEqual([])
      expect(result.final).toBeNull()
      expect(f.created.map(s => s.title)).toEqual(['granny · fix plan review r1'])
      await waitFor(() => f.prompts.some(p => p.sessionID === 'parent'))
      const done = f.prompts.find(p => p.sessionID === 'parent')!.text
      expect(done).toContain(`[granny] Run ${id} finished.`)
      expect(done).toContain('- plan review: round-cap, 1 review round(s) (1 unresolved) - stopped before stage 1, nothing was implemented')
    })
  })

  it('lets the model pass plan files to granny_run and refuses a relative one', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const run = f.tools.get('granny_run')
    expect(run.input.properties.plan).toMatchObject({ type: 'array', items: { type: 'string' } })
    const refused = await run.execute({ repo, branch: 'feat/x', plan: ['plans/v1.md'], stages: [{ task: 't' }] }, { sessionID: 'parent' })
    expect(refused.content).toContain('plan must be an absolute path')
    expect(f.created).toHaveLength(0)
  })

  it('refuses to start on a bad input or config without creating sessions', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const run = f.tools.get('granny_run')
    expect((await run.execute({ repo: repo, branch: 'feat/x', stages: [] }, { sessionID: 'parent' })).content).toContain('stages must be')
    const unknownCheck = await run.execute(
      { repo, branch: 'feat/x', stages: [{ task: 't', checks: ['lint'] }], config: { checks: [{ name: 'tests', run: 'bun test' }] } },
      { sessionID: 'parent' },
    )
    expect(unknownCheck.content).toContain('granny_run refused:\n- stages[0].checks names "lint", which is not in config checks (tests)')
    writeFileSync(join(repo, 'granny.config.json'), '{"treshold": 1}')
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    expect((await run.execute({ repo, branch: 'feat/x', stages: [{ task: 't' }] }, { sessionID: 'parent' })).content).toContain('unknown key "treshold"')
    expect(f.created).toHaveLength(0)
  })

  it('refuses a model opencode cannot run before any session starts, naming the entry, its config file and the host-keyed fix', async () => {
    const home = mkdtempSync(join(tmpdir(), 'granny-global-'))
    const global = join(home, 'config.json')
    process.env.GRANNY_CONFIG = global
    writeFileSync(global, JSON.stringify({ reviewers: [{ name: 'sonnet', engine: 'agent', model: 'sonnet' }], roles: { judge: { model: { opencode: 'haiku' } } } }))
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const run = (config?: unknown) => f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ task: 't' }], ...(config ? { config } : {}) }, { sessionID: 'parent' })
    const refused = (await run()).content
    expect(refused).toStartWith('granny_run refused:\n- ')
    expect(refused).toContain(`reviewers[0] "sonnet": model "sonnet" (from ${global})`)
    expect(refused).toContain('opencode models are "provider/model[#variant]"')
    expect(refused).toContain('{ "claude-code": "sonnet", "opencode": "<provider/model>" }')
    expect(refused).toContain(`roles.judge.model: "haiku" (from ${global})`)
    expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
    expect(f.created).toHaveLength(0)

    const fixed = { reviewers: [{ name: 'sonnet', engine: 'agent', model: { 'claude-code': 'sonnet', opencode: 'anthropic/claude-sonnet' } }], roles: { judge: { model: { opencode: 'opencode/judge' } } } }
    const started = (await run(fixed)).content
    expect(started).toContain('granny run ')
    const id = /granny run (\S+) started/.exec(started)![1]!
    await finished(join(repo, '.granny/runs', id))
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses adversarial-review on engine auto, which means the Codex CLI on opencode, without creating sessions', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const started = await f.tools
      .get('granny_run')
      .execute({ repo, branch: 'feat/x', stages: [{ task: 't' }], config: { reviewers: [{ mode: 'adversarial-review' }] } }, { sessionID: 'parent' })
    expect(started.content).toContain('on opencode engine "auto" means the Codex CLI')
    expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
    expect(f.created).toHaveLength(0)
  })

  it('runs the loop in the background with child sessions, a direct review command and a completion message', async () => {
    writeFileSync(
      join(repo, 'granny.config.json'),
      JSON.stringify({
        roles: { judge: { model: { opencode: 'opencode/judge-model' } } },
        reviewers: [
          {
            name: 'codex',
            engine: 'command',
            command: `test -n {base} && if [ -e .granny/reviewed ]; then echo "No findings." > {out}; else touch .granny/reviewed; printf '%s\\n' '- [P2] Real issue — a.txt:1' '  detail' > {out}; fi`,
          },
        ],
      }),
    )
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const f = fakeContext({ skipSubmitOnce: true })
    await plugin.setup(f.ctx)
    const started = await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }, { sessionID: 'parent' })
    const id = /granny run (\S+) started/.exec(started.content)?.[1]
    expect(id).toBeDefined()
    expect(started.content).not.toContain('overrides:')

    const dir = join(repo, '.granny/runs', id!)
    await waitFor(() => existsSync(join(dir, 'result.json'))).catch(e => {
      const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
      throw new Error(`${e.message}\nstatus: ${read('status.json')}\njournal:\n${read('journal.jsonl')}`)
    })
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean', rounds: 2 })
    expect(result.stages[0].history[0].findings[0]).toMatchObject({ id: 'codex-F1', reviewer: 'codex', severity: 'P2', file: 'a.txt', line: 1, priority: 95 })

    expect(f.created.map(s => s.title)).toEqual(['granny · implement one', 'granny · judge one r1', 'granny · fix one r1', 'granny · pr-ready check'])
    expect(f.created[0]).toMatchObject({ agent: 'build', model: { providerID: 'opencode', id: 'parent-model' }, location: { directory: repo } })
    expect(f.creates.map(c => [c.parentID, 'location' in c])).toEqual(f.creates.map(() => ['parent', false]))
    expect(f.moves).toEqual(f.created.map(s => ({ sessionID: s.id, directory: repo })))
    for (const s of f.created) expect(f.calls.indexOf(`move ${s.id}`)).toBeLessThan(f.calls.indexOf(`prompt ${s.id}`))
    const meta = (label: string, role: string, phase: string, model: string) => ({ 'granny-workflow': { run: id, dir, parent: 'parent', label, role, phase, model } })
    expect(f.created.map(s => s.metadata)).toEqual([
      meta('implement one', 'implementer', 'Implement', 'opencode/parent-model'),
      meta('judge one r1', 'judge', 'Review', 'opencode/judge-model'),
      meta('fix one r1', 'implementer', 'Implement', 'opencode/parent-model'),
      meta('pr-ready check', 'granny', 'PR ready', 'opencode/parent-model'),
    ])
    expect(f.removed).toEqual([])
    const journal = journalOf(dir)
    expect(journal.filter(e => e.type === 'link-failed')).toEqual([])
    const agents = journal.filter(e => e.type === 'agent')
    expect(agents.map(e => [e.label, e.phase, e.session, e.linked])).toEqual(f.created.map(s => [s.metadata['granny-workflow'].label, s.metadata['granny-workflow'].phase, s.id, true]))
    expect(journal.filter(e => e.type === 'agent-end')).toEqual(agents.map(e => ({ t: expect.any(String), type: 'agent-end', label: e.label, session: e.session, outcome: 'done' })))
    expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ id, status: 'done', parent: 'parent', watch: 'full' })
    expect(JSON.parse(readRun(dir, 'status.json')).outline).toEqual({
      kind: 'implement',
      branch: 'feat/x',
      worktree: true,
      planReview: false,
      finalReview: false,
      reviewers: ['codex'],
      fromStage: 1,
      stages: [{ number: 1, name: 'one', implement: true, review: true, checks: false }],
    })
    expect(agents.map(e => e.cwd)).toEqual(agents.map(() => repo))
    expect(journal.filter(e => e.type === 'stage').map(({ t: _t, type: _type, ...e }) => e)).toEqual([
      { number: 1, name: 'one', event: 'start' },
      { number: 1, name: 'one', event: 'end', outcome: 'clean' },
    ])
    expect(f.created[1].model).toEqual({ providerID: 'opencode', id: 'judge-model' })
    expect(f.created[1].permissions).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
    expect(f.prompts.some(p => p.text.startsWith('You stopped without calling granny_submit_implementation'))).toBe(true)

    await waitFor(() => f.prompts.some(p => p.sessionID === 'parent'))
    const done = f.prompts.find(p => p.sessionID === 'parent')!
    expect(done.text).toContain(`[granny] Run ${id} finished.`)
    expect(done.text).toContain('- one: clean, 2 review round(s)')

    const status = await f.tools.get('granny_status').execute({ repo }, {})
    expect(status.content).toContain('"status": "done"')
    expect(status.content).toContain('"outcome": "clean"')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('leaves the heartbeats out of granny_status, so a long command does not push out the real entries', async () => {
    const f = fakeContext({ hangUntilInterrupted: title => title === 'granny · implement one' })
    await plugin.setup(f.ctx)
    const run = await startRun(repo, f)
    await waitFor(() => f.prompts.length > 0)
    appendFileSync(join(run.dir, 'journal.jsonl'), Array.from({ length: 60 }, () => `${JSON.stringify({ t: 'now', type: 'heartbeat', command: 'bun test' })}\n`).join(''))
    const status = (await f.tools.get('granny_status').execute({ runId: run.id })).content
    expect(status).toContain('"type":"phase"')
    expect(status).not.toContain('"type":"heartbeat"')
    await f.tools.get('granny_cancel').execute({ runId: run.id })
    await waitFor(() => readRun(run.dir, 'status.json').includes('"status": "cancelled"'))
  })

  it('journals a heartbeat while a long command runs, and none after it ends', async () => {
    const f = fakeContext()
    await createGrannyPlugin({ heartbeatMs: 40 }).setup(f.ctx)
    const { dir } = await startRun(repo, f, { checks: [{ name: 'slow', run: 'sleep 0.3' }] })
    await finished(dir)
    const beats = journalOf(dir).filter(e => e.type === 'heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(3)
    for (const beat of beats) expect(beat.command).toContain('sleep 0.3')
    await Bun.sleep(150)
    expect(journalOf(dir).filter(e => e.type === 'heartbeat')).toHaveLength(beats.length)
  })

  it('lists in its start reply what the run config changed from the config files, for the agent to show the user', async () => {
    writeFileSync(join(repo, 'granny.config.json'), JSON.stringify({ reviewers: [{ name: 'codex', engine: 'command', command: REVIEW_ONCE }], roles: { implementer: { model: { opencode: 'openai/gpt-x' } } } }))
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const config = { roles: { implementer: { model: 'kimi-code/k3.1-pro' } }, threshold: 50 }
    const started = (await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }], config }, { sessionID: 'parent' })).content
    expect(started).toContain('\noverrides: roles.implementer.model kimi-code/k3.1-pro (config: openai/gpt-x), threshold 50 (config: 70) - show this line to the user in your next message')
    await finished(join(repo, '.granny/runs', /granny run (\S+) started/.exec(started)![1]!))
  })

  it('hints in its start reply when the reviewers share the implementer model, and starts the run either way', async () => {
    const agent = (model?: Record<string, string>) => ({ reviewers: [{ name: 'reviewer', engine: 'agent', ...(model ? { model } : {}) }] })
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const startWith = async (config: unknown) => {
      const started = (await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }], config }, { sessionID: 'parent' })).content as string
      const id = /granny run (\S+) started/.exec(started)![1]!
      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(join(repo, '.granny/runs', id), 'status.json').includes('"status": "cancelled"'))
      return started
    }
    expect(await startWith(agent())).toContain(SAME_MODEL_HINT)
    expect(await startWith(agent({ opencode: 'openai/gpt-x' }))).not.toContain(SAME_MODEL_HINT)
  })

  it('tells the agent to point the user at the run navigator with watch full only', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const sentence = 'Tell the user: /granny or <leader>j in the TUI opens the run navigator (stages, agents, live activity).'
    for (const watch of ['full', 'panel', 'off']) {
      writeFileSync(join(repo, 'granny.config.json'), JSON.stringify({ reviewers: [{ name: 'codex', engine: 'command', command: REVIEW_ONCE }], watch }))
      git(repo, 'add', 'granny.config.json')
      git(repo, 'commit', '-qm', `cfg ${watch}`)
      const started = (await f.tools.get('granny_run').execute({ repo, branch: `feat/${watch}`, stages: [{ name: 'one', task: 'Do it.' }] }, { sessionID: 'parent' })).content
      if (watch === 'full') expect(started).toContain(`\n${sentence}`)
      else expect(started).not.toContain('run navigator')
      await finished(join(repo, '.granny/runs', /granny run (\S+) started/.exec(started)![1]!))
    }
  })

  it('writes the run outline to status.json from the start, and a planning run as kind plan', async () => {
    const f = fakeContext({ hangUntilInterrupted: title => title === 'granny · implement one' || title === 'granny · plan' })
    await plugin.setup(f.ctx)
    const run = await startRun(repo, f)
    expect(JSON.parse(readRun(run.dir, 'status.json'))).toMatchObject({ status: 'running', outline: { kind: 'implement', branch: 'feat/x', stages: [{ number: 1, name: 'one' }] } })
    await waitFor(() => f.prompts.length > 0)
    await f.tools.get('granny_cancel').execute({ runId: run.id })
    await waitFor(() => readRun(run.dir, 'status.json').includes('"status": "cancelled"'))
    expect(JSON.parse(readRun(run.dir, 'status.json')).outline).toMatchObject({ kind: 'implement' })

    const started = await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', goal: 'Build it.' }, { sessionID: 'parent' })
    const id = /granny run (\S+) started/.exec(started.content)![1]!
    const dir = join(repo, '.granny/runs', id)
    expect(JSON.parse(readRun(dir, 'status.json')).outline).toMatchObject({ kind: 'plan', stages: [], finalReview: false })
    await waitFor(() => journalOf(dir).some(e => e.type === 'agent'))
    expect(journalOf(dir).find(e => e.type === 'agent')).toMatchObject({ label: 'plan', cwd: repo })
    await f.tools.get('granny_cancel').execute({ runId: id })
    await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'))
  })

  it('works in a worktree of its own when repo is on another branch, and keeps the run files in repo', async () => {
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'granny.config.json'), JSON.stringify({ reviewers: [{ name: 'codex', engine: 'command', command: REVIEW_ONCE }] }))
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const started = await f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }, { sessionID: 'parent' })
    const id = /granny run (\S+) started/.exec(started.content)?.[1]
    expect(id).toBeDefined()
    const dir = join(repo, '.granny/runs', id!)
    const result = await finished(dir)
    const wt = `${repo}-worktrees/feat-x`

    expect(result).toMatchObject({ repo, worktree: wt })
    expect(result.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(f.created.map(s => s.location.directory)).toEqual(f.created.map(() => wt))
    expect(journalOf(dir).filter(e => e.type === 'agent').map(e => e.cwd)).toEqual(f.created.map(() => wt))
    expect(f.created.map(s => s.parentID)).toEqual(f.created.map(() => 'parent'))
    expect(f.moves).toEqual(f.created.map(s => ({ sessionID: s.id, directory: wt })))
    expect(existsSync(join(wt, '.granny/reviewed'))).toBe(true)
    expect(existsSync(join(repo, '.granny/reviewed'))).toBe(false)
    expect(git(wt, 'branch', '--show-current')).toBe('feat/x')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'log', message: `worktree: ${wt}` }))

    await waitFor(() => f.prompts.some(p => p.sessionID === 'parent'))
    expect(f.prompts.find(p => p.sessionID === 'parent')!.text).toContain(`- worktree: ${wt} - review and push from there`)
    expect((await f.tools.get('granny_status').execute({ repo }, {})).content).toContain(`"id": "${id}"`)
  })

  it('refuses to start with the worktree off when repo is not on the branch, or with it on when the branch is checked out dirty in repo', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const run = (config: Record<string, unknown>) => f.tools.get('granny_run').execute({ repo, branch: 'feat/x', stages: [{ task: 't' }], config }, { sessionID: 'parent' })
    git(repo, 'checkout', '-q', 'main')
    expect((await run({ worktree: false })).content).toContain('repo is on branch "main", expected "feat/x"')
    git(repo, 'checkout', '-q', 'feat/x')
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    expect((await run({})).content).toMatch(/granny_run refused:[\s\S]*working tree is not clean[\s\S]*dirty\.txt/)
    expect(f.created).toHaveLength(0)
    expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
  })

  it('backs off on a transient provider error and asks the model to continue instead of calling the tool', async () => {
    const quota = { type: 'provider.quota', message: 'Quota exceeded', status: 429 }
    const slept: number[] = []
    const f = fakeContext({ providerError: (title, attempt) => (title === 'granny · judge one r1' && attempt === 1 ? quota : undefined) })
    await createGrannyPlugin({ sleep: async ms => void slept.push(ms) }).setup(f.ctx)
    const { dir } = await startRun(repo, f)
    const result = await finished(dir)

    expect(slept).toEqual([30_000])
    const judge = promptsTo(f, 'granny · judge one r1')
    expect(judge).toHaveLength(2)
    expect(judge[1]).toContain('provider.quota')
    expect(judge[1]).toContain('granny_submit_judgement')
    expect(f.prompts.some(p => p.text.startsWith('You stopped without calling'))).toBe(false)
    expect(journalOf(dir)).toContainEqual(
      expect.objectContaining({ type: 'provider-error', label: 'judge one r1', error: quota, transient: true, backoffMs: 30_000 }),
    )
    expect(result.stages[0].history[0].findings[0].priority).toBe(95)
  })

  it('gives up on the role after the backoff budget, and the engine reports the unjudged findings after its one retry', async () => {
    const slept: number[] = []
    const f = fakeContext({
      providerError: title => (title.startsWith('granny · judge one r1') ? { type: 'provider.rate-limit', message: 'Too many requests', status: 429 } : undefined),
    })
    await createGrannyPlugin({ delays: [5, 10], sleep: async ms => void slept.push(ms) }).setup(f.ctx)
    const { dir } = await startRun(repo, f)
    const result = await finished(dir)

    expect(slept).toEqual([5, 10, 5, 10])
    expect(promptsTo(f, 'granny · judge one r1')).toHaveLength(3)
    expect(promptsTo(f, 'granny · judge one r1 retry')).toHaveLength(3)
    const journal = journalOf(dir)
    for (const label of ['judge one r1', 'judge one r1 retry']) {
      expect(journal).toContainEqual(expect.objectContaining({ type: 'agent-failed', label, error: expect.objectContaining({ type: 'provider.rate-limit' }) }))
    }
    expect(journal).toContainEqual(expect.objectContaining({ type: 'log', message: 'one r1: judge returned nothing - retrying once' }))
    expect(journal).toContainEqual(
      expect.objectContaining({ type: 'log', message: 'one r1: judge returned nothing, also on a retry - all 1 finding(s) go to the implementer unjudged (rule 2)' }),
    )
    expect(result.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(result.stages[0].history[0].findings[0].priority).toBeUndefined()
    for (const label of ['judge one r1', 'judge one r1 retry']) {
      const session = journal.find(e => e.type === 'agent' && e.label === label).session
      expect(journal.filter(e => e.type === 'agent-end' && e.label === label)).toEqual([expect.objectContaining({ session, outcome: 'failed' })])
    }
  })

  it('does not retry a provider error that waiting cannot fix', async () => {
    const slept: number[] = []
    const f = fakeContext({
      providerError: title => (title === 'granny · judge one r1' ? { type: 'provider.auth', message: 'Invalid API key', status: 401 } : undefined),
    })
    await createGrannyPlugin({ sleep: async ms => void slept.push(ms) }).setup(f.ctx)
    const { dir } = await startRun(repo, f)
    await finished(dir)

    expect(slept).toEqual([])
    expect(promptsTo(f, 'granny · judge one r1')).toHaveLength(1)
    const journal = journalOf(dir)
    expect(journal).toContainEqual(expect.objectContaining({ type: 'provider-error', label: 'judge one r1', transient: false }))
    expect(journal).toContainEqual(expect.objectContaining({ type: 'agent-failed', label: 'judge one r1' }))
  })

  it('falls back to re-prompting for the tool when the session context cannot be read', async () => {
    const f = fakeContext({ skipSubmitOnce: true, contextThrows: true })
    await plugin.setup(f.ctx)
    const { dir } = await startRun(repo, f)
    const result = await finished(dir)

    expect(result.stages[0].outcome).toBe('clean')
    expect(f.prompts.some(p => p.text.startsWith('You stopped without calling granny_submit_implementation'))).toBe(true)
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'context-failed', label: 'implement one' }))
  })

  it('cancels a run while it waits out a provider error', async () => {
    let sleeping = false
    const f = fakeContext({
      providerError: title => (title === 'granny · implement one' ? { type: 'provider.timeout', message: 'timed out' } : undefined),
    })
    const sleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>(resolve => {
        sleeping = true
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    await createGrannyPlugin({ sleep }).setup(f.ctx)
    const { id, dir } = await startRun(repo, f)
    await waitFor(() => sleeping)
    await f.tools.get('granny_cancel').execute({ runId: id })
    await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'))
    expect(JSON.parse(readRun(dir, 'status.json')).error).toBe('cancelled')
    expect(promptsTo(f, 'granny · implement one')).toHaveLength(1)
    expect(f.created).toHaveLength(1)
  })

  describe('linking role sessions to the parent session', () => {
    const fallsBack = async (behaviour: Behaviour) => {
      const f = fakeContext(behaviour)
      await plugin.setup(f.ctx)
      const { id, dir } = await startRun(repo, f)
      const result = await finished(dir)
      expect(readRun(dir, 'status.json')).toContain('"status": "done"')
      expect(result.stages[0]).toMatchObject({ outcome: 'clean' })
      const [first, ...rest] = f.created
      expect(first).toMatchObject({ title: 'granny · implement one', parentID: 'parent' })
      expect(f.removed).toEqual([first.id])
      expect(rest.length).toBeGreaterThan(0)
      for (const s of rest) {
        expect(s.parentID).toBeUndefined()
        expect(s.location).toEqual({ directory: repo })
        expect(s.metadata['granny-workflow']).toMatchObject({ run: id, dir, parent: 'parent', label: s.title.slice('granny · '.length) })
      }
      expect(f.moves.map(m => m.sessionID)).toEqual([first.id])
      expect(f.prompts.some(p => p.sessionID === first.id)).toBe(false)
      const journal = journalOf(dir)
      expect(journal.filter(e => e.type === 'link-failed')).toEqual([expect.objectContaining({ label: 'implement one', error: expect.any(String) })])
      expect(journal.filter(e => e.type === 'agent').map(e => e.linked)).toEqual(rest.map(() => false))
      return journal
    }

    it('falls back to top-level sessions in the work directory for the rest of the run when the move fails', async () => {
      const journal = await fallsBack({ moveFails: title => title === 'granny · implement one' })
      expect(journal.find(e => e.type === 'link-failed').error).toContain('session.move: directory not found')
    })

    it('still falls back when the half-made session cannot be removed', async () => {
      await fallsBack({ moveFails: title => title === 'granny · implement one', removeFails: true })
    })

    it('falls back when the moved session is not in the work directory', async () => {
      const journal = await fallsBack({ moveIgnored: title => title === 'granny · implement one' })
      expect(journal.find(e => e.type === 'link-failed').error).toContain('/parent-dir')
    })

    it('links the role sessions and records watch "off" in status.json when watching is off', async () => {
      const f = fakeContext()
      await plugin.setup(f.ctx)
      const { dir } = await startRun(repo, f, { watch: 'off' })
      expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'running', parent: 'parent', watch: 'off' })
      await finished(dir)
      expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'done', parent: 'parent', watch: 'off' })
      expect(f.created.map(s => s.parentID)).toEqual(f.created.map(() => 'parent'))
    })

    it('does not move a role session that already starts in the work directory', async () => {
      const f = fakeContext({ parentDir: `${repo}/` })
      await plugin.setup(f.ctx)
      const { dir } = await startRun(repo, f)
      await finished(dir)
      expect(f.moves).toEqual([])
      expect(f.created.map(s => s.parentID)).toEqual(f.created.map(() => 'parent'))
      expect(journalOf(dir).filter(e => e.type === 'agent').map(e => e.linked)).toEqual(f.created.map(() => true))
    })

    it('ends the run cancelled when it is cancelled while a role session is being moved', async () => {
      const f = fakeContext({ hangMove: title => title === 'granny · implement one' })
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { id, dir } = await startRun(repo, f)
      await waitFor(() => f.moves.length === 1)
      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      expect(f.interrupted).toEqual([f.created[0].id])
      expect(f.prompts).toEqual([])
      expect(f.created).toHaveLength(1)
      expect(journalOf(dir).filter(e => e.type === 'link-failed' || e.type === 'agent')).toEqual([])
    })
  })

  describe('when opencode reloads the plugin while a run is in progress', () => {
    const freshModule = (tag: string) => import(`../src/adapters/opencode/plugin.ts?${tag}`)
    const startWith = async (runTool: any, reviewer: Record<string, unknown>, stage: Record<string, unknown> = { name: 'one', task: 'Do it.' }) => {
      writeFileSync(join(repo, 'granny.config.json'), JSON.stringify({ reviewers: [{ name: 'codex', engine: 'command', ...reviewer }] }))
      git(repo, 'add', 'granny.config.json')
      git(repo, 'commit', '-qm', 'cfg')
      const started = await runTool.execute({ repo, branch: 'feat/x', stages: [stage] }, { sessionID: 'parent' })
      const id = /granny run (\S+) started/.exec(started.content)![1]!
      return { id, dir: join(repo, '.granny/runs', id) }
    }

    it('still receives the results the role sessions submit through the reloaded tools', async () => {
      const f = fakeContext()
      await (await freshModule('before-reload-1')).default.setup(f.ctx)
      const runTool = f.tools.get('granny_run')
      await (await freshModule('after-reload-1')).default.setup(f.ctx)
      const { dir } = await startWith(runTool, { command: REVIEW_ONCE })
      const result = await finished(dir)
      expect(result.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2, implementation: { headSha: 'bbb' } })
      expect(result.final).toMatchObject({ gatesGreen: true })
      expect(journalOf(dir).filter(e => e.type === 'retry' || e.type === 'agent-failed')).toEqual([])
    })

    it('lets the reloaded plugin report and cancel a run the previous one started', async () => {
      const f = fakeContext()
      const before = await freshModule('before-reload-2')
      await before.createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const runTool = f.tools.get('granny_run')
      const cancelBefore = f.tools.get('granny_cancel')
      const after = await freshModule('after-reload-2')
      await after.createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { id, dir } = await startWith(runTool, { command: 'test -n {base} && sleep 30' }, { name: 'one', implement: false })
      try {
        await waitFor(() => journalOf(dir).some(e => e.type === 'command' && e.command.includes('sleep 30')))
        expect((await f.tools.get('granny_status').execute({ runId: id })).content).toContain(`"id": "${id}"`)
        expect((await f.tools.get('granny_cancel').execute({ runId: id })).content).toContain(`Cancelling ${id}`)
        await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      } finally {
        await cancelBefore.execute({ runId: id })
        await waitFor(() => !readRun(dir, 'status.json').includes('"status": "running"'), 2000).catch(() => {})
      }
    })
  })

  describe('cancelling a running review command', () => {
    let pids: string
    const leftovers: number[] = []
    beforeEach(() => {
      pids = mkdtempSync(join(tmpdir(), 'granny-pids-'))
    })
    afterEach(() => {
      for (const pid of leftovers.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      rmSync(pids, { recursive: true, force: true })
    })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    }

    const fixtures: Array<[string, (pidFile: string) => string]> = [
      ['a grandchild', pidFile => `test -n {base} && bash -c 'sleep 300 & echo $! > ${pidFile}; wait'`],
      ['a grandchild that ignores SIGTERM', pidFile => `test -n {base} && bash -c 'trap "" TERM; sleep 300 & echo $! > ${pidFile}; wait'`],
      [
        'a grandchild that ignores SIGTERM and holds the output pipe',
        pidFile => `test -n {base}; bash -c 'trap "" TERM; sleep 300 & echo $! > ${pidFile}; wait' & wait`,
      ],
    ]
    for (const [label, command] of fixtures) {
      it(`stops ${label} and ends the run promptly`, async () => {
        const pidFile = join(pids, 'grandchild.pid')
        const f = fakeContext()
        await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
        const { id, dir } = await startRun(repo, f, { reviewers: [{ name: 'codex', engine: 'command', command: command(pidFile) }] })
        await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
        const pid = Number(readFileSync(pidFile, 'utf8'))
        leftovers.push(pid)
        expect(alive(pid)).toBe(true)

        await f.tools.get('granny_cancel').execute({ runId: id })
        await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
        await waitFor(() => !alive(pid), 2000)
        const logs = journalOf(dir).filter(e => e.type === 'log').map(e => e.message)
        expect(logs.filter(m => /exited 130|retrying once|review failed/.test(m))).toEqual([])
      })
    }

    it('stops the review commands of every reviewer running at once and leaves no process behind', async () => {
      const pidFiles = ['a', 'b'].map(name => join(pids, `${name}.pid`))
      const command = (pidFile: string) => `test -n {base} && bash -c 'trap "" TERM; sleep 300 & echo $! > ${pidFile}; wait'`
      const f = fakeContext()
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const reviewers = pidFiles.map((pidFile, i) => ({ name: ['a', 'b'][i], engine: 'command', command: command(pidFile) }))
      const { id, dir } = await startRun(repo, f, { reviewers })
      await waitFor(() => pidFiles.every(p => existsSync(p) && readFileSync(p, 'utf8').trim() !== ''))
      const sleepers = pidFiles.map(p => Number(readFileSync(p, 'utf8')))
      leftovers.push(...sleepers)
      expect(sleepers.every(alive)).toBe(true)

      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      await waitFor(() => !sleepers.some(alive), 2000)
      const logs = journalOf(dir).filter(e => e.type === 'log').map(e => e.message)
      expect(logs.filter(m => /exited 130|retrying once|review failed/.test(m))).toEqual([])
      expect(journalOf(dir).filter(e => e.type === 'command' && e.command.includes('sleep 300'))).toHaveLength(2)
    })

    it('interrupts every child session that is running, not only the last one started', async () => {
      const reviewing = (title: string) => title.startsWith('granny · review one r1 ')
      const f = fakeContext({ hangUntilInterrupted: reviewing })
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { id, dir } = await startRun(repo, f, { reviewers: ['a', 'b', 'c'].map(name => ({ name, engine: 'agent' })) })
      await waitFor(() => f.created.filter(s => reviewing(s.title)).length === 3)

      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      expect([...f.interrupted].sort()).toEqual(f.created.filter(s => reviewing(s.title)).map(s => s.id).sort())
      expect(f.created.filter(s => reviewing(s.title)).map(s => s.title).sort()).toEqual([
        'granny · review one r1 a',
        'granny · review one r1 b',
        'granny · review one r1 c',
      ])
    })

    it('ends a run cancelled during an agent review as cancelled: no retry, no review-failed, no notice', async () => {
      const reviewing = (title: string) => title === 'granny · review one r1 a'
      const f = fakeContext({ hangUntilInterrupted: reviewing })
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { id, dir } = await startRun(repo, f, { reviewers: [{ name: 'a', engine: 'agent' }] })
      await waitFor(() => f.created.some(s => reviewing(s.title)))

      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      expect(f.prompts.filter(p => p.sessionID === 'parent')).toEqual([])
      expect(f.created.map(s => s.title)).toEqual(['granny · implement one', 'granny · review one r1 a'])
      const logs = journalOf(dir).filter(e => e.type === 'log').map(e => e.message)
      expect(logs.filter(m => /retrying once|review failed/.test(m))).toEqual([])
      expect(existsSync(join(dir, 'result.json'))).toBe(false)
      const reviewer = f.created.find(s => reviewing(s.title)).id
      expect(journalOf(dir).filter(e => e.type === 'agent-end' && e.label === 'review one r1 a')).toEqual([expect.objectContaining({ session: reviewer, outcome: 'cancelled' })])
    })

    it('lists the active roles in granny_status while the run is running, and none after it', async () => {
      const reviewing = (title: string) => title === 'granny · review one r1 a'
      const f = fakeContext({ hangUntilInterrupted: reviewing })
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { id, dir } = await startRun(repo, f, { reviewers: [{ name: 'a', engine: 'agent', model: { opencode: 'zai/glm-5.3#high' } }] })
      await waitFor(() => f.prompts.some(p => p.sessionID === f.created.find(s => reviewing(s.title))?.id))
      const session = f.created.find(s => reviewing(s.title)).id
      const status = (await f.tools.get('granny_status').execute({ runId: id })).content
      expect(status).toMatch(new RegExp(`\\n\\nactive roles:\\n- review one r1 a \\(reviewer, zai/glm-5\\.3#high\\) session ${session} · \\d+s$`))
      expect(status).not.toContain('implement one (')

      await f.tools.get('granny_cancel').execute({ runId: id })
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
      expect((await f.tools.get('granny_status').execute({ runId: id })).content).not.toContain('active roles:')
    })

    it('journals a role whose prompt throws as failed with the error', async () => {
      const f = fakeContext({ promptFails: title => title.startsWith('granny · review one r1 bad') })
      await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
      const { dir } = await startRun(repo, f, { reviewers: [{ name: 'bad', engine: 'agent' }, { name: 'good', engine: 'agent' }] })
      await finished(dir)
      const ends = journalOf(dir).filter(e => e.type === 'agent-end' && e.label.startsWith('review one r1 bad'))
      expect(ends.length).toBeGreaterThan(0)
      for (const e of ends) expect(e).toMatchObject({ outcome: 'failed', error: 'session.prompt: 500 Internal Server Error' })
    })

    describe("when one reviewer's session cannot be created", () => {
      const broken = (title: string) => title.startsWith('granny · review one r1 bad')
      const reviewers = [{ name: 'bad', engine: 'agent' }, { name: 'good', engine: 'agent' }]
      const retried = (dir: string) =>
        journalOf(dir).some(e => e.type === 'error' || (e.type === 'log' && e.message.startsWith('one r1 bad: did not run - retrying once.')))

      it('keeps the run cancellable while the other reviewers still run', async () => {
        const good = (title: string) => title.startsWith('granny · review one r1 good')
        const f = fakeContext({ createFails: broken, hangUntilInterrupted: good })
        await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
        const { id, dir } = await startRun(repo, f, { reviewers })
        await waitFor(() => f.created.some(s => good(s.title)) && retried(dir))
        expect(readRun(dir, 'status.json')).toContain('"status": "running"')

        expect((await f.tools.get('granny_cancel').execute({ runId: id })).content).toContain(`Cancelling ${id}`)
        await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 2000)
        expect(f.interrupted).toEqual(f.created.filter(s => good(s.title)).map(s => s.id))
        expect(journalOf(dir)).toContainEqual(
          expect.objectContaining({ type: 'log', message: 'one r1 bad: did not run - retrying once. reviewer call failed: session.create: 503 Service Unavailable' }),
        )
      })

      it('ends the stage review-failed and the run done, naming the reviewer and the error', async () => {
        const f = fakeContext({ createFails: broken })
        await createGrannyPlugin({ killGraceMs: 100 }).setup(f.ctx)
        const { dir } = await startRun(repo, f, { reviewers })
        const result = await finished(dir)
        expect(readRun(dir, 'status.json')).toContain('"status": "done"')
        expect(result.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
        expect(result.stages[0].note).toContain('reviewer(s) that did not run, also on a retry: bad')
        expect(result.stages[0].note).toContain('bad: reviewer call failed: session.create: 503 Service Unavailable')
        expect(f.created.map(s => s.title)).toContain('granny · review one r1 good')
      })
    })

    describe('with the Codex plugin', () => {
      const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA }
      afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      })

      it('also stops the app-server broker the companion started outside the process group', async () => {
        const scripts = join(pids, 'claude config/plugins/cache/openai-codex/codex/1.0.6/scripts')
        const record = join(pids, 'calls.jsonl')
        mkdirSync(scripts, { recursive: true })
        writeFileSync(join(scripts, 'codex-companion.mjs'), brokerCompanion(record, { hang: true }))
        writeFileSync(join(scripts, 'session-lifecycle-hook.mjs'), sessionEndHook(record))
        process.env.CLAUDE_CONFIG_DIR = join(pids, 'claude config')
        process.env.CLAUDE_PLUGIN_DATA = join(pids, 'user plugin data')
        const f = fakeContext()
        await createGrannyPlugin({ killGraceMs: 3000 }).setup(f.ctx)
        const { id, dir } = await startRun(repo, f, { reviewers: [{ name: 'codex', engine: 'codex-plugin' }] })
        await waitFor(() => records(record).length > 0)
        const broker = records(record)[0].broker
        leftovers.push(broker)
        expect(alive(broker)).toBe(true)

        await f.tools.get('granny_cancel').execute({ runId: id })
        await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 4000)
        await waitFor(() => !alive(broker), 2000)
        expect(records(record).map(r => r.event)).toEqual(['companion', 'hook'])
        expect(existsSync(join(pids, 'user plugin data'))).toBe(false)
      })
    })
  })
})
