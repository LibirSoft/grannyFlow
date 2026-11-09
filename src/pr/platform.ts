import { failure, type PosterIo } from './io'

export const PLATFORMS = ['github', 'gitlab'] as const
export type Platform = (typeof PLATFORMS)[number]

/** The host a remote URL points at, lower-cased, or undefined for a local path. */
export function hostOf(url: string): string | undefined {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(url)
  const host = scheme ? scheme[1]!.slice(scheme[1]!.lastIndexOf('@') + 1).replace(/:\d*$/, '') : /^(?:[^@/]+@)?([^/:]+):/.exec(url)?.[1]
  return host ? host.toLowerCase() : undefined
}

const PASS = 'pass --platform github|gitlab, or --out <file>'

/** The remote the current branch tracks, else origin. */
function remoteName(io: PosterIo): string {
  const branch = io.exec('git', ['branch', '--show-current']).stdout.trim()
  const tracked = branch ? io.exec('git', ['config', '--get', `branch.${branch}.remote`]) : undefined
  const name = tracked?.code === 0 ? tracked.stdout.trim() : ''
  return name && name !== '.' ? name : 'origin'
}

const glabKnows = (io: PosterIo, host: string) => {
  const r = io.exec('glab', ['auth', 'status', '--all'])
  return `${r.stdout}\n${r.stderr}`.split('\n').some(line => line.trim().toLowerCase() === host)
}

/** The platform the remote is on, or why it cannot tell. */
export function detectPlatform(io: PosterIo): Platform | { error: string } {
  const remote = remoteName(io)
  const url = io.exec('git', ['remote', 'get-url', remote])
  if (url.code !== 0) return { error: `cannot tell the platform: the remote ${remote} has no URL (${failure(url)}): ${PASS}` }
  const host = hostOf(url.stdout.trim())
  if (host === undefined) return { error: `cannot tell the platform of the remote ${remote} (${url.stdout.trim()}): ${PASS}` }
  if (host === 'github.com') return 'github'
  if (host.includes('gitlab') || glabKnows(io, host)) return 'gitlab'
  return { error: `cannot tell the platform of ${host}: ${PASS}` }
}
