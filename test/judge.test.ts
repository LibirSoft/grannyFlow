import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildClaudeCode } from '../scripts/build'
import { GrannyCancelled } from '../src/core/cancel'
import { judgeConfigGaps } from '../src/core/config'
import { runGranny, runJudge, type JudgeInput } from '../src/core/engine'
import { bucketOf, renderReport, utf8Length, type ReportMeta } from '../src/core/report'
import { SCHEMAS } from '../src/core/schemas'
import { heredocWriteScript } from '../src/core/shell'
import type { AgentRequest, Finding, JudgeResult } from '../src/core/types'
import { fakeHost, finding, review, type FakeOptions } from './fake-host'

const agent = (model?: unknown) => ({ name: 'kimi', engine: 'agent', ...(model === undefined ? {} : { model }) })

describe('judgeConfigGaps', () => {
  it('counts the built-in reviewer list as no choice, and names one gap for it', () => {
    expect(judgeConfigGaps([], 'claude-code')).toEqual(['reviewers: no config sets who reviews'])
    expect(judgeConfigGaps([{ threshold: 80 }, undefined], 'claude-code')).toEqual(['reviewers: no config sets who reviews'])
  })

  it('names an agent reviewer with no model for this host', () => {
    const layer = { reviewers: [agent({ opencode: 'k' })], roles: { judge: { model: 'h' } } }
    expect(judgeConfigGaps([layer], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
    expect(judgeConfigGaps([layer], 'opencode')).toEqual([])
  })

  it('does not ask a model of a reviewer that is not an agent', () => {
    const layer = { reviewers: [{ name: 'codex', engine: 'codex' }, { name: 'cmd', engine: 'command', command: 'r {base}' }], roles: { judge: { model: 'h' } } }
    expect(judgeConfigGaps([layer], 'opencode')).toEqual([])
  })

  it('accepts the built-in haiku judge on Claude Code but not on a host it does not name', () => {
    const layer = { reviewers: [agent('k')] }
    expect(judgeConfigGaps([layer], 'claude-code')).toEqual([])
    expect(judgeConfigGaps([layer], 'omp')).toEqual(['roles.judge.model: no model for omp'])
    expect(judgeConfigGaps([layer], 'opencode')).toEqual(['roles.judge.model: no model for opencode'])
  })

  it('sees a judge model taken away by a later layer', () => {
    expect(judgeConfigGaps([{ reviewers: [agent('k')], roles: { judge: { model: null } } }], 'claude-code')).toEqual(['roles.judge.model: no model for claude-code'])
  })

  it('reads the reviewers and the judge across the layers, the last reviewers list winning', () => {
    const user = { reviewers: [agent()], roles: { judge: { model: { omp: 'h' } } } }
    expect(judgeConfigGaps([user], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
    expect(judgeConfigGaps([user, { reviewers: [agent({ omp: 'k' })] }], 'omp')).toEqual([])
  })

  it('names every gap at once', () => {
    expect(judgeConfigGaps([{ reviewers: [agent(), { ...agent(), name: 'other' }] }], 'omp')).toEqual([
      'reviewers[0] (kimi): no model for omp',
      'reviewers[1] (other): no model for omp',
      'roles.judge.model: no model for omp',
    ])
  })

  it('treats an empty model string as no model', () => {
    expect(judgeConfigGaps([{ reviewers: [agent('')], roles: { judge: { model: 'h' } } }], 'omp')).toEqual(['reviewers[0] (kimi): no model for omp'])
  })
})

const ROLE_MODELS = { roles: { judge: { model: 'j' } } }
const ONE = { reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }], ...ROLE_MODELS }
const TWO = { reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }, { name: 'terra', engine: 'agent', model: 't' }], ...ROLE_MODELS }
const REPO = '/work/repo'
const DATE = '20261106-171600'

const raw = (id: string, severity: string, title = `${id} title`, file = 'src/a.ts', line = 3) => ({ id, severity, file, line, title, detail: `${id} detail` })
const classes = (impact: string, more: Record<string, unknown> = {}) => ({ verdict: 'confirmed', impact, likelihood: 'edge', fixCost: 'small', scope: 'in-scope', evidence: 'src/a.ts:3 - trigger', ...more })

/** The text of a heading, up to the next heading of its level. */
const under = (report: string, heading: string): string => {
  const at = report.indexOf(`\n## ${heading}\n`)
  if (at < 0) return ''
  const rest = report.slice(at + 1)
  const next = rest.indexOf('\n## ')
  return next < 0 ? rest : rest.slice(0, next)
}

const textOf = (script: string) => {
  const open = script.indexOf('\n')
  const end = /<<'(\w+)'/.exec(script)![1]!
  return script.slice(open + 1, script.lastIndexOf(`${end}\n`))
}

/** A host with the engine's plain commands answered; `reviews` maps a reviewer's name to its findings or null. */
function judgeHost(opts: {
  findings?: Record<string, unknown[] | null>
  scores?: FakeOptions['scores']
  size?: (text: string, n: number) => string
  write?: () => { code: number; output: string } | undefined
  branch?: string
  override?: FakeOptions['override']
  commits?: FakeOptions['commits']
  status?: FakeOptions['status']
  name?: FakeOptions['name']
  reviews?: FakeOptions['reviews']
} = {}) {
  const writes: string[] = []
  const f = fakeHost({
    name: opts.name,
    scores: opts.scores,
    commits: opts.commits,
    status: opts.status,
    reviews: opts.reviews,
    checks: command => {
      if (command.includes('info/exclude')) return ''
      if (command.startsWith('date ')) return `${DATE}\n`
      if (command === 'git branch --show-current') return `${opts.branch ?? 'feat/x'}\n`
      if (command.includes("<<'")) {
        writes.push(textOf(command))
        return opts.write?.()
          ?? ''
      }
      if (command.startsWith('wc -c')) {
        const text = writes.at(-1)!
        return opts.size ? opts.size(text, writes.length) : `${Buffer.byteLength(text)}\n`
      }
      return undefined
    },
    override: req => {
      const custom = opts.override?.(req)
      if (custom !== undefined) return custom
      if (req.kind !== 'findings') return undefined
      const name = /review feat\/x r1 ([a-z0-9-]+)/.exec(req.label)?.[1] ?? 'kimi'
      const found = opts.findings?.[name]
      return found === null ? null : { findings: found ?? [] }
    },
  })
  return { ...f, writes }
}

describe('runJudge: the headings', () => {
  it('returns the repo without the trailing slash it was given', async () => {
    const r = await runJudge(judgeHost().host, { repo: `${REPO}/`, config: ONE })
    expect(r.repo).toBe(REPO)
  })

  it('counts a demoted word severity as a demoted P0 or P1', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'high')] }, scores: [{ 'kimi-F1': classes('minor') }] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.demoted).toEqual(['kimi-F1'])
  })

  it('maps the judge\'s impact to the heading, whatever the reviewer said', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P3'), raw('F2', 'P3'), raw('F3', 'P3'), raw('F4', 'P3')] },
      scores: [{ 'kimi-F1': classes('critical'), 'kimi-F2': classes('major'), 'kimi-F3': classes('moderate'), 'kimi-F4': classes('minor') }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.outcome).toBe('reviewed')
    expect(r.counts).toEqual({ P0: 1, P1: 1, P2: 1, P3: 1, dismissed: 0 })
    expect(under(r.report!, 'P0')).toContain('### F1 title')
    expect(under(r.report!, 'P1')).toContain('### F2 title')
    expect(under(r.report!, 'P2')).toContain('### F3 title')
    expect(under(r.report!, 'P3')).toContain('### F4 title')
    expect(r.report).not.toContain('## Dismissed by the judge')
    expect(under(r.report!, 'P0')).toContain('`src/a.ts:3` · `confirmed` `critical` `edge` `small` `in-scope` · priority 95 · `reviewer: P3` · from `kimi-F1`')
  })

  it('puts a refuted finding and impact none under Dismissed with the judge\'s reason, and keeps them', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P2'), raw('F2', 'P3')] },
      scores: [{ 'kimi-F1': classes('major', { verdict: 'refuted', reason: 'the guard at a.ts:9 stops it' }), 'kimi-F2': classes('none', { reason: 'not a problem' }) }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0, dismissed: 2 })
    const dismissed = under(r.report!, 'Dismissed by the judge')
    expect(dismissed).toContain('### F1 title')
    expect(dismissed).toContain('**Judge:** the guard at a.ts:9 stops it')
    expect(dismissed).toContain('### F2 title')
    expect(dismissed).toContain('**Judge:** not a problem')
    expect(dismissed).toContain('`demoted`')
    expect(r.findings).toHaveLength(2)
  })

  it('lets an unverified finding drop one class, under the existing rule', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P1'), raw('F2', 'P1')] },
      scores: [{ 'kimi-F1': classes('critical', { evidence: 'looks wrong, no location' }), 'kimi-F2': classes('major', { verdict: 'unverified' }) }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(under(r.report!, 'P1')).toContain('### F1 title')
    expect(under(r.report!, 'P1')).toContain('`unverified` `major`')
    expect(under(r.report!, 'P2')).toContain('### F2 title')
  })

  it('demotes a reviewer P0 the judge tagged moderate, and names it', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P0')] }, scores: [{ 'kimi-F1': classes('moderate') }] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.calls.filter(c => c.kind === 'judge')[0]!.prompt).toContain('"severity":"P0"')
    const p2 = under(r.report!, 'P2')
    expect(p2).toContain('### F1 title')
    expect(p2).toContain('`reviewer: P0` `demoted`')
    expect(r.demoted).toEqual(['kimi-F1'])
    expect(f.logs.join('\n')).toContain('kimi-F1')
  })

  it('names only a reviewer P0 or P1 in demoted, and tags every lowered finding', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P2'), raw('F2', 'P1'), raw('F3', 'P3')] },
      scores: [{ 'kimi-F1': classes('minor'), 'kimi-F2': classes('major'), 'kimi-F3': classes('critical') }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.demoted).toEqual([])
    expect(under(r.report!, 'P3')).toContain('`reviewer: P2` `demoted`')
    expect(under(r.report!, 'P1')).not.toContain('`demoted`')
    expect(under(r.report!, 'P0')).not.toContain('`demoted`')
  })

  it('does not let the threshold or alwaysFix change a heading or a merge', async () => {
    const run = async (extra: object) => {
      const f = judgeHost({
        findings: { kimi: [raw('F1', 'P2'), raw('F2', 'P2')] },
        scores: [{ 'kimi-F1': classes('moderate'), 'kimi-F2': classes('critical', { scope: 'pre-existing', duplicateOf: 'kimi-F1' }) }],
      })
      return (await runJudge(f.host, { repo: REPO, config: [ONE, extra] })).counts
    }
    const counts = await run({ threshold: 0, alwaysFix: ['moderate'] })
    expect(counts).toEqual(await run({ threshold: 100, alwaysFix: [] }))
    expect(counts.P0).toBe(1)
  })
})

describe('runJudge: a judge that does not answer', () => {
  it('keeps every finding under its severity when the judge answers nothing twice, and still writes the report', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P0'), raw('F2', 'P3'), raw('F3', 'major')] }, scores: [null, null] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.calls.filter(c => c.kind === 'judge').map(c => c.label)).toEqual(['tag feat/x', 'tag feat/x retry'])
    expect(r.notJudged).toEqual(['kimi-F1', 'kimi-F2', 'kimi-F3'])
    expect(r.counts).toEqual({ P0: 1, P1: 0, P2: 1, P3: 1, dismissed: 0 })
    expect(under(r.report!, 'P0')).toContain('`not judged`')
    expect(under(r.report!, 'P2')).toContain('### F3 title')
    expect(r.report).toContain("- Not judged: the judge left 3 finding(s) unclassified; they stay under the reviewer's severity")
    expect(r.demoted).toEqual([])
    expect(r.written).toBe(true)
    expect(f.writes).toEqual([r.report!])
  })

  it('retries a P0 the judge left out, the same as any other finding', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P0'), raw('F2', 'P2')] },
      scores: [{ 'kimi-F2': classes('minor') }, { 'kimi-F1': classes('moderate') }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    const judge = f.calls.filter(c => c.kind === 'judge')
    expect(judge.map(c => c.label)).toEqual(['tag feat/x', 'tag feat/x retry'])
    expect(judge[1]!.prompt).toContain('- kimi-F1: no classification in your answer')
    expect(r.notJudged).toEqual([])
    expect(r.demoted).toEqual(['kimi-F1'])
    expect(r.counts).toEqual({ P0: 0, P1: 0, P2: 1, P3: 1, dismissed: 0 })
  })

  it('names a P0\'s invalid classification in the retry, and leaves it under its severity after a second bad answer', async () => {
    const bad = { ...classes('critical'), impact: 'huge' }
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P0')] }, scores: [{ 'kimi-F1': bad }, { 'kimi-F1': bad }] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.calls.filter(c => c.kind === 'judge')[1]!.prompt).toContain('- kimi-F1: invalid classification: impact "huge"')
    expect(r.notJudged).toEqual(['kimi-F1'])
    expect(under(r.report!, 'P0')).toContain('`not judged`')
  })

  it('writes the report when the judge call throws on both tries', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P1')] },
      override: req => {
        if (req.kind === 'judge') throw new Error('provider down')
        return undefined
      },
    })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.notJudged).toEqual(['kimi-F1'])
    expect(r.written).toBe(true)
    expect(f.logs.join('\n')).toContain('provider down')
  })

  it('stops on a cancel during the judge call instead of reporting', async () => {
    let cancelled = false
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P1')] },
      override: req => {
        if (req.kind === 'judge') cancelled = true
        return undefined
      },
    })
    f.host.cancelled = () => cancelled
    await expect(runJudge(f.host, { repo: REPO, config: ONE })).rejects.toBeInstanceOf(GrannyCancelled)
    expect(f.writes).toEqual([])
  })
})

describe('runJudge: duplicates', () => {
  it('merges duplicates and lists both ids', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P2')], terra: [raw('F1', 'P2')] },
      scores: [{ 'kimi-F1': classes('major'), 'terra-F1': classes('major', { duplicateOf: 'kimi-F1' }) }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: TWO })
    expect(r.counts.P1).toBe(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.duplicates).toEqual(['terra-F1'])
    expect(under(r.report!, 'P1')).toContain('from `kimi-F1`, `terra-F1`')
  })

  it('keeps the worst reviewer severity of merged copies, so a demotion stays visible', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P3')], terra: [raw('F1', 'P0')] },
      scores: [{ 'kimi-F1': classes('minor'), 'terra-F1': classes('minor', { duplicateOf: 'kimi-F1' }) }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: TWO })
    expect(under(r.report!, 'P3')).toContain('`reviewer: P0` `demoted`')
    expect(r.demoted).toEqual(['kimi-F1'])
  })

  it('does not let a refuted copy of a higher class hide a confirmed one', async () => {
    const f = judgeHost({
      findings: { kimi: [raw('F1', 'P2')], terra: [raw('F1', 'P2')] },
      scores: [{ 'kimi-F1': classes('critical', { verdict: 'refuted' }), 'terra-F1': classes('minor', { duplicateOf: 'kimi-F1' }) }],
    })
    const r = await runJudge(f.host, { repo: REPO, config: TWO })
    expect(r.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 1, dismissed: 0 })
  })

  it('leaves no decision of the normal loop on the findings it returns', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P2')] }, scores: [{ 'kimi-F1': classes('major') }] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.findings[0]!.decision).toBeUndefined()
    expect(r.findings[0]!.priority).toBe(80)
  })
})

describe('runJudge: what is reviewed', () => {
  it('returns no-changes with no agent and no report on an empty range', async () => {
    const f = judgeHost({ commits: 0 })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r).toMatchObject({ outcome: 'no-changes', written: false, branch: 'feat/x', base: 'main', demoted: [], findings: [] })
    expect(r.report).toBeUndefined()
    expect(r.reportPath).toBeUndefined()
    expect(f.requests).toEqual([])
    expect(f.writes).toEqual([])
  })

  it('throws on a count that fails, naming the base and that the repo may use another', async () => {
    const f = fakeHost({
      commits: () => 0,
      checks: command => (command.startsWith('date ') ? `${DATE}\n` : command === 'git branch --show-current' ? 'feat/x\n' : undefined),
    })
    const run = f.host.run!
    f.host.run = (command, cwd) => (command.includes('git rev-list --count') ? Promise.resolve({ code: 128, output: "fatal: ambiguous argument 'main..HEAD'" }) : run(command, cwd))
    const failed = runJudge(f.host, { repo: REPO, config: ONE })
    await expect(failed).rejects.toThrow('main..HEAD')
    await expect(failed).rejects.toThrow('master')
    expect(f.requests).toEqual([])
  })

  it('reviews the given base, and uses the config\'s base without one', async () => {
    const f = judgeHost({ findings: { kimi: [] } })
    const r = await runJudge(f.host, { repo: REPO, base: 'develop', config: ONE })
    expect(r.base).toBe('develop')
    expect(f.calls[0]!.prompt).toContain('git diff develop...HEAD')
    const g = judgeHost()
    expect((await runJudge(g.host, { repo: REPO, config: [ONE, { base: 'trunk' }] })).base).toBe('trunk')
  })

  it('lists uncommitted files at the top and in the result, and does not refuse them', async () => {
    const f = judgeHost({ status: [' M src/a.ts\n?? new.ts\n'] })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.outcome).toBe('reviewed')
    expect(r.uncommitted).toEqual(['src/a.ts', 'new.ts'])
    expect(r.report).toContain('- Not reviewed: src/a.ts, new.ts')
  })

  it('tells the reviewer it is a one-shot review, in the Review phase', async () => {
    const f = judgeHost()
    await runJudge(f.host, { repo: REPO, context: 'look at the auth', config: ONE })
    const rv = f.calls.find(c => c.kind === 'findings')!
    expect(rv.prompt).toContain('one-shot review')
    expect(rv.prompt).toContain('nobody fixes anything in this run')
    expect(rv.prompt).toContain('report every problem you can confirm in the code')
    expect(rv.prompt).toContain('look at the auth')
    expect(rv.phase).toBe('Review')
    expect(rv.cwd).toBe(REPO)
    expect(f.phases).toEqual(['Review', 'Save report'])
  })

  it('names the short SHA on a detached HEAD, for the report and its file', async () => {
    const f = judgeHost({ branch: '' })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.branch).toBe('deadbee1')
    expect(r.reportPath).toBe(`${REPO}/.granny/reviews/${DATE}-deadbee1.md`)
    expect(r.report).toContain('# Granny judge - deadbee1')
    expect(f.calls[0]!.prompt).toContain('detached')
  })

  it('refuses a relative repo, and ignores fields it does not know', async () => {
    const f = judgeHost()
    await expect(runJudge(f.host, { repo: 'repo', config: ONE })).rejects.toThrow('repo must be an absolute path')
    expect(f.requests).toEqual([])
    const r = await runJudge(f.host, { repo: `${REPO}/`, stages: [], branch: 'other', config: ONE } as JudgeInput)
    expect(r.outcome).toBe('reviewed')
    expect(r.branch).toBe('feat/x')
    expect(r.reportPath).toBe(`${REPO}/.granny/reviews/${DATE}-feat-x.md`)
  })
})

describe('runJudge: reviewers that fail', () => {
  it('goes on when one of two fails twice, and the report says so', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P2')], terra: null }, scores: [{ 'kimi-F1': classes('major') }] })
    const r = await runJudge(f.host, { repo: REPO, config: TWO })
    expect(f.calls.filter(c => c.label.startsWith('review feat/x r1 terra'))).toHaveLength(2)
    expect(r.outcome).toBe('reviewed')
    expect(r.failedReviewers).toEqual([{ name: 'terra', note: 'reviewer agent returned nothing' }])
    expect(r.report).toContain('- Did not run: terra: reviewer agent returned nothing')
    expect(r.written).toBe(true)
  })

  it('returns review-failed with the notes and writes nothing when all fail', async () => {
    const f = judgeHost({ findings: { kimi: null, terra: null } })
    const r = await runJudge(f.host, { repo: REPO, config: TWO })
    expect(r.outcome).toBe('review-failed')
    expect(r.written).toBe(false)
    expect(r.report).toBeUndefined()
    expect(r.failedReviewers.map(x => x.name)).toEqual(['kimi', 'terra'])
    expect(r.note).toContain('kimi: reviewer agent returned nothing')
    expect(f.writes).toEqual([])
    expect(f.calls.some(c => c.kind === 'judge')).toBe(false)
  })

  it('keeps a long failure note to one short line in the report, whole in the result', async () => {
    const long = `line one\n${'x'.repeat(1500)}`
    const f = judgeHost({ reviews: [{ code: 1, output: long }, { code: 1, output: long }] })
    const r = await runJudge(f.host, { repo: REPO, config: { reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }, { name: 'cmd', engine: 'command', command: 'r {base}' }], ...ROLE_MODELS } })
    const line = r.report!.split('\n').find(l => l.startsWith('- Did not run: cmd:'))!
    expect(line.length).toBeLessThan(400)
    expect(r.failedReviewers[0]!.note).toContain(long)
  })

  it('reads findings from a command reviewer as usual', async () => {
    const f = judgeHost({ reviews: [review(finding('P1', 'Off by one'))], scores: [{ 'cmd-F1': classes('major') }] })
    const r = await runJudge(f.host, { repo: REPO, config: { reviewers: [{ name: 'cmd', engine: 'command', command: 'r {base}' }], ...ROLE_MODELS } })
    expect(under(r.report!, 'P1')).toContain('### Off by one')
  })
})

describe('runJudge: the config gate', () => {
  const gated = async (layers: unknown[], name: FakeOptions['name'], text: string) => {
    const f = judgeHost({ name })
    await expect(runJudge(f.host, { repo: REPO, config: layers })).rejects.toThrow(`granny judge needs models: ${text}`)
    expect(f.requests).toEqual([])
    expect(f.commands).toEqual([])
    expect(f.probes).toEqual([])
    expect(f.phases).toEqual([])
  }

  it('throws on each gap before anything runs', async () => {
    await gated([ROLE_MODELS], 'omp', 'reviewers: no config sets who reviews')
    await gated([{ reviewers: [{ name: 'kimi', engine: 'agent' }], ...ROLE_MODELS }], 'omp', 'reviewers[0] (kimi): no model for omp')
    await gated([{ reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }] }], 'omp', 'roles.judge.model: no model for omp')
  })

  it('names every gap in the one error', async () => {
    await gated([], 'omp', 'reviewers: no config sets who reviews; roles.judge.model: no model for omp')
  })

  it('passes with reviewers and a judge model on the host', async () => {
    const f = judgeHost({ name: 'omp' })
    const r = await runJudge(f.host, { repo: REPO, config: { reviewers: [{ name: 'kimi', engine: 'agent', model: { omp: 'k' } }], roles: { judge: { model: { omp: 'j' } } } } })
    expect(r.outcome).toBe('reviewed')
  })

  it('lets the built-in haiku pass on Claude Code and not on omp', async () => {
    const layer = { reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }] }
    const f = judgeHost({ name: 'claude-code', findings: { kimi: [raw('F1', 'P2')] } })
    await runJudge(f.host, { repo: REPO, config: layer })
    expect(f.calls.find(c => c.kind === 'judge')!.model).toBe('haiku')
    await gated([layer], 'omp', 'roles.judge.model: no model for omp')
  })
})

describe('runJudge: hands off', () => {
  const clean = (f: ReturnType<typeof judgeHost>) => {
    expect(f.setups).toEqual([])
    expect(f.requests.some(c => c.role === 'implementer' || c.role === 'planner')).toBe(false)
    for (const c of f.commands) expect(c).not.toMatch(/git (commit|worktree|checkout|switch|push|add|stash|reset)\b/)
  }

  it('asks only read-only agents, with no worktree, commit or implementer', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P1')] }, scores: [{ 'kimi-F1': classes('major') }] })
    await runJudge(f.host, { repo: REPO, config: [ONE, { checks: [{ name: 'tests', run: 'exit 1' }], worktree: true, maxRounds: 9 }] })
    expect(f.requests.map(c => c.access)).toEqual(['read-only', 'read-only'])
    expect(f.requests.map(c => c.role)).toEqual(['reviewer', 'judge'])
    clean(f)
    expect(f.commands.some(c => c.includes('exit 1'))).toBe(false)
  })

  it('tags with a read-only judge on the judge\'s schema, every finding included', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P0'), raw('F2', 'P3')] }, scores: [{ 'kimi-F1': classes('major'), 'kimi-F2': classes('minor') }] })
    await runJudge(f.host, { repo: REPO, config: [ONE, { roles: { judge: { model: 'j', effort: 'high' } } }] })
    const j = f.calls.find(c => c.kind === 'judge')!
    expect(j).toMatchObject({ role: 'judge', label: 'tag feat/x', phase: 'Tagging', access: 'read-only', model: 'j', effort: 'high', cwd: REPO })
    expect(j.schema).toBe(SCHEMAS.judge)
    expect(j.prompt).toContain('"id":"kimi-F1"')
    expect(j.prompt).toContain('"id":"kimi-F2"')
    expect(j.prompt).toContain('Use scope in-scope or pre-existing only')
    expect(j.prompt).toContain('duplicateOf')
    expect(j.prompt).toContain('verdict: confirmed')
    expect(j.prompt).not.toContain('EARLIER DECISIONS')
    expect(j.prompt).not.toContain('go to the implementer')
    expect(j.prompt).not.toContain('TASK')
    expect(f.phases).toEqual(['Review', 'Tagging', 'Save report'])
  })

  it('starts no judge on a clean review, and writes the same file with every heading None.', async () => {
    const f = judgeHost()
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.calls.some(c => c.kind === 'judge')).toBe(false)
    expect(r.outcome).toBe('reviewed')
    for (const p of ['P0', 'P1', 'P2', 'P3']) expect(under(r.report!, p).trim()).toBe(`## ${p}\n\nNone.`)
    expect(r.written).toBe(true)
  })
})

describe('runJudge: writing the report', () => {
  let root: string
  let repo: string
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "granny judge's ")))
    repo = join(root, 'r')
    mkdirSync(repo)
    git('init', '-qb', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.ts'), 'one\n')
    git('add', 'a.ts')
    git('commit', '-qm', 'one')
    git('checkout', '-qb', 'feat/x')
    writeFileSync(join(repo, 'a.ts'), 'two\n')
    git('commit', '-qam', 'two')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const NASTY = 'é ğ 日本語 🦀 $HOME `id` "q" \\ \'s\'\nGRANNY_REPORT_END\nGRANNY_REPORT_END_\n## P0\nend'
  const nasty = { id: 'F1', severity: 'P1', file: 'a.ts', line: 1, title: 'Ünicode\n title', detail: NASTY }

  const readReport = (r: JudgeResult) => readFileSync(r.reportPath!)

  it('writes the exact bytes through a real shell, whatever the text holds, and leaves the repo as it was', async () => {
    const head = git('rev-parse', 'HEAD')
    const f = fakeHost({
      commits: 'git',
      shell: {},
      scores: [{ 'kimi-F1': classes('major', { reason: 'réel' }) }],
      override: req => (req.kind === 'findings' ? { findings: [nasty] } : undefined),
    })
    const r = await runJudge(f.host, { repo, config: ONE })
    expect(r.written).toBe(true)
    expect(r.reportPath).toStartWith(`${repo}/.granny/reviews/`)
    expect(r.reportPath).toEndWith('-feat-x.md')
    expect(readReport(r).toString('utf8')).toBe(r.report!)
    expect(r.report).toContain(NASTY.replace('## P0', '\\## P0'))
    expect(r.report).toContain('### Ünicode title')
    expect(r.head).toBe(head)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('branch', '--show-current')).toBe('feat/x')
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('reports uncommitted files through a real shell, without its own work dir', async () => {
    writeFileSync(join(repo, 'a.ts'), 'three\n')
    const f = fakeHost({ commits: 'git', shell: {}, override: req => (req.kind === 'findings' ? { findings: [] } : undefined) })
    const r = await runJudge(f.host, { repo, config: ONE })
    expect(r.uncommitted).toEqual(['a.ts'])
    const again = fakeHost({ commits: 'git', shell: {}, override: req => (req.kind === 'findings' ? { findings: [] } : undefined) })
    expect((await runJudge(again.host, { repo, config: ONE })).uncommitted).toEqual(['a.ts'])
  })

  it('names a base that is not there and master in the error, through a real shell', async () => {
    const f = fakeHost({ commits: 'git', shell: {} })
    await expect(runJudge(f.host, { repo, base: 'nope', config: ONE })).rejects.toThrow(/nope.*master/s)
    expect(f.requests).toEqual([])
  })

  it('refuses outside a git repository, through a real shell', async () => {
    const f = fakeHost({ commits: 'git', shell: {} })
    await expect(runJudge(f.host, { repo: root, config: ONE })).rejects.toThrow('not a git repository')
    expect(f.requests).toEqual([])
  })

  it('writes once more on a byte mismatch, then keeps the report in the result', async () => {
    const f = judgeHost({ findings: { kimi: [raw('F1', 'P2')] }, scores: [{ 'kimi-F1': classes('major') }], size: () => '3\n' })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.writes).toHaveLength(2)
    expect(r.written).toBe(false)
    expect(r.report).toContain('### F1 title')
    expect(r.reportPath).toBe(`${REPO}/.granny/reviews/${DATE}-feat-x.md`)
    expect(r.note).toContain(r.reportPath!)
    expect(f.logs.join('\n')).toContain('not written')
  })

  it('is written when the second try gets the bytes right', async () => {
    const f = judgeHost({ size: (text, n) => (n === 1 ? '3\n' : `${Buffer.byteLength(text)}\n`) })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.writes).toHaveLength(2)
    expect(r.written).toBe(true)
    expect(r.note).toBeUndefined()
  })

  it('counts a size it cannot read as a mismatch', async () => {
    const f = judgeHost({ size: () => 'wc: no such file\n' })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.writes).toHaveLength(2)
    expect(r.written).toBe(false)
  })

  it('does not write again after a failed write, and keeps the report', async () => {
    const f = judgeHost({ write: () => ({ code: 1, output: 'disk full' }) })
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(f.writes).toHaveLength(1)
    expect(r.written).toBe(false)
    expect(r.report).toContain('# Granny judge - feat/x')
    expect(f.logs.join('\n')).toContain('disk full')
  })

  it('keeps the report when the runner itself throws while writing', async () => {
    const f = judgeHost()
    const run = f.host.run!
    f.host.run = (command, cwd) => (command.includes("<<'") ? Promise.reject(new Error('runner died')) : run(command, cwd))
    const r = await runJudge(f.host, { repo: REPO, config: ONE })
    expect(r.written).toBe(false)
    expect(r.report).toContain('# Granny judge - feat/x')
    expect(f.logs.join('\n')).toContain('runner died')
  })

  it('stops on a cancel while writing instead of reporting a failed write', async () => {
    let cancelled = false
    const f = judgeHost()
    const run = f.host.run!
    f.host.run = (command, cwd) => {
      if (!command.includes("<<'")) return run(command, cwd)
      cancelled = true
      return Promise.reject(new Error('killed'))
    }
    f.host.cancelled = () => cancelled
    await expect(runJudge(f.host, { repo: REPO, config: ONE })).rejects.toBeInstanceOf(GrannyCancelled)
  })

  const helperAnswer = (req: AgentRequest) => {
    const script = /Run exactly this[^\n]*:\n([\s\S]*)\n\nReturn ran:/.exec(req.prompt)![1]!
    const done = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    return { ran: done.status === 0, exitCode: done.status, output: done.stdout + done.stderr }
  }

  it('works through a helper on a host without run, the wrapped heredoc included', async () => {
    const f = fakeHost({
      direct: false,
      name: 'claude-code',
      commits: 'git',
      scores: [{ 'kimi-F1': classes('major') }],
      override: req => (req.kind === 'findings' ? { findings: [nasty] } : req.kind === 'command' ? helperAnswer(req) : undefined),
    })
    const r = await runJudge(f.host, { repo, config: ONE })
    expect(r.outcome).toBe('reviewed')
    expect(r.written).toBe(true)
    expect(readReport(r).toString('utf8')).toBe(r.report!)
    expect(r.branch).toBe('feat/x')
    const helpers = f.requests.filter(c => c.kind === 'command')
    expect(helpers.length).toBeGreaterThan(0)
    expect(new Set(helpers.map(c => c.role))).toEqual(new Set(['helper']))
    expect(helpers.map(c => c.label)).toContain('write report')
    expect(f.requests.filter(c => c.kind !== 'command').map(c => c.access)).toEqual(['read-only', 'read-only'])
    expect(git('status', '--porcelain')).toBe('')
    expect(f.calls.some(c => c.role === 'implementer')).toBe(false)
  })

  it('tells the helper the write is the one file and spans several lines', async () => {
    const f = fakeHost({
      direct: false,
      name: 'claude-code',
      commits: 'git',
      override: req => (req.kind === 'findings' ? { findings: [] } : req.kind === 'command' ? helperAnswer(req) : undefined),
    })
    await runJudge(f.host, { repo, config: ONE })
    const write = f.requests.find(c => c.label === 'write report')!
    expect(write.prompt).toContain('the one file this run writes')
    expect(write.prompt).toContain('line breaks')
    expect(write.phase).toBe('Save report')
  })
})

describe('renderReport', () => {
  const judged = (over: Partial<Finding>): Finding => ({
    id: 'kimi-F1',
    severity: 'P2',
    file: 'src/a.ts',
    line: 12,
    title: 'A title',
    detail: 'The detail.',
    verdict: 'confirmed',
    impact: 'critical',
    likelihood: 'edge',
    fixCost: 'small',
    scope: 'in-scope',
    evidence: 'src/a.ts:12 - trigger',
    priority: 95,
    reason: 'real',
    ...over,
  })
  const META: ReportMeta = {
    branch: 'feat/x',
    base: 'main',
    head: 'abcd1234',
    commits: 2,
    repo: '/r',
    when: DATE,
    reviewers: [{ name: 'kimi', engine: 'agent', model: 'k' }, { name: 'codex', engine: 'auto' }],
    judge: 'haiku',
    uncommitted: [],
    failed: [],
  }

  it('renders the agreed shape', () => {
    const f = judged({ severity: 'P1', duplicates: ['codex-F2'] })
    expect(renderReport(META, [f])).toBe(`# Granny judge - feat/x

- Reviewed: \`main...HEAD\` at abcd1234, 2 commit(s), in /r
- When: ${DATE}
- Reviewers: kimi (agent, k), codex (auto) · Judge: haiku
- Totals: P0 1, P1 0, P2 0, P3 0, dismissed 0

## P0

### A title

\`src/a.ts:12\` · \`confirmed\` \`critical\` \`edge\` \`small\` \`in-scope\` · priority 95 · \`reviewer: P1\` · from \`kimi-F1\`, \`codex-F2\`

The detail.

**Evidence:** src/a.ts:12 - trigger

**Judge:** real

## P1

None.

## P2

None.

## P3

None.
`)
  })

  it('sorts by priority, then file and line', () => {
    const titles = (text: string) => [...text.matchAll(/^### (.*)$/gm)].map(m => m[1])
    const text = renderReport(META, [
      judged({ title: 'low', priority: 90 }),
      judged({ title: 'b-file', file: 'b.ts', priority: 95 }),
      judged({ title: 'a-line-9', file: 'a.ts', line: 9, priority: 95 }),
      judged({ title: 'a-line-2', file: 'a.ts', line: 2, priority: 95 }),
    ])
    expect(titles(text)).toEqual(['a-line-2', 'a-line-9', 'b-file', 'low'])
  })

  it('ends in one newline, whatever the last finding ends in, so the heredoc closes', () => {
    const text = renderReport(META, [judged({ impact: 'minor', detail: 'tail\n\n', reason: undefined, evidence: undefined })])
    expect(text.endsWith('tail\n')).toBe(true)
  })

  it('leaves out what a finding does not have', () => {
    const text = renderReport(META, [{ id: 'kimi-F1', severity: 'P3', file: 'a.ts', title: 't', detail: '' }])
    expect(under(text, 'P3')).toBe('## P3\n\n### t\n\n`a.ts` · `not judged` · `reviewer: P3` · from `kimi-F1`\n')
  })

  it('renders a finding missing its fields without throwing', () => {
    const text = renderReport(META, [{ id: 'kimi-F1', severity: 'P3' } as Finding])
    expect(text).toContain('### (no title)')
    expect(text).toContain('`not judged` · `reviewer: P3` · from `kimi-F1`')
  })

  it('reads a word severity the way the loop does, and an unknown one as P2', () => {
    const f = { id: 'kimi-F1', severity: 'high', file: 'a.ts', title: 't', detail: '' }
    expect(bucketOf(f)).toBe('P1')
    expect(under(renderReport(META, [f]), 'P1')).toContain('`reviewer: P1`')
    expect(['critical', 'HIGH', 'medium', 'low'].map(severity => bucketOf({ ...f, severity }))).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(bucketOf({ ...f, severity: 'P1 must fix' })).toBe('P1')
    expect(bucketOf({ ...f, severity: 'p0' })).toBe('P0')
    expect(bucketOf({ ...f, severity: 'whatever' })).toBe('P2')
  })

  it('shows a word severity the judge lowered as demoted', () => {
    const f = judged({ severity: 'critical', impact: 'minor' })
    expect(under(renderReport(META, [f]), 'P3')).toContain('`reviewer: P0` `demoted`')
  })

  describe('reviewer text that looks like the report', () => {
    const headings = (text: string) => text.split('\n').filter(l => /^ {0,3}#{1,6}\s/.test(l))
    const clean = headings(renderReport(META, [judged({ impact: 'minor', title: 'real', detail: 'x', evidence: 'y', reason: 'z' })]))

    it('cannot add a heading from the detail, the evidence or the judge reason', () => {
      const fake = '## P0\n### Everything is fine\n   # also this'
      const text = renderReport(META, [judged({ impact: 'minor', title: 'real', detail: fake, evidence: fake, reason: fake })])
      expect(headings(text)).toEqual(clean)
      expect(text).toContain('\\## P0')
      expect(under(text, 'P0')).toBe('## P0\n\nNone.\n')
    })

    it('cannot turn a line into a heading by underlining it', () => {
      const text = renderReport(META, [judged({ impact: 'minor', detail: 'Fake title\n===\nOther title\n---\nThird\n-' })])
      expect(text).toContain('Fake title\n\\===\nOther title\n\\---\nThird\n\\-')
    })

    it('leaves a heading-like line inside a code fence as it is', () => {
      const text = renderReport(META, [judged({ impact: 'minor', detail: 'before\n```sh\n# a comment\n---\n```\n## after' })])
      expect(text).toContain('```sh\n# a comment\n---\n```\n\\## after')
    })

    it('closes a fence the reviewer left open, so the rest of the report is not swallowed', () => {
      const detail = '```ts\nconst a = 1'
      const text = renderReport(META, [judged({ impact: 'minor', title: 'first', detail, evidence: undefined, reason: undefined }), judged({ impact: 'minor', title: 'second', evidence: undefined, reason: undefined })])
      expect(text).toContain('```ts\nconst a = 1\n```\n\n### ')
      expect(text.split('\n').filter(l => l.startsWith('```')).length % 2).toBe(0)
    })

    it('does not take inline code at the start of a line for a fence', () => {
      const text = renderReport(META, [judged({ impact: 'minor', detail: '```a``` is wrong\n# heading' })])
      expect(text).toContain('```a``` is wrong\n\\# heading')
      expect(text).not.toContain('# heading\n```')
    })

    it('does not close a fence on a longer one\'s shorter marker', () => {
      const text = renderReport(META, [judged({ impact: 'minor', detail: '````md\n```\n# inner\n```\n````\n# outer' })])
      expect(text).toContain('````md\n```\n# inner\n```\n````\n\\# outer')
    })
  })

  it('maps every impact to its bucket', () => {
    const bucket = (impact: Finding['impact'], verdict: Finding['verdict'] = 'confirmed') => bucketOf(judged({ impact, verdict }))
    expect(['critical', 'major', 'moderate', 'minor', 'none'].map(i => bucket(i as Finding['impact']))).toEqual(['P0', 'P1', 'P2', 'P3', 'dismissed'])
    expect(bucket('critical', 'refuted')).toBe('dismissed')
    expect(bucket('critical', 'unverified')).toBe('P0')
  })
})

describe('utf8Length', () => {
  it('matches the bytes a file holds, without TextEncoder', () => {
    for (const text of ['', 'abc\n', 'é', 'ğ', '日本語', '🦀', 'a\u{10FFFF}b', 'x\r\ny']) expect(utf8Length(text)).toBe(Buffer.byteLength(text))
  })
})

describe('heredocWriteScript', () => {
  it('picks a delimiter that does not occur in the text', () => {
    const script = heredocWriteScript('/r/a b/f.md', 'GRANNY_REPORT_END\nGRANNY_REPORT_END_x\n')
    expect(script).toStartWith("mkdir -p '/r/a b' && cat > '/r/a b/f.md' <<'GRANNY_REPORT_END__'\n")
    expect(script).toEndWith('\nGRANNY_REPORT_END__\n')
  })
})

describe('a normal run', () => {
  it('keeps the judge in the review it serves, and enters no phase of a judge run', async () => {
    const f = fakeHost({
      scores: [{ 'kimi-F1': 90 }, { 'kimi-F1': 90 }],
      override: req => (req.label === 'review one r1 kimi' || req.label === 'review final review r1 kimi' ? { findings: [raw('F1', 'P2')] } : undefined),
    })
    await runGranny(f.host, { repo: REPO, branch: 'feat/x', base: 'main', stages: [{ name: 'one', task: 'WP-01' }, { name: 'two', task: 'WP-02' }], config: ONE })
    const phaseOf = (label: string) => f.calls.find(c => c.label === label)!.phase
    expect(phaseOf('review one r1 kimi')).toBe('Review')
    expect(phaseOf('judge one r1')).toBe('Review')
    expect(phaseOf('review final review r1 kimi')).toBe('Final review')
    expect(phaseOf('judge final review r1')).toBe('Final review')
    expect(f.phases).toContain('Final review')
    for (const phase of ['Tagging', 'Save report', 'Judge', 'Report']) expect(f.phases).not.toContain(phase)
  })
})

describe('Claude Code entry', () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const load = (script: string) => new AsyncFunction('agent', 'log', 'phase', 'args', script.replace(/^export const meta/, 'const meta'))

  it('runs a judge run on args.judge, through the helper', async () => {
    const script = await buildClaudeCode()
    const agents: Array<{ prompt: string; opts: any }> = []
    const phases: string[] = []
    const written: string[] = []
    const agent = async (prompt: string, opts: any) => {
      agents.push({ prompt, opts })
      const kind = Object.keys(opts.schema.properties).join(',')
      if (kind.startsWith('perFinding')) return { perFinding: [{ id: 'kimi-F1', ...classes('major'), reason: 'real' }] }
      if (kind.startsWith('findings') || opts.label.startsWith('review ')) return { findings: [raw('F1', 'P0')], clean: false }
      const say = (output: string) => ({ ran: true, exitCode: 0, output })
      if (opts.label === 'date') return say(`${DATE}\n`)
      if (opts.label === 'branch') return say('feat/x\n')
      if (opts.label === 'head') return say('abcdef1234\n')
      if (opts.label === 'commits') return say('2\n')
      if (opts.label === 'write report') {
        written.push(prompt)
        return say('')
      }
      if (opts.label === 'report size') {
        const text = /<<'\w+'\n([\s\S]*)GRANNY_REPORT_END\n \) 2>&1/.exec(written.at(-1)!)![1]!
        return say(`${Buffer.byteLength(text)}\n`)
      }
      return say('')
    }
    const result = await load(script)(agent, () => {}, (t: string) => phases.push(t), { judge: true, repo: '/r', config: [ONE] })
    expect(phases).toEqual(['Review', 'Tagging', 'Save report'])
    expect(result).toMatchObject({ outcome: 'reviewed', written: true, demoted: ['kimi-F1'], counts: { P1: 1 } })
    expect(agents.some(a => /worktree/.test(a.opts.label))).toBe(false)
    expect(script).not.toContain('TextEncoder')
  })

  it('still fails the Workflow on a gap, before any agent', async () => {
    const script = await buildClaudeCode()
    let calls = 0
    const run = load(script)(async () => (calls++, null), () => {}, () => {}, { judge: true, repo: '/r', config: [] })
    await expect(run).rejects.toThrow('granny judge needs models: reviewers: no config sets who reviews')
    expect(calls).toBe(0)
  })

  it('takes a normal run when judge is not exactly true', async () => {
    const script = await buildClaudeCode()
    const run = load(script)(async () => null, () => {}, () => {}, { judge: 'yes', repo: '/r', config: [ONE] })
    await expect(run).rejects.toThrow('Invalid granny input')
  })

  it('lists a normal run\'s phases up to PR ready in the meta, then the two only a judge run has, and names the mode', async () => {
    const script = await buildClaudeCode()
    const meta = script.slice(0, script.indexOf('\n}\n') + 2)
    expect([...meta.matchAll(/\{ title: '([^']+)' \}/g)].map(m => m[1])).toEqual(['Worktree', 'Plan', 'Plan review', 'Implement', 'Checks', 'Review', 'Final review', 'PR ready', 'Tagging', 'Save report'])
    expect(meta).toMatch(/description: '.*review-only/)
    expect(meta).toMatch(/whenToUse: '.*judge: true/)
  })
})
