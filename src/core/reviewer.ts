import { resolveModel, type GrannyConfig, type ReviewerConfig } from './config'
import { OPENCODE_AGENT, opencodeAgentConfig } from './opencode'
import { shellQuote } from './shell'
import type { HostName } from './types'

const SAID = '[granny] reviewer: '
const BACKEND_LINE = /^\[granny\] reviewer: (.*)$/m
const PLUGINS = 'codex_plugins="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex"'
const COMPANION = 'scripts/codex-companion.mjs'

export interface ReviewPlan {
  script: string
  /** The script without its mkdir and rm, for a detached run whose start command clears the files. */
  body: string
  backend?: string
}

export const WAIT_SECONDS = 540
export const MAX_WAITS = 7

export interface DetachedReview {
  start: string
  wait: string
  read: string
  stop: string
}

export function detachedReview(plan: ReviewPlan, c: GrannyConfig, stem: string, cwd: string): DetachedReview {
  const [md, log, out, exit, pid] = ['md', 'log', 'out', 'exit', 'pid'].map(ext => shellQuote(`${stem}.${ext}`))
  const cd = `cd ${shellQuote(cwd)} && `
  const kill = `kill -TERM -- "-$(cat ${pid})" 2>/dev/null || kill -TERM "$(cat ${pid})" 2>/dev/null`
  const job = shellQuote(`echo $$ > ${pid}; (${plan.body}) > ${out} 2>&1; echo $? > ${exit}`)
  const until = shellQuote(`until [ -s ${exit} ] || [ "$SECONDS" -ge ${WAIT_SECONDS} ]; do sleep 5; done`)
  return {
    start: `${cd}if [ -s ${pid} ] && [ ! -s ${exit} ]; then ${kill}; fi; mkdir -p ${shellQuote(c.workDir)} && rm -f ${md} ${log} ${out} ${exit} ${pid} && { set -m; nohup bash -c ${job} > /dev/null 2>&1 < /dev/null & } && echo started`,
    wait: `${cd}bash -c ${until}; if [ -s ${exit} ]; then echo done; else echo pending; fi`,
    read: `${cd}code=$(cat ${exit}); cat ${out}; exit "\${code:-1}"`,
    stop: `${cd}if [ -s ${pid} ]; then ${kill}; fi; rm -f ${pid}; echo stopped`,
  }
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

/** Cuts every event but text, error and step_start down to its type, so a tool's output never reaches whoever reads the stream. */
const OPENCODE_SHORTEN = '/^\\{"type":"(text|error|step_start)"/!s/^(\\{"type":"[a-z_]+").*/\\1}/'

export const opencodeModel = (rv: ReviewerConfig, host: HostName) => `${resolveModel(rv.model, host)}${rv.effort ? `#${rv.effort}` : ''}`

/** `opencode run` as a read-only reviewer, its output the JSON event stream; `dirs` are the outside directories it may read. */
function opencodeScript(rv: ReviewerConfig, host: HostName, prompt: string, dirs: string[], log: string): string {
  const model = opencodeModel(rv, host)
  const run = `OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeAgentConfig(dirs))} opencode run --standalone --archived --format json --agent ${OPENCODE_AGENT} -m ${shellQuote(model)} ${shellQuote(prompt)} </dev/null`
  return `{ echo ${shellQuote(`${SAID}opencode ${model} (read-only agent)`)}; ${run}; } > ${log} 2>&1`
}

interface Backends {
  cli: string
  cliLabel: string
  plugin: string
  pluginLabel: string
  fallback: boolean
  prompt: string
  dirs: string[]
}

function script(rv: ReviewerConfig, c: GrannyConfig, host: HostName, stem: string, b: Backends): ReviewPlan {
  const md = shellQuote(`${stem}.md`)
  const log = shellQuote(`${stem}.log`)
  const wrap = (run: string, backend?: string, print = `if [ -s ${md} ]; then cat ${md}; else cat ${log}; fi`): ReviewPlan => {
    const body = `${run}; code=$?; ${print}; exit $code`
    return { script: `mkdir -p ${shellQuote(c.workDir)} && rm -f ${md} ${log} && ${body}`, body, ...(backend ? { backend } : {}) }
  }

  if (rv.engine === 'opencode') return wrap(opencodeScript(rv, host, b.prompt, b.dirs, log), undefined, `sed -E ${shellQuote(OPENCODE_SHORTEN)} ${log}`)
  const cli = `${b.cli} > ${log} 2>&1`
  if (rv.engine === 'command') return wrap(cli, 'custom command')
  if (rv.engine === 'codex' || (rv.engine === 'auto' && host !== 'claude-code')) return wrap(cli, b.cliLabel)

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
  return wrap(`${find}; if [ -z "$companion_version" ]; then ${missing}; elif ! command -v node >/dev/null 2>&1; then ${noNode}; else ${plugin}; fi`)
}

export function reviewPlan(rv: ReviewerConfig, c: GrannyConfig, host: HostName, base: string, stem: string, prompt = '', dirs: string[] = []): ReviewPlan {
  const mode = rv.mode ?? 'review'
  return script(rv, c, host, stem, {
    cli: cliCommand(rv, host, base, `${stem}.md`, prompt),
    cliLabel: 'codex CLI (codex exec review)',
    plugin: companionCommand(rv, host, base),
    pluginLabel: mode,
    fallback: rv.engine === 'auto' && mode === 'review',
    prompt,
    dirs,
  })
}

export function planReviewScript(rv: ReviewerConfig, c: GrannyConfig, host: HostName, base: string, stem: string, prompt: string, dirs: string[] = []): ReviewPlan | undefined {
  if (rv.engine === 'agent' || (rv.engine === 'command' && !rv.command?.includes('{prompt}'))) return undefined
  const m = resolveModel(rv.model, host)
  const model = m ? ` -m ${shellQuote(m)}` : ''
  const cli =
    rv.engine === 'command'
      ? cliCommand(rv, host, base, `${stem}.md`, prompt)
      : `codex exec --sandbox read-only${model} -o ${shellQuote(`${stem}.md`)} ${shellQuote(prompt)} </dev/null`
  return script(rv, c, host, stem, {
    cli,
    cliLabel: 'codex CLI (codex exec, read-only)',
    plugin: `node "$companion" task${model} ${shellQuote(prompt)} </dev/null`,
    pluginLabel: 'task',
    fallback: rv.engine === 'auto',
    prompt,
    dirs,
  })
}

export function reportedBackend(output: string): string | undefined {
  return BACKEND_LINE.exec(output)?.[1]?.trim()
}
