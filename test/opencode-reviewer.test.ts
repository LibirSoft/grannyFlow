import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/core/config'
import { runGranny, type RunInput } from '../src/core/engine'
import { OPENCODE_AGENT, OPENCODE_DECODE, opencodeAgentConfig, opencodeAnswer, readableDirs } from '../src/core/opencode'
import { parseCodexReview, saysNoFindings } from '../src/core/review'
import { planReviewScript, reportedBackend, reviewPlan } from '../src/core/reviewer'
import { shellQuote } from '../src/core/shell'
import type { CommandResult, HostName } from '../src/core/types'
import { fakeHost, finding, review } from './fake-host'

const event = (type: string, part: Record<string, unknown> = {}) => JSON.stringify({ type, timestamp: 1, sessionID: 'ses_1', part })
const text = (t: string) => event('text', { type: 'text', text: t })
const DIFF_WITH_FINDING = 'diff --git a/test/review.test.ts b/test/review.test.ts\n+  const out = `- [P1] Planted bug — src/a.ts:3-3`\n'
const toolUse = (output: string) => event('tool_use', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git diff main...HEAD' }, output } })

describe('opencodeAnswer', () => {
  it('reads only the text parts, so a finding inside a tool output never counts', () => {
    const stream = [event('step_start', { type: 'step-start' }), toolUse(DIFF_WITH_FINDING), event('step_finish', { type: 'step-finish' }), text('No findings.')].join('\n')
    expect(stream).toContain('- [P1] Planted bug')
    const answer = opencodeAnswer(stream)
    expect(answer).toEqual({ text: 'No findings.' })
    expect(parseCodexReview(answer.text!)).toEqual({ findings: [], markers: 0 })
  })

  it('joins the text parts of the last stretch in order, one per line, so a finding that starts a part starts a line', () => {
    const stream = [text('I read the diff.'), toolUse('x'), text('- [P2] Off by one — src/a.ts:3-3\n  It skips the last item.\n'), text('- [P3] Typo — src/b.ts:1')].join('\n')
    const answer = opencodeAnswer(stream).text!
    expect(answer).toBe('- [P2] Off by one — src/a.ts:3-3\n  It skips the last item.\n\n- [P3] Typo — src/b.ts:1')
    expect(parseCodexReview(answer).findings.map(f => [f.severity, f.title, f.file, f.line])).toEqual([
      ['P2', 'Off by one', 'src/a.ts', 3],
      ['P3', 'Typo', 'src/b.ts', 1],
    ])
  })

  it('drops the narration of earlier steps, so a clean review is the no-findings sentence alone', () => {
    const step = (...events: string[]) => [event('step_start', { type: 'step-start' }), ...events, event('step_finish', { type: 'step-finish' })]
    const stream = [
      ...step(text('Let me look at the diff.'), toolUse(DIFF_WITH_FINDING)),
      ...step(text('- [P1] Now checking the parser — src/a.ts:1'), toolUse('x')),
      ...step(text('No findings.')),
    ].join('\n')
    const answer = opencodeAnswer(stream)
    expect(answer).toEqual({ text: 'No findings.' })
    expect(saysNoFindings(answer.text!)).toBe(true)
  })

  it('keeps the last text when the final step has none, and a blank part never starts a new stretch', () => {
    expect(opencodeAnswer([event('step_start'), text('No findings.'), event('step_finish'), event('step_start'), event('step_finish')].join('\n'))).toEqual({ text: 'No findings.' })
    expect(opencodeAnswer([text('No findings.'), event('step_start'), text('  ')].join('\n'))).toEqual({ text: 'No findings.' })
  })

  it('falls back to every text part when the last stretch has no finding and is not the no-findings sentence', () => {
    const stream = [text('- [P1] Off by one — src/a.ts:3'), toolUse('x'), text('That is all.')].join('\n')
    const answer = opencodeAnswer(stream).text!
    expect(answer).toBe('- [P1] Off by one — src/a.ts:3\nThat is all.')
    expect(parseCodexReview(answer).findings.map(f => [f.severity, f.file, f.line])).toEqual([['P1', 'src/a.ts', 3]])
    expect(opencodeAnswer([text('Let me look.'), toolUse('x'), text('- [P2] Typo — b.ts:1')].join('\n'))).toEqual({ text: '- [P2] Typo — b.ts:1' })
  })

  it('skips lines that are not JSON events, the backend line and CRLF included', () => {
    const stream = `[granny] reviewer: opencode zai/glm-5.3 (read-only agent)\r\nsome stray stderr\r\n${text('No findings.')}\r\n[1, 2]\r\n"x"\r\n`
    expect(opencodeAnswer(stream)).toEqual({ text: 'No findings.' })
  })

  it('counts an event line that is not valid JSON, so a text part a copy broke is never dropped without a trace', () => {
    const broken = text('- [P1] Leak — src/a.ts:3').replace('Leak', 'Le"ak')
    expect(opencodeAnswer([text('No findings.'), broken, '[granny] reviewer: x', '{"type":"tool_use"}'].join('\n'))).toEqual({ text: 'No findings.', dropped: 1 })
  })

  it('reads an error event and a plain Error: line as the error', () => {
    const errorEvent = JSON.stringify({ type: 'error', timestamp: 1, sessionID: 's', error: { type: 'provider.no-route', message: 'Variant unavailable for kimi/k3: nope' } })
    expect(opencodeAnswer(errorEvent)).toEqual({ error: 'provider.no-route: Variant unavailable for kimi/k3: nope' })
    expect(opencodeAnswer('Error: Variant unavailable for kimi/k3: nope\n')).toEqual({ error: 'Error: Variant unavailable for kimi/k3: nope' })
    const named = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'quota exceeded' } } })
    expect(opencodeAnswer(named)).toEqual({ error: 'APIError: quota exceeded' })
    expect(opencodeAnswer(JSON.stringify({ type: 'error', error: 'boom' }))).toEqual({ error: 'boom' })
    expect(opencodeAnswer([errorEvent, errorEvent, text('partial')].join('\n'))).toEqual({ text: 'partial', error: 'provider.no-route: Variant unavailable for kimi/k3: nope' })
  })

  it('reads the decoded form the review script prints: text parts as plain lines, step and error frames', () => {
    const out = [
      '[granny] reviewer: opencode zai/glm-5.3 (read-only agent)',
      '[granny] opencode: step',
      '[granny] opencode: text 1',
      'Let me look.',
      '[granny] opencode: step',
      '[granny] opencode: text 2',
      '- [P2] Off by one — src/a.ts:3-3',
      '  It says "page" and \\n literally.',
      '',
      '[granny] opencode: text 1',
      '- [P3] Typo — src/b.ts:1',
    ].join('\n')
    expect(opencodeAnswer(out)).toEqual({ text: '- [P2] Off by one — src/a.ts:3-3\n  It says "page" and \\n literally.\n\n- [P3] Typo — src/b.ts:1' })
    expect(parseCodexReview(opencodeAnswer(out).text!).findings.map(f => [f.severity, f.file, f.line])).toEqual([
      ['P2', 'src/a.ts', 3],
      ['P3', 'src/b.ts', 1],
    ])
    const error = JSON.stringify({ type: 'error', error: { type: 'provider.quota', message: 'quota' } })
    expect(opencodeAnswer(`[granny] opencode: error ${error}\n[granny] opencode: error not json\nError: boom\n`)).toEqual({ error: 'provider.quota: quota; not json; Error: boom' })
  })

  it('ends a text part after its non-blank lines, so a later stderr line is not part of the answer', () => {
    expect(opencodeAnswer('[granny] opencode: text 1\nNo findings.\n\nError: Variant unavailable for kimi/k3: nope\n')).toEqual({ text: 'No findings.', error: 'Error: Variant unavailable for kimi/k3: nope' })
  })

  it('takes a frame-shaped line inside a text part as the part\'s text while the part is short of its lines', () => {
    const detail = ['- [P2] Frames in text — src/core/opencode.ts:81', '  [granny] opencode: error {"type":"x"}', '  [granny] opencode: step', '[granny] opencode: text 2', 'end of detail']
    expect(opencodeAnswer(`[granny] opencode: step\n[granny] opencode: text 5\n${detail.join('\n')}\n`)).toEqual({ text: detail.join('\n') })
  })

  it('counts a part\'s lines as the decoder does, so a line of only a no-break space or form feed does not pull a later frame into the text', () => {
    expect(opencodeAnswer('[granny] opencode: text 3\npartial\n\u00a0\nmore\n[granny] opencode: error {"type":"error","error":{"type":"x","message":"boom"}}\n')).toEqual({ text: 'partial\n\u00a0\nmore', error: 'x: boom' })
    expect(opencodeAnswer('[granny] opencode: text 3\nLooking.\n\f\nchecking\n[granny] opencode: step\n[granny] opencode: text 1\n- [P1] Real — a.ts:1\n')).toEqual({ text: '- [P1] Real — a.ts:1' })
  })

  it('counts a text part that came back short, or one the script could not decode, as dropped', () => {
    expect(opencodeAnswer('[granny] opencode: text 1\nNo findings.\n[granny] opencode: text 3\n- [P1] Leak — src/a.ts:3\n')).toEqual({ text: 'No findings.\n- [P1] Leak — src/a.ts:3', dropped: 1 })
    expect(opencodeAnswer('[granny] opencode: dropped\n[granny] opencode: text 1\nNo findings.\n')).toEqual({ text: 'No findings.', dropped: 1 })
  })

  it('has no text for a stream without a text part, or with blank ones only', () => {
    expect(opencodeAnswer('')).toEqual({})
    expect(opencodeAnswer([event('step_start'), toolUse(DIFF_WITH_FINDING), text('  \n')].join('\n'))).toEqual({})
    expect(opencodeAnswer(event('text', { type: 'reasoning', text: '- [P1] thinking — a.ts:1' }))).toEqual({})
  })
})

describe('readableDirs', () => {
  it('takes the directory of every absolute path in the text and of every file, once, outside the worktree only', () => {
    const context = 'Plan files - read them first: /repo/.granny/plans/a.md, /repo/.granny/plans/b.md\nSee "/srv/notes/wo-1.md" and (/srv/specs/api/) and https://x.dev/doc and plans/rel.md and /wt/src/a.ts.'
    expect(readableDirs(context, ['/srv/other/plan.md'], '/wt')).toEqual(['/repo/.granny/plans', '/srv/notes', '/srv/specs/api', '/srv/other'])
  })

  it('normalizes . and .. and never opens the root or the worktree', () => {
    expect(readableDirs('/a/./b/../c/x.md /top.md /wt2/x/y.md', [], '/wt/')).toEqual(['/a/c', '/wt2/x'])
    expect(readableDirs('/wt/x.md /wt/sub/y.md', [], '/wt')).toEqual([])
    expect(readableDirs('', [], '/wt')).toEqual([])
  })

  it('never opens a top-level directory, a home directory or a dot directory right under one', () => {
    expect(readableDirs('Main checkout /home/u/proj, notes in /home/u/todo.md, see /etc/hosts', [], '/home/u/wt/feat')).toEqual([])
    expect(readableDirs('/Users/u/notes.md /root/plan.md /var/home/u/x.md /home/u/.ssh/id_ed25519 /home/u/.claude/CLAUDE.md /tmp/plan.md', ['/home/u/.aws/config'], '/wt')).toEqual([])
    expect(readableDirs('/home/u/proj/.granny/plans/a.md /home/u/.claude/plans/b.md /tmp/run/plan.md', [], '/wt')).toEqual(['/home/u/proj/.granny/plans', '/home/u/.claude/plans', '/tmp/run'])
  })

  it('never grants the parent of a path in the text that names no file, so a directory named without a trailing slash opens neither itself nor its project', () => {
    expect(readableDirs('Specs in /home/u/proj/docs and /srv/notes/README', [], '/home/u/wt/feat')).toEqual([])
    expect(readableDirs('Specs in /home/u/proj/docs/ and /home/u/proj/docs/api.md', [], '/home/u/wt/feat')).toEqual(['/home/u/proj/docs'])
    expect(readableDirs('', ['/srv/plans/PLAN'], '/wt')).toEqual(['/srv/plans'])
  })

  it('never grants the worktree or a directory above it', () => {
    const wt = '/home/u/Desktop/ws/proj-worktrees/feat'
    expect(readableDirs(`Working repo: ${wt}`, [], wt)).toEqual([])
    expect(readableDirs('Main checkout: /home/u/Desktop/ws/proj', [], wt)).toEqual([])
    expect(readableDirs('see /home/u/Desktop/notes.md', [], wt)).toEqual([])
    expect(readableDirs('/home/u/Desktop/ws/proj/.granny/plans/a.md', [`${wt}-old/plan.md`], `${wt}/`)).toEqual(['/home/u/Desktop/ws/proj/.granny/plans', `${wt}-old`])
  })
})

describe('opencodeAgentConfig', () => {
  it('defines one primary agent that may only read and run read-only git, with --output, redirects and outside paths denied after the allows', () => {
    const config = JSON.parse(opencodeAgentConfig([]))
    expect(Object.keys(config.agent)).toEqual([OPENCODE_AGENT])
    const agent = config.agent[OPENCODE_AGENT]
    expect(agent.mode).toBe('primary')
    expect(agent.permission).toEqual({
      '*': 'deny',
      read: 'allow',
      grep: 'allow',
      glob: 'allow',
      list: 'allow',
      bash: {
        '*': 'deny',
        'git diff*': 'allow',
        'git log*': 'allow',
        'git show*': 'allow',
        'git status*': 'allow',
        'git blame*': 'allow',
        'git rev-parse*': 'allow',
        'git merge-base*': 'allow',
        'git ls-files*': 'allow',
        'git * --output*': 'deny',
        '*>*': 'deny',
        '*<*': 'deny',
        '*--no-index*': 'deny',
        '* /*': 'deny',
        "*'/*": 'deny',
        '*"/*': 'deny',
        '*=/*': 'deny',
        '* ~*': 'deny',
        "*'~*": 'deny',
        '*"~*': 'deny',
        '*=~*': 'deny',
        '*../*': 'deny',
        '* ..': 'deny',
        '* .. *': 'deny',
        "*'..*": 'deny',
        '*"..*': 'deny',
        '*$*': 'deny',
        '*`*': 'deny',
        '*{*': 'deny',
        '*.?/*': 'deny',
        '*.[*': 'deny',
        '* -?/*': 'deny',
        '*\t*': 'deny',
      },
    })
    const rules = Object.entries(agent.permission.bash as Record<string, string>)
    expect(rules.map(([, effect]) => effect).lastIndexOf('allow')).toBe(8)
    expect(Object.keys(agent.permission)[0]).toBe('*')
  })

  const OPENCODE_WILDCARD = (command: string, pattern: string) => {
    let re = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    if (re.endsWith(' .*')) re = `${re.slice(0, -3)}( .*)?`
    return new RegExp(`^${re}$`, 's').test(command.replaceAll('\\', '/'))
  }
  const bashDecision = (command: string) => {
    const rules = Object.entries(JSON.parse(opencodeAgentConfig([])).agent[OPENCODE_AGENT].permission.bash as Record<string, string>)
    return rules.reverse().find(([pattern]) => OPENCODE_WILDCARD(command, pattern))?.[1]
  }

  it('lets the reviewer run read-only git on the worktree', () => {
    for (const command of ['git diff main...HEAD', 'git diff main...HEAD -- src/a.ts', 'git log --oneline main..HEAD', 'git show HEAD:src/a.ts', 'git status --short', 'git blame -L 1,9 src/a.ts', 'git ls-files src', 'git rev-parse HEAD', 'git merge-base main HEAD'])
      expect([command, bashDecision(command)]).toEqual([command, 'allow'])
  })

  it('denies a redirect, so an allowed git command never writes a file', () => {
    for (const command of ['git log > leak.txt', 'git diff main...HEAD >> src/a.ts', 'git log>x', 'git show HEAD 2>err.txt', 'git diff --no-index /dev/stdin x < y', 'git diff HEAD --output=leak.txt', 'git diff HEAD\t--output=leak.txt'])
      expect([command, bashDecision(command)]).toEqual([command, 'deny'])
  })

  it('denies a git command that names a path outside the worktree, so git never reads a file the external_directory rules refuse', () => {
    for (const command of [
      'git diff /home/u/.ssh/id_ed25519 /dev/null',
      'git diff --no-index a b',
      'git diff ~/.aws/credentials src/a.ts',
      "git diff '/etc/passwd' src/a.ts",
      'git diff "~/.aws/config" src/a.ts',
      'git diff ../outside/secret.txt src/a.ts',
      'git diff src/../../outside.txt src/a.ts',
      'git diff -- .. src',
      'git blame --contents=/etc/passwd src/a.ts',
      'git diff $HOME/.aws/config src/a.ts',
      'git diff `echo /etc/passwd` src/a.ts',
      'git diff \\/etc/passwd src/a.ts',
      'git diff {/etc/passwd,src/a.ts}',
      'git diff .?/outside.txt src/a.ts',
      'git diff .[.]/outside.txt src/a.ts',
      'git blame -S/home/u/.ssh/id_ed25519 src/a.ts',
      'git diff\t/etc/passwd\t/dev/null',
      'git blame --contents\t/etc/passwd src/a.ts',
    ])
      expect([command, bashDecision(command)]).toEqual([command, 'deny'])
  })

  it('allows reading in the given directories outside the worktree, after the deny-all', () => {
    const agent = JSON.parse(opencodeAgentConfig(['/repo/.granny/plans', "/my dir's"])).agent[OPENCODE_AGENT]
    expect(agent.permission.external_directory).toEqual({ '/repo/.granny/plans/*': 'allow', "/my dir's/*": 'allow' })
    expect(Object.keys(agent.permission).indexOf('external_directory')).toBeGreaterThan(Object.keys(agent.permission).indexOf('*'))
    expect(agent.permission.edit).toBeUndefined()
  })
})

describe('the opencode review script', () => {
  const config = resolveConfig([])
  const stem = '.granny/review-core-r1-kimi'
  const rv = (entry: Record<string, unknown>, host: HostName = 'claude-code') =>
    resolveConfig([{ reviewers: [{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', ...entry }] }], host).reviewers[0]!
  const PROMPT = "Review `git diff abc...HEAD`; it's $HOME"

  for (const host of ['claude-code', 'opencode', 'omp'] as const) {
    it(`runs opencode run standalone with the generated agent, the prompt and the model on ${host}`, () => {
      const s = reviewPlan(rv({}, host), config, host, 'abc', stem, PROMPT, ['/repo/.granny/plans'])
      const agent = shellQuote(opencodeAgentConfig(['/repo/.granny/plans']))
      expect(s.script).toBe(
        `mkdir -p .granny && rm -f ${stem}.md ${stem}.log && { echo '[granny] reviewer: opencode kimi-code-plan-global/k3.1-pro (read-only agent)'; OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT=${agent} opencode run --standalone --archived --format json --agent granny-reviewer -m kimi-code-plan-global/k3.1-pro 'Review \`git diff abc...HEAD\`; it'\\''s $HOME' </dev/null; } > ${stem}.log 2>&1; code=$?; LC_ALL=C awk ${shellQuote(OPENCODE_DECODE)} ${stem}.log; exit $code`,
      )
      expect(s.backend).toBeUndefined()
    })
  }

  it('turns the effort into the model variant and keeps a #variant given in the model', () => {
    expect(reviewPlan(rv({ effort: 'max' }), config, 'opencode', 'abc', stem, 'p').script).toContain(`-m 'kimi-code-plan-global/k3.1-pro#max' p </dev/null`)
    expect(reviewPlan(rv({ effort: 'max' }), config, 'opencode', 'abc', stem, 'p').script).toContain(`'[granny] reviewer: opencode kimi-code-plan-global/k3.1-pro#max (read-only agent)'`)
    expect(reviewPlan(rv({ model: 'zai/glm-5.3#high' }), config, 'opencode', 'abc', stem, 'p').script).toContain(`-m 'zai/glm-5.3#high' p </dev/null`)
  })

  it('takes the host entry of a host-keyed model', () => {
    const keyed = rv({ model: { 'claude-code': 'zai/glm-5.3', opencode: 'kimi/k3', omp: 'kimi/k3' } })
    expect(reviewPlan(keyed, config, 'claude-code', 'abc', stem, 'p').script).toContain('-m zai/glm-5.3 p')
    expect(reviewPlan(keyed, config, 'omp', 'abc', stem, 'p').script).toContain('-m kimi/k3 p')
  })

  it('runs the plan review the same way, with the plan review prompt', () => {
    const s = planReviewScript(rv({}), config, 'claude-code', 'main', '.granny/review-plan-review-r1-kimi', 'Review the plan /plans/v1.md', ['/plans'])!
    expect(s).toBeDefined()
    expect(s.body).toContain(`OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeAgentConfig(['/plans']))} opencode run --standalone --archived --format json --agent granny-reviewer -m kimi-code-plan-global/k3.1-pro 'Review the plan /plans/v1.md' </dev/null; } > .granny/review-plan-review-r1-kimi.log 2>&1`)
    expect(s.body).not.toContain('codex')
  })

  it('passes bash the exact agent JSON and prompt, and prints the backend line before the stream', () => {
    const dir = mkdtempSync(join(tmpdir(), 'granny-opencode-'))
    const bin = join(dir, 'bin')
    spawnSync('mkdir', ['-p', bin])
    writeFileSync(
      join(bin, 'opencode'),
      `#!/usr/bin/env bash\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > "${dir}/config.json"\nprintf '%s' "$OPENCODE_DISABLE_PROJECT_CONFIG" > "${dir}/no-project"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\n${['echo', `'${text('No findings.')}'`].join(' ')}\n`,
    )
    chmodSync(join(bin, 'opencode'), 0o755)
    const s = reviewPlan(rv({ effort: 'high' }), config, 'opencode', 'abc', stem, PROMPT, ["/my dir's/plans"])
    const r = spawnSync('bash', ['-c', s.script], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(r.status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(JSON.parse(opencodeAgentConfig(["/my dir's/plans"])))
    expect(readFileSync(join(dir, 'no-project'), 'utf8')).toBe('1')
    expect(readFileSync(join(dir, 'args'), 'utf8').split('\n').slice(0, -1)).toEqual([
      'run',
      '--standalone',
      '--archived',
      '--format',
      'json',
      '--agent',
      'granny-reviewer',
      '-m',
      'kimi-code-plan-global/k3.1-pro#high',
      PROMPT,
    ])
    expect(r.stdout.split('\n')[0]).toBe('[granny] reviewer: opencode kimi-code-plan-global/k3.1-pro#high (read-only agent)')
    expect(reportedBackend(r.stdout)).toBe('opencode kimi-code-plan-global/k3.1-pro#high (read-only agent)')
    expect(opencodeAnswer(r.stdout)).toEqual({ text: 'No findings.' })
  })

  const printed = (events: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'granny-opencode-'))
    spawnSync('mkdir', ['-p', join(dir, 'bin')])
    writeFileSync(join(dir, 'events.jsonl'), `${events.join('\n')}\n`)
    writeFileSync(join(dir, 'bin/opencode'), `#!/usr/bin/env bash\ncat "${dir}/events.jsonl"\n`)
    chmodSync(join(dir, 'bin/opencode'), 0o755)
    const s = reviewPlan(rv({}), config, 'opencode', 'abc', stem, 'p')
    const r = spawnSync('bash', ['-c', s.script], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
    return { ...r, log: readFileSync(join(dir, `${stem}.log`), 'utf8') }
  }

  it('prints the answer decoded, every tool output cut away, so a large one never reaches the reader, and keeps the full stream in the log', () => {
    const big = `${DIFF_WITH_FINDING}${'+ a line of a large diff with "quotes" and \\ backslashes\n'.repeat(20000)}`
    const reasoning = event('reasoning', { type: 'reasoning', text: 'x'.repeat(50000) })
    const error = JSON.stringify({ type: 'error', error: { type: 'provider.quota', message: 'quota' } })
    const events = [event('step_start', { type: 'step-start' }), text('Let me look.'), toolUse(big), event('step_finish', { type: 'step-finish', tokens: { input: 1 } }), event('step_start'), reasoning, text('- [P2] Off by one — src/a.ts:3'), error, event('step_finish')]
    const r = printed(events)
    expect(r.status).toBe(0)
    expect(r.log.length).toBeGreaterThan(1_000_000)
    expect(r.stdout.length).toBeLessThan(2000)
    expect(r.stdout).not.toContain('Planted bug')
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      '[granny] reviewer: opencode kimi-code-plan-global/k3.1-pro (read-only agent)',
      '[granny] opencode: step',
      '[granny] opencode: text 1',
      'Let me look.',
      '[granny] opencode: step',
      '[granny] opencode: step',
      '[granny] opencode: text 1',
      '- [P2] Off by one — src/a.ts:3',
      `[granny] opencode: error ${error}`,
    ])
    expect(opencodeAnswer(r.stdout)).toEqual({ text: '- [P2] Off by one — src/a.ts:3', error: 'provider.quota: quota' })
  })

  it('prints a text part as the plain text it holds, every JSON escape decoded, so a helper relays markdown and not an escaped JSON line', () => {
    const answer = '- [P1] Quote "a" \\ back — src/a.ts:3-3\n  Tab\there, slash /, bell \u0007, é, — and 😀.\n\n- [P3] Typo — src/b.ts:1\n'
    const escaped = JSON.stringify({ type: 'text', part: { id: 'p', type: 'text', text: answer, time: { start: 1 } } })
      .replace('é', '\\u00e9')
      .replace('😀', '\\ud83d\\ude00')
      .replace('slash /', 'slash \\/')
    expect(escaped).toContain('\\u00e9')
    const r = printed([event('step_start'), escaped, text('')])
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('{"type"')
    expect(r.stdout).toContain(`[granny] opencode: text 3\n${answer}\n[granny] opencode: text 0\n\n`)
    expect(opencodeAnswer(r.stdout)).toEqual({ text: answer.trim() })
    expect(parseCodexReview(opencodeAnswer(r.stdout).text!).findings.map(f => [f.severity, f.file, f.line])).toEqual([
      ['P1', 'src/a.ts', 3],
      ['P3', 'src/b.ts', 1],
    ])
  })

  it('prints a frame for a text event it cannot decode, and nothing for a reasoning part or any other event', () => {
    const r = printed(['{"type":"text","part":{"type":"text","text":"cut off', event('text', { type: 'reasoning', text: '- [P1] thinking — a.ts:1' }), event('step_finish'), text('No findings.')])
    expect(r.stdout.split('\n').filter(Boolean).slice(1)).toEqual(['[granny] opencode: dropped', '[granny] opencode: text 1', 'No findings.'])
    expect(opencodeAnswer(r.stdout)).toEqual({ text: 'No findings.', dropped: 1 })
  })

  it('finds the backend line wherever it sits among the JSON events', () => {
    const line = '[granny] reviewer: opencode zai/glm-5.3 (read-only agent)'
    for (const stream of [[line, text('a')], [text('a'), line], [text('a'), line, toolUse('x'), text('b')]]) {
      expect(reportedBackend(stream.join('\n'))).toBe('opencode zai/glm-5.3 (read-only agent)')
      expect(reportedBackend(stream.join('\r\n'))).toBe('opencode zai/glm-5.3 (read-only agent)')
    }
  })

  it("exits with opencode's exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), 'granny-opencode-'))
    spawnSync('mkdir', ['-p', join(dir, 'bin')])
    writeFileSync(join(dir, 'bin/opencode'), '#!/usr/bin/env bash\necho "Error: Variant unavailable for kimi/k3: nope" >&2\nexit 1\n')
    chmodSync(join(dir, 'bin/opencode'), 0o755)
    const s = reviewPlan(rv({}), config, 'opencode', 'abc', stem, 'p')
    const r = spawnSync('bash', ['-c', s.script], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
    expect(r.status).toBe(1)
    expect(opencodeAnswer(r.stdout)).toEqual({ error: 'Error: Variant unavailable for kimi/k3: nope' })
  })
})

describe('an opencode reviewer in a run', () => {
  const KIMI = { name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro', effort: 'max' }
  const BACKEND = '[granny] reviewer: opencode kimi-code-plan-global/k3.1-pro#max (read-only agent)'
  const md = '.granny/review-core-r1-kimi.md'
  const input = (extra: Partial<RunInput> = {}): RunInput => ({
    repo: '/work/repo',
    branch: 'feat/x',
    base: 'main',
    stages: [{ name: 'core', task: 'Do WP-01.' }],
    config: { reviewers: [KIMI] },
    ...extra,
  })
  const stream = (answer?: string, ...more: string[]) =>
    [BACKEND, event('step_start'), toolUse(DIFF_WITH_FINDING), ...(answer === undefined ? [] : [text(answer)]), ...more, event('step_finish')].join('\n') + '\n'
  const isSave = (command: string) => command.includes("<<'GRANNY")
  /** Review streams in order; a save of the answer is recorded and answered on its own, without taking a stream. */
  const opencode = (answers: Array<string | CommandResult>, save: CommandResult = { code: 0, output: '' }) => {
    const queue = [...answers]
    const saves: string[] = []
    const reviews = (command: string) => (isSave(command) ? (saves.push(command), save) : (queue.shift() ?? stream('No findings.')))
    return { saves, reviews }
  }
  const saved = (command: string) => /<<'(\w+)'\n([\s\S]*)\1\n$/.exec(command)?.[2]

  it('reviews from the answer only: a finding inside a tool output is not one, and the answer is saved as the review file', async () => {
    const o = opencode([stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 1 })
    expect(f.calls.some(c => c.kind === 'findings')).toBe(false)
    expect(f.logs).toContain('core r1 kimi: reviewer: opencode kimi-code-plan-global/k3.1-pro#max (read-only agent)')
    expect(o.saves).toHaveLength(1)
    expect(o.saves[0]).toStartWith(`mkdir -p .granny && cat > ${md} <<'GRANNY_REPORT_END'\n`)
    expect(saved(o.saves[0]!)).toBe('No findings.\n')
  })

  it('parses the findings of the answer under the reviewer name', async () => {
    const o = opencode([stream(review(finding('P2', 'Off by one'))), stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews, scores: [{ 'kimi-F1': 90 }] })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => [x.id, x.title, x.file])).toEqual([['kimi-F1', 'Off by one', 'src/a.ts']])
    expect(saved(o.saves[0]!)).toBe(`${review(finding('P2', 'Off by one')).trim()}\n`)
    expect(o.saves[1]).toContain('cat > .granny/review-core-r2-kimi.md')
  })

  it('counts an answer-less stream that exited 0 as a reviewer that did not run, then ends the stage review-failed', async () => {
    const o = opencode([stream(), stream()])
    const f = fakeHost({ reviews: o.reviews })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('kimi: opencode returned no answer')
    expect(f.logs).toContain('core r1 kimi: did not run - retrying once. opencode returned no answer')
    expect(o.saves).toEqual([])
  })

  it("names opencode's error as the note, whether it exited 0 or not", async () => {
    const error = JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: 'Variant unavailable for kimi-code-plan-global/k3.1-pro: max' } })
    const o = opencode([`${BACKEND}\n${error}\n`, { code: 1, output: `${BACKEND}\n${error}\n` }])
    const f = fakeHost({ reviews: o.reviews })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed' })
    expect(f.logs).toContain('core r1 kimi: did not run - retrying once. opencode: provider.no-route: Variant unavailable for kimi-code-plan-global/k3.1-pro: max')
    expect(r.stages[0]!.note).toContain('kimi: review command exited 1: provider.no-route: Variant unavailable for kimi-code-plan-global/k3.1-pro: max')
    expect(r.stages[0]!.note).not.toContain('"type"')
  })

  it('counts an answer followed by an error event on exit 0 as a reviewer that did not run, never as a finished review', async () => {
    const error = JSON.stringify({ type: 'error', error: { type: 'provider.quota', message: 'rate limited' } })
    const o = opencode([stream('- [P2] Half a review — src/a.ts:1', error), stream('- [P2] Half a review — src/a.ts:1', error)])
    const f = fakeHost({ reviews: o.reviews })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'review-failed', rounds: 1 })
    expect(r.stages[0]!.note).toContain('kimi: opencode: provider.quota: rate limited')
    expect(o.saves).toEqual([])
  })

  it('keeps the review when saving the answer fails, and says so', async () => {
    const o = opencode([stream('No findings.')], { code: 1, output: 'disk full' })
    const f = fakeHost({ reviews: o.reviews })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean' })
    expect(f.logs).toContain(`core r1 kimi: could not save the answer to ${md} (exit 1): disk full`)
  })

  it('lets the reviewer read the plan files outside the worktree, and nothing else outside it', async () => {
    const o = opencode([stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews, worktree: '/wt/feat-x' })
    await runGranny(f.host, input({ plan: ['/work/repo/.granny/plans/feat-x.md', '/wt/feat-x/docs/plan-2.md'], context: 'Work orders in /srv/orders/wo-1.md' }))
    const run = f.commands.find(c => c.includes('opencode run'))!
    expect(run).toContain(`OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeAgentConfig(['/srv/orders', '/work/repo/.granny/plans']))} opencode run`)
    expect(f.cwds[f.commands.indexOf(run)]).toBe('/wt/feat-x')
  })

  it('grants the plan directories from the plan list, so a plan path with a space opens its own directory and nothing wider', async () => {
    const o = opencode([stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews, worktree: '/wt/feat-x' })
    await runGranny(f.host, input({ plan: ['/Users/u/Library/Mobile Documents/plans/a.md', '/home/u/My Plans/feat.md'] }))
    const run = f.commands.find(c => c.includes('opencode run'))!
    expect(run).toContain(`OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeAgentConfig(['/Users/u/Library/Mobile Documents/plans', '/home/u/My Plans']))} opencode run`)
  })

  it('says how many text parts did not come back whole', async () => {
    const broken = text('- [P1] Leak — src/a.ts:3').replace('Leak', 'Le"ak')
    const o = opencode([stream('No findings.', broken)])
    const f = fakeHost({ reviews: o.reviews })
    await runGranny(f.host, input())
    expect(f.logs).toContain('core r1 kimi: opencode: 1 text part(s) did not come back whole and may be missing from the answer - check .granny/review-core-r1-kimi.log')
  })

  it('runs the plan review through opencode too, with the plan directory readable', async () => {
    const o = opencode([stream('No findings.'), stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews, worktree: '/wt/feat-x' })
    await runGranny(f.host, input({ plan: '/srv/plans/v1.md', config: { reviewers: [KIMI], planReview: true } }))
    const plan = f.commands.find(c => c.includes('review-plan-review-r1-kimi.log'))!
    expect(plan).toContain(`OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeAgentConfig(['/srv/plans']))} opencode run`)
    expect(o.saves[0]).toContain('cat > .granny/review-plan-review-r1-kimi.md')
  })

  it("records the round in the trail with the reviewer, its engine and model, and the findings of its answer only", async () => {
    const o = opencode([stream(review(finding('P2', 'Off by one'))), stream('No findings.')])
    const f = fakeHost({ reviews: o.reviews, scores: [{ 'kimi-F1': 90 }] })
    const r = await runGranny(f.host, input())
    expect(r.trail).toEqual({ dir: '/work/repo/.granny/trail', written: 2, failed: [] })
    const r1 = JSON.parse(f.trail.get('/work/repo/.granny/trail/s1-r1.json')!)
    expect(r1.reviewers).toEqual([{ name: 'kimi', engine: 'opencode', model: 'kimi-code-plan-global/k3.1-pro#max' }])
    expect(r1.findings.map((x: Record<string, unknown>) => [x.id, x.reviewer, x.title, x.file, x.route])).toEqual([['kimi-F1', 'kimi', 'Off by one', 'src/a.ts', 'sent']])
    expect(JSON.stringify(r1)).not.toContain('Planted bug')
    expect(JSON.parse(f.trail.get('/work/repo/.granny/trail/s1-r2.json')!)).toMatchObject({ findings: [], outcome: 'clean' })
  })

  it('on Claude Code runs it detached through the helper steps, then has a helper save the answer', async () => {
    const o = opencode([stream(review(finding('P1', 'Leak'))), stream('No findings.')])
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: o.reviews, override: req => (req.label.endsWith(' save') ? { ran: true, exitCode: 0, output: '' } : undefined) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Leak'])
    const labels = f.calls.filter(c => c.kind === 'command' && c.label.startsWith('review core r1')).map(c => c.label)
    expect(labels).toEqual(['review core r1 kimi', 'review core r1 kimi wait 1', 'review core r1 kimi read', 'review core r1 kimi save'])
    const save = f.calls.find(c => c.label === 'review core r1 kimi save')!
    expect(save).toMatchObject({ role: 'helper', access: 'write', phase: 'Review' })
    expect(save.prompt).toContain('line breaks and every character kept')
    expect(save.prompt).toContain(`\n( cd /work/repo && mkdir -p .granny && cat > ${md} <<'GRANNY_REPORT_END'\nReview comments:\n\n- [P1] Leak`)
    expect(f.commands[0]).toContain('opencode run --standalone --archived --format json --agent granny-reviewer')
  })

  it('on Claude Code takes the findings from the decoded text the read step relays', async () => {
    const answer = review(finding('P1', 'Leak "quoted"'))
    const relayed = `${BACKEND}\n[granny] opencode: step\n[granny] opencode: text ${answer.split('\n').filter(l => l.trim()).length}\n${answer}\n`
    const o = opencode([relayed, stream('No findings.')])
    const f = fakeHost({ name: 'claude-code', direct: false, reviews: o.reviews, override: req => (req.label.endsWith(' save') ? { ran: true, exitCode: 0, output: '' } : undefined) })
    const r = await runGranny(f.host, input())
    expect(r.stages[0]).toMatchObject({ outcome: 'clean', rounds: 2 })
    expect(r.stages[0]!.history[0]!.findings.map(x => x.title)).toEqual(['Leak "quoted"'])
    expect(f.logs.some(l => l.includes('did not come back whole'))).toBe(false)
  })
})
