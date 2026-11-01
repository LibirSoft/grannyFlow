import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompts } from '../scripts/build'
import { resolveConfig } from '../src/core/config'

const root = join(import.meta.dir, '..')
const skill = join(root, 'skills/granny-workflow')
const read = (p: string) => readFileSync(join(skill, p), 'utf8')
const readRoot = (p: string) => readFileSync(join(root, p), 'utf8')
const configBlocks = (md: string) =>
  [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]!).filter(b => /^\{\s*"(roles|reviewers)"/.test(b.trim()))

describe('skill docs', () => {
  it('ships prompts.md in sync with the engine prompts', () => {
    expect(read('references/prompts.md')).toBe(renderPrompts())
  })

  it('has config examples that the engine accepts', () => {
    const blocks = [...configBlocks(readRoot('README.md')), ...configBlocks(read('SKILL.md')), ...configBlocks(read('references/config.md'))]
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    for (const block of blocks) expect(() => resolveConfig([JSON.parse(block)])).not.toThrow()
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
    expect(config).toContain('A P2 that duplicates a P1 is scored on its own')
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
