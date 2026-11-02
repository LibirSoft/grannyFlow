import type { GrannyConfig } from './config'
import { shellQuote } from './shell'

const SAID = '[granny] worktree: '
const REPORTED = /^\[granny\] worktree: (\/.*?)\r?$/m

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

export function worktreePath(repo: string, branch: string, worktreeDir?: string): string {
  const top = normalize(repo)
  const cut = top.lastIndexOf('/')
  const parent = top.slice(0, cut) || '/'
  const dir = worktreeDir === undefined ? `${parent}/${top.slice(cut + 1)}-worktrees` : worktreeDir.startsWith('/') ? worktreeDir : `${parent}/${worktreeDir}`
  return normalize(`${dir}/${branchSlug(branch)}`)
}

export function worktreeScript(c: GrannyConfig, branch: string, base: string, path: string): string {
  const entry = shellQuote(`/${c.workDir}/`)
  const b = shellQuote(branch)
  const exclude = `ex="$(git rev-parse --git-common-dir)/info/exclude" && mkdir -p "\${ex%/*}" && { grep -qxF -e ${entry} "$ex" 2>/dev/null || { if [ -s "$ex" ] && [ -n "$(tail -c 1 "$ex")" ]; then echo >> "$ex"; fi; printf '%s\\n' ${entry} >> "$ex"; }; }`
  const find = `wt=$(git worktree list --porcelain | while IFS= read -r l; do case "$l" in "worktree "*) p=\${l#worktree };; "branch refs/heads/"*) if [ "\${l#branch refs/heads/}" = ${b} ]; then printf '%s\\n' "$p"; break; fi;; esac; done)`
  const reuse = `changes=$(git -C "$wt" status --porcelain) || exit 1; if [ -n "$changes" ]; then printf '[granny] worktree failed: %s has %s checked out with uncommitted changes - commit or discard them, then run again:\\n' "$wt" ${b}; git -C "$wt" status --short; exit 1; fi`
  const add = `wt=${shellQuote(path)}; git worktree add "$wt" ${b} || exit 1`
  const create = `wt=${shellQuote(path)}; git worktree add -b ${b} "$wt" ${shellQuote(base)} || exit 1`
  return `${exclude} && ${find} && if [ -n "$wt" ]; then ${reuse}; elif git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then ${add}; else ${create}; fi && printf '%s%s\\n' ${shellQuote(SAID)} "$wt"`
}

export function reportedWorktree(output: string): string | undefined {
  return REPORTED.exec(output)?.[1]
}
