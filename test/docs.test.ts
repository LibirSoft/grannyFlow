import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompts } from '../scripts/build'
import { SAME_MODEL_HINT } from '../src/adapters/common'
import { blockReason } from '../src/adapters/omp/extension'
import { DEFAULT_CONFIG, resolveConfig } from '../src/core/config'
import { HOSTS } from '../src/core/types'

const root = join(import.meta.dir, '..')
const skill = join(root, 'skills/granny-workflow')
const read = (p: string) => readFileSync(join(skill, p), 'utf8')
const readRoot = (p: string) => readFileSync(join(root, p), 'utf8')
const OMP_INSTALL = 'cp -r <skill-dir>/engines/omp/extensions/granny-workflow ~/.omp/agent/extensions/'
const jsonBlocks = (md: string) => [...md.matchAll(/^[ \t]*```json\s*\n([\s\S]*?)^[ \t]*```/gm)].map(m => m[1]!)

describe('skill docs', () => {
  it('ships prompts.md in sync with the engine prompts', () => {
    expect(read('references/prompts.md')).toBe(renderPrompts())
  })

  it('names the Claude Code script of each mode wherever a launch is described', () => {
    const cc = read('references/claude-code.md')
    for (const script of ['plan.js', 'workflow.js', 'judge.js']) {
      expect(cc).toContain(`script: <contents of ${script}>`)
      expect(() => read(`engines/claude-code/${script}`)).not.toThrow()
    }
    expect(cc).toContain('a new launch of `workflow.js`')
    expect(read('references/judge.md')).toContain('`engines/claude-code/judge.js`')
    const md = read('SKILL.md')
    expect(md).toContain('`engines/claude-code/plan.js`')
    expect(md).toContain('`engines/claude-code/judge.js` with `judge: true`')
    expect(md).toContain('on Claude Code with `engines/claude-code/workflow.js`, not `plan.js`')
    for (const doc of [cc, read('references/judge.md'), md]) expect(doc).not.toContain('same Workflow script')
  })

  it('has only JSON examples that resolveConfig accepts on every host - omp refusing only the Codex reviewers, with its own message', () => {
    const docs: Record<string, string> = { 'README.md': readRoot('README.md'), 'SKILL.md': read('SKILL.md') }
    for (const f of readdirSync(join(skill, 'references'))) docs[`references/${f}`] = read(`references/${f}`)
    const examples = Object.entries(docs).flatMap(([file, md]) => jsonBlocks(md).map(block => ({ file, block })))
    expect(examples.length).toBeGreaterThanOrEqual(10)
    for (const { file, block } of examples) {
      const config = JSON.parse(block)
      const codex = (config.reviewers ?? []).some((r: any) => ['auto', 'codex', 'codex-plugin', undefined].includes(r?.engine))
      for (const host of HOSTS) {
        let problem: string | undefined
        try {
          resolveConfig([config], host)
        } catch (e) {
          problem = String(e)
        }
        if (host === 'omp' && codex) {
          expect(problem).toContain('runs Codex, which granny does not run on omp')
          expect(problem!.split('\n- ').slice(1).every(line => line.includes('which granny does not run on omp'))).toBe(true)
        } else expect({ file, host, block, problem }).toEqual({ file, host, block, problem: undefined })
      }
    }
  })

  it('documents every config key once in the config reference, with the engine default', () => {
    const config = read('references/config.md')
    const keysTable = config.slice(config.indexOf('## Keys'), config.indexOf('\n## ', config.indexOf('## Keys') + 1))
    const rows = [...keysTable.matchAll(/^\| `([^`]+)` \|([^|]*)\|/gm)].map(m => ({ key: m[1]!, value: m[2]!.trim() }))
    const expected = [
      '$schema',
      ...Object.keys(DEFAULT_CONFIG.roles).map(r => `roles.${r}`),
      'worktreeDir',
      ...Object.keys(DEFAULT_CONFIG).filter(k => k !== 'roles'),
    ]
    expect(rows.map(r => r.key).sort()).toEqual(expected.sort())
    for (const key of ['threshold', 'alwaysFix', 'maxRounds', 'planReview', 'base', 'gates', 'workDir', 'worktree', 'language', 'aiAttribution', 'reviewers'] as const) {
      expect({ key, value: JSON.parse(rows.find(r => r.key === key)!.value.slice(1, -1)) }).toEqual({ key, value: DEFAULT_CONFIG[key] })
    }
    expect(() => resolveConfig([{ $schema: './granny.schema.json' }])).not.toThrow()
  })

  it('shows a Codex, Opus and GLM reviewer list in the config reference for opencode and for Claude Code', () => {
    const configs = jsonBlocks(read('references/config.md')).map(b => JSON.parse(b))
    const glm = (c: any) => c.reviewers?.find((r: any) => r.name === 'glm')
    const trio = configs.filter(c => ['codex', 'opus', 'glm'].every(n => c.reviewers?.some((r: any) => r.name === n)))
    expect(trio.some(c => glm(c).engine === 'agent' && /^[\w.-]+\/[\w.-]+$/.test(glm(c).model?.opencode))).toBe(true)
    expect(trio.some(c => glm(c).engine === 'opencode' && /^[\w.-]+\/[\w.-]+$/.test(glm(c).model))).toBe(true)
  })

  it('documents the opencode reviewer engine wherever the reviewer engines are listed, and no longer sends GLM through a command reviewer', () => {
    const config = read('references/config.md')
    expect(config).toMatch(/^\| `engine` \| [^|]*`command`, `opencode` \|/m)
    expect(config).toMatch(/^\| `opencode` \| /m)
    const section = config.slice(config.indexOf('### opencode reviewers'), config.indexOf('\n### ', config.indexOf('### opencode reviewers') + 1))
    for (const topic of ['--standalone', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'external_directory', '#<effort>', 'not a sandbox', '`opencode models`', 'opencode returned no answer']) {
      expect({ topic, has: section.includes(topic) }).toEqual({ topic, has: true })
    }
    const commands = jsonBlocks(config).flatMap(b => JSON.parse(b).reviewers ?? []).filter((r: any) => r.engine === 'command')
    expect(commands.length).toBeGreaterThan(0)
    const docs: Record<string, string> = { 'README.md': readRoot('README.md'), 'SKILL.md': read('SKILL.md') }
    for (const f of readdirSync(join(skill, 'references'))) if (f !== 'prompts.md') docs[`references/${f}`] = read(`references/${f}`)
    for (const [file, md] of Object.entries(docs)) expect({ file, stale: md.includes('opencode run -m') }).toEqual({ file, stale: false })
    const md = read('SKILL.md')
    expect(md.split('\n').find(l => l.startsWith('| reviewers |'))).toContain('`opencode`')
    expect(md).toContain('Engine `opencode`: `opencode --version` works and `opencode models` lists the model')
    expect(read('references/setup.md')).toContain('"engine": "opencode"')
    for (const host of ['claude-code', 'opencode', 'omp']) {
      const ref = read(`references/${host}.md`)
      const reviewers = ref.slice(ref.indexOf('## Reviewers'), ref.indexOf('\n## ', ref.indexOf('## Reviewers') + 1))
      expect({ host, has: reviewers.includes('- `opencode` ') }).toEqual({ host, has: true })
    }
    expect(read('references/claude-code.md')).toContain('`review <stage> r<n> <name> save`')
    expect(read('references/judge.md')).toContain('an `opencode` reviewer')
    expect(readRoot('README.md')).toContain('"engine": "opencode"')
    const unreleased = readRoot('CHANGELOG.md').split('\n## ')[1]!
    expect(unreleased).toContain('`"engine": "opencode"`')
    const entry = unreleased.split('\n').find(l => l.includes('`"engine": "opencode"`'))!
    expect(entry).not.toContain('one string for every host')
    expect(entry).toContain('an object keyed by host')
    expect(entry).toContain('of the absolute file paths named in `context` - each whole directory')
    const write = read('references/judge.md').split('## 3. Write')[1]!.split('\n## ')[0]!
    expect(write).toContain('An `opencode` reviewer\'s `model`: one string, not keyed by host')
  })

  it('has a SKILL.md with the frontmatter every host reads', () => {
    const md = read('SKILL.md')
    expect(md).toMatch(/^---\nname: granny-workflow\ndescription: .{50,1024}\n---\n/)
    // Hosts parse this with a YAML parser and skip the skill when it fails, e.g. on a ": " in the description.
    const frontmatter = Bun.YAML.parse(md.split('\n---\n')[0].slice(4)) as Record<string, unknown>
    expect(frontmatter.name).toBe('granny-workflow')
    expect(md.split('\n')[2]).toBe(`description: ${frontmatter.description}`)
    for (const ref of ['references/claude-code.md', 'references/opencode.md', 'references/omp.md', 'references/cursor.md', 'references/config.md', 'references/setup.md', 'references/judge.md']) {
      expect(md).toContain(`(${ref}`)
      expect(() => read(ref)).not.toThrow()
    }
  })

  it('describes the reviewers list and mentions roles.reviewer only as the migration', () => {
    const docs: Record<string, string> = { 'README.md': readRoot('README.md'), 'SKILL.md': read('SKILL.md') }
    for (const f of readdirSync(join(skill, 'references'))) docs[`references/${f}`] = read(`references/${f}`)
    for (const f of readdirSync(join(skill, 'engines/cursor/agents'))) docs[`cursor/${f}`] = read(`engines/cursor/agents/${f}`)
    for (const [file, text] of Object.entries(docs)) {
      const stale = text.split('\n').filter(l => l.includes('roles.reviewer') && !/no `roles\.reviewer`|leftover `roles\.reviewer`/.test(l))
      expect({ file, stale }).toEqual({ file, stale: [] })
    }
    const config = read('references/config.md')
    expect(config).toContain('A P2 that duplicates a P1 is classified on its own')
    expect(config).toContain('A reviewer that labels everything P0/P1 bypasses the judge')
    expect(read('references/claude-code.md')).toContain('Claude models only')
  })

  it('documents the worktree in the config keys, the SKILL.md preflight and the Cursor protocol', () => {
    const config = read('references/config.md')
    expect(config).toMatch(/^\| `worktree` \| `true` \|/m)
    expect(config).toMatch(/^\| `worktreeDir` \| `<parent of repo>\/<repo name>-worktrees` \|/m)
    expect(config).toContain('## Worktree')
    const skill = read('SKILL.md')
    expect(skill).toContain('do not create or check out `branch` yourself')
    expect(skill).not.toMatch(/^2\. `git -C <repo> status --short` is clean; create and check out `branch`/m)
    expect(read('references/cursor.md')).toContain('## The worktree')
    expect(read('references/cursor.md')).toContain('`git -C <repo> worktree list --porcelain`')
  })

  it('documents the review trail and its poster in the config keys, SKILL.md, the host references and the README', () => {
    expect(readFileSync(join(skill, 'scripts/pr-comments.mjs'), 'utf8')).toContain('granny-trail')
    const config = read('references/config.md')
    expect(config).toMatch(/^\| `trail` \| `true` \|.*\[Review trail\]\(#review-trail\)/m)
    expect(config).toContain('## Review trail')
    expect(config).toContain('node <skill-dir>/scripts/pr-comments.mjs [--platform github|gitlab] [--pr <n>] [--trail <dir>] [--out <file> [--base <ref>]] [--dry-run]')
    for (const topic of ['### GitHub', '### GitLab', '### Any other client: `--out`', 'glab api', 'bulk_publish', '"version": 1']) expect({ topic, has: config.includes(topic) }).toEqual({ topic, has: true })
    const md = read('SKILL.md')
    expect(md).toContain('a GitLab MR')
    expect(md).toContain('`--out <file>`')
    expect(md).toContain('### When the PR is opened')
    expect(md).toContain('run `node <skill-dir>/scripts/pr-comments.mjs` in the worktree')
    expect(md).toContain('Never write, edit or post review comments yourself. Only the script posts them.')
    expect(md).toContain('No push, no `git remote add`, no PR, no tag - the user decides.')
    expect(md).toContain('`trail.failed`')
    for (const host of ['claude-code', 'opencode', 'omp', 'cursor']) {
      const ref = read(`references/${host}.md`)
      expect({ host, has: ref.includes('## When the PR is opened') && ref.includes('<skill-dir>/scripts/pr-comments.mjs') }).toEqual({ host, has: true })
      if (host !== 'cursor') expect({ host, gitlab: ref.includes('GitLab MR') }).toEqual({ host, gitlab: true })
    }
    expect(readRoot('README.md')).toContain('node <skill-dir>/scripts/pr-comments.mjs')
    expect(readRoot('README.md')).toContain('GitLab')
  })

  it('documents the plan review in the config keys, SKILL.md, the host references and the Cursor protocol', () => {
    const config = read('references/config.md')
    expect(config).toMatch(/^\| `planReview` \| `false` \|/m)
    expect(config).toContain('## Plan review')
    expect(config).toContain('"planReview": true')
    const skill = read('SKILL.md')
    expect(skill).toMatch(/^\| `plan` \| absolute path/m)
    expect(skill).toContain('plan review ─►')
    expect(read('references/claude-code.md')).toContain('repo, branch, base, context, plan, stages')
    expect(read('references/opencode.md')).toContain('granny_run({ repo, branch, base, context, plan?, stages')
    expect(read('references/omp.md')).toContain('granny_run({ repo, branch, base, context, plan?, stages')
    expect(read('references/cursor.md')).toContain('## The plan review')
    expect(readRoot('README.md')).toMatch(/^\| `planReview` \| `false` \|/m)
  })

  it('names in cursor.md only prompts that prompts.md has under that heading', () => {
    const headings = [...read('references/prompts.md').matchAll(/^## (.+)$/gm)].map(m => m[1]!)
    const names = [...new Set([...read('references/cursor.md').matchAll(/"([^"]+)" prompt/g)].map(m => m[1]!))]
    expect(names.length).toBeGreaterThan(10)
    const missing = names.filter(n => !headings.some(h => h === n || h.startsWith(`${n},`) || h.startsWith(`${n} (`) || h.startsWith(`${n} - `)))
    expect(missing).toEqual([])
  })

  it('tells a Cursor run what to do with an opencode reviewer', () => {
    const cursor = read('references/cursor.md')
    expect(cursor).toContain('An `engine: "opencode"` reviewer is not supported here')
    expect(cursor).toContain('engine `opencode`: not supported on Cursor')
  })

  it('says wherever plan review can be turned on that it costs many tokens and time, and to turn it on only when asked', () => {
    for (const file of ['SKILL.md', 'references/config.md', 'references/claude-code.md', 'references/opencode.md', 'references/omp.md', 'references/cursor.md']) {
      const text = read(file)
      expect({ file, extra: text.includes('so it costs extra tokens') }).toEqual({ file, extra: false })
      expect({ file, tokens: text.includes('many more tokens') }).toEqual({ file, tokens: true })
      expect({ file, asked: /only when the user asks|unless the user asks for a plan review/.test(text) }).toEqual({ file, asked: true })
    }
    expect(read('references/setup.md')).toContain('plan review is off by default because every round is a full review + judge + fix')
    expect(read('SKILL.md')).toContain('plan review on or off')
  })

  it("tells the agent in SKILL.md to keep the user's models and loop settings unless the user asked, and to ask on a provider error", () => {
    const row = read('SKILL.md').split('\n').find(l => l.startsWith('| `config` |'))!
    for (const key of ['roles.*.model', 'roles.*.effort', 'reviewers', 'threshold', 'maxRounds', 'checks']) expect(row).toContain(key)
    expect(row).toContain('only when the user asked for that change in this conversation')
    expect(row).toContain('stop and ask the user which model to use')
    expect(row).toContain('overrides:')
  })

  it('documents granny setup with the same threshold presets in the README, setup.md and the config reference', () => {
    expect(read('SKILL.md')).toContain('granny setup')
    expect(read('engines/opencode/agents/granny.md')).toContain('granny setup')
    expect(readRoot('README.md').indexOf('## Install')).toBeLessThan(readRoot('README.md').indexOf('## Setup'))
    expect(readRoot('README.md')).toContain('> granny setup')
    const presets = { strict: 55, normal: 70, relaxed: 85 }
    expect(presets.normal).toBe(DEFAULT_CONFIG.threshold)
    for (const [name, threshold] of Object.entries(presets)) {
      expect(readRoot('README.md')).toMatch(new RegExp(`^ *\\| ${name} \\| ${threshold} \\|`, 'm'))
      expect(read('references/setup.md')).toMatch(new RegExp(`^ *\\| ${name}( \\(default\\))? \\| \`${threshold}\` \\|`, 'm'))
      expect(read('references/config.md')).toContain(`${name} \`${threshold}\``)
    }
  })

  describe('granny judge', () => {
    const MAPPING = /critical.*P0.*major.*P1.*moderate.*P2.*minor.*P3/s

    it('has a reference with config examples that parse, the launch per host, the mapping and the report directory', () => {
      const judge = read('references/judge.md')
      const blocks = jsonBlocks(judge)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        const config = JSON.parse(block)
        expect(Object.keys(config).sort()).toEqual(['reviewers', 'roles'])
        for (const host of HOSTS) expect(() => resolveConfig([config], host)).not.toThrow()
      }
      expect(judge).toMatch(MAPPING)
      expect(judge).toContain('.granny/reviews/')
      expect(judge).toContain('granny_judge({ repo, base?, context? })')
      expect(judge).toContain('args: { judge: true, repo, base, context, config: [<user>, <project>] }')
      expect(judge).toContain('[setup.md](setup.md#1-look-first)')
      expect(judge).toContain('A parent never answers these for the user')
      expect(judge).toContain('`written: false`')
      expect(judge).toContain('`implement: false`')
    })

    it('is routed from SKILL.md, whose description names it', () => {
      const md = read('SKILL.md')
      expect(md).toContain('[references/judge.md](references/judge.md)')
      expect(md.split('\n')[2]).toContain('granny judge')
      expect(md.split('\n')[2]).toContain('review only')
      expect(md).toContain('`granny_judge`')
    })

    it('is named in the host references, the config reference, the README and the changelog', () => {
      for (const file of ['references/omp.md', 'references/opencode.md']) {
        expect({ file, tool: read(file).includes('granny_judge({ repo, base?, context?, config? })') }).toEqual({ file, tool: true })
        expect({ file, reviews: read(file).includes('.granny/reviews/') }).toEqual({ file, reviews: true })
      }
      expect(read('references/claude-code.md')).toContain('judge: true')
      expect(read('references/claude-code.md')).toContain('.granny/reviews/')
      expect(read('references/cursor.md')).toContain('## granny judge')
      expect(read('references/cursor.md')).toMatch(/granny judge[\s\S]*not deterministic/)
      expect(read('references/cursor.md')).toContain('.granny/reviews/')
      const config = read('references/config.md')
      expect(config).toContain('## Judge runs')
      expect(config).toContain('(#judge-runs)')
      expect(config.slice(config.indexOf('## Judge runs'))).toMatch(MAPPING)
      expect(config).toContain('names both a role and a method')
      const readme = readRoot('README.md')
      expect(readme).toContain('## Review only: `granny judge`')
      expect(readme.indexOf('## Use')).toBeLessThan(readme.indexOf('## Review only: `granny judge`'))
      expect(readme.indexOf('## Review only: `granny judge`')).toBeLessThan(readme.indexOf('## How it works'))
      expect(readme).toContain('.granny/reviews/')
      expect(readme).toMatch(MAPPING)
      expect(readRoot('CHANGELOG.md')).toContain('`granny_judge`')
      expect(read('engines/opencode/agents/granny.md')).toContain('granny judge')
    })
  })

  it('has the Cursor protocol route and triage findings in the engine order', () => {
    const cursor = read('references/cursor.md')
    const route = cursor.slice(cursor.indexOf('3. **Route.**'), cursor.indexOf('4. **Judge**'))
    expect(route).toContain('in the final review, a decline in a stage review of that repo counts too')
    const triage = cursor.slice(cursor.indexOf('5. **Triage**'), cursor.indexOf('take the first rule that matches'))
    expect(triage.indexOf('apply [the ratchet]')).toBeGreaterThan(-1)
    expect(triage.indexOf('apply [the ratchet]')).toBeLessThan(triage.indexOf('compute the priority'))
  })

  it('routes omp sessions to omp.md, which installs the committed extension bundle', () => {
    const md = read('SKILL.md')
    expect(md).toContain('[references/omp.md](references/omp.md)')
    expect(md).toContain('[references/omp.md](references/omp.md#install)')
    expect(read('references/omp.md')).toContain(OMP_INSTALL)
    expect(() => read('engines/omp/extensions/granny-workflow/index.js')).not.toThrow()
  })

  it('installs both opencode plugin entries and documents watching a run on opencode', () => {
    const opencode = read('references/opencode.md')
    for (const entry of ['index.js', 'tui.js']) {
      expect(opencode).toContain(`\`${entry}\``)
      expect(() => read(`engines/opencode/plugin/granny-workflow/${entry}`)).not.toThrow()
    }
    expect(opencode).toContain('features: { server: true, tui: true }')
    expect(opencode).toContain('## Watching a run')
    expect(opencode).toContain('`<leader>j`')
    const config = read('references/config.md')
    expect(config).toMatch(/^\| `watch` \| `"full"` \| omp and opencode:/m)
    expect(config).toContain('[opencode.md](opencode.md#watching-a-run)')
    expect(config).not.toMatch(/and opencode (accept|have their own views)/)
  })

  it('describes the run navigator page, its detail and its keys on omp and opencode', () => {
    const page = ['granny  feat/pause  ● running', '↺ review loop · up to 4 rounds', '2 agents at the same time', 'granny › 2 Client pause UI › Round 2 of 4', '`run details`', 'NOW', 'TODO', 'RECENT', 'LAST SAID', '✓ done in', '`v`', '`f`', 'short model']
    for (const file of ['references/omp.md', 'references/opencode.md']) {
      const text = read(file)
      expect({ file, missing: page.filter(piece => !text.includes(piece)) }).toEqual({ file, missing: [] })
      expect({ file, phases: text.includes('round and stage groups') }).toEqual({ file, phases: false })
    }
    const omp = read('references/omp.md')
    const navigator = omp.slice(omp.indexOf('**Run navigator.**'))
    expect(navigator.startsWith('**Run navigator.** `/granny` or `alt+w` in the omp TUI opens it; the run panel says so.')).toBe(true)
    expect(omp).toContain('`t` opens')
    const opencode = read('references/opencode.md')
    expect(opencode).toContain('`data.session.message`')
    expect(opencode).toContain('granny · stage <k>/<n> · <phase> · <n> running · <time>')
    expect(opencode).toContain('Enter opens its opencode session')
  })

  it("tells the final check to rewrite the PR body's review section from the run's outcomes, by hand on Cursor too", () => {
    expect(read('references/prompts.md')).toContain("Rewrite the PR body's review and status section from this list")
    expect(read('references/cursor.md')).toContain("rewrite the PR body's review section from them")
    expect(read('references/config.md')).toContain("rewrite the PR body's review section from them")
  })

  it('gives the same-model hint in setup on every host and names it in the omp and opencode references', () => {
    expect(read('references/setup.md')).toContain(SAME_MODEL_HINT)
    for (const file of ['references/omp.md', 'references/opencode.md']) expect({ file, text: read(file).includes(SAME_MODEL_HINT) }).toEqual({ file, text: true })
  })

  it('names the run files the views read in both host references', () => {
    for (const file of ['references/omp.md', 'references/opencode.md']) {
      const text = read(file)
      const pieces = ['`outline`', 'stage { number, name, event, outcome? }', 'heartbeat { command }', '`cwd`']
      expect({ file, missing: pieces.filter(piece => !text.includes(piece)) }).toEqual({ file, missing: [] })
    }
    expect(read('references/omp.md')).toContain('{ type: "todo", todos }')
    for (const file of ['references/omp.md', 'references/opencode.md']) expect({ file, text: read(file).includes("`granny_status`'s journal tail leaves it out") }).toEqual({ file, text: true })
  })

  it("states the model refusal and the rule on the user's models in both host references", () => {
    for (const file of ['references/omp.md', 'references/opencode.md']) {
      const text = read(file)
      const pieces = ['`granny_run refused:`', 'host-keyed', 'only when the user asked for that change in this conversation', 'stop and ask the user which model to use', 'overrides: roles.implementer.model']
      expect({ file, missing: pieces.filter(piece => !text.includes(piece)) }).toEqual({ file, missing: [] })
    }
    expect(read('SKILL.md')).toContain('`granny_run` refuses a model the host cannot run')
    expect(read('references/config.md')).toContain('`granny_run` refuses')
  })

  it('shows no Claude Code alias as a model for every host in a JSON example, since opencode and omp refuse the run', () => {
    const docs: Record<string, string> = { 'README.md': readRoot('README.md'), 'SKILL.md': read('SKILL.md') }
    for (const f of readdirSync(join(skill, 'references'))) docs[`references/${f}`] = read(`references/${f}`)
    const alias = /^(default|sonnet|opus|haiku|opusplan)(\[1m\])?$/i
    const plain = Object.entries(docs).flatMap(([file, md]) =>
      jsonBlocks(md).flatMap(block => {
        const config = JSON.parse(block)
        const models = [...Object.values<any>(config.roles ?? {}).map(r => r?.model), ...(config.reviewers ?? []).filter((r: any) => r?.engine === 'agent').map((r: any) => r.model)]
        return models.filter(m => typeof m === 'string' && alias.test(m)).map(model => ({ file, model }))
      }),
    )
    expect(plain).toEqual([])
  })

  it('names omp in the README, the package description and the hosts diagram', () => {
    expect(readRoot('README.md')).toContain(OMP_INSTALL)
    expect(readRoot('README.md')).toMatch(/^\| omp \|/m)
    expect(JSON.parse(readRoot('package.json')).description).toContain('omp')
    for (const theme of ['light', 'dark']) expect(readRoot(`docs/images/hosts-${theme}.svg`)).toContain('omp')
  })

  it('lists in omp.md exactly the built-in omp tools a read-only role may call', () => {
    const omp = read('references/omp.md')
    const start = omp.indexOf('may call only')
    const sentence = omp.slice(start, omp.indexOf('and their submit tool', start))
    expect(start).toBeGreaterThan(-1)
    const documented = [...sentence.matchAll(/`([a-z_]+)`/g)].map(m => m[1]!).sort()
    const builtins = ['read', 'security_scan', 'bash', 'edit', 'ast_grep', 'ast_edit', 'ask', 'debug', 'ida', 'eval', 'github', 'glob', 'grep', 'find', 'lsp', 'checkpoint', 'rewind', 'context_notes', 'new_context', 'task', 'wait', 'todo', 'web_search', 'write', 'memory_edit', 'retain', 'recall', 'reflect', 'learn', 'manage_skill', 'think', 'yield', 'goal']
    const allowed = builtins.filter(t => blockReason(t, t === 'bash' ? { command: 'git diff' } : {}, 'read-only', 'granny_submit_findings') === undefined).sort()
    expect(documented).toEqual(allowed)
    for (const op of ['pr_create', 'pr_push', 'pr_checkout']) {
      expect(omp).toContain(`\`${op}\``)
      expect(blockReason('github', { op }, 'write', 'granny_submit_implementation')).toBeDefined()
    }
  })

  it('releases 1.6.0 with a CHANGELOG entry for the package version', () => {
    const { version } = JSON.parse(readRoot('package.json'))
    expect(version).toBe('1.6.0')
    const changelog = readRoot('CHANGELOG.md')
    expect(changelog.match(/^## (\S+)/m)?.[1]).toMatch(new RegExp(`^(Unreleased|${version.replaceAll('.', '\\.')})$`))
    expect(changelog.match(/^## (?!Unreleased$)(\S+)$/m)?.[1]).toBe(version)
    expect(changelog).not.toMatch(/used to|previously|no longer|migrat|upgrad|replaces/i)
  })

  it('points every repo reference at LibirSoft/grannyFlow', () => {
    expect(readRoot('README.md')).toContain('npx skills add LibirSoft/grannyFlow')
    const docs: Record<string, string> = {
      'README.md': readRoot('README.md'),
      'package.json': readRoot('package.json'),
      'SKILL.md': read('SKILL.md'),
    }
    for (const f of readdirSync(join(skill, 'references'))) docs[`references/${f}`] = read(`references/${f}`)
    for (const [file, text] of Object.entries(docs)) {
      expect({ file, stale: text.match(/LibirSoft\/(?!grannyFlow(?![\w-]))\S*/gi) }).toEqual({ file, stale: null })
    }
  })
})
