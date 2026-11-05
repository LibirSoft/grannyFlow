import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGranny, type RunInput } from '../src/core/engine'
import { reportedWorktree, worktreePath } from '../src/core/worktree'
import { fakeHost, type FakeOptions, withCodex } from './fake-host'

describe('worktreePath', () => {
  it('puts the worktree in <parent>/<repo-name>-worktrees/<branch-slug> by default', () => {
    expect(worktreePath('/work/my repo', 'feat/v1')).toBe('/work/my repo-worktrees/feat-v1')
    expect(worktreePath('/work/repo/', 'feat/v1')).toBe('/work/repo-worktrees/feat-v1')
    expect(worktreePath('/work/./x/../repo', 'main')).toBe('/work/repo-worktrees/main')
  })

  it('reads a relative worktreeDir from the repo parent and keeps an absolute one', () => {
    expect(worktreePath('/work/repo', 'fix/a.b_c', 'trees')).toBe('/work/trees/fix-a.b_c')
    expect(worktreePath('/work/repo', 'x', '../elsewhere/wt')).toBe('/elsewhere/wt/x')
    expect(worktreePath('/work/repo', 'x', '/srv/wt/')).toBe('/srv/wt/x')
  })

  it('keeps the case of the branch and turns every other character into a dash', () => {
    expect(worktreePath('/r', 'Feat/X+y#z', '/w')).toBe('/w/Feat-X-y-z')
    expect(worktreePath('/r', "fix/it's", '/w')).toBe('/w/fix-it-s')
  })
})

describe('reportedWorktree', () => {
  it('reads the absolute path from the [granny] worktree line among git output', () => {
    expect(reportedWorktree("Preparing worktree (new branch 'feat/x')\nHEAD is now at abc init\n[granny] worktree: /a b/c's\n")).toBe("/a b/c's")
    expect(reportedWorktree('[granny] worktree: /a/b\r\n')).toBe('/a/b')
  })

  it('ignores a missing or relative path', () => {
    expect(reportedWorktree('done\n')).toBeUndefined()
    expect(reportedWorktree('[granny] worktree: a/b\n')).toBeUndefined()
    expect(reportedWorktree('[granny] worktree failed: /a has changes\n')).toBeUndefined()
  })
})

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('the worktree setup in a real git repo', () => {
  let root: string
  let repo: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "granny wt's ")))
    repo = join(root, 'my repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const defaultPath = () => join(root, 'my repo-worktrees', 'feat-x')
  const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  const excludes = () => readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('\n').filter(l => l === '/.granny/').length
  const run = (host: 'opencode' | 'claude-code', extra: Partial<RunInput> = {}, opts: FakeOptions = {}) => {
    const f = fakeHost({ name: host, direct: host === 'opencode', worktree: 'git', ...opts })
    const result = runGranny(f.host, withCodex({ repo, branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'Do WP-01.' }], ...extra }))
    return { f, result }
  }
  const workedIn = (f: ReturnType<typeof fakeHost>, wt: string) => {
    const impl = f.calls.find(c => c.kind === 'implementation')!
    expect(impl.prompt).toContain(`Working repo: ${wt}, branch \`feat/x\``)
    expect(impl.cwd).toBe(wt)
    if (f.cwds.length) expect(f.cwds).toEqual([wt])
    else expect(f.calls.find(c => c.label === 'review core r1 codex')!.prompt).toContain(`\n( cd '${wt.replaceAll("'", `'\\''`)}' && if [ -s .granny/review-core-r1-codex.pid ]`)
  }

  for (const host of ['opencode', 'claude-code'] as const) {
    describe(`on ${host}`, () => {
      it('reuses the main checkout when the branch is checked out there', async () => {
        git(repo, 'checkout', '-qb', 'feat/x')
        const { f, result } = run(host)
        expect((await result).worktree).toBe(repo)
        workedIn(f, repo)
        expect(worktrees()).toEqual([repo])
        expect(excludes()).toBe(1)
      })

      it('reuses a linked worktree that already has the branch, wherever it is', async () => {
        const elsewhere = join(root, 'somewhere else', 'feat')
        git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', elsewhere, 'main')
        const { f, result } = run(host)
        expect((await result).worktree).toBe(elsewhere)
        workedIn(f, elsewhere)
        expect(existsSync(join(root, 'my repo-worktrees'))).toBe(false)
        expect(worktrees()).toEqual([repo, elsewhere])
      })

      it('adds a worktree for an existing branch that has none, and leaves the main checkout alone', async () => {
        git(repo, 'branch', 'feat/x')
        writeFileSync(join(repo, 'a.txt'), 'uncommitted on main\n')
        const { f, result } = run(host)
        const wt = defaultPath()
        expect((await result).worktree).toBe(wt)
        workedIn(f, wt)
        expect(git(wt, 'branch', '--show-current')).toBe('feat/x')
        expect(git(repo, 'branch', '--show-current')).toBe('main')
        expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('uncommitted on main\n')
        expect(worktrees()).toEqual([repo, wt])
      })

      it('creates the branch from the base in a new worktree when the branch does not exist', async () => {
        git(repo, 'checkout', '-qb', 'develop')
        writeFileSync(join(repo, 'b.txt'), 'b\n')
        git(repo, 'add', 'b.txt')
        git(repo, 'commit', '-qm', 'develop')
        git(repo, 'checkout', '-q', 'main')
        const { f, result } = run(host, { base: 'develop' })
        const wt = defaultPath()
        expect((await result).worktree).toBe(wt)
        workedIn(f, wt)
        expect(git(wt, 'branch', '--show-current')).toBe('feat/x')
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'develop'))
        expect(git(repo, 'branch', '--show-current')).toBe('main')
      })

      it('fails before any agent runs when the reused worktree has uncommitted changes', async () => {
        const wt = defaultPath()
        git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main')
        writeFileSync(join(wt, 'dirty.txt'), 'x')
        writeFileSync(join(wt, 'a.txt'), 'changed\n')
        const { f, result } = run(host)
        await expect(result).rejects.toThrow(/worktree setup failed \(exit 1\)[\s\S]*has feat\/x checked out with uncommitted changes[\s\S]*a\.txt[\s\S]*dirty\.txt/)
        expect(f.calls).toHaveLength(0)
        expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('changed\n')
      })

      it('fails when the branch is checked out in a dirty main checkout', async () => {
        git(repo, 'checkout', '-qb', 'feat/x')
        writeFileSync(join(repo, 'a.txt'), 'changed\n')
        const { f, result } = run(host)
        await expect(result).rejects.toThrow(`${repo} has feat/x checked out with uncommitted changes`)
        expect(f.calls).toHaveLength(0)
      })

      it('does not count the git-excluded work dir as a change, and excludes it only once', async () => {
        git(repo, 'branch', 'feat/x')
        const first = run(host)
        const wt = (await first.result).worktree
        mkdirSync(join(wt, '.granny'), { recursive: true })
        writeFileSync(join(wt, '.granny/PR-BODY.md'), '# Title\n')
        const again = run(host, { stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2 })
        expect((await again.result).worktree).toBe(wt)
        expect(again.f.calls.find(c => c.kind === 'implementation')!.prompt).toContain('Stage 2/2: "b"')
        expect(worktrees()).toEqual([repo, wt])
        expect(excludes()).toBe(1)
      })

      it('places the worktree under a relative worktreeDir with spaces', async () => {
        const { f, result } = run(host, { config: { worktreeDir: "wt dir's" } })
        const wt = join(root, "wt dir's", 'feat-x')
        expect((await result).worktree).toBe(wt)
        workedIn(f, wt)
        expect(git(wt, 'branch', '--show-current')).toBe('feat/x')
      })

      it('writes the review into the worktree work dir, not the main checkout', async () => {
        const command = `{ test -n {base} && printf '%s\\n' '- [P2] Custom — a.txt:1' '  d' > {out}; }`
        const { f, result } = run(
          host,
          { config: { maxRounds: 1, reviewers: [{ name: 'mine', engine: 'command', command }] } },
          { shell: {}, scores: [{ 'mine-F1': 10 }] },
        )
        const r = await result
        const wt = defaultPath()
        expect(r.worktree).toBe(wt)
        expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Custom'])
        expect(readFileSync(join(wt, '.granny/review-core-r1-mine.md'), 'utf8')).toContain('Custom')
        expect(existsSync(join(repo, '.granny'))).toBe(false)
        expect(git(wt, 'status', '--porcelain')).toBe('')
        expect(f.setups).toHaveLength(1)
      })
    })
  }
})
