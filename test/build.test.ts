import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClaudeCode, buildOpencode } from '../scripts/build'
import { CODEX_REVIEWER, finding, review } from './fake-host'

const root = join(import.meta.dir, '..')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

function loadWorkflow(script: string) {
  expect(script.startsWith('export const meta = {')).toBe(true)
  const body = script.replace(/^export const meta/, 'const meta')
  return new AsyncFunction('agent', 'log', 'phase', 'args', 'parallel', 'pipeline', 'budget', 'workflow', body)
}

describe('claude-code workflow.js', () => {
  it('is committed in sync with src/', async () => {
    const built = await buildClaudeCode()
    expect(readFileSync(join(root, 'skills/granny-workflow/engines/claude-code/workflow.js'), 'utf8')).toBe(built)
  })

  it('starts with a pure-literal meta and avoids APIs the Workflow sandbox forbids', async () => {
    const script = await buildClaudeCode()
    const meta = script.slice(0, script.indexOf('\n}\n') + 2)
    expect(meta).not.toMatch(/\$\{|\.\.\.|\w\(/)
    for (const banned of ['Date.now(', 'Math.random(', 'new Date(', 'require(']) expect(script).not.toContain(banned)
  })

  it('runs the whole loop against the Workflow agent() API', async () => {
    const script = await buildClaudeCode()
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
      if (kind.startsWith('score')) return { score: 80, perFinding: [{ id: 'codex-F1', score: 85, reason: 'real' }], rationale: 'ok' }
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
    expect(setup.prompt).toContain('\ncd /r && ex="$(git rev-parse --git-common-dir)/info/exclude"')
    expect(setup.prompt).toContain('wt=/r-worktrees/feat-x;')
    expect(calls[1]!.opts).toMatchObject({ label: 'head one', phase: 'Implement', model: 'haiku', effort: 'low' })
    expect(calls[1]!.prompt).toContain('\ncd /r-worktrees/feat-x && git rev-parse --verify HEAD\n')
    const impl = calls[2]!
    expect(impl.opts).toMatchObject({ label: 'implement one', phase: 'Implement', model: 'opus', effort: 'high' })
    expect(impl.prompt).toContain('Working repo: /r-worktrees/feat-x, branch `feat/x`')
    const runner = calls.find(c => c.opts.label === 'review one r1 codex')!
    expect(runner.prompt).toContain('\ncd /r-worktrees/feat-x && if [ -s .granny/review-one-r1-codex.pid ]')
    expect(calls.filter(c => c.opts.label.startsWith('review one r1 codex')).map(c => c.opts.label)).toEqual(['review one r1 codex', 'review one r1 codex wait 1', 'review one r1 codex read'])
    expect(runner.prompt.startsWith('READ-ONLY ROLE')).toBe(true)
    expect(runner.opts).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(calls.find(c => c.opts.label === 'pr-ready check')!.opts.model).toBeUndefined()
    const judge = calls.find(c => c.opts.label === 'judge one r1')!
    expect(judge.opts.model).toBe('haiku')
    expect(calls.some(c => c.opts.label === 'fix one r1' && c.prompt.includes('Off by one'))).toBe(true)
    expect(logs.some(l => l.includes('review score 80'))).toBe(true)
  })

  it('declares the Plan review phase and reviews and fixes a plan through the Workflow agent() API', async () => {
    const script = await buildClaudeCode()
    const meta = script.slice(0, script.indexOf('\n}\n') + 2)
    expect(meta).toContain("{ title: 'Worktree' },\n    { title: 'Plan' },\n    { title: 'Plan review' },\n    { title: 'Implement' },")
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

describe('opencode plugin bundle', () => {
  it('is committed in sync with src/', async () => {
    const built = await buildOpencode()
    expect(readFileSync(join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow/index.js'), 'utf8')).toBe(built)
  })

  it('default-exports a v2 plugin definition', async () => {
    const mod = await import(join(root, 'skills/granny-workflow/engines/opencode/plugin/granny-workflow/index.js'))
    expect(mod.default.id).toBe('granny-workflow')
    expect(typeof mod.default.setup).toBe('function')
  })
})
