import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/core/config'
import { madeByGranny, removalOf, removeWorktreeScript, reportedWorktree, savedDir, savedKey, savedNotes, worktreeScript } from '../src/core/worktree'

const c = resolveConfig([])
const WT = '/work/a-worktrees/feat-x'
const SAVED = '/work/a/.granny/branches/feat%2Fx'
const REACHED = ['run worktree owned', 'run worktree on branch', 'run worktree clean', 'work dir saved', 'run worktree removed'].map(m => `[granny] ${m}\n`)

describe('the worktree scripts as text', () => {
  it('names the saved dir per repo and branch', () => {
    expect(savedDir(c, '/work/a/', 'feat/x')).toBe(SAVED)
    expect(savedKey('feat/x')).toBe('feat%2Fx')
    expect(savedDir({ workDir: 'tmp/g/' }, '/work/a', 'fix/a b')).toBe('/work/a/tmp/g/branches/fix%2Fa%20b')
  })

  it('gives branches that differ only in a slash or a dash their own saved dirs', () => {
    expect(savedDir(c, '/work/a', 'feat/x')).not.toBe(savedDir(c, '/work/a', 'feat-x'))
    expect(savedDir(c, '/work/a', 'feat%2Fx')).not.toBe(savedDir(c, '/work/a', 'feat/x'))
  })

  it('caps the saved dir name at 200 bytes, and keeps long branch names apart', () => {
    const long = `feat/${'a'.repeat(250)}`
    expect(savedKey(long).length).toBeLessThanOrEqual(200)
    expect(savedKey(long)).not.toBe(savedKey(`feat/${'a'.repeat(249)}b`))
    expect(savedKey(`feat/${'é'.repeat(120)}`).length).toBeLessThanOrEqual(200)
    expect(savedKey('feat/x')).toBe('feat%2Fx')
  })

  it('leaves the saved dir out of a setup script that is given none, and marks the worktree either way', () => {
    const lane = worktreeScript(c, 'feat/x--s2-two', 'main', '/work/a-worktrees/feat-x--s2-two')
    expect(lane).not.toContain('branches')
    expect(lane).toContain('granny-worktree')
    const run = worktreeScript(c, 'feat/x', 'main', WT, SAVED)
    expect(run).toContain(`cp -R ${SAVED}/. "$wt"/.granny/`)
    expect(run).toContain(`mv ${SAVED} "$old"`)
    expect(run).not.toContain('\n')
  })

  it('writes a removal script that is one braced line, never forces, checks before it copies and copies before it removes', () => {
    const script = removeWorktreeScript(c, 'feat/x', WT, SAVED)
    expect(script).not.toContain('\n')
    expect(script).not.toContain('--force')
    expect(script).not.toContain('git worktree list')
    expect(script.startsWith('{ wt=')).toBe(true)
    expect(script.endsWith(`git worktree remove "$wt" || exit 1; echo '[granny] run worktree removed'; }`)).toBe(true)
    const order = ['granny-worktree', 'symbolic-ref', 'status --porcelain', 'cp -R', 'cmp -s', 'git worktree remove'].map(part => script.indexOf(part))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('reads the mark and the notes of the setup output', () => {
    expect(madeByGranny('Preparing worktree\n[granny] worktree made by granny\n[granny] worktree: /a/b\n')).toBe(true)
    expect(madeByGranny('[granny] worktree: /a/b\n')).toBe(false)
    expect(madeByGranny("echo '[granny] worktree made by granny'\n")).toBe(false)
    expect(reportedWorktree('[granny] worktree made by granny\n[granny] worktree: /a/b\n')).toBe('/a/b')
    expect(savedNotes('[granny] work dir restored\n', SAVED)).toEqual([`work dir files of an earlier run restored from ${SAVED}`])
    expect(savedNotes('[granny] work dir not restored\n', SAVED)).toEqual([`the work dir files of an earlier run could not be restored from ${SAVED} - they stay there`])
    expect(savedNotes(`[granny] earlier work dir files moved aside: ${SAVED}.before-20261117-120000\n`, SAVED)).toEqual([`${SAVED} held the files of an earlier branch of this name - moved to ${SAVED}.before-20261117-120000`])
    expect(savedNotes('[granny] worktree: /a/b\n', SAVED)).toEqual([])
  })

  it('reads how far the removal got', () => {
    const upTo = (n: number, more = '') => REACHED.slice(0, n).join('') + more
    expect(removalOf(upTo(5), 'feat/x', SAVED)).toEqual({ removed: true, saved: SAVED })
    expect(removalOf('[granny] run worktree owned\n[granny] run worktree on branch\n[granny] run worktree clean\n[granny] no work dir files\n[granny] run worktree removed\n', 'feat/x', SAVED)).toEqual({ removed: true })
    expect(removalOf('[granny] run worktree gone\n[granny] work dir saved\n', 'feat/x', SAVED)).toEqual({ removed: true, saved: SAVED })
    expect(removalOf('[granny] run worktree gone\n', 'feat/x', SAVED)).toEqual({ removed: true })
    expect(removalOf('No findings.', 'feat/x', SAVED)).toEqual({ removed: false, kept: 'the removal could not confirm that granny created it' })
    expect(removalOf(upTo(1), 'feat/x', SAVED)).toEqual({ removed: false, kept: 'it is not on feat/x' })
    expect(removalOf(upTo(2, '?? left.txt\n'), 'feat/x', SAVED)).toEqual({ removed: false, kept: 'uncommitted changes in the worktree' })
    expect(removalOf(upTo(3), 'feat/x', SAVED)).toEqual({ removed: false, kept: `its work dir files could not be saved to ${SAVED}` })
    expect(removalOf(upTo(4, 'fatal: locked\n'), 'feat/x', SAVED)).toEqual({ removed: false, kept: 'git worktree remove failed' })
    expect(removalOf(`{ wt=x; echo '[granny] run worktree removed'; }\n`, 'feat/x', SAVED)).toEqual({ removed: false, kept: 'the removal could not confirm that granny created it' })
    expect(removalOf('[granny] run worktree listed\n', 'feat/x', SAVED)).toEqual({ removed: false, kept: 'the worktree folder is gone, but git still lists it - git worktree prune removes the entry' })
    expect(removalOf('the remove worktree runner returned nothing', 'feat/x', SAVED, '?')).toEqual({ removed: false, kept: 'the removal did not run: its runner returned no exit code' })
    expect(removalOf('No findings.', 'feat/x', SAVED, 1)).toEqual({ removed: false, kept: 'the removal could not confirm that granny created it' })
  })
})

describe('the worktree scripts in a real git repo', () => {
  let root: string
  let repo: string
  let wt: string
  let saved: string
  const sh = (command: string, cwd = repo) => {
    const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' })
    return { code: r.status, output: r.stdout + r.stderr }
  }
  const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`
  const setup = () => sh(worktreeScript(c, 'feat/x', 'main', wt, saved))
  const remove = () => {
    const r = sh(removeWorktreeScript(c, 'feat/x', wt, saved))
    return { ...r, end: removalOf(r.output, 'feat/x', saved) }
  }
  const workDir = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(wt, '.granny', name, '..'), { recursive: true })
      writeFileSync(join(wt, '.granny', name), text)
    }
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "granny sc's ")))
    repo = join(root, 'my repo')
    wt = join(root, 'my repo-worktrees', 'feat-x')
    saved = savedDir(c, repo, 'feat/x')
    mkdirSync(repo)
    sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a.txt && git add a.txt && git commit -qm init')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('marks a worktree it creates, for a new branch and for an existing one, and no worktree it reuses', () => {
    expect(madeByGranny(setup().output)).toBe(true)
    expect(madeByGranny(setup().output)).toBe(true)
    sh(`git worktree remove ${quoted(wt)}`)
    expect(madeByGranny(setup().output)).toBe(true)
    sh(`git worktree remove ${quoted(wt)} && git worktree add -q ${quoted(wt)} feat/x`)
    const reused = setup()
    expect(reportedWorktree(reused.output)).toBe(wt)
    expect(madeByGranny(reused.output)).toBe(false)
    sh(`git worktree remove ${quoted(wt)} && git checkout -q feat/x`)
    expect(madeByGranny(setup().output)).toBe(false)
  })

  it('saves the work dir files, removes the worktree and leaves the branch', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n', 'trail/s1-r1.json': '{}\n', "review it's.md": 'r\n' })
    const r = remove()
    expect(r.code).toBe(0)
    expect(r.end).toEqual({ removed: true, saved })
    expect(existsSync(wt)).toBe(false)
    expect(sh('git branch --list feat/x').output).toContain('feat/x')
    expect(sh('git worktree list').output.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(saved, 'PR-BODY.md'), 'utf8')).toBe('# one\n')
    expect(readFileSync(join(saved, "review it's.md"), 'utf8')).toBe('r\n')
    expect(readFileSync(join(saved, 'trail/worktree-paths'), 'utf8')).toBe(`${wt}\n`)
    expect(remove().end).toEqual({ removed: true, saved })
  })

  it('saves the work dir files of a branch name too long for one file name, and removes the worktree', () => {
    for (const [i, branch] of [`feat/${'a'.repeat(250)}`, `feat/${'é'.repeat(120)}`].entries()) {
      const path = join(root, 'my repo-worktrees', `long-${i}`)
      const dir = savedDir(c, repo, branch)
      expect(sh(worktreeScript(c, branch, 'main', path, dir)).code).toBe(0)
      mkdirSync(join(path, '.granny'), { recursive: true })
      writeFileSync(join(path, '.granny/PR-BODY.md'), `# ${i}\n`)
      const r = sh(removeWorktreeScript(c, branch, path, dir))
      expect(removalOf(r.output, branch, dir)).toEqual({ removed: true, saved: dir })
      expect(readFileSync(join(dir, 'PR-BODY.md'), 'utf8')).toBe(`# ${i}\n`)
      expect(existsSync(path)).toBe(false)
    }
  })

  it('removes a worktree with no work dir, and says nothing was saved', () => {
    setup()
    expect(remove().end).toEqual({ removed: true })
    expect(existsSync(saved)).toBe(false)
  })

  for (const [label, spoil, kept] of [
    ['an untracked file', () => writeFileSync(join(wt, 'left.txt'), 'x'), 'uncommitted changes in the worktree'],
    ['a changed tracked file', () => writeFileSync(join(wt, 'a.txt'), 'changed\n'), 'uncommitted changes in the worktree'],
    ['a staged file', () => sh('echo s > s.txt && git add s.txt', wt), 'uncommitted changes in the worktree'],
    ['another branch checked out', () => sh('git checkout -q -b other', wt), 'it is not on feat/x'],
    ['a detached HEAD', () => sh('git checkout -q --detach', wt), 'it is not on feat/x'],
    ['no mark', () => sh('rm "$(git rev-parse --absolute-git-dir)/granny-worktree"', wt), 'the removal could not confirm that granny created it'],
    ['a lock', () => sh(`git worktree lock ${quoted(wt)}`), 'git worktree remove failed'],
  ] as const) {
    it(`leaves a worktree with ${label}, and every file in it`, () => {
      setup()
      workDir({ 'PR-BODY.md': '# one\n' })
      spoil()
      const r = remove()
      expect(r.code).not.toBe(0)
      expect(r.end).toEqual({ removed: false, kept })
      expect(readFileSync(join(wt, '.granny/PR-BODY.md'), 'utf8')).toBe('# one\n')
      expect(sh('git worktree list').output.trim().split('\n')).toHaveLength(2)
    })
  }

  it('does not remove when a saved copy differs from its file', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n' })
    mkdirSync(join(saved, 'PR-BODY.md'), { recursive: true })
    const r = remove()
    expect(r.end).toEqual({ removed: false, kept: `its work dir files could not be saved to ${saved}` })
    expect(existsSync(wt)).toBe(true)
  })

  it('never removes the main checkout or a worktree the user added, and does nothing from a directory that is not there', () => {
    const main = sh(removeWorktreeScript(c, 'main', repo, savedDir(c, repo, 'main')))
    expect(removalOf(main.output, 'main', 'x')).toEqual({ removed: false, kept: 'the removal could not confirm that granny created it' })
    sh(`git worktree add -q -b feat/x ${quoted(wt)} main`)
    expect(remove().end).toEqual({ removed: false, kept: 'the removal could not confirm that granny created it' })
    expect(existsSync(wt)).toBe(true)
    const nowhere = sh(`cd /nonexistent-granny-dir && ${removeWorktreeScript(c, 'feat/x', wt, saved)}`)
    expect(nowhere.code).not.toBe(0)
    expect(nowhere.output).not.toContain('[granny]')
  })

  it('copies the saved files back into the worktree it adds for the branch, and keeps the files of both runs', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n', 'review-a-r1-x.md': 'old\n' })
    remove()
    const again = setup()
    expect(savedNotes(again.output, saved)).toEqual([`work dir files of an earlier run restored from ${saved}`])
    expect(readFileSync(join(wt, '.granny/PR-BODY.md'), 'utf8')).toBe('# one\n')
    expect(sh('git status --porcelain', wt).output).toBe('')
    workDir({ 'PR-BODY.md': '# two\n', 'review-b-r1-x.md': 'new\n' })
    expect(remove().end).toEqual({ removed: true, saved })
    expect(readdirSync(saved).sort()).toEqual(['PR-BODY.md', 'review-a-r1-x.md', 'review-b-r1-x.md'])
    expect(readFileSync(join(saved, 'PR-BODY.md'), 'utf8')).toBe('# two\n')
  })

  it('moves the saved files aside when it creates the branch anew', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n' })
    remove()
    sh('git branch -D feat/x')
    const fresh = setup()
    expect(savedNotes(fresh.output, saved)[0]).toContain(`${saved} held the files of an earlier branch of this name - moved to ${saved}.before-`)
    expect(existsSync(saved)).toBe(false)
    expect(existsSync(join(wt, '.granny'))).toBe(false)
    const aside = readdirSync(join(repo, '.granny/branches'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(repo, '.granny/branches', aside[0]!, 'PR-BODY.md'), 'utf8')).toBe('# one\n')
  })

  it('says so when the saved files of an earlier branch cannot be moved aside, and leaves them where they are', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n' })
    remove()
    sh('git branch -D feat/x')
    const bin = join(root, 'failing-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mv'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'mv'), 0o755)
    const path = process.env.PATH ?? ''
    process.env.PATH = `${bin}:${path}`
    try {
      const fresh = setup()
      expect(madeByGranny(fresh.output)).toBe(true)
      expect(savedNotes(fresh.output, saved)).toEqual([`${saved} holds the files of an earlier branch of this name, which could not be moved aside - the files of this run are merged into them`])
      expect(readFileSync(join(saved, 'PR-BODY.md'), 'utf8')).toBe('# one\n')
    } finally {
      process.env.PATH = path
    }
  })

  it('keeps the saved files of a branch apart from a branch whose name differs only in a slash', () => {
    setup()
    workDir({ 'PR-BODY.md': '# feat/x\n' })
    expect(remove().end).toEqual({ removed: true, saved })
    sh('git branch feat-x main')
    const other = savedDir(c, repo, 'feat-x')
    const restored = sh(worktreeScript(c, 'feat-x', 'main', wt, other))
    expect(savedNotes(restored.output, other)).toEqual([])
    expect(existsSync(join(wt, '.granny'))).toBe(false)
    workDir({ 'PR-BODY.md': '# feat-x\n' })
    const r = sh(removeWorktreeScript(c, 'feat-x', wt, other))
    expect(removalOf(r.output, 'feat-x', other)).toEqual({ removed: true, saved: other })
    expect(readFileSync(join(saved, 'PR-BODY.md'), 'utf8')).toBe('# feat/x\n')
    expect(readFileSync(join(other, 'PR-BODY.md'), 'utf8')).toBe('# feat-x\n')
  })

  it('removes the worktree when a tag has the branch name too', () => {
    sh('git tag feat/x')
    setup()
    workDir({ 'PR-BODY.md': '# one\n' })
    expect(remove().end).toEqual({ removed: true, saved })
    expect(sh('git branch --list feat/x').output).toContain('feat/x')
  })

  it('does not report a worktree removed while git still lists it after its folder was deleted by hand', () => {
    setup()
    workDir({ 'PR-BODY.md': '# one\n' })
    rmSync(wt, { recursive: true, force: true })
    const r = remove()
    expect(r.code).not.toBe(0)
    expect(r.end).toEqual({ removed: false, kept: 'the worktree folder is gone, but git still lists it - git worktree prune removes the entry' })
    expect(sh('git worktree list').output.trim().split('\n')).toHaveLength(2)
  })

  it('reports a worktree that git already removed as removed', () => {
    setup()
    sh(`git worktree remove ${quoted(wt)}`)
    expect(remove().end).toEqual({ removed: true })
  })

  it('reads a worktree that is already gone under a shell that fails an unmatched glob, as zsh does', () => {
    setup()
    expect(remove().end).toEqual({ removed: true })
    const r = spawnSync('bash', ['-O', 'failglob', '-c', removeWorktreeScript(c, 'feat/x', wt, saved)], { cwd: repo, encoding: 'utf8' })
    expect(removalOf(r.stdout + r.stderr, 'feat/x', saved)).toEqual({ removed: true })
  })

  it('gives a second move aside within the same second a name of its own', () => {
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'date'), '#!/bin/sh\necho 20261117-120000\n')
    chmodSync(join(bin, 'date'), 0o755)
    const path = process.env.PATH ?? ''
    process.env.PATH = `${bin}:${path}`
    try {
      setup()
      workDir({ 'PR-BODY.md': '# one\n' })
      remove()
      sh('git branch -D feat/x')
      const first = /moved aside: (.+)/.exec(setup().output)![1]!.trim()
      workDir({ 'PR-BODY.md': '# two\n' })
      expect(remove().end).toEqual({ removed: true, saved })
      sh('git branch -D feat/x')
      const second = /moved aside: (.+)/.exec(setup().output)![1]!.trim()
      expect(second).not.toBe(first)
      expect(readFileSync(join(first, 'PR-BODY.md'), 'utf8')).toBe('# one\n')
      expect(readFileSync(join(second, 'PR-BODY.md'), 'utf8')).toBe('# two\n')
      expect(existsSync(saved)).toBe(false)
    } finally {
      process.env.PATH = path
    }
  })
})
