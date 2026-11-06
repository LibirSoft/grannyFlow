import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAME_MODEL_HINT } from '../src/adapters/common'
import extension, { blockReason, createGrannyExtension, isTransient, waitSeconds } from '../src/adapters/omp/extension'
import { lineType, LiveRun, type LogEntry, PARSED_EVENTS, type RoleActivity } from '../src/adapters/omp/panel'
import { EventLog } from '../src/adapters/omp/watch'
import { planReviewWarning } from '../src/core/config'
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
  const commands = new Map<string, any>()
  const shortcuts = new Map<string, any>()
  const handlers: Array<[string, any]> = []
  const sent: Array<{ message: any; options: any }> = []
  const pi = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerShortcut: (shortcut: string, options: any) => {
      if (shortcuts.has(shortcut)) throw new Error(`${shortcut} registered twice`)
      shortcuts.set(shortcut, options)
    },
    on: (event: string, handler: any) => handlers.push([event, handler]),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  }
  return { pi, tools, commands, shortcuts, handlers, sent }
}

const CTX = { cwd: '/', model: { provider: 'omp-test', id: 'parent-model' } }
const exec = (tool: any, params: unknown, ctx: unknown = CTX) => tool.execute('call-1', params, undefined, undefined, ctx)
const textOf = (r: any) => r.content.map((c: any) => c.text).join('')

function fakeUi() {
  const calls: Array<{ fn: 'setWidget' | 'setStatus'; key: string; content: any; options?: any }> = []
  const ui = {
    setWidget: (key: string, content: any, options?: any) => void calls.push({ fn: 'setWidget', key, content, options }),
    setStatus: (key: string, content: any) => void calls.push({ fn: 'setStatus', key, content }),
  }
  const last = (fn: string, key: string) => calls.filter(c => c.fn === fn && c.key === key).at(-1)
  return {
    ui,
    calls,
    widgets: (key: string) => calls.filter(c => c.fn === 'setWidget' && c.key === key),
    widget: (key: string): string[] | undefined => last('setWidget', key)?.content,
    status: (key: string): string | undefined => last('setStatus', key)?.content,
  }
}

const ev = (event: unknown) => JSON.stringify(event)
const update = (type: string, extra: Record<string, unknown> = {}) => ev({ type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, ...extra } })

function feed(role: RoleActivity, line: string, now: number) {
  const type = lineType(line)
  if (type !== undefined && !PARSED_EVENTS.has(type)) role.stream(type, line, now)
  else role.event(JSON.parse(line), now)
}

const ompState = () => (globalThis as any)[Symbol.for('granny-workflow.omp.state')] as { runs: Map<string, any>; navigating?: boolean }
const liveRoles = (id: string): RoleActivity[] => ompState().runs.get(id).live.roles

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

describe('waitSeconds', () => {
  it('clamps granny_wait\'s timeout to 1..7200 s and defaults to 1800 s', () => {
    expect([waitSeconds(undefined), waitSeconds(null), waitSeconds('soon'), waitSeconds(Number.NaN), waitSeconds(Infinity)]).toEqual([1800, 1800, 1800, 1800, 1800])
    expect([waitSeconds(0), waitSeconds(-5), waitSeconds(0.2), waitSeconds(60), waitSeconds('90'), waitSeconds(7200), waitSeconds(99_999)]).toEqual([1, 1, 1, 60, 90, 7200, 7200])
  })
})

describe('live panel', () => {
  it('follows a role from waiting through thinking, writing and its tool calls, with how long each state has lasted', () => {
    let t = 0
    const live = new LiveRun('r1', undefined, { now: () => t, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner', model: 'openai/gpt', effort: 'max', session: 's', phase: 'p' })
    live.start(role)
    const lines = () => live.lines(Number.POSITIVE_INFINITY).slice(1)
    expect(lines()).toEqual(['  plan (planner) · openai/gpt/max · starting 0s'])
    feed(role, ev({ type: 'turn_start' }), t)
    feed(role, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }), t)
    t = 5_000
    expect(lines()[0]).toEndWith(' · waiting for model 5s')

    feed(role, update('thinking_start'), t)
    feed(role, update('thinking_delta', { delta: 'Let me look.\n\n**Comparing auth' }), t)
    feed(role, update('thinking_delta', { delta: 'entication options**\n\nweighing both' }), t + 1000)
    t += 192_000
    expect(lines()[0]).toBe('  plan (planner) · openai/gpt/max · thinking 3m12s · "Comparing authentication options"')

    feed(role, update('text_start'), t)
    feed(role, update('text_delta', { delta: 'The plan' }), t)
    expect(lines()[0]).toEndWith(' · writing 0s')
    feed(role, update('toolcall_start'), t)
    expect(lines()[0]).toEndWith(' · preparing a tool call 0s')

    feed(role, ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/auth.ts' }, intent: 'Reading auth controller routes' }), t)
    t += 3_000
    expect(lines()[0]).toEndWith(' · running read: Reading auth controller routes 3s')
    feed(role, ev({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: {} }), t)
    expect(lines()).toEqual(['  plan (planner) · openai/gpt/max · waiting for model 0s', '    last tool: Reading auth controller routes (0s ago)'])

    feed(role, ev({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'git   status\n--short' } }), t)
    expect(lines()[0]).toEndWith(' · running bash: git status --short 0s')
    feed(role, ev({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: {}, isError: true }), t)
    t += 480_000
    expect(lines()[1]).toBe('    last tool: bash: git status --short ✗ (8m00s ago)')
  })

  it('lists the subagents of a task call and marks them when it ends', () => {
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner', session: 's', phase: 'p' })
    live.start(role)
    const batch = { context: 'c', tasks: [{ name: 'BaselineGates', agent: 'explore', task: 'a' }, { agent: 'reviewer', task: 'b' }] }
    expect(role.event({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'task', args: batch }, 0)).toEqual(['BaselineGates', 'reviewer'])
    expect(live.lines()[1]).toBe('  plan (planner) · default model · running task: BaselineGates, reviewer 0s')
    expect(live.lines()[2]).toBe('    └ task: BaselineGates …, reviewer …')
    role.event({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'task', result: {} }, 0)
    expect(live.lines()).toContain('    └ task: BaselineGates ✓, reviewer ✓')
    expect(role.event({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'task', args: { agent: 'explore', task: 'x' } }, 0)).toEqual(['explore'])
    role.event({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'task', result: {}, isError: true }, 0)
    expect(live.lines()).toContain('    └ task: explore ✗')
    expect(role.event({ type: 'tool_execution_start', toolCallId: 't3', toolName: 'read', args: {} }, 0)).toBeUndefined()
  })

  it('classifies message_update lines from their first bytes and reads the heading without parsing them whole', () => {
    const tail = `,"partial":{"content":[${'{"type":"thinking","thinking":"'.repeat(20_000)}`
    const writing = `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}${tail}`
    const thinking = `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"**Big \\\\ \\"quoted\\" heading**\\n"}${tail}`
    const older = `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"${'x'.repeat(50_000)}"}]},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1}}`
    expect(() => JSON.parse(writing)).toThrow()
    expect([lineType(writing), lineType(thinking), lineType(older)]).toEqual(['message_update', 'message_update', 'message_update'])
    expect(PARSED_EVENTS.has('message_update')).toBe(false)

    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'judge', role: 'judge', session: 's', phase: 'p' })
    live.start(role)
    const parse = spyOn(JSON, 'parse')
    try {
      role.stream('message_update', writing, 0)
      expect(role.state).toBe('writing')
      role.stream('message_update', older, 0)
      expect(role.state).toBe('preparing a tool call')
      role.stream('message_update', update('thinking_start'), 0)
      role.stream('message_update', thinking, 0)
      expect(parse).toHaveBeenCalledTimes(1)
      expect(live.lines()[1]).toEndWith(' · thinking 0s · "Big \\ \"quoted\" heading"')
      expect(parse.mock.calls.every(([arg]) => String(arg).length < 100)).toBe(true)
    } finally {
      parse.mockRestore()
    }
  })

  it('keeps a bounded tail of the thinking text, not the raw lines, between draws, and still finds the heading', () => {
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner', session: 's', phase: 'p' })
    live.start(role)
    role.stream('message_update', update('thinking_start'), 0)
    const partial = `,"partial":{"content":[{"type":"thinking","thinking":"${'y'.repeat(100_000)}"}]}`
    role.stream('message_update', `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"**Early heading**\\n"}${partial}}`, 0)
    for (let i = 0; i < 300; i++) {
      role.stream('message_update', `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"step ${i} "}${partial}}`, 0)
    }
    expect(role.retainedChars).toBeLessThanOrEqual(8000)
    expect(live.lines()[1]).toEndWith(' · thinking 0s · "Early heading"')
    live.stop(role)
    expect(role.retainedChars).toBe(0)
    expect(live.roles).toEqual([role])
  })

  it('draws at most once per renderEveryMs, refreshes on its own from the first draw, and stops when closed', async () => {
    let t = 1_000_000
    const u = fakeUi()
    const live = new LiveRun('r2', u.ui, { now: () => t, renderEveryMs: 1000 })
    t += 1000
    await Bun.sleep(300)
    expect(u.calls).toEqual([])
    const role = live.role({ label: 'implement one', role: 'implementer', model: 'm', session: 's', phase: 'p' })
    live.start(role)
    for (let i = 0; i < 500; i++) {
      role.stream('message_update', update('text_delta', { delta: 'x' }), t)
      live.touch()
    }
    expect(u.widgets('granny-r2')).toHaveLength(1)
    t += 999
    live.touch()
    expect(u.widgets('granny-r2')).toHaveLength(1)
    t += 1
    live.touch()
    expect(u.widgets('granny-r2')).toHaveLength(2)
    expect(u.widgets('granny-r2')[0]!.options).toEqual({ placement: 'aboveEditor' })
    expect(u.status('granny-r2')).toBe('granny r2 · Starting · 1 active · 2s')

    t += 1000
    await Bun.sleep(300)
    expect(u.widgets('granny-r2')).toHaveLength(3)
    expect(u.widget('granny-r2')![1]).toEndWith(' · writing 2s')

    const clear = live.close('done')
    expect(u.widgets('granny-r2')).toHaveLength(4)
    expect(u.widget('granny-r2')).toBeUndefined()
    expect(u.status('granny-r2')).toBe('granny r2: done')
    t += 5000
    live.touch()
    await Bun.sleep(300)
    expect(u.widgets('granny-r2')).toHaveLength(4)
    clear()
    clear()
    expect(u.status('granny-r2')).toBeUndefined()
    expect(u.calls.filter(c => c.fn === 'setStatus' && c.content === undefined)).toHaveLength(1)
  })

  it('keeps the widget to 8 lines, collapsing the other roles into "+N more"', () => {
    const live = new LiveRun('r3', undefined, { now: () => 0, renderEveryMs: 1000 })
    for (let i = 1; i <= 6; i++) {
      const role = live.role({ label: `review one r1 reviewer${i}`, role: 'reviewer', session: 's', phase: 'p' })
      live.start(role)
      role.event({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: { path: 'a.ts' } }, 0)
      role.event({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', result: {} }, 0)
    }
    const lines = live.lines()
    expect(lines).toHaveLength(8)
    expect(lines.at(-1)).toBe('  +3 more')
    expect(live.lines(Number.POSITIVE_INFINITY)).toHaveLength(13)
    expect(live.status()).toBe('granny r3 · Starting · 6 active · 0s')
  })

  it('makes no UI call and keeps no timer without a UI', async () => {
    const live = new LiveRun('r4', undefined, { now: () => 0, renderEveryMs: 1 })
    const role = live.role({ label: 'judge one r1', role: 'judge', session: 's', phase: 'p' })
    live.start(role)
    live.setPhase('Review')
    expect(live.lines()[0]).toBe('granny r4 · Review · 0s')
    live.stop(role)
    expect(live.lines()).toEqual(['granny r4 · Review · 0s', '  no role process running'])
    live.close('done')()
  })

  it('names a running command without its cd to the worktree, and a path relative to the role\'s cwd', () => {
    const live = new LiveRun('r5', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'implement one', role: 'implementer', session: 's', phase: 'p', cwd: '/home/u/wt' })
    live.start(role)
    role.event({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: "cd '/home/u/wt' && bun test test/GameService.test.ts" } }, 0)
    expect(live.lines()[1]).toBe('  implement one (implementer) · default model · running bash: bun test test/GameService.test.ts 0s')
    role.event({ type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: {} }, 0)
    role.event({ type: 'tool_execution_start', toolCallId: 'r', toolName: 'read', args: { path: '/home/u/wt/src/services/GameService.ts' } }, 0)
    expect(live.lines()[1]).toBe('  implement one (implementer) · default model · running read: src/services/GameService.ts 0s')
    expect(live.lines()[2]).toBe('    last tool: bash: bun test test/GameService.test.ts (0s ago)')
  })

  it('tells where the agents are on the widget\'s first line only when given a hint, never in granny_status\'s copy', () => {
    const u = fakeUi()
    const live = new LiveRun('r6', u.ui, { now: () => 0, renderEveryMs: 1000, hint: '/granny or alt+w: agents' })
    live.touch()
    expect(u.widget('granny-r6')![0]).toBe('granny r6 · Starting · 0s · /granny or alt+w: agents')
    expect(live.lines()[0]).toBe('granny r6 · Starting · 0s')
    live.close('done')
    const plain = fakeUi()
    const other = new LiveRun('r7', plain.ui, { now: () => 0, renderEveryMs: 1000 })
    other.touch()
    expect(plain.widget('granny-r7')![0]).toBe('granny r7 · Starting · 0s')
    other.close('done')
  })

  it('gives what a role does now as a state the navigator can draw', () => {
    let t = 0
    const live = new LiveRun('r8', undefined, { now: () => t, renderEveryMs: 1000 })
    const role = live.role({ label: 'implement one', role: 'implementer', session: 's', phase: 'p', cwd: '/wt' })
    expect(role.now()).toBeUndefined()
    live.start(role)
    expect(role.now()).toEqual({ state: 'starting', since: 0 })
    t = 2000
    role.stream('message_update', update('thinking_start'), t)
    role.stream('message_update', update('thinking_delta', { delta: '**Weighing the options**\n' }), t)
    role.flush()
    expect(role.now()).toEqual({ state: 'thinking', since: 2000, heading: 'Weighing the options' })
    t = 5000
    role.event({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'cd /wt && bun test' } }, t)
    expect(role.now()).toEqual({ state: 'running', tool: 'bash', arg: 'bun test', since: 5000, heading: 'Weighing the options' })
    role.event({ type: 'tool_execution_start', toolCallId: 'r', toolName: 'read', args: { path: 'a.ts' }, intent: 'Reading a' }, t)
    expect(role.now()).toMatchObject({ state: 'running', tool: 'read', intent: 'Reading a' })
    role.event({ type: 'tool_execution_end', toolCallId: 'r', toolName: 'read', result: {} }, t)
    expect(role.now()).toMatchObject({ state: 'running', tool: 'bash', arg: 'bun test' })
    role.event({ type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', result: {} }, t)
    expect(role.now()).toMatchObject({ state: 'waiting' })
    role.stream('message_update', update('toolcall_start'), t)
    expect(role.now()?.state).toBe('preparing')
    role.stream('message_update', update('text_delta', { delta: 'x' }), t)
    expect(role.now()?.state).toBe('writing')
    live.stop(role)
    expect(role.now()).toBeUndefined()
  })
})

describe('role event log', () => {
  it('condenses a role\'s stream into state, heading, tool, tool-end, text, subagents and exit entries', () => {
    const entries: LogEntry[] = []
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner', session: 's', phase: 'p' }, entry => void entries.push(entry))
    live.start(role)
    const huge = `,"partial":{"content":[{"type":"thinking","thinking":"HUGE${'z'.repeat(50_000)}"}]}`
    for (const line of [
      ev({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      update('thinking_start'),
      `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"**Comparing"}${huge}}`,
      update('thinking_delta', { delta: ' options**\n\nfirst' }),
      update('thinking_delta', { delta: ' more' }),
      ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'plan.md' }, intent: 'Reading the plan' }),
      ev({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: {} }),
      ev({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: `echo ${'a'.repeat(300)}` } }),
      ev({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: {}, isError: true }),
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: `Done. ${'w'.repeat(5000)}` }], stopReason: 'stop' } }),
      ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } }),
      ev({ type: 'tool_execution_start', toolCallId: 't3', toolName: 'task', args: { tasks: [{ name: 'BaselineGates' }, { agent: 'explore' }] } }),
    ]) feed(role, line, 0)
    role.exit(0)
    expect(entries.map(e => e.type)).toEqual(['state', 'state', 'heading', 'state', 'tool', 'tool-end', 'state', 'state', 'tool', 'tool-end', 'state', 'text', 'state', 'tool', 'subagents', 'exit'])
    expect(entries.slice(0, 7)).toEqual([
      { type: 'state', state: 'waiting for model' },
      { type: 'state', state: 'thinking' },
      { type: 'heading', text: 'Comparing options' },
      { type: 'state', state: 'running read: Reading the plan' },
      { type: 'tool', id: 't1', name: 'read', intent: 'Reading the plan', arg: 'plan.md' },
      { type: 'tool-end', id: 't1', name: 'read' },
      { type: 'state', state: 'waiting for model' },
    ])
    expect(entries[8]).toEqual({ type: 'tool', id: 't2', name: 'bash', arg: `echo ${'a'.repeat(194)}…` })
    expect(entries[9]).toEqual({ type: 'tool-end', id: 't2', name: 'bash', error: true })
    const text = entries.find(e => e.type === 'text') as { text: string }
    expect(text.text).toStartWith('Done. www')
    expect(text.text).toHaveLength(4000)
    expect(entries.at(-2)).toEqual({ type: 'subagents', agents: ['BaselineGates', 'explore'] })
    expect(entries.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect(JSON.stringify(entries)).not.toContain('HUGE')
  })

  it('logs the todo list a todo call left, with done, active and pending items, and nothing for a failed one', () => {
    const entries: LogEntry[] = []
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'implement one', role: 'implementer', session: 's', phase: 'p' }, entry => void entries.push(entry))
    live.start(role)
    const phases = [
      { name: 'Auth', tasks: [{ content: 'Tracking complete auth recovery stage', status: 'completed' }, { content: 'Advancing to durable session completion', status: 'in_progress' }] },
      { name: 'Wrap up', tasks: [{ content: 'Final checks', status: 'pending' }, { content: 'Old idea', status: 'abandoned' }, { content: 'Needs input', status: 'blocked' }] },
    ]
    role.event({ type: 'tool_execution_start', toolCallId: 'td', toolName: 'todo', args: { op: 'start', task: 'Advancing to durable session completion' } }, 0)
    role.event({ type: 'tool_execution_end', toolCallId: 'td', toolName: 'todo', result: { content: [{ type: 'text', text: 'ok' }], details: { op: 'start', phases } } }, 0)
    role.event({ type: 'tool_execution_start', toolCallId: 'bad', toolName: 'todo', args: { op: 'done' } }, 0)
    role.event({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'todo', result: { details: { phases: [] } }, isError: true }, 0)
    role.event({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', result: { details: { phases: 'not a list' } } }, 0)
    expect(entries.filter(e => e.type === 'todo')).toEqual([
      {
        type: 'todo',
        todos: [
          { text: 'Tracking complete auth recovery stage', state: 'done' },
          { text: 'Advancing to durable session completion', state: 'active' },
          { text: 'Final checks', state: 'pending' },
          { text: 'Needs input', state: 'pending' },
        ],
      },
    ])
    expect(entries.map(e => e.type)).toEqual(['state', 'tool', 'todo', 'tool-end', 'state', 'state', 'tool', 'tool-end', 'state', 'tool-end'])
  })

  it('stops writing after the first failed append, reports it once, and never throws - not even when reporting fails', () => {
    const errors: unknown[] = []
    const log = new EventLog('/proc/no-such-dir/events.jsonl', () => 0, e => {
      errors.push(e)
      throw new Error('journal gone too')
    })
    expect(() => {
      log.write({ type: 'state', state: 'thinking' })
      log.write({ type: 'exit', code: 0 })
    }).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('logs each new heading once, as it arrives, without a draw', () => {
    const headings: string[] = []
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner', session: 's', phase: 'p' }, e => void (e.type === 'heading' && headings.push(e.text)))
    live.start(role)
    role.stream('message_update', update('thinking_start'), 0)
    for (const delta of ['**First**\n', 'body *x* ', 'more\n', '**Second', ' one**\n', 'tail']) role.stream('message_update', update('thinking_delta', { delta }), 0)
    expect(headings).toEqual(['First', 'Second one'])
    live.lines()
    expect(headings).toEqual(['First', 'Second one'])
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
    expect([...f.commands.keys()]).toEqual([])
    expect([...f.shortcuts.keys()]).toEqual([])
    const submit = f.tools.get('granny_submit_judgement')
    expect(submit.loadMode).toBe('essential')
    expect(submit.parameters).toBe(SCHEMAS.judge)
    expect(f.handlers.map(([event]) => event).sort()).toEqual(['session_start', 'tool_call'])

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

  it('lets only the role\'s top-level agent submit: a subagent\'s call writes nothing and is told to report to its parent', async () => {
    const out = join(dir, 'sessions/1-plan/submission.json')
    process.env.GRANNY_OMP_CHILD = JSON.stringify({ tool: 'granny_submit_plan', kind: 'plan', out, access: 'write' })
    const f = fakePi()
    await extension(f.pi as any)
    const submit = f.tools.get('granny_submit_plan')
    const sub = { cwd: dir, agent: { kind: 'sub', id: '0-BaselineGates', name: 'task', depth: 1, parentId: 'Main' } }
    const refused = textOf(await exec(submit, { notes: 'research notes' }, sub))
    expect(refused).toBe("granny: only the role's top-level agent submits the result - return your findings to the agent that spawned you.")
    expect(existsSync(out)).toBe(false)

    const value = { plan: 'the plan' }
    expect(textOf(await exec(submit, value, { cwd: dir, agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } }))).toBe('Recorded. You are done - stop now.')
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(value)
  })

  it('hides the submit tool from a subagent session and leaves the top-level role session alone', async () => {
    process.env.GRANNY_OMP_CHILD = JSON.stringify({ tool: 'granny_submit_findings', kind: 'findings', out: join(dir, 'out.json'), access: 'read-only' })
    const f = fakePi()
    const set: string[][] = []
    const api = { ...f.pi, getActiveTools: () => ['read', 'granny_submit_findings', 'bash'], setActiveTools: async (names: string[]) => void set.push(names) }
    await extension(api as any)
    const sessionStart = f.handlers.find(([event]) => event === 'session_start')![1]
    await sessionStart({ type: 'session_start' }, { agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } })
    await sessionStart({ type: 'session_start' }, {})
    expect(set).toEqual([])
    await sessionStart({ type: 'session_start' }, { agent: { kind: 'sub', id: '0-Explore', name: 'explore', depth: 1 } })
    expect(set).toEqual([['read', 'bash']])

    const broken = fakePi()
    await extension({ ...broken.pi, getActiveTools: () => { throw new Error('runtime not initialized') } } as any)
    const brokenStart = broken.handlers.find(([event]) => event === 'session_start')![1]
    await brokenStart({ type: 'session_start' }, { agent: { kind: 'sub', id: '0-Explore', name: 'explore', depth: 1 } })
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
    ompState().runs.clear()
    ompState().navigating = false
  })
  afterEach(() => {
    for (const file of ['hang-implement-one.pid', 'wait-implement-one.pid', 'wait-review-one-r1-reviewer.pid']) {
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

  async function start(f: ReturnType<typeof fakePi>, config: Record<string, unknown> = {}, ctx: unknown = CTX, extra: Record<string, unknown> = {}) {
    writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }], ...extra }, ctx))
    const id = /granny run (\S+) started/.exec(started)?.[1]
    if (!id) throw new Error(started)
    return { id, dir: join(repo, '.granny/runs', id), started }
  }

  it('registers granny_run, granny_status, granny_wait and granny_cancel as essential tools, and no submit tool', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    expect([...f.tools.keys()].sort()).toEqual(['granny_cancel', 'granny_judge', 'granny_run', 'granny_status', 'granny_wait'])
    expect(f.tools.get('granny_wait').parameters.required).toEqual(['runId'])
    expect(f.tools.get('granny_wait').interruptible).toBe(true)
    for (const name of ['granny_run', 'granny_judge', 'granny_status', 'granny_cancel']) expect(f.tools.get(name).interruptible).toBeUndefined()
    for (const tool of f.tools.values()) {
      expect(tool.loadMode).toBe('essential')
      expect(tool.label).toBeString()
    }
    expect(f.tools.get('granny_run').parameters.required).toEqual(['repo', 'branch'])
    expect(f.tools.get('granny_judge').parameters.required).toEqual(['repo'])
    expect(f.handlers).toEqual([])
    expect([...f.commands.keys()]).toEqual(['granny'])
    expect([...f.shortcuts.keys()]).toEqual(['alt+w'])
    expect(f.commands.get('granny').description).toContain('alt+w')
    expect(f.commands.get('granny').getArgumentCompletions('o').map((i: any) => i.value)).toEqual(['off', 'on'])
  })

  it('warns in its start reply what a plan review costs, only when the run reviews a plan', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const plan = join(repo, '.granny/plans/v1.md')
    mkdirSync(join(repo, '.granny/plans'), { recursive: true })
    writeFileSync(plan, '# plan\n')
    const on = await start(f, {}, CTX, { plan: [plan], config: { planReview: true, maxRounds: 2 } })
    expect(on.started).toContain(planReviewWarning(2))
    expect(on.started).toContain('Tell the user this in your next message')
    expect(on.started).toContain('\noverrides: maxRounds 2 (config: 4), planReview true (config: false) - show this line to the user in your next message')
    await exec(f.tools.get('granny_cancel'), { runId: on.id })
    await finished(on.dir)
    const off = await start(f, { maxRounds: 3 }, CTX, { plan: [plan] })
    expect(off.started).not.toContain('Plan review is on')
    expect(off.started).not.toContain('overrides:')
    await exec(f.tools.get('granny_cancel'), { runId: off.id })
    await finished(off.dir)
  })

  it('hints in its start reply when the reviewers share the implementer model, and starts the run either way', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const same = await start(f, { reviewers: [{ name: 'reviewer', engine: 'agent' }] })
    expect(same.started).toContain(SAME_MODEL_HINT)
    await exec(f.tools.get('granny_cancel'), { runId: same.id })
    await finished(same.dir)
    const other = await start(f, { reviewers: [{ name: 'reviewer', engine: 'agent', model: { omp: 'openai-codex/gpt-6.1-sol' } }] })
    expect(other.started).not.toContain(SAME_MODEL_HINT)
    await exec(f.tools.get('granny_cancel'), { runId: other.id })
    await finished(other.dir)
  })

  it('writes the run outline to status.json from the start, and a planning run as kind plan', async () => {
    behave({ wait: ['implement-one', 'plan'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const run = await start(f)
    expect(JSON.parse(readRun(run.dir, 'status.json'))).toMatchObject({ status: 'running', outline: { kind: 'implement', branch: 'feat/x', stages: [{ number: 1, name: 'one' }] } })
    await waitFor(() => callsTo('implement-one').length > 0)
    await exec(f.tools.get('granny_cancel'), { runId: run.id })
    await finished(run.dir)
    expect(JSON.parse(readRun(run.dir, 'status.json'))).toMatchObject({ status: 'cancelled', outline: { kind: 'implement' } })

    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', goal: 'Build it.' }))
    const id = /granny run (\S+) started/.exec(started)![1]!
    const dir = join(repo, '.granny/runs', id)
    expect(JSON.parse(readRun(dir, 'status.json')).outline).toMatchObject({ kind: 'plan', stages: [], finalReview: false })
    await waitFor(() => callsTo('plan').length > 0)
    expect(journalOf(dir).find(e => e.type === 'agent')).toMatchObject({ label: 'plan', cwd: repo })
    await exec(f.tools.get('granny_cancel'), { runId: id })
    await finished(dir)
  })

  it('leaves the heartbeats out of granny_status, so a long command does not push out the real entries', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const run = await start(f)
    await waitFor(() => callsTo('implement-one').length > 0)
    fs.appendFileSync(join(run.dir, 'journal.jsonl'), Array.from({ length: 60 }, () => `${JSON.stringify({ t: 'now', type: 'heartbeat', command: 'bun test' })}\n`).join(''))
    const status = textOf(await exec(f.tools.get('granny_status'), { runId: run.id }))
    expect(status).toContain('"type":"phase"')
    expect(status).not.toContain('"type":"heartbeat"')
    await exec(f.tools.get('granny_cancel'), { runId: run.id })
    await finished(run.dir)
  })

  it('journals a heartbeat while a long command runs, and none after it ends', async () => {
    behave({})
    const f = fakePi()
    await createGrannyExtension({ heartbeatMs: 40 })(f.pi as any)
    const { dir } = await start(f, { checks: [{ name: 'slow', run: 'sleep 0.3' }] })
    await finished(dir)
    const beats = journalOf(dir).filter(e => e.type === 'heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(3)
    for (const beat of beats) expect(beat.command).toContain('sleep 0.3')
    await Bun.sleep(150)
    expect(journalOf(dir).filter(e => e.type === 'heartbeat')).toHaveLength(beats.length)
  })

  it('refuses a Claude Code model alias given for every host before any role starts, naming the entry, its config file and the host-keyed fix', async () => {
    behave({})
    const global = join(fake, 'global-config.json')
    process.env.GRANNY_CONFIG = global
    writeFileSync(global, JSON.stringify({ reviewers: [{ name: 'sonnet', engine: 'agent', model: 'sonnet' }] }))
    const f = fakePi()
    await extension(f.pi as any)
    const run = (config?: unknown) => exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ task: 't' }], ...(config ? { config } : {}) })
    const refused = textOf(await run({ roles: { implementer: { model: 'opus' } } }))
    expect(refused).toStartWith('granny_run refused:\n- ')
    expect(refused).toContain(`reviewers[0] "sonnet": model "sonnet" (from ${global})`)
    expect(refused).toContain('is a Claude Code model alias')
    expect(refused).toContain('{ "claude-code": "sonnet", "omp": "<provider/model>" }')
    expect(refused).toContain(`roles.implementer.model: "opus" (from the run's config)`)
    expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
    expect(calls()).toEqual([])

    const started = textOf(await run({ reviewers: [{ name: 'sonnet', engine: 'agent', model: { 'claude-code': 'sonnet', omp: 'sonnet' } }], roles: { implementer: { model: 'anthropic/claude-opus' } } }))
    const id = /granny run (\S+) started/.exec(started)![1]!
    await finished(join(repo, '.granny/runs', id))
  })

  it('refuses a Codex reviewer, which granny does not run on omp, without starting a run', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    for (const reviewer of [{ name: 'c' }, { engine: 'codex' }, { engine: 'codex-plugin', mode: 'adversarial-review' }]) {
      const refused = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ task: 't' }], config: { reviewers: [reviewer] } }))
      expect(refused).toContain('runs Codex, which granny does not run on omp - use "engine": "agent" with an omp model')
    }
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
    expect(agents.map(e => e.phase)).toEqual(['Implement', 'Review', 'Review', 'Implement', 'Review', 'PR ready'])
    expect(agents.map(e => e.cwd)).toEqual(agents.map(() => repo))
    expect(journalOf(dir).filter(e => e.type === 'stage').map(({ t: _t, type: _type, ...e }) => e)).toEqual([
      { number: 1, name: 'one', event: 'start' },
      { number: 1, name: 'one', event: 'end', outcome: 'clean' },
    ])
    expect(JSON.parse(readRun(dir, 'status.json')).outline).toEqual({
      kind: 'implement',
      branch: 'feat/x',
      worktree: true,
      planReview: false,
      finalReview: false,
      reviewers: ['reviewer'],
      fromStage: 1,
      stages: [{ number: 1, name: 'one', implement: true, review: true, checks: false }],
    })
    const ends = journalOf(dir).filter(e => e.type === 'agent-end')
    for (const agent of agents) {
      expect(ends.filter(e => e.session === agent.session)).toEqual([{ t: expect.any(String), type: 'agent-end', label: agent.label, session: agent.session, outcome: 'done' }])
    }
    expect(ends).toHaveLength(agents.length)
    const roles = liveRoles(id)
    expect(roles.map(r => [r.info.label, r.info.phase, r.info.session, r.outcome])).toEqual(agents.map(e => [e.label, e.phase, e.session, 'done']))

    await waitFor(() => f.sent.length > 0)
    expect(f.sent).toHaveLength(1)
    const [{ message, options }] = f.sent
    expect(options).toEqual({ deliverAs: 'aside' })
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
    const { id, dir } = await start(f)
    await finished(dir)
    expect(slept.slice(0, 2)).toEqual([5, 10])
    expect(callsTo('judge-one-r1')).toHaveLength(3)
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'agent-failed', label: 'judge one r1', error: '503 Service Unavailable' }))
    expect(journalOf(dir).filter(e => e.type === 'agent-end' && e.label === 'judge one r1')).toEqual([
      { t: expect.any(String), type: 'agent-end', label: 'judge one r1', session: join(dir, 'sessions/3-judge-one-r1'), outcome: 'failed' },
    ])
    expect(liveRoles(id).find(r => r.info.label === 'judge one r1')?.outcome).toBe('failed')
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
    expect(f.sent[0]!.options).toEqual({ deliverAs: 'aside' })
  })

  it('writes result.json last on success, when status.json is already terminal', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    const statusAtResult: unknown[] = []
    const real = fs.writeFileSync
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: any, data: any, options?: any) => {
      if (String(path).endsWith('result.json')) statusAtResult.push(JSON.parse(readRun(String(path).slice(0, -'/result.json'.length), 'status.json')))
      return real(path, data, options)
    }) as typeof fs.writeFileSync)
    try {
      const { dir } = await start(f)
      await finished(dir)
    } finally {
      spy.mockRestore()
    }
    expect(statusAtResult).toEqual([expect.objectContaining({ status: 'done', finishedAt: expect.any(String) })])
  })

  it('writes result.json with the error when a run fails', async () => {
    process.env.GRANNY_OMP_BIN = join(fake, 'no-such-omp')
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f)
    const result = await finished(dir)
    expect(result).toEqual({ id, status: 'failed', finishedAt: expect.any(String), error: expect.stringContaining('GRANNY_OMP_BIN') })
    expect(result.error).not.toContain('\n    at ')
    expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'failed', finishedAt: result.finishedAt, error: expect.stringContaining('\n    at ') })
  })

  it('writes result.json when a run is cancelled, and sends no message', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const { id, dir } = await start(f)
    await waitFor(() => existsSync(join(fake, 'wait-implement-one.pid')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    const result = await finished(dir)
    expect(result).toEqual({ id, status: 'cancelled', finishedAt: expect.any(String), error: 'cancelled' })
    expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'cancelled', error: 'cancelled' })
    expect(f.sent).toEqual([])
  })

  it('ends a run cancelled during a review as cancelled: no retry, no review-failed, no notice, the waiting granny_wait told', async () => {
    behave({ wait: ['review-one-r1-reviewer'] })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100, renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, u.ctx)
    const reply = wait(f, { runId: id })
    await waitFor(() => existsSync(join(fake, 'wait-review-one-r1-reviewer.pid')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    expect(await reply).toBe(`Run ${id} was cancelled.`)
    expect(await finished(dir)).toEqual({ id, status: 'cancelled', finishedAt: expect.any(String), error: 'cancelled' })
    expect(JSON.parse(readRun(dir, 'status.json')).status).toBe('cancelled')
    expect(f.sent).toEqual([])
    expect(u.widget(`granny-${id}`)).toBeUndefined()
    expect(u.status(`granny-${id}`)).toBe(`granny ${id}: cancelled`)
    const logs = journalOf(dir).filter(e => e.type === 'log').map(e => e.message)
    expect(logs.filter(m => /retrying once|review failed/.test(m))).toEqual([])
    expect(callsTo('review-one-r1-reviewer')).toHaveLength(1)
    expect(calls().map(c => c.slug)).toEqual(['implement-one', 'review-one-r1-reviewer'])
    expect(journalOf(dir).filter(e => e.type === 'agent-end').map(e => [e.label, e.outcome])).toEqual([
      ['implement one', 'done'],
      ['review one r1 reviewer', 'cancelled'],
    ])
    expect(liveRoles(id).map(r => r.outcome)).toEqual(['done', 'cancelled'])
  })

  it('keeps the run\'s outcome when journalling an agent\'s end throws', async () => {
    behave({})
    const real = fs.appendFileSync
    let refused = 0
    const spy = spyOn(fs, 'appendFileSync').mockImplementation(((path: any, data: any, options?: any) => {
      if (String(data).includes('"type":"agent-end"')) {
        refused++
        throw new Error('disk full')
      }
      return real(path, data, options)
    }) as typeof fs.appendFileSync)
    try {
      const f = fakePi()
      await extension(f.pi as any)
      const { id, dir } = await start(f)
      expect((await finished(dir)).stages[0].outcome).toBe('clean')
      expect(refused).toBe(6)
      expect(liveRoles(id).map(r => r.outcome)).toEqual(Array(6).fill('done'))
    } finally {
      spy.mockRestore()
    }
  })

  it('tells the agent to wait with granny_wait or end its turn, never with a watcher of its own', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    writeFileSync(join(repo, 'granny.config.json'), '{}')
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }))
    const id = /granny run (\S+) started/.exec(started)![1]!
    expect(started).toContain(`call granny_wait { runId: "${id}" }`)
    expect(started).toContain('end your turn - the finish message starts a new one')
    expect(started).toContain('Never write your own watcher, sleep or poll loop on the run files')
    expect(started).toContain('granny_status')
    expect(started).toContain('granny_cancel')
    expect(f.tools.get('granny_wait').description).toContain('instead of your own watcher, sleep or poll loop')
    await finished(join(repo, '.granny/runs', id))
  })

  it('tells the agent to point the user at the navigator, and the panel names it, only with watch "full"', async () => {
    behave({ hold: ['implement-one'] })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const full = await start(f, {}, u.ctx)
    const sentence = 'Tell the user: /granny or alt+w opens the run navigator (stages, agents, live activity).'
    expect(full.started).toContain(`\n${sentence}`)
    await waitFor(() => (u.widget(`granny-${full.id}`) ?? []).some(l => l.startsWith('  implement one')))
    expect(u.widget(`granny-${full.id}`)![0]).toMatch(new RegExp(`^granny ${full.id} · \\S.* · \\d+s · /granny or alt\\+w: agents$`))
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(full.dir)
    rmSync(join(fake, 'release-implement-one'))
    const panel = await start(f, { watch: 'panel', maxRounds: 2 }, u.ctx)
    expect(panel.started).not.toContain(sentence)
    await waitFor(() => (u.widget(`granny-${panel.id}`) ?? []).some(l => l.startsWith('  implement one')))
    expect(u.widget(`granny-${panel.id}`)![0]).not.toContain('/granny')
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(panel.dir)
    expect(f.commands.get('granny').description).toContain('stepper')
    expect(f.commands.get('granny').description).toContain('stage groups')
  })

  const wait = (f: ReturnType<typeof fakePi>, params: Record<string, unknown>, signal?: AbortSignal) =>
    f.tools.get('granny_wait').execute('call-w', params, signal, undefined, CTX).then(textOf) as Promise<string>
  const waitsJournalled = (dir: string) => journalOf(dir).filter(e => e.type === 'notified-via-wait')

  it('granny_wait returns the finish summary instead of the notice when the run ends during the wait', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f)
    const [first, second] = await Promise.all([wait(f, { runId: id }), wait(f, { runId: id })])
    expect(first).toContain(`[granny] Run ${id} finished.`)
    expect(first).toContain('- one: clean, 2 review round(s)')
    expect(first).toContain(`Call granny_status with runId "${id}"`)
    expect(second).toBe(first)
    expect(JSON.parse(readRun(dir, 'status.json')).status).toBe('done')
    expect(existsSync(join(dir, 'result.json'))).toBe(true)
    expect(f.sent).toEqual([])
    expect(waitsJournalled(dir)).toEqual([expect.objectContaining({ waits: 2 })])
  })

  it('granny_wait returns at once for a run that has already ended, and the notice went out as before', async () => {
    behave({})
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f)
    await finished(dir)
    expect(f.sent).toHaveLength(1)
    expect(await wait(f, { runId: id })).toBe(f.sent[0]!.message.content)
    expect(waitsJournalled(dir)).toEqual([])
  })

  it('granny_wait returns the failure text when the run fails during the wait, without a second report', async () => {
    process.env.GRANNY_OMP_BIN = join(fake, 'no-such-omp')
    const f = fakePi()
    await extension(f.pi as any)
    const { id, dir } = await start(f)
    const reply = await wait(f, { runId: id })
    expect(reply).toStartWith(`[granny] Run ${id} failed: `)
    expect(reply).toContain('GRANNY_OMP_BIN')
    expect(f.sent.length + waitsJournalled(dir).length).toBe(1)
  })

  it('granny_wait says so when the run is cancelled during the wait', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const { id, dir } = await start(f)
    const reply = wait(f, { runId: id })
    await waitFor(() => existsSync(join(fake, 'wait-implement-one.pid')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    expect(await reply).toBe(`Run ${id} was cancelled.`)
    expect(await wait(f, { runId: id })).toBe(`Run ${id} was cancelled.`)
    expect(waitsJournalled(dir)).toHaveLength(1)
  })

  it('granny_wait times out with the still-running text, clamping the timeout to at least 1 s, and stops counting as a wait', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const { id, dir } = await start(f)
    const begun = performance.now()
    const reply = await wait(f, { runId: id, timeoutSeconds: 0 })
    expect(performance.now() - begun).toBeGreaterThanOrEqual(990)
    expect(reply).toBe(`Run ${id} is still running after 1 s. Call granny_wait again to keep waiting, or end your turn - the finish message will start a new one.`)
    await waitFor(() => existsSync(join(fake, 'wait-implement-one.pid')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    await finished(dir)
    expect(waitsJournalled(dir)).toEqual([])
  })

  it('granny_wait stops on abort and leaves the run going', async () => {
    behave({ wait: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
    const { id, dir } = await start(f)
    const stopped = `Stopped waiting; run ${id} is still running.`
    const pressed = new AbortController()
    pressed.abort()
    expect(await wait(f, { runId: id }, pressed.signal)).toBe(stopped)
    const esc = new AbortController()
    const reply = wait(f, { runId: id }, esc.signal)
    await Bun.sleep(50)
    esc.abort()
    expect(await reply).toBe(stopped)
    expect(JSON.parse(readRun(dir, 'status.json')).status).toBe('running')
    await waitFor(() => existsSync(join(fake, 'wait-implement-one.pid')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    await finished(dir)
    expect(waitsJournalled(dir)).toEqual([])
  })

  describe('granny_judge', () => {
    const MODELS = { reviewers: [{ name: 'reviewer', engine: 'agent', model: { omp: 'prov/review' } }], roles: { judge: { model: { omp: 'prov/tag' } } } }
    const ASK = "Ask the user for these per the skill's references/judge.md and write them to the config. Do not choose a model yourself."
    const configure = (config: unknown) => {
      writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
      git(repo, 'add', 'granny.config.json')
      git(repo, 'commit', '-qm', 'cfg')
    }
    const call = async (f: ReturnType<typeof fakePi>, params: Record<string, unknown> = {}, ctx: unknown = CTX) => textOf(await exec(f.tools.get('granny_judge'), { repo, ...params }, ctx))
    const tool = async () => {
      const f = fakePi()
      await createGrannyExtension({ killGraceMs: 100 })(f.pi as any)
      return f
    }
    const launch = async (f: ReturnType<typeof fakePi>, params: Record<string, unknown> = {}, ctx: unknown = CTX) => {
      const started = await call(f, params, ctx)
      const id = /granny judge run (\S+) started/.exec(started)?.[1]
      if (!id) throw new Error(started)
      return { id, started, dir: join(repo, '.granny/runs', id) }
    }

    it('refuses without config, naming every gap and telling the agent to ask the user, before anything runs', async () => {
      const f = await tool()
      const reply = await call(f)
      expect(reply.split('\n')).toEqual(['granny_judge refused:', '- reviewers: no config sets who reviews', '- roles.judge.model: no model for omp', ASK])
      expect(calls()).toEqual([])
      expect(existsSync(join(repo, '.granny/runs'))).toBe(false)
    })

    it('refuses an agent reviewer with no model for omp', async () => {
      const f = await tool()
      configure({ ...MODELS, reviewers: [{ name: 'kimi', engine: 'agent', model: { opencode: 'a/b' } }] })
      expect((await call(f)).split('\n')).toEqual(['granny_judge refused:', '- reviewers[0] (kimi): no model for omp', ASK])
    })

    it('refuses no judge model for omp', async () => {
      const f = await tool()
      configure({ reviewers: MODELS.reviewers })
      expect((await call(f)).split('\n')).toEqual(['granny_judge refused:', '- roles.judge.model: no model for omp', ASK])
    })

    it('does not let the run\'s own config answer the gate, so the agent cannot pick the models itself', async () => {
      const f = await tool()
      const reply = await call(f, { config: MODELS })
      expect(reply).toStartWith('granny_judge refused:')
      expect(reply).toContain('- reviewers: no config sets who reviews')
      expect(reply).toEndWith(ASK)
    })

    it('still names a gap the run\'s own config opens', async () => {
      const f = await tool()
      configure(MODELS)
      const reply = await call(f, { config: { reviewers: [{ name: 'bare', engine: 'agent' }] } })
      expect(reply.split('\n')).toEqual(['granny_judge refused:', '- reviewers[0] (bare): no model for omp', ASK])
    })

    it('refuses a model omp cannot run, in a reviewer, the judge and the extraction agent', async () => {
      const f = await tool()
      configure({ reviewers: [{ name: 'r', engine: 'agent', model: 'sonnet' }], roles: { judge: { model: 'haiku' }, granny: { model: 'opus' } } })
      const reply = await call(f)
      expect(reply).toStartWith('granny_judge refused:')
      expect(reply).toContain('roles.judge.model: "haiku"')
      expect(reply).toContain('roles.granny.model: "opus"')
      expect(reply).toContain('reviewers[0] "r": model "sonnet"')
      expect(reply).not.toContain(ASK)
      expect(calls()).toEqual([])
    })

    it('does not refuse a bad implementer model, which a judge run never uses', async () => {
      behave({ wait: ['review-feat-x-r1-reviewer'] })
      const f = await tool()
      configure({ ...MODELS, roles: { ...MODELS.roles, implementer: { model: 'sonnet' }, planner: { model: 'opus' } } })
      const { id, dir } = await launch(f)
      await exec(f.tools.get('granny_cancel'), { runId: id })
      await finished(dir)
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
      expect(result.report).toContain('## P0\n\n### Real issue')
      expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'done', branch: 'feat/x', outline: { kind: 'judge', branch: 'feat/x', worktree: false, reviewers: ['reviewer'], stages: [] } })
      for (const c of calls()) expect(c.child.access).toBe('read-only')
      expect(calls().map(c => c.slug)).toEqual(['review-feat-x-r1-reviewer', 'tag-feat-x'])
      expect(calls().find(c => c.slug === 'tag-feat-x').argv).toContain('prov/tag')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(repo, 'branch', '--show-current')).toBe('feat/x')
      expect(git(repo, 'status', '--short')).toBe('')
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
      await waitFor(() => f.sent.length > 0)
      const notice = f.sent[0]!.message.content
      expect(notice).toStartWith(`[granny] Run ${id} finished.\n- report: ${result.reportPath}\n- counts: P0 1, P1 0, P2 0, P3 0, dismissed 0\n`)
      expect(notice).toEndWith('Nothing was fixed or committed. Give the user the report path and the counts; do not fix anything unless they ask.')
    })

    it('names the reviewers and the judge model in the start reply, says nothing will change, and keeps the wait sentence and the overrides', async () => {
      behave({ wait: ['review-feat-x-r1-reviewer'] })
      const f = await tool()
      configure(MODELS)
      const { id, dir, started } = await launch(f, { config: { language: 'Turkish' } })
      expect(started).toContain(`granny judge run ${id} started on ${repo} (feat/x)`)
      expect(started).toContain('main...HEAD by reviewer (agent, prov/review)')
      expect(started).toContain('tagged by prov/tag')
      expect(started).toContain('Nothing will be changed: no fix, commit, push, branch or worktree')
      expect(started).toContain('.granny/reviews/')
      expect(started).toContain(`Journal: ${join(dir, 'journal.jsonl')}`)
      expect(started).toContain(`To wait in this turn, call granny_wait { runId: "${id}" }`)
      expect(started).toContain('\noverrides: language Turkish')
      expect(started).not.toContain('threshold')
      expect(started).not.toContain('reviewers share')
      await exec(f.tools.get('granny_cancel'), { runId: id })
      await finished(dir)
    })

    it('starts on a dirty tree and lists what it did not review', async () => {
      const f = await tool()
      configure(MODELS)
      writeFileSync(join(repo, 'dirty.txt'), 'x')
      const { dir } = await launch(f)
      const result = await finished(dir)
      expect(result.outcome).toBe('reviewed')
      expect(result.uncommitted).toEqual(['dirty.txt'])
      expect(result.report).toContain('- Not reviewed: dirty.txt')
      await waitFor(() => f.sent.length > 0)
      expect(f.sent[0]!.message.content).toContain('- not reviewed, uncommitted: dirty.txt')
      expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('x')
    })

    it('takes placeholders for the optional fields', async () => {
      behave({ wait: ['review-feat-x-r1-reviewer'] })
      const f = await tool()
      configure(MODELS)
      const { id, dir, started } = await launch(f, { base: '', context: '', config: {} })
      expect(started).not.toContain('overrides:')
      await exec(f.tools.get('granny_cancel'), { runId: id })
      await finished(dir)
    })

    it('names a detached HEAD by its short SHA in the views', async () => {
      const f = await tool()
      configure(MODELS)
      git(repo, 'checkout', '-q', '--detach')
      const head = git(repo, 'rev-parse', 'HEAD').slice(0, 8)
      const { dir, started } = await launch(f)
      expect(started).toContain(`(${head})`)
      const result = await finished(dir)
      expect(result.branch).toBe(head)
      expect(JSON.parse(readRun(dir, 'status.json')).outline.branch).toBe(head)
    })

    it('granny_wait returns the report path and counts', async () => {
      behave({ hold: ['tag-feat-x'] })
      const f = await tool()
      configure(MODELS)
      const { id, dir } = await launch(f)
      const waiting = exec(f.tools.get('granny_wait'), { runId: id })
      await waitFor(() => callsTo('tag-feat-x').length > 0)
      writeFileSync(join(fake, 'release-tag-feat-x'), '')
      const reply = textOf(await waiting)
      const result = await finished(dir)
      expect(reply).toContain(`- report: ${result.reportPath}`)
      expect(reply).toContain('- counts: P0 1, P1 0, P2 0, P3 0, dismissed 0')
      expect(f.sent).toEqual([])
    })

    it('granny_cancel stops it, with no report', async () => {
      behave({ wait: ['tag-feat-x'] })
      const f = await tool()
      configure(MODELS)
      const { id, dir } = await launch(f)
      await waitFor(() => callsTo('tag-feat-x').length > 0)
      await exec(f.tools.get('granny_cancel'), { runId: id })
      expect(await finished(dir)).toMatchObject({ status: 'cancelled' })
      expect(JSON.parse(readRun(dir, 'status.json')).status).toBe('cancelled')
      expect(existsSync(join(repo, '.granny/reviews'))).toBe(false)
    })

    it('shows a judge run in granny_status', async () => {
      const f = await tool()
      configure(MODELS)
      const { id, dir } = await launch(f)
      const result = await finished(dir)
      const status = textOf(await exec(f.tools.get('granny_status'), { runId: id }))
      expect(status).toContain('"kind": "judge"')
      expect(status).toContain(result.reportPath)
    })

    it('reports no-changes with no agent and no report', async () => {
      process.env.GRANNY_CONFIG = join(fake, 'config.json')
      writeFileSync(process.env.GRANNY_CONFIG, JSON.stringify(MODELS))
      git(repo, 'checkout', '-q', 'main')
      const f = await tool()
      const { dir } = await launch(f)
      expect(await finished(dir)).toMatchObject({ outcome: 'no-changes', written: false })
      expect(calls()).toEqual([])
      await waitFor(() => f.sent.length > 0)
      expect(f.sent[0]!.message.content).toContain('- no report: main..HEAD has no commits')
    })

    it('reports review-failed when no reviewer ran, with no report', async () => {
      behave({ errors: [{ slug: 'review-feat-x-r1-reviewer', message: 'model not found', times: 9 }, { slug: 'review-feat-x-r1-reviewer-2', message: 'model not found', times: 9 }] })
      const f = await tool()
      configure(MODELS)
      const { dir } = await launch(f)
      expect(await finished(dir)).toMatchObject({ outcome: 'review-failed', written: false })
      expect(existsSync(join(repo, '.granny/reviews'))).toBe(false)
      await waitFor(() => f.sent.length > 0)
      expect(f.sent[0]!.message.content).toContain('- no report: no reviewer ran, also on a retry')
    })

    it('points to the navigator and keeps the outline for it', async () => {
      behave({ wait: ['review-feat-x-r1-reviewer'] })
      const f = await tool()
      configure({ ...MODELS, watch: 'full' })
      const { id, dir, started } = await launch(f)
      expect(started).toContain('/granny or alt+w')
      expect(ompState().runs.get(id).outline.kind).toBe('judge')
      await exec(f.tools.get('granny_cancel'), { runId: id })
      await finished(dir)
    })
  })

  it('granny_wait points to granny_status for a run this process does not know', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    const reply = await wait(f, { runId: 'no-such-run' })
    expect(reply).toContain('No granny run "no-such-run" in this omp process')
    expect(reply).toContain('granny_status({ repo })')
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

  const tui = () => {
    const u = fakeUi()
    return { ...u, ctx: { ...CTX, hasUI: true, ui: u.ui } }
  }

  it('shows a live panel in the TUI - phase, role and model, the running intent, the last tool, the subagents - and granny_status shows it too', async () => {
    const batch = { context: 'c', tasks: [{ name: 'BaselineGates', agent: 'explore', task: 'a' }, { name: 'PublishedContracts', agent: 'explore', task: 'b' }] }
    behave({
      events: {
        'implement-one': [
          { type: 'turn_start' },
          { type: 'tool_execution_start', toolCallId: 't1', toolName: 'task', args: batch },
          { type: 'tool_execution_end', toolCallId: 't1', toolName: 'task', result: {}, isError: false },
          { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'git status --short' } },
          { type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: {} },
          { type: 'tool_execution_start', toolCallId: 't3', toolName: 'read', args: { path: 'plan.md' }, intent: 'Reading the plan' },
        ],
      },
      hold: ['implement-one'],
    })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, u.ctx)
    const key = `granny-${id}`
    await waitFor(() => (u.widget(key) ?? []).some(l => l.includes('running read: Reading the plan')))
    const lines = u.widget(key)!
    expect(lines[0]).toStartWith(`granny ${id} · Implement · `)
    expect(lines[1]).toStartWith('  implement one (implementer) · omp-test/parent-model · running read: Reading the plan ')
    expect(lines[2]).toMatch(/^    last tool: bash: git status --short \(\d+s ago\)$/)
    expect(lines[3]).toBe('    └ task: BaselineGates ✓, PublishedContracts ✓')
    expect(lines).toHaveLength(4)
    expect(u.widgets(key)[0]!.options).toEqual({ placement: 'aboveEditor' })
    expect(u.status(key)).toMatch(new RegExp(`^granny ${id} · Implement · 1 active · \\d+s$`))
    expect(journalOf(dir).filter(e => e.type === 'subagent')).toEqual([expect.objectContaining({ label: 'implement one', agents: ['BaselineGates', 'PublishedContracts'] })])

    for (const params of [{ runId: id }, { repo }]) {
      const status = textOf(await exec(f.tools.get('granny_status'), params))
      expect(status).toContain('live (this omp process):\ngranny ')
      expect(status).toContain('  implement one (implementer) · omp-test/parent-model · running read: Reading the plan ')
    }

    writeFileSync(join(fake, 'release-implement-one'), '')
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    expect(u.widget(key)).toBeUndefined()
    expect(u.status(key)).toBe(`granny ${id}: done`)
    expect(textOf(await exec(f.tools.get('granny_status'), { runId: id }))).not.toContain('live (this omp process)')
  })

  it('shows the thinking heading while a role thinks, and still reads message_end after lines it does not parse', async () => {
    const tail = `,"partial":{"content":[${'{"type":"thinking","thinking":"'.repeat(20_000)}`
    behave({
      events: {
        'implement-one': [
          { type: 'message_start', message: { role: 'assistant', content: [] } },
          { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
          { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '**Comparing auth' } },
          `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"entication options**\\n\\nweighing"}${tail}`,
        ],
        'judge-one-r1': [`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x"}${tail}`, `{"type":"tool_execution_update"${tail}`],
      },
      hold: ['implement-one'],
      errors: [{ slug: 'judge-one-r1', message: '401 Invalid API key', times: 1 }],
    })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, u.ctx)
    const key = `granny-${id}`
    await waitFor(() => (u.widget(key) ?? []).some(l => l.includes('"Comparing authentication options"')))
    expect(u.widget(key)![1]).toMatch(/^  implement one \(implementer\) · omp-test\/parent-model · thinking \d+s · "Comparing authentication options"$/)
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
    expect(journalOf(dir)).toContainEqual(expect.objectContaining({ type: 'provider-error', label: 'judge one r1', error: '401 Invalid API key', transient: false }))
  })

  it('removes the panel and leaves "failed" in the status line when a run fails, and the next run clears that status', async () => {
    process.env.GRANNY_OMP_BIN = join(fake, 'no-such-omp')
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const first = await start(f, {}, u.ctx)
    await finished(first.dir)
    const key = `granny-${first.id}`
    expect(u.widgets(key).length).toBeGreaterThan(1)
    expect(u.widget(key)).toBeUndefined()
    expect(u.status(key)).toBe(`granny ${first.id}: failed`)
    const second = await start(f, { maxRounds: 2 }, u.ctx)
    expect(u.status(key)).toBeUndefined()
    await finished(second.dir)
    expect(u.status(`granny-${second.id}`)).toBe(`granny ${second.id}: failed`)
  })

  it('removes the panel and leaves "cancelled" in the status line when a run is cancelled', async () => {
    behave({ wait: ['implement-one'] })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ killGraceMs: 100, renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, u.ctx)
    await waitFor(() => existsSync(join(fake, 'wait-implement-one.pid')))
    await waitFor(() => (u.widget(`granny-${id}`) ?? []).some(l => l.startsWith('  implement one (implementer)')))
    await exec(f.tools.get('granny_cancel'), { runId: id })
    await finished(dir)
    expect(u.widget(`granny-${id}`)).toBeUndefined()
    expect(u.status(`granny-${id}`)).toBe(`granny ${id}: cancelled`)
  })

  it('makes no UI call when the session has no UI', async () => {
    behave({})
    const u = fakeUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 1 })(f.pi as any)
    const { dir } = await start(f, {}, { ...CTX, hasUI: false, ui: u.ui })
    await finished(dir)
    expect(u.calls).toEqual([])
  })

  const sessionFiles = (dir: string, name: string) =>
    existsSync(join(dir, 'sessions'))
      ? fs.readdirSync(join(dir, 'sessions')).filter(d => existsSync(join(dir, 'sessions', d, name))).map(d => join(dir, 'sessions', d, name))
      : []
  const logOf = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const HUGE = `,"partial":{"content":[{"type":"thinking","thinking":"HUGE${'z'.repeat(50_000)}"}]}`
  const STREAM = [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
    `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"**Reading the plan**\\n"}${HUGE}}`,
    { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'plan.md' }, intent: 'Reading the plan' },
    { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: {} },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Spawning helpers.' }], stopReason: 'toolUse' } },
    { type: 'tool_execution_start', toolCallId: 't2', toolName: 'task', args: { tasks: [{ name: 'BaselineGates' }] } },
    { type: 'tool_execution_end', toolCallId: 't2', toolName: 'task', result: {} },
  ]

  it('writes a condensed events.jsonl next to each role\'s session with watch "full", never the raw stream', async () => {
    behave({ events: { 'implement-one': STREAM } })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { dir } = await start(f, {}, u.ctx)
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    const logs = sessionFiles(dir, 'events.jsonl')
    expect(logs.length).toBe(fs.readdirSync(join(dir, 'sessions')).length)
    const implement = logOf(logs.find(p => p.includes('-implement-one/'))!)
    const kinds = implement.map(e => (e.type === 'state' ? `state:${e.state}` : e.type))
    expect(kinds).toEqual([
      'state:waiting for model',
      'state:thinking',
      'heading',
      'state:running read: Reading the plan',
      'tool',
      'tool-end',
      'state:waiting for model',
      'text',
      'state:running task: BaselineGates',
      'tool',
      'subagents',
      'tool-end',
      'state:waiting for model',
      'exit',
    ])
    expect(implement.find(e => e.type === 'heading').text).toBe('Reading the plan')
    expect(implement.find(e => e.type === 'tool')).toMatchObject({ name: 'read', intent: 'Reading the plan', arg: 'plan.md' })
    expect(implement.find(e => e.type === 'text').text).toBe('Spawning helpers.')
    expect(implement.at(-1)).toMatchObject({ type: 'exit', code: 0 })
    expect(implement.every(e => typeof e.t === 'string' && !Number.isNaN(Date.parse(e.t)))).toBe(true)
    expect(readFileSync(logs.find(p => p.includes('-implement-one/'))!, 'utf8')).not.toContain('HUGE')
    for (const path of logs) expect(logOf(path).at(-1)).toMatchObject({ type: 'exit' })
  })

  it('writes no event log with watch "panel", and still shows the panel', async () => {
    behave({ events: { 'implement-one': STREAM } })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, { watch: 'panel' }, u.ctx)
    await finished(dir)
    expect(sessionFiles(dir, 'submission.json').length).toBeGreaterThan(0)
    expect(sessionFiles(dir, 'events.jsonl')).toEqual([])
    expect(u.widgets(`granny-${id}`).length).toBeGreaterThan(1)
    expect(u.status(`granny-${id}`)).toBe(`granny ${id}: done`)
  })

  it('makes no UI call and writes no event log with watch "off", and the run is the same', async () => {
    behave({ events: { 'implement-one': STREAM } })
    const u = tui()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 1 })(f.pi as any)
    const { id, dir } = await start(f, { watch: 'off' }, u.ctx)
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    expect(u.calls).toEqual([])
    expect(sessionFiles(dir, 'events.jsonl')).toEqual([])
    expect(journalOf(dir).filter(e => e.type === 'subagent')).toEqual([expect.objectContaining({ label: 'implement one', agents: ['BaselineGates'] })])
    await waitFor(() => f.sent.length > 0)
    expect(f.sent[0]!.message.content).toContain(`[granny] Run ${id} finished.`)
  })

  it('journals a failing event log once per role and keeps the run going', async () => {
    behave({ events: { 'implement-one': STREAM } })
    const real = fs.appendFileSync
    const spy = spyOn(fs, 'appendFileSync').mockImplementation(((path: any, data: any, options?: any) => {
      if (String(path).endsWith('events.jsonl')) throw new Error('disk full')
      return real(path, data, options)
    }) as typeof fs.appendFileSync)
    try {
      const f = fakePi()
      await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
      const { dir } = await start(f, {}, tui().ctx)
      expect((await finished(dir)).stages[0].outcome).toBe('clean')
      const failures = journalOf(dir).filter(e => e.type === 'event-log-failed')
      expect(failures.filter(e => e.label === 'implement one')).toEqual([expect.objectContaining({ error: 'disk full', path: expect.stringContaining('-implement-one/events.jsonl') })])
      expect(new Set(failures.map(e => e.label)).size).toBe(failures.length)
    } finally {
      spy.mockRestore()
    }
  })

  const OVERLAY = { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, fullscreen: true, mouseTracking: false } }
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const SESSION = [
    { type: 'title', v: 1, title: 'implement one', updatedAt: at(0), pad: '' },
    { type: 'session', version: 3, id: 'fake-session', timestamp: at(0), cwd: '/work' },
    { type: 'message', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'Implement stage one.' }] } },
    { type: 'message', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'plan.md' }, intent: 'Reading the plan' }], stopReason: 'toolUse' } },
    { type: 'message', timestamp: at(3), message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: '# Plan' }], isError: false } },
    { type: 'message', timestamp: at(4), message: { role: 'assistant', content: [{ type: 'text', text: 'Stage one is implemented.' }], stopReason: 'stop' } },
  ]
  const SUB_SESSION = [
    { type: 'session', version: 3, id: 'sub-session', timestamp: at(5), cwd: '/work' },
    { type: 'message', timestamp: at(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Baseline gates are green.' }], stopReason: 'stop' } },
  ]

  const commandUi = (custom?: (factory: any, options: any) => unknown) => {
    const u = fakeUi()
    const notes: string[] = []
    const selects: unknown[] = []
    const views: Array<{ view: any; options: any; renders: number[]; closed: number }> = []
    const ui = {
      ...u.ui,
      notify: (message: string) => void notes.push(message),
      select: async (...args: unknown[]) => void selects.push(args),
      custom:
        custom ??
        ((factory: any, options: any) =>
          new Promise(resolve => {
            const entry = { view: undefined as any, options, renders: [] as number[], closed: 0 }
            views.push(entry)
            entry.view = factory({ requestRender: () => entry.renders.push(1), terminal: { rows: 40 } }, {}, { matches: () => false }, (value: unknown) => {
              entry.closed++
              resolve(value)
            })
          })),
    }
    return { ...u, ui, notes, selects, views, ctx: { ...CTX, hasUI: true, mode: 'tui', ui } }
  }
  const screen = (view: any, width = 160) => (view.render(width) as string[]).join('\n')
  const press = (view: any, ...keys: string[]) => {
    for (const key of keys) view.handleInput(key)
  }

  it('/granny opens the run navigator full-screen: the stage and its agents, a running agent\'s summary, then its outcome and transcript once it ended, until Esc', async () => {
    behave({
      events: { 'implement-one': STREAM },
      hold: ['implement-one'],
      session: { 'implement-one': SESSION },
      subagentSessions: { 'implement-one': { BaselineGates: SUB_SESSION } },
    })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, c.ctx)
    await waitFor(() => sessionFiles(dir, 'events.jsonl').some(p => readFileSync(p, 'utf8').includes('"subagents"')))

    const opened = f.commands.get('granny').handler('', c.ctx)
    await waitFor(() => c.views.length === 1)
    expect(c.views[0]!.options).toEqual(OVERLAY)
    expect(c.selects).toEqual([])
    const view = c.views[0]!.view
    await waitFor(() => screen(view).includes('task   BaselineGates ✓'), 3000)
    const live = screen(view).split('\n')
    const tree = (lines: string[]) => lines.map(l => l.split(' │ ')[0]!.trimEnd())
    const detail = (lines: string[]) => lines.map(l => (l.includes(' │ ') ? l.slice(l.indexOf(' │ ') + 3).trimEnd() : ''))
    expect(live[0]).toMatch(/^granny · feat\/x · stage 1\/1 · Implement · \d+s +$/)
    expect(live[1]).toStartWith('Worktree ✓ › Implement ● › Review › PR ready')
    expect(tree(live)).toContainEqual(expect.stringMatching(/^ {2}▾ ● 1 one +\d+s$/))
    expect(tree(live)).toContainEqual(expect.stringMatching(/^› {3}● implement +\d+s$/))
    expect(tree(live)).toContain('      └ ● BaselineGates')
    expect(detail(live)).toContainEqual(expect.stringMatching(/^implementer · parent-model · \d+s$/))
    expect(detail(live)).toContainEqual(expect.stringMatching(/^NOW {3}… waiting for model \d+s$/))
    expect(detail(live)).toContainEqual(expect.stringMatching(/^ \d\d:\d\d:\d\d {2}task {3}BaselineGates ✓$/))
    expect(detail(live)).toContainEqual(expect.stringMatching(/^ \d\d:\d\d:\d\d {2}read {3}Reading the plan$/))
    expect(detail(live)).toContain('LAST SAID  "Spawning helpers."')
    expect(live.filter(l => l.includes(id))).toEqual([])
    expect(live.at(-1)!.trimEnd()).toBe('↑↓ move · Enter/→ open · Tab/] next agent · [ prev · Space fold · Esc close')
    expect(live).toHaveLength(40)

    writeFileSync(join(fake, 'release-implement-one'), '')
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    await waitFor(() => /^granny · feat\/x · done · /.test(screen(view)), 3000)
    const ended = screen(view).split('\n')
    expect(tree(ended)).toContainEqual(expect.stringMatching(/^ {2}▾ ✓ 1 one +\d+s$/))
    expect(tree(ended)).toContainEqual(expect.stringMatching(/^› {3}✓ implement +\d+s$/))
    for (const action of ['review r1', 'judge r1', 'fix r1', 'review r2']) expect(tree(ended)).toContainEqual(expect.stringMatching(new RegExp(`^ {4}✓ ${action} +\\d+s$`)))
    expect(tree(ended)).toContainEqual(expect.stringMatching(/^ {2}▸ ✓ PR ready +\d+s$/))
    expect(tree(ended)).toContain('      └ ✓ BaselineGates')
    expect(ended[1]).toStartWith('Worktree ✓ › Implement ✓ › Review ✓ › PR ready ✓')
    expect(detail(ended)).toContainEqual(expect.stringMatching(/^implementer · parent-model · ✓ \d+s$/))
    expect(detail(ended)).toContainEqual(expect.stringMatching(/^NOW {3}✓ done in \d+s$/))

    press(view, '\r', 't')
    await waitFor(() => screen(view).includes('✎ Stage one is implemented.'), 3000)
    const transcript = screen(view)
    expect(transcript).toContain('── session fake-session · /work')
    expect(transcript).toMatch(/\d\d:\d\d:\d\d {2}▸ read: Reading the plan/)
    expect(transcript.split('\n').at(-1)).toStartWith('↑↓ PgUp/PgDn Home/End scroll · f follow (off) · v details · t summary')

    press(view, '\x1b', '\x1b[B')
    await waitFor(() => screen(view).includes('✎ Baseline gates are green.'), 3000)
    expect(screen(view)).toContain('│ BaselineGates · subagent of implement')
    expect(screen(view)).not.toContain('Stage one is implemented.')

    press(view, '\r', '\x1b', '\x1b')
    expect(await opened).toBeUndefined()
    expect(c.views[0]!.closed).toBe(1)
    expect(view.disposed).toBe(true)
  })

  it('/granny <runId> opens the navigator on that run, lists only the runs with watch "full", and a second open while one is open does nothing', async () => {
    behave({ hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    writeFileSync(join(fake, 'release-implement-one'), '')
    const first = await start(f, {}, c.ctx)
    await finished(first.dir)
    const second = await start(f, { watch: 'panel', maxRounds: 2 }, c.ctx)
    await finished(second.dir)
    rmSync(join(fake, 'release-implement-one'))
    const third = await start(f, { maxRounds: 3 }, c.ctx)
    await waitFor(() => existsSync(join(third.dir, 'sessions')))
    const granny = f.commands.get('granny')
    const runRow = (shown: string, run: string, status: string) => new RegExp(`^${shown} [✓●] ${run.slice(-4)} · ${status}`)

    const opened = granny.handler(first.id, c.ctx)
    await waitFor(() => c.views.length === 1)
    const shown = screen(c.views[0]!.view).split('\n')
    expect(shown[0]).toStartWith('granny · feat/x · done · ')
    expect(shown).toContainEqual(expect.stringMatching(runRow(' ', first.id, 'done \\(shown\\)')))
    expect(shown).toContainEqual(expect.stringMatching(runRow(' ', third.id, 'running')))
    expect(shown.filter(l => l.includes(` ${second.id.slice(-4)} · `))).toEqual([])

    await granny.handler('', c.ctx)
    await granny.handler(third.id, c.ctx)
    expect(c.views).toHaveLength(1)
    expect(c.notes).toEqual([])

    press(c.views[0]!.view, 'q')
    await opened
    const reopened = granny.handler('', c.ctx)
    await waitFor(() => c.views.length === 2)
    const again = screen(c.views[1]!.view).split('\n')
    expect(again[0]).toStartWith('granny · feat/x · stage 1/1 · ')
    expect(again).toContainEqual(expect.stringMatching(runRow(' ', third.id, 'running \\(shown\\)')))
    press(c.views[1]!.view, 'q')
    await reopened
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(third.dir)
  })

  it('/granny off hides the panel for this session and /granny on shows it again', async () => {
    behave({ events: { 'implement-one': STREAM }, hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, c.ctx)
    const key = `granny-${id}`
    await waitFor(() => (c.widget(key) ?? []).some(l => l.includes('implement one')))
    const granny = f.commands.get('granny')
    try {
      await granny.handler('off', c.ctx)
      expect(c.widget(key)).toBeUndefined()
      expect(c.status(key)).toBeUndefined()
      expect(c.notes.at(-1)).toContain('/granny on')
      const drawn = c.widgets(key).length
      await Bun.sleep(100)
      expect(c.widgets(key)).toHaveLength(drawn)
    } finally {
      await granny.handler('on', c.ctx)
    }
    await waitFor(() => (c.widget(key) ?? []).some(l => l.includes('implement one')))
    expect(c.status(key)).toStartWith(`granny ${id} · `)
    expect(c.views).toEqual([])
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
    expect(c.status(key)).toBe(`granny ${id}: done`)
  })

  it('/granny and alt+w say watching is off for a run with watch "panel", and how to turn it on; /granny names an unknown run and the lack of any run', async () => {
    behave({ hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    await f.commands.get('granny').handler('', c.ctx)
    expect(c.notes.at(-1)).toBe('granny: no granny run in this omp process yet.')
    const { id, dir } = await start(f, { watch: 'panel' }, c.ctx)
    await waitFor(() => existsSync(join(dir, 'sessions')))
    const off = `granny: watching is off for run ${id} (watch: "panel") - set "watch": "full" in granny.config.json or the run's config to log each role and watch it with /granny.`
    await f.commands.get('granny').handler('', c.ctx)
    expect(c.notes.at(-1)).toBe(off)
    c.notes.length = 0
    expect(f.shortcuts.get('alt+w').handler(c.ctx)).toBeUndefined()
    await waitFor(() => c.notes.length > 0)
    expect(c.notes).toEqual([off])
    await f.commands.get('granny').handler('no-such-run', c.ctx)
    expect(c.notes.at(-1)).toBe('granny: no run "no-such-run" in this omp process - /granny watches the runs started here.')
    expect(c.views).toEqual([])
    expect(c.selects).toEqual([])
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
  })

  it('/granny prints the event log paths without a UI', async () => {
    behave({ hold: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, { ...CTX, hasUI: false })
    await waitFor(() => existsSync(join(fake, 'calls.jsonl')))
    await f.commands.get('granny').handler('', { ...CTX, hasUI: false, mode: 'print', ui: {} })
    const printed = f.sent.at(-1)!
    expect(printed.options).toEqual({ triggerTurn: false })
    expect(printed.message).toMatchObject({ customType: 'granny-workflow', display: true })
    expect(printed.message.content).toBe(`granny run ${id} - event log per role:\n  implement one (implementer): ${join(dir, 'sessions', fs.readdirSync(join(dir, 'sessions'))[0]!, 'events.jsonl')}`)
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
  })

  it('registers alt+w in parent mode, which opens the navigator in the TUI, once at a time', async () => {
    behave({ hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    expect([...f.shortcuts.keys()]).toEqual(['alt+w'])
    expect(f.shortcuts.get('alt+w').description).toBe('granny-workflow: open the run navigator')
    const { id, dir } = await start(f, {}, c.ctx)
    await waitFor(() => existsSync(join(dir, 'sessions')))
    const handler = f.shortcuts.get('alt+w').handler
    expect(handler(c.ctx)).toBeUndefined()
    await waitFor(() => c.views.length === 1)
    expect(c.views[0]!.options).toEqual(OVERLAY)
    expect(screen(c.views[0]!.view).split('\n')[0]).toStartWith('granny · feat/x · ')
    press(c.views[0]!.view, '\x1b[F')
    expect(screen(c.views[0]!.view)).toContain(`│ run ${id}`)
    handler(c.ctx)
    await Bun.sleep(50)
    expect(c.views).toHaveLength(1)
    press(c.views[0]!.view, 'q')
    await waitFor(() => c.views[0]!.closed === 1)
    handler(c.ctx)
    await waitFor(() => c.views.length === 2)
    press(c.views[1]!.view, 'q')
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
  })

  it('swallows a ui.custom that throws or rejects when alt+w opens the navigator, disposes a navigator it built, and the run finishes', async () => {
    behave({ hold: ['implement-one'] })
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    let calls = 0
    const throwing = commandUi(() => {
      calls++
      throw new Error('stale tui')
    })
    const built: any[] = []
    const rejecting = commandUi(async (factory: any) => {
      calls++
      built.push(factory({ requestRender: () => {}, terminal: { rows: 40 } }, {}, { matches: () => false }, () => {}))
      throw new Error('overlay refused')
    })
    const { id, dir } = await start(f, {}, throwing.ctx)
    await waitFor(() => existsSync(join(dir, 'sessions')))
    const handler = f.shortcuts.get('alt+w').handler
    expect(handler(throwing.ctx)).toBeUndefined()
    expect(handler(rejecting.ctx)).toBeUndefined()
    await waitFor(() => calls === 2)
    await Bun.sleep(20)
    expect(handler(rejecting.ctx)).toBeUndefined()
    await waitFor(() => calls === 3)
    await waitFor(() => built.length === 2 && built.every(v => v.disposed))
    writeFileSync(join(fake, 'release-implement-one'), '')
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    await waitFor(() => f.sent.length > 0)
    expect(f.sent[0]!.message.content).toContain(`[granny] Run ${id} finished.`)
  })
  it('keeps the run going when the UI throws', async () => {
    behave({})
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 1 })(f.pi as any)
    let thrown = 0
    const fail = () => {
      thrown++
      throw new Error('stale ui')
    }
    const { id, dir } = await start(f, {}, { ...CTX, hasUI: true, ui: { setWidget: fail, setStatus: fail } })
    expect((await finished(dir)).stages[0].outcome).toBe('clean')
    expect(thrown).toBeGreaterThan(2)
    await waitFor(() => f.sent.length > 0)
    expect(f.sent[0]!.message.content).toContain(`[granny] Run ${id} finished.`)
  })
})
