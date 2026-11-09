/** New-side line ranges, inclusive, of each file a unified diff changes. */
export type Hunks = Map<string, Array<[number, number]>>

/** A new-side line inside a hunk: added, or context with its old-side number. */
export type HunkLine = { kind: 'added' } | { kind: 'context'; oldLine: number }

export interface FileDiff {
  /** The diff's `a/` path: the file's path before a rename, its own path when it is new. */
  oldPath: string
  ranges: Array<[number, number]>
  lines: Map<number, HunkLine>
}

/** Each file a unified diff changes, keyed by its new path. */
export type DiffFiles = Map<string, FileDiff>

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  return path.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => ({ t: '\t', n: '\n' })[c] ?? c)
}

function headerPath(line: string, prefix: 'a/' | 'b/'): string | undefined {
  const path = unquote(line.slice(4).replace(/\t.*$/, ''))
  if (path === '/dev/null') return undefined
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

interface Walk {
  file: FileDiff
  oldLine: number
  oldLeft: number
  newLine: number
  newEnd: number
}

export function parseDiff(diff: string): DiffFiles {
  const files: DiffFiles = new Map()
  let oldPath: string | undefined
  let file: FileDiff | undefined
  let header = false
  let walk: Walk | undefined
  // A hunk whose body the diff cuts short still covers its header's range: the rest reads as context.
  const finish = () => {
    while (walk && walk.newLine <= walk.newEnd) walk.file.lines.set(walk.newLine++, { kind: 'context', oldLine: walk.oldLine++ })
    walk = undefined
  }
  for (const line of diff.split('\n')) {
    if (walk && (walk.newLine <= walk.newEnd || walk.oldLeft > 0)) {
      const mark = line[0]
      const newLeft = walk.newLine <= walk.newEnd
      if (mark === '+' && newLeft) {
        walk.file.lines.set(walk.newLine++, { kind: 'added' })
        continue
      }
      if (mark === '-' && walk.oldLeft > 0) {
        walk.oldLine++
        walk.oldLeft--
        continue
      }
      if (mark === ' ' && newLeft) {
        walk.file.lines.set(walk.newLine++, { kind: 'context', oldLine: walk.oldLine++ })
        walk.oldLeft--
        continue
      }
      if (mark === '\\') continue
    }
    if (line.startsWith('diff --git ')) {
      finish()
      oldPath = undefined
      file = undefined
      header = true
    } else if (header && line.startsWith('--- ')) oldPath = headerPath(line, 'a/')
    else if (header && line.startsWith('+++ ')) {
      const path = headerPath(line, 'b/')
      if (path === undefined) file = undefined
      else {
        file = files.get(path) ?? { oldPath: oldPath ?? path, ranges: [], lines: new Map() }
        files.set(path, file)
      }
    } else if (line.startsWith('@@')) {
      finish()
      header = false
      const m = HUNK.exec(line)
      if (!m || file === undefined) continue
      const start = Number(m[3])
      const count = m[4] === undefined ? 1 : Number(m[4])
      if (count) file.ranges.push([start, start + count - 1])
      walk = { file, oldLine: Number(m[1]), oldLeft: m[2] === undefined ? 1 : Number(m[2]), newLine: start, newEnd: start + count - 1 }
    }
  }
  finish()
  return files
}

export function parseHunks(diff: string): Hunks {
  return new Map([...parseDiff(diff)].filter(([, f]) => f.ranges.length).map(([path, f]) => [path, f.ranges]))
}

export const onChangedLine = (hunks: Hunks, file: string, line: number | undefined) =>
  line !== undefined && (hunks.get(file) ?? []).some(([from, to]) => line >= from && line <= to)

/** Where a new-side line sits in the diff, or undefined when no hunk holds it. */
export function diffLine(files: DiffFiles, path: string, line: number | undefined): ({ oldPath: string } & HunkLine) | undefined {
  const file = files.get(path)
  const at = line === undefined ? undefined : file?.lines.get(line)
  return file && at ? { oldPath: file.oldPath, ...at } : undefined
}
