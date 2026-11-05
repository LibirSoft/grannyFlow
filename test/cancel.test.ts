import { describe, expect, it } from 'bun:test'
import { GrannyCancelled, isCancelled } from '../src/core/cancel'
import { runGranny, type RunInput } from '../src/core/engine'
import type { AgentRequest, CommandResult } from '../src/core/types'
import { fakeHost, finding, review, withCodex, type FakeOptions } from './fake-host'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({
    repo: '/work/repo',
    branch: 'feat/x',
    base: 'main',
    stages: [{ name: 'core', task: 'Do WP-01.' }],
    ...extra,
  })

/** A fake host whose run is cancelled by the step `at` matches: the flag goes up and the step throws, as omp and opencode do. */
function cancelling(at: (req: AgentRequest) => boolean, opts: FakeOptions = {}, thrown: () => Error = () => new GrannyCancelled()) {
  const state = { cancelled: false }
  const f = fakeHost({
    ...opts,
    override: req => {
      if (state.cancelled) throw thrown()
      if (at(req)) {
        state.cancelled = true
        throw thrown()
      }
      return opts.override?.(req)
    },
  })
  f.host.cancelled = () => state.cancelled
  const labels = () => f.calls.map(c => c.label)
  const logged = (text: string) => f.logs.some(l => l.includes(text))
  return { ...f, state, labels, logged }
}

const quiet = (c: ReturnType<typeof cancelling>) => {
  expect(c.logged('retrying once')).toBe(false)
  expect(c.logged('review failed')).toBe(false)
  expect(c.labels()).not.toContain('pr-ready check')
}

describe('GrannyCancelled', () => {
  it('is an Error named GrannyCancelled with the message cancelled', () => {
    const e = new GrannyCancelled()
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('GrannyCancelled')
    expect(e.message).toBe('cancelled')
  })

  it('isCancelled matches the class and a copy of it from another bundle, by name, and nothing else', () => {
    class Copy extends Error {
      constructor() {
        super('cancelled')
        this.name = 'GrannyCancelled'
      }
    }
    expect(isCancelled(new GrannyCancelled())).toBe(true)
    expect(isCancelled(new Copy())).toBe(true)
    expect(isCancelled(new Error('cancelled'))).toBe(false)
    expect(isCancelled('cancelled')).toBe(false)
    expect(isCancelled(null)).toBe(false)
    expect(isCancelled(undefined)).toBe(false)
  })
})

describe('a cancelled run', () => {
  it('stops at a cancel during a reviewer call: no retry, no review-failed outcome, no result', async () => {
    const c = cancelling(req => req.label === 'review core r1 rv', {})
    await expect(runGranny(c.host, input({ config: { reviewers: [{ name: 'rv', engine: 'agent' }] } }))).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels().filter(l => l.startsWith('review core r1'))).toEqual(['review core r1 rv'])
    quiet(c)
  })

  it('stops at a cancel during a plan reviewer of a planning run: the run does not end with the plan written', async () => {
    const c = cancelling(req => req.label === 'review plan review r1 rv')
    const config = { planReview: true, reviewers: [{ name: 'rv', engine: 'agent' }] }
    await expect(runGranny(c.host, input({ stages: undefined, goal: 'Add login.', config }))).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['plan', 'review plan review r1 rv'])
    expect(c.logged('plan written')).toBe(false)
    quiet(c)
  })

  it('stops at a cancel during a review command that exits 130: no retry, not read as a failed review', async () => {
    const c = cancelling(() => false, {
      reviews: () => {
        c.state.cancelled = true
        return { code: 130, output: 'cancelled' }
      },
    })
    await expect(runGranny(c.host, input())).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.commands.filter(cmd => cmd.includes('codex exec review'))).toHaveLength(1)
    expect(c.logged('review command exited 130')).toBe(false)
    quiet(c)
  })

  it('turns any error a host throws once it is cancelled into GrannyCancelled', async () => {
    const c = cancelling(req => req.label === 'review core r1 rv', {}, () => new Error('session aborted'))
    await expect(runGranny(c.host, input({ config: { reviewers: [{ name: 'rv', engine: 'agent' }] } }))).rejects.toBeInstanceOf(GrannyCancelled)
    quiet(c)
  })

  it('stops at a cancel during the judge: no judge retry, no fix', async () => {
    const c = cancelling(req => req.kind === 'judge', { reviews: [review(finding('P2', 'Real issue'))] })
    await expect(runGranny(c.host, input())).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['implement core', 'judge core r1'])
    quiet(c)
  })

  it('stops at a cancel during the fixer: no next review round', async () => {
    const c = cancelling(req => req.label === 'fix core r1', { reviews: [review(finding('P1', 'Blocker'))] })
    await expect(runGranny(c.host, input())).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['implement core', 'fix core r1'])
    expect(c.commands.filter(cmd => cmd.includes('codex exec review'))).toHaveLength(1)
    quiet(c)
  })

  it('stops at a cancel during the implementer: no review', async () => {
    const c = cancelling(req => req.label === 'implement core')
    await expect(runGranny(c.host, input())).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['implement core'])
    expect(c.commands).toEqual([])
  })

  it('stops at a cancel during the planner: no plan review, no draft result', async () => {
    const c = cancelling(req => req.kind === 'draft')
    await expect(runGranny(c.host, input({ stages: undefined, goal: 'Add login.' }))).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['plan'])
    expect(c.logged('plan written')).toBe(false)
  })

  it('stops at a cancel during a plan-review fix: no next plan review round, no stage', async () => {
    const c = cancelling(req => req.label === 'fix plan review r1', { reviews: [review(finding('P1', 'Missing step', '/plans/v1.md', 4))] })
    await expect(runGranny(c.host, input({ plan: '/plans/v1.md', config: { planReview: true } }))).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['fix plan review r1'])
    expect(c.commands).toHaveLength(1)
    expect(c.logged('plan review ended')).toBe(false)
    quiet(c)
  })

  it('stops at a cancel during an extraction: the reviewer is not retried', async () => {
    const c = cancelling(req => req.label.startsWith('extract '), { reviews: ['Something went sideways, see above.'] })
    await expect(runGranny(c.host, input())).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['implement core', 'extract core r1 codex'])
    expect(c.commands.filter(cmd => cmd.includes('codex exec review'))).toHaveLength(1)
    quiet(c)
  })

  describe('at a check gate', () => {
    const checked = (cancelled: boolean) => {
      const c = cancelling(() => false, {
        checks: (command: string): CommandResult | undefined => {
          if (!command.includes('run-tests')) return undefined
          if (cancelled) c.state.cancelled = true
          return { code: 130, output: 'cancelled' }
        },
      })
      return c
    }
    const config = { checks: [{ name: 'tests', run: 'run-tests', maxRepairs: 1 }] }

    it('stops when the check command exits 130 because the run was cancelled: no repair', async () => {
      const c = checked(true)
      await expect(runGranny(c.host, input({ config }))).rejects.toBeInstanceOf(GrannyCancelled)
      expect(c.labels()).toEqual(['implement core'])
      expect(c.logged('check tests failed')).toBe(false)
    })

    it('still reads a 130 as a red check when the run was not cancelled', async () => {
      const c = checked(false)
      const r = await runGranny(c.host, input({ config }))
      expect(c.labels()).toContain('repair core implement #1')
      expect(r.stages[0]).toMatchObject({ outcome: 'checks-failed' })
    })
  })

  it('starts no further stage once a stage is cancelled', async () => {
    const c = cancelling(req => req.label === 'implement one')
    const stages = [{ name: 'one', task: 'A.' }, { name: 'two', task: 'B.' }]
    await expect(runGranny(c.host, input({ stages }))).rejects.toBeInstanceOf(GrannyCancelled)
    expect(c.labels()).toEqual(['implement one'])
    expect(c.logged('a stage failed')).toBe(false)
  })
})
