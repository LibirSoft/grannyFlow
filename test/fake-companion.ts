import { existsSync, readFileSync } from 'node:fs'

export const brokerCompanion = (record: string, { exit = 0, hang = false } = {}) => `import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
const data = process.env.CLAUDE_PLUGIN_DATA ?? ''
const broker = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
broker.unref()
mkdirSync(data, { recursive: true })
writeFileSync(data + '/broker.pid', String(broker.pid))
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ event: 'companion', data, broker: broker.pid }) + '\\n')
${hang ? 'setInterval(() => {}, 1000)' : `process.stdout.write('- [P2] Reviewed by the plugin — a.ts:1\\n  detail\\n')\nprocess.exitCode = ${exit}`}
`

export const sessionEndHook = (record: string) => `import { appendFileSync, readFileSync } from 'node:fs'
const data = process.env.CLAUDE_PLUGIN_DATA ?? ''
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ event: 'hook', argv: process.argv.slice(2), cwd: process.cwd(), data }) + '\\n')
try {
  process.kill(Number(readFileSync(data + '/broker.pid', 'utf8')), 'SIGTERM')
} catch {}
`

export const records = (file: string): any[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export async function until(check: () => boolean, ms = 2000) {
  const end = performance.now() + ms
  while (!check()) {
    if (performance.now() > end) return false
    await Bun.sleep(20)
  }
  return true
}
