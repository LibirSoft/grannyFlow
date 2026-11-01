import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompts } from '../scripts/build'
import { resolveConfig } from '../src/core/config'

const skill = join(import.meta.dir, '../skills/granny-workflow')
const read = (p: string) => readFileSync(join(skill, p), 'utf8')
const configBlocks = (md: string) =>
  [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]!).filter(b => /^\{\s*"roles"/.test(b.trim()))

describe('skill docs', () => {
  it('ships prompts.md in sync with the engine prompts', () => {
    expect(read('references/prompts.md')).toBe(renderPrompts())
  })

  it('has config examples that the engine accepts', () => {
    const blocks = [...configBlocks(read('SKILL.md')), ...configBlocks(read('references/config.md'))]
    expect(blocks.length).toBeGreaterThanOrEqual(2)
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
})
