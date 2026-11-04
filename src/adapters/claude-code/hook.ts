import { guard } from './readonly'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => (raw += chunk))
process.stdin.on('end', () => {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const reason = guard(input)
  if (!reason) process.exit(0)
  process.stderr.write(`${reason}\n`)
  process.exit(2)
})
