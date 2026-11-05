import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompts } from '../scripts/build'
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
    expect(trio.some(c => glm(c).engine === 'command' && /^opencode run -m \S+ \{prompt\}$/.test(glm(c).command))).toBe(true)
  })

  it('has a SKILL.md with the frontmatter every host reads', () => {
    const md = read('SKILL.md')
    expect(md).toMatch(/^---\nname: granny-workflow\ndescription: .{50,1024}\n---\n/)
    for (const ref of ['references/claude-code.md', 'references/opencode.md', 'references/omp.md', 'references/cursor.md', 'references/config.md', 'references/setup.md']) {
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

  it('releases 1.5.0 with a CHANGELOG entry for the package version', () => {
    const { version } = JSON.parse(readRoot('package.json'))
    expect(version).toBe('1.5.0')
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
