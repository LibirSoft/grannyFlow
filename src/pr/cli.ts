import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globalConfigPath, readJson } from '../adapters/config-files'
import { resolveConfig } from '../core/config'
import { postTrail, type PosterIo } from './post'

const io: PosterIo = {
  exec(cmd, args, input) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
    if (r.error) return { code: 127, stdout: '', stderr: `${cmd}: ${r.error.message}` }
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  },
  list: dir => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter(n => n.endsWith('.json')) : undefined),
  read: path => readFileSync(path, 'utf8'),
  workDir: toplevel => resolveConfig([readJson(globalConfigPath()), readJson(join(toplevel, 'granny.config.json'))]).workDir,
  write: (path, text) => writeFileSync(path, text),
  print: line => console.log(line),
}

process.exitCode = postTrail(process.argv.slice(2), io)
