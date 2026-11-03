import { describe, expect, it } from 'bun:test'
import { checkInput, runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest } from '../src/core/types'
import { fakeHost, withCodex, type Review } from './fake-host'

const A = '/work/a'
const B = '/work/b'
const C = '/work/c'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({
  repo: A,
  branch: 'feat/x',
  base: 'main',
  repos: [B, { repo: C, base: 'master' }],
  stages: [
    { name: 'logo a', task: 'Logo in A.' },
    { name: 'logo b', task: 'Logo in B.', repo: B },
    { name: 'logo c', task: 'Logo in C.', repo: C },
  ],
  ...extra,
  })

const lanePath = (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd

function tracker(ms = 15) {
  let active = 0
  let peak = 0
  const order: string[] = []
  const override = async (req: AgentRequest) => {
    if (req.kind !== 'implementation') return undefined
    active++
    peak = Math.max(peak, active)
    order.push(`start ${req.label}`)
    await new Promise(r => setTimeout(r, ms))
    order.push(`end ${req.label}`)
    active--
    return { startSha: `s-${req.label}`, headSha: `h-${req.label}`, gatesGreen: true, gates: 'green', commits: [], untested: '' }
  }
  return { override, order, peak: () => peak }
}

describe('parallel stages', () => {
  it('runs stages in different repos at the same time, each in its own repo, by default', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override, worktree: lanePath })
    const r = await runGranny(f.host, input())
    expect(t.peak()).toBe(3)
    const impl = (label: string) => f.calls.find(c => c.label === label)!
    expect(impl('implement logo a').cwd).toBe('/work/a-worktrees/feat-x')
    expect(impl('implement logo b').cwd).toBe('/work/b-worktrees/feat-x')
    expect(impl('implement logo c').cwd).toBe('/work/c-worktrees/feat-x')
    expect(impl('implement logo b').prompt).toContain('This run also changes other repos: /work/a-worktrees/feat-x, /work/c-worktrees/feat-x')
    expect(impl('implement logo c').prompt).toContain("Never touch `master`")
    expect(r.stages.map(s => [s.stage, s.repo, s.outcome])).toEqual([
      ['logo a', undefined, 'clean'],
      ['logo b', B, 'clean'],
      ['logo c', C, 'clean'],
    ])
    expect(f.setups.map(s => s.cwd)).toEqual([A, B, C])
    expect(f.setups[2]!.command).toContain('"$wt" master')
    expect(r.repos?.map(x => [x.repo, x.worktree, x.final?.gatesGreen])).toEqual([
      [A, '/work/a-worktrees/feat-x', true],
      [B, '/work/b-worktrees/feat-x', true],
      [C, '/work/c-worktrees/feat-x', true],
    ])
    expect(f.calls.filter(c => c.kind === 'final').map(c => [c.label, c.cwd])).toEqual([
      ['pr-ready check', '/work/a-worktrees/feat-x'],
      ['pr-ready check b', '/work/b-worktrees/feat-x'],
      ['pr-ready check c', '/work/c-worktrees/feat-x'],
    ])
    expect(f.cwds.filter(c => c.includes('worktrees'))).toEqual(
      expect.arrayContaining(['/work/a-worktrees/feat-x', '/work/b-worktrees/feat-x', '/work/c-worktrees/feat-x']),
    )
  })

  it('runs one stage at a time, in order, with parallel off', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override })
    await runGranny(f.host, input({ config: { parallel: false } }))
    expect(t.peak()).toBe(1)
    expect(t.order).toEqual(['start implement logo a', 'end implement logo a', 'start implement logo b', 'end implement logo b', 'start implement logo c', 'end implement logo c'])
  })

  it('caps the stages running at once with maxParallel', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override })
    await runGranny(f.host, input({ config: { maxParallel: 2 } }))
    expect(t.peak()).toBe(2)
  })

  it('keeps stages in the same repo in order unless after says otherwise', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override })
    await runGranny(f.host, input({ repos: undefined, stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(t.peak()).toBe(1)
    expect(f.setups).toHaveLength(1)
  })

  it('waits for the stages named in after, across repos', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override })
    await runGranny(f.host, input({
      stages: [
        { name: 'api', task: 'API in A.' },
        { name: 'ui', task: 'UI in B.', repo: B, after: [1] },
        { name: 'docs', task: 'Docs in C.', repo: C },
      ],
    }))
    expect(t.order.indexOf('start implement ui')).toBeGreaterThan(t.order.indexOf('end implement api'))
    expect(t.order.indexOf('start implement docs')).toBeLessThan(t.order.indexOf('end implement api'))
  })

  it('runs an independent stage of a busy repo in its own worktree and merges it back', async () => {
    const t = tracker()
    const f = fakeHost({ override: t.override, worktree: lanePath })
    const r = await runGranny(f.host, input({
      repos: undefined,
      stages: [
        { name: 'retry', task: 'WP-01' },
        { name: 'circuit breaker', task: 'WP-02', after: [] },
      ],
    }))
    expect(t.peak()).toBe(2)
    const lane = '/work/a-worktrees/feat-x--s2-circuit-breaker'
    expect(f.setups.map(s => s.command)).toEqual([expect.stringContaining('= feat/x ]'), expect.stringContaining('= feat/x--s2-circuit-breaker ]')])
    expect(f.setups[1]!.command).toContain(`git worktree add -b feat/x--s2-circuit-breaker "$wt" deadbee1`)
    const second = f.calls.find(c => c.label === 'implement circuit breaker')!
    expect(second.cwd).toBe(lane)
    expect(second.prompt).toContain('branch `feat/x--s2-circuit-breaker`')
    expect(second.prompt).toContain('/work/a-worktrees/feat-x/.granny/PR-BODY-s2-circuit-breaker.md')
    expect(f.commands).toContain('git merge --no-edit feat/x--s2-circuit-breaker')
    const merge = f.commands.indexOf('git merge --no-edit feat/x--s2-circuit-breaker')
    expect(f.cwds[merge]).toBe('/work/a-worktrees/feat-x')
    expect(f.commands.some(c => c.includes(`git worktree remove --force ${lane} && echo '[granny] lane worktree removed' && git branch -d feat/x--s2-circuit-breaker`))).toBe(true)
    expect(r.stages[1]!.note).toContain('ran in parallel on feat/x--s2-circuit-breaker, merged')
    expect(f.calls.find(c => c.kind === 'final')!.prompt).toContain('.granny/PR-BODY-*.md')
  })

  it('has the implementer resolve a merge that stops on conflicts', async () => {
    const f = fakeHost({
      worktree: lanePath,
      reviews: (command: string) => (command.startsWith('git merge --no-edit') ? { code: 1, output: 'CONFLICT (content): Merge conflict in src/a.ts' } : 'No findings.'),
      override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
    })
    const r = await runGranny(f.host, input({ repos: undefined, stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [] }] }))
    const resolve = f.calls.find(c => c.label === 'resolve merge two')!
    expect(resolve.kind).toBe('implementation')
    expect(resolve.cwd).toBe('/work/a-worktrees/feat-x')
    expect(resolve.prompt).toContain('Merge conflict in src/a.ts')
    expect(r.stages[1]!.note).toContain('merged after the implementer resolved conflicts')
  })

  it('lets running stages finish when one fails, starts nothing new, then fails the run', async () => {
    const started: string[] = []
    let finished = false
    const f = fakeHost({
      override: async req => {
        if (req.kind !== 'implementation') return undefined
        started.push(req.label)
        if (req.label === 'implement logo a') return null
        await new Promise(r => setTimeout(r, 20))
        finished = true
        return undefined
      },
    })
    await expect(runGranny(f.host, input({
      stages: [
        { name: 'logo a', task: 'A' },
        { name: 'logo b', task: 'B', repo: B },
        { name: 'more a', task: 'A2' },
      ],
    }))).rejects.toThrow('implement logo a: implementer returned nothing')
    expect(finished).toBe(true)
    expect(started).toEqual(['implement logo a', 'implement logo b'])
    expect(f.logs).toContain('a stage failed - waited for the stages already running. Finished: 2 (logo b). Not finished: 1 (logo a), 3 (more a)')
  })

  it('treats stages before fromStage as done', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ fromStage: 2, stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b' }] }))
    expect(r.stages.map(s => s.outcome)).toEqual(['skipped', 'clean'])
  })

  it('validates repos, stage repos and after', () => {
    expect(checkInput(input({ repos: ['relative'] }))).toContain('repos[0] must be an absolute path or { repo, base } with an absolute repo')
    expect(checkInput(input({ repos: [A] }))).toContain('repos[0] repeats /work/a (it is the primary repo)')
    expect(checkInput(input({ stages: [{ task: 'x', repo: '/elsewhere' }] }))).toContain('stages[0].repo must be the repo or one of repos (got "/elsewhere")')
    expect(checkInput(input({ stages: [{ task: 'x' }, { task: 'y', after: [2] }] }))).toContain('stages[1].after must list 1-based numbers of earlier stages (1..1)')
    expect(checkInput(input({ stages: [{ task: 'x', after: [] }] }))).toEqual([])
  })
})

describe('parallel stages in a real git repo', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const fs = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  let root = ''
  let repo = ''
  const setUp = () => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'granny-par-')))
    repo = join(root, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    fs.writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
  }
  const commit = (cwd: string, file: string, text: string, ms = 0) => async () => {
    await new Promise(r => setTimeout(r, ms))
    const start = git(cwd, 'rev-parse', 'HEAD')
    fs.writeFileSync(join(cwd, file), text)
    fs.mkdirSync(join(cwd, '.granny'), { recursive: true })
    fs.writeFileSync(join(cwd, '.granny', 'note.md'), 'x')
    git(cwd, 'add', file)
    git(cwd, 'commit', '-qm', `feat: ${file}`)
    return { startSha: start, headSha: git(cwd, 'rev-parse', 'HEAD'), gatesGreen: true, gates: 'green', commits: [], untested: '' }
  }
  const run = (edits: Record<string, [string, string, number] | ((cwd: string) => Promise<unknown>)>, resolve?: (cwd: string) => void) =>
    runGranny(
      fakeHost({
        worktree: 'git',
        commits: 'git',
        shell: {},
        override: async req => {
          if (req.label.startsWith('resolve')) {
            const start = git(req.cwd, 'rev-parse', 'HEAD')
            resolve!(req.cwd)
            return { startSha: start, headSha: git(req.cwd, 'rev-parse', 'HEAD'), gatesGreen: true, gates: 'green', commits: [], untested: '' }
          }
          const e = edits[req.label]
          return typeof e === 'function' ? e(req.cwd) : e ? commit(req.cwd, ...e)() : undefined
        },
      }).host,
      {
        repo,
        branch: 'feat/x',
        base: 'main',
        stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02', after: [] }],
        config: { reviewers: [{ name: 'a', engine: 'agent' }] },
      },
    )

  it('merges a stage that ran in its own worktree back and removes that worktree', async () => {
    setUp()
    try {
      const r = await run({ 'implement one': ['one.txt', 'one\n', 40], 'implement two': ['two.txt', 'two\n', 0] })
      const wt = join(root, 'repo-worktrees', 'feat-x')
      expect(fs.readFileSync(join(wt, 'one.txt'), 'utf8')).toBe('one\n')
      expect(fs.readFileSync(join(wt, 'two.txt'), 'utf8')).toBe('two\n')
      expect(fs.existsSync(join(root, 'repo-worktrees', 'feat-x--s2-two'))).toBe(false)
      expect(git(repo, 'branch', '--list', 'feat/x--*')).toBe('')
      expect(git(wt, 'status', '--porcelain')).toBe('')
      expect(r.stages[1]!.note).toBe('ran in parallel on feat/x--s2-two, merged')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('hands a conflicting merge to the implementer, who concludes it', async () => {
    setUp()
    try {
      const r = await run({ 'implement one': ['a.txt', 'one\n', 40], 'implement two': ['a.txt', 'two\n', 0] }, cwd => {
        fs.writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n')
        git(cwd, 'add', 'a.txt')
        git(cwd, 'commit', '--no-edit', '-q')
      })
      const wt = join(root, 'repo-worktrees', 'feat-x')
      expect(fs.readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
      expect(git(wt, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
      expect(r.stages[1]!.note).toBe('ran in parallel on feat/x--s2-two, merged after the implementer resolved conflicts')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the run and keeps the lane when a merge that stopped without a conflict leaves it out of HEAD', async () => {
    setUp()
    try {
      const dirty = async (cwd: string) => {
        await new Promise(r => setTimeout(r, 40))
        fs.writeFileSync(join(cwd, 'a.txt'), 'uncommitted\n')
        return undefined
      }
      await expect(run({ 'implement one': dirty, 'implement two': ['a.txt', 'two\n', 0] }, () => {})).rejects.toThrow(
        'merge two: feat/x--s2-two is not merged into feat/x',
      )
      const wt = join(root, 'repo-worktrees', 'feat-x')
      expect(fs.existsSync(join(root, 'repo-worktrees', 'feat-x--s2-two'))).toBe(true)
      expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'feat/x--*')).toBe('feat/x--s2-two')
      expect(spawnSync('git', ['merge-base', '--is-ancestor', 'feat/x--s2-two', 'HEAD'], { cwd: wt }).status).toBe(1)
      expect(fs.readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('uncommitted\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

it('fails the run when the implementer leaves the merge unfinished', async () => {
  const f = fakeHost({
    worktree: (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd,
    reviews: (command: string) =>
      command.startsWith('git merge') ? { code: 1, output: 'CONFLICT' } : command.includes('MERGE_HEAD') ? { code: 1, output: 'UU a.txt' } : 'No findings.',
    override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
  })
  await expect(runGranny(f.host, { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', after: [] }] })).rejects.toThrow(
    'merge two: the merge of feat/x--s2-two into feat/x is still unfinished',
  )
})

describe('lane merge verification', () => {
  const laneInput = { repo: A, branch: 'feat/x', stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', after: [] }] }
  const laneHost = (answer: (command: string) => Review | undefined) =>
    fakeHost({
      worktree: lanePath,
      reviews: (command: string) => answer(command) ?? 'No findings.',
      override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
    })

  it('fails the run without cleaning up when the merge stops without a conflict and the lane is not in HEAD', async () => {
    const f = laneHost(command =>
      command.startsWith('git merge --no-edit')
        ? { code: 1, output: 'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt' }
        : command.startsWith('git merge-base --is-ancestor')
          ? { code: 1, output: '' }
          : undefined,
    )
    await expect(runGranny(f.host, laneInput)).rejects.toThrow(
      'merge two: feat/x--s2-two is not merged into feat/x (git merge-base --is-ancestor exit 1) - its worktree /work/a-worktrees/feat-x--s2-two and branch feat/x--s2-two are left in place',
    )
    expect(f.commands).toContain("git merge-base --is-ancestor feat/x--s2-two HEAD")
    expect(f.cwds[f.commands.indexOf('git merge-base --is-ancestor feat/x--s2-two HEAD')]).toBe('/work/a-worktrees/feat-x')
    expect(f.commands.some(c => c.includes('git worktree remove') || c.includes('git branch -d'))).toBe(false)
  })

  it('fails the run when a merge reported as done left the lane out of HEAD', async () => {
    const f = laneHost(command => (command.startsWith('git merge-base --is-ancestor') ? { code: 128, output: 'fatal: Not a valid object name' } : undefined))
    await expect(runGranny(f.host, laneInput)).rejects.toThrow('merge two: feat/x--s2-two is not merged into feat/x (git merge-base --is-ancestor exit 128)')
    expect(f.calls.some(c => c.label === 'resolve merge two')).toBe(false)
    expect(f.commands.some(c => c.includes('git worktree remove'))).toBe(false)
  })

  it('starts the cleanup with the same ancestry check and reports a removed worktree whose branch was kept', async () => {
    const f = laneHost(command =>
      command.includes('git worktree remove')
        ? { code: 1, output: '[granny] lane merged\n[granny] lane worktree clean\n[granny] lane worktree removed\nerror: the branch is not fully merged' }
        : undefined,
    )
    const r = await runGranny(f.host, laneInput)
    const cleanup = f.commands.find(c => c.includes('git worktree remove'))!
    expect(cleanup.startsWith('git merge-base --is-ancestor feat/x--s2-two HEAD && ')).toBe(true)
    expect(r.stages[1]!.note).toBe('ran in parallel on feat/x--s2-two, merged; its worktree /work/a-worktrees/feat-x--s2-two was removed, but its branch feat/x--s2-two was left in place')
  })

  it('says both the worktree and the branch were left in place when the cleanup stopped before removing anything', async () => {
    const f = laneHost(command => (command.includes('git worktree remove') ? { code: 1, output: '[granny] lane merged\n' } : undefined))
    const r = await runGranny(f.host, laneInput)
    expect(r.stages[1]!.note).toBe(
      'ran in parallel on feat/x--s2-two, merged; its worktree /work/a-worktrees/feat-x--s2-two and branch feat/x--s2-two were left in place (uncommitted changes in the worktree)',
    )
    expect(f.logs).toContainEqual(expect.stringContaining('merge two: left /work/a-worktrees/feat-x--s2-two (feat/x--s2-two) in place'))
  })

  it('merges and cleans up as before when the lane is in HEAD', async () => {
    const f = laneHost(() => undefined)
    const r = await runGranny(f.host, laneInput)
    expect(r.stages[1]!.note).toBe('ran in parallel on feat/x--s2-two, merged')
    expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean'])
  })
})

it('documents a run input that checkInput accepts in the config reference', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const md = fs.readFileSync(require('node:path').join(import.meta.dir, '../skills/granny-workflow/references/config.md'), 'utf8')
  const block = /```jsonc\n([\s\S]*?)```/.exec(md)![1]!
  expect(checkInput(JSON.parse(block))).toEqual([])
})

it('runs the lane setup, the merge and the cleanup through granny helper agents on Claude Code', async () => {
  const f = fakeHost({
    name: 'claude-code',
    direct: false,
    worktree: (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd,
    override: async req => (req.label === 'implement one' ? new Promise(r => setTimeout(() => r(undefined), 15)) : undefined),
  })
  const r = await runGranny(f.host, {
    repo: A,
    branch: 'feat/x',
    repos: [B],
    stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', after: [] }, { name: 'bee', task: 'c', repo: B }],
  })
  expect(f.setups.map(s => s.request!.label)).toEqual(['worktree', 'worktree b', 'worktree two'])
  expect(f.setups[2]!.command).toContain(`cd ${A} && `)
  const merge = f.calls.find(c => c.label === 'merge two')!
  expect(merge.kind).toBe('command')
  expect(merge.cwd).toBe('/work/a-worktrees/feat-x')
  expect(merge.prompt).toContain('cd /work/a-worktrees/feat-x && git merge --no-edit feat/x--s2-two')
  expect(f.calls.find(c => c.label === 'cleanup two')!.prompt).toContain('git worktree remove --force /work/a-worktrees/feat-x--s2-two')
  expect(f.calls.find(c => c.label === 'implement two')!.cwd).toBe('/work/a-worktrees/feat-x--s2-two')
  expect(f.calls.find(c => c.label === 'implement bee')!.cwd).toBe('/work/b-worktrees/feat-x')
  expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean', 'clean'])
})

it('tells only a stage that builds on earlier work in its repo to read the earlier stages', async () => {
  const f = fakeHost()
  await runGranny(f.host, {
    repo: A,
    branch: 'feat/x',
    repos: [B],
    stages: [{ name: 'one', task: 'a' }, { name: 'two', task: 'b', after: [] }, { name: 'bee', task: 'c', repo: B }, { name: 'three', task: 'd', after: [2] }],
  })
  const prompt = (label: string) => f.calls.find(c => c.label === label)!.prompt
  expect(prompt('implement one')).not.toContain('Earlier stages')
  expect(prompt('implement two')).toContain('This stage does not build on the other stages')
  expect(prompt('implement bee')).toContain('This stage does not build on the other stages')
  expect(prompt('implement three')).toContain('Earlier stages in this repo are done and reviewed')
})
