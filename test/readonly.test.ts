import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeCodeHost } from '../src/adapters/claude-code/host'
import { commandProblem, guard, READ_ONLY_AGENT } from '../src/adapters/claude-code/readonly'
import { resolveConfig } from '../src/core/config'
import type { AgentRequest, Role } from '../src/core/types'

const root = join(import.meta.dir, '..')
const engine = join(root, 'skills/granny-workflow/engines/claude-code')

function request(role: Role, access: AgentRequest['access']): AgentRequest {
  return { role, kind: 'findings', label: `${role} x`, phase: 'Review', prompt: 'PROMPT', schema: { type: 'object', properties: {} }, access, cwd: '/r' }
}

function hostWith(config: unknown) {
  const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = []
  const host = claudeCodeHost({
    agent: async (prompt, opts) => {
      calls.push({ prompt, opts })
      return null
    },
    log: () => {},
    phase: () => {},
    args: { repo: '/r', branch: 'b', stages: [{ name: 'one' }], config } as any,
  })
  return { host, calls }
}

describe('readOnlyAgent config', () => {
  it('is off by default and takes only a boolean', () => {
    expect(resolveConfig([]).readOnlyAgent).toBe(false)
    expect(resolveConfig([{ readOnlyAgent: true }]).readOnlyAgent).toBe(true)
    expect(() => resolveConfig([{ readOnlyAgent: 'yes' }])).toThrow('readOnlyAgent must be a boolean')
  })
})

describe('Claude Code adapter with readOnlyAgent', () => {
  it('runs the agent reviewer, the judge and the extraction agent as the granny-readonly agent type', async () => {
    const { host, calls } = hostWith([{ readOnlyAgent: true }])
    for (const role of ['reviewer', 'judge', 'granny'] as const) await host.agent(request(role, 'read-only'))
    expect(calls.map(c => c.opts.agentType)).toEqual([READ_ONLY_AGENT, READ_ONLY_AGENT, READ_ONLY_AGENT])
    for (const c of calls) {
      expect(c.prompt.startsWith('READ-ONLY ROLE')).toBe(true)
      expect(c.prompt).toContain('git diff, git log, git show, git blame, git status')
      expect(c.prompt.endsWith('PROMPT')).toBe(true)
    }
  })

  it('leaves write roles and the review-command helpers on the default agent', async () => {
    const { host, calls } = hostWith([{ readOnlyAgent: true }])
    for (const role of ['implementer', 'planner', 'helper', 'granny'] as const) await host.agent(request(role, 'write'))
    await host.agent(request('helper', 'read-only'))
    expect(calls.map(c => c.opts.agentType)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(calls.map(c => 'agentType' in c.opts)).toEqual([false, false, false, false, false])
    expect(calls[4]!.prompt).toBe('READ-ONLY ROLE: do not edit, create, stage or commit any file.\n\nPROMPT')
  })

  it('passes no agent type when the flag is off', async () => {
    const { host, calls } = hostWith([{}])
    for (const role of ['reviewer', 'judge', 'granny'] as const) await host.agent(request(role, 'read-only'))
    expect(calls.every(c => !('agentType' in c.opts))).toBe(true)
    expect(calls.every(c => c.prompt === 'READ-ONLY ROLE: do not edit, create, stage or commit any file.\n\nPROMPT')).toBe(true)
  })
})

describe('read-only command check', () => {
  const allowed = [
    "cd '/r-worktrees/feat-x' && git diff 'abc123'...HEAD",
    "cd '/r' && git log --oneline 'abc123'..HEAD",
    'git status --short',
    'git branch --show-current',
    'git --no-pager -C /r show HEAD:src/a.ts 2>/dev/null',
    'git blame -L 10,20 src/a.ts',
    'git rev-parse HEAD',
    'git merge-base main HEAD',
    'git ls-files src',
    'git diff --stat main...HEAD | head -50',
    "sed -n '10,40p' src/a.ts",
    'sed -n 1,5p src/a.ts',
    'grep -n "foo bar" src/a.ts | wc -l',
    'cat src/a.ts',
    'ls -la src',
    'tail -n 20 CHANGELOG.md',
    'pwd',
    "find src -name '*.ts' -newer package.json",
    'git log -p -- src/a.ts 2>&1 | head',
  ]
  for (const command of allowed) {
    it(`allows ${command}`, () => expect(commandProblem(command)).toBeUndefined())
  }

  const blocked = [
    'git commit -m x',
    'git add src/a.ts',
    'git reset --hard HEAD~1',
    'git checkout main',
    'git merge feat',
    'git rebase main',
    'git push',
    'git stash',
    'git branch -D feat',
    'git -c core.pager=sh log',
    'git diff --output=/tmp/x',
    'git log --output /tmp/x',
    "cd '/r' && git commit -am x",
    'git log && git commit -m x',
    'ls; rm -rf src',
    'echo hi > a.txt',
    'cat a.txt >> b.txt',
    'git diff > out.patch',
    'git log | tee log.txt',
    "sed -i 's/a/b/' src/a.ts",
    "sed -n 'w out.txt' src/a.ts",
    "sed -n '1p;w out' src/a.ts",
    "sed 's/a/b/' src/a.ts",
    'rm a.txt',
    'touch a.txt',
    'find . -name "*.ts" -delete',
    "find . -exec rm {} +",
    'find . -fprint out.txt',
    'bun test',
    'cat $(git commit -m x)',
    'cat `rm a`',
    'cat "$HOME/.ssh/id_rsa"',
    'X=1 git log',
    '(git commit -m x)',
    'cat <<EOF > a.txt',
    'git log & git commit',
    'ls\nrm a.txt',
    '',
  ]
  for (const command of blocked) {
    it(`blocks ${JSON.stringify(command)}`, () => expect(commandProblem(command)).toBeString())
  }
})

describe('read-only guard', () => {
  const bash = (command: string, agent_type?: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(agent_type && { agent_type }) })

  it('blocks a state-changing command for the granny-readonly agent type, also from a plugin', () => {
    expect(guard(bash('git commit -m x', 'granny-readonly'))).toContain('git commit -m x')
    expect(guard(bash('git commit -m x', 'granny:granny-readonly'))).toBeString()
    expect(guard(bash("cd '/r' && git diff abc...HEAD", 'granny-readonly'))).toBeUndefined()
  })

  it('blocks the write tools for the granny-readonly agent type and lets the read tools through', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(guard({ tool_name: tool, tool_input: { file_path: '/r/a.ts' }, agent_type: 'granny-readonly' })).toBeString()
    }
    for (const tool of ['Read', 'Grep', 'Glob', 'StructuredOutput']) {
      expect(guard({ tool_name: tool, tool_input: {}, agent_type: 'granny-readonly' })).toBeUndefined()
    }
  })

  it('leaves other agent types and the main session alone', () => {
    expect(guard(bash('git commit -m x', 'general-purpose'))).toBeUndefined()
    expect(guard(bash('git commit -m x', 'granny-readonly-extra'))).toBeUndefined()
    expect(guard(bash('git commit -m x'))).toBeUndefined()
    expect(guard({ tool_name: 'Write', tool_input: {} })).toBeUndefined()
    expect(guard('not an object')).toBeUndefined()
  })
})

describe('shipped Claude Code read-only files', () => {
  const hook = join(engine, 'hooks/granny-readonly-guard.mjs')
  const runHook = (input: string) => {
    const r = Bun.spawnSync([Bun.which('node') ?? process.execPath, hook], { stdin: Buffer.from(input) })
    return { code: r.exitCode, stderr: r.stderr.toString() }
  }

  it('the hook script exits 2 with the reason on stderr for a blocked command and 0 otherwise', () => {
    const blocked = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, agent_type: 'granny-readonly' }))
    expect(blocked.code).toBe(2)
    expect(blocked.stderr).toContain('git commit -m x')
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log --oneline' }, agent_type: 'granny-readonly' }))).toEqual({ code: 0, stderr: '' })
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, agent_type: 'general-purpose' }))).toEqual({ code: 0, stderr: '' })
    expect(runHook('not json')).toEqual({ code: 0, stderr: '' })
  })

  it('the agent definition is granny-readonly with Read, Grep, Glob and Bash only', () => {
    const md = readFileSync(join(engine, 'agents/granny-readonly.md'), 'utf8')
    const front = md.slice(4, md.indexOf('\n---\n', 4))
    expect(front).toContain(`name: ${READ_ONLY_AGENT}`)
    expect(front.match(/^tools: (.*)$/m)?.[1]).toBe('Read, Grep, Glob, Bash')
    expect(front).not.toMatch(/^model:/m)
  })
})
