import type { HostName } from './types'

export type ModelSpec = string | Partial<Record<HostName, string>>

export interface RoleConfig {
  model?: ModelSpec
  effort?: string
}

export type ConfigRole = 'granny' | 'implementer' | 'judge'
export type ReviewerEngine = 'auto' | 'codex' | 'codex-plugin' | 'agent' | 'command'
export type ReviewMode = 'review' | 'adversarial-review'

export interface ReviewerConfig extends RoleConfig {
  name: string
  engine: ReviewerEngine
  mode?: ReviewMode
  focus?: string
  command?: string
}

export interface GrannyConfig {
  roles: Record<ConfigRole, RoleConfig>
  reviewers: ReviewerConfig[]
  threshold: number
  maxRounds: number
  base: string
  gates: string[] | 'auto'
  workDir: string
  worktree: boolean
  worktreeDir?: string
  language: string
  aiAttribution: boolean
  rules: string[]
}

export const DEFAULT_CONFIG: GrannyConfig = {
  roles: {
    granny: {},
    implementer: {},
    judge: { model: { 'claude-code': 'sonnet' } },
  },
  reviewers: [{ name: 'codex', engine: 'auto' }],
  threshold: 70,
  maxRounds: 4,
  base: 'main',
  gates: 'auto',
  workDir: '.granny',
  worktree: true,
  language: 'English',
  aiAttribution: false,
  rules: [
    'Every behaviour change gets a test that fails without the change - write the red half first.',
    'Code comments: default none; add one only when the reason cannot be recovered from the code.',
  ],
}

const ROLES: ConfigRole[] = ['granny', 'implementer', 'judge']
const TOP_KEYS = new Set(['$schema', 'roles', 'worktreeDir', ...Object.keys(DEFAULT_CONFIG).filter(k => k !== 'roles')])
const ROLE_KEYS = new Set(['model', 'effort'])
const REVIEWER_KEYS = new Set(['name', 'engine', 'model', 'effort', 'mode', 'focus', 'command'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const ENGINES: ReviewerEngine[] = ['auto', 'codex', 'codex-plugin', 'agent', 'command']
const PLUGIN_ENGINES: ReviewerEngine[] = ['auto', 'codex-plugin']
const MODES: ReviewMode[] = ['review', 'adversarial-review']
const NAME = /^[a-z0-9-]+$/

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function resolveConfig(layers: unknown[], host?: HostName): GrannyConfig {
  const config: GrannyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const errors: string[] = []

  layers.forEach((layer, index) => {
    if (layer === undefined || layer === null) return
    const where = `config layer ${index + 1}`
    if (!isObject(layer)) {
      errors.push(`${where}: must be an object`)
      return
    }
    for (const key of Object.keys(layer)) {
      if (!TOP_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`)
    }
    if (layer.roles !== undefined) {
      if (!isObject(layer.roles)) errors.push(`${where}: roles must be an object`)
      else {
        for (const [role, value] of Object.entries(layer.roles)) {
          if (role === 'reviewer') {
            errors.push(
              `${where}: roles.reviewer was replaced by "reviewers": [{ "name": "codex", ...the same keys }] - a list of reviewers that run in parallel; a custom command needs "engine": "command"`,
            )
            continue
          }
          if (!ROLES.includes(role as ConfigRole)) {
            errors.push(`${where}: unknown role "${role}" (expected ${ROLES.join(', ')})`)
            continue
          }
          if (!isObject(value)) {
            errors.push(`${where}: roles.${role} must be an object`)
            continue
          }
          for (const k of Object.keys(value)) {
            if (!ROLE_KEYS.has(k)) errors.push(`${where}: unknown key "roles.${role}.${k}"`)
          }
          const target = config.roles[role as ConfigRole] as Record<string, unknown>
          for (const [k, v] of Object.entries(value)) {
            if (v === null) delete target[k]
            else target[k] = v
          }
        }
      }
    }
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'roles' || key === '$schema' || value === undefined || !TOP_KEYS.has(key)) continue
      ;(config as unknown as Record<string, unknown>)[key] = value
    }
  })

  config.reviewers = reviewers(config.reviewers, errors, host)
  errors.push(...validate(config))
  if (errors.length) throw new Error(`Invalid granny config:\n- ${errors.join('\n- ')}`)
  return config
}

function modelErrors(path: string, spec: unknown): string[] {
  if (spec === undefined) return []
  if (typeof spec !== 'string' && !isObject(spec)) return [`${path} must be a string or an object keyed by host`]
  if (typeof spec === 'string') return []
  const errors: string[] = []
  for (const [host, m] of Object.entries(spec)) {
    if (host !== 'claude-code' && host !== 'opencode') errors.push(`${path}: unknown host "${host}"`)
    if (typeof m !== 'string' || !m) errors.push(`${path}.${host} must be a non-empty string`)
  }
  return errors
}

const effortErrors = (path: string, effort: unknown): string[] =>
  effort !== undefined && !EFFORTS.has(effort as string) ? [`${path} must be one of ${[...EFFORTS].join(', ')}`] : []

function reviewers(list: unknown, errors: string[], host?: HostName): ReviewerConfig[] {
  if (!Array.isArray(list) || !list.length) {
    errors.push('reviewers must be a non-empty array of reviewer objects')
    return []
  }
  const named = new Map<string, number>()
  return list.map((entry, i): ReviewerConfig => {
    const at = `reviewers[${i}]`
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`)
      return { name: `reviewer-${i + 1}`, engine: 'auto' }
    }
    for (const k of Object.keys(entry)) {
      if (!REVIEWER_KEYS.has(k)) errors.push(`unknown key "${at}.${k}"`)
    }
    const engine: ReviewerEngine = entry.engine ?? 'auto'
    if (!ENGINES.includes(engine)) errors.push(`${at}.engine must be one of ${ENGINES.map(e => `"${e}"`).join(', ')}`)
    const name: string = entry.name ?? `${engine}-${i + 1}`
    if (typeof name !== 'string' || !NAME.test(name)) errors.push(`${at}.name must be a non-empty string of a-z, 0-9 and -`)
    else if (named.has(name)) errors.push(`${at}.name "${name}" is already used by reviewers[${named.get(name)}]`)
    else named.set(name, i)

    errors.push(...modelErrors(`${at}.model`, entry.model), ...effortErrors(`${at}.effort`, entry.effort))
    const adversarial = entry.mode === 'adversarial-review'
    if (entry.mode !== undefined && !MODES.includes(entry.mode)) errors.push(`${at}.mode must be "review" or "adversarial-review"`)
    else if (entry.mode !== undefined && !PLUGIN_ENGINES.includes(engine)) {
      errors.push(`${at}.mode needs the Codex plugin; engine "${engine}" cannot run it - use "codex-plugin" or "auto"`)
    }
    if (entry.focus !== undefined && (typeof entry.focus !== 'string' || !entry.focus.trim())) errors.push(`${at}.focus must be a non-empty string`)
    else if (entry.focus !== undefined && !adversarial) {
      errors.push(`${at}.focus only works with mode "adversarial-review"; the plain review takes no focus text`)
    }
    if (engine === 'command') {
      if (entry.command === undefined) errors.push(`${at}.command is required for engine "command"`)
      else if (typeof entry.command !== 'string' || !/\{(base|prompt)\}/.test(entry.command)) {
        errors.push(`${at}.command must be a string containing {base} or {prompt}`)
      }
    } else if (entry.command !== undefined) {
      errors.push(`${at}.command needs "engine": "command"; engine "${engine}" runs its own reviewer`)
    }
    if (host === 'opencode' && adversarial && engine === 'auto') {
      errors.push(`${at}.mode "adversarial-review" needs the Codex plugin, and on opencode engine "auto" means the Codex CLI - set ${at}.engine to "codex-plugin"`)
    }
    return { ...entry, name, engine }
  })
}

function validate(c: GrannyConfig): string[] {
  const errors: string[] = []
  if (typeof c.threshold !== 'number' || !(c.threshold >= 0 && c.threshold <= 100)) {
    errors.push('threshold must be a number between 0 and 100')
  }
  if (!Number.isInteger(c.maxRounds) || c.maxRounds < 1) errors.push('maxRounds must be an integer >= 1')
  if (typeof c.base !== 'string' || !c.base) errors.push('base must be a non-empty string')
  if (c.gates !== 'auto' && !(Array.isArray(c.gates) && c.gates.every(g => typeof g === 'string' && g.trim()))) {
    errors.push('gates must be "auto" or an array of non-empty command strings')
  }
  if (typeof c.workDir !== 'string' || !c.workDir || c.workDir.startsWith('/') || c.workDir.includes('..')) {
    errors.push('workDir must be a relative path inside the repo')
  }
  if (typeof c.language !== 'string' || !c.language) errors.push('language must be a non-empty string')
  if (typeof c.worktree !== 'boolean') errors.push('worktree must be a boolean')
  if (c.worktreeDir !== undefined) {
    if (typeof c.worktreeDir !== 'string' || !c.worktreeDir.trim()) errors.push('worktreeDir must be a non-empty path')
    else if (c.worktreeDir.startsWith('~')) errors.push('worktreeDir is not expanded by a shell - write the absolute path instead of ~')
  }
  if (typeof c.aiAttribution !== 'boolean') errors.push('aiAttribution must be a boolean')
  if (!Array.isArray(c.rules) || !c.rules.every(r => typeof r === 'string')) errors.push('rules must be an array of strings')

  for (const role of ROLES) {
    errors.push(...modelErrors(`roles.${role}.model`, c.roles[role].model), ...effortErrors(`roles.${role}.effort`, c.roles[role].effort))
  }
  return errors
}

export function resolveModel(spec: ModelSpec | undefined, host: HostName): string | undefined {
  if (spec === undefined) return undefined
  if (typeof spec === 'string') return spec
  return spec[host]
}
