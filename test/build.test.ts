import { describe, expect, it, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { buildClaudeCode, buildOmp, CLAUDE_CODE_SCRIPTS, buildOpencode, buildOpencodeTui, buildPrComments, buildReadOnlyGuard } from '../scripts/build'
import { CODEX_REVIEWER, finding, review } from './fake-host'

const root = join(import.meta.dir, '..')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

function loadWorkflow(script: string) {
  expect(script.startsWith('export const meta = {')).toBe(true)
  const body = script.replace(/^export const meta/, 'const meta')
  return new AsyncFunction('agent', 'log', 'phase', 'args', 'parallel', 'pipeline', 'budget', 'workflow', body)
}

describe('claude-code Workflow scripts', () => {
  for (const name of CLAUDE_CODE_SCRIPTS) {
    it(`${name}.js is committed in sync with src/`, async () => {
      const built = await buildClaudeCode(name)
      expect(readFileSync(join(root, `skills/granny-workflow/engines/claude-code/${name}.js`), 'utf8')).toBe(built)
    })

    it(`${name}.js starts with a pure-literal meta and avoids APIs the Workflow sandbox forbids`, async () => {
      const script = await buildClaudeCode(name)
      const meta = script.slice(0, script.indexOf('\n}\n') + 2)
      expect(meta).not.toMatch(/\$\{|\.\.\.|\w\(/)
      for (const banned of ['Date.now(', 'Math.random(', 'new Date(', 'require(']) expect(script).not.toContain(banned)
    })
  }

  it('bundles no implement loop into judge.js', async () => {
    expect(await buildClaudeCode('judge')).not.toContain('async function runGranny(')
  })
})

describe('claude-code workflow.js', () => {
  it('runs the whole loop against the Workflow agent() API', async () => {
    const script = await buildClaudeCode('workflow')
    const calls: Array<{ prompt: string; opts: any }> = []
    const logs: string[] = []
    const phases: string[] = []
    let reviews = 0
    const agent = async (prompt: string, opts: any) => {
      calls.push({ prompt, opts })
      const kind = Object.keys(opts.schema.properties).join(',')
      if (opts.label === 'worktree') return { ran: true, exitCode: 0, output: "Preparing worktree (new branch 'feat/x')\n[granny] worktree: /r-worktrees/feat-x\n" }
      if (kind.startsWith('startSha')) return { startSha: 's1', headSha: 'h1', gatesGreen: true, gates: 'ok', commits: ['c'], untested: '' }
      if (kind.startsWith('ran') && prompt.includes('git rev-parse --verify HEAD')) return { ran: true, exitCode: 0, output: 's1\n' }
      if (kind.startsWith('ran') && prompt.includes('git rev-list --count')) return { ran: true, exitCode: 0, output: '1\n' }
      if (kind.startsWith('ran') && prompt.includes('git status --porcelain')) return { ran: true, exitCode: 0, output: '' }
      if (kind.startsWith('ran') && prompt.includes('nohup bash -c')) return { ran: true, exitCode: 0, output: 'started\n' }
      if (kind.startsWith('ran') && / wait \d+$/.test(opts.label)) return { ran: true, exitCode: 0, output: 'done\n' }
      if (kind.startsWith('ran')) {
        reviews++
        return { ran: true, exitCode: 0, output: reviews === 1 ? review(finding('P2', 'Off by one')) : 'No findings.' }
      }
      if (kind.startsWith('perFinding')) {
        return { perFinding: [{ id: 'codex-F1', verdict: 'confirmed', impact: 'moderate', likelihood: 'common', fixCost: 'trivial', scope: 'in-scope', evidence: 'src/a.ts:1 - off by one', reason: 'real' }], rationale: 'ok' }
      }
      if (kind.startsWith('gatesGreen')) return { gatesGreen: true, gates: 'ok', commits: ['c'], prBodyPath: '.granny/PR-BODY.md', issues: '' }
      throw new Error(`unexpected schema ${kind}`)
    }
    const run = loadWorkflow(script)
    const result = await run(agent, (m: string) => logs.push(m), (t: string) => phases.push(t), {
      repo: '/r',
      branch: 'feat/x',
      stages: [{ name: 'one', task: 'Do it.' }],
      config: [CODEX_REVIEWER, { roles: { implementer: { model: 'opus', effort: 'high' } } }, { threshold: 80 }],
    })
    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean', rounds: 2 })
    expect(result.base).toBe('main')
    expect(result.worktree).toBe('/r-worktrees/feat-x')
    expect(phases).toEqual(['Worktree', 'Implement', 'Review', 'PR ready'])
    const setup = calls[0]!
    expect(setup.opts).toMatchObject({ label: 'worktree', phase: 'Worktree', model: 'haiku', effort: 'low' })
    expect(setup.prompt.startsWith('READ-ONLY ROLE')).toBe(false)
    expect(setup.prompt).toContain('\n( cd /r && ex="$(git rev-parse --git-common-dir)/info/exclude"')
    expect(setup.prompt).toContain(' ) 2>&1; echo "[granny] exit=$?"\n')
    expect(setup.prompt).toContain('wt=/r-worktrees/feat-x;')
    expect(calls[1]!.opts).toMatchObject({ label: 'head one', phase: 'Implement', model: 'haiku', effort: 'low' })
    expect(calls[1]!.prompt).toContain('\n( cd /r-worktrees/feat-x && git rev-parse --verify HEAD ) 2>&1; echo "[granny] exit=$?"\n')
    const impl = calls[2]!
    expect(impl.opts).toMatchObject({ label: 'implement one', phase: 'Implement', model: 'opus', effort: 'high' })
    expect(impl.prompt).toContain('Working repo: /r-worktrees/feat-x, branch `feat/x`')
    const runner = calls.find(c => c.opts.label === 'review one r1 codex')!
    expect(runner.prompt).toContain('\n( cd /r-worktrees/feat-x && if [ -s .granny/review-one-r1-codex.pid ]')
    expect(calls.filter(c => c.opts.label.startsWith('review one r1 codex')).map(c => c.opts.label)).toEqual(['review one r1 codex', 'review one r1 codex wait 1', 'review one r1 codex read'])
    expect(runner.prompt.startsWith('READ-ONLY ROLE')).toBe(true)
    expect(runner.opts).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(calls.find(c => c.opts.label === 'pr-ready check')!.opts.model).toBeUndefined()
    const judge = calls.find(c => c.opts.label === 'judge one r1')!
    expect(judge.opts.model).toBe('haiku')
    expect(calls.some(c => c.opts.label === 'fix one r1' && c.prompt.includes('Off by one'))).toBe(true)
    expect(logs.some(l => l.includes('one r1: to the implementer: codex-F1 (rule 7: priority 90 > threshold 80 (moderate/common/trivial))'))).toBe(true)
  })

  it('declares the Plan review phase and reviews and fixes a plan through the Workflow agent() API', async () => {
    const script = await buildClaudeCode('workflow')
    const meta = script.slice(0, script.indexOf('\n}\n') + 2)
    expect(meta).toContain("{ title: 'Worktree' },\n    { title: 'Plan review' },\n    { title: 'Implement' },")
    const calls: Array<{ prompt: string; opts: any }> = []
    const phases: string[] = []
    let reviews = 0
    const agent = async (prompt: string, opts: any) => {
      calls.push({ prompt, opts })
      const kind = Object.keys(opts.schema.properties).join(',')
      if (opts.label === 'worktree') return { ran: true, exitCode: 0, output: '[granny] worktree: /r-worktrees/feat-x\n' }
      if (kind.startsWith('files')) return { files: ['/plans/v1.md'], changes: 'codex-F1: added the migration step' }
      if (kind.startsWith('startSha')) return { startSha: 's1', headSha: 'h1', gatesGreen: true, gates: 'ok', commits: ['c'], untested: '' }
      if (kind.startsWith('ran') && prompt.includes('git rev-parse --verify HEAD')) return { ran: true, exitCode: 0, output: 's1\n' }
      if (kind.startsWith('ran') && prompt.includes('git rev-list --count')) return { ran: true, exitCode: 0, output: '1\n' }
      if (kind.startsWith('ran') && prompt.includes('git status --porcelain')) return { ran: true, exitCode: 0, output: '' }
      if (kind.startsWith('ran') && prompt.includes('nohup bash -c')) return { ran: true, exitCode: 0, output: 'started\n' }
      if (kind.startsWith('ran') && / wait \d+$/.test(opts.label)) return { ran: true, exitCode: 0, output: 'done\n' }
      if (kind.startsWith('ran')) {
        reviews++
        return { ran: true, exitCode: 0, output: reviews === 1 ? review(finding('P1', 'Missing migration step', '/plans/v1.md', 4)) : 'No findings.' }
      }
      if (kind.startsWith('gatesGreen')) return { gatesGreen: true, gates: 'ok', commits: ['c'], prBodyPath: '.granny/PR-BODY.md', issues: '' }
      throw new Error(`unexpected schema ${kind}`)
    }
    const run = loadWorkflow(script)
    const result = await run(agent, () => {}, (t: string) => phases.push(t), {
      repo: '/r',
      branch: 'feat/x',
      plan: '/plans/v1.md',
      stages: [{ name: 'one', task: 'Do it.' }],
      config: [CODEX_REVIEWER, { planReview: true }],
    })
    expect(result.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean' })
    expect(phases).toEqual(['Worktree', 'Plan review', 'Implement', 'Review', 'PR ready'])
    const runner = calls.find(c => c.opts.label === 'review plan review r1 codex')!
    expect(runner.opts.phase).toBe('Plan review')
    expect(runner.prompt).toContain('node "$companion" task')
    expect(calls.find(c => c.opts.label === 'review plan review r1 codex read')!.opts.phase).toBe('Plan review')
    const fix = calls.find(c => c.opts.label === 'fix plan review r1')!
    expect(fix.opts.phase).toBe('Plan review')
    expect(fix.prompt.startsWith('READ-ONLY ROLE')).toBe(false)
    expect(fix.prompt).toContain('Missing migration step')
  })
})

describe('claude-code read-only guard hook', () => {
  it('is committed in sync with src/', async () => {
    const built = await buildReadOnlyGuard()
    expect(readFileSync(join(root, 'skills/granny-workflow/engines/claude-code/hooks/granny-readonly-guard.mjs'), 'utf8')).toBe(built)
  })
})

describe('opencode plugin bundle', () => {
  it('is committed in sync with src/', async () => {
    const built = await buildOpencode()
    expect(readFileSync(join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow/index.js'), 'utf8')).toBe(built)
  })

  it('bundles no module of the omp adapter, in the server plugin or the TUI plugin', () => {
    for (const file of ['index.js', 'tui.js']) {
      const text = readFileSync(join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow', file), 'utf8')
      expect(text.match(/^\/\/ src\/adapters\/omp\/.*$/gm) ?? []).toEqual([])
    }
  })

  it('default-exports a v2 plugin definition', async () => {
    const mod = await import(join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow/index.js'))
    expect(mod.default.id).toBe('granny-workflow')
    expect(typeof mod.default.setup).toBe('function')
  })
})

describe('opencode TUI plugin bundle', () => {
  const bundle = join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow/tui.js')

  it('is committed in sync with src/', async () => {
    const built = await buildOpencodeTui()
    expect(readFileSync(bundle, 'utf8')).toBe(built)
  })

  it('imports only the TUI runtime and node built-ins', () => {
    const text = readFileSync(bundle, 'utf8')
    const specifiers = [...text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)].map(m => m[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(s => !s.startsWith('node:') && !builtinModules.includes(s)).sort()).toEqual(['@opentui/solid', 'solid-js'])
  })

  it('default-exports a TUI plugin definition when the runtime resolves', async () => {
    mock.module('@opentui/solid', () => ({ createElement: () => ({}), createTextNode: () => ({}), insertNode() {}, insert() {}, setProp() {} }))
    mock.module('solid-js', () => ({ createSignal: (v: unknown) => [() => v, () => v], onCleanup() {} }))
    const mod = await import(bundle)
    expect(mod.default.id).toBe('granny-workflow')
    expect(typeof mod.default.setup).toBe('function')
  })
})

describe('omp extension bundle', () => {
  const bundle = join(root, 'skills/granny-workflow/engines/omp/extensions/granny-workflow/index.js')

  it('is committed in sync with src/', async () => {
    const built = await buildOmp()
    expect(readFileSync(bundle, 'utf8')).toBe(built)
  })

  it('default-exports the extension factory and passes its own path to the role processes', async () => {
    const mod = await import(bundle)
    expect(typeof mod.default).toBe('function')
    expect(readFileSync(bundle, 'utf8')).toContain('fileURLToPath(import.meta.url)')
  })

  it('registers only the submit tool and the guard when loaded as a role process', async () => {
    const tools: string[] = []
    const events: string[] = []
    process.env.GRANNY_OMP_CHILD = JSON.stringify({ tool: 'granny_submit_findings', kind: 'findings', out: '/nonexistent/out.json', access: 'read-only' })
    try {
      ;(await import(bundle)).default({ registerTool: (t: any) => tools.push(t.name), on: (e: string) => events.push(e), sendMessage: () => {} })
    } finally {
      delete process.env.GRANNY_OMP_CHILD
    }
    expect(tools).toEqual(['granny_submit_findings'])
    expect(events).toEqual(['tool_call', 'session_start'])
  })
})

describe('pr-comments.mjs', () => {
  const script = join(root, 'skills/granny-workflow/scripts/pr-comments.mjs')

  it('is committed in sync with src/', async () => {
    expect(readFileSync(script, 'utf8')).toBe(await buildPrComments())
  })

  it('imports only node built-ins', () => {
    const text = readFileSync(script, 'utf8')
    const specifiers = [...text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)].map(m => m[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(s => !s.startsWith('node:'))).toEqual([])
  })

  it('posts a round through gh when node runs it in a checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'granny-pr-'))
    try {
      const repo = join(dir, 'repo')
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
        expect(r.status).toBe(0)
        return r.stdout.trim()
      }
      mkdirSync(repo)
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'a.ts'), 'one\n')
      git('add', 'a.ts')
      git('commit', '-q', '-m', 'base')
      const base = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n')
      git('commit', '-q', '-am', 'two')
      const head = git('rev-parse', 'HEAD')
      const record = {
        version: 1,
        loop: 's1',
        name: 'one',
        round: 1,
        base,
        reviewedSha: head,
        reviewers: [{ name: 'codex', engine: 'auto' }],
        findings: [{ id: 'codex-F1', reviewer: 'codex', severity: 'P2', file: 'a.ts', line: 2, title: 'Two', detail: 'd', route: 'residual', decision: { rule: 8, action: 'residual', why: 'low' } }],
        outcome: 'residual-only',
      }
      mkdirSync(join(repo, '.granny/trail'), { recursive: true })
      writeFileSync(join(repo, '.granny/trail/s1-r1.json'), JSON.stringify(record))
      const posted = join(dir, 'posted.json')
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh
case "$1 $2" in
  "pr view") echo '{"number":3,"url":"https://github.com/o/r/pull/3","headRefOid":"${head}","baseRefOid":"${base}"}' ;;
  "api --paginate") ;;
  "api --method") cat > '${posted}' ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`,
      )
      chmodSync(join(bin, 'gh'), 0o755)
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRANNY_CONFIG: join(dir, 'none.json') }
      const r = spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env })
      expect({ code: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: 's1 r1: posted 1 line comment, 0 in body\nhttps://github.com/o/r/pull/3\n', stderr: '' })
      const review = JSON.parse(readFileSync(posted, 'utf8'))
      expect(review).toMatchObject({ commit_id: head, event: 'COMMENT', comments: [{ path: 'a.ts', line: 2, side: 'RIGHT' }] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
