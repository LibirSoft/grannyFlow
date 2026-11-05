import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** `<Name>.jsonl` files one directory level under a role's session directory, by name. */
export function subagentFiles(session: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (const dir of readdirSync(session, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      try {
        for (const file of readdirSync(join(session, dir.name), { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith('.jsonl')) out.set(file.name.slice(0, -'.jsonl'.length), join(session, dir.name, file.name))
        }
      } catch {}
    }
  } catch {}
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}
