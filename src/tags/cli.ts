import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { globalConfigPath } from '../adapters/config-files'
import { runTags, type TagsIo } from './command'

function targetOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    let target = path
    for (let hops = 0; lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(); hops++) {
      if (hops === 40) throw new Error('too many symbolic links')
      target = resolve(realpathSync(dirname(target)), readlinkSync(target))
    }
    return target
  }
}

const io: TagsIo = {
  userPath: globalConfigPath(),
  read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  write(path, text) {
    const target = targetOf(path)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && statSync(target).nlink > 1) {
      writeFileSync(target, text)
      return
    }
    const temp = `${target}.${process.pid}.tmp`
    try {
      writeFileSync(temp, text)
      if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o777)
      renameSync(temp, target)
    } catch (e) {
      rmSync(temp, { force: true })
      throw e
    }
  },
  remove: path => rmSync(path, { force: true }),
  linkCount(path) {
    const target = targetOf(path)
    return existsSync(target) ? statSync(target).nlink : 1
  },
  print: line => console.log(line),
  toplevel(dir) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : undefined
  },
}

process.exitCode = runTags(process.argv.slice(2), io)
