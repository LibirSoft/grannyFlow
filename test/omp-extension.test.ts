import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extension, { blockReason, createGrannyExtension, isTransient } from '../src/adapters/omp/extension'
import { SCHEMAS } from '../src/core/schemas'
import type { FakeOmpBehaviour } from './fake-omp'

const SOURCE = join(import.meta.dir, '../src/adapters/omp/extension.ts')

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'granny-omp-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'checkout', '-qb', 'feat/x')
  return repo
}

function fakePi() {
  const tools = new Map<string, any>()
  const handlers: Array<[string, any]> = []
  const sent: Array<{ message: any; options: any }> = []
  const pi = {
    registerTool: (t: any) => tools.set(t.name, t),
    on: (event: string, handler: any) => handlers.push([event, handler]),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  }
  return { pi, tools, handlers, sent }
}

const CTX = { cwd: '/', model: { provider: 'omp-test', id: 'parent-model' } }
const exec = (tool: any, params: unknown, ctx: unknown = CTX) => tool.execute('call-1', params, undefined, undefined, ctx)
const textOf = (r: any) => r.content.map((c: any) => c.text).join('')

const readRun = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '')
const journalOf = (dir: string) => readRun(dir, 'journal.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

async function waitFor(check: () => boolean, ms = 8000) {
  const until = performance.now() + ms
  while (!check()) {
    if (performance.now() > until) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

async function finished(dir: string) {
  await waitFor(() => existsSync(join(dir, 'result.json'))).catch(e => {
    throw new Error(`${e.message}\nstatus: ${readRun(dir, 'status.json')}\njournal:\n${readRun(dir, 'journal.jsonl')}`)
  })
  return JSON.parse(readRun(dir, 'result.json'))
}

describe('blockReason', () => {
  const SUBMIT = 'granny_submit_findings'
  const bash = (command: string, access: 'write' | 'read-only' = 'write') => blockReason('bash', { command }, access, SUBMIT)

  it('blocks ask for every role', () => {
    expect(blockReason('ask', { question: 'ok?' }, 'write', SUBMIT)).toContain('no one answers')
    expect(blockReason('ask', {}, 'read-only', SUBMIT)).toContain('no one answers')
  })

  const denied = [
    'git push',
    'git push origin feat/x',
    'cd /r && git push',
    'cd "/my dir" && git push -u origin HEAD',
    'echo a; git push',
    'git status | git push',
    'make || git push',
    '(git push)',
    '{ git push; }',
    'echo $(git push)',
    'echo `git push`',
    'git -C /r push',
    'git -c user.name=x push',
    'git --no-pager push',
    'FOO=1 git push',
    'sudo git push',
    'env GIT_TRACE=1 git push',
    'timeout 30 git push',
    'bash -c "git push"',
    "sh -c 'cd x && git push'",
    'eval git push',
    '/usr/bin/git push',
    'git remote add origin https://x',
    'git -C /r remote add up u',
    'git stash',
    'git stash pop',
    'git rebase main',
    'git rebase -i HEAD~2',
    'git reset --hard HEAD~1',
    'git reset HEAD~1 --hard',
    'gh pr create --fill',
    'cd /r && gh pr merge 1',
    'if true; then git push; fi',
    'ls\ngit push',
    'bash -lc "git push"',
    "sh -ec 'git push'",
    'bash -l -c "git push"',
    'bash -o pipefail -c "git push"',
    'bash --norc -c "git push"',
    'zsh -xc "cd /r && git push"',
    'env -i git push',
    'env - git push',
    'env -u HOME git push',
    'env -i FOO=1 git push',
    'env -C /r git push',
    'env --chdir=/r git push',
    'env -S "git push"',
    'sudo -u me git push',
    'nice -n 5 git push',
    'timeout -s KILL 30 git push',
    'xargs -I{} git push',
    'command -p git push',
    'echo "$(git push)"',
    'echo "x $(cd /r && git push) y"',
    'echo "`git push`"',
    'echo "$(echo "$(git push)")"',
  ]
  for (const command of denied) {
    it(`blocks ${JSON.stringify(command)} for every role`, () => {
      expect(bash(command)).toBeString()
      expect(bash(command, 'read-only')).toBeString()
    })
  }

  const allowed = [
    'git status',
    'git diff main...HEAD',
    'git log --grep push',
    'git reset --soft HEAD~1',
    'git remote -v',
    'git remote get-url origin',
    'echo "git push"',
    'grep -rn "git push" src',
    'gh issue list',
    'git show HEAD:a.txt',
    'git rev-parse HEAD@{1}',
    'bash script.sh',
    'bash -l script.sh -c "git push"',
    'echo "\\$(git push)"',
    "echo '$(git push)'",
    'env -i git status',
    'toString git push',
    'constructor',
  ]
  for (const command of allowed) {
    it(`allows ${JSON.stringify(command)} for every role`, () => {
      expect(bash(command)).toBeUndefined()
      expect(bash(command, 'read-only')).toBeUndefined()
    })
  }

  it('lets a writing role add, commit, edit and use every tool but ask', () => {
    for (const command of ['git add a.txt', 'git commit -m "do not git push yet"', 'cd /r && git add -A && git commit -qm x']) {
      expect(bash(command)).toBeUndefined()
    }
    for (const tool of ['edit', 'write', 'ast_edit', 'eval', 'task', 'read', 'some_extension_tool']) {
      expect(blockReason(tool, {}, 'write', SUBMIT)).toBeUndefined()
    }
  })

  it('keeps a read-only role to the reading tools, bash without add or commit, and its own submit tool', () => {
    for (const tool of ['read', 'grep', 'glob', 'find', 'ast_grep', 'lsp', 'web_search', 'todo', 'think', 'wait', 'yield', SUBMIT]) {
      expect(blockReason(tool, {}, 'read-only', SUBMIT)).toBeUndefined()
    }
    for (const tool of ['edit', 'write', 'ast_edit', 'eval', 'task', 'checkpoint', 'granny_submit_implementation', 'some_extension_tool']) {
      expect(blockReason(tool, {}, 'read-only', SUBMIT)).toContain('read-only')
    }
    for (const command of ['git add a.txt', 'git commit -m x', 'cd /r && git commit --amend --no-edit', 'git -C /r add .']) {
      expect(bash(command, 'read-only')).toContain('read-only')
    }
  })

  it('blocks the github tool from pushing or touching pull requests for every role', () => {
    for (const op of ['pr_create', 'pr_push', 'pr_checkout']) {
      expect(blockReason('github', { op }, 'write', SUBMIT)).toContain('not allowed')
      expect(blockReason('github', { op, forceWithLease: true }, 'read-only', SUBMIT)).toBeString()
    }
  })

  it('lets a writing role read through the github tool', () => {
    for (const op of ['repo_view', 'file_read', 'search_issues', 'search_prs', 'search_code', 'search_commits', 'search_repos', 'run_watch']) {
      expect(blockReason('github', { op }, 'write', SUBMIT)).toBeUndefined()
    }
  })

  it('reads a bash call without a command as an empty command', () => {
    expect(blockReason('bash', undefined, 'read-only', SUBMIT)).toBeUndefined()
  })
})

describe('isTransient', () => {
  it('treats rate limits, overload, quota, timeouts, gateway errors and dropped connections as transient', () => {
    for (const message of [
      '429 Too Many Requests',
      'Rate limit reached for requests',
      'rate_limit_error',
      'overloaded_error: Overloaded',
      '529 Overloaded',
      '502 Bad Gateway',
      '503 Service Unavailable',
      '504 Gateway Timeout',
      'You exceeded your current quota',
      'Request timed out',
      'ETIMEDOUT',
      'socket hang up',
      'ECONNRESET',
      'The connection was dropped',
      'terminated: other side closed',
    ]) {
      expect(isTransient(message)).toBe(true)
    }
    for (const message of ['401 Invalid API key', 'model not found: foo/bar', 'context length exceeded', '400 Bad Request', '']) {
      expect(isTransient(message)).toBe(false)
    }
  })
})

describe('omp extension in a role process (child mode)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'granny-omp-child-'))
  })
  afterEach(() => {
    delete process.env.GRANNY_OMP_CHILD
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers only the submit tool and the guard, and the submit tool records its arguments', async () => {
    const out = join(dir, 'sessions/1-judge/submission.json')
    process.env.GRANNY_OMP_CHILD = JSON.stringify({ tool: 'granny_submit_judgement', kind: 'judge', out, access: 'read-only' })
    const f = fakePi()
    await extension(f.pi as any)
    expect([...f.tools.keys()]).toEqual(['granny_submit_judgement'])
    const submit = f.tools.get('granny_submit_judgement')
    expect(submit.loadMode).toBe('essential')
    expect(submit.parameters).toBe(SCHEMAS.judge)
    expect(f.handlers.map(([event]) => event)).toEqual(['tool_call'])

    const value = { perFinding: [], rationale: 'nothing to judge' }
    expect(textOf(await exec(submit, value))).toBe('Recorded. You are done - stop now.')
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(value)

    const guard = f.handlers[0]![1]
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'bash', input: { command: 'cd /r && git push' } })).toMatchObject({ block: true, reason: expect.any(String) })
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'edit', input: {} })).toMatchObject({ block: true })
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'bash', input: { command: 'git diff main...HEAD' } })).toBeUndefined()
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'granny_submit_judgement', input: value })).toBeUndefined()
  })

  it('lets a writing role edit and commit', async () => {
    process.env.GRANNY_OMP_CHILD = JSON.stringify({ tool: 'granny_submit_implementation', kind: 'implementation', out: join(dir, 'out.json'), access: 'write' })
    const f = fakePi()
    await extension(f.pi as any)
    expect([...f.tools.keys()]).toEqual(['granny_submit_implementation'])
    const guard = f.handlers[0]![1]
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'edit', input: {} })).toBeUndefined()
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'bash', input: { command: 'git commit -qm x' } })).toBeUndefined()
    expect(await guard({ type: 'tool_call', toolCallId: 'c', toolName: 'ask', input: {} })).toMatchObject({ block: true })
  })
})

describe('omp extension in the user session (parent mode)', () => {
  let repo: string
  let fake: string
  const saved = { GRANNY_OMP_BIN: process.env.GRANNY_OMP_BIN, FAKE_OMP_DIR: process.env.FAKE_OMP_DIR }
  beforeEach(() => {
    repo = makeRepo()
    fake = mkdtempSync(join(tmpdir(), 'granny-fake-omp-'))
    const bin = join(fake, 'omp')
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fake-omp.ts')}' "$@"\n`)
    chmodSync(bin, 0o755)
    process.env.GRANNY_OMP_BIN = bin
    process.env.FAKE_OMP_DIR = fake
    process.env.GRANNY_CONFIG = join(repo, 'no-global-config.json')
  })
  afterEach(() => {
    for (const file of ['hang-implement-one.pid', 'wait-implement-one.pid']) {
      if (existsSync(join(fake, file))) {
        try {
          process.kill(Number(readFileSync(join(fake, file), 'utf8')), 'SIGKILL')
        } catch {}
      }
    }
    rmSync(repo, { recursive: true, force: true })
    rmSync(`${repo}-worktrees`, { recursive: true, force: true })
    rmSync(fake, { recursive: true, force: true })
    delete process.env.GRANNY_CONFIG
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const behave = (b: FakeOmpBehaviour) => writeFileSync(join(fake, 'behaviour.json'), JSON.stringify(b))
  const calls = () => readRun(fake, 'calls.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const callsTo = (slug: string) => calls().filter(c => c.slug === slug)
  const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)

  async function start(f: ReturnType<typeof fakePi>, config: Record<string, unknown> = {}) {
    writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }))
    const id = /granny run (\S+) started/.exec(started)?.[1]
    if (!id) throw new Error(started)
    return { id, dir: join(repo, '.granny/runs', id) }
  }

  it('registers granny_run, granny_status and granny_cancel as essential tools, and no submit tool', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    expect([...f.tools.keys()].sort()).toEqual(['granny_cancel', 'granny_run', 'granny_status'])
    for (const tool of f.tools.values()) {
      expect(tool.loadMode).toBe('essential')
      expect(tool.label).toBeString()
    }
    expect(f.tools.get('granny_run').parameters.required).toEqual(['repo', 'branch'])
    expect(f.handlers).toEqual([])
  })

  it('refuses adversarial-review on engine auto, which means the Codex CLI on omp, without starting a run', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    const refused = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ task: 't' }], config: { reviewers: [{ mode: 'adversarial-review' }] } }))
    expect(refused).toContain('on omp engine "auto" means the Codex CLI')
    expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
  })

  it('refuses a bad input before any role runs', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    expect(textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [] }))).toContain('stages must be')
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    expect(textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ task: 't' }] }))).toMatch(/granny_run refused:[\s\S]*dirty\.txt/)
    expect(calls()).toEqual([])
  })

  it('runs every role as its own omp process, with the role models, and reports back into the session', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f, { roles: { judge: { model: { omp: 'anthropic/judge-model' }, effort: 'high' } } })
    const result = await finished(dir)

    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean', rounds: 2 })
    expect(result.stages[0].history[0].findings[0]).toMatchObject({ id: 'reviewer-F1', reviewer: 'reviewer', severity: 'P2', file: 'a.txt', line: 1 })
    expect(result.final).toMatchObject({ gatesGreen: true })
    expect(calls().map(c => c.slug)).toEqual(['implement-one', 'review-one-r1-reviewer', 'judge-one-r1', 'fix-one-r1', 'review-one-r2-reviewer', 'pr-ready-check'])

    for (const c of calls()) {
      expect(c.argv.slice(0, 4)).toEqual(['--mode', 'json', '--no-title', '--no-extensions'])
      expect(flag(c.argv, '-e')).toBe(SOURCE)
      expect(flag(c.argv, '--approval-mode')).toBe('yolo')
      expect(flag(c.argv, '--session-dir')).toStartWith(join(dir, 'sessions/'))
      expect(c.argv).not.toContain('--continue')
      expect(c.cwd).toBe(repo)
      expect(c.child.out).toBe(join(flag(c.argv, '--session-dir')!, 'submission.json'))
      expect(c.stdin).toContain(`call the \`${c.child.tool}\` tool exactly once`)
    }
    const [impl, review, judge] = calls()
    expect(flag(impl.argv, '--model')).toBe('omp-test/parent-model')
    expect(impl.argv).not.toContain('--thinking')
    expect(impl.child).toMatchObject({ tool: 'granny_submit_implementation', kind: 'implementation', access: 'write' })
    expect(review.child).toMatchObject({ tool: 'granny_submit_findings', kind: 'findings', access: 'read-only' })
    expect(flag(judge.argv, '--model')).toBe('anthropic/judge-model')
    expect(flag(judge.argv, '--thinking')).toBe('high')
    expect(judge.child).toMatchObject({ tool: 'granny_submit_judgement', access: 'read-only' })
    expect(flag(review.argv, '--session-dir')).toBe(join(dir, 'sessions/2-review-one-r1-reviewer'))

    const agents = journalOf(dir).filter(e => e.type === 'agent')
    expect(agents.map(e => e.label)).toEqual(['implement one', 'review one r1 reviewer', 'judge one r1', 'fix one r1', 'review one r2 reviewer', 'pr-ready check'])
    expect(agents[0]).toMatchObject({ role: 'implementer', model: 'omp-test/parent-model' })
    expect(agents[2]).toMatchObject({ role: 'judge', model: 'anthropic/judge-model', effort: 'high' })

    await waitFor(() => f.sent.length > 0)
    expect(f.sent).toHaveLength(1)
    const [{ message, options }] = f.sent
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' })
    expect(message).toMatchObject({ customType: 'granny-workflow', display: true })
    expect(message.content).toContain(`[granny] Run ${id} finished.`)
    expect(message.content).toContain('- one: clean, 2 review round(s)')
    expect(message.content).toContain(`Call granny_status with runId "${id}"`)

    const status = textOf(await exec(f.tools.get('granny_status'), { repo }))
    expect(status).toContain('"status": "done"')
    expect(status).toContain('"outcome": "clean"')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('uses omp\'s default model when neither the role nor the calling session names one', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    writeFileSync(join(repo, 'granny.config.json'), '{}')
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }, { cwd: repo, model: undefined }))
    const id = /granny run (\S+) started/.exec(started)![1]!
    await finished(join(repo, '.granny/runs', id))
    expect(calls().every(c => !c.argv.includes('--model'))).toBe(true)
  })

  it('re-prompts in the same session when a role stops without submitting or submits an invalid result', async () => {
    behave({ skipOnce: ['implement-one'], invalidOnce: ['pr-ready-check'] })
    const f = fakePi()
    await extension(f.pi as any)
    const { dir } = await start(f)
    const result = await finished(dir)
    expect(result.stages[0].outcome).toBe('clean')

    const impl = callsTo('implement-one')
    expect(impl).toHaveLength(2)
    expect(impl[1].argv).toContain('--continue')
    expect(flag(impl[1].argv, '--session-dir')).toBe(flag(impl[0].argv, '--session-dir'))
    expect(impl[1].stdin).toBe('You stopped without calling granny_submit_implementation. Call it now with your result.')

    const final = callsTo('pr-ready-check')
    expect(final).toHaveLength(2)
    expect(final[1].argv).toContain('--continue')
    expect(final[1].stdin).toStartWith('Your granny_submit_final call was invalid: ')
    expect(final[1].stdin).toContain('Call granny_submit_final again with the corrected, complete result.')
    const retries = journalOf(dir).filter(e => e.type === 'retry')
    expect(retries.map(e => [e.label, e.attempt])).toEqual([
      ['implement one', 1],
      ['pr-ready check', 1],
    ])
  })

  it('backs off on a transient provider error and asks the role to continue', async () => {
    behave({ errors: [{ slug: 'judge-one-r1', message: '429 rate_limit_error: Too many requests', times: 1 }] })
    const slept: number[] = []
    const f = fakePi()
    await createGrannyExtension({ sleep: async ms => void slept.push(ms) })(f.pi as any)
    const { dir } = await start(f)
    const result = await finished(dir)

    expect(slept).toEqual([30_000])
    const judge = callsTo('judge-one-r1')
    expect(judge).toHaveLength(2)
    expect(judge[1].argv).toContain('--continue')
    expect(judge[1].stdin).toContain('429 rate_limit_error')
    expect(judge[1].stdin).toContain('call `granny_submit_judgement` exactly once')
    expect(journalOf(dir)).toContainEqual(
      expect.objectContaining({ type: 'provider-error', label: 'judge one r1', error: '429 rate_limit_error: Too many requests', transient: true, backoffMs: 30_000 }),
    )
    expect(journalOf(dir).filter(e => e.type === 'retry')).toEqual([])
    expect(result.stages[0].history[0].findings[0].priority).toBeNumber()
  })

  it('gives up on a role after the backoff budget', async () => {
    behave({ errors: [{ slug: 'judge-one-r1', message: '503 Service Unavailable', times: 99 }] })
    const slept: number[] = []
    const f = fakePi()
    await createGrannyExtension({ delays: [5, 10], sleep: async ms => void slept.push(ms) })(f.pi as any)
    const { dir } = await start(f)
    await finished(dir)
    expect(slept.slice(0, 2)).toEqual([5, 10])
    expect(callsTo('judge-one-r1')).toHaveLength(3)
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'agent-failed', label: 'judge one r1', error: '503 Service Unavailable' }))
  })

  it('does not retry a provider error that waiting cannot fix', async () => {
    behave({ errors: [{ slug: 'judge-one-r1', message: '401 Invalid API key', times: 99 }] })
    const slept: number[] = []
    const f = fakePi()
    await createGrannyExtension({ sleep: async ms => void slept.push(ms) })(f.pi as any)
    const { dir } = await start(f)
    await finished(dir)
    expect(slept).toEqual([])
    expect(callsTo('judge-one-r1')).toHaveLength(1)
    const journal = journalOf(dir)
    expect(journal).toContainEqual(expect.objectContaining({ type: 'provider-error', label: 'judge one r1', transient: false }))
    expect(journal).toContainEqual(expect.objectContaining({ type: 'agent-failed', label: 'judge one r1', error: '401 Invalid API key' }))
  })

  it('cancels a run by killing the role process group, also when it ignores SIGTERM', async () => {
    behave({ hang: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const { id, dir } = await start(f)
    const pidFile = join(fake, 'hang-implement-one.pid')
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)

    expect(textOf(await exec(f.tools.get('granny_cancel'), { runId: id }))).toContain(`Cancelling ${id}`)
    await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 3000)
    await waitFor(() => !alive(), 3000)
    expect(callsTo('implement-one')).toHaveLength(1)
    expect(f.sent).toEqual([])
    expect(textOf(await exec(f.tools.get('granny_cancel'), { runId: id }))).toContain(`No running granny run "${id}"`)
  })

  it('sends no SIGKILL after cancel once the role process has exited on SIGTERM', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 300 })(f.pi as any)
    const { id, dir } = await start(f)
    const pidFile = join(fake, 'wait-implement-one.pid')
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const signals: Array<[number, unknown]> = []
    const realKill = process.kill.bind(process)
    const spy = spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      if (target === -pid) signals.push([target, signal])
      return realKill(target, signal)
    }) as typeof process.kill)
    try {
      expect(textOf(await exec(f.tools.get('granny_cancel'), { runId: id }))).toContain(`Cancelling ${id}`)
      await waitFor(() => readRun(dir, 'status.json').includes('"status": "cancelled"'), 3000)
      await Bun.sleep(600)
    } finally {
      spy.mockRestore()
    }
    expect(signals).toEqual([[-pid, 'SIGTERM']])
  })

  it('fails the run with a message naming GRANNY_OMP_BIN when omp cannot be started', async () => {
    process.env.GRANNY_OMP_BIN = join(fake, 'no-such-omp')
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f)
    await waitFor(() => f.sent.length > 0)
    expect(readRun(dir, 'status.json')).toContain('"status": "failed"')
    expect(f.sent[0]!.message.content).toContain(`[granny] Run ${id} failed: `)
    expect(f.sent[0]!.message.content).toContain('GRANNY_OMP_BIN')
    expect(f.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' })
  })

  it('keeps the run alive when posting the completion message throws', async () => {
    behave({})
    const f = fakePi()
    f.pi.sendMessage = () => {
      throw new Error('session gone')
    }
    await extension(f.pi as any)
    const { dir } = await start(f)
    await finished(dir)
    await waitFor(() => journalOf(dir).some(e => e.type === 'notify-failed'))
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'notify-failed', error: expect.stringContaining('session gone') }))
  })
})
