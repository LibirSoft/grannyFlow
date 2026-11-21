import { describe, expect, it } from 'bun:test'
import { isPrBody } from '../src/core/review'

describe('isPrBody', () => {
  it('is true for the PR body under the work dir, however the path is written', () => {
    for (const file of ['.granny/PR-BODY.md', './.granny/PR-BODY.md', '/w/repo/.granny/PR-BODY.md', '.granny/PR-BODY.md:13', '.granny/PR-BODY.md:13-20', '.granny/pr-body.md', '/w/main/.granny/PR-BODY-s2-api.md', ' .granny/PR-BODY.md ', '.granny\\PR-BODY.md']) {
      expect([file, isPrBody(file, '.granny')]).toEqual([file, true])
    }
    expect(isPrBody('tmp/granny work/PR-BODY.md', './tmp/granny work/')).toBe(true)
  })

  it('is false for any other file, a file of that name elsewhere, and a value that is no path', () => {
    for (const file of ['PR-BODY.md', 'docs/PR-BODY.md', '.granny/PR-BODY.md.bak', '.granny/plans/PR-BODY.md', '.granny/PR-BODY', 'x.granny/PR-BODY.md', '.granny/trail/s1-r1.json', 'src/a.ts', '', undefined, 7]) {
      expect([file, isPrBody(file, '.granny')]).toEqual([file, false])
    }
    expect(isPrBody('.granny/PR-BODY.md', 'tmp/g')).toBe(false)
    expect(isPrBody('aXgranny/PR-BODY.md', 'a.granny')).toBe(false)
  })
})
