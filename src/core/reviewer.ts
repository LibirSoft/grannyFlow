import { codexCommand, reviewerEngine, type GrannyConfig } from './config'
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

  const otherwise = (why: string, remedy: string) =>
    engine === 'auto' && mode === 'review'
      ? `echo "${SAID}${cliLabel} - ${why}" && ${cli}`
      : `{ echo "${SAID}codex-plugin ${mode} unavailable - ${why}; ${remedy}" > ${log}; false; }`
  const missing = otherwise(`no Codex plugin companion at $codex_plugins/<version>/${COMPANION}`, "install OpenAI's Codex plugin for Claude Code")
  const noNode = otherwise('node is not on PATH for the Codex plugin companion at $companion', 'install Node.js')
  const versions = `for d in "$codex_plugins"/*/; do d=\${d%/}; d=\${d##*/}; [ -f "$codex_plugins/$d/${COMPANION}" ] && printf '%s\\n' "$d"; done`
  const find = `${PLUGINS}; companion_version=$(${versions} | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1); companion="$codex_plugins/$companion_version/${COMPANION}"`
  const plugin = `echo "${SAID}codex-plugin ${mode} ($companion)" && ${companionCommand(c, base)} > ${md} 2> ${log}`
  return {
    script: wrap(`${find}; if [ -z "$companion_version" ]; then ${missing}; elif ! command -v node >/dev/null 2>&1; then ${noNode}; else ${plugin}; fi`),
  }
}

export function reportedBackend(output: string): string | undefined {
  return BACKEND_LINE.exec(output)?.[1]?.trim()
}
