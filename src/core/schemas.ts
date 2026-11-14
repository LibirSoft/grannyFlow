import { FIX_COSTS, IMPACTS, LIKELIHOODS, SCOPES, VERDICTS } from './types'
import type { JsonSchema, ResultKind } from './types'

const DECLINED = {
  type: 'array',
  description: 'the findings you were sent and did not fix on purpose, each with its id exactly as given and why; [] when you fixed them all',
  items: {
    type: 'object',
    properties: { id: { type: 'string' }, reason: { type: 'string' } },
    required: ['id', 'reason'],
  },
}

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
            steps: {
              type: 'array',
              description: 'the steps of this stage, in order, one per commit point; the planner is asked for them only when config stepAgents is on',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'a short name for the step' },
                  task: { type: 'string', description: 'which work orders, or the part of one, this step does; the files to read first and the files it changes' },
                },
                required: ['task'],
              },
            },
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
      declined: DECLINED,
    },
    required: ['startSha', 'headSha', 'gatesGreen', 'gates', 'commits', 'untested'],
  },
  planFix: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'absolute paths of the plan files you changed' },
      changes: { type: 'string', description: 'what you changed in the plan, per finding id' },
      deviations: { type: 'string', description: 'anything else the user should know about your changes' },
      declined: DECLINED,
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
  judge: {
    type: 'object',
    properties: {
      perFinding: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: [...VERDICTS], description: 'is it really in the code?' },
            impact: { type: 'string', enum: [...IMPACTS], description: 'how bad IF it triggers - likelihood never lowers it' },
            likelihood: { type: 'string', enum: [...LIKELIHOODS] },
            fixCost: { type: 'string', enum: [...FIX_COSTS] },
            scope: { type: 'string', enum: [...SCOPES] },
            evidence: { type: 'string', description: 'path:line plus the concrete trigger steps' },
            reason: { type: 'string', description: 'one line' },
            duplicateOf: { type: 'string', description: 'id of another finding in this list that reports the same problem; omit when there is none' },
            repeatOf: { type: 'string', description: 'label of the earlier finding this one repeats, exactly as listed under EARLIER DECISIONS (e.g. r1/codex-F2, or s1/r2/codex-F1 from a stage review); omit when it repeats none' },
          },
          required: ['id', 'verdict', 'impact', 'likelihood', 'fixCost', 'scope', 'evidence', 'reason'],
        },
      },
      rationale: { type: 'string' },
    },
    required: ['perFinding', 'rationale'],
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
