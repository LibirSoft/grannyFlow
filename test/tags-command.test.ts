import { describe, expect, it } from 'bun:test'
import { runTags, type TagsIo } from '../src/tags/command'

const USER = '/home/u/.config/granny/config.json'
const TOP = '/w/repo'
const PROJECT = `${TOP}/granny.config.json`
const USAGE = [
  'usage:',
  'node <skill-dir>/scripts/tags.mjs add <name> --description <text> (--points <1-100> | --fix) [--project] [--replace] [--repo <dir>]',
  'node <skill-dir>/scripts/tags.mjs remove <name> [--project] [--repo <dir>]',
  'node <skill-dir>/scripts/tags.mjs list [--repo <dir>]',
]
const TYPO = { description: 'a misspelled word', fix: true }

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function fake(files: Record<string, string>, top: string | null = TOP, over: Partial<TagsIo> = {}) {
  const store = new Map(Object.entries(files))
  const out: string[] = []
  const io: TagsIo = {
    userPath: USER,
    read: path => store.get(path),
    write: (path, text) => {
      store.set(path, text)
    },
    print: line => out.push(line),
    toplevel: dir => (dir === undefined ? (top ?? undefined) : dir === '/other' ? '/other' : undefined),
    ...over,
  }
  return { io, out, store }
}

function run(argv: string[], files: Record<string, string> = {}, top: string | null = TOP) {
  const f = fake(files, top)
  return { code: runTags(argv, f.io), out: f.out, store: f.store }
}

describe('granny tag', () => {
  it('creates the user file with the tag when it is missing', () => {
    const r = run(['add', 'typo', '--fix', '--description', 'a misspelled word'])
    expect(r.code).toBe(0)
    expect(r.store.get(USER)).toBe(json({ tags: { typo: TYPO } }))
    expect(r.out).toEqual([`added tag typo (fix) to ${USER}`])
  })

  it('keeps the other keys and their order, and puts a new tag last', () => {
    const before = { threshold: 80, reviewers: [{ name: 'codex', engine: 'codex' }], tags: { typo: TYPO } }
    const r = run(['add', 'naming', '--points', '20', '--description', 'x'], { [USER]: json(before) })
    expect(r.code).toBe(0)
    expect(r.store.get(USER)).toBe(json({ ...before, tags: { typo: TYPO, naming: { description: 'x', points: 20 } } }))
    expect(r.out).toEqual([`added tag naming (+20) to ${USER}`])
  })

  it('writes the repo file with --project and leaves the user file as it is', () => {
    const user = json({ tags: { naming: { description: 'n', points: 5 } } })
    const r = run(['add', 'typo', '--fix', '--description', 'x', '--project'], { [USER]: user })
    expect(r.code).toBe(0)
    expect(r.out).toEqual([`added tag typo (fix) to ${PROJECT}`])
    expect(r.store.get(USER)).toBe(user)
    expect(r.store.get(PROJECT)).toBe(json({ tags: { typo: { description: 'x', fix: true } } }))
  })

  it('writes the file of the repo that --repo names', () => {
    const r = run(['add', 'typo', '--fix', '--description', 'x', '--project', '--repo', '/other'], {}, null)
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['added tag typo (fix) to /other/granny.config.json'])
    expect(r.store.get('/other/granny.config.json')).toBe(json({ tags: { typo: { description: 'x', fix: true } } }))
  })

  it('refuses --project outside a git checkout and writes nothing', () => {
    const r = run(['add', 'typo', '--fix', '--description', 'x', '--project'], {}, null)
    expect(r.code).toBe(1)
    expect(r.out).toEqual(['--project needs a git checkout: run it in the repo or pass --repo <dir>'])
    expect(r.store.size).toBe(0)
  })

  it('refuses a tag that is already there without --replace, and changes it with --replace', () => {
    const files = { [USER]: json({ tags: { typo: TYPO } }) }
    const refused = run(['add', 'typo', '--points', '20', '--description', 'b'], files)
    expect(refused.code).toBe(1)
    expect(refused.out).toEqual([`tag typo is already in ${USER} (fix) - pass --replace to change it`])
    expect(refused.store.get(USER)).toBe(files[USER])
    const changed = run(['add', 'typo', '--points', '20', '--description', 'b', '--replace'], files)
    expect(changed.code).toBe(0)
    expect(changed.out).toEqual([`replaced tag typo (+20) in ${USER}`])
    expect(changed.store.get(USER)).toBe(json({ tags: { typo: { description: 'b', points: 20 } } }))
  })

  it('names what is wrong with a new tag and writes nothing', () => {
    const cases: Array<[string[], string]> = [
      [['add', 'Typo', '--fix', '--description', 'x'], 'tags.Typo: a tag name is 1 to 32 characters of a-z, 0-9 and -, and not "none"'],
      [['add', 'none', '--fix', '--description', 'x'], 'tags.none: a tag name is 1 to 32 characters of a-z, 0-9 and -, and not "none"'],
      [['add', 'typo', '--points', '0', '--description', 'x'], 'tags.typo.points must be an integer between 1 and 100'],
      [['add', 'typo', '--points', '101', '--description', 'x'], 'tags.typo.points must be an integer between 1 and 100'],
      [['add', 'typo', '--points', '1.5', '--description', 'x'], 'tags.typo.points must be an integer between 1 and 100'],
      [['add', 'typo', '--points', '20', '--fix', '--description', 'x'], 'tags.typo has points and fix - keep one of them'],
      [['add', 'typo', '--description', 'x'], 'tags.typo needs points (1-100) or fix: true'],
      [['add', 'typo', '--fix'], 'tags.typo.description must be a non-empty string of at most 200 characters on one line'],
      [['add', 'typo', '--fix', '--description', '  '], 'tags.typo.description must be a non-empty string of at most 200 characters on one line'],
    ]
    for (const [argv, message] of cases) {
      const r = run(argv)
      expect({ argv, code: r.code, out: r.out, written: r.store.size }).toEqual({ argv, code: 1, out: [message], written: 0 })
    }
  })

  it('prints the usage for an unknown command, a flag the command does not take, or a missing value', () => {
    const cases: string[][] = [
      [],
      ['frobnicate'],
      ['add', 'typo', '--points'],
      ['add', '-fix', '--description', 'x'],
      ['add', 'typo', '--fix', '--fix', '--description', 'x'],
      ['add', 'typo', '--repo', '', '--fix', '--description', 'x'],
      ['add', 'typo', '--fix', '--description', 'x', 'extra'],
      ['remove'],
      ['remove', 'typo', '--fix'],
      ['list', 'typo'],
      ['list', '--project'],
    ]
    for (const argv of cases) {
      const r = run(argv)
      expect({ argv, code: r.code, out: r.out, written: r.store.size }).toEqual({ argv, code: 1, out: USAGE, written: 0 })
    }
  })

  it('refuses a file that is not valid JSON, not an object, or has tags that are not an object, and leaves it as it is', () => {
    const cases: Array<[string, string]> = [
      ['{ not json', `${USER}: invalid JSON (`],
      ['[]', `${USER}: not a JSON object`],
      ['{"tags": []}', `${USER}: tags must be an object keyed by tag name`],
    ]
    for (const [text, start] of cases) {
      const r = run(['add', 'typo', '--fix', '--description', 'x'], { [USER]: text })
      expect(r.code).toBe(1)
      expect(r.out).toHaveLength(1)
      expect(r.out[0]).toStartWith(start)
      expect(r.out[0]).toEndWith(' - nothing written')
      expect(r.store.get(USER)).toBe(text)
    }
  })

  it('refuses to write the user file while the repo file is not valid JSON, since the two are merged', () => {
    const r = run(['add', 'typo', '--fix', '--description', 'x'], { [PROJECT]: '{ bad' })
    expect(r.code).toBe(1)
    expect(r.out[0]).toStartWith(`${PROJECT}: invalid JSON (`)
    expect(r.store.has(USER)).toBe(false)
  })

  it('removes a tag, keeps the other keys, and removes the tags key with the last tag', () => {
    const files = { [USER]: json({ threshold: 80, tags: { typo: TYPO, naming: { description: 'b', points: 20 } } }) }
    const r = run(['remove', 'typo'], files)
    expect(r.code).toBe(0)
    expect(r.out).toEqual([`removed tag typo from ${USER}`])
    expect(r.store.get(USER)).toBe(json({ threshold: 80, tags: { naming: { description: 'b', points: 20 } } }))
    const last = run(['remove', 'naming'], { [USER]: json({ threshold: 80, tags: { naming: { description: 'b', points: 20 } } }) })
    expect(last.store.get(USER)).toBe(json({ threshold: 80 }))
  })

  it('says which file has a tag that remove was not asked to take from this one', () => {
    const r = run(['remove', 'typo'], { [PROJECT]: json({ tags: { typo: TYPO } }) })
    expect(r.code).toBe(1)
    expect(r.out).toEqual([`tag typo is not in ${USER} - it is in ${PROJECT}`])
    expect(r.store.size).toBe(1)
  })

  it('removes a tag from the repo file with --project, and says which file holds a user tag it was not asked to take', () => {
    const files = { [USER]: json({ tags: { typo: TYPO } }), [PROJECT]: json({ threshold: 70, tags: { naming: { description: 'n', points: 5 } } }) }
    const removed = run(['remove', 'naming', '--project'], files)
    expect(removed.code).toBe(0)
    expect(removed.out).toEqual([`removed tag naming from ${PROJECT}`])
    expect(removed.store.get(PROJECT)).toBe(json({ threshold: 70 }))
    expect(removed.store.get(USER)).toBe(files[USER])
    const reverse = run(['remove', 'typo', '--project'], { [USER]: json({ tags: { typo: TYPO } }) })
    expect(reverse.code).toBe(1)
    expect(reverse.out).toEqual([`tag typo is not in ${PROJECT} - it is in ${USER}`])
    expect(reverse.store.size).toBe(1)
  })

  it('lists the tags of the repo that --repo names, not those of the current directory', () => {
    const r = run(['list', '--repo', '/other'], {
      [USER]: json({ tags: { typo: TYPO } }),
      [PROJECT]: json({ tags: { style: { description: 'here', points: 9 } } }),
      '/other/granny.config.json': json({ tags: { naming: { description: 'there', points: 10 } } }),
    })
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['typo  fix  user  a misspelled word', 'naming  +10  project  there', `user: ${USER}`, 'project: /other/granny.config.json'])
  })

  it('lists the tags of both files, marking a project tag and a project null that turns a user tag off', () => {
    const r = run(['list'], {
      [USER]: json({ tags: { typo: TYPO, naming: { description: 'a name', points: 20 } } }),
      [PROJECT]: json({ tags: { naming: { description: 'project naming', points: 30 }, typo: null } }),
    })
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['typo  off  project  a misspelled word', 'naming  +30  project  project naming', `user: ${USER}`, `project: ${PROJECT}`])
  })

  it('lists no tags, and names the project file as none outside a checkout', () => {
    expect(run(['list'], {}, null).out).toEqual(['no tags', `user: ${USER}`, 'project: none (not in a git checkout)'])
  })

  it('refuses a tag that would make the tags of both files more than 20, and writes nothing', () => {
    const tags = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${String(i + 1).padStart(2, '0')}`, TYPO]))
    const files = { [USER]: json({ tags }) }
    const r = run(['add', 'extra', '--fix', '--description', 'x'], files)
    expect(r.code).toBe(1)
    expect(r.out).toEqual(['tags: at most 20 tags (got 21)'])
    expect(r.store.get(USER)).toBe(files[USER])
  })

  it('keeps a name such as constructor an ordinary tag name, not a property of the object', () => {
    const added = run(['add', 'constructor', '--fix', '--description', 'x'])
    expect(added.out).toEqual([`added tag constructor (fix) to ${USER}`])
    expect(added.store.get(USER)).toBe(json({ tags: { constructor: { description: 'x', fix: true } } }))
    expect(run(['remove', 'toString']).out).toEqual([`tag toString is not in ${USER}`])
  })

  it('says when a file cannot be read or written, and writes nothing', () => {
    const unreadable = fake({}, TOP, {
      read: () => {
        throw new Error('EISDIR')
      },
    })
    expect(runTags(['add', 'typo', '--fix', '--description', 'x'], unreadable.io)).toBe(1)
    expect(unreadable.out).toEqual([`could not read ${USER}: EISDIR`])
    const unwritable = fake({}, TOP, {
      write: () => {
        throw new Error('EACCES')
      },
    })
    expect(runTags(['add', 'typo', '--fix', '--description', 'x'], unwritable.io)).toBe(1)
    expect(unwritable.out).toEqual([`could not write ${USER}: EACCES - nothing written`])
  })
})
