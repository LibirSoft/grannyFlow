import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost, type FakeOptions } from './fake-host'

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('the worktree removal in a real git repo', () => {
  let root: string
  let repo: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "granny rm's ")))
    repo = join(root, 'my repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const wt = () => join(root, 'my repo-worktrees', 'feat-x')
  const saved = () => join(repo, '.granny/branches/feat%2Fx')
  const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  const body = (text: string) => (req: AgentRequest) => {
    if (req.kind !== 'final') return undefined
    mkdirSync(join(req.cwd, '.granny/trail'), { recursive: true })
    writeFileSync(join(req.cwd, '.granny/PR-BODY.md'), text)
    writeFileSync(join(req.cwd, '.granny/trail/s1-r1.json'), '{}\n')
    return undefined
  }
  const run = (host: 'opencode' | 'claude-code', extra: Partial<RunInput> = {}, opts: FakeOptions = {}) => {
    const f = fakeHost({ name: host, direct: host === 'opencode', worktree: 'git', shell: {}, override: body('# one\n'), ...opts })
    const result = runGranny(f.host, { repo, branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'Do WP-01.' }], ...extra, config: [{ reviewers: [{ name: 'a', engine: 'agent' }] }, ...(extra.config === undefined ? [] : [extra.config])] })
    return { f, result }
  }
  const removals = (f: ReturnType<typeof fakeHost>) => f.commands.filter(c => c.includes('git worktree remove'))

  for (const host of ['opencode', 'claude-code'] as const) {
    describe(`on ${host}`, () => {
      it('removes the worktree it created, leaves the branch and saves the work dir files', async () => {
        const { f, result } = run(host)
        const r = await result
        expect(r.worktree).toBe(wt())
        expect(r.worktreeEnd).toEqual({ removed: true, saved: saved() })
        expect(existsSync(wt())).toBe(false)
        expect(worktrees()).toEqual([repo])
        expect(git(repo, 'branch', '--list', 'feat/x')).toContain('feat/x')
        expect(readFileSync(join(saved(), 'PR-BODY.md'), 'utf8')).toBe('# one\n')
        expect(readFileSync(join(saved(), 'trail/worktree-paths'), 'utf8')).toBe(`${wt()}\n`)
        expect(r.final!.prBodyPath).toBe(`${saved()}/PR-BODY.md`)
        expect(removals(f)).toHaveLength(1)
        expect(f.logs).toContain(`worktree removed: ${wt()} - the branch feat/x is left, and its work dir files are in ${saved()}`)
        git(repo, 'checkout', '-q', 'feat/x')
        expect(git(repo, 'branch', '--show-current')).toBe('feat/x')
        expect(git(repo, 'status', '--porcelain')).toBe('')
      })

      it('leaves a worktree it reused', async () => {
        const elsewhere = join(root, 'mine')
        git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', elsewhere, 'main')
        const { f, result } = run(host)
        expect((await result).worktreeEnd).toEqual({ removed: false, kept: 'granny did not create it' })
        expect(existsSync(join(elsewhere, '.granny/PR-BODY.md'))).toBe(true)
        expect(removals(f)).toHaveLength(0)
        expect(existsSync(saved())).toBe(false)
      })

      it('leaves a worktree with an untracked file and saves nothing', async () => {
        const { result } = run(host, {}, { override: req => { if (req.kind === 'final') writeFileSync(join(req.cwd, 'left.txt'), 'x'); return body('# one\n')(req) } })
        expect((await result).worktreeEnd).toEqual({ removed: false, kept: 'uncommitted changes in the worktree' })
        expect(readFileSync(join(wt(), 'left.txt'), 'utf8')).toBe('x')
        expect(existsSync(saved())).toBe(false)
      })

      it('restores the saved files into the worktree a later run creates, and removes it again', async () => {
        await run(host).result
        let seen = ''
        const again = run(host, { stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2 }, {
          override: req => {
            if (req.kind === 'implementation') seen = readFileSync(join(req.cwd, '.granny/PR-BODY.md'), 'utf8')
            return body('# two\n')(req)
          },
        })
        const r = await again.result
        expect(seen).toBe('# one\n')
        expect(again.f.logs).toContain(`worktree: work dir files of an earlier run restored from ${saved()}`)
        expect(r.worktreeEnd).toEqual({ removed: true, saved: saved() })
        expect(readFileSync(join(saved(), 'PR-BODY.md'), 'utf8')).toBe('# two\n')
        expect(existsSync(wt())).toBe(false)
      })

      it('keeps the worktree of a run that failed, and removes it when the resume ends ready', async () => {
        const failed = run(host, {}, { override: req => (req.kind === 'implementation' ? null : undefined) })
        await expect(failed.result).rejects.toThrow('implementer returned nothing')
        expect(existsSync(wt())).toBe(true)
        const r = await run(host).result
        expect(r.worktreeEnd).toEqual({ removed: true, saved: saved() })
        expect(existsSync(wt())).toBe(false)
      })

      it('keeps the worktree of a planning run; the implement run removes it', async () => {
        const planned = await run(host, { stages: undefined, goal: 'Build it.' }).result
        expect(planned.worktreeEnd).toEqual({ removed: false, kept: 'a planning run keeps its worktree for the implement run' })
        expect(existsSync(wt())).toBe(true)
        expect((await run(host).result).worktreeEnd).toEqual({ removed: true, saved: saved() })
      })

      it('moves the saved files of an earlier branch of the same name aside', async () => {
        await run(host).result
        git(repo, 'branch', '-D', 'feat/x')
        const { f, result } = run(host, {}, { override: body('# new\n') })
        await result
        const kept = readdirSync(join(repo, '.granny/branches')).filter(n => n.startsWith('feat%2Fx.before-'))
        expect(kept).toHaveLength(1)
        expect(readFileSync(join(repo, '.granny/branches', kept[0]!, 'PR-BODY.md'), 'utf8')).toBe('# one\n')
        expect(readFileSync(join(saved(), 'PR-BODY.md'), 'utf8')).toBe('# new\n')
        expect(f.logs.some(l => l.includes('held the files of an earlier branch of this name'))).toBe(true)
      })
    })
  }
})
