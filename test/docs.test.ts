import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompts } from '../scripts/build'
import { DEFAULT_CONFIG, resolveConfig } from '../src/core/config'

const root = join(import.meta.dir, '..')
const skill = join(root, 'skills/granny-workflow')
const read = (p: string) => readFileSync(join(skill, p), 'utf8')
const readRoot = (p: string) => readFileSync(join(root, p), 'utf8')
const jsonBlocks = (md: string) => [...md.matchAll(/^[ \t]*```json\s*\n([\s\S]*?)^[ \t]*```/gm)].map(m => m[1]!)

describe('skill docs', () => {
  it('ships prompts.md in sync with the engine prompts', () => {
    expect(read('references/prompts.md')).toBe(renderPrompts())
  })

  it('has only JSON examples that resolveConfig accepts on both hosts', () => {
    const docs: Record<string, string> = { 'README.md': readRoot('README.md'), 'SKILL.md': read('SKILL.md') }
    for (const f of readdirSync(join(skill, 'references'))) docs[`references/${f}`] = read(`references/${f}`)
    const examples = Object.entries(docs).flatMap(([file, md]) => jsonBlocks(md).map(block => ({ file, block })))
    expect(examples.length).toBeGreaterThanOrEqual(10)
    for (const { file, block } of examples) {
      for (const host of ['claude-code', 'opencode'] as const) {
        let problem: string | undefined
        try {
          resolveConfig([JSON.parse(block)], host)
        } catch (e) {
          problem = String(e)
        }
        expect({ file, host, block, problem }).toEqual({ file, host, block, problem: undefined })
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

  it('shows a Codex, Opus and GLM reviewer list in the README for opencode and for Claude Code', () => {
    const configs = jsonBlocks(readRoot('README.md')).map(b => JSON.parse(b))
    const glm = (c: any) => c.reviewers?.find((r: any) => r.name === 'glm')
    const trio = configs.filter(c => ['codex', 'opus', 'glm'].every(n => c.reviewers?.some((r: any) => r.name === n)))
    expect(trio.some(c => glm(c).engine === 'agent' && /^[\w.-]+\/[\w.-]+$/.test(glm(c).model?.opencode))).toBe(true)
    expect(trio.some(c => glm(c).engine === 'command' && /^opencode run -m \S+ \{prompt\}$/.test(glm(c).command))).toBe(true)
  })

  it('has a SKILL.md with the frontmatter every host reads', () => {
    const md = read('SKILL.md')
    expect(md).toMatch(/^---\nname: granny-workflow\ndescription: .{50,1024}\n---\n/)
    for (const ref of ['references/claude-code.md', 'references/opencode.md', 'references/cursor.md', 'references/config.md']) {
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
    expect(read('references/cursor.md')).toContain('## The plan review')
    expect(readRoot('README.md')).toMatch(/^\| `planReview` \| `false` \|/m)
  })

  it('has the Cursor protocol route and triage findings in the engine order', () => {
    const cursor = read('references/cursor.md')
    const route = cursor.slice(cursor.indexOf('3. **Route.**'), cursor.indexOf('4. **Judge**'))
    expect(route).toContain('in the final review, a decline in a stage review of that repo counts too')
    const triage = cursor.slice(cursor.indexOf('5. **Triage**'), cursor.indexOf('take the first rule that matches'))
    expect(triage.indexOf('apply [the ratchet]')).toBeGreaterThan(-1)
    expect(triage.indexOf('apply [the ratchet]')).toBeLessThan(triage.indexOf('compute the priority'))
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
