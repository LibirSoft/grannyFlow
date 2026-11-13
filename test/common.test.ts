import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropPlaceholders, HEARTBEAT_MS, hostModelErrors, JUDGE_INPUT_SCHEMA, JUDGE_ROLES, JUDGE_TOOL_DESCRIPTION, judgeStartLine, overridesNotice, planReviewWarning, RUN_INPUT_SCHEMA, summarize, RUN_TOOL_DESCRIPTION, runStatus, SAME_MODEL_HINT, sameModelNotice, summarizeJudge, withHeartbeat } from '../src/adapters/common'
import { resolveConfig } from '../src/core/config'
import { checkInput, type JudgeInput, type RunInput } from '../src/core/engine'
import { noteLine, renderReport } from '../src/core/report'
import type { JudgeResult } from '../src/core/types'

// The granny_run arguments gpt-5.6-luna sent through omp for a plain one-stage run: every optional
// field filled with an empty placeholder. checkInput refused them ("goal must be a non-empty string").
const filled = {
  repo: '/r',
  branch: 'feat/fix-add',
  base: 'main',
  repos: [],
  goal: '',
  context: '',
  plan: [],
  stages: [{ name: 'fix add', task: 'Fix add.', implement: true, review: true, repo: '', checks: [], after: [] }],
  fromStage: 1,
  config: {},
} as unknown as RunInput

describe('dropPlaceholders', () => {
  it('turns a placeholder-filled granny_run call into one checkInput accepts', () => {
    expect(checkInput(filled).length).toBeGreaterThan(0)
    const clean = dropPlaceholders(filled)
    expect(checkInput(clean)).toEqual([])
    expect(clean).not.toHaveProperty('goal')
    expect(clean).not.toHaveProperty('plan')
    expect(clean).not.toHaveProperty('repos')
    expect(clean).not.toHaveProperty('context')
    expect(clean).not.toHaveProperty('config')
    expect(clean.stages![0]).not.toHaveProperty('repo')
  })

  it('keeps the empty values that mean something and every real value', () => {
    const clean = dropPlaceholders(filled)
    expect(clean.stages![0]!.checks).toEqual([])
    expect(clean.stages![0]!.after).toEqual([])
    expect(clean.base).toBe('main')
    expect(clean.fromStage).toBe(1)
    const real = { repo: '/r', branch: 'b', goal: 'Build it', config: { maxRounds: 2 }, plan: ['/p.md'] } as unknown as RunInput
    expect(dropPlaceholders(real)).toEqual(real)
  })

  it('drops fromStage 0 and leaves non-object input alone', () => {
    expect(dropPlaceholders({ repo: '/r', branch: 'b', stages: [{ task: 't' }], fromStage: 0 } as RunInput)).not.toHaveProperty('fromStage')
    expect(dropPlaceholders(undefined as unknown as RunInput)).toBeUndefined()
  })

  it('drops an empty steps list and an empty step name, and keeps the step tasks', () => {
    const clean = dropPlaceholders({ repo: '/r', branch: 'b', stages: [{ task: 't', steps: [] }, { task: 't', steps: [{ name: '', task: 'first' }, { name: 'second', task: 'second task' }] }] } as unknown as RunInput)
    expect(clean.stages![0]).not.toHaveProperty('steps')
    expect(clean.stages![1]!.steps).toEqual([{ task: 'first' }, { name: 'second', task: 'second task' }])
    expect(clean.stages![1]!.steps![0]).not.toHaveProperty('name')
  })

  it('refuses the placeholder steps of a raw input, and lets them through once dropPlaceholders has cleaned them', () => {
    const stages = [{ name: 'a', task: 'A.', steps: [{ name: '', task: 'first' }, { name: '', task: 'second' }] }, { name: 'b', task: 'B.', implement: false, steps: [] }]
    expect(checkInput({ repo: '/r', branch: 'b', stages } as unknown as RunInput)).toEqual([
      'stages[0].steps[0].name must be a non-empty string',
      'stages[0].steps[1].name must be a non-empty string',
      'stages[1].steps must be a non-empty array of { name?, task }',
    ])
    expect(checkInput(dropPlaceholders({ repo: '/r', branch: 'b', goal: '', stages } as unknown as RunInput))).toEqual([])
  })
})

describe('the steps of a stage in the tool schema', () => {
  it('describes steps as optional, with a task for each, and names the stepAgents setting', () => {
    const steps = (RUN_INPUT_SCHEMA.properties as any).stages.items.properties.steps
    expect(steps.type).toBe('array')
    expect(steps.items.required).toEqual(['task'])
    expect(Object.keys(steps.items.properties).sort()).toEqual(['name', 'task'])
    expect(steps.description).toContain('stepAgents')
  })
})

describe('the plan review warning', () => {
  it('names the round cap, the tokens and the time', () => {
    const text = planReviewWarning(3)
    expect(text).toContain('up to 3 round(s)')
    expect(text).toContain('tokens')
    expect(text).toContain('time')
    expect(planReviewWarning(1)).toContain('up to 1 round(s)')
  })

  it('tells the agent in the tool schema to turn plan review on only when the user asked', () => {
    const props = RUN_INPUT_SCHEMA.properties as Record<string, { description: string }>
    for (const text of [props.config!.description, props.plan!.description, RUN_TOOL_DESCRIPTION]) {
      expect(text).toContain('only when the user')
      expect(text).toContain('tokens')
    }
  })
})

describe('the user\'s models and loop settings', () => {
  it('tells the agent in the tool schema to keep them unless the user asked, and to ask on a provider error', () => {
    const props = RUN_INPUT_SCHEMA.properties as Record<string, { description: string }>
    for (const text of [props.config!.description, RUN_TOOL_DESCRIPTION]) {
      for (const key of ['roles.*.model', 'roles.*.effort', 'reviewers', 'threshold', 'maxRounds', 'checks']) expect(text).toContain(key)
      expect(text).toContain("user's config files")
      expect(text).toContain('only when the user asked for that change in this conversation')
      expect(text).toContain('stop and ask the user which model to use')
    }
  })
})

describe('overridesNotice', () => {
  const files = [{ roles: { implementer: { model: { omp: 'openai-codex/gpt-6.1-sol' }, effort: 'xhigh' } }, reviewers: [{ name: 'codex', engine: 'agent', model: 'openai-codex/gpt-6.1-sol' }] }, { threshold: 70 }]

  it('names every value the run config changed, with the value from the config files', () => {
    const run = { roles: { implementer: { model: 'kimi-code/k3.1-pro', effort: 'high' }, judge: { model: 'kimi-code/k3.1-pro' } }, threshold: 50, maxRounds: 2, reviewers: [{ name: 'kimi', engine: 'agent', model: 'kimi-code/k3.1-pro' }], checks: [{ name: 'test', run: 'bun test' }] }
    const notice = overridesNotice([...files, run], 'omp')
    expect(notice).toBe(
      '\noverrides: roles.implementer.model kimi-code/k3.1-pro (config: openai-codex/gpt-6.1-sol), roles.implementer.effort high (config: xhigh), roles.judge.model kimi-code/k3.1-pro (config: default), ' +
        'reviewers kimi (agent, kimi-code/k3.1-pro) (config: codex (agent, openai-codex/gpt-6.1-sol)), threshold 50 (config: 70), maxRounds 2 (config: 4), checks test (config: none) - ' +
        'show this line to the user in your next message; they did not set these values in their config files.',
    )
  })

  it('names an opencode reviewer by the model and variant it runs', () => {
    const run = { reviewers: [{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' }] }
    expect(overridesNotice([...files, run], 'omp')).toContain('reviewers kimi (opencode, kimi-code-plan-global/k3.1-pro#max) (config: ')
  })

  it('compares a host-keyed effort by what it resolves to on this host', () => {
    const effort = (value: unknown) => overridesNotice([...files, { roles: { implementer: { effort: value } } }], 'omp')
    expect(effort({ omp: 'xhigh' })).not.toContain('roles.implementer.effort')
    expect(effort({ omp: 'high' })).toContain('roles.implementer.effort high (config: xhigh)')
    expect(effort({ 'claude-code': 'high' })).toContain('roles.implementer.effort default (config: xhigh)')
  })

  it('says nothing without a run config, or when it changes nothing', () => {
    expect(overridesNotice([...files, undefined], 'omp')).toBe('')
    expect(overridesNotice([...files, { threshold: 70 }], 'omp')).toBe('')
  })
})

describe('judgeStartLine', () => {
  it('names an opencode reviewer by the model and variant it runs', () => {
    const config = resolveConfig([{ reviewers: [{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' }], roles: { judge: { model: 'j/j' } } }], 'omp')
    expect(judgeStartLine('id1', { repo: '/r' }, 'feat/x', config, 'omp')).toContain('by kimi (opencode, kimi-code-plan-global/k3.1-pro#max), tagged by j/j')
  })
})

describe('hostModelErrors', () => {
  it('checks the model of every role at launch, the helper too', () => {
    const layers = [{ roles: { granny: { model: 'g' }, helper: { model: 'h' }, planner: { model: 'p' }, implementer: { model: 'i' }, judge: { model: 'j' } } }]
    const errors = hostModelErrors(resolveConfig(layers, 'omp'), layers, 'omp', model => (model.includes('/') ? undefined : 'not provider/model'), ['the config'])
    expect(errors.map(e => e.slice(0, e.indexOf(':')))).toEqual(['roles.granny.model', 'roles.helper.model', 'roles.planner.model', 'roles.implementer.model', 'roles.judge.model'])
  })

  it("leaves an opencode reviewer's model to opencode, which the host never runs as its own agent", () => {
    const layers = [{ reviewers: [{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' }] }]
    for (const host of ['opencode', 'omp'] as const) {
      expect(hostModelErrors(resolveConfig(layers, host), layers, host, () => 'not a model this host has', ['the config'], [])).toEqual([])
    }
  })
})

describe('withHeartbeat', () => {
  function timers() {
    const live = new Map<number, { fn: () => void; ms: number; unref: boolean }>()
    let next = 1
    return {
      live,
      setInterval: (fn: () => void, ms: number) => {
        const id = next++
        const entry = { fn, ms, unref: false }
        live.set(id, entry)
        return { id, unref: () => void (entry.unref = true) }
      },
      clearInterval: (handle: unknown) => void live.delete((handle as { id: number }).id),
      tick: () => [...live.values()].forEach(e => e.fn()),
    }
  }

  it('beats once a minute while a 15-minute command runs, then stops', async () => {
    const t = timers()
    const beats: number[] = []
    let finish!: (v: string) => void
    const done = withHeartbeat(() => new Promise<string>(r => (finish = r)), () => beats.push(beats.length), HEARTBEAT_MS, t)
    expect([...t.live.values()]).toEqual([expect.objectContaining({ ms: 60_000, unref: true })])
    for (let minute = 0; minute < 15; minute++) t.tick()
    expect(beats).toHaveLength(15)
    finish('ok')
    expect(await done).toBe('ok')
    expect(t.live.size).toBe(0)
  })

  it('stops beating when the command throws, and swallows a failing beat', async () => {
    const t = timers()
    const done = withHeartbeat(async () => {
      t.tick()
      throw new Error('boom')
    }, () => {
      throw new Error('journal gone')
    }, 10, t)
    await expect(done).rejects.toThrow('boom')
    expect(t.live.size).toBe(0)
  })
})

describe('sameModelNotice', () => {
  const run: RunInput = { repo: '/r', branch: 'b', stages: [{ task: 't' }] }
  const notice = (config: unknown, host: 'omp' | 'opencode' = 'omp', input: RunInput = run) => sameModelNotice(input, resolveConfig([config], host), host)
  const keyed = (model: string) => ({ omp: model, opencode: model })
  const on = (model: string) => ({ roles: { implementer: { model: keyed(model) } } })
  const agent = (name: string, model?: string) => ({ name, engine: 'agent', ...(model ? { model: keyed(model) } : {}) })

  it('gives the hint when every agent reviewer resolves to the implementer model, as advice not to act on alone', () => {
    const text = notice({ ...on('a/x'), reviewers: [agent('one', 'a/x'), agent('two', 'a/x')] })
    expect(text).toContain(SAME_MODEL_HINT)
    expect(text).toContain("do not change a model unless the user asks")
  })

  it('counts an implementer and a reviewer with no model as the same session model', () => {
    expect(notice({})).toContain(SAME_MODEL_HINT)
    expect(notice({ roles: { implementer: { model: { 'claude-code': 'opus' } } }, reviewers: [{ name: 'one', engine: 'agent', model: { 'claude-code': 'sonnet' } }] })).toContain(SAME_MODEL_HINT)
  })

  it('counts an opencode #variant as the same model', () => {
    expect(notice({ ...on('a/x#high'), reviewers: [agent('one', 'a/x')] }, 'opencode')).toContain(SAME_MODEL_HINT)
  })

  it('gives no hint for a reviewer on a different model, also when only one of several differs', () => {
    expect(notice({ ...on('a/x'), reviewers: [agent('one', 'a/y')] })).toBe('')
    expect(notice({ ...on('a/x'), reviewers: [agent('one', 'a/x'), agent('two', 'a/y')] })).toBe('')
    expect(notice({ ...on('a/x'), reviewers: [agent('one')] })).toBe('')
    expect(notice({ reviewers: [agent('one', 'a/x')] })).toBe('')
  })

  it('counts a Codex or command reviewer as different', () => {
    const command = { name: 'cmd', engine: 'command', command: 'review {base} {out}' }
    expect(notice({ reviewers: [command] })).toBe('')
    expect(notice({ reviewers: [agent('one'), command] })).toBe('')
    expect(notice({ reviewers: [{ name: 'codex', engine: 'codex' }] }, 'opencode')).toBe('')
    expect(notice({ reviewers: [{ name: 'auto', engine: 'auto' }] }, 'opencode')).toBe('')
  })

  it('gives no hint on a planning run, which writes no code to review', () => {
    expect(notice({}, 'omp', { repo: '/r', branch: 'b', goal: 'build it' })).toBe('')
  })
})

describe('runStatus journal tail', () => {
  const entry = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ t: '2026-11-06T10:00:00.000Z', type, ...data })
  const beat = entry('heartbeat', { command: 'bun test' })
  const tailOf = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'granny-status-'))
    try {
      writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n')
      const status = runStatus(new Map([['R', { dir }]]), 'R')
      return status.slice(status.indexOf('journal (')).split('\n').slice(1).filter(Boolean)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('shows the real entries before 60 trailing heartbeats', () => {
    const real = [entry('phase', { title: 'Checks' }), entry('command', { command: 'bun test' })]
    expect(tailOf([...real, ...Array.from({ length: 60 }, () => beat)])).toEqual(real)
  })

  it('keeps the bound of 40 lines, counted without the heartbeats', () => {
    const real = Array.from({ length: 50 }, (_, i) => entry('log', { message: `line ${i}` }))
    const mixed = real.flatMap(line => [line, beat])
    expect(tailOf(mixed)).toEqual(real.slice(-40))
  })

  it('keeps an entry that only mentions a heartbeat, and a line that does not parse', () => {
    const mention = entry('log', { message: '"type":"heartbeat"' })
    expect(tailOf([mention, '{not json', beat])).toEqual([mention, '{not json'])
  })
})

describe('the granny_judge tool', () => {
  it('needs only repo, and says it changes nothing and asks the user for missing models', () => {
    expect(JUDGE_INPUT_SCHEMA.required).toEqual(['repo'])
    expect(Object.keys(JUDGE_INPUT_SCHEMA.properties).sort()).toEqual(['base', 'config', 'context', 'repo'])
    expect(JUDGE_TOOL_DESCRIPTION).toContain('references/judge.md')
    expect(JUDGE_TOOL_DESCRIPTION).toContain('.granny/reviews/')
    expect(JUDGE_TOOL_DESCRIPTION).toContain('no fix, commit, push, branch or worktree')
  })

  it('drops the placeholders of a judge call', () => {
    const clean = dropPlaceholders({ repo: '/r', base: '', context: '', config: {} } as JudgeInput)
    expect(clean).toEqual({ repo: '/r' })
  })

  it('checks only the roles a judge run uses, when given them', () => {
    const layer = { roles: { implementer: { model: 'bad' }, judge: { model: 'bad' }, granny: { model: 'bad' } }, reviewers: [{ name: 'r', engine: 'agent', model: 'bad' }] }
    const config = resolveConfig([layer], 'omp')
    const errors = hostModelErrors(config, [layer], 'omp', () => 'wrong', ['file'], JUDGE_ROLES)
    expect(errors.map(e => e.split(' "')[0])).toEqual(['roles.granny.model:', 'roles.judge.model:', 'reviewers[0]'])
    expect(hostModelErrors(config, [layer], 'omp', () => 'wrong', ['file']).map(e => e.split(' "')[0])).toContain('roles.implementer.model:')
  })
})

describe('summarize of a planning run', () => {
  const planned = (questions?: string) => summarize({ repo: '/r', branch: 'b', base: 'main', worktree: '/w', stages: [], final: null, draft: { files: ['/r/plan.md'], stages: [{ name: 'one', task: 't' }], summary: 's', ...(questions ? { questions } : {}) } } as any, true)

  it('carries the open questions and tells the agent to ask them with its question tool', () => {
    const text = planned('1. Which database?\n2. Which port?\n')
    expect(text).toContain('ask the user these with your question tool (`ask` on omp, `question` on opencode), do not just write them out')
    expect(text).toContain('without such a tool, ask in one numbered message:\n1. Which database?\n2. Which port?')
    expect(text).toContain('show the user the plan and the stages, and wait for their approval')
  })

  it('says nothing of questions when the planner has none', () => {
    const text = planned()
    expect(text).not.toContain('question')
    expect(text).toContain('wait for their approval')
  })
})

describe('summarizeJudge', () => {
  const result: JudgeResult = {
    repo: '/r',
    branch: 'feat/x',
    base: 'main',
    head: 'a'.repeat(40),
    outcome: 'reviewed',
    counts: { P0: 1, P1: 2, P2: 3, P3: 0, dismissed: 1 },
    demoted: ['codex-F1', 'codex-F2'],
    findings: [],
    failedReviewers: [],
    notJudged: [],
    uncommitted: [],
    reportPath: '/r/.granny/reviews/20261106-101010-feat-x.md',
    written: true,
    report: '# report',
  }
  const END = 'Nothing was fixed or committed. Give the user the report path and the counts; do not fix anything unless they ask.'

  it('gives the report path first, then the counts and the demoted count, and ends with what to do', () => {
    const lines = summarizeJudge(result).split('\n')
    expect(lines[0]).toBe('- report: /r/.granny/reviews/20261106-101010-feat-x.md')
    expect(lines[1]).toBe('- counts: P0 1, P1 2, P2 3, P3 0, dismissed 1')
    expect(lines[2]).toBe('- reviewer P0/P1 findings the judge placed lower: 2 (codex-F1, codex-F2)')
    expect(lines.at(-1)).toBe(END)
    expect(lines).toHaveLength(4)
  })

  it('says none were demoted', () => {
    expect(summarizeJudge({ ...result, demoted: [] })).toContain('- reviewer P0/P1 findings the judge placed lower: 0\n')
  })

  it('names what was not reviewed, the reviewers that did not run and what the judge left', () => {
    const text = summarizeJudge({ ...result, uncommitted: ['a.ts', 'b.ts'], failedReviewers: [{ name: 'codex', note: 'exit 1\nlong' }], notJudged: ['kimi-F1'] })
    expect(text).toContain('- not reviewed, uncommitted: a.ts, b.ts')
    expect(text).toContain('- did not run: codex: exit 1 long')
    expect(text).toContain('- not judged, under the reviewer\'s severity: kimi-F1')
    expect(text.split('\n').at(-1)).toBe(END)
  })

  it('words a reviewer that did not run the same as the report does', () => {
    const note = `exit 1\n\n  ${'x'.repeat(400)}`
    const line = noteLine(note)
    expect(line).toBe(`exit 1 ${'x'.repeat(293)}`)
    const failed = [{ name: 'codex', note }]
    expect(summarizeJudge({ ...result, failedReviewers: failed })).toContain(`- did not run: codex: ${line}\n`)
    const report = renderReport({ branch: 'feat/x', base: 'main', head: 'abcd1234', commits: 1, repo: '/r', when: 'now', reviewers: [], uncommitted: [], failed }, [])
    expect(report).toContain(`- Did not run: codex: ${line}\n`)
  })

  it('says where the report is when it could not be written', () => {
    const lines = summarizeJudge({ ...result, written: false }).split('\n')
    expect(lines[0]).toBe('- report NOT written to /r/.granny/reviews/20261106-101010-feat-x.md: its text is in the run\'s result.json (granny_status), under report')
    expect(lines.at(-1)).toBe(END)
  })

  it('says there is no report after no-changes and review-failed', () => {
    const none = summarizeJudge({ ...result, outcome: 'no-changes', reportPath: undefined, report: undefined, written: false, note: 'main..HEAD has no commits, so there was nothing to review' })
    expect(none.split('\n')[0]).toBe('- no report: main..HEAD has no commits, so there was nothing to review')
    expect(none.split('\n').at(-1)).toBe('Nothing was fixed or committed. Tell the user; do not fix anything unless they ask.')
    const failed = summarizeJudge({ ...result, outcome: 'review-failed', reportPath: undefined, report: undefined, written: false, failedReviewers: [{ name: 'codex', note: 'exit 1' }] })
    expect(failed.split('\n').slice(0, 2)).toEqual(['- no report: no reviewer ran, also on a retry', '- did not run: codex: exit 1'])
    expect(failed.split('\n').at(-1)).toBe('Nothing was fixed or committed. Tell the user; do not fix anything unless they ask.')
  })
})
