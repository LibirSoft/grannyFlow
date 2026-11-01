import { codexCommand, reviewerEngine, type GrannyConfig } from './config'
import { shellQuote } from './shell'
import type { HostName } from './types'

const SAID = '[granny] reviewer: '
const BACKEND_LINE = /^\[granny\] reviewer: (.*)$/m
const COMPANION = '.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs'

export interface ReviewPlan {
  script: string
  backend?: string
}

export function companionCommand(c: GrannyConfig, base: string): string {
  const rv = c.roles.reviewer
  const model = typeof rv.model === 'string' ? ` -m ${shellQuote(rv.model)}` : ''
  const focus = rv.focus ? ` -- ${shellQuote(rv.focus)}` : ''
  return `node "$companion" ${rv.mode ?? 'review'} --wait --base ${shellQuote(base)} --scope branch${model}${focus}`
}

export function reviewPlan(c: GrannyConfig, host: HostName, base: string, stem: string): ReviewPlan {
  const md = shellQuote(`${stem}.md`)
  const log = shellQuote(`${stem}.log`)
  const wrap = (run: string) =>
    `mkdir -p ${shellQuote(c.workDir)} && rm -f ${md} ${log} && ${run}; code=$?; if [ -s ${md} ]; then cat ${md}; else cat ${log}; fi; exit $code`

  const rv = c.roles.reviewer
  const engine = reviewerEngine(c)
  const mode = rv.mode ?? 'review'
  const cli = `${codexCommand(c, base, `${stem}.md`)} > ${log} 2>&1`
  const cliLabel = rv.command ? 'custom command (roles.reviewer.command)' : 'codex CLI (codex exec review)'
  if (engine !== 'codex-plugin' && (engine !== 'auto' || host !== 'claude-code' || rv.command)) {
    return { script: wrap(cli), backend: cliLabel }
  }

  const missing = `no Codex plugin companion at $HOME/${COMPANION.replace('*', '<version>')}`
  const fallback =
    engine === 'auto' && mode === 'review'
      ? `echo "${SAID}${cliLabel} - ${missing}" && ${cli}`
      : `{ echo "${SAID}codex-plugin ${mode} unavailable - ${missing}; install OpenAI's Codex plugin for Claude Code" > ${log}; false; }`
  const find = `companion=$(printf '%s\\n' "$HOME"/${COMPANION} | sort -V | tail -n 1)`
  const plugin = `echo "${SAID}codex-plugin ${mode} ($companion)" && ${companionCommand(c, base)} > ${md} 2> ${log}`
  return { script: wrap(`${find}; if [ -f "$companion" ]; then ${plugin}; else ${fallback}; fi`) }
}

export function reportedBackend(output: string): string | undefined {
  return BACKEND_LINE.exec(output)?.[1]?.trim()
}
