import { describe, expect, it } from 'bun:test'
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
    expect(f.events).toEqual(['implement core', 'check run-tests', 'review core r1 reviewer', 'check run-tests', 'pr-ready check'])
    expect(f.cwds).toEqual([REPO, REPO])
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', checks: [{ at: 'implement', attempt: 1, results: [{ name: 'tests', passed: true, code: 0 }] }] })
    expect(r.checks).toEqual([{ at: 'final', attempt: 1, results: [{ name: 'tests', passed: true, code: 0 }] }])
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
      run({ checks: [TESTS] }, { repos: [B], stages: [{ name: 'api', task: 'WP-01' }, { name: 'web', task: 'WP-02', repo: B, checks: [] }] }),
    )
    expect(f.cwds).toEqual([REPO, REPO])
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
    expect(f.events).toEqual(['implement core', 'check run-tests', 'review core r1 reviewer', 'fix core r1', 'check run-tests', 'check run-tests', 'pr-ready check'])
    expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed', rounds: 1 })
    expect(r.stages[0]!.checks?.map(c => [c.at, c.results[0]!.passed])).toEqual([
      ['implement', true],
      ['fix r1', false],
    ])
    expect(r.stages[0]!.history).toHaveLength(1)
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
      req.kind === 'implementation' ? { startSha: 'start1', headSha: 'h', gatesGreen: false, gates: '1 failing', commits: ['c'], untested: '' } : undefined
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
    const one = scripted({ 'run-tests': [green(), red('integration broke')] })
    const r1 = await runGranny(one.host, run({ checks: [TESTS] }))
    expect(one.calls.some(c => c.label.startsWith('repair final review'))).toBe(false)
    expect(r1.finalReview).toMatchObject({ outcome: 'checks-failed', rounds: 0 })
    expect(r1.checks).toHaveLength(1)
    expect(one.logs).toContain('final review: the final checks get no repairs - no final review follows to see one')

    const off = scripted({ 'run-tests': [green(), green(), red()] })
    const r2 = await runGranny(off.host, run({ finalReview: false, checks: [TESTS] }, { stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }] }))
    expect(off.calls.some(c => c.label.startsWith('repair final review'))).toBe(false)
    expect(r2.finalReview?.outcome).toBe('checks-failed')
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
    expect(f.calls.some(c => c.label === 'check final review tests')).toBe(true)
    expect(r.stages[0]!.outcome).toBe('clean')
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
