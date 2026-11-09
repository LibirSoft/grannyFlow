export const OPENCODE_AGENT = 'granny-reviewer'

const READ_ONLY_GIT = ['git diff*', 'git log*', 'git show*', 'git status*', 'git blame*', 'git rev-parse*', 'git merge-base*', 'git ls-files*']
const ABSOLUTE_PATH = /(?<=^|[\s,;(\[{"'`])\/[^\s,;)\]}"'`]*/g

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface OpencodeAnswer {
  text?: string
  error?: string
}

function errorText(error: unknown): string {
  if (!isObject(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : isObject(error.data) && typeof error.data.message === 'string' ? error.data.message : JSON.stringify(error)
  const kind = typeof error.type === 'string' ? error.type : typeof error.name === 'string' ? error.name : undefined
  return kind ? `${kind}: ${message}` : message
}

/** The answer in `opencode run --format json` output: its text parts in order, never a tool's output. */
export function opencodeAnswer(jsonl: string): OpencodeAnswer {
  const parts: string[] = []
  const errors: string[] = []
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      if (line.startsWith('Error:')) errors.push(line)
      continue
    }
    if (!isObject(event)) continue
    if (event.type === 'text' && isObject(event.part) && event.part.type === 'text' && typeof event.part.text === 'string') parts.push(event.part.text)
    else if (event.type === 'error') errors.push(errorText(event.error))
  }
  const text = parts.join('\n').trim()
  const error = [...new Set(errors)].join('; ')
  return { ...(text ? { text } : {}), ...(error ? { error } : {}) }
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

/** The directories of the absolute paths named in `text` and of `files` that lie outside `cwd`; never `/`. */
export function readableDirs(text: string, files: string[], cwd: string): string[] {
  const root = normalize(cwd)
  const dirs = [...(text.match(ABSOLUTE_PATH) ?? []).map(p => p.replace(/[.:]+$/, '')), ...files].map(p => {
    const path = normalize(p)
    return p.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/'))
  })
  return [...new Set(dirs)].filter(d => d && d !== '/' && d !== root && !d.startsWith(`${root}/`))
}

/** OPENCODE_CONFIG_CONTENT for the reviewer: an agent opencode itself keeps to reading and read-only git. */
export function opencodeAgentConfig(dirs: string[]): string {
  const permission = {
    '*': 'deny',
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
    bash: { '*': 'deny', ...Object.fromEntries(READ_ONLY_GIT.map(p => [p, 'allow'])), 'git * --output*': 'deny' },
    ...(dirs.length ? { external_directory: Object.fromEntries(dirs.map(d => [`${d}/*`, 'allow'])) } : {}),
  }
  return JSON.stringify({ agent: { [OPENCODE_AGENT]: { mode: 'primary', permission } } })
}
