import { resolveModel, type GrannyConfig, type ReviewerConfig } from './config'
import { shellQuote } from './shell'
import type { HostName } from './types'

const SAID = '[granny] reviewer: '
const BACKEND_LINE = /^\[granny\] reviewer: (.*)$/m
const PLUGINS = 'codex_plugins="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex"'
const COMPANION = 'scripts/codex-companion.mjs'

export interface ReviewPlan {
  script: string
  backend?: string
}

export function cliCommand(rv: ReviewerConfig, host: HostName, base: string, out: string, prompt = ''): string {
  const model = resolveModel(rv.model, host)
  const template = rv.engine === 'command' && rv.command ? rv.command : `codex exec review --base {base}${model ? ' -m {model}' : ''} -o {out}`
  const values: Record<string, string> = { base: shellQuote(base), out: shellQuote(out), model: model ? shellQuote(model) : '', prompt: shellQuote(prompt) }
  return template.replace(/\{(base|out|model|prompt)\}/g, (_, key: string) => values[key]!)
}

export function companionCommand(rv: ReviewerConfig, host: HostName, base: string): string {
  const m = resolveModel(rv.model, host)
  const model = m ? ` -m ${shellQuote(m)}` : ''
  const focus = rv.focus ? ` -- ${shellQuote(rv.focus)}` : ''
  return `node "$companion" ${rv.mode ?? 'review'} --wait --base ${shellQuote(base)} --scope branch${model}${focus}`
}

export const reviewStem = (c: GrannyConfig, stage: string, round: number, rv: ReviewerConfig) => `${c.workDir}/review-${stage}-r${round}-${rv.name}`

interface Backends {
  cli: string
  cliLabel: string
  plugin: string
  pluginLabel: string
  fallback: boolean
}

function script(rv: ReviewerConfig, c: GrannyConfig, host: HostName, stem: string, b: Backends): ReviewPlan {
  const md = shellQuote(`${stem}.md`)
  const log = shellQuote(`${stem}.log`)
  const wrap = (run: string) =>
    `mkdir -p ${shellQuote(c.workDir)} && rm -f ${md} ${log} && ${run}; code=$?; if [ -s ${md} ]; then cat ${md}; else cat ${log}; fi; exit $code`

  const cli = `${b.cli} > ${log} 2>&1`
  if (rv.engine === 'command') return { script: wrap(cli), backend: 'custom command' }
  if (rv.engine === 'codex' || (rv.engine === 'auto' && host !== 'claude-code')) return { script: wrap(cli), backend: b.cliLabel }

  const otherwise = (why: string, remedy: string) =>
    b.fallback
      ? `echo "${SAID}${b.cliLabel} - ${why}" && ${cli}`
      : `{ echo "${SAID}codex-plugin ${b.pluginLabel} unavailable - ${why}; ${remedy}" > ${log}; false; }`
  const missing = otherwise(`no Codex plugin companion at $codex_plugins/<version>/${COMPANION}`, "install OpenAI's Codex plugin for Claude Code")
  const noNode = otherwise('node is not on PATH for the Codex plugin companion at $companion', 'install Node.js')
  const versions = `for d in "$codex_plugins"/*/; do d=\${d%/}; d=\${d##*/}; [ -f "$codex_plugins/$d/${COMPANION}" ] && printf '%s\\n' "$d"; done`
  const find = `${PLUGINS}; companion_version=$(${versions} | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1); companion="$codex_plugins/$companion_version/${COMPANION}"`
  const stopBroker = `node "\${companion%/*}/session-lifecycle-hook.mjs" SessionEnd </dev/null >/dev/null 2>&1`
  const ownBroker = `export CLAUDE_PLUGIN_DATA="$PWD"/${shellQuote(`${c.workDir}/codex-plugin-${rv.name}`)} && trap '${stopBroker}' EXIT && trap 'exit 143' TERM && trap 'exit 130' INT && trap 'exit 129' HUP`
  const plugin = `echo "${SAID}codex-plugin ${b.pluginLabel} ($companion)" && ${ownBroker} && ${b.plugin} > ${md} 2> ${log}`
  return {
    script: wrap(`${find}; if [ -z "$companion_version" ]; then ${missing}; elif ! command -v node >/dev/null 2>&1; then ${noNode}; else ${plugin}; fi`),
  }
}

export function reviewPlan(rv: ReviewerConfig, c: GrannyConfig, host: HostName, base: string, stem: string, prompt = ''): ReviewPlan {
  const mode = rv.mode ?? 'review'
  return script(rv, c, host, stem, {
    cli: cliCommand(rv, host, base, `${stem}.md`, prompt),
    cliLabel: 'codex CLI (codex exec review)',
    plugin: companionCommand(rv, host, base),
    pluginLabel: mode,
    fallback: rv.engine === 'auto' && mode === 'review',
  })
}

export function planReviewScript(rv: ReviewerConfig, c: GrannyConfig, host: HostName, stem: string, prompt: string): ReviewPlan | undefined {
  if (rv.engine === 'agent' || (rv.engine === 'command' && !rv.command?.includes('{prompt}'))) return undefined
  const m = resolveModel(rv.model, host)
  const model = m ? ` -m ${shellQuote(m)}` : ''
  const cli =
    rv.engine === 'command'
      ? cliCommand(rv, host, c.base, `${stem}.md`, prompt)
      : `codex exec --sandbox read-only${model} -o ${shellQuote(`${stem}.md`)} ${shellQuote(prompt)} </dev/null`
  return script(rv, c, host, stem, {
    cli,
    cliLabel: 'codex CLI (codex exec, read-only)',
    plugin: `node "$companion" task${model} ${shellQuote(prompt)} </dev/null`,
    pluginLabel: 'task',
    fallback: rv.engine === 'auto',
  })
}

export function reportedBackend(output: string): string | undefined {
  return BACKEND_LINE.exec(output)?.[1]?.trim()
}
