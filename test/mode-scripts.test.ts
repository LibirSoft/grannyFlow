import { describe, expect, it } from 'bun:test'
import { buildClaudeCode, CLAUDE_CODE_SCRIPTS, type ClaudeCodeScript } from '../scripts/build'
import { runGranny, runJudge, type JudgeInput } from '../src/core/engine'
import { fakeHost, finding, review, withCodex, type FakeOptions } from './fake-host'

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const load = (script: string) => new AsyncFunction('agent', 'log', 'phase', 'args', script.replace(/^export const meta/, 'const meta'))
const metaOf = (script: string) => script.slice(0, script.indexOf('\n}\n') + 2)
const metaPhases = async (name: ClaudeCodeScript) => [...metaOf(await buildClaudeCode(name)).matchAll(/\{ title: '([^']+)' \}/g)].map(m => m[1]!)

const REPO = '/work/repo'
const PLAN = '/plans/v1.md'
const JUDGE_MODELS = { reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }], roles: { judge: { model: 'j' } } }

const goalRun = { repo: REPO, branch: 'feat/x', goal: 'Add login.', config: [] }
const implementRun = { repo: REPO, branch: 'feat/x', plan: PLAN, stages: [{ name: 'one', task: 'Do it.' }], config: [] }
const judgeRun = { judge: true, repo: REPO, config: [JUDGE_MODELS] }

/** The phases in the order each one is first entered; a later return to an earlier phase does not reorder the list. */
const firstSeen = (phases: string[]) => [...new Set(phases)]
const isSubsequence = (part: string[], whole: string[]) => {
  let at = 0
  for (const p of part) {
    at = whole.indexOf(p, at)
    if (at < 0) return false
    at++
  }
  return true
}

const claudeHost = (opts: FakeOptions = {}) => fakeHost({ name: 'claude-code', direct: false, ...opts })

function judgeHost(found: unknown[], commits = 2) {
  const writes: string[] = []
  return fakeHost({
    name: 'claude-code',
    commits,
    scores: [Object.fromEntries(found.map((_, i) => [`kimi-F${i + 1}`, 90]))],
    checks: command => {
      if (command.includes('info/exclude')) return ''
      if (command.startsWith('date ')) return '20261108-120000\n'
      if (command === 'git branch --show-current') return 'feat/x\n'
      if (command.includes("<<'")) {
        writes.push(command.slice(command.indexOf('\n') + 1, command.lastIndexOf('GRANNY_REPORT_END\n')))
        return ''
      }
      if (command.startsWith('wc -c')) return `${Buffer.byteLength(writes.at(-1)!)}\n`
      return undefined
    },
    override: req => (req.kind === 'findings' ? { findings: found } : undefined),
  })
}

const red = { code: 1, output: 'FAIL' }

describe('the Claude Code mode scripts', () => {
  it('list only their own mode\'s phases, in the order they run', async () => {
    expect(await metaPhases('plan')).toEqual(['Worktree', 'Plan', 'Plan review'])
    expect(await metaPhases('workflow')).toEqual(['Worktree', 'Plan review', 'Implement', 'Checks', 'Review', 'Final review', 'PR ready'])
    expect(await metaPhases('judge')).toEqual(['Review', 'Tagging', 'Save report'])
  })

  it('name only their own mode in the description and whenToUse', async () => {
    const plan = metaOf(await buildClaudeCode('plan'))
    expect(plan).toMatch(/whenToUse: '.*goal/)
    expect(plan).not.toMatch(/judge: true|, stages/)
    const workflow = metaOf(await buildClaudeCode('workflow'))
    expect(workflow).toMatch(/whenToUse: '.*stages/)
    expect(workflow).not.toMatch(/judge: true|goal|review-only run/)
    const judge = metaOf(await buildClaudeCode('judge'))
    expect(judge).toMatch(/description: '.*review-only/)
    expect(judge).toMatch(/whenToUse: '.*judge: true/)
    expect(judge).not.toMatch(/goal|, stages/)
  })

  describe('enter only phases their meta lists, in its order, across the config variants', () => {
    const variants: Record<ClaudeCodeScript, Array<[string, () => { f: ReturnType<typeof claudeHost>; run: Promise<unknown> }]>> = {
      plan: [
        ['worktree, no plan review', () => {
          const f = claudeHost()
          return { f, run: runGranny(f.host, withCodex({ ...goalRun, config: [] })) }
        }],
        ['no worktree, plan review with a fix', () => {
          const f = claudeHost({ reviews: [review(finding('P1', 'Missing step', `${REPO}/.granny/plans/feat-x.md`, 4)), 'No findings.'] })
          return { f, run: runGranny(f.host, withCodex({ ...goalRun, config: [{ worktree: false, planReview: true }] })) }
        }],
      ],
      workflow: [
        ['one stage, no worktree', () => {
          const f = claudeHost()
          return { f, run: runGranny(f.host, { ...implementRun, config: [{ worktree: false }] }) }
        }],
        ['plan review, timed checks with a repair, a fix round, two stages and a final review', () => {
          let checks = 0
          const f = claudeHost({
            timeoutProbe: 'timeout\n',
            reviews: [review(finding('P1', 'Off by one')), 'No findings.', 'No findings.', 'No findings.', 'No findings.'],
            checks: command => (command.includes('run-tests') ? (++checks === 1 ? red : 'ok') : undefined),
          })
          const config = [{ planReview: true, checks: [{ name: 'tests', run: 'run-tests', timeout: 60 }] }]
          return { f, run: runGranny(f.host, withCodex({ ...implementRun, stages: [{ name: 'one', task: 'A' }, { name: 'two', task: 'B' }], config })) }
        }],
        ['a review-only stage', () => {
          const f = claudeHost()
          return { f, run: runGranny(f.host, { ...implementRun, stages: [{ name: 'old', implement: false }] }) }
        }],
        ['a plan review that ends at the round cap', () => {
          const bad = review(finding('P1', 'Still missing', PLAN))
          const f = claudeHost({ reviews: [bad, bad] })
          return { f, run: runGranny(f.host, withCodex({ ...implementRun, config: [{ planReview: true, maxRounds: 2 }] })) }
        }],
      ],
      judge: [
        ['findings to tag', () => {
          const f = judgeHost([{ id: 'F1', severity: 'P2', file: 'src/a.ts', line: 3, title: 't', detail: 'd' }])
          return { f, run: runJudge(f.host, judgeRun as JudgeInput) }
        }],
        ['a clean review', () => {
          const f = judgeHost([])
          return { f, run: runJudge(f.host, judgeRun as JudgeInput) }
        }],
        ['no commits to review', () => {
          const f = judgeHost([], 0)
          return { f, run: runJudge(f.host, judgeRun as JudgeInput) }
        }],
      ],
    }

    for (const name of CLAUDE_CODE_SCRIPTS) {
      for (const [title, start] of variants[name]) {
        it(`${name}.js: ${title}`, async () => {
          const listed = await metaPhases(name)
          const { f, run } = start()
          await run
          expect(f.phases.length).toBeGreaterThan(0)
          expect(firstSeen(f.phases).filter(p => !listed.includes(p))).toEqual([])
          expect(isSubsequence(firstSeen(f.phases), listed)).toBe(true)
          expect([...new Set(f.requests.map(r => r.phase))].filter(p => !listed.includes(p))).toEqual([])
        })
      }
    }

    it('together reach every phase each meta lists', async () => {
      for (const name of CLAUDE_CODE_SCRIPTS) {
        const reached = new Set<string>()
        for (const [, start] of variants[name]) {
          const { f, run } = start()
          await run
          for (const p of f.phases) reached.add(p)
        }
        expect([...reached].sort()).toEqual([...(await metaPhases(name))].sort())
      }
    })
  })

  describe('refuse the wrong mode before any agent, naming the right script', () => {
    const cases: Array<[ClaudeCodeScript, string, Record<string, unknown>, string]> = [
      ['workflow', 'a planning run', goalRun, 'this is the implement script; a planning run (args with goal) uses engines/claude-code/plan.js'],
      ['workflow', 'a judge run', judgeRun, 'this is the implement script; a granny judge run (args with judge: true) uses engines/claude-code/judge.js'],
      ['plan', 'an implement run', implementRun, 'this is the planning script; an implement run (args with plan and stages) uses engines/claude-code/workflow.js'],
      ['plan', 'a judge run', { ...judgeRun, goal: 'x' }, 'this is the planning script; a granny judge run (args with judge: true) uses engines/claude-code/judge.js'],
      ['judge', 'an implement run', implementRun, 'this is the granny judge script; an implement run (args with plan and stages) uses engines/claude-code/workflow.js'],
      ['judge', 'a planning run', goalRun, 'this is the granny judge script; a planning run (args with goal) uses engines/claude-code/plan.js'],
      ['judge', 'judge not exactly true', { ...judgeRun, judge: 'yes' }, 'this is the granny judge script; an implement run (args with plan and stages) uses engines/claude-code/workflow.js'],
    ]
    for (const [name, what, args, message] of cases) {
      it(`${name}.js given ${what}`, async () => {
        let calls = 0
        const phases: string[] = []
        const run = load(await buildClaudeCode(name))(async () => (calls++, null), () => {}, (t: string) => phases.push(t), args)
        await expect(run).rejects.toThrow(message)
        expect(calls).toBe(0)
        expect(phases).toEqual([])
      })
    }

    it('leaves args that are not an object to the engine\'s input check', async () => {
      for (const name of CLAUDE_CODE_SCRIPTS) {
        const run = load(await buildClaudeCode(name))(async () => null, () => {}, () => {}, undefined)
        await expect(run).rejects.toThrow('input must be an object')
      }
    })
  })

  it('plan.js runs a planning run and stops after the plan', async () => {
    const phases: string[] = []
    const labels: string[] = []
    const agent = async (_prompt: string, opts: any) => {
      labels.push(opts.label)
      if (opts.label === 'worktree') return { ran: true, exitCode: 0, output: '[granny] worktree: /r-worktrees/feat-x\n' }
      if (opts.label === 'plan') return { files: [`${REPO}/.granny/plans/feat-x.md`], stages: [{ name: 'core', task: 'WP-01' }], summary: 'one stage' }
      throw new Error(`unexpected agent ${opts.label}`)
    }
    const result = await load(await buildClaudeCode('plan'))(agent, () => {}, (t: string) => phases.push(t), goalRun)
    expect(phases).toEqual(['Worktree', 'Plan'])
    expect(labels).toEqual(['worktree', 'plan'])
    expect(result).toMatchObject({ stages: [], final: null, draft: { stages: [{ name: 'core', task: 'WP-01' }] } })
  })
})
