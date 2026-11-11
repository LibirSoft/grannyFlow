import { parseCodexReview, saysNoFindings } from './review'

export const OPENCODE_AGENT = 'granny-reviewer'

const READ_ONLY_GIT = ['git diff*', 'git log*', 'git show*', 'git status*', 'git blame*', 'git rev-parse*', 'git merge-base*', 'git ls-files*']
// opencode v2.2.6 matches each simple command's whole text, redirect words included, after turning `\` into `/`;
// git reads any path outside the repo it is given (no-index mode), which external_directory does not cover.
const REDIRECT = ['*>*', '*<*']
const OUTSIDE_PATH = ['*--no-index*', '* /*', "*'/*", '*"/*', '*=/*', '* ~*', "*'~*", '*"~*', '*=~*', '*../*', '* ..', '* .. *', "*'..*", '*"..*', '*$*', '*`*', '*{*', '*.?/*', '*.[*', '* -?/*', '*\t*']
const ABSOLUTE_PATH = /(?<=^|[\s,;(\[{"'`])\/[^\s,;)\]}"'`]*/g

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

const FRAME = '[granny] opencode: '

/**
 * POSIX awk, run under LC_ALL=C, that turns `opencode run --format json` output into lines a reader can relay as plain text:
 * a text part becomes `<FRAME>text <its non-blank line count>` and its decoded text, a tool call or step start `<FRAME>step`,
 * an error event `<FRAME>error <event>`, a text event it cannot decode `<FRAME>dropped`; every other event goes, other lines stay.
 */
export const OPENCODE_DECODE = [
  String.raw`function hex(s, i, n) { n = 0; for (i = 1; i <= 4; i++) n = n * 16 + index("0123456789abcdef", tolower(substr(s, i, 1))) - 1; return n }`,
  String.raw`function utf8(c) { if (c < 128) return sprintf("%c", c); if (c < 2048) return sprintf("%c%c", 192 + int(c / 64), 128 + c % 64); if (c < 65536) return sprintf("%c%c%c", 224 + int(c / 4096), 128 + int(c / 64) % 64, 128 + c % 64); return sprintf("%c%c%c%c", 240 + int(c / 262144), 128 + int(c / 4096) % 64, 128 + int(c / 64) % 64, 128 + c % 64) }`,
  String.raw`function jstr(s, i, out, r, p, c, h, lo) { out = ""; i++; while (1) { r = substr(s, i); p = match(r, /[\\"]/); if (!p) { BAD = 1; return "" } out = out substr(r, 1, p - 1); i += p; if (substr(r, p, 1) == "\"") { J = i; return out } c = substr(s, i, 1); i++; if (c == "n") out = out "\n"; else if (c == "t") out = out "\t"; else if (c == "r") out = out "\r"; else if (c == "b") out = out "\b"; else if (c == "f") out = out "\f"; else if (c == "u") { h = hex(substr(s, i, 4)); i += 4; if (h >= 55296 && h < 56320 && substr(s, i, 2) == "\\u") { lo = hex(substr(s, i + 2, 4)); if (lo >= 56320 && lo < 57344) { h = 65536 + (h - 55296) * 1024 + lo - 56320; i += 6 } } out = out utf8(h) } else out = out c } }`,
  String.raw`function text(s, i, k, v) { i = 1; while ((k = index(substr(s, i), "\"")) > 0) { v = jstr(s, i + k - 1); if (BAD) return ""; i = J; if (v == "text" && substr(s, i, 2) == ":\"") { v = jstr(s, i + 1); if (!BAD) FOUND = 1; return v } } return "" }`,
  String.raw`/^\{"type":"text"/ { x = $0; if (gsub(/"type":"text"/, "", x) < 2) next; BAD = 0; FOUND = 0; t = text($0); if (!FOUND) { print "${FRAME}dropped"; next } n = split(t, L, "\n"); c = 0; for (i = 1; i <= n; i++) if (L[i] ~ /[^ \t\r]/) c++; print "${FRAME}text " c; print t; next }`,
  String.raw`/^\{"type":"(tool_use|step_start)"/ { print "${FRAME}step"; next }`,
  String.raw`/^\{"type":"error"/ { print "${FRAME}error " $0; next }`,
  String.raw`/^\{/ { next }`,
  String.raw`{ print }`,
].join('; ')

const COUNTED = /[^ \t\r]/

/** The frame the review script prints when the decoder itself fails, before what it says about it. */
export const DECODER_FAILED = `${FRAME}decoder failed `

const FRAME_LINE = /^\[granny\] opencode: (?:text (\d+)|(step)|error (.*)|(dropped)|(decoder failed .*))$/

export interface OpencodeAnswer {
  text?: string
  error?: string
  /** Text parts that did not come back whole - an event line that is not valid JSON, a decoded part short of its lines, or one the script could not decode. */
  dropped?: number
}

function errorText(error: unknown): string {
  if (!isObject(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : isObject(error.data) && typeof error.data.message === 'string' ? error.data.message : JSON.stringify(error)
  const kind = typeof error.type === 'string' ? error.type : typeof error.name === 'string' ? error.name : undefined
  return kind ? `${kind}: ${message}` : message
}

function errorEvent(line: string): string {
  try {
    const event: unknown = JSON.parse(line)
    if (isObject(event) && 'error' in event) return errorText(event.error)
  } catch {}
  return line
}

/**
 * The answer in what the review script prints (OPENCODE_DECODE's lines) or in raw `opencode run --format json` output: the text parts
 * after the last tool call or step start, or every text part when those hold no finding and are not the no-findings sentence; never a tool's output.
 */
export function opencodeAnswer(output: string): OpencodeAnswer {
  const all: string[] = []
  let parts: string[] = []
  let boundary = false
  const errors: string[] = []
  let dropped = 0
  let open: { lines: string[]; want: number; got: number } | undefined
  const add = (text: string) => {
    if (boundary && text.trim()) [parts, boundary] = [[], false]
    parts.push(text)
    all.push(text)
  }
  const close = () => {
    if (!open) return
    if (open.got < open.want) dropped++
    add(open.lines.join('\n'))
    open = undefined
  }
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (open && open.got < open.want) {
      open.lines.push(raw)
      if (COUNTED.test(raw)) open.got++
      continue
    }
    const frame = FRAME_LINE.exec(line)
    if (frame) {
      close()
      if (frame[1] !== undefined) open = { lines: [], want: Number(frame[1]), got: 0 }
      else if (frame[2]) boundary = true
      else if (frame[3] !== undefined) errors.push(errorEvent(frame[3]))
      else if (frame[5] !== undefined) errors.push(frame[5])
      else dropped++
      continue
    }
    if (open && !COUNTED.test(raw)) {
      open.lines.push(raw)
      continue
    }
    close()
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
    if (event.type === 'text' && isObject(event.part) && event.part.type === 'text' && typeof event.part.text === 'string') add(event.part.text)
    else if (event.type === 'tool_use' || event.type === 'step_start') boundary = true
    else if (event.type === 'error') errors.push(errorText(event.error))
  }
  close()
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

export interface ReadGrant {
  dirs: string[]
  /** The paths given whose directory is too wide or holds the worktree, so the reviewer cannot read them. */
  refused: string[]
}

/**
 * The directories of `files`, of the absolute paths named in `text` (a path ending in `/` is the directory itself, one whose last part has no `.` names nothing)
 * and the directories in `dirs` themselves, that lie outside `cwd`; never a top-level directory, a home directory, a dot directory right under one or a directory above `cwd`.
 */
export function readGrant(text: string, files: string[], cwd: string, dirs: string[] = []): ReadGrant {
  const root = normalize(cwd)
  const named = (text.match(ABSOLUTE_PATH) ?? []).map(p => p.replace(/[.:]+$/, '')).flatMap(p => {
    const path = normalize(p)
    if (path === '/') return []
    if (p.endsWith('/')) return [{ path: p, dir: path }]
    return path.slice(path.lastIndexOf('/') + 1).includes('.') ? [{ path: p, dir: parent(path) }] : []
  })
  const asked = [...named, ...files.map(f => ({ path: f, dir: parent(normalize(f)) })), ...dirs.map(d => ({ path: d, dir: normalize(d) }))]
  const outside = asked.filter(a => a.dir !== root && !a.dir.startsWith(`${root}/`))
  const refuse = (dir: string) => tooWide(dir) || root.startsWith(`${dir}/`)
  return {
    dirs: [...new Set(outside.filter(a => !refuse(a.dir)).map(a => a.dir))],
    refused: [...new Set(outside.filter(a => refuse(a.dir)).map(a => a.path))],
  }
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
