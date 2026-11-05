import { HOSTS, IMPACTS, type HostName, type Impact } from './types'

export type ModelSpec = string | Partial<Record<HostName, string>>

export interface RoleConfig {
  model?: ModelSpec
  effort?: string
}

export type ConfigRole = 'granny' | 'helper' | 'planner' | 'implementer' | 'judge'
export type ReviewerEngine = 'auto' | 'codex' | 'codex-plugin' | 'agent' | 'command'
export type ReviewMode = 'review' | 'adversarial-review'
export type WatchMode = 'full' | 'panel' | 'off'

export interface ReviewerConfig extends RoleConfig {
  name: string
  engine: ReviewerEngine
  mode?: ReviewMode
  focus?: string
  command?: string
}

export interface CheckMetric {
  pattern: string
  min?: number
  max?: number
}

export interface CheckConfig {
  name: string
  run: string
  maxRepairs?: number
  timeout?: number
  metric?: CheckMetric
}

export interface GrannyConfig {
  roles: Record<ConfigRole, RoleConfig>
  reviewers: ReviewerConfig[]
  threshold: number
  alwaysFix: Impact[]
  maxRounds: number
  base: string
  gates: string[] | 'auto'
  workDir: string
  worktree: boolean
  worktreeDir?: string
  planReview: boolean
  finalReview: boolean
  parallel: boolean
  maxParallel: number
  language: string
  aiAttribution: boolean
  rules: string[]
  checks: CheckConfig[]
  maxRepairs: number
  readOnlyAgent: boolean
  watch: WatchMode
}

export const DEFAULT_CONFIG: GrannyConfig = {
  roles: {
    granny: {},
    helper: { model: { 'claude-code': 'haiku' }, effort: 'low' },
    planner: {},
    implementer: {},
    judge: { model: { 'claude-code': 'haiku' } },
  },
  reviewers: [{ name: 'reviewer', engine: 'agent' }],
  threshold: 70,
  alwaysFix: ['critical', 'major'],
  maxRounds: 4,
  base: 'main',
  gates: 'auto',
  workDir: '.granny',
  worktree: true,
  planReview: false,
  finalReview: true,
  parallel: true,
  maxParallel: 3,
  language: 'English',
  aiAttribution: false,
  rules: [
    'Every behaviour change gets a test that fails without the change - write the red half first.',
    'Code comments: default none; add one only when the reason cannot be recovered from the code.',
  ],
  checks: [],
  maxRepairs: 2,
  readOnlyAgent: false,
  watch: 'full',
}

const ROLES: ConfigRole[] = ['granny', 'helper', 'planner', 'implementer', 'judge']
const TOP_KEYS = new Set(['$schema', 'roles', 'worktreeDir', ...Object.keys(DEFAULT_CONFIG).filter(k => k !== 'roles')])
const ROLE_KEYS = new Set(['model', 'effort'])
const REVIEWER_KEYS = new Set(['name', 'engine', 'model', 'effort', 'mode', 'focus', 'command'])
const CHECK_KEYS = new Set(['name', 'run', 'maxRepairs', 'timeout', 'metric'])
const METRIC_KEYS = new Set(['pattern', 'min', 'max'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const ENGINES: ReviewerEngine[] = ['auto', 'codex', 'codex-plugin', 'agent', 'command']
const PLUGIN_ENGINES: ReviewerEngine[] = ['auto', 'codex-plugin']
const CODEX_ENGINES: ReviewerEngine[] = ['auto', 'codex', 'codex-plugin']
const MODES: ReviewMode[] = ['review', 'adversarial-review']
const WATCH_MODES: WatchMode[] = ['full', 'panel', 'off']
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
    if (!(HOSTS as readonly string[]).includes(host)) errors.push(`${path}: unknown host "${host}"`)
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
    if (host === 'omp' && CODEX_ENGINES.includes(engine)) {
      errors.push(
        `${at}.engine "${engine}"${entry.engine === undefined ? ' (the engine of an entry that names none)' : ''} runs Codex, which granny does not run on omp - use "engine": "agent" with an omp model, e.g. "model": { "omp": "openai-codex/gpt-6.1-sol" }, or "engine": "command"`,
      )
    } else if (host === 'opencode' && adversarial && engine === 'auto') {
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
  if (!Array.isArray(c.alwaysFix) || !c.alwaysFix.every(i => IMPACTS.includes(i))) {
    errors.push(`alwaysFix must be an array of impact classes (${IMPACTS.join(', ')})`)
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
  if (typeof c.planReview !== 'boolean') errors.push('planReview must be a boolean')
  if (typeof c.finalReview !== 'boolean') errors.push('finalReview must be a boolean')
  if (typeof c.parallel !== 'boolean') errors.push('parallel must be a boolean')
  if (!Number.isInteger(c.maxParallel) || c.maxParallel < 1) errors.push('maxParallel must be an integer >= 1')
  if (typeof c.aiAttribution !== 'boolean') errors.push('aiAttribution must be a boolean')
  if (typeof c.readOnlyAgent !== 'boolean') errors.push('readOnlyAgent must be a boolean')
  if (!WATCH_MODES.includes(c.watch)) errors.push('watch must be "full", "panel" or "off"')
  if (!Array.isArray(c.rules) || !c.rules.every(r => typeof r === 'string')) errors.push('rules must be an array of strings')
  if (!isRepairs(c.maxRepairs)) errors.push('maxRepairs must be an integer >= 0')
  errors.push(...checkErrors(c.checks))

  for (const role of ROLES) {
    errors.push(...modelErrors(`roles.${role}.model`, c.roles[role].model), ...effortErrors(`roles.${role}.effort`, c.roles[role].effort))
  }
  return errors
}

const isRepairs = (v: unknown) => Number.isInteger(v) && (v as number) >= 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function checkErrors(list: unknown): string[] {
  if (!Array.isArray(list)) return ['checks must be an array of { name, run } objects']
  const errors: string[] = []
  const named = new Map<string, number>()
  list.forEach((entry, i) => {
    const at = `checks[${i}]`
    if (!isObject(entry)) return errors.push(`${at} must be an object`)
    for (const k of Object.keys(entry)) {
      if (!CHECK_KEYS.has(k)) errors.push(`unknown key "${at}.${k}"`)
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) errors.push(`${at}.name must be a non-empty string`)
    else if (named.has(entry.name)) errors.push(`${at}.name "${entry.name}" is already used by checks[${named.get(entry.name)}]`)
    else named.set(entry.name, i)
    if (typeof entry.run !== 'string' || !entry.run.trim()) errors.push(`${at}.run must be a non-empty command string`)
    if (entry.maxRepairs !== undefined && !isRepairs(entry.maxRepairs)) errors.push(`${at}.maxRepairs must be an integer >= 0`)
    if (entry.timeout !== undefined && !(isNumber(entry.timeout) && entry.timeout > 0)) errors.push(`${at}.timeout must be a number of seconds > 0`)
    if (entry.metric !== undefined) errors.push(...metricErrors(`${at}.metric`, entry.metric))
  })
  return errors
}

function metricErrors(at: string, m: unknown): string[] {
  if (!isObject(m)) return [`${at} must be an object { pattern, min?, max? }`]
  const errors = Object.keys(m).filter(k => !METRIC_KEYS.has(k)).map(k => `unknown key "${at}.${k}"`)
  if (typeof m.pattern !== 'string' || !m.pattern) errors.push(`${at}.pattern must be a non-empty regular expression`)
  else {
    try {
      if (new RegExp(`${m.pattern}|`).exec('')!.length < 2) errors.push(`${at}.pattern needs a capture group around the number, e.g. "coverage: ([0-9.]+)%"`)
    } catch (e) {
      errors.push(`${at}.pattern is not a valid regular expression: ${(e as Error).message}`)
    }
  }
  for (const k of ['min', 'max'] as const) {
    if (m[k] !== undefined && !isNumber(m[k])) errors.push(`${at}.${k} must be a number`)
  }
  if (m.min === undefined && m.max === undefined) errors.push(`${at} needs min, max or both`)
  else if (isNumber(m.min) && isNumber(m.max) && m.min > m.max) errors.push(`${at}.min must not be above max`)
  return errors
}

export function resolveModel(spec: ModelSpec | undefined, host: HostName): string | undefined {
  if (spec === undefined) return undefined
  if (typeof spec === 'string') return spec
  return spec[host]
}
