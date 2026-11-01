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
