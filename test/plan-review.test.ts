import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, type ReviewerConfig } from '../src/core/config'
import { checkInput, runGranny, type RunInput } from '../src/core/engine'
import { agentPlanReviewPrompt, planReviewPrompt, type PromptContext } from '../src/core/prompts'
import { parseCodexReview, reviewFailure } from '../src/core/review'
import { planReviewScript, reviewStem } from '../src/core/reviewer'
import type { CommandResult, HostName } from '../src/core/types'
import { fakeHost, finding, review } from './fake-host'

const PLAN = '/plans/v1.md'

const input = (extra: Partial<RunInput> = {}): RunInput => ({
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
      reviews: [review(finding('P2', 'Off by one')), 'No issues.'],
      scores: [{ 'glm-F1': 90 }],
    })
    await runGranny(
      f.host,
      input({
        plan: [PLAN, "/plans/it's wo-2.md"],
        context: 'Read docs/notes.md.',
        config: { planReview: false, reviewers: [{ name: 'glm', engine: 'command', command: 'glm-review {prompt}' }] },
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
      const s = planReviewScript(rv(entry, host), config, host, stem, prompt)!
      expect(s.backend).toBe('codex CLI (codex exec, read-only)')
      expect(s.script).toContain(
        `codex exec --sandbox read-only -o .granny/review-plan-review-r1-codex.md ${quoted} </dev/null > .granny/review-plan-review-r1-codex.log 2>&1`,
      )
      expect(s.script).not.toContain('codex exec review')
      expect(s.script).not.toContain('companion')
    })
  }

  it('passes the reviewer model to codex exec', () => {
    const s = planReviewScript(rv({ engine: 'codex', model: 'gpt-5.5' }), config, 'opencode', stem, prompt)!
    expect(s.script).toContain(`codex exec --sandbox read-only -m gpt-5.5 -o .granny/review-plan-review-r1-codex.md ${quoted}`)
  })

  for (const [label, entry, host] of [
    ['codex-plugin', { engine: 'codex-plugin', model: 'gpt-5.5' }, 'claude-code'],
    ['codex-plugin', { engine: 'codex-plugin', model: 'gpt-5.5' }, 'opencode'],
    ['auto', { engine: 'auto', model: 'gpt-5.5' }, 'claude-code'],
    ['auto in adversarial-review mode', { engine: 'auto', mode: 'adversarial-review', model: 'gpt-5.5' }, 'claude-code'],
  ] as const) {
    it(`runs the companion's read-only, foreground task command for ${label} on ${host}`, () => {
      const s = planReviewScript(rv(entry, host), config, host, stem, prompt)!
      expect(s.backend).toBeUndefined()
      expect(s.script).toContain(`node "$companion" task -m gpt-5.5 ${quoted} </dev/null > .granny/review-plan-review-r1-codex.md 2> .granny/review-plan-review-r1-codex.log`)
      expect(s.script).not.toContain('--write')
      expect(s.script).not.toContain('--background')
      expect(s.script).not.toContain('adversarial-review')
      expect(s.script).toContain('export CLAUDE_PLUGIN_DATA="$PWD"/.granny/codex-plugin-codex')
    })
  }

  it('fills {prompt} of a command reviewer with the plan-review prompt', () => {
    const s = planReviewScript(rv({ engine: 'command', command: 'llm -m {model} {prompt}', model: 'm' }), config, 'opencode', stem, prompt)!
    expect(s).toEqual({
      script: `mkdir -p .granny && rm -f .granny/review-plan-review-r1-codex.md .granny/review-plan-review-r1-codex.log && llm -m m ${quoted} > .granny/review-plan-review-r1-codex.log 2>&1; code=$?; if [ -s .granny/review-plan-review-r1-codex.md ]; then cat .granny/review-plan-review-r1-codex.md; else cat .granny/review-plan-review-r1-codex.log; fi; exit $code`,
      backend: 'custom command',
    })
  })

  it('has no command for a command reviewer without {prompt}', () => {
    expect(planReviewScript(rv({ engine: 'command', command: 'my-review --base {base} --out {out}' }), config, 'opencode', stem, prompt)).toBeUndefined()
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
    const s = planReviewScript(rv({ engine: 'codex' }), config, 'opencode', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r).toEqual({ code: 0, output: '- [P1] Plan reviewed by codex exec — /plans/v1.md:3\n  detail\n' })
    expect(readFileSync(join(home, 'codex-argv'), 'utf8')).toBe(`exec\n--sandbox\nread-only\n-o\n${stem}.md\n${prompt}\n`)
    expect(readFileSync(join(home, 'codex-stdin'), 'utf8')).toBe('')
  }, 5000)

  it('runs the companion task with the prompt on Claude Code with engine auto, and says so', async () => {
    const companion = installCompanion()
    const s = planReviewScript(rv({ engine: 'auto' }, 'claude-code'), config, 'claude-code', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).toBe(0)
    expect(r.output).toContain(`[granny] reviewer: codex-plugin task (${companion})`)
    expect(r.output).toContain('- [P2] Plan reviewed by the companion — /plans/v1.md:7')
    expect(companionCalls()).toEqual([{ argv: ['task', prompt], cwd: realpathSync(repo) }])
    expect(existsSync(join(home, 'codex-argv'))).toBe(false)
  }, 5000)

  it('falls back to codex exec on Claude Code with engine auto when no companion is installed', async () => {
    const s = planReviewScript(rv({ engine: 'auto' }, 'claude-code'), config, 'claude-code', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).toBe(0)
    expect(r.output).toContain('[granny] reviewer: codex CLI (codex exec, read-only) - no Codex plugin companion at')
    expect(r.output).toContain('Plan reviewed by codex exec')
  }, 5000)

  it('fails with engine codex-plugin when no companion is installed, without running codex exec', async () => {
    const s = planReviewScript(rv({ engine: 'codex-plugin' }, 'claude-code'), config, 'claude-code', stem, prompt)!
    const r = await sh(s.script, repo, env())
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("codex-plugin task unavailable - no Codex plugin companion at")
    expect(existsSync(join(home, 'codex-argv'))).toBe(false)
  }, 5000)

  it("reads the companion's empty task render as a failed review", async () => {
    installCompanion()
    const s = planReviewScript(rv({ engine: 'codex-plugin' }, 'claude-code'), config, 'claude-code', stem, prompt)!
    const r = await sh(s.script, repo, env({ GRANNY_TASK_OUTPUT: 'Codex did not return a final message.\n' }))
    expect(r.code).toBe(0)
    expect(reviewFailure(r.output)).toBe('Codex did not return a final message.')
  }, 5000)
})
