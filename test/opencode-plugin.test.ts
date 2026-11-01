import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { modelRef, permissions, preflight } from '../src/adapters/opencode/plugin'

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
  granny_submit_score: { score: 90, perFinding: [{ id: 'F1', score: 95, reason: 'real' }], rationale: 'ok' },
  granny_submit_final: { gatesGreen: true, gates: 'ok', commits: ['c1'], prBodyPath: '.granny/PR-BODY.md', issues: '' },
  granny_submit_findings: { findings: [] },
}

function fakeContext(behaviour: { skipSubmitOnce?: boolean } = {}) {
  const tools = new Map<string, any>()
  const created: any[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const pending = new Map<string, string>()
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
        return s
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
        pending.set(input.sessionID, input.text)
        return {}
      },
      wait: async ({ sessionID }: { sessionID: string }) => {
        const text = pending.get(sessionID) ?? ''
        const name = /(granny_submit_\w+)/.exec(text)?.[1]
        if (!name) return
        if (behaviour.skipSubmitOnce && !skipped) {
          skipped = true
          return
        }
        await tools.get(name).execute(CANNED[name], { sessionID })
      },
      interrupt: async () => ({ interrupted: true }),
    },
  }
  return { ctx, tools, created, prompts }
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

  it('runs the loop in the background with child sessions, a direct review command and a completion message', async () => {
    writeFileSync(
      join(repo, 'granny.config.json'),
      JSON.stringify({
        roles: {
          judge: { model: { opencode: 'opencode/judge-model' } },
          reviewer: {
            command: `test -n {base} && if [ -e .granny/reviewed ]; then echo "No issues." > {out}; else touch .granny/reviewed; printf '%s\\n' '- [P2] Real issue — a.txt:1' '  detail' > {out}; fi`,
          },
        },
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
    expect(result.stages[0].history[0].findings[0]).toMatchObject({ id: 'F1', severity: 'P2', file: 'a.txt', line: 1, score: 95 })

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
})
