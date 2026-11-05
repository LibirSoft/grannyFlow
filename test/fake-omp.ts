import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// A stand-in for the omp binary: `GRANNY_OMP_BIN=<wrapper>` runs this script with omp's argv.
// It loads the extension named by -e in child mode against a fake pi, so the submit tool and the
// guard the role sessions get are the real ones, and answers with canned results.
//
// FAKE_OMP_DIR holds behaviour.json (written by the test) and calls.jsonl (one line per run).

export interface FakeOmpBehaviour {
  /** Session-dir slugs (the part after `<n>-`) whose first run stops without submitting. */
  skipOnce?: string[]
  /** Session-dir slugs whose first run submits an invalid result. */
  invalidOnce?: string[]
  /** Provider errors: the first `times` runs of a slug end with stopReason "error" and this message. */
  errors?: Array<{ slug: string; message: string; times: number }>
  /** Slugs whose run ignores SIGTERM and hangs until killed. */
  hang?: string[]
}

export const CANNED: Record<string, unknown> = {
  granny_submit_implementation: { startSha: 'aaa', headSha: 'bbb', gatesGreen: true, gates: 'ok', commits: ['c1'], untested: '' },
  granny_submit_judgement: {
    perFinding: [{ id: 'reviewer-F1', verdict: 'confirmed', impact: 'critical', likelihood: 'edge', fixCost: 'small', scope: 'in-scope', evidence: 'a.txt:1 - real', reason: 'real' }],
    rationale: 'ok',
  },
  granny_submit_final: { gatesGreen: true, gates: 'ok', commits: ['c1'], prBodyPath: '.granny/PR-BODY.md', issues: '' },
  granny_submit_plan_fix: { files: ['/plan.md'], changes: 'fixed' },
}

const FINDING = { id: 'F1', severity: 'P2', file: 'a.txt', line: 1, title: 'Real issue', detail: 'detail' }

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const dir = process.env.FAKE_OMP_DIR!
  const behaviour: FakeOmpBehaviour = existsSync(join(dir, 'behaviour.json')) ? JSON.parse(readFileSync(join(dir, 'behaviour.json'), 'utf8')) : {}
  const stdin = await new Response(Bun.stdin.stream()).text()
  const spec = JSON.parse(process.env.GRANNY_OMP_CHILD ?? 'null')
  const sessionDir = argv[argv.indexOf('--session-dir') + 1]!
  const slug = basename(sessionDir).replace(/^\d+-/, '')
  mkdirSync(sessionDir, { recursive: true })
  const counter = join(sessionDir, 'fake-runs')
  const attempt = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
  writeFileSync(counter, String(attempt))
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), slug, attempt, child: spec, stdin, pid: process.pid }) + '\n')

  const tools = new Map<string, any>()
  const guards: any[] = []
  const extension = argv[argv.indexOf('-e') + 1]!
  const factory = (await import(extension)).default
  await factory({
    registerTool: (t: any) => tools.set(t.name, t),
    on: (event: string, handler: any) => event === 'tool_call' && guards.push(handler),
    sendMessage: () => {
      throw new Error('sendMessage in a role session')
    },
  })
  const say = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
  say({ type: 'session', version: 3, id: `fake-${process.pid}`, cwd: process.cwd() })
  const end = (stopReason: string, errorMessage?: string) =>
    say({ type: 'message_end', message: { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) } })

  if (behaviour.hang?.includes(slug)) {
    process.on('SIGTERM', () => {})
    writeFileSync(join(dir, `hang-${slug}.pid`), String(process.pid))
    await new Promise(() => setInterval(() => {}, 1000))
  }
  const error = behaviour.errors?.find(e => e.slug === slug && attempt <= e.times)
  if (error) {
    end('error', error.message)
    process.exit(1)
  }
  if (!(behaviour.skipOnce?.includes(slug) && attempt === 1)) {
    const tool = tools.get(spec.tool)
    let value: unknown = CANNED[spec.tool]
    if (spec.tool === 'granny_submit_findings') {
      const marker = join(process.cwd(), '.granny', 'reviewed')
      value = { findings: existsSync(marker) ? [] : [FINDING] }
      mkdirSync(join(process.cwd(), '.granny'), { recursive: true })
      writeFileSync(marker, '')
    }
    if (behaviour.invalidOnce?.includes(slug) && attempt === 1) value = { gates: 'ok' }
    if (spec.tool === 'granny_submit_implementation') {
      spawnSync('git', ['commit', '-q', '--allow-empty', '-m', `feat: ${slug}`], { cwd: process.cwd() })
    }
    const blocked = await guards[0]({ type: 'tool_call', toolCallId: 'c1', toolName: spec.tool, input: value })
    if (!blocked?.block) await tool.execute('c1', value, undefined, undefined, { cwd: process.cwd() })
  }
  end('stop')
}
