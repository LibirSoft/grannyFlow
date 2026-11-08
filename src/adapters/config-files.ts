import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function globalConfigPath(): string {
  if (process.env.GRANNY_CONFIG) return process.env.GRANNY_CONFIG
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'granny', 'config.json')
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${(e as Error).message})`)
  }
}
