import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { globalConfigPath } from '../adapters/config-files'
import { runTags, type TagsIo } from './command'

const io: TagsIo = {
  userPath: globalConfigPath(),
  read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temp, text)
      renameSync(temp, path)
    } catch (e) {
      rmSync(temp, { force: true })
      throw e
    }
  },
  print: line => console.log(line),
  toplevel(dir) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : undefined
  },
}

process.exitCode = runTags(process.argv.slice(2), io)
