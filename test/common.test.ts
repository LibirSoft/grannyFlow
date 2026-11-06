import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropPlaceholders, HEARTBEAT_MS, hostModelErrors, overridesNotice, planReviewWarning, RUN_INPUT_SCHEMA, RUN_TOOL_DESCRIPTION, runStatus, SAME_MODEL_HINT, sameModelNotice, withHeartbeat } from '../src/adapters/common'
import { resolveConfig } from '../src/core/config'
import { checkInput, type RunInput } from '../src/core/engine'

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

  it('says nothing without a run config, or when it changes nothing', () => {
    expect(overridesNotice([...files, undefined], 'omp')).toBe('')
    expect(overridesNotice([...files, { threshold: 70 }], 'omp')).toBe('')
  })
})

describe('hostModelErrors', () => {
  it('checks the model of every role at launch, the helper too', () => {
    const layers = [{ roles: { granny: { model: 'g' }, helper: { model: 'h' }, planner: { model: 'p' }, implementer: { model: 'i' }, judge: { model: 'j' } } }]
    const errors = hostModelErrors(resolveConfig(layers, 'omp'), layers, 'omp', model => (model.includes('/') ? undefined : 'not provider/model'), ['the config'])
    expect(errors.map(e => e.slice(0, e.indexOf(':')))).toEqual(['roles.granny.model', 'roles.helper.model', 'roles.planner.model', 'roles.implementer.model', 'roles.judge.model'])
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
