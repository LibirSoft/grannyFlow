import type { Role } from '../../core/types'

export const READ_ONLY_AGENT = 'granny-readonly'
export const READ_ONLY_ROLES: Role[] = ['reviewer', 'judge', 'granny']

const GIT_READS = ['diff', 'log', 'show', 'blame', 'status', 'rev-parse', 'merge-base', 'ls-files']
const BRANCH_READS = new Set(['--show-current', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv'])
const PLAIN_READS = new Set(['cat', 'grep', 'ls', 'head', 'tail', 'wc', 'pwd', 'cd'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/
const SED_FLAGS = /^-[nEr]+$/
const SED_PRINT = /^\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*(;\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*)*;?\s*$/

export const READ_ONLY_LINE = 'READ-ONLY ROLE: do not edit, create, stage or commit any file.'
export const READ_ONLY_COMMANDS =
  "Besides Read (and Grep and Glob where you have them), your Bash runs these commands only: git diff, git log, git show, git blame, git status, git rev-parse, git merge-base, git ls-files, git branch --show-current, cat, sed -n '<from>,<to>p', grep, find (without -exec, -delete or -fprint), ls, head, tail, wc, pwd. Write each as a plain command; `cd <dir> && ` before it, `|` between them and `2>/dev/null` are fine, but `$(...)`, backticks, `$VARIABLES` and redirection into a file are not. A hook blocks any other command."

export function readOnlyPrefix(agentType: boolean): string {
  return agentType ? `${READ_ONLY_LINE}\n${READ_ONLY_COMMANDS}\n\n` : `${READ_ONLY_LINE}\n\n`
}

type Redirect = { op: string; target: string }
type Token = { word: string } | { sep: string } | Redirect

function lex(command: string): Token[] | string {
  const tokens: Token[] = []
  let word = ''
  let quoted = false
  let i = 0
  const flush = () => {
    if (word || quoted) tokens.push({ word })
    word = ''
    quoted = false
  }
  const readTarget = (): string | undefined => {
    while (command[i] === ' ' || command[i] === '\t') i++
    const start = i
    while (i < command.length && !/[\s;&|<>()$`'"\\]/.test(command[i]!)) i++
    return i > start ? command.slice(start, i) : undefined
  }
  while (i < command.length) {
    const c = command[i]!
    if (c === ' ' || c === '\t') {
      flush()
      i++
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return 'an unterminated quote'
      word += command.slice(i + 1, end)
      quoted = true
      i = end + 1
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '$' || command[i] === '`') return '`$` or a backtick inside double quotes'
        if (command[i] === '\\' && i + 1 < command.length) i++
        word += command[i]
        i++
      }
      if (i >= command.length) return 'an unterminated quote'
      quoted = true
      i++
    } else if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') word += command[i + 1]
      i += 2
    } else if (c === '$' || c === '`') {
      return 'command substitution or a variable'
    } else if (c === '(' || c === ')') {
      return 'a subshell or process substitution'
    } else if (c === '\n' || c === ';') {
      flush()
      tokens.push({ sep: ';' })
      i++
    } else if (c === '|' || c === '&') {
      const two = command.slice(i, i + 2)
      if (c === '&' && command[i + 1] === '>') {
        flush()
        i += command[i + 2] === '>' ? 3 : 2
        const target = readTarget()
        if (target === undefined) return 'a redirection without a target'
        tokens.push({ op: '&>', target })
      } else if (two === '&&' || two === '||' || two === '|&') {
        flush()
        tokens.push({ sep: two })
        i += 2
      } else if (c === '|') {
        flush()
        tokens.push({ sep: '|' })
        i++
      } else return 'a background `&`'
    } else if (c === '>' || c === '<') {
      const fd = /^\d*$/.test(word) && !quoted ? word : undefined
      if (fd === undefined) flush()
      word = ''
      quoted = false
      let op = c
      i++
      if (c === '<' && (command[i] === '<' || command[i] === '>')) return c === '<' && command[i] === '<' ? 'a here-document' : 'a read-write redirection'
      if (c === '>' && (command[i] === '>' || command[i] === '|')) i++
      if (command[i] === '&') {
        op += '&'
        i++
      }
      const target = readTarget()
      if (target === undefined) return 'a redirection without a target'
      tokens.push({ op: `${fd ?? ''}${op}`, target })
    } else {
      word += c
      i++
    }
  }
  flush()
  return tokens
}

function redirectProblem(r: Redirect): string | undefined {
  if (r.op.endsWith('&')) return /^(\d|-)$/.test(r.target) ? undefined : `a redirection to ${r.target}`
  if (r.op.endsWith('<')) return undefined
  return r.target === '/dev/null' ? undefined : `a redirection into ${r.target}`
}

function sedProblem(args: string[]): string | undefined {
  let quiet = false
  const scripts: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--quiet' || a === '--silent') quiet = true
    else if (a === '-e') scripts.push(args[++k] ?? '')
    else if (SED_FLAGS.test(a)) quiet ||= a.includes('n')
    else if (a.startsWith('-')) return `sed option ${a}`
    else if (!scripts.length) scripts.push(a)
  }
  if (!quiet) return 'sed without -n'
  if (!scripts.length || !scripts.every(s => SED_PRINT.test(s))) return "a sed script other than '<from>,<to>p'"
  return undefined
}

function gitProblem(args: string[]): string | undefined {
  let k = 0
  while (k < args.length && args[k]!.startsWith('-')) {
    if (args[k] === '-C') k += 2
    else if (args[k] === '--no-pager' || args[k] === '-P') k++
    else return `git option ${args[k]}`
  }
  const sub = args[k]
  const rest = args.slice(k + 1)
  if (sub === 'branch') return rest.every(a => BRANCH_READS.has(a)) ? undefined : `git branch ${rest.join(' ')}`
  if (sub === undefined || !GIT_READS.includes(sub)) return `git ${sub ?? ''}`.trim()
  const output = rest.find(a => a.startsWith('--output'))
  return output ? `git ${sub} ${output}` : undefined
}

function segmentProblem(words: string[]): string | undefined {
  const [name, ...args] = words as [string, ...string[]]
  if (/^[A-Za-z_]\w*=/.test(name)) return `a variable assignment (${name})`
  if (name === 'git') return gitProblem(args)
  if (name === 'sed') return sedProblem(args)
  if (name === 'find') {
    const action = args.find(a => FIND_ACTIONS.test(a))
    return action ? `find ${action}` : undefined
  }
  if (PLAIN_READS.has(name)) return undefined
  return name
}

/** Why a read-only role may not run this Bash command, or undefined when it may. */
export function commandProblem(command: string): string | undefined {
  const tokens = lex(command)
  if (typeof tokens === 'string') return tokens
  let words: string[] = []
  const segments: string[][] = []
  for (const t of tokens) {
    if ('sep' in t) {
      segments.push(words)
      words = []
    } else if ('op' in t) {
      const problem = redirectProblem(t)
      if (problem) return problem
    } else words.push(t.word)
  }
  segments.push(words)
  const commands = segments.filter(s => s.length)
  if (!commands.length) return 'an empty command'
  for (const s of commands) {
    const problem = segmentProblem(s)
    if (problem) return problem
  }
  return undefined
}

const isReadOnlyAgent = (type: unknown) => typeof type === 'string' && (type === READ_ONLY_AGENT || type.endsWith(`:${READ_ONLY_AGENT}`))

/** The PreToolUse decision for a hook input: the reason to block, or undefined to let the call through. */
export function guard(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const { agent_type, tool_name, tool_input } = input as Record<string, any>
  if (!isReadOnlyAgent(agent_type)) return undefined
  if (WRITE_TOOLS.has(tool_name)) return `granny read-only role: ${tool_name} is not available to ${agent_type}.`
  if (tool_name !== 'Bash') return undefined
  const command = String(tool_input?.command ?? '')
  const problem = commandProblem(command)
  return problem ? `granny read-only role: blocked \`${command}\` (${problem}). ${READ_ONLY_COMMANDS}` : undefined
}
