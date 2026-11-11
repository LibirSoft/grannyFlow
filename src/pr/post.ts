import { trimSlashes } from '../core/paths'
import type { TrailRound } from '../core/types'
import { postGithub, prOf, prTarget } from './github'
import { mrOf, mrTarget, postGitlab } from './gitlab'
import { failure, plural, type PosterIo } from './io'
import { type PlannedReview, planRound, type Target } from './plan'
import { detectPlatform, type Platform, PLATFORMS } from './platform'
import { byTrailOrder, trailProblem } from './records'

export type { ExecResult, PosterIo } from './io'

export const USAGE = 'usage: node pr-comments.mjs [--platform github|gitlab] [--pr <number>] [--trail <dir>] [--out <file> [--base <ref>]] [--dry-run]'

interface Options {
  platform?: Platform
  pr?: number
  trail?: string
  out?: string
  base?: string
  dryRun: boolean
}

const VALUED = ['--pr', '--trail', '--platform', '--out', '--base']

function parseArgs(argv: string[]): Options | string {
  const options: Options = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!VALUED.includes(arg)) return `unknown argument ${arg}`
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) return `${arg} needs a value`
    if (arg === '--trail') options.trail = value
    else if (arg === '--out') options.out = value
    else if (arg === '--base') options.base = value
    else if (arg === '--platform') {
      if (!(PLATFORMS as readonly string[]).includes(value)) return `--platform takes github or gitlab, got ${value}`
      options.platform = value as Platform
    } else if (/^[1-9]\d*$/.test(value)) options.pr = Number(value)
    else return `--pr takes a PR number, got ${value}`
  }
  if (options.base !== undefined && options.out === undefined) return '--base goes with --out <file>'
  return options
}

function readRecords(io: PosterIo, dir: string): TrailRound[] | undefined {
  const names = io.list(dir)
  if (names === undefined) return undefined
  const records: TrailRound[] = []
  for (const name of [...names].sort()) {
    let value: unknown
    try {
      value = JSON.parse(io.read(`${dir}/${name}`))
    } catch (e) {
      io.print(`skipped ${name}: ${(e as Error).message}`)
      continue
    }
    const problem = trailProblem(value)
    if (problem) io.print(`skipped ${name}: ${problem}`)
    else records.push(value as TrailRound)
  }
  return records.sort(byTrailOrder)
}

const commitOf = (io: PosterIo, ref: string) => {
  const r = io.exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** What `--out` plans against: the PR when the platform has one, else `--base` and the checked-out commit. */
function outTarget(io: PosterIo, options: Options): Target | { error: string; code: number } {
  const platform = options.platform ?? detectPlatform(io)
  if (platform === 'github') {
    const pr = prOf(io, options.pr)
    if (typeof pr !== 'string') return prTarget(pr)
    if (options.pr !== undefined) return { error: `open the PR first (${pr})`, code: 2 }
  }
  if (platform === 'gitlab') {
    const mr = mrOf(io, options.pr)
    if (!('error' in mr)) return mrTarget(io, mr)
    if (options.pr !== undefined || mr.code !== 2) return mr
  }
  if (options.base === undefined) return { error: '--out needs the target branch: open the PR, or pass --base <ref>', code: 1 }
  const base = commitOf(io, options.base)
  if (base === undefined) return { error: `--base ${options.base} is not a commit`, code: 1 }
  const head = commitOf(io, 'HEAD')
  if (head === undefined) return { error: 'HEAD is not a commit', code: 1 }
  return { head, base, ...(platform === 'gitlab' ? { platform } : {}) }
}

/** Writes `{ version: 1, reviews }` for any other client to post; posts nothing. */
function writeOut(io: PosterIo, options: Options & { out: string }, records: TrailRound[], toplevel: string): number {
  const target = outTarget(io, options)
  if ('error' in target) {
    io.print(target.error)
    return target.code
  }
  const reviews = records.map(r => planRound(io, r, records, target, toplevel)).filter((p): p is PlannedReview => p !== undefined)
  const text = `${JSON.stringify({ version: 1, reviews }, null, 2)}\n`
  if (options.dryRun) {
    io.print(text.trimEnd())
    io.print(`would write ${plural(reviews.length, 'review')} to ${options.out}`)
    return 0
  }
  try {
    io.write(options.out, text)
  } catch (e) {
    io.print(`could not write ${options.out}: ${(e as Error).message}`)
    return 1
  }
  io.print(`wrote ${plural(reviews.length, 'review')} to ${options.out}`)
  return 0
}

/** Reads the trail and posts each round not yet on the PR, or writes the plan with `--out`; returns the exit code. */
export function postTrail(argv: string[], io: PosterIo): number {
  const options = parseArgs(argv)
  if (typeof options === 'string') {
    io.print(`${options}\n${USAGE}`)
    return 1
  }
  const top = io.exec('git', ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    io.print(`not inside a git checkout: ${failure(top)}`)
    return 1
  }
  const toplevel = top.stdout.trim()
  let dir = options.trail
  if (dir === undefined) {
    try {
      dir = `${toplevel}/${trimSlashes(io.workDir(toplevel))}/trail`
    } catch (e) {
      io.print(`${(e as Error).message}\npass the trail directory with --trail <dir>`)
      return 1
    }
  }
  const records = readRecords(io, dir)
  if (records === undefined) {
    io.print(`no trail at ${dir} - a granny run writes it there (config trail: true)`)
    return 1
  }
  if (options.out !== undefined) return writeOut(io, { ...options, out: options.out }, records, toplevel)
  const platform = options.platform ?? detectPlatform(io)
  if (typeof platform !== 'string') {
    io.print(platform.error)
    return 1
  }
  if (!records.length) io.print(`no trail records in ${dir}`)
  const request = { records, toplevel, ...(options.pr === undefined ? {} : { pr: options.pr }), dryRun: options.dryRun }
  return platform === 'gitlab' ? postGitlab(io, request) : postGithub(io, request)
}
