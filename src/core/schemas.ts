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
  findings: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: FINDING },
      summary: { type: 'string' },
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
          properties: { id: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } },
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
