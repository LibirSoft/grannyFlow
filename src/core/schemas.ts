import type { JsonSchema, ResultKind } from './types'

const FINDING = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', description: 'P0 | P1 | P2 | P3' },
    file: { type: 'string' },
    line: { type: 'number' },
    title: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'severity', 'file', 'title', 'detail'],
}

export const SCHEMAS: Record<ResultKind, JsonSchema> = {
  draft: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'absolute paths of the plan files you wrote' },
      stages: {
        type: 'array',
        description: 'proposed stages, one per stop-and-review point',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            task: { type: 'string', description: 'exactly which work orders or sections of the plan this stage does' },
            repo: { type: 'string', description: 'absolute path of the repo this stage works in, when the run spans several repos; omit for the primary repo' },
            after: { type: 'array', items: { type: 'number' }, description: '1-based numbers of the earlier stages this stage builds on; [] when it can start right away (independent stages run in parallel)' },
          },
          required: ['name', 'task'],
        },
      },
      summary: { type: 'string', description: 'a few lines for the user: the approach and the work orders' },
      questions: { type: 'string', description: 'decisions only the user can make, each with the default the plan assumes; empty when none' },
    },
    required: ['files', 'stages', 'summary'],
  },
  implementation: {
    type: 'object',
    properties: {
      startSha: { type: 'string', description: 'HEAD before your first change' },
      headSha: { type: 'string' },
      gatesGreen: { type: 'boolean' },
      gates: { type: 'string', description: 'exact numbers per gate' },
      commits: { type: 'array', items: { type: 'string' } },
      untested: { type: 'string' },
      deviations: { type: 'string' },
    },
    required: ['startSha', 'headSha', 'gatesGreen', 'gates', 'commits', 'untested'],
  },
  planFix: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'absolute paths of the plan files you changed' },
      changes: { type: 'string', description: 'what you changed in the plan, per finding id' },
      deviations: { type: 'string', description: 'findings you did not apply, and why' },
    },
    required: ['files', 'changes'],
  },
  findings: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: FINDING },
      summary: { type: 'string' },
      clean: { type: 'boolean', description: 'only when asked to read a review that has no finding bullets: true if it is a finished review that clearly says the changes have no problems' },
    },
    required: ['findings'],
  },
  command: {
    type: 'object',
    properties: {
      ran: { type: 'boolean', description: 'true only if the command finished with exit code 0' },
      exitCode: { type: 'number' },
      output: { type: 'string', description: 'the review text, verbatim' },
      note: { type: 'string' },
    },
    required: ['ran', 'output'],
  },
  score: {
    type: 'object',
    properties: {
      score: { type: 'number', description: '0-100 overall: how correct, verified and actionable this review is' },
      perFinding: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            score: { type: 'number' },
            reason: { type: 'string' },
            duplicateOf: { type: 'string', description: 'id of another finding in this list that reports the same problem; omit when there is none' },
          },
          required: ['id', 'score', 'reason'],
        },
      },
      rationale: { type: 'string' },
    },
    required: ['score', 'perFinding', 'rationale'],
  },
  final: {
    type: 'object',
    properties: {
      gatesGreen: { type: 'boolean' },
      gates: { type: 'string', description: 'exact numbers per gate' },
      commits: { type: 'array', items: { type: 'string' } },
      prBodyPath: { type: 'string' },
      issues: { type: 'string', description: 'open issues for the user; empty when none' },
    },
    required: ['gatesGreen', 'gates', 'commits', 'prBodyPath', 'issues'],
  },
}

const TYPES: Record<string, (v: unknown) => boolean> = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => typeof v === 'object' && v !== null && !Array.isArray(v),
}

export function checkShape(schema: JsonSchema, value: unknown): string[] {
  if (!TYPES.object!(value)) return ['result must be an object']
  const obj = value as Record<string, unknown>
  const errors: string[] = []
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) errors.push(`missing "${key}"`)
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const type = (prop as { type?: string }).type
    if (obj[key] !== undefined && type && TYPES[type] && !TYPES[type]!(obj[key])) {
      errors.push(`"${key}" must be ${type}`)
    }
  }
  return errors
}
