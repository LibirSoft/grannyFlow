import { shellQuote } from './shell'
import type { HostName, Role } from './types'

export type ModelSpec = string | Partial<Record<HostName, string>>

export interface RoleConfig {
  model?: ModelSpec
  effort?: string
}

export interface ReviewerConfig extends RoleConfig {
  engine?: 'codex' | 'agent'
  command?: string
}

export interface GrannyConfig {
  roles: {
    granny: RoleConfig
    implementer: RoleConfig
    reviewer: ReviewerConfig
    judge: RoleConfig
  }
  threshold: number
  maxRounds: number
  base: string
  gates: string[] | 'auto'
  workDir: string
  language: string
  aiAttribution: boolean
  rules: string[]
}

export const DEFAULT_CONFIG: GrannyConfig = {
  roles: {
    granny: {},
    implementer: {},
    reviewer: { engine: 'codex' },
    judge: { model: { 'claude-code': 'sonnet' } },
  },
  threshold: 70,
  maxRounds: 4,
  base: 'main',
  gates: 'auto',
  workDir: '.granny',
  language: 'English',
  aiAttribution: false,
  rules: [
    'Every behaviour change gets a test that fails without the change - write the red half first.',
    'Code comments: default none; add one only when the reason cannot be recovered from the code.',
  ],
}

const ROLES: Role[] = ['granny', 'implementer', 'reviewer', 'judge']
const TOP_KEYS = new Set(['$schema', 'roles', ...Object.keys(DEFAULT_CONFIG).filter(k => k !== 'roles')])
const ROLE_KEYS = new Set(['model', 'effort'])
const REVIEWER_KEYS = new Set(['model', 'effort', 'engine', 'command'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function resolveConfig(layers: unknown[]): GrannyConfig {
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
          if (!ROLES.includes(role as Role)) {
            errors.push(`${where}: unknown role "${role}" (expected ${ROLES.join(', ')})`)
            continue
          }
          if (!isObject(value)) {
            errors.push(`${where}: roles.${role} must be an object`)
            continue
          }
          const allowed = role === 'reviewer' ? REVIEWER_KEYS : ROLE_KEYS
          for (const k of Object.keys(value)) {
            if (!allowed.has(k)) errors.push(`${where}: unknown key "roles.${role}.${k}"`)
          }
          const target = config.roles[role as Role] as Record<string, unknown>
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

  errors.push(...validate(config))
  if (errors.length) throw new Error(`Invalid granny config:\n- ${errors.join('\n- ')}`)
  return config
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
  if (typeof c.aiAttribution !== 'boolean') errors.push('aiAttribution must be a boolean')
  if (!Array.isArray(c.rules) || !c.rules.every(r => typeof r === 'string')) errors.push('rules must be an array of strings')

  for (const role of ROLES) {
    const r = c.roles[role]
    if (r.model !== undefined && typeof r.model !== 'string' && !isObject(r.model)) {
      errors.push(`roles.${role}.model must be a string or an object keyed by host`)
    }
    if (isObject(r.model)) {
      for (const [host, m] of Object.entries(r.model)) {
        if (host !== 'claude-code' && host !== 'opencode') errors.push(`roles.${role}.model: unknown host "${host}"`)
        if (typeof m !== 'string' || !m) errors.push(`roles.${role}.model.${host} must be a non-empty string`)
      }
    }
    if (r.effort !== undefined && !EFFORTS.has(r.effort)) {
      errors.push(`roles.${role}.effort must be one of ${[...EFFORTS].join(', ')}`)
    }
  }
  const rv = c.roles.reviewer
  if (rv.engine !== undefined && rv.engine !== 'codex' && rv.engine !== 'agent') {
    errors.push('roles.reviewer.engine must be "codex" or "agent"')
  }
  if (rv.command !== undefined && (typeof rv.command !== 'string' || !rv.command.includes('{base}'))) {
    errors.push('roles.reviewer.command must be a string containing {base}')
  }
  return errors
}

export function resolveModel(spec: ModelSpec | undefined, host: HostName): string | undefined {
  if (spec === undefined) return undefined
  if (typeof spec === 'string') return spec
  return spec[host]
}

export function reviewerEngine(c: GrannyConfig): 'codex' | 'agent' {
  return c.roles.reviewer.engine ?? 'codex'
}

export function codexCommand(c: GrannyConfig, base: string, out: string): string {
  const model = c.roles.reviewer.model
  const codexModel = typeof model === 'string' ? model : undefined
  const template = c.roles.reviewer.command ?? `codex exec review --base {base}${codexModel ? ' -m {model}' : ''} -o {out}`
  const values: Record<string, string> = { base: shellQuote(base), out: shellQuote(out), model: codexModel ? shellQuote(codexModel) : '' }
  return template.replace(/\{(base|out|model)\}/g, (_, key: string) => values[key]!)
}
