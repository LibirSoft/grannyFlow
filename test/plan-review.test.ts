import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planReviewWarning, resolveConfig, type ReviewerConfig } from '../src/core/config'
import { checkInput, runGranny, type RunInput } from '../src/core/engine'
import { agentPlanReviewPrompt, planReviewPrompt, type PromptContext } from '../src/core/prompts'
import { parseCodexReview, reviewFailure } from '../src/core/review'
import { planReviewScript, reviewStem } from '../src/core/reviewer'
import type { CommandResult, HostName } from '../src/core/types'
import { fakeHost, finding, review, withCodex } from './fake-host'

const PLAN = '/plans/v1.md'

const input = (extra: Partial<RunInput> = {}): RunInput =>
  withCodex({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
  })

describe('the plan input', () => {
  it('takes one absolute path or a list of them', () => {
    expect(checkInput(input({ plan: PLAN }))).toEqual([])
    expect(checkInput(input({ plan: [PLAN, '/plans/wo-2.md'] }))).toEqual([])
  })

  for (const [label, plan, message] of [
    ['a relative path', 'plans/v1.md', 'plan must be an absolute path or a non-empty array of absolute paths (got "plans/v1.md")'],
    ['a relative path in a list', [PLAN, './wo.md'], 'plan must be an absolute path or a non-empty array of absolute paths (got "./wo.md")'],
    ['an empty list', [], 'plan must be an absolute path or a non-empty array of absolute paths'],
    ['an empty string', '', 'plan must be an absolute path or a non-empty array of absolute paths'],
    ['a number in a list', [PLAN, 5], 'plan must be an absolute path or a non-empty array of absolute paths (got 5)'],
  ] as const) {
    it(`rejects ${label} before anything runs`, async () => {
      expect(checkInput(input({ plan: plan as any }))).toEqual([message])
      const f = fakeHost()
      await expect(runGranny(f.host, input({ plan: plan as any }))).rejects.toThrow(message)
      expect(f.calls).toHaveLength(0)
      expect(f.setups).toHaveLength(0)
    })
  }

  it('puts the plan files in every agent prompt and the {prompt} of a command reviewer', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Off by one')), 'No findings.'],
      scores: [{ 'glm-F1': 90 }],
    })
    await runGranny(
      f.host,
      input({
        plan: [PLAN, "/plans/it's wo-2.md"],
        context: 'Read docs/notes.md.',
        config: { reviewers: [{ name: 'glm', engine: 'command', command: 'glm-review {prompt}' }] },
      }),
    )
    const line = `Plan files - read them first: ${PLAN}, /plans/it's wo-2.md`
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'judge core r1', 'fix core r1', 'pr-ready check'])
    for (const c of f.calls) {
      expect(c.prompt).toContain(line)
      expect(c.prompt).toContain('Read docs/notes.md.')
    }
    expect(f.commands[0]).toContain(`Plan files - read them first: ${PLAN}, /plans/it'\\''s wo-2.md`)
  })

  it("fills {base} of a command plan reviewer with the run's base, not the configured one", async () => {
    const f = fakeHost()
    await runGranny(
      f.host,
      input({
        base: 'develop',
        plan: PLAN,
        config: { planReview: true, worktree: false, reviewers: [{ name: 'glm', engine: 'command', command: 'glm-review --base {base} {prompt}' }] },
      }),
    )
    const planCommand = f.commands.find(c => c.includes('review-plan-review-r1'))!
    expect(planCommand).toContain('glm-review --base develop ')
    expect(planCommand).not.toContain('--base main')
  })
})

describe('the plan review', () => {
  const WT = '/work/repo-worktrees/feat-x'
  const planFinding = (severity: string, title: string, line = 3) => finding(severity, title, PLAN, line)
  const planCommand = (c: string) => c.includes('review-plan-review-r')
  const opus = { name: 'opus', engine: 'agent', model: 'opus' }

  it('reviews the plan after the worktree setup and before stage 1, and goes on when it is clean', async () => {
    const f = fakeHost({ worktree: WT })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(f.phases).toEqual(['Worktree', 'Plan review', 'Implement', 'Review', 'PR ready'])
    expect(f.commands).toHaveLength(2)
    expect(f.commands[0]).toContain('codex exec --sandbox read-only -o .granny/review-plan-review-r1-codex.md ')
    expect(f.commands[0]).toContain(`Review the plan in ${PLAN} - a plan, not code changes - against the actual repo at ${WT}`)
    expect(f.cwds[0]).toBe(WT)
    expect(f.commands[1]).toContain('codex exec review --base deadbee1')
    expect(f.logs).toContain('plan review r1: clean')
    expect(f.logs).toContain('plan review r1 codex: reviewer: codex CLI (codex exec, read-only)')
    expect(r.plan).toEqual({ outcome: 'clean', rounds: 1, residual: [], unresolved: [], history: [] })
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'clean' })
    expect(r.final).not.toBeNull()
  })

  it('has the implementer fix the plan in place, uncommitted, then reviews it again', async () => {
    const f = fakeHost({ worktree: WT, reviews: [review(planFinding('P2', 'Step 2 uses a removed flag')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ plan: [PLAN, '/plans/wo-2.md'], config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.plan!.history[0]!.findings[0]).toMatchObject({ id: 'codex-F1', file: PLAN, line: 3, priority: 90, title: 'Step 2 uses a removed flag' })
    expect(f.calls.map(c => c.label)).toEqual(['judge plan review r1', 'fix plan review r1', 'implement core', 'pr-ready check'])
    const judge = f.calls[0]!
    expect(judge).toMatchObject({ role: 'judge', kind: 'judge', phase: 'Plan review', access: 'read-only' })
    expect(judge.prompt).toContain(`You are the JUDGE classifying the findings of a plan review. Repo ${WT}, branch feat/x, plan ${PLAN}, /plans/wo-2.md.`)
    expect(judge.prompt).not.toContain('stage diff')
    const fix = f.calls[1]!
    expect(fix).toMatchObject({ role: 'implementer', kind: 'planFix', phase: 'Plan review', access: 'write', cwd: WT })
    expect(fix.prompt).toContain(`Edit the plan files in place at their absolute paths: ${PLAN}, /plans/wo-2.md.`)
    expect(fix.prompt).toContain('Never stage or commit the plan files')
    expect(fix.prompt).toContain('`## rN deltas (<date>)`')
    expect(fix.prompt).toContain('`date +%F`')
    expect(fix.prompt).toContain('Step 2 uses a removed flag')
    expect(f.commands.filter(planCommand).map(c => /review-plan-review-r\d/.exec(c)![0])).toEqual(['review-plan-review-r1', 'review-plan-review-r2'])
    expect(f.phases).toEqual(['Worktree', 'Plan review', 'Implement', 'Review', 'PR ready'])
  })

  it('stops before stage 1 when it hits the round cap, and reports the plan result', async () => {
    const bad = review(planFinding('P2', 'Still missing a migration step'))
    const f = fakeHost({ reviews: [bad, bad], scores: [{ 'codex-F1': 90 }, { 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, maxRounds: 2 } }))
    expect(r.plan).toMatchObject({ outcome: 'round-cap', rounds: 2 })
    expect(r.plan!.unresolved.map(x => x.title)).toEqual(['Still missing a migration step'])
    expect(r.plan!.history).toHaveLength(2)
    expect(r.stages).toEqual([])
    expect(r.final).toBeNull()
    expect(f.calls.map(c => c.label)).toEqual(['judge plan review r1', 'fix plan review r1', 'judge plan review r2', 'fix plan review r2'])
    expect(f.phases).toEqual(['Worktree', 'Plan review'])
    expect(f.logs.at(-1)).toBe('plan review ended round-cap - stopping before stage 1; nothing was implemented')
  })

  it('stops before stage 1 when a reviewer fails twice', async () => {
    const f = fakeHost({ reviews: [{ code: 1, output: 'codex: not logged in' }, { code: 1, output: 'codex: still not logged in' }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.plan!.note).toContain('still not logged in')
    expect(r.stages).toEqual([])
    expect(r.final).toBeNull()
    expect(f.calls).toHaveLength(0)
    expect(f.logs.at(-1)).toBe('plan review ended review-failed - stopping before stage 1; nothing was implemented')
  })

  it('keeps a residual plan finding of an earlier round when a later round is clean', async () => {
    const f = fakeHost({ reviews: [review(planFinding('P2', 'Missing step'), planFinding('P3', 'Wording')), 'No findings.'], scores: [{ 'codex-F1': 90, 'codex-F2': 20 }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.plan!.residual.map(x => x.title)).toEqual(['Wording'])
  })

  it('goes on to stage 1 with the residual findings when nothing is above the threshold', async () => {
    const f = fakeHost({ reviews: [review(planFinding('P3', 'Wording'))], scores: [{ 'codex-F1': 20 }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.plan!.residual.map(x => x.title)).toEqual(['Wording'])
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'clean' })
  })

  it('asks the plan judge once more when it returned nothing, with the plan judge prompt', async () => {
    const f = fakeHost({ reviews: [review(planFinding('P3', 'Wording'))], scores: [null, { 'codex-F1': 20 }] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    const judges = f.calls.filter(c => c.role === 'judge')
    expect(judges.map(c => c.label)).toEqual(['judge plan review r1', 'judge plan review r1 retry'])
    expect(judges[1]!.prompt.startsWith(judges[0]!.prompt)).toBe(true)
    expect(judges[0]!.prompt).toContain('classifying the findings of a plan review')
    expect(r.plan).toMatchObject({ outcome: 'residual-only', rounds: 1 })
  })

  it('sends P0/P1 plan findings to the implementer without the judge', async () => {
    const f = fakeHost({ reviews: [review(planFinding('P1', 'Wrong dependency version')), 'No findings.'] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(f.calls.some(c => c.kind === 'judge')).toBe(false)
    expect(f.calls.find(c => c.label === 'fix plan review r1')!.prompt).toContain('Wrong dependency version')
    expect(f.logs).toContain('plan review r1: 1 P0/P1 finding(s) go to the implementer without the judge: codex-F1')
  })

  it('is skipped when the run resumes from a later stage', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ plan: PLAN, stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2, config: { planReview: true } }))
    expect(r.plan).toEqual({ outcome: 'skipped', rounds: 0, residual: [], unresolved: [], history: [] })
    expect(f.phases).toEqual(['Worktree', 'Implement', 'Review', 'Final review', 'PR ready'])
    expect(f.commands.some(planCommand)).toBe(false)
    expect(f.logs).toContain('plan review skipped - the run resumes from stage 2')
    expect(f.calls.find(c => c.kind === 'implementation')!.prompt).toContain(`Plan files - read them first: ${PLAN}`)
  })

  it('is off by default: a run with a plan skips the Plan review phase but still hands the plan files to every agent', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ plan: PLAN }))
    expect(r.plan).toEqual({ outcome: 'review-skipped', rounds: 0, residual: [], unresolved: [], history: [] })
    expect(f.phases).toEqual(['Worktree', 'Implement', 'Review', 'PR ready'])
    expect(f.commands.some(planCommand)).toBe(false)
    expect(f.calls.map(c => c.label)).toEqual(['implement core', 'pr-ready check'])
    for (const c of f.calls) expect(c.prompt).toContain(`Plan files - read them first: ${PLAN}`)
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'clean' })
  })

  it('is off with planReview false, and absent without a plan', async () => {
    const off = fakeHost()
    const r = await runGranny(off.host, input({ plan: PLAN, config: { planReview: false } }))
    expect(r.plan).toEqual({ outcome: 'review-skipped', rounds: 0, residual: [], unresolved: [], history: [] })
    expect(off.commands.some(planCommand)).toBe(false)
    expect(off.logs).toContain('plan review off (planReview: false)')
    const none = fakeHost()
    expect((await runGranny(none.host, input())).plan).toBeUndefined()
    expect(none.phases).toEqual(['Worktree', 'Implement', 'Review', 'PR ready'])
  })

  it('logs the token and time warning with the round cap once, right after the Plan review phase starts', async () => {
    const f = fakeHost({ worktree: WT, reviews: [review(planFinding('P2', 'Step 2 uses a removed flag')), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, maxRounds: 3 } }))
    const warnings = f.logs.filter(l => l === planReviewWarning(3))
    expect(warnings).toHaveLength(1)
    expect(f.logs.indexOf(warnings[0]!)).toBeLessThan(f.logs.indexOf('plan review r1: 1 finding(s)'))
    const off = fakeHost()
    await runGranny(off.host, input({ plan: PLAN }))
    expect(off.logs.some(l => l.includes('tokens'))).toBe(false)
  })

  it('skips a command reviewer without {prompt}, with a log line, and reviews with the others', async () => {
    const diffOnly = { name: 'diff-only', engine: 'command', command: 'my-review --base {base} --out {out}' }
    const f = fakeHost({ override: req => (req.role === 'reviewer' ? { findings: [] } : undefined) })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, reviewers: [diffOnly, opus] } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 1 })
    expect(f.logs).toContain('plan review: reviewer diff-only skipped - its command has no {prompt}, so it cannot review a plan')
    expect(f.commands.some(planCommand)).toBe(false)
    expect(f.commands.some(c => c.includes('my-review --base deadbee1'))).toBe(true)
    const agent = f.calls.find(c => c.label === 'review plan review r1 opus')!
    expect(agent).toMatchObject({ role: 'reviewer', kind: 'findings', phase: 'Plan review', access: 'read-only', model: 'opus' })
    expect(agent.prompt).toContain(`Review the plan in ${PLAN}`)
  })

  it('fails closed when no reviewer can review a plan', async () => {
    const diffOnly = { name: 'diff-only', engine: 'command', command: 'my-review --base {base} --out {out}' }
    const f = fakeHost()
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, reviewers: [diffOnly] } }))
    expect(r.plan).toMatchObject({ outcome: 'review-failed', rounds: 0 })
    expect(r.plan!.note).toBe('no reviewer can review a plan: diff-only has a command without {prompt} - add a reviewer that can, or set planReview to false')
    expect(r.stages).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  it('fills {prompt} of a command reviewer with the plan-review prompt', async () => {
    const f = fakeHost({ worktree: WT })
    await runGranny(f.host, input({ plan: PLAN, config: { planReview: true, reviewers: [{ name: 'glm', engine: 'command', command: 'glm-review {prompt}' }] } }))
    expect(f.commands[0]).toContain(`glm-review 'You are a plan REVIEWER.`)
    expect(f.commands[0]).toContain('.granny/review-plan-review-r1-glm.md')
  })

  it('retries a plan reviewer that failed once', async () => {
    const f = fakeHost({ reviews: [{ code: 1, output: 'flaky' }, 'No findings.'] })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 1 })
    expect(f.commands.filter(planCommand)).toHaveLength(2)
  })

  it('keeps the absolute plan path of a finding even when the plan sits in the worktree', async () => {
    const inside = `${WT}/.granny/plans/v1.md`
    const f = fakeHost({ worktree: WT, reviews: [review(finding('P2', 'Gap', inside, 9)), 'No findings.'], scores: [{ 'codex-F1': 90 }] })
    const r = await runGranny(f.host, input({ plan: inside, config: { planReview: true } }))
    expect(r.plan!.history[0]!.findings[0]).toMatchObject({ file: inside, line: 9 })
  })

  it('runs the plan-review command on Claude Code through the review runner, in the Plan review phase', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, worktree: WT })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean' })
    const runner = f.calls.find(c => c.label === 'review plan review r1 codex')!
    expect(runner).toMatchObject({ role: 'helper', kind: 'command', phase: 'Plan review', access: 'read-only' })
    expect(runner.prompt).toContain(`; mkdir -p .granny && rm -f .granny/review-plan-review-r1-codex.md .granny/review-plan-review-r1-codex.log`)
    expect(runner.prompt).toContain('{ set -m; nohup bash -c ')
    expect(runner.prompt).toContain('node "$companion" task')
    expect(f.calls.filter(c => c.kind === 'command' && c.label.startsWith('review plan review')).map(c => [c.label, c.phase])).toEqual([
      ['review plan review r1 codex', 'Plan review'],
      ['review plan review r1 codex wait 1', 'Plan review'],
      ['review plan review r1 codex read', 'Plan review'],
    ])
    expect(f.calls.find(c => c.label === 'review plan review r1 codex wait 1')!.prompt).toContain(`\n( cd ${WT} && bash -c 'until [ -s .granny/review-plan-review-r1-codex.exit ]`)
  })

  it('waits for a slow plan-review command on Claude Code until it is done, then reads its findings', async () => {
    const f = fakeHost({
      name: 'claude-code',
      direct: false,
      worktree: WT,
      reviews: [review(planFinding('P2', 'Gap')), 'No findings.'],
      scores: [{ 'codex-F1': 90 }],
      wait: (_, n) => (n < 4 ? 'pending\n' : 'done\n'),
    })
    const r = await runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))
    expect(r.plan).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.plan!.history[0]!.findings.map(x => x.title)).toEqual(['Gap'])
    expect(f.calls.filter(c => c.label.startsWith('review plan review r1 codex wait')).map(c => c.label)).toEqual([1, 2, 3, 4].map(n => `review plan review r1 codex wait ${n}`))
  })

  it('throws when the plan fixer returns nothing', async () => {
    const f = fakeHost({ reviews: [review(planFinding('P1', 'Blocker'))], override: req => (req.kind === 'planFix' ? null : undefined) })
    await expect(runGranny(f.host, input({ plan: PLAN, config: { planReview: true } }))).rejects.toThrow('fix plan review r1: implementer returned nothing')
  })
})

const ctx = (extra: Partial<PromptContext> = {}): PromptContext => ({
  repo: '/work/repo-worktrees/feat-x',
  branch: 'feat/x',
  base: 'main',
  config: resolveConfig([]),
  ...extra,
})

describe('the plan-review prompts', () => {
  const plans = [PLAN, "/plans/it's wo-2.md"]

  it('asks for the five plan problems against the actual repo, with the plan file and line as the location', () => {
    for (const prompt of [planReviewPrompt(ctx(), plans), agentPlanReviewPrompt(ctx(), plans)]) {
      expect(prompt).toContain(`Review the plan in ${PLAN}, /plans/it's wo-2.md`)
      expect(prompt).toContain('against the actual repo at /work/repo-worktrees/feat-x')
      for (const ask of ['wrong assumptions about the code or its dependencies', 'missing steps', 'risky ordering', 'acceptance criteria that cannot be tested', 'version drift']) {
        expect(prompt).toContain(ask)
      }
      expect(prompt).toContain('Do not edit, stage or commit anything.')
    }
    expect(planReviewPrompt(ctx(), plans)).toContain('`- [P1] Title — /abs/path/of/plan.md:12`')
    expect(planReviewPrompt(ctx(), plans)).toContain('the absolute path of the plan file and the line in it')
    expect(agentPlanReviewPrompt(ctx(), plans)).toContain('file (the absolute path of the plan file), line (the line in the plan file)')
  })

  it('fits the command and CLI prompt on one line, with the context', () => {
    const prompt = planReviewPrompt(ctx({ context: 'Plan files - read them first: /p.md\nAlso notes.md.' }), [PLAN])
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('Plan files - read them first: /p.md Also notes.md.')
  })

  it('gives the agent the shared rules', () => {
    expect(agentPlanReviewPrompt(ctx(), [PLAN])).toContain('Prefix EVERY shell command with `cd /work/repo-worktrees/feat-x &&`')
  })

  it('reads plan findings with their absolute plan path', () => {
    const parsed = parseCodexReview(`- [P1] Step 3 assumes a Bun API that does not exist — ${PLAN}:12\n  detail\n`)
    expect(parsed.findings).toMatchObject([{ severity: 'P1', file: PLAN, line: 12, title: 'Step 3 assumes a Bun API that does not exist' }])
  })
})

const rv = (entry: Partial<ReviewerConfig> & { engine: ReviewerConfig['engine'] }, host: HostName = 'opencode'): ReviewerConfig =>
  resolveConfig([{ reviewers: [{ name: 'codex', ...entry }] }], host).reviewers[0]!

describe('the plan-review command of each reviewer engine', () => {
  const config = resolveConfig([])
  const stem = reviewStem(config, 'plan-review', 1, rv({ engine: 'codex' }))
  const prompt = "Review the plan. It's $HOME"
  const quoted = `'Review the plan. It'\\''s $HOME'`

  it('stores the plan review under its own stem', () => {
    expect(stem).toBe('.granny/review-plan-review-r1-codex')
  })

  for (const [label, entry, host] of [
    ['codex', { engine: 'codex' }, 'claude-code'],
    ['codex', { engine: 'codex' }, 'opencode'],
    ['auto on opencode', { engine: 'auto' }, 'opencode'],
  ] as const) {
    it(`runs codex exec read-only with the prompt for ${label} on ${host}`, () => {
      const s = planReviewScript(rv(entry, host), config, host, 'main', stem, prompt)!
      expect(s.backend).toBe('codex CLI (codex exec, read-only)')
      expect(s.script).toContain(
        `codex exec --sandbox read-only -o .granny/review-plan-review-r1-codex.md ${quoted} </dev/null > .granny/review-plan-review-r1-codex.log 2>&1`,
      )
      expect(s.script).not.toContain('codex exec review')
      expect(s.script).not.toContain('companion')
    })
  }

  it('passes the reviewer model to codex exec', () => {
    const s = planReviewScript(rv({ engine: 'codex', model: 'gpt-5.5' }), config, 'opencode', 'main', stem, prompt)!
    expect(s.script).toContain(`codex exec --sandbox read-only -m gpt-5.5 -o .granny/review-plan-review-r1-codex.md ${quoted}`)
  })

  for (const [label, entry, host] of [
    ['codex-plugin', { engine: 'codex-plugin', model: 'gpt-5.5' }, 'claude-code'],
    ['codex-plugin', { engine: 'codex-plugin', model: 'gpt-5.5' }, 'opencode'],
    ['auto', { engine: 'auto', model: 'gpt-5.5' }, 'claude-code'],
    ['auto in adversarial-review mode', { engine: 'auto', mode: 'adversarial-review', model: 'gpt-5.5' }, 'claude-code'],
  ] as const) {
    it(`runs the companion's read-only, foreground task command for ${label} on ${host}`, () => {
      const s = planReviewScript(rv(entry, host), config, host, 'main', stem, prompt)!
      expect(s.backend).toBeUndefined()
      expect(s.script).toContain(`node "$companion" task -m gpt-5.5 ${quoted} </dev/null > .granny/review-plan-review-r1-codex.md 2> .granny/review-plan-review-r1-codex.log`)
      expect(s.script).not.toContain('--write')
      expect(s.script).not.toContain('--background')
      expect(s.script).not.toContain('adversarial-review')
      expect(s.script).toContain('export CLAUDE_PLUGIN_DATA="$PWD"/.granny/codex-plugin-codex')
    })
  }

  it('fills {prompt} of a command reviewer with the plan-review prompt', () => {
    const s = planReviewScript(rv({ engine: 'command', command: 'llm -m {model} {prompt}', model: 'm' }), config, 'opencode', 'main', stem, prompt)!
    const body = `llm -m m ${quoted} > .granny/review-plan-review-r1-codex.log 2>&1; code=$?; if [ -s .granny/review-plan-review-r1-codex.md ]; then cat .granny/review-plan-review-r1-codex.md; else cat .granny/review-plan-review-r1-codex.log; fi; exit $code`
    expect(s).toEqual({
      script: `mkdir -p .granny && rm -f .granny/review-plan-review-r1-codex.md .granny/review-plan-review-r1-codex.log && ${body}`,
      body,
      backend: 'custom command',
    })
  })

  it('has no command for a command reviewer without {prompt}', () => {
    expect(planReviewScript(rv({ engine: 'command', command: 'my-review --base {base} --out {out}' }), config, 'opencode', 'main', stem, prompt)).toBeUndefined()
  })
})

const FAKE_CODEX = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$GRANNY_HOME/codex-argv"
cat > "$GRANNY_HOME/codex-stdin"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
echo 'codex progress' >&2
printf '%s\\n' '- [P1] Plan reviewed by codex exec — /plans/v1.md:3' '  detail' > "$out"
`

const FAKE_COMPANION = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.GRANNY_HOME + '/companion.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
process.stderr.write('[codex] progress\\n')
process.stdout.write(process.env.GRANNY_TASK_OUTPUT ?? '- [P2] Plan reviewed by the companion — /plans/v1.md:7\\n  detail\\n')
`

function sh(command: string, cwd: string, env: Record<string, string>): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { cwd, env: { ...process.env, ...env } })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

describe('the plan-review command in a real shell', () => {
  let repo: string
  let home: string
  let bin: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "granny plan repo's "))
    home = mkdtempSync(join(tmpdir(), 'granny plan home '))
    bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: '', GRANNY_HOME: home, ...extra })
  const installCompanion = () => {
    const dir = join(home, '.claude/plugins/cache/openai-codex/codex/1.0.6/scripts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codex-companion.mjs'), FAKE_COMPANION)
    writeFileSync(join(dir, 'session-lifecycle-hook.mjs'), '')
    return join(dir, 'codex-companion.mjs')
  }
  const config = resolveConfig([])
  const stem = '.granny/review-plan-review-r1-codex'
  const prompt = "Review /plans/v1.md. Don't skip $HOME or `id`."
  const companionCalls = () => readFileSync(join(home, 'companion.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

  it('hands codex exec the prompt as one argument and closes its stdin, so it does not wait for more', async () => {
    const s = planReviewScript(rv({ engine: 'codex' }), config, 'opencode', 'main', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r).toEqual({ code: 0, output: '- [P1] Plan reviewed by codex exec — /plans/v1.md:3\n  detail\n' })
    expect(readFileSync(join(home, 'codex-argv'), 'utf8')).toBe(`exec\n--sandbox\nread-only\n-o\n${stem}.md\n${prompt}\n`)
    expect(readFileSync(join(home, 'codex-stdin'), 'utf8')).toBe('')
  }, 5000)

  it('runs the companion task with the prompt on Claude Code with engine auto, and says so', async () => {
    const companion = installCompanion()
    const s = planReviewScript(rv({ engine: 'auto' }, 'claude-code'), config, 'claude-code', 'main', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).toBe(0)
    expect(r.output).toContain(`[granny] reviewer: codex-plugin task (${companion})`)
    expect(r.output).toContain('- [P2] Plan reviewed by the companion — /plans/v1.md:7')
    expect(companionCalls()).toEqual([{ argv: ['task', prompt], cwd: realpathSync(repo) }])
    expect(existsSync(join(home, 'codex-argv'))).toBe(false)
  }, 5000)

  it('falls back to codex exec on Claude Code with engine auto when no companion is installed', async () => {
    const s = planReviewScript(rv({ engine: 'auto' }, 'claude-code'), config, 'claude-code', 'main', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).toBe(0)
    expect(r.output).toContain('[granny] reviewer: codex CLI (codex exec, read-only) - no Codex plugin companion at')
    expect(r.output).toContain('Plan reviewed by codex exec')
  }, 5000)

  it('fails with engine codex-plugin when no companion is installed, without running codex exec', async () => {
    const s = planReviewScript(rv({ engine: 'codex-plugin' }, 'claude-code'), config, 'claude-code', 'main', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("codex-plugin task unavailable - no Codex plugin companion at")
    expect(existsSync(join(home, 'codex-argv'))).toBe(false)
  }, 5000)

  it("reads the companion's empty task render as a failed review", async () => {
    installCompanion()
    const s = planReviewScript(rv({ engine: 'codex-plugin' }, 'claude-code'), config, 'claude-code', 'main', stem, prompt)!
    const r = await sh(s.script, repo, env({ GRANNY_TASK_OUTPUT: 'Codex did not return a final message.\n' }))
    expect(r.code).toBe(0)
    expect(reviewFailure(r.output)).toBe('Codex did not return a final message.')
  }, 5000)
})
