/** New-side line ranges, inclusive, of each file a unified diff changes. */
export type Hunks = Map<string, Array<[number, number]>>

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  return path.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => ({ t: '\t', n: '\n' })[c] ?? c)
}

const newPath = (line: string) => {
  const path = unquote(line.slice(4).replace(/\t.*$/, ''))
  return path === '/dev/null' ? undefined : path.replace(/^b\//, '')
}

export function parseHunks(diff: string): Hunks {
  const hunks: Hunks = new Map()
  let file: string | undefined
  let header = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined
      header = true
    } else if (header && line.startsWith('+++ ')) file = newPath(line)
    else if (line.startsWith('@@')) {
      header = false
      const m = HUNK.exec(line)
      if (!m || file === undefined) continue
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      if (!count) continue
      const ranges = hunks.get(file) ?? []
      ranges.push([start, start + count - 1])
      hunks.set(file, ranges)
    }
  }
  return hunks
}

export const onChangedLine = (hunks: Hunks, file: string, line: number | undefined) =>
  line !== undefined && (hunks.get(file) ?? []).some(([from, to]) => line >= from && line <= to)
