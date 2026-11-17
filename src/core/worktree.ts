import type { GrannyConfig } from './config'
import { trimPath, workOf } from './paths'
import { shellQuote } from './shell'

const SAID = '[granny] worktree: '
const REPORTED = /^\[granny\] worktree: (\/.*?)\r?$/m
const OWNED = '[granny] worktree made by granny'
const OWNER_FILE = 'granny-worktree'
const RESTORED = '[granny] work dir restored'
const NOT_RESTORED = '[granny] work dir not restored'
const ASIDE = '[granny] earlier work dir files moved aside: '
const NOT_ASIDE = '[granny] earlier work dir files not moved aside'
const GIT_DIR = 'gd=$(git -C "$wt" rev-parse --absolute-git-dir)'
const ownerFile = `"$gd"/${OWNER_FILE}`

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const branchSlug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'

export function worktreePath(repo: string, branch: string, worktreeDir?: string, shared = false): string {
  const top = normalize(repo)
  const cut = top.lastIndexOf('/')
  const parent = top.slice(0, cut) || '/'
  const name = top.slice(cut + 1)
  const dir = worktreeDir === undefined ? `${parent}/${name}-worktrees` : worktreeDir.startsWith('/') ? worktreeDir : `${parent}/${worktreeDir}`
  const prefix = shared && worktreeDir !== undefined ? `${name}-` : ''
  return normalize(`${dir}/${prefix}${branchSlug(branch)}`)
}

export function excludeScript(c: GrannyConfig): string {
  const entry = shellQuote(`/${c.workDir}/`)
  return `ex="$(git rev-parse --git-common-dir)/info/exclude" && mkdir -p "\${ex%/*}" && { grep -qxF -e ${entry} "$ex" 2>/dev/null || { if [ -s "$ex" ] && [ -n "$(tail -c 1 "$ex")" ]; then echo >> "$ex"; fi; printf '%s\\n' ${entry} >> "$ex"; }; }`
}

const KEY_MAX = 200

const hashOf = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const savedKey = (branch: string) => {
  const key = encodeURIComponent(branch).replace(/[!'()*~]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return key.length <= KEY_MAX ? key : `${key.slice(0, KEY_MAX - 9)}-${hashOf(key)}`
}

export const savedDir = (c: Pick<GrannyConfig, 'workDir'>, repo: string, branch: string) => `${trimPath(repo)}/${workOf(c)}/branches/${savedKey(branch)}`

export function worktreeScript(c: GrannyConfig, branch: string, base: string, path: string, saved?: string): string {
  const b = shellQuote(branch)
  const find = `wt=$(git worktree list --porcelain | while IFS= read -r l; do case "$l" in "worktree "*) p=\${l#worktree };; "branch refs/heads/"*) if [ "\${l#branch refs/heads/}" = ${b} ]; then printf '%s\\n' "$p"; break; fi;; esac; done)`
  const reuse = `changes=$(git -C "$wt" status --porcelain) || exit 1; if [ -n "$changes" ]; then printf '[granny] worktree failed: %s has %s checked out with uncommitted changes - commit or discard them, then run again:\\n' "$wt" ${b}; git -C "$wt" status --short; exit 1; fi`
  const own = `${GIT_DIR} && printf '%s\\n' "$wt" > ${ownerFile} || :`
  const s = saved === undefined ? undefined : shellQuote(saved)
  const work = shellQuote(workOf(c))
  const restore = s ? `; if [ -d ${s} ]; then if mkdir -p "$wt"/${work} && cp -R ${s}/. "$wt"/${work}/; then echo ${shellQuote(RESTORED)}; else echo ${shellQuote(NOT_RESTORED)}; fi; fi` : ''
  const aside = s ? `; if [ -d ${s} ]; then base=${s}.before-$(date +%Y%m%d-%H%M%S); old=$base; n=2; while [ -e "$old" ]; do old=$base-$n; n=$((n+1)); done; if mv ${s} "$old"; then printf '%s%s\\n' ${shellQuote(ASIDE)} "$old"; else echo ${shellQuote(NOT_ASIDE)}; fi; fi` : ''
  const add = `wt=${shellQuote(path)}; git worktree add "$wt" ${b} || exit 1; ${own}${restore}`
  const create = `wt=${shellQuote(path)}; git worktree add -b ${b} "$wt" ${shellQuote(base)} || exit 1; ${own}${aside}`
  const owned = `${GIT_DIR} && if [ -f ${ownerFile} ]; then echo ${shellQuote(OWNED)}; fi`
  return `${excludeScript(c)} && ${find} && if [ -n "$wt" ]; then ${reuse}; elif git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then ${add}; else ${create}; fi && ${owned} && printf '%s%s\\n' ${shellQuote(SAID)} "$wt"`
}

export const madeByGranny = (output: string) => output.split('\n').some(l => l.trim() === OWNED)

export function savedNotes(output: string, saved: string): string[] {
  const lines = output.split('\n').map(l => l.trim())
  const aside = lines.find(l => l.startsWith(ASIDE))
  return [
    ...(lines.includes(RESTORED) ? [`work dir files of an earlier run restored from ${saved}`] : []),
    ...(lines.includes(NOT_RESTORED) ? [`the work dir files of an earlier run could not be restored from ${saved} - they stay there`] : []),
    ...(aside ? [`${saved} held the files of an earlier branch of this name - moved to ${aside.slice(ASIDE.length)}`] : []),
    ...(lines.includes(NOT_ASIDE) ? [`${saved} holds the files of an earlier branch of this name, which could not be moved aside - the files of this run are merged into them`] : []),
  ]
}

const MARK = (m: string) => `echo ${shellQuote(`[granny] ${m}`)}`

export function removeWorktreeScript(c: Pick<GrannyConfig, 'workDir'>, branch: string, path: string, saved: string): string {
  const dst = shellQuote(saved)
  const save = [
    'cd "$src" || exit 1',
    `mkdir -p ${dst} || exit 1`,
    `if [ -d trail ]; then grep -qxF -e "$wt" trail/worktree-paths 2>/dev/null || printf '%s\\n' "$wt" >> trail/worktree-paths; fi`,
    `cp -R . ${dst}/`,
    'n=$(find . -type f | wc -l)',
    `same=$(find . -type f -exec cmp -s {} ${dst}/{} \\; -print | wc -l)`,
    '[ "$n" -eq "$same" ]',
  ].join('; ')
  const steps = [
    `wt=${shellQuote(path)}; src="$wt"/${shellQuote(workOf(c))}`,
    `if [ ! -e "$wt" ]; then common=$(git rev-parse --git-common-dir) || exit 1; if [ -n "$(find "$common/worktrees" -mindepth 2 -maxdepth 2 -name ${OWNER_FILE} -type f -exec grep -lxF -e "$wt" {} + 2>/dev/null)" ]; then ${MARK('run worktree listed')}; exit 1; fi;${MARK('run worktree gone')}; if [ -d ${dst} ]; then ${MARK('work dir saved')}; fi; exit 0; fi`,
    `${GIT_DIR} || exit 1; [ -f ${ownerFile} ] || exit 1; ${MARK('run worktree owned')}`,
    `top=$(git rev-parse --show-toplevel) && wtop=$(git -C "$wt" rev-parse --show-toplevel) || exit 1; if [ "$top" = "$wtop" ]; then ${MARK('run worktree is where the run starts')}; exit 1; fi`,
    `[ "$(git -C "$wt" symbolic-ref -q HEAD)" = ${shellQuote(`refs/heads/${branch}`)} ] || exit 1; ${MARK('run worktree on branch')}`,
    `changes=$(git -C "$wt" status --porcelain) || exit 1; if [ -n "$changes" ]; then git -C "$wt" status --short; exit 1; fi; ${MARK('run worktree clean')}`,
    `if [ -d "$src" ]; then ( ${save} ) || exit 1; ${MARK('work dir saved')}; else ${MARK('no work dir files')}; fi`,
    `git worktree remove "$wt" || exit 1; ${MARK('run worktree removed')}`,
  ]
  return `{ ${steps.join('; ')}; }`
}

export const printed = (output: string, marker: string) => output.split('\n').some(l => l.trim() === `[granny] ${marker}`)

export type Removal = { removed: true; saved?: string } | { removed: false; kept: string }

export function removalOf(output: string, branch: string, saved: string, code?: number | string): Removal {
  if (code !== undefined && typeof code !== 'number' && !output.split('\n').some(l => l.trim().startsWith('[granny] '))) return { removed: false, kept: 'the removal did not run: its runner returned no exit code' }
  const reached = (m: string) => printed(output, m)
  if (reached('run worktree listed')) return { removed: false, kept: 'the worktree folder is gone, but git still lists it - git worktree prune removes the entry' }
  if (reached('run worktree gone') || reached('run worktree removed')) return { removed: true, ...(reached('work dir saved') ? { saved } : {}) }
  if (!reached('run worktree owned')) return { removed: false, kept: 'the removal could not confirm that granny created it' }
  if (reached('run worktree is where the run starts')) return { removed: false, kept: 'the run was started in this worktree' }
  if (!reached('run worktree on branch')) return { removed: false, kept: `it is not on ${branch}` }
  if (!reached('run worktree clean')) return { removed: false, kept: 'uncommitted changes in the worktree' }
  if (!reached('work dir saved') && !reached('no work dir files')) return { removed: false, kept: `its work dir files could not be saved to ${saved}` }
  return { removed: false, kept: 'git worktree remove failed' }
}

export function reportedWorktree(output: string): string | undefined {
  return REPORTED.exec(output)?.[1]
}
