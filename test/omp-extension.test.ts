import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extension, { blockReason, createGrannyExtension, isTransient, waitSeconds } from '../src/adapters/omp/extension'
import { lineType, LiveRun, type LogEntry, PARSED_EVENTS, type RoleActivity } from '../src/adapters/omp/panel'
import { EventLog } from '../src/adapters/omp/watch'
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
  const handlers: Array<[string, any]> = []
  const sent: Array<{ message: any; options: any }> = []
  const pi = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (event: string, handler: any) => handlers.push([event, handler]),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  }
  return { pi, tools, commands, handlers, sent }
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
    const role = live.role({ label: 'plan', role: 'planner', model: 'openai/gpt', effort: 'max' })
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
    const role = live.role({ label: 'plan', role: 'planner' })
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
    const role = live.role({ label: 'judge', role: 'judge' })
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
    const role = live.role({ label: 'plan', role: 'planner' })
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
    const role = live.role({ label: 'implement one', role: 'implementer', model: 'm' })
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
      const role = live.role({ label: `review one r1 reviewer${i}`, role: 'reviewer' })
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
    const role = live.role({ label: 'judge one r1', role: 'judge' })
    live.start(role)
    live.setPhase('Review')
    expect(live.lines()[0]).toBe('granny r4 · Review · 0s')
    live.stop(role)
    expect(live.lines()).toEqual(['granny r4 · Review · 0s', '  no role process running'])
    live.close('done')()
  })
})

describe('role event log', () => {
  it('condenses a role\'s stream into state, heading, tool, tool-end, text, subagents and exit entries', () => {
    const entries: LogEntry[] = []
    const live = new LiveRun('r1', undefined, { now: () => 0, renderEveryMs: 1000 })
    const role = live.role({ label: 'plan', role: 'planner' }, entry => void entries.push(entry))
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
      { type: 'tool', name: 'read', intent: 'Reading the plan', arg: 'plan.md' },
      { type: 'tool-end', name: 'read' },
      { type: 'state', state: 'waiting for model' },
    ])
    expect(entries[8]).toEqual({ type: 'tool', name: 'bash', arg: `echo ${'a'.repeat(194)}…` })
    expect(entries[9]).toEqual({ type: 'tool-end', name: 'bash', error: true })
    const text = entries.find(e => e.type === 'text') as { text: string }
    expect(text.text).toStartWith('Done. www')
    expect(text.text).toHaveLength(4000)
    expect(entries.at(-2)).toEqual({ type: 'subagents', agents: ['BaselineGates', 'explore'] })
    expect(entries.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect(JSON.stringify(entries)).not.toContain('HUGE')
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
    const role = live.role({ label: 'plan', role: 'planner' }, e => void (e.type === 'heading' && headings.push(e.text)))
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

  async function start(f: ReturnType<typeof fakePi>, config: Record<string, unknown> = {}, ctx: unknown = CTX) {
    writeFileSync(join(repo, 'granny.config.json'), JSON.stringify(config))
    git(repo, 'add', 'granny.config.json')
    git(repo, 'commit', '-qm', 'cfg')
    const started = textOf(await exec(f.tools.get('granny_run'), { repo, branch: 'feat/x', stages: [{ name: 'one', task: 'Do it.' }] }, ctx))
    const id = /granny run (\S+) started/.exec(started)?.[1]
    if (!id) throw new Error(started)
    return { id, dir: join(repo, '.granny/runs', id) }
  }

  it('registers granny_run, granny_status, granny_wait and granny_cancel as essential tools, and no submit tool', async () => {
    const f = fakePi()
    await extension(f.pi as any)
    expect([...f.tools.keys()].sort()).toEqual(['granny_cancel', 'granny_run', 'granny_status', 'granny_wait'])
    expect(f.tools.get('granny_wait').parameters.required).toEqual(['runId'])
    expect(f.tools.get('granny_wait').interruptible).toBe(true)
    for (const name of ['granny_run', 'granny_status', 'granny_cancel']) expect(f.tools.get(name).interruptible).toBeUndefined()
    for (const tool of f.tools.values()) {
      expect(tool.loadMode).toBe('essential')
      expect(tool.label).toBeString()
    }
    expect(f.tools.get('granny_run').parameters.required).toEqual(['repo', 'branch'])
    expect(f.handlers).toEqual([])
    expect([...f.commands.keys()]).toEqual(['granny'])
    expect(f.commands.get('granny').description).toContain('watch')
    expect(f.commands.get('granny').getArgumentCompletions('o').map((i: any) => i.value)).toEqual(['off', 'on'])
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
    expect(JSON.parse(readRun(dir, 'status.json'))).toMatchObject({ status: 'failed', finishedAt: result.finishedAt })
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
    expect(JSON.parse(readRun(dir, 'status.json')).status).toBe('cancelled')
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

  const commandUi = () => {
    const u = fakeUi()
    const notes: string[] = []
    const selects: Array<{ title: string; options: Array<{ label: string; description?: string }> }> = []
    const views: Array<{ view: any; options: any; renders: number[] }> = []
    const ui = {
      ...u.ui,
      notify: (message: string) => void notes.push(message),
      select: async (title: string, options: any[]) => {
        selects.push({ title, options })
        return options.find(o => o.label.includes('implement one'))?.label
      },
      custom: (factory: any, options: any) =>
        new Promise(resolve => {
          const renders: number[] = []
          const view = factory({ requestRender: () => renders.push(1) }, {}, { matches: () => false }, resolve)
          views.push({ view, options, renders })
        }),
    }
    return { ...u, ui, notes, selects, views, ctx: { ...CTX, hasUI: true, mode: 'tui', ui } }
  }

  it('/granny lists the roles of the latest run and opens a role\'s event log live in an overlay until Esc', async () => {
    behave({ events: { 'implement-one': STREAM }, hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, {}, c.ctx)
    await waitFor(() => sessionFiles(dir, 'events.jsonl').some(p => readFileSync(p, 'utf8').includes('"subagents"')))
    const granny = f.commands.get('granny')

    const opened = granny.handler('', c.ctx)
    await waitFor(() => c.views.length === 1)
    expect(c.selects[0]!.title).toContain(`granny ${id}`)
    expect(c.selects[0]!.options).toEqual([{ label: '1. implement one (implementer)', description: expect.stringMatching(/^omp-test\/parent-model · waiting for model \d+s · \d+s$/) }])
    expect(c.views[0]!.options).toEqual({ overlay: true })
    const view = c.views[0]!.view
    const lines: string[] = view.render(100)
    expect(lines[0]).toMatch(new RegExp(`^granny ${id} · implement one \\(implementer\\) · waiting for model$`))
    const body = lines.join('\n')
    expect(body).toMatch(/\d\d:\d\d:\d\d  · thinking/)
    expect(body).toContain('  » Reading the plan')
    expect(body).toContain('  ▸ read: Reading the plan (plan.md)')
    expect(body).toContain('  ✎ answer:\n')
    expect(body).toContain('          Spawning helpers.')
    expect(body).toContain('  └ task: BaselineGates')
    expect(body).not.toContain('running read')
    expect(body).not.toContain('process exited')
    expect(lines.at(-1)).toBe('Esc closes')
    expect(view.render(20).every((l: string) => l.length <= 20)).toBe(true)

    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
    await waitFor(() => c.views[0]!.renders.length > 0, 3000)
    expect(view.render(100).join('\n')).toMatch(/■ process exited 0/)
    view.handleInput('x')
    view.handleInput('\x1b')
    expect(await opened).toBeUndefined()

    const again = granny.handler(id, c.ctx)
    await waitFor(() => c.views.length === 2)
    const roles = c.selects[1]!.options
    expect(roles.length).toBe(fs.readdirSync(join(dir, 'sessions')).length)
    expect(roles.every(o => / · done · \d+s$/.test(o.description!))).toBe(true)
    c.views[1]!.view.handleInput('q')
    await again
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
    writeFileSync(join(fake, 'release-implement-one'), '')
    await finished(dir)
    expect(c.status(key)).toBe(`granny ${id}: done`)
  })

  it('/granny says watching is off for a run with watch "panel", and how to turn it on', async () => {
    behave({ hold: ['implement-one'] })
    const c = commandUi()
    const f = fakePi()
    await createGrannyExtension({ renderEveryMs: 10 })(f.pi as any)
    const { id, dir } = await start(f, { watch: 'panel' }, c.ctx)
    await waitFor(() => existsSync(join(dir, 'sessions')))
    await f.commands.get('granny').handler('', c.ctx)
    expect(c.notes.at(-1)).toBe(`granny: watching is off for run ${id} (watch: "panel") - set "watch": "full" in granny.config.json or the run's config to log each role and watch it with /granny.`)
    expect(c.selects).toEqual([])
    await f.commands.get('granny').handler('no-such-run', c.ctx)
    expect(c.notes.at(-1)).toBe('granny: no run "no-such-run" in this omp process - /granny watches the runs started here.')
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
