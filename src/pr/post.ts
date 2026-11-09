import { trimSlashes } from '../core/paths'
import type { TrailRound } from '../core/types'
import { postGithub } from './github'
import { failure, type PosterIo } from './io'
import { byTrailOrder, trailProblem } from './records'

export type { ExecResult, PosterIo } from './io'

export const USAGE = 'usage: node pr-comments.mjs [--pr <number>] [--trail <dir>] [--dry-run]'

interface Options {
  pr?: number
  trail?: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Options | string {
  const options: Options = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--pr' || arg === '--trail') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`
      if (arg === '--trail') options.trail = value
      else if (/^[1-9]\d*$/.test(value)) options.pr = Number(value)
      else return `--pr takes a PR number, got ${value}`
    } else return `unknown argument ${arg}`
  }
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

/** Reads the trail and posts each round not yet on the PR; returns the exit code. */
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
  if (!records.length) io.print(`no trail records in ${dir}`)
  return postGithub(io, { records, toplevel, ...(options.pr === undefined ? {} : { pr: options.pr }), dryRun: options.dryRun })
}
