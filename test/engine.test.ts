import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGranny, type RunInput } from '../src/core/engine'
import { fakeHost, finding, review } from './fake-host'

const input = (extra: Partial<RunInput> = {}): RunInput => ({
  repo: '/work/repo',
  branch: 'feat/x',
  base: 'main',
  stages: [{ name: 'core', task: 'Do WP-01.' }],
  ...extra,
})

describe('runGranny', () => {
  it('ends a stage clean when the first review has no findings', async () => {
    const f = fakeHost({ reviews: ['I did not find any issues.'] })
    const r = await runGranny(f.host, input())
    expect(r.stages).toHaveLength(1)
    expect(r.stages[0]).toMatchObject({ stage: 'core', outcome: 'clean', rounds: 1 })
    expect(f.calls.map(c => c.kind)).toEqual(['implementation', 'final'])
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0]).toContain('codex exec review --base start1 -o .granny/review-core-r1.md')
    expect(f.phases).toEqual(['Implement', 'Review', 'PR ready'])
    expect(r.final?.gatesGreen).toBe(true)
  })

  it('sends P0/P1 at any score and others above the threshold, keeps the rest as residual', async () => {
    const f = fakeHost({
      reviews: [review(finding('P1', 'Blocker bug'), finding('P2', 'Borderline'), finding('P2', 'Real issue')), 'No issues.'],
      scores: [{ F1: 10, F2: 70, F3: 71 }],
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    const fix = f.calls.find(c => c.label === 'fix core r1')!
    expect(fix.prompt).toContain('Blocker bug')
    expect(fix.prompt).toContain('Real issue')
    expect(fix.prompt).not.toContain('Borderline')
    expect(f.logs.some(l => l.includes('not sent: F2(70)'))).toBe(true)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.score)).toEqual([10, 70, 71])
  })

  it('stops with residual-only when nothing is above the threshold', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Meh'), finding('P3', 'Nit'))], scores: [{ F1: 40, F2: 70 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'residual-only', rounds: 1 })
    expect(r.stages[0]!.residual.map(x => x.title)).toEqual(['Meh', 'Nit'])
    expect(f.calls.some(c => c.label.startsWith('fix'))).toBe(false)
  })

  it('honours a configured threshold', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Meh')), 'No issues.'], scores: [{ F1: 40 }] })
    const r = await runGranny(f.host, input({ config: { threshold: 30 } }))
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
  })

  it('hits the round cap and reports the last findings as unresolved', async () => {
    const bad = review(finding('P1', 'Still broken'))
    const f = fakeHost({ reviews: [bad, bad], scores: [{ F1: 90 }, { F1: 90 }] })
    const r = await runGranny(f.host, input({ config: { maxRounds: 2 } }))
    expect(r.stages[0]).toMatchObject({ outcome: 'round-cap', rounds: 2 })
    expect(r.stages[0]!.unresolved.map(x => x.title)).toEqual(['Still broken'])
    expect(f.calls.filter(c => c.label.startsWith('fix')).length).toBe(2)
    expect(f.logs.at(-1)).toContain('2-round cap')
  })

  it('stops the loop when the review command fails instead of inventing findings', async () => {
    const f = fakeHost({ reviews: [{ code: 1, output: 'codex: not logged in' }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('not logged in')
    expect(f.calls.some(c => c.kind === 'score')).toBe(false)
  })

  it('fails the review instead of reporting clean when Codex returned no structured result', async () => {
    const f = fakeHost({ reviews: ['# Codex Adversarial Review\n\nCodex did not return valid structured JSON.\n\n- Parse error: Unexpected end of JSON input\n'] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('Codex did not return valid structured JSON.')
    expect(r.stages[0]!.note).toContain('Unexpected end of JSON input')
    expect(f.calls.some(c => c.kind === 'score' || c.kind === 'findings')).toBe(false)
  })

  it('sends every finding when the judge returns nothing, and says so', async () => {
    const f = fakeHost({ reviews: [review(finding('P3', 'Nit'), finding('P3', 'Other nit')), 'No issues.'], scores: [null] })
    await runGranny(f.host, input())
    expect(f.calls.some(c => c.label === 'fix core r1')).toBe(true)
    expect(f.logs).toContain('core r1: judge returned nothing - all 2 finding(s) go to the implementer unscored')
  })

  it('does not report an unscored send when the judge answers', async () => {
    const f = fakeHost({ reviews: [review(finding('P3', 'Nit')), 'No issues.'], scores: [{ F1: 90 }] })
    await runGranny(f.host, input())
    expect(f.logs.some(l => l.includes('judge returned nothing'))).toBe(false)
  })

  it('skips the review loop for stages marked review: false', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ stages: [{ task: 'docs only', review: false }] }))
    expect(r.stages[0]).toMatchObject({ stage: 'stage 1', outcome: 'review-skipped', rounds: 0 })
    expect(f.commands).toHaveLength(0)
  })

  it('resumes from a later stage', async () => {
    const f = fakeHost()
    const r = await runGranny(f.host, input({ stages: [{ name: 'a', task: 'A' }, { name: 'b', task: 'B' }], fromStage: 2 }))
    expect(r.stages.map(s => [s.stage, s.outcome])).toEqual([['a', 'skipped'], ['b', 'clean']])
    const impl = f.calls.find(c => c.kind === 'implementation')!
    expect(impl.prompt).toContain('Stage 2/2: "b"')
    expect(impl.prompt).toContain('Earlier stages are done')
  })

  it('reviews an existing branch against the base in a review-only stage, then fixes', async () => {
    const f = fakeHost({ reviews: [review(finding('P1', 'Existing bug')), 'No issues.'], scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input({ stages: [{ name: 'audit', implement: false }] }))
    expect(r.stages[0]).toMatchObject({ stage: 'audit', outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.implementation).toBeUndefined()
    expect(f.calls.map(c => c.label)).toEqual(['judge audit r1', 'fix audit r1', 'pr-ready check'])
    expect(f.commands[0]).toContain('codex exec review --base main -o')
    expect(f.phases).toEqual(['Review', 'PR ready'])
  })

  it('rejects a stage with nothing to do, and a working stage without a task', async () => {
    const f = fakeHost()
    await expect(runGranny(f.host, input({ stages: [{ implement: false, review: false }] }))).rejects.toThrow('nothing to do')
    await expect(runGranny(f.host, input({ stages: [{ name: 'x' }] }))).rejects.toThrow('stages[0].task is required')
    expect(f.calls).toHaveLength(0)
  })

  it('does not ask for an extraction when a finding detail quotes a [Px] bullet', async () => {
    const f = fakeHost({ reviews: [review(`${finding('P2', 'Real one')}\n  - [P1] quoted from an earlier round`), 'No issues.'], scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input())
    expect(f.calls.some(c => c.kind === 'findings')).toBe(false)
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Real one'])
  })

  it('falls back to an extraction agent when the parser misses findings', async () => {
    const f = fakeHost({
      reviews: ['- [P1] no location here\n  detail', 'No issues.'],
      scores: [{ F1: 90 }],
      override: req =>
        req.kind === 'findings' ? { findings: [{ id: 'F1', severity: 'P1', file: 'x.ts', title: 'Extracted', detail: 'd' }] } : undefined,
    })
    const r = await runGranny(f.host, input())
    const extract = f.calls.find(c => c.kind === 'findings')!
    expect(extract.role).toBe('granny')
    expect(extract.access).toBe('read-only')
    expect(r.stages[0]!.history[0]!.findings[0]!.title).toBe('Extracted')
  })

  for (const [label, extracted] of [['an empty list', { findings: [] }], ['nothing', null]] as const) {
    it(`fails the review instead of reporting clean when extraction returns ${label}`, async () => {
      const f = fakeHost({
        reviews: ['- [P1] no location here\n  detail'],
        override: req => (req.kind === 'findings' ? extracted : undefined),
      })
      const r = await runGranny(f.host, input())
      expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
      expect(r.stages[0]!.note).toContain('1 finding marker(s), parser read 0')
      expect(r.stages[0]!.note).toContain('no location here')
      expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
    })
  }

  it('fails the review rather than fixing only the parsed part when extraction returns nothing', async () => {
    const f = fakeHost({ reviews: [review(finding('P2', 'Parsed one'), '- [P1] unparseable\n  d')] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 1')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  const extracted = (...titles: string[]) => ({
    findings: titles.map((title, i) => ({ id: `F${i + 1}`, severity: 'P1', file: 'x.ts', title, detail: 'd' })),
  })
  const twoUnparseable = '- [P1] first without a location\n  d\n- [P2] second without a location\n  d'

  it('asks again with the expected count when extraction recovers fewer findings than markers', async () => {
    const answers = [extracted('Only one'), extracted('One', 'Two')]
    const f = fakeHost({
      reviews: [twoUnparseable, 'No issues.'],
      scores: [{ F1: 90, F2: 90 }],
      override: req => (req.kind === 'findings' ? answers.shift() : undefined),
    })
    const r = await runGranny(f.host, input())
    const extracts = f.calls.filter(c => c.kind === 'findings')
    expect(extracts.map(c => c.label)).toEqual(['extract core r1', 'extract core r1 retry'])
    expect(extracts[1]!.prompt).toContain('2 finding marker(s)')
    expect(extracts[1]!.prompt).toContain('returned 1')
    expect(f.logs).toContain('core r1: extraction recovered 1/2 findings - asking once more with the expected count')
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['One', 'Two'])
  })

  it('fails the review with both counts when extraction stays short after the retry', async () => {
    const f = fakeHost({ reviews: [twoUnparseable], override: req => (req.kind === 'findings' ? extracted('Only one') : undefined) })
    const r = await runGranny(f.host, input())
    expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(2)
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 0')
    expect(r.stages[0]!.note).toContain('extraction recovered 1, then 1 on a retry that named the count')
    expect(r.stages[0]!.note).toContain('second without a location')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  it('does not drop the unparsed rest when extraction returns only what the parser already read', async () => {
    const f = fakeHost({
      reviews: [review(finding('P2', 'Parsed one'), '- [P1] unparseable\n  d')],
      override: req => (req.kind === 'findings' ? extracted('Parsed one') : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('2 finding marker(s), parser read 1')
    expect(f.calls.some(c => c.kind === 'score' || c.label.startsWith('fix'))).toBe(false)
  })

  it('accepts an extraction that recovers more findings than markers', async () => {
    const f = fakeHost({
      reviews: ['- [P1] no location here\n  detail', 'No issues.'],
      scores: [{ F1: 90, F2: 90 }],
      override: req => (req.kind === 'findings' ? extracted('A', 'B') : undefined),
    })
    const r = await runGranny(f.host, input())
    expect(f.calls.filter(c => c.kind === 'findings')).toHaveLength(1)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['A', 'B'])
  })

  it('uses an agent reviewer when configured, with no shell command', async () => {
    const f = fakeHost({
      override: req => (req.kind === 'findings' ? { findings: [] } : undefined),
    })
    const r = await runGranny(
      f.host,
      input({ config: { roles: { reviewer: { engine: 'agent', model: { opencode: 'zai/glm-5' } } } } }),
    )
    expect(r.stages[0]!.outcome).toBe('clean')
    expect(f.commands).toHaveLength(0)
    const rev = f.calls.find(c => c.role === 'reviewer')!
    expect(rev).toMatchObject({ kind: 'findings', access: 'read-only', model: 'zai/glm-5' })
    expect(rev.prompt).toContain('git diff start1...HEAD')
  })

  it('runs the review command through a granny agent on hosts without a shell', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: ['No issues.'] })
    await runGranny(f.host, input())
    const runner = f.calls.find(c => c.kind === 'command')!
    expect(runner.role).toBe('granny')
    expect(runner.prompt).toContain(
      'cd /work/repo && mkdir -p .granny && rm -f .granny/review-core-r1.md .granny/review-core-r1.log && codex exec review --base start1',
    )
  })

  it('shell-quotes the repo, the work dir and the base in every generated command', async () => {
    const repo = "/work/my repo's"
    const config = { workDir: ".granny dir's" }
    const r = `'/work/my repo'\\''s'`
    const wd = (file = '') => `'.granny dir'\\''s${file}'`

    const direct = fakeHost({ reviews: ['No issues.'] })
    await runGranny(direct.host, input({ repo, config, base: 'feat;main' }))
    expect(direct.calls[0]!.prompt).toContain(`Prefix EVERY shell command with \`cd ${r} &&\``)
    expect(direct.calls.find(c => c.kind === 'final')!.prompt).toContain(`git log 'feat;main'..HEAD`)
    expect(direct.commands[0]).toBe(
      `mkdir -p ${wd()} && rm -f ${wd('/review-core-r1.md')} ${wd('/review-core-r1.log')} && codex exec review --base start1 -o ${wd('/review-core-r1.md')} > ${wd('/review-core-r1.log')} 2>&1; code=$?; if [ -s ${wd('/review-core-r1.md')} ]; then cat ${wd('/review-core-r1.md')}; else cat ${wd('/review-core-r1.log')}; fi; exit $code`,
    )

    const runner = fakeHost({ name: 'claude-code', direct: false, reviews: ['No issues.'] })
    await runGranny(runner.host, input({ repo, config }))
    expect(runner.calls.find(c => c.kind === 'command')!.prompt).toContain(`\n${`cd ${r} && mkdir -p ${wd()} && rm -f`}`)

    const agent = fakeHost({ override: req => (req.kind === 'findings' ? { findings: [] } : undefined) })
    await runGranny(agent.host, input({ repo, config: { ...config, roles: { reviewer: { engine: 'agent' } } }, stages: [{ name: 'audit', implement: false }], base: "it's" }))
    expect(agent.calls.find(c => c.role === 'reviewer')!.prompt).toContain(`\`cd ${r} && git diff 'it'\\''s'...HEAD\``)
  })

  it('resolves role models per host and applies effort', async () => {
    const config = {
      roles: {
        implementer: { model: { 'claude-code': 'opus', opencode: 'anthropic/claude-opus-5-5' }, effort: 'high' },
        granny: { model: 'haiku' },
      },
    }
    const cc = fakeHost({ name: 'claude-code', direct: false })
    await runGranny(cc.host, input({ config }))
    expect(cc.calls.find(c => c.role === 'implementer')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(cc.calls.find(c => c.kind === 'final')).toMatchObject({ role: 'granny', model: 'haiku', access: 'write' })

    const oc = fakeHost({ reviews: [review(finding('P1', 'x')), 'No issues.'], scores: [{ F1: 99 }] })
    await runGranny(oc.host, input({ config }))
    expect(oc.calls.find(c => c.role === 'implementer')!.model).toBe('anthropic/claude-opus-5-5')
    expect(oc.calls.find(c => c.role === 'judge')!.model).toBeUndefined()
    expect(cc.calls.find(c => c.role === 'judge')).toBeUndefined()
  })

  it('defaults the judge to sonnet on claude-code', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: [review(finding('P1', 'x')), 'No issues.'], scores: [{ F1: 99 }] })
    await runGranny(f.host, input())
    expect(f.calls.find(c => c.role === 'judge')).toMatchObject({ model: 'sonnet', access: 'read-only' })
  })

  it('applies config layers in order and bakes rules into prompts', async () => {
    const f = fakeHost()
    await runGranny(
      f.host,
      input({
        config: [{ gates: ['make test'], aiAttribution: true }, { rules: ['Use tabs.'], language: 'Turkish' }],
        context: 'Read plans/x.md first.',
      }),
    )
    const p = f.calls.find(c => c.kind === 'implementation')!.prompt
    expect(p).toContain('`make test`')
    expect(p).toContain('Use tabs.')
    expect(p).toContain('in Turkish.')
    expect(p).toContain('Read plans/x.md first.')
    expect(p).not.toContain('NO Co-Authored-By')
    expect(f.calls.find(c => c.kind === 'final')!.prompt).not.toContain('co-authored-by')
  })

  it('forbids AI attribution by default', async () => {
    const f = fakeHost()
    await runGranny(f.host, input())
    expect(f.calls[0]!.prompt).toContain('NO Co-Authored-By')
    expect(f.calls.find(c => c.kind === 'final')!.prompt).toContain('co-authored-by')
  })

  it('throws when the implementer returns nothing', async () => {
    const f = fakeHost({ override: req => (req.kind === 'implementation' ? null : undefined) })
    await expect(runGranny(f.host, input())).rejects.toThrow('implementer returned nothing')
  })

  it('rejects invalid input and config before spawning anything', async () => {
    const f = fakeHost()
    await expect(runGranny(f.host, { repo: 'rel', branch: '', stages: [] } as RunInput)).rejects.toThrow(/repo must be an absolute path[\s\S]*branch is required[\s\S]*stages must be/)
    await expect(runGranny(f.host, input({ config: { treshold: 1 } }))).rejects.toThrow('unknown key "treshold"')
    expect(f.calls).toHaveLength(0)
  })
})

const FAKE_CODEX = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    *) shift ;;
  esac
done
echo 'codex progress' >&2
printf '%s\\n' "- [P1] Reviewed $base — a.ts:1" '  detail' > "$out"
`

describe('the review script in a real shell', () => {
  let repo: string
  let bin: string
  const workDir = "review dir's $& $HOME"
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "granny repo's "))
    bin = mkdtempSync(join(tmpdir(), 'granny-bin-'))
    writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const shell = () => ({ env: { PATH: `${bin}:${process.env.PATH}` } })

  it('runs the default codex command in a repo and work dir with spaces and a quote', async () => {
    const f = fakeHost({ shell: shell(), scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Reviewed start1'])
    expect(readFileSync(join(repo, workDir, 'review-core-r1.md'), 'utf8')).toContain('Reviewed start1')
    expect(readFileSync(join(repo, workDir, 'review-core-r1.log'), 'utf8')).toBe('codex progress\n')
  })

  it('runs the cd-prefixed command a granny agent is given from outside the repo', async () => {
    const f = fakeHost({ name: 'claude-code', direct: false, shell: shell(), scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir } }))
    expect(f.commands[0]!.startsWith('cd ')).toBe(true)
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Reviewed start1'])
    expect(existsSync(join(repo, workDir, 'review-core-r1.md'))).toBe(true)
  })

  it('substitutes a quoted {out} into a custom command', async () => {
    const command = `{ test -n {base} && printf '%s\\n' '- [P2] Custom — b.ts:2' '  d' > {out}; }`
    const f = fakeHost({ shell: {}, scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, workDir, roles: { reviewer: { command } } } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Custom'])
    expect(readFileSync(join(repo, workDir, 'review-core-r1.md'), 'utf8')).toContain('Custom')
  })

  it('reads what a custom reviewer printed, not a review file an earlier run left behind', async () => {
    mkdirSync(join(repo, '.granny'))
    writeFileSync(join(repo, '.granny/review-core-r1.md'), review(finding('P2', 'Stale from an earlier run')))
    writeFileSync(join(repo, '.granny/review-core-r1.log'), 'stale log\n')
    const command = `test -n {base} && printf '%s\\n' '- [P1] Fresh — a.ts:1' '  printed to stdout'`
    const f = fakeHost({ shell: {}, scores: [{ F1: 90 }] })
    const r = await runGranny(f.host, input({ repo, config: { maxRounds: 1, roles: { reviewer: { command } } } }))
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Fresh'])
    expect(existsSync(join(repo, '.granny/review-core-r1.md'))).toBe(false)
    expect(readFileSync(join(repo, '.granny/review-core-r1.log'), 'utf8')).not.toContain('stale log')
  })
})
