import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClaudeCode, buildOpencode } from '../scripts/build'
import { finding, review } from './fake-host'

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
      if (kind.startsWith('startSha')) return { startSha: 's1', headSha: 'h1', gatesGreen: true, gates: 'ok', commits: ['c'], untested: '' }
      if (kind.startsWith('ran')) {
        reviews++
        return { ran: true, exitCode: 0, output: reviews === 1 ? review(finding('P2', 'Off by one')) : 'No issues.' }
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
      config: [{ roles: { implementer: { model: 'opus', effort: 'high' } } }, { threshold: 80 }],
    })
    expect(result.stages[0]).toMatchObject({ stage: 'one', outcome: 'clean', rounds: 2 })
    expect(result.base).toBe('main')
    expect(phases).toEqual(['Implement', 'Review', 'PR ready'])
    const impl = calls[0]!
    expect(impl.opts).toMatchObject({ label: 'implement one', phase: 'Implement', model: 'opus', effort: 'high' })
    const runner = calls.find(c => c.opts.label === 'review one r1 codex')!
    expect(runner.prompt.startsWith('READ-ONLY ROLE')).toBe(true)
    expect(runner.opts.model).toBeUndefined()
    const judge = calls.find(c => c.opts.label === 'judge one r1')!
    expect(judge.opts.model).toBe('sonnet')
    expect(calls.some(c => c.opts.label === 'fix one r1' && c.prompt.includes('Off by one'))).toBe(true)
    expect(logs.some(l => l.includes('review score 80'))).toBe(true)
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
