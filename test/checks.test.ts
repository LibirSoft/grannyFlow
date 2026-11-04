import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest, CommandResult } from '../src/core/types'
import { fakeHost, type FakeOptions } from './fake-host'

const REPO = '/work/repo'
const TESTS = { name: 'tests', run: 'run-tests' }
const LINT = { name: 'lint', run: 'run-lint' }

const run = (config: Record<string, unknown> = {}, extra: Partial<RunInput> = {}): RunInput => ({
  repo: REPO,
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'WP-01' }],
  config: { worktree: false, ...config },
  ...extra,
})

const red = (output = 'FAIL: expected 2, got 3'): CommandResult => ({ code: 1, output })
const green = (output = 'ok'): CommandResult => ({ code: 0, output })

function scripted(answers: Record<string, Array<CommandResult | string>>, opts: FakeOptions = {}) {
  const events: string[] = []
  const left = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]))
  const f = fakeHost({
    ...opts,
    checks: command => {
      const key = Object.keys(left).find(k => command.includes(k))
      if (key === undefined) return undefined
      events.push(`check ${key}`)
      const list = left[key]!
      return list.length > 1 ? list.shift() : list[0]
    },
    override: (req: AgentRequest) => {
      events.push(req.label)
      return opts.override?.(req)
    },
  })
  return { ...f, events }
}

const p1 = { findings: [{ id: 'F1', severity: 'P1', file: 'src/a.ts', line: 3, title: 'broken', detail: 'd' }] }

describe('checks', () => {
  it('are off by default: no check commands, no Checks phase, no checks in the result', async () => {
    const f = scripted({})
    const r = await runGranny(f.host, run())
    expect(f.commands).toEqual([])
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'review core r1 reviewer', 'pr-ready check'])
    expect(f.phases).not.toContain('Checks')
    expect(r.stages[0]).not.toHaveProperty('checks')
    expect(r).not.toHaveProperty('checks')
  })

  it('run after the implementer and before the review; green checks let the review run', async () => {
    const f = scripted({ 'run-tests': [green()] })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.events).toEqual(['implement core', 'check run-tests', 'review core r1 reviewer', 'pr-ready check'])
    expect(f.cwds).toEqual([REPO])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 1, results: [{ name: 'tests', passed: true, code: 0 }] }] })
    expect(r).not.toHaveProperty('checks')
    expect(f.logs).toContain('final review: final checks not rerun - 1 (core) ran them green last on deadbee2, HEAD unchanged')
    expect(f.phases.slice(0, 3)).toEqual(['Implement', 'Checks', 'Review'])
    expect(f.logs).toContain('core: checks green (implement: tests)')
  })

  it('send failing checks to the implementer for a repair, rerun them, then review', async () => {
    const output = `${'x'.repeat(5000)}\nFAIL: expected 2, got 3`
    const f = scripted({ 'run-tests': [red(output), green()] })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.events.slice(0, 5)).toEqual(['implement core', 'check run-tests', 'repair core implement #1', 'check run-tests', 'review core r1 reviewer'])
    const repair = f.calls.find(c => c.label === 'repair core implement #1')!
    expect(repair.kind).toBe('implementation')
    expect(repair.phase).toBe('Implement')
    expect(repair.prompt).toContain('FAIL: expected 2, got 3')
    expect(repair.prompt).toContain('`run-tests`')
    expect(repair.prompt).toContain('Exit code: 1')
    expect(repair.prompt).toContain('WP-01')
    expect(repair.prompt).toContain('NEVER delete, skip, disable or weaken a test, a check, a threshold, the granny config or a check script')
    expect(repair.prompt).not.toContain('x'.repeat(3001))
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(r.stages[0]!.rounds).toBe(1)
    expect(r.stages[0]!.checks?.map(c => [c.at, c.attempt, c.results[0]!.passed])).toEqual([
      ['implement', 1, false],
      ['implement', 2, true],
    ])
    expect(JSON.stringify(r.stages[0]!.checks)).not.toContain('FAIL')
    expect(f.logs).toContain('core: check tests failed (exit 1) - repair 1/2')
    expect(f.logs).toContain('core: checks green after 1 repair (implement: tests)')
  })

  it('end the stage checks-failed when the repair budget runs out, skip the review and the stages built on it', async () => {
    const giveUp = (req: AgentRequest) =>
      req.label === 'repair core implement #2' ? { startSha: 's', headSha: 'h', gatesGreen: false, gates: 'red', commits: [], untested: '', deviations: 'the test pins a removed API' } : undefined
    const f = scripted({ 'run-tests': [red()] }, { override: giveUp })
    const r = await runGranny(f.host, run({ checks: [TESTS] }, { stages: [{ name: 'core', task: 'WP-01' }, { name: 'more', task: 'WP-02' }] }))
    expect(f.calls.filter(c => c.label.startsWith('repair core')).map(c => c.label)).toEqual(['repair core implement #1', 'repair core implement #2'])
    expect(f.calls.some(c => c.label.startsWith('review core'))).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 0 })
    expect(r.stages[0]!.note).toContain('tests (exit 1)')
    expect(r.stages[0]!.note).toContain("the last repair's deviations: the test pins a removed API")
    expect(r.stages[0]!.checks).toHaveLength(3)
    expect(r.stages[1]).toMatchObject({ stage: 'more', outcome: 'skipped' })
    expect(r.stages[1]!.note).toContain('ended checks-failed')
    expect(f.calls.some(c => c.label === 'implement more')).toBe(false)
  })

  describe('metric', () => {
    const coverage = (metric: Record<string, unknown>, output: string) => async () => {
      const f = scripted({ 'run-cov': [green(output)] })
      const r = await runGranny(f.host, run({ checks: [{ name: 'cov', run: 'run-cov', maxRepairs: 0, metric: { pattern: 'coverage: ([0-9.]+)%', ...metric } }] }))
      return { f, r, stage: r.stages[0]! }
    }

    it('fails above max, with the value in the result and the note', async () => {
      const { f, stage } = await coverage({ max: 90 }, 'coverage: 95.5%')()
      expect(stage.outcome).toBe('checks-failed')
      expect(stage.checks?.[0]!.results[0]).toEqual({ name: 'cov', passed: false, code: 0, metric: 95.5, note: 'metric 95.5 is above max 90' })
      expect(f.calls.some(c => c.label.startsWith('review'))).toBe(false)
    })

    it('passes within the bounds, reading the last match', async () => {
      const { stage } = await coverage({ min: 80, max: 100 }, 'coverage: 12%\nfiles...\ncoverage: 85%\n')()
      expect(stage.outcome).toBe('clean')
      expect(stage.checks?.[0]!.results[0]).toMatchObject({ passed: true, metric: 85 })
    })

    it('fails below min', async () => {
      const { stage } = await coverage({ min: 80 }, 'coverage: 79.9%')()
      expect(stage.checks?.[0]!.results[0]).toMatchObject({ passed: false, metric: 79.9, note: 'metric 79.9 is below min 80' })
    })

    it('fails when the metric is not in the output', async () => {
      const { stage } = await coverage({ min: 80 }, 'all tests passed')()
      expect(stage.outcome).toBe('checks-failed')
      expect(stage.checks?.[0]!.results[0]).toEqual({ name: 'cov', passed: false, code: 0, note: 'metric not found in output' })
      expect(stage.note).toContain('metric not found in output')
    })

    it("on Claude Code, reads the metric from what the check printed, never from the helper's note", async () => {
      const f = scripted({ 'run-cov': [green('coverage: 60%')] }, { name: 'claude-code', direct: false, note: c => (c.includes('run-cov') ? 'Ran it, coverage: 95%' : undefined) })
      const r = await runGranny(f.host, run({ checks: [{ name: 'cov', run: 'run-cov', maxRepairs: 0, metric: { pattern: 'coverage: ([0-9.]+)%', min: 80 } }] }))
      expect(r.stages[0]!.checks?.[0]!.results[0]).toEqual({ name: 'cov', passed: false, code: 0, metric: 60, note: 'metric 60 is below min 80' })
    })

    it('fails on a non-zero exit even when the metric is in bounds', async () => {
      const f = scripted({ 'run-cov': [{ code: 2, output: 'coverage: 90%' }] })
      const r = await runGranny(f.host, run({ maxRepairs: 0, checks: [{ name: 'cov', run: 'run-cov', metric: { pattern: 'coverage: ([0-9.]+)%', min: 80 } }] }))
      expect(r.stages[0]!.checks?.[0]!.results[0]).toEqual({ name: 'cov', passed: false, code: 2 })
    })
  })

  it("use a check's own maxRepairs over the global one", async () => {
    const none = scripted({ 'run-tests': [red()] })
    const r1 = await runGranny(none.host, run({ maxRepairs: 5, checks: [{ ...TESTS, maxRepairs: 0 }] }))
    expect(r1.stages[0]!.outcome).toBe('checks-failed')
    expect(none.calls.some(c => c.label.startsWith('repair'))).toBe(false)

    const one = scripted({ 'run-tests': [red()] })
    const r2 = await runGranny(one.host, run({ maxRepairs: 0, checks: [{ ...TESTS, maxRepairs: 1 }] }))
    expect(r2.stages[0]!.outcome).toBe('checks-failed')
    expect(one.calls.filter(c => c.label.startsWith('repair core')).map(c => c.label)).toEqual(['repair core implement #1'])
    expect(one.logs).toContain('core: check tests failed (exit 1) - repair 1/1')
  })

  it('run only the checks a stage selects; the final gate runs the ones its repo\'s stages selected', async () => {
    const f = scripted({ 'run-tests': [green()], 'run-lint': [green()] })
    const r = await runGranny(
      f.host,
      run({ checks: [TESTS, LINT] }, { stages: [{ name: 'core', task: 'WP-01', checks: ['lint'] }, { name: 'docs', task: 'WP-02', checks: [] }] }),
    )
    expect(f.events.filter(e => e.startsWith('check') || e.startsWith('implement'))).toEqual(['implement core', 'check run-lint', 'implement docs', 'check run-lint'])
    expect(r.stages[0]!.checks?.[0]!.results.map(x => x.name)).toEqual(['lint'])
    expect(r.stages[1]).not.toHaveProperty('checks')
    expect(r.checks?.[0]!.results.map(x => x.name)).toEqual(['lint'])
  })

  it('run every check at the final gate when a stage of the repo selects none by name', async () => {
    const f = scripted({ 'run-tests': [green()], 'run-lint': [green()] })
    const r = await runGranny(f.host, run({ checks: [TESTS, LINT] }, { stages: [{ name: 'core', task: 'WP-01', checks: ['lint'] }, { name: 'docs', task: 'WP-02' }] }))
    expect(r.checks?.[0]!.results.map(x => x.name)).toEqual(['tests', 'lint'])
  })

  it('skip the final gate in a repo whose stages opted out of every check', async () => {
    const B = '/work/b'
    const f = scripted({ 'run-tests': [green()] })
    const r = await runGranny(
      f.host,
      run({ checks: [TESTS] }, { repos: [B], stages: [{ name: 'api', task: 'WP-01' }, { name: 'api2', task: 'WP-03' }, { name: 'web', task: 'WP-02', repo: B, checks: [] }] }),
    )
    expect(f.cwds).toEqual([REPO, REPO, REPO])
    expect(f.calls.some(c => c.label.startsWith('repair'))).toBe(false)
    expect(r.repos?.[0]).toHaveProperty('checks')
    expect(r.repos?.[1]).not.toHaveProperty('checks')
    expect(r.repos?.[1]!.finalReview?.outcome).not.toBe('checks-failed')
  })

  it('run after every fix round and stop the loop before the next review when they fail', async () => {
    const f = scripted(
      { 'run-tests': [green(), red('broke after fix')] },
      { override: req => (req.label === 'review core r1 reviewer' ? p1 : undefined) },
    )
    const r = await runGranny(f.host, run({ maxRepairs: 0, checks: [TESTS] }))
    expect(f.events).toEqual(['implement core', 'check run-tests', 'review core r1 reviewer', 'fix core r1', 'check run-tests', 'pr-ready check'])
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed', note: 'checks failed at final: 1 (core) ended with tests red on deadbee3, HEAD unchanged' })
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 1 })
    expect(r.stages[0]!.checks?.map(c => [c.at, c.results[0]!.passed])).toEqual([
      ['implement', true],
      ['fix r1', false],
    ])
    expect(r.stages[0]!.history).toHaveLength(1)
  })

  it('keep an earlier round\'s residual findings when the checks fail after a later fix', async () => {
    const two = { findings: [{ id: 'F1', severity: 'P2', file: 'src/a.ts', line: 3, title: 'real', detail: 'd' }, { id: 'F2', severity: 'P3', file: 'src/a.ts', line: 9, title: 'nit', detail: 'd' }] }
    const f = scripted(
      { 'run-tests': [green(), green(), red('broke after fix')] },
      {
        scores: [{ 'reviewer-F1': 90, 'reviewer-F2': 10 }],
        override: req => (req.label === 'review core r1 reviewer' ? two : req.label === 'review core r2 reviewer' ? p1 : undefined),
      },
    )
    const r = await runGranny(f.host, run({ maxRepairs: 0, checks: [TESTS] }))
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 2 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['nit'])
  })

  it('repair a fix round and then review again', async () => {
    const f = scripted(
      { 'run-tests': [green(), red(), green()] },
      { override: req => (req.label === 'review core r1 reviewer' ? p1 : undefined) },
    )
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.events.slice(0, 8)).toEqual([
      'implement core',
      'check run-tests',
      'review core r1 reviewer',
      'fix core r1',
      'check run-tests',
      'repair core fix r1 #1',
      'check run-tests',
      'review core r2 reviewer',
    ])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
  })

  it('not start a later stage on a branch a checks-failed stage left red, even one that does not build on it', async () => {
    const f = scripted({ 'run-tests': [red()] })
    const r = await runGranny(
      f.host,
      run({ parallel: false, maxRepairs: 0, checks: [TESTS] }, { stages: [{ name: 'core', task: 'WP-01' }, { name: 'docs', task: 'WP-02', after: [] }] }),
    )
    expect(r.stages[0]!.outcome).toBe('checks-failed')
    expect(r.stages[1]).toMatchObject({ stage: 'docs', outcome: 'skipped' })
    expect(r.stages[1]!.note).toBe('not started: 1 (core) ended checks-failed and left its red commits on feat/x in this repo')
    expect(f.calls.some(c => c.label === 'implement docs')).toBe(false)
  })

  it('still start a later stage in another repo after a checks-failed stage', async () => {
    const B = '/work/b'
    const f = scripted({ 'run-tests': [red()] })
    const r = await runGranny(
      f.host,
      run({ parallel: false, maxRepairs: 0, checks: [TESTS] }, { repos: [B], stages: [{ name: 'core', task: 'WP-01' }, { name: 'web', task: 'WP-02', repo: B, after: [], checks: [] }] }),
    )
    expect(r.stages.map(x => x.outcome)).toEqual(['checks-failed', 'clean'])
  })

  it('leave a parallel lane that ended checks-failed unmerged, with its worktree in place', async () => {
    const lanePath = (command: string, cwd: string) => /wt='?([^';]+)'?; git worktree add/.exec(command)?.[1] ?? cwd
    const slow = async (req: AgentRequest) => {
      if (req.kind !== 'implementation') return undefined
      await new Promise(r => setTimeout(r, 15))
      return { startSha: 's', headSha: 'h', gatesGreen: true, gates: 'green', commits: [], untested: '' }
    }
    const f = scripted({ 'check-a': [green()], 'check-b': [red()] }, { worktree: lanePath, override: slow })
    const r = await runGranny(
      f.host,
      run(
        { worktree: true, maxRepairs: 0, checks: [{ name: 'a', run: 'check-a' }, { name: 'b', run: 'check-b' }] },
        { stages: [{ name: 'one', task: 'WP-01', checks: ['a'] }, { name: 'two', task: 'WP-02', after: [], checks: ['b'] }] },
      ),
    )
    const lane = '/work/repo-worktrees/feat-x--s2-two'
    expect(f.calls.find(c => c.label === 'implement two')!.cwd).toBe(lane)
    expect(r.stages[1]!.outcome).toBe('checks-failed')
    expect(f.commands.some(c => c.startsWith('git merge'))).toBe(false)
    expect(f.commands.some(c => c.includes('git worktree remove'))).toBe(false)
    expect(r.stages[1]!.note).toContain(`ran in parallel on feat/x--s2-two; its checks stayed red, so it was not merged - its worktree ${lane} is left in place`)
  })

  it('take over from the self-reported gates: green checks keep a red-gates stage clean', async () => {
    const redGates = (req: AgentRequest) =>
      req.kind === 'implementation' ? { startSha: 'deadbee1', headSha: 'h', gatesGreen: false, gates: '1 failing', commits: ['c'], untested: '' } : undefined
    const checked = scripted({ 'run-tests': [green()] }, { override: redGates })
    expect((await runGranny(checked.host, run({ checks: [TESTS] }))).stages[0]!.outcome).toBe('clean')
    const unchecked = scripted({}, { override: redGates })
    expect((await runGranny(unchecked.host, run())).stages[0]!.outcome).toBe('gates-red')
  })

  it('wrap a check with a timeout in timeout(1) and name a timeout in the note', async () => {
    const f = scripted({ 's slow': [{ code: 124, output: '' }] })
    const r = await runGranny(f.host, run({ maxRepairs: 0, checks: [{ name: 'slow', run: "echo it's slow", timeout: 30 }] }))
    expect(f.commands[0]).toBe(`timeout 30 bash -c 'echo it'\\''s slow'`)
    expect(r.stages[0]!.checks?.[0]!.results[0]).toEqual({ name: 'slow', passed: false, code: 124, note: 'timed out after 30s' })
  })

  describe('the timeout command', () => {
    const temp: string[] = []
    const tempDir = (prefix: string) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
      temp.push(dir)
      return dir
    }
    afterAll(() => temp.forEach(dir => rmSync(dir, { recursive: true, force: true })))
    const bin = (...tools: Array<[string, string]>) => {
      const dir = tempDir('granny-bin-')
      for (const [name, target] of [['bash', Bun.which('bash')!] as [string, string], ...tools]) symlinkSync(target, join(dir, name))
      return dir
    }
    const timed = (timeout = 5) => ({ name: 'tests', run: 'true', timeout })
    const inRepo = (config: Record<string, unknown>, extra: Partial<RunInput> = {}) => run(config, { repo: tempDir('granny-repo-'), ...extra })

    it('is gtimeout when only gtimeout is on PATH, probed once per run', async () => {
      const f = fakeHost({ shell: { env: { PATH: bin(['gtimeout', (Bun.which('timeout') ?? Bun.which('gtimeout'))!]) } } })
      const r = await runGranny(f.host, inRepo({ checks: [timed()] }, { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
      expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean'])
      expect(f.commands.filter(c => c.includes('bash -c true'))).toEqual(['gtimeout 5 bash -c true', 'gtimeout 5 bash -c true', 'gtimeout 5 bash -c true'])
      expect(f.probes.filter(c => c.includes('command -v gtimeout')).length).toBe(1)
    })

    it('fails the run before any agent starts when neither timeout nor gtimeout is on PATH', async () => {
      const f = fakeHost({ shell: { env: { PATH: bin() } } })
      const failed = runGranny(f.host, inRepo({ checks: [timed()] }))
      await expect(failed).rejects.toThrow('neither `timeout` nor `gtimeout` is on PATH')
      await expect(failed).rejects.toThrow('brew install coreutils')
      await expect(failed).rejects.toThrow('tests')
      expect(f.calls).toEqual([])
    })

    it('is probed through the helper on Claude Code, and its absence fails the run there too', async () => {
      const g = fakeHost({ name: 'claude-code', direct: false, timeoutProbe: 'gtimeout\n' })
      expect((await runGranny(g.host, run({ checks: [timed(30)] }))).stages[0]!.outcome).toBe('clean')
      expect(g.commands).toContain('cd /work/repo && gtimeout 30 bash -c true')
      const none = fakeHost({ name: 'claude-code', direct: false, timeoutProbe: { code: 1, output: '' } })
      await expect(runGranny(none.host, run({ checks: [timed()] }))).rejects.toThrow('brew install coreutils')
      expect(none.calls).toEqual([])
    })

    it('is not probed when no check has a timeout', async () => {
      const f = scripted({ 'run-tests': [green()] })
      await runGranny(f.host, run({ checks: [TESTS] }))
      expect(f.probes.some(c => c.includes('command -v gtimeout'))).toBe(false)
    })

    it('missing at run time (exit 127) is a runner failure that spends no repair', async () => {
      const f = scripted({ 'bash -c true': [{ code: 127, output: 'bash: line 1: timeout: command not found\n' }] })
      const r = await runGranny(f.host, run({ maxRepairs: 2, checks: [timed()] }))
      expect(r.stages[0]!.outcome).toBe('checks-failed')
      expect(r.stages[0]!.note).toContain('check runner failed')
      expect(r.stages[0]!.checks?.[0]!.results[0]).toMatchObject({ code: 127, note: 'timeout command not found' })
      expect(f.calls.filter(c => c.label.startsWith('repair'))).toEqual([])
    })

    it('present, a check whose own command is missing (exit 127) is still a red check that gets repairs', async () => {
      const f = scripted({ 'bash -c true': [{ code: 127, output: 'bash: line 1: bun: command not found\n' }, green()] })
      const r = await runGranny(f.host, run({ maxRepairs: 2, checks: [timed()] }))
      expect(r.stages[0]!.outcome).toBe('clean')
      expect(f.calls.map(c => c.label)).toContain('repair core implement #1')
    })
  })

  it('surface a failed final gate at run level: no final review, the final check still runs', async () => {
    const f = scripted({ 'run-tests': [green(), green(), red('integration broke')] })
    const r = await runGranny(f.host, run({ maxRepairs: 1, checks: [TESTS] }, { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean'])
    expect(f.calls.some(c => c.label.startsWith('review final review'))).toBe(false)
    expect(f.calls.map(c => c.label)).toContain('repair final review final #1')
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed', rounds: 0 })
    expect(r.finalReview!.note).toContain('tests (exit 1)')
    expect(r.checks?.map(c => [c.at, c.attempt])).toEqual([
      ['final', 1],
      ['final', 2],
    ])
    expect(r.final).not.toBeNull()
    expect(f.logs.some(l => l.includes('not PR-ready'))).toBe(true)
  })

  it('give the final gate no repairs when no final review follows to see them', async () => {
    const off = scripted({ 'run-tests': [green(), green(), red()] })
    const r2 = await runGranny(off.host, run({ finalReview: false, checks: [TESTS] }, { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(off.calls.some(c => c.label.startsWith('repair final review'))).toBe(false)
    expect(r2.finalReview?.outcome).toBe('checks-failed')
    expect(r2.checks).toHaveLength(1)
    expect(off.logs).toContain('final review: the final checks get no repairs - no final review follows to see one')
  })

  it('not rerun the stage\'s own checks at the final gate of a one-stage repo, even with other checks configured', async () => {
    const f = scripted({ 'run-tests': [green()], 'run-lint': [green(), red('lint broke')] })
    const r = await runGranny(f.host, run({ checks: [TESTS, LINT] }, { stages: [{ name: 'core', task: 'WP-01', checks: ['tests'] }] }))
    expect(f.events.filter(e => e.startsWith('check'))).toEqual(['check run-tests'])
    expect(r.finalReview?.outcome).toBe('skipped')
  })

  it('rerun the checks at the final gate, and once more after the pr-ready check, when HEAD cannot be read', async () => {
    const f = scripted({ 'run-tests': [green()] })
    const run0 = f.host.run!
    f.host.run = async (command, cwd) => (command.includes('git rev-parse --verify HEAD') ? { code: 128, output: 'fatal: not a git repository' } : run0(command, cwd))
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.events.filter(e => e.startsWith('check') || e === 'pr-ready check')).toEqual(['check run-tests', 'check run-tests', 'pr-ready check', 'check run-tests'])
    expect(r.stages[0]!.checks?.[0]).not.toHaveProperty('head')
    expect(f.logs).toContain('final review: running the final checks - could not read the HEAD 1 (core) last ran them on, so their result is not reused')
    expect(f.logs).toContain('pr-ready check: could not read HEAD after the pr-ready check or at the final checks - running them once more, without repairs')
    expect(r.checks?.map(c => c.at)).toEqual(['final', 'pr-ready'])
    expect(r.recheck).toEqual({ passed: true })
  })

  it('name an unknown branch state, not red commits, when a stage was skipped after a check runner failed', async () => {
    const f = scripted(
      { 'run-tests': [green()] },
      { name: 'claude-code', direct: false, override: req => (req.label === 'check core tests' ? null : undefined) },
    )
    const r = await runGranny(f.host, run({ parallel: false, checks: [TESTS] }, { stages: [{ name: 'core', task: 'WP-01' }, { name: 'docs', task: 'WP-02', after: [] }] }))
    expect(r.stages[1]!.note).toBe('not started: 1 (core) ended checks-failed because its check runner failed, so the state of feat/x in this repo is unknown')
  })

  it('give the final gate no repairs in a repo where a stage already ended checks-failed', async () => {
    const f = scripted({ 'run-tests': [red()] })
    const r = await runGranny(f.host, run({ maxRepairs: 1, checks: [TESTS] }, { stages: [{ name: 'core', task: 'WP-01' }, { name: 'more', task: 'WP-02' }] }))
    expect(r.stages[0]!.outcome).toBe('checks-failed')
    expect(f.calls.filter(c => c.label.startsWith('repair')).map(c => c.label)).toEqual(['repair core implement #1'])
    expect(r.finalReview?.outcome).toBe('checks-failed')
    expect(f.logs).toContain('final review: the final checks get no repairs - 1 (core) already ended checks-failed')
  })

  it('gate the fix rounds of the final review', async () => {
    let reviews = 0
    const f = scripted(
      { 'run-tests': [green(), green(), green(), red()] },
      { override: req => (req.label.startsWith('review final review') && reviews++ === 0 ? p1 : undefined) },
    )
    const r = await runGranny(f.host, run({ maxRepairs: 0, checks: [TESTS] }, { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed', rounds: 1 })
    expect(r.checks?.map(c => [c.at, c.results[0]!.passed])).toEqual([
      ['final', true],
      ['fix r1', false],
    ])
  })

  it('run through a helper agent on Claude Code, in phase Checks', async () => {
    const f = scripted({ 'run-tests': [green('12 pass')] }, { name: 'claude-code', direct: false })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    const check = f.calls.find(c => c.label === 'check core tests')!
    expect(check).toMatchObject({ kind: 'command', role: 'granny', phase: 'Checks', cwd: REPO })
    expect(check.prompt).toContain(`cd ${REPO} && run-tests`)
    expect(check.prompt).toContain('Never invent output or an exit code')
    expect(f.calls.some(c => c.label === 'check final review tests')).toBe(false)
    expect(r.stages[0]!.outcome).toBe('clean')
  })

  it('on Claude Code, retry a check once when its runner returns nothing, and spend no repair on it', async () => {
    let nulls = 1
    const f = scripted({ 'run-tests': [green()] }, { name: 'claude-code', direct: false, override: req => (req.label === 'check core tests' && nulls-- > 0 ? null : undefined) })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.calls.filter(c => c.label === 'check core tests')).toHaveLength(2)
    expect(f.calls.some(c => c.label.startsWith('repair'))).toBe(false)
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(r.stages[0]!.checks?.map(c => c.results[0]!.passed)).toEqual([true])
    expect(f.logs).toContain('core: the check tests runner failed (exit ?) - running it once more')
  })

  it('on Claude Code, end the gate "check runner failed" without a repair when the runner fails twice', async () => {
    const f = scripted({ 'run-tests': [green()] }, { name: 'claude-code', direct: false, override: req => (req.label === 'check core tests' ? null : undefined) })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.calls.filter(c => c.label === 'check core tests')).toHaveLength(2)
    expect(f.calls.some(c => c.label.startsWith('repair') || c.label.startsWith('review core'))).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 0 })
    expect(r.stages[0]!.note).toContain('check runner failed: tests')
    expect(r.stages[0]!.checks?.[0]!.results[0]).toMatchObject({ name: 'tests', passed: false, code: '?', note: 'check runner failed' })
    expect(f.calls.filter(c => c.label === 'check final review tests')).toHaveLength(1)
  })

  it('on Claude Code, ask the helper to keep every line the metric matches when it shortens a long output', async () => {
    const pattern = 'All files\\s*\\|\\s*([0-9.]+)'
    const f = scripted({ 'run-cov': [green('All files | 91.2\n')], 'run-tests': [green()] }, { name: 'claude-code', direct: false })
    const r = await runGranny(f.host, run({ checks: [{ name: 'cov', run: 'run-cov', metric: { pattern, min: 80 } }, TESTS] }))
    const cov = f.calls.find(c => c.label === 'check core cov')!.prompt
    expect(cov).toContain(`every line that matches the regular expression \`${pattern}\``)
    expect(cov).toContain('then the last 3000 characters')
    const tests = f.calls.find(c => c.label === 'check core tests')!.prompt
    expect(tests).not.toContain('regular expression')
    expect(tests).toContain('the last 3000 characters are enough')
    expect(r.stages[0]!.checks?.[0]!.results[0]).toMatchObject({ name: 'cov', passed: true, metric: 91.2 })
  })

  it('reject a stage that selects a check the config does not have, before anything runs', async () => {
    const f = scripted({})
    await expect(runGranny(f.host, run({ checks: [TESTS] }, { stages: [{ name: 'core', task: 'WP-01', checks: ['tset'] }] }))).rejects.toThrow(
      'stages[0].checks names "tset", which is not in config checks (tests)',
    )
    await expect(runGranny(f.host, run({}, { stages: [{ name: 'core', task: 'WP-01', checks: 'tests' as never }] }))).rejects.toThrow('stages[0].checks must be an array of check names')
    expect(f.calls).toEqual([])
  })
})

describe('checks config', () => {
  it('defaults to no checks and two repairs', () => {
    const c = resolveConfig([])
    expect(c.checks).toEqual([])
    expect(c.maxRepairs).toBe(2)
  })

  it('accepts a full check and replaces the list across layers', () => {
    const full = { name: 'cov', run: 'bun test --coverage', maxRepairs: 0, timeout: 600, metric: { pattern: 'All files\\s*\\|\\s*([0-9.]+)', min: 80 } }
    const c = resolveConfig([{ checks: [TESTS] }, { checks: [full], maxRepairs: 3 }])
    expect(c.checks).toEqual([full])
    expect(c.maxRepairs).toBe(3)
  })

  const bad: Array<[string, unknown, string]> = [
    ['a non-array', { checks: { name: 'x' } }, 'checks must be an array'],
    ['a missing name', { checks: [{ run: 'x' }] }, 'checks[0].name must be a non-empty string'],
    ['a blank name', { checks: [{ name: ' ', run: 'x' }] }, 'checks[0].name must be a non-empty string'],
    ['a duplicate name', { checks: [TESTS, { name: 'tests', run: 'y' }] }, 'checks[1].name "tests" is already used by checks[0]'],
    ['an empty run', { checks: [{ name: 'x', run: '' }] }, 'checks[0].run must be a non-empty command string'],
    ['an unknown key', { checks: [{ ...TESTS, cmd: 'x' }] }, 'unknown key "checks[0].cmd"'],
    ['a negative maxRepairs', { checks: [{ ...TESTS, maxRepairs: -1 }] }, 'checks[0].maxRepairs must be an integer >= 0'],
    ['a fractional maxRepairs', { checks: [{ ...TESTS, maxRepairs: 1.5 }] }, 'checks[0].maxRepairs must be an integer >= 0'],
    ['a zero timeout', { checks: [{ ...TESTS, timeout: 0 }] }, 'checks[0].timeout must be a number of seconds > 0'],
    ['a pattern that does not compile', { checks: [{ ...TESTS, metric: { pattern: '([0-9]+', min: 1 } }] }, 'checks[0].metric.pattern is not a valid regular expression'],
    ['a pattern without a capture group', { checks: [{ ...TESTS, metric: { pattern: '[0-9]+', min: 1 } }] }, 'checks[0].metric.pattern needs a capture group'],
    ['a metric without bounds', { checks: [{ ...TESTS, metric: { pattern: '([0-9]+)' } }] }, 'checks[0].metric needs min, max or both'],
    ['a non-numeric bound', { checks: [{ ...TESTS, metric: { pattern: '([0-9]+)', max: '90' } }] }, 'checks[0].metric.max must be a number'],
    ['an unknown metric key', { checks: [{ ...TESTS, metric: { pattern: '([0-9]+)', min: 1, flags: 'i' } }] }, 'unknown key "checks[0].metric.flags"'],
    ['min above max', { checks: [{ ...TESTS, metric: { pattern: '([0-9]+)', min: 9, max: 1 } }] }, 'checks[0].metric.min must not be above max'],
    ['a negative global maxRepairs', { maxRepairs: -1 }, 'maxRepairs must be an integer >= 0'],
  ]
  for (const [label, layer, message] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => resolveConfig([layer])).toThrow(message)
    })
  }

  it('lists every check problem at once', () => {
    let message = ''
    try {
      resolveConfig([{ checks: [{ name: 'a' }, { name: 'a', run: 'x', timeout: -1 }] }])
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('checks[0].run')
    expect(message).toContain('checks[1].name "a" is already used')
    expect(message).toContain('checks[1].timeout')
  })
})

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const init = (repo: string) => {
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
}
const commit = (cwd: string, file: string, text?: string) => {
  if (text === undefined) git(cwd, 'rm', '-q', file)
  else {
    writeFileSync(join(cwd, file), text)
    git(cwd, 'add', file)
  }
  git(cwd, 'commit', '-qm', `${text === undefined ? 'fix' : 'test'}: ${file}`)
}
const done = (cwd: string, start: string) => ({ startSha: start, headSha: git(cwd, 'rev-parse', 'HEAD'), gatesGreen: true, gates: 'green', commits: [], untested: '' })

describe('the HEAD a check gate ran on, in a real git repo', () => {
  const GOOD = { name: 'tests', run: 'grep -qx good f.txt' }
  const FINAL = { gatesGreen: true, gates: 'all green', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
  const oneStage = async (after: (req: AgentRequest, repo: string) => unknown = () => undefined) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'granny-check-head-')))
    const repo = join(root, 'r')
    init(repo)
    git(repo, 'checkout', '-qb', 'feat/x')
    let gated = ''
    const f = fakeHost({
      commits: 'git',
      shell: {},
      override: req => {
        if (req.kind !== 'implementation') return after(req, repo)
        const start = git(repo, 'rev-parse', 'HEAD')
        commit(repo, 'f.txt', 'good\n')
        gated = git(repo, 'rev-parse', 'HEAD')
        return done(repo, start)
      },
    })
    try {
      const r = await runGranny(f.host, { repo, branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'WP-01' }], config: { worktree: false, checks: [GOOD] } })
      return { f, r, gated, head: git(repo, 'rev-parse', 'HEAD'), checkRuns: f.commands.filter(c => c.includes(GOOD.run)).length }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('records the HEAD each gate ran on and reuses the stage result at the final gate while HEAD is unchanged', async () => {
    const { f, r, gated, checkRuns } = await oneStage()
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 1, head: gated, results: [{ name: 'tests', passed: true, code: 0 }] }] })
    expect(checkRuns).toBe(1)
    expect(f.logs).toContain(`final review: final checks not rerun - 1 (core) ran them green last on ${gated.slice(0, 8)}, HEAD unchanged`)
    expect(r).not.toHaveProperty('checks')
    expect(r).not.toHaveProperty('recheck')
  })

  it('reruns the final checks when a reviewer committed after the last green gate, and they fail', async () => {
    const { f, r, gated, head, checkRuns } = await oneStage((req, repo) => {
      if (req.role !== 'reviewer') return undefined
      commit(repo, 'f.txt', 'bad\n')
      return { findings: [] }
    })
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
    expect(checkRuns).toBe(2)
    expect(f.logs).toContain(`final review: running the final checks - 1 (core) ran them last on ${gated.slice(0, 8)}, but HEAD is now ${head.slice(0, 8)}`)
    expect(f.logs.some(l => l.includes('nothing changed since'))).toBe(false)
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed' })
    expect(r.checks).toEqual([{ at: 'final', attempt: 1, head, results: [{ name: 'tests', passed: false, code: 1 }] }])
    expect(r).not.toHaveProperty('recheck')
  })

  it('reruns the checks once after the pr-ready check moved HEAD, and a red result marks the run not PR-ready', async () => {
    const { f, r, gated, head, checkRuns } = await oneStage((req, repo) => {
      if (req.kind !== 'final') return undefined
      commit(repo, 'f.txt', 'bad\n')
      return FINAL
    })
    expect(checkRuns).toBe(2)
    expect(f.calls.some(c => c.label.startsWith('repair'))).toBe(false)
    expect(r.checks).toEqual([{ at: 'pr-ready', attempt: 1, head, results: [{ name: 'tests', passed: false, code: 1 }] }])
    expect(r.recheck).toMatchObject({ passed: false })
    expect(r.recheck!.note).toContain('tests (exit 1)')
    expect(f.logs).toContain(`pr-ready check: HEAD moved from ${gated.slice(0, 8)} to ${head.slice(0, 8)} after the final checks - running them once more, without repairs`)
    expect(f.logs).toContain('pr-ready check: the checks are red after the pr-ready check - the branch is not PR-ready')
  })

  it('records a green recheck after the pr-ready check moved HEAD without breaking anything', async () => {
    const { r, head, checkRuns } = await oneStage((req, repo) => {
      if (req.kind !== 'final') return undefined
      commit(repo, 'notes.txt', 'pr body tweak\n')
      return FINAL
    })
    expect(checkRuns).toBe(2)
    expect(r.recheck).toEqual({ passed: true })
    expect(r.checks).toEqual([{ at: 'pr-ready', attempt: 1, head, results: [{ name: 'tests', passed: true, code: 0 }] }])
  })
})

describe('checks on a parallel lane in a real git repo', () => {
  it('branch a lane from where the busy stage started, not from its unfinished red commits', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'granny-checks-lane-')))
    const a = join(root, 'a')
    const b = join(root, 'b')
    try {
      init(a)
      init(b)
      const f = fakeHost({
        worktree: 'git',
        commits: 'git',
        shell: {},
        override: async req => {
          if (req.kind !== 'implementation') return undefined
          const start = git(req.cwd, 'rev-parse', 'HEAD')
          if (req.label === 'implement one') {
            commit(req.cwd, 'red.txt', 'a failing test, fixed in the next commit\n')
            await new Promise(r => setTimeout(r, 300))
            commit(req.cwd, 'red.txt')
          } else commit(req.cwd, `${req.label.split(' ')[1]}.txt`, 'x\n')
          return done(req.cwd, start)
        },
      })
      const r = await runGranny(f.host, {
        repo: a,
        repos: [b],
        branch: 'feat/x',
        base: 'main',
        stages: [
          { name: 'one', task: 'WP-01' },
          { name: 'pre', task: 'WP-02', repo: b, after: [], checks: [] },
          { name: 'two', task: 'WP-03', after: [2] },
        ],
        config: { reviewers: [{ name: 'a', engine: 'agent' }], maxRepairs: 0, checks: [{ name: 'tests', run: 'test ! -e red.txt' }] },
      })
      expect(r.stages.map(s => s.outcome)).toEqual(['clean', 'clean', 'clean'])
      expect(r.stages[2]!.note).toBe('ran in parallel on feat/x--s3-two, merged')
      const wt = join(root, 'a-worktrees', 'feat-x')
      expect(existsSync(join(wt, 'two.txt'))).toBe(true)
      expect(existsSync(join(wt, 'red.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('uncommitted work, in a real git repo', () => {
  const GOOD = { name: 'tests', run: 'grep -qx good f.txt' }
  const runDirty = async (
    onAsk: (req: AgentRequest, repo: string) => void,
    other: (req: AgentRequest, repo: string) => unknown = () => undefined,
    checks: unknown[] = [GOOD],
    first: (repo: string) => void = repo => {
      commit(repo, 'f.txt', 'bad\n')
      writeFileSync(join(repo, 'f.txt'), 'good\n')
    },
  ) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'granny-clean-tree-')))
    const repo = join(root, 'r')
    init(repo)
    git(repo, 'checkout', '-qb', 'feat/x')
    const f = fakeHost({
      commits: 'git',
      shell: {},
      override: req => {
        if (req.kind !== 'implementation') return other(req, repo)
        const start = git(repo, 'rev-parse', 'HEAD')
        if (req.label === 'implement core') first(repo)
        else onAsk(req, repo)
        return done(repo, start)
      },
    })
    try {
      const r = await runGranny(f.host, { repo, branch: 'feat/x', base: 'main', stages: [{ name: 'core', task: 'WP-01' }], config: { worktree: false, checks } })
      return {
        f,
        r,
        head: git(repo, 'rev-parse', 'HEAD'),
        committed: git(repo, 'show', 'HEAD:f.txt'),
        status: git(repo, 'status', '--porcelain'),
        checkRuns: f.commands.filter(c => c.includes(GOOD.run)).length,
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const commitAll = (_: AgentRequest, repo: string) => {
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'fix: f.txt')
  }

  it('asks the implementer to commit before a check gate runs, then checks the committed tree', async () => {
    const { f, r, head, committed, checkRuns } = await runDirty(commitAll)
    expect(f.calls.filter(c => c.kind === 'implementation').map(c => c.label)).toEqual(['implement core', 'commit core implement #1'])
    const ask = f.calls.find(c => c.label === 'commit core implement #1')!
    expect(ask.phase).toBe('Implement')
    expect(ask.prompt).toContain(' M f.txt')
    expect(ask.prompt).toContain('WP-01')
    expect(ask.prompt).toContain('never `git stash`')
    expect(f.logs).toContain('core: uncommitted changes before the checks at implement - repair 1/2: M f.txt')
    expect(committed).toBe('good')
    expect(checkRuns).toBe(1)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 2, head, results: [{ name: 'tests', passed: true, code: 0 }] }] })
  })

  it('ends the stage checks-failed without running the checks or a review while the work stays uncommitted', async () => {
    const { f, r, committed, status, checkRuns } = await runDirty(() => {})
    expect(f.calls.filter(c => c.kind === 'implementation').map(c => c.label)).toEqual(['implement core', 'commit core implement #1', 'commit core implement #2'])
    expect(checkRuns).toBe(0)
    expect(f.calls.some(c => c.role === 'reviewer')).toBe(false)
    expect(committed).toBe('bad')
    expect(status).toBe('M f.txt')
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 0 })
    expect(r.stages[0]).not.toHaveProperty('checks')
    expect(r.stages[0]!.note).toBe('checks not run at implement - uncommitted changes: M f.txt (still there after 2 repair(s))')
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed', note: 'checks not run at final - uncommitted changes: M f.txt' })
    expect(r.recheck).toMatchObject({ passed: false, note: 'checks not run at pr-ready - uncommitted changes: M f.txt' })
  })

  it('marks the run not PR-ready when the checks rerun after the pr-ready check leave the tree dirty', async () => {
    const writes = { name: 'tests', run: `${GOOD.run} && { [ ! -e notes.txt ] || echo report > out.txt; }` }
    const { f, r, head } = await runDirty(
      commitAll,
      (req, repo) => {
        if (req.kind !== 'final') return undefined
        commit(repo, 'notes.txt', 'pr body tweak\n')
        return { gatesGreen: true, gates: 'all green', commits: [], prBodyPath: '.granny/PR-BODY.md', issues: '' }
      },
      [writes],
    )
    expect(r.checks).toEqual([{ at: 'pr-ready', attempt: 1, head, results: [{ name: 'tests', passed: true, code: 0 }] }])
    expect(r.recheck).toEqual({ passed: false, note: 'uncommitted changes after the checks at pr-ready: ?? out.txt' })
    expect(f.logs).toContain('pr-ready check: the checks left uncommitted changes after the pr-ready check - the branch is not PR-ready: ?? out.txt')
  })
})

describe('plan files inside the repo, in a real git repo', () => {
  const GOOD = { name: 'tests', run: 'grep -qx good f.txt' }
  const runWithPlans = async (implement: (repo: string) => void, onAsk: (req: AgentRequest, repo: string) => void = () => {}) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'granny-plan-files-')))
    const repo = join(root, 'r')
    init(repo)
    commit(repo, 'plan.md', '# plan\n')
    git(repo, 'checkout', '-qb', 'feat/x')
    writeFileSync(join(repo, 'plan.md'), '# plan\n\n## r1 deltas\n')
    mkdirSync(join(repo, 'plans'))
    writeFileSync(join(repo, 'plans', "it's two.md"), '# two\n')
    const f = fakeHost({
      commits: 'git',
      shell: {},
      override: req => {
        if (req.kind !== 'implementation') return undefined
        const start = git(repo, 'rev-parse', 'HEAD')
        if (req.label === 'implement core') implement(repo)
        else onAsk(req, repo)
        return done(repo, start)
      },
    })
    try {
      const plan = [join(repo, 'plan.md'), join(repo, 'plans', "it's two.md")]
      const r = await runGranny(f.host, { repo, branch: 'feat/x', base: 'main', plan, stages: [{ name: 'core', task: 'WP-01' }], config: { worktree: false, checks: [GOOD] } })
      return { f, r, status: git(repo, 'status', '--porcelain'), asked: f.calls.filter(c => c.kind === 'implementation').map(c => c.label) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('does not count the uncommitted plan files as uncommitted work', async () => {
    const { f, r, status, asked } = await runWithPlans(repo => commit(repo, 'f.txt', 'good\n'))
    expect(asked).toEqual(['implement core'])
    const final = f.calls.find(c => c.kind === 'final')!.prompt
    expect(final).toMatch(/`git status --short` must be clean except for the plan files \S+\/r\/plan\.md, \S+\/r\/plans\/it's two\.md, which stay uncommitted: never stage or commit them\./)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 1, results: [{ name: 'tests', passed: true }] }] })
    expect(r.stages[0]).not.toHaveProperty('note')
    expect(status).toBe('M plan.md\n?? plans/')
  })

  it('leaves the plan files out of the commit prompt and tells the implementer not to commit them', async () => {
    const { f, r, status, asked } = await runWithPlans(
      repo => writeFileSync(join(repo, 'f.txt'), 'good\n'),
      (_, repo) => {
        git(repo, 'add', 'f.txt')
        git(repo, 'commit', '-qm', 'feat: f.txt')
      },
    )
    expect(asked).toEqual(['implement core', 'commit core implement'])
    const prompt = f.calls.find(c => c.label === 'commit core implement')!.prompt
    expect(prompt).toContain('?? f.txt')
    expect(prompt).not.toContain('M plan.md')
    expect(prompt).not.toContain('?? plans/')
    expect(prompt).toContain('Leave the plan files')
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(status).toBe('M plan.md\n?? plans/')
  })
})

describe('a stage whose implementer only left uncommitted work, in a real git repo', () => {
  const GOOD = { name: 'tests', run: 'grep -qx good f.txt' }
  const writeOnly = (repo: string) => writeFileSync(join(repo, 'f.txt'), 'good\n')
  const commitAll = (_: AgentRequest, repo: string) => {
    git(repo, 'add', 'f.txt')
    git(repo, 'commit', '-qm', 'feat: f.txt')
  }
  const runWriteOnly = async (onAsk: (req: AgentRequest, repo: string) => void, checks: unknown[]) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'granny-write-only-')))
    const repo = join(root, 'r')
    init(repo)
    git(repo, 'checkout', '-qb', 'feat/x')
    const f = fakeHost({
      commits: 'git',
      shell: {},
      override: req => {
        if (req.kind !== 'implementation') return undefined
        const start = git(repo, 'rev-parse', 'HEAD')
        if (req.label === 'implement core') writeOnly(repo)
        else if (req.label === 'implement api') commit(repo, 'g.txt', 'api\n')
        else onAsk(req, repo)
        return done(repo, start)
      },
    })
    try {
      const stages = [{ name: 'core', task: 'WP-01' }, { name: 'api', task: 'WP-02' }]
      const r = await runGranny(f.host, { repo, branch: 'feat/x', base: 'main', stages, config: { worktree: false, checks } })
      return { f, r, status: git(repo, 'status', '--porcelain'), checkRuns: f.commands.filter(c => c.includes(GOOD.run)).length }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const asked = (f: ReturnType<typeof fakeHost>) => f.calls.filter(c => c.kind === 'implementation').map(c => c.label)

  it('asks the implementer to commit before ending the stage no-changes, then checks and reviews the commit', async () => {
    const { f, r, checkRuns } = await runWriteOnly(commitAll, [GOOD])
    expect(asked(f).slice(0, 2)).toEqual(['implement core', 'commit core implement'])
    expect(f.calls.find(c => c.label === 'commit core implement')!.prompt).toContain('?? f.txt')
    expect(checkRuns).toBeGreaterThan(0)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 1, results: [{ name: 'tests', passed: true }] }] })
    expect(r.stages[1]!.outcome).not.toBe('skipped')
  })

  it('asks once without checks, then reviews the commit', async () => {
    const { f, r } = await runWriteOnly(commitAll, [])
    expect(asked(f).filter(l => l.includes('core'))).toEqual(['implement core', 'commit core implement'])
    expect(f.calls.some(c => c.label === 'review core r1 reviewer')).toBe(true)
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(r.stages[0]).not.toHaveProperty('note')
  })

  it('ends the stage no-changes, naming the uncommitted work, when the commit step commits nothing', async () => {
    const { f, r, status, checkRuns } = await runWriteOnly(() => {}, [GOOD])
    expect(asked(f).filter(l => l.includes('core'))).toEqual(['implement core', 'commit core implement'])
    expect(checkRuns).toBe(0)
    expect(f.calls.some(c => c.role === 'reviewer')).toBe(false)
    expect(status).toBe('?? f.txt')
    expect(r.stages[0]).toMatchObject({ outcome: 'no-changes', rounds: 0 })
    expect(r.stages[0]!.note).toBe('the implementer made no commit: the work it left is uncommitted (?? f.txt), so there was nothing to review')
    expect(r.stages[1]!.outcome).toBe('skipped')
  })
})

describe('uncommitted work without checks', () => {
  it('asks the implementer once to commit, and names what stayed uncommitted in the stage note', async () => {
    const f = scripted({}, { status: [' M src/a.ts\n?? scratch.txt\n'] })
    const r = await runGranny(f.host, run())
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'commit core implement', 'review core r1 reviewer', 'pr-ready check'])
    expect(f.calls[1]!.prompt).toContain('?? scratch.txt')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', note: 'uncommitted changes after implement: M src/a.ts, ?? scratch.txt - the review saw HEAD without them' })
    expect(f.logs).toContain('core: uncommitted changes after implement: M src/a.ts, ?? scratch.txt - the review saw HEAD without them')
  })

  it('adds nothing when the commit step leaves a clean tree, but takes its gates report', async () => {
    const redCommit = (req: AgentRequest) =>
      req.label === 'commit core implement' ? { startSha: 's', headSha: 'h', gatesGreen: false, gates: '1 failing', commits: ['c'], untested: '' } : undefined
    const f = scripted({}, { status: [' M src/a.ts\n', ''], override: redCommit })
    const r = await runGranny(f.host, run())
    expect(r.stages[0]!.outcome).toBe('gates-red')
    expect(r.stages[0]!.note).toBe('the review found nothing to fix, but the commit step (commit core implement) left the gates red: 1 failing')
  })

  it('probes after every fix round too', async () => {
    const f = scripted({}, { status: ['', ' M src/a.ts\n'], override: req => (req.label === 'review core r1 reviewer' ? p1 : undefined) })
    const r = await runGranny(f.host, run())
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'review core r1 reviewer', 'fix core r1', 'commit core fix r1', 'review core r2 reviewer', 'pr-ready check'])
    expect(r.stages[0]!.note).toBe('uncommitted changes after fix r1: M src/a.ts - the review saw HEAD without them')
  })

  it('costs nothing but the status read on a clean tree, also through the helper on Claude Code', async () => {
    const f = scripted({ 'run-tests': [green()] }, { name: 'claude-code', direct: false })
    await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'check core tests', 'review core r1 reviewer', 'pr-ready check'])
    expect(f.probes).toContain(`cd ${REPO} && git status --porcelain`)
  })
})

describe('a working tree status that cannot be read', () => {
  const UNREADABLE: CommandResult = { code: 128, output: 'fatal: index file corrupt' }
  const WHY = 'exit 128: fatal: index file corrupt'
  const retried = 'status core implement: could not read the working tree status (exit 128) - reading it once more'

  it('fails the gate after one more read, without running the checks or spending a repair', async () => {
    const f = scripted({ 'run-tests': [green()] }, { status: [UNREADABLE] })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.commands.filter(c => c.includes('run-tests'))).toEqual([])
    expect(f.calls.some(c => c.label.startsWith('repair') || c.label.startsWith('commit'))).toBe(false)
    expect(f.probes.filter(c => c.includes('git status --porcelain')).length).toBeGreaterThanOrEqual(2)
    expect(f.logs).toContain(retried)
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', note: `checks not run at implement - working tree status unreadable (${WHY})` })
    expect(r.finalReview).toMatchObject({ outcome: 'checks-failed', note: `checks not run at final - working tree status unreadable (${WHY})` })
    expect(r.recheck).toEqual({ passed: false, note: `checks not run at pr-ready - working tree status unreadable (${WHY})` })
  })

  it('goes on when the second read works', async () => {
    const f = scripted({ 'run-tests': [green()] }, { status: [UNREADABLE, ''] })
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(f.logs).toContain(retried)
    expect(r.stages[0]!.outcome).toBe('clean')
  })

  it('without checks, says in the stage note that the review may have missed uncommitted work', async () => {
    const f = scripted({}, { status: [UNREADABLE, UNREADABLE, ''] })
    const r = await runGranny(f.host, run())
    expect(f.calls.some(c => c.label.startsWith('commit'))).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', note: `working tree status unreadable after implement (${WHY}) - the review saw HEAD and may have missed uncommitted work` })
  })

  it('says so in the stage note when the status cannot be read after the commit step', async () => {
    const f = scripted({}, { status: ['?? f.txt\n', UNREADABLE] })
    const r = await runGranny(f.host, run())
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'commit core implement', 'review core r1 reviewer', 'pr-ready check'])
    expect(f.logs).toContain('status core implement after commit: could not read the working tree status (exit 128) - reading it once more')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', note: `working tree status unreadable after implement (${WHY}) - the review saw HEAD and may have missed uncommitted work` })
  })

  it('says so in the stage note when the status cannot be read after a fix round', async () => {
    const f = scripted({}, { status: ['', ' M src/a.ts\n', UNREADABLE], override: req => (req.label === 'review core r1 reviewer' ? p1 : undefined) })
    const r = await runGranny(f.host, run())
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'review core r1 reviewer', 'fix core r1', 'commit core fix r1', 'review core r2 reviewer', 'pr-ready check'])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', note: `working tree status unreadable after fix r1 (${WHY}) - the review saw HEAD and may have missed uncommitted work` })
  })

  it('ends an empty stage no-changes and says the status could not be read', async () => {
    const f = scripted({}, { commits: 0, status: [UNREADABLE] })
    const r = await runGranny(f.host, run())
    expect(r.stages[0]).toMatchObject({
      outcome: 'no-changes',
      note: `the implementer made no commit: deadbee1..HEAD is empty, so there was nothing to review; the working tree status could not be read (${WHY}), so uncommitted work may be left`,
    })
  })

  it('marks the run not PR-ready when it cannot be read after the pr-ready checks', async () => {
    let checked = false
    let reads = 0
    const f = scripted({ 'run-tests': [green()] }, { override: req => void (req.kind === 'final' && (checked = true)) })
    const direct = f.host.run!
    f.host.run = async (command, cwd) => {
      if (checked && command.includes('git rev-parse --verify HEAD')) return { code: 0, output: 'deadbee9\n' }
      if (checked && command.includes('git status --porcelain') && ++reads > 1) return UNREADABLE
      return direct(command, cwd)
    }
    const r = await runGranny(f.host, run({ checks: [TESTS] }))
    expect(r.checks).toEqual([{ at: 'pr-ready', attempt: 1, head: 'deadbee9', results: [{ name: 'tests', passed: true, code: 0 }] }])
    expect(r.recheck).toEqual({ passed: false, note: `working tree status unreadable after the checks at pr-ready (${WHY})` })
    expect(f.logs).toContain('pr-ready check: could not read the working tree status after the checks - the branch is not PR-ready')
  })
})
