import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { createGrannyPlugin, isTransient, modelRef, pause, permissions, preflight, providerError } from '../src/adapters/opencode/plugin'
import { brokerCompanion, records, sessionEndHook } from './fake-companion'

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
  granny_submit_score: { score: 90, perFinding: [{ id: 'codex-F1', score: 95, reason: 'real' }], rationale: 'ok' },
  granny_submit_final: { gatesGreen: true, gates: 'ok', commits: ['c1'], prBodyPath: '.granny/PR-BODY.md', issues: '' },
  granny_submit_findings: { findings: [] },
}

type FakeError = { type: string; message: string; status?: number }

interface Behaviour {
  skipSubmitOnce?: boolean
  contextThrows?: boolean
  providerError?: (title: string, attempt: number) => FakeError | undefined
}

function fakeContext(behaviour: Behaviour = {}) {
  const tools = new Map<string, any>()
  const created: any[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const pending = new Map<string, string>()
  const messages = new Map<string, any[]>()
  const attempts = new Map<string, number>()
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
      get: async () => ({ id: 'parent', model: { providerID: 'opencode', id: 'parent-model' } }),
      create: async (input: any) => {
        const s = { id: `ses_${++n}`, ...input }
        created.push(s)
        messages.set(s.id, [])
        return s
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
        pending.set(input.sessionID, input.text)
        messages.get(input.sessionID)?.push({ type: 'user', text: input.text })
        return {}
      },
      wait: async ({ sessionID }: { sessionID: string }) => {
        const log = messages.get(sessionID) ?? []
        const attempt = (attempts.get(sessionID) ?? 0) + 1
        attempts.set(sessionID, attempt)
        const title = created.find(s => s.id === sessionID)?.title ?? ''
        const error = behaviour.providerError?.(title, attempt)
        if (error) {
          log.push({ type: 'assistant', finish: 'error', error, content: [] }, { type: 'idle', outcome: 'failed' })
          return
        }
        log.push({ type: 'assistant', finish: 'stop', content: [] }, { type: 'idle', outcome: 'succeeded' })
        const text = pending.get(sessionID) ?? ''
        const name = /(granny_submit_\w+)/.exec(text)?.[1]
        if (!name) return
        if (behaviour.skipSubmitOnce && !skipped) {
          skipped = true
          return
        }
        await tools.get(name).execute(CANNED[name], { sessionID })
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        if (behaviour.contextThrows) throw new Error('context unavailable')
        return [...(messages.get(sessionID) ?? [])]
      },
      interrupt: async () => ({ interrupted: true }),
    },
  }
  return { ctx, tools, created, prompts }
}

const REVIEW_ONCE = `test -n {base} && if [ -e .granny/reviewed ]; then echo "No issues." > {out}; else touch .granny/reviewed; printf '%s\\n' '- [P2] Real issue — a.txt:1' '  detail' > {out}; fi`

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
    delete process.env.GRANNY_CONFIG
  })

  it('preflight refuses the wrong branch and a dirty tree, then git-excludes the work dir', () => {
    git(repo, 'checkout', '-q', 'main')
    expect(preflight(repo, 'feat/x', '.granny')[0]).toContain('expected "feat/x"')
    git(repo, 'checkout', '-q', 'feat/x')
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    expect(preflight(repo, 'feat/x', '.granny')[0]).toContain('dirty.txt')
    rmSync(join(repo, 'dirty.txt'))
    expect(preflight(repo, 'feat/x', '.granny')).toEqual([])
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.granny/\n')
    expect(preflight(repo, 'feat/x', '.granny')).toEqual([])
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('/.granny/').length).toBe(2)
  })

  it('registers the run, status, cancel and submit tools', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    expect([...f.tools.keys()].sort()).toEqual([
      'granny_cancel',
      'granny_run',
      'granny_status',
      'granny_submit_final',
      'granny_submit_findings',
      'granny_submit_implementation',
      'granny_submit_score',
    ])
  })

  it('refuses to start on a bad input or config without creating sessions', async () => {
    const f = fakeContext()
    await plugin.setup(f.ctx)
    const run = f.tools.get('granny_run')
    expect((await run.execute({ repo: repo, branch: 'feat/x', stages: [] }, { sessionID: 'parent' })).content).toContain('stages must be')
    writeFileSync(join(repo, 'granny.config.json'), '{"treshold": 1}')
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    expect((await run.execute({ repo, branch: 'feat/x', stages: [{ task: 't' }] }, { sessionID: 'parent' })).content).toContain('unknown key "treshold"')
    expect(f.created).toHaveLength(0)
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
            command: `test -n {base} && if [ -e .granny/reviewed ]; then echo "No issues." > {out}; else touch .granny/reviewed; printf '%s\\n' '- [P2] Real issue — a.txt:1' '  detail' > {out}; fi`,
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

    const dir = join(repo, '.granny/runs', id!)
    await waitFor(() => existsSync(join(dir, 'result.json'))).catch(e => {
      const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
      throw new Error(`${e.message}\nstatus: ${read('status.json')}\njournal:\n${read('journal.jsonl')}`)
    })
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean', rounds: 2 })
    expect(result.stages[0].history[0].findings[0]).toMatchObject({ id: 'codex-F1', reviewer: 'codex', severity: 'P2', file: 'a.txt', line: 1, score: 95 })

    expect(f.created.map(s => s.title)).toEqual(['granny · implement one', 'granny · judge one r1', 'granny · fix one r1', 'granny · pr-ready check'])
    expect(f.created[0]).toMatchObject({ agent: 'build', model: { providerID: 'opencode', id: 'parent-model' }, location: { directory: repo } })
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
    expect(judge[1]).toContain('granny_submit_score')
    expect(f.prompts.some(p => p.text.startsWith('You stopped without calling'))).toBe(false)
    expect(journalOf(dir)).toContainEqual(
      expect.objectContaining({ type: 'provider-error', label: 'judge one r1', error: quota, transient: true, backoffMs: 30_000 }),
    )
    expect(result.stages[0].history[0].findings[0].score).toBe(95)
  })

  it('gives up on the role after the backoff budget, and the engine reports the unscored findings', async () => {
    const slept: number[] = []
    const f = fakeContext({
      providerError: title => (title === 'granny · judge one r1' ? { type: 'provider.rate-limit', message: 'Too many requests', status: 429 } : undefined),
    })
    await createGrannyPlugin({ delays: [5, 10], sleep: async ms => void slept.push(ms) }).setup(f.ctx)
    const { dir } = await startRun(repo, f)
    const result = await finished(dir)

    expect(slept).toEqual([5, 10])
    expect(promptsTo(f, 'granny · judge one r1')).toHaveLength(3)
    const journal = journalOf(dir)
    expect(journal).toContainEqual(
      expect.objectContaining({ type: 'agent-failed', label: 'judge one r1', error: expect.objectContaining({ type: 'provider.rate-limit' }) }),
    )
    expect(journal).toContainEqual(
      expect.objectContaining({ type: 'log', message: 'one r1: judge returned nothing - all 1 finding(s) go to the implementer unscored' }),
    )
    expect(result.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(result.stages[0].history[0].findings[0].score).toBeUndefined()
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
    expect(promptsTo(f, 'granny · implement one')).toHaveLength(1)
    expect(f.created).toHaveLength(1)
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
        await waitFor(() => journalOf(dir).some(e => e.type === 'command'))
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
        expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'log', message: expect.stringContaining('review command exited 130') }))
      })
    }

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
