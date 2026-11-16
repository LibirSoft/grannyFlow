import { tagErrors } from '../core/config'

type Obj = Record<string, unknown>
type Verb = 'add' | 'remove' | 'list'

export interface TagsIo {
  userPath: string
  read(path: string): string | undefined
  write(path: string, text: string): void
  print(line: string): void
  toplevel(dir?: string): string | undefined
}

interface Options {
  verb: Verb
  name: string
  description?: string
  points?: unknown
  fix: boolean
  replace: boolean
  project: boolean
  repo?: string
}

interface File {
  path: string
  object: Obj
  tags: Obj
}

interface Store {
  user: File
  project?: File
}

const USAGE = [
  'usage:',
  'node <skill-dir>/scripts/tags.mjs add <name> --description <text> (--points <1-100> | --fix) [--project] [--replace] [--repo <dir>]',
  'node <skill-dir>/scripts/tags.mjs remove <name> [--project] [--repo <dir>]',
  'node <skill-dir>/scripts/tags.mjs list [--repo <dir>]',
]
const NO_CHECKOUT = '--project needs a git checkout: run it in the repo or pass --repo <dir>'
const SWITCHES: Record<Verb, string[]> = { add: ['--fix', '--project', '--replace'], remove: ['--project'], list: [] }
const VALUED: Record<Verb, string[]> = { add: ['--description', '--points', '--repo'], remove: ['--repo'], list: ['--repo'] }

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPoints = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100
const hasOwn = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key)
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))
const serialize = (object: Obj) => `${JSON.stringify(object, null, 2)}\n`
const descriptionOf = (tag: unknown) => (isObject(tag) && typeof tag.description === 'string' ? tag.description : '')
const row = (name: string, effect: string, source: string, tag: unknown) => [name, effect, source, descriptionOf(tag)].join('  ').trimEnd()

const fail = (io: TagsIo, ...messages: string[]) => {
  for (const message of messages) io.print(message)
  return 1
}

function effectOf(tag: unknown): string {
  if (tag === null) return 'off'
  if (!isObject(tag)) return 'invalid'
  if (tag.fix === true && tag.points === undefined) return 'fix'
  if (tag.fix === undefined && isPoints(tag.points)) return `+${tag.points}`
  return 'invalid'
}

function parse(argv: string[]): Options | undefined {
  const [verb, ...rest] = argv
  if (verb !== 'add' && verb !== 'remove' && verb !== 'list') return undefined
  const switches = new Set<string>()
  const values = new Map<string, string>()
  const names: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) {
      if (arg === '' || arg.startsWith('-')) return undefined
      names.push(arg)
    } else if (SWITCHES[verb].includes(arg) && !switches.has(arg)) {
      switches.add(arg)
    } else if (VALUED[verb].includes(arg) && !values.has(arg)) {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--') || (arg === '--repo' && value === '')) return undefined
      values.set(arg, value)
    } else {
      return undefined
    }
  }
  if (names.length !== (verb === 'list' ? 0 : 1)) return undefined
  const description = values.get('--description')
  const points = values.get('--points')
  const repo = values.get('--repo')
  return {
    verb,
    name: names[0] ?? '',
    ...(description === undefined ? {} : { description: description.trim() }),
    ...(points === undefined ? {} : { points: /^\d+$/.test(points) ? Number(points) : points }),
    fix: switches.has('--fix'),
    replace: switches.has('--replace'),
    project: switches.has('--project'),
    ...(repo === undefined ? {} : { repo }),
  }
}

function readFile(io: TagsIo, path: string): File | string {
  let text: string | undefined
  try {
    text = io.read(path)
  } catch (e) {
    return `could not read ${path}: ${reason(e)}`
  }
  if (text === undefined) return { path, object: {}, tags: {} }
  let object: unknown
  try {
    object = JSON.parse(text)
  } catch (e) {
    return `${path}: invalid JSON (${reason(e)}) - nothing written`
  }
  if (!isObject(object)) return `${path}: not a JSON object - nothing written`
  const tags = object.tags === undefined ? {} : object.tags
  if (!isObject(tags)) return `${path}: tags must be an object keyed by tag name - nothing written`
  return { path, object, tags }
}

function readStore(io: TagsIo, top: string | undefined): Store | string {
  const user = readFile(io, io.userPath)
  if (typeof user === 'string') return user
  if (top === undefined) return { user }
  const project = readFile(io, `${top}/granny.config.json`)
  return typeof project === 'string' ? project : { user, project }
}

function merged(...layers: Array<Obj | undefined>): Obj {
  const tags = new Map<string, unknown>()
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const [name, value] of Object.entries(layer)) {
      if (value === null) tags.delete(name)
      else tags.set(name, value)
    }
  }
  return Object.fromEntries(tags)
}

const checkAfter = (store: Store, project: boolean, tags: Obj) =>
  tagErrors(project ? merged(store.user.tags, tags) : merged(tags, store.project?.tags))

function save(io: TagsIo, path: string, object: Obj): string | undefined {
  try {
    io.write(path, serialize(object))
    return undefined
  } catch (e) {
    return `could not write ${path}: ${reason(e)} - nothing written`
  }
}

function add(io: TagsIo, o: Options, store: Store, target: File): number {
  const existed = hasOwn(target.tags, o.name)
  if (existed && !o.replace) {
    return fail(io, `tag ${o.name} is already in ${target.path} (${effectOf(target.tags[o.name])}) - pass --replace to change it`)
  }
  const tag: Obj = {}
  if (o.description !== undefined) tag.description = o.description
  if (o.points !== undefined) tag.points = o.points
  if (o.fix) tag.fix = true
  const tags = new Map(Object.entries(target.tags))
  tags.set(o.name, tag)
  const next = Object.fromEntries(tags)
  const errors = checkAfter(store, o.project, next)
  if (errors.length) return fail(io, ...errors)
  const error = save(io, target.path, { ...target.object, tags: next })
  if (error !== undefined) return fail(io, error)
  io.print(existed ? `replaced tag ${o.name} (${effectOf(tag)}) in ${target.path}` : `added tag ${o.name} (${effectOf(tag)}) to ${target.path}`)
  return 0
}

function remove(io: TagsIo, o: Options, store: Store, target: File, other: File | undefined): number {
  if (!hasOwn(target.tags, o.name)) {
    const elsewhere = other !== undefined && hasOwn(other.tags, o.name) ? ` - it is in ${other.path}` : ''
    return fail(io, `tag ${o.name} is not in ${target.path}${elsewhere}`)
  }
  const tags = new Map(Object.entries(target.tags))
  tags.delete(o.name)
  const next = Object.fromEntries(tags)
  const errors = checkAfter(store, o.project, next)
  if (errors.length) return fail(io, ...errors)
  const object: Obj = { ...target.object }
  if (tags.size) object.tags = next
  else delete object.tags
  const error = save(io, target.path, object)
  if (error !== undefined) return fail(io, error)
  io.print(`removed tag ${o.name} from ${target.path}`)
  return 0
}

function list(io: TagsIo, store: Store): number {
  const user = store.user.tags
  const project: Obj = store.project?.tags ?? {}
  const rows: string[] = []
  for (const name of Object.keys(user)) {
    if (hasOwn(project, name)) rows.push(row(name, effectOf(project[name]), 'project', project[name] === null ? user[name] : project[name]))
    else rows.push(row(name, effectOf(user[name]), 'user', user[name]))
  }
  for (const name of Object.keys(project)) {
    if (!hasOwn(user, name) && project[name] !== null) rows.push(row(name, effectOf(project[name]), 'project', project[name]))
  }
  for (const line of rows.length ? rows : ['no tags']) io.print(line)
  io.print(`user: ${store.user.path}`)
  io.print(store.project === undefined ? 'project: none (not in a git checkout)' : `project: ${store.project.path}`)
  return 0
}

export function runTags(argv: string[], io: TagsIo): number {
  const options = parse(argv)
  if (options === undefined) return fail(io, ...USAGE)
  const store = readStore(io, io.toplevel(options.repo))
  if (typeof store === 'string') return fail(io, store)
  if (options.verb === 'list') return list(io, store)
  const target = options.project ? store.project : store.user
  if (target === undefined) return fail(io, NO_CHECKOUT)
  const other = options.project ? store.user : store.project
  return options.verb === 'add' ? add(io, options, store, target) : remove(io, options, store, target, other)
}
