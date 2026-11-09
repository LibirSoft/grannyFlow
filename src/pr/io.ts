export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Everything the poster touches outside itself: git, the platform's CLI, the trail files and its output. */
export interface PosterIo {
  exec(cmd: 'git' | 'gh' | 'glab', args: string[], input?: string): ExecResult
  /** The `*.json` names in `dir`, or undefined when it does not exist. */
  list(dir: string): string[] | undefined
  read(path: string): string
  /** The config's work dir for the checkout at `toplevel`; throws on an invalid config. */
  workDir(toplevel: string): string
  print(line: string): void
}

export const failure = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ') || `exit ${r.code}`

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
