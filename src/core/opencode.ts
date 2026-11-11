import { parseCodexReview, saysNoFindings } from './review'

export const OPENCODE_AGENT = 'granny-reviewer'

const READ_ONLY_GIT = ['git diff*', 'git log*', 'git show*', 'git status*', 'git blame*', 'git rev-parse*', 'git merge-base*', 'git ls-files*']
// opencode v2.2.6 matches each simple command's whole text, redirect words included, after turning `\` into `/`;
// git reads any path outside the repo it is given (no-index mode), which external_directory does not cover.
const REDIRECT = ['*>*', '*<*']
const OUTSIDE_PATH = ['*--no-index*', '* /*', "*'/*", '*"/*', '*=/*', '* ~*', "*'~*", '*"~*', '*=~*', '*../*', '* ..', '* .. *', "*'..*", '*"..*', '*$*', '*`*', '*{*', '*.?/*', '*.[*', '* -?/*', '*\t*']
const ABSOLUTE_PATH = /(?<=^|[\s,;(\[{"'`])\/[^\s,;)\]}"'`]*/g

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface OpencodeAnswer {
  text?: string
  error?: string
  /** Lines that start like an event but are not valid JSON, so whatever they held is missing from the answer. */
  dropped?: number
}

function errorText(error: unknown): string {
  if (!isObject(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : isObject(error.data) && typeof error.data.message === 'string' ? error.data.message : JSON.stringify(error)
  const kind = typeof error.type === 'string' ? error.type : typeof error.name === 'string' ? error.name : undefined
  return kind ? `${kind}: ${message}` : message
}

/** The answer in `opencode run --format json` output: the text parts after the last tool call or step start, or every text part when those hold no finding and are not the no-findings sentence; never a tool's output. */
export function opencodeAnswer(jsonl: string): OpencodeAnswer {
  const all: string[] = []
  let parts: string[] = []
  let boundary = false
  const errors: string[] = []
  let dropped = 0
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      if (line.startsWith('Error:')) errors.push(line)
      else if (line.startsWith('{')) dropped++
      continue
    }
    if (!isObject(event)) continue
    if (event.type === 'text' && isObject(event.part) && event.part.type === 'text' && typeof event.part.text === 'string') {
      if (boundary && event.part.text.trim()) [parts, boundary] = [[], false]
      parts.push(event.part.text)
      all.push(event.part.text)
    } else if (event.type === 'tool_use' || event.type === 'step_start') boundary = true
    else if (event.type === 'error') errors.push(errorText(event.error))
  }
  const last = parts.join('\n').trim()
  const text = parseCodexReview(last).markers || saysNoFindings(last) ? last : all.join('\n').trim()
  const error = [...new Set(errors)].join('; ')
  return { ...(text ? { text } : {}), ...(error ? { error } : {}), ...(dropped ? { dropped } : {}) }
}

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const HOME = /^\/(?:root|(?:home|Users|var\/home)\/[^/]+)(?:\/\.[^/]+)?$/

const tooWide = (dir: string) => dir.split('/').length < 3 || HOME.test(dir)

const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))

/** The directories of `files` and of the absolute paths named in `text` (a path ending in `/` is the directory itself, one whose last part has no `.` names nothing) that lie outside `cwd` and above it; never a top-level directory, a home directory or a dot directory right under one. */
export function readableDirs(text: string, files: string[], cwd: string): string[] {
  const root = normalize(cwd)
  const named = (text.match(ABSOLUTE_PATH) ?? []).map(p => p.replace(/[.:]+$/, '')).flatMap(p => {
    const path = normalize(p)
    if (p.endsWith('/')) return [path]
    return path.slice(path.lastIndexOf('/') + 1).includes('.') ? [parent(path)] : []
  })
  const dirs = [...named, ...files.map(f => parent(normalize(f)))]
  return [...new Set(dirs)].filter(d => !tooWide(d) && d !== root && !d.startsWith(`${root}/`) && !root.startsWith(`${d}/`))
}

/** OPENCODE_CONFIG_CONTENT for the reviewer: an agent opencode itself keeps to reading and read-only git. */
export function opencodeAgentConfig(dirs: string[]): string {
  const permission = {
    '*': 'deny',
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
    bash: { '*': 'deny', ...Object.fromEntries(READ_ONLY_GIT.map(p => [p, 'allow'])), ...Object.fromEntries(['git * --output*', ...REDIRECT, ...OUTSIDE_PATH].map(p => [p, 'deny'])) },
    ...(dirs.length ? { external_directory: Object.fromEntries(dirs.map(d => [`${d}/*`, 'allow'])) } : {}),
  }
  return JSON.stringify({ agent: { [OPENCODE_AGENT]: { mode: 'primary', permission } } })
}
