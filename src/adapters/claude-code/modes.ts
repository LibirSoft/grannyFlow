export type Mode = 'plan' | 'workflow' | 'judge'

const SCRIPT_OF: Record<Mode, string> = { plan: 'planning', workflow: 'implement', judge: 'granny judge' }
const RUN_OF: Record<Mode, string> = {
  plan: 'a planning run (args with goal)',
  workflow: 'an implement run (args with plan and stages)',
  judge: 'a granny judge run (args with judge: true)',
}

export function modeOf(args: unknown): Mode | undefined {
  if (!args || typeof args !== 'object') return undefined
  const { judge, goal } = args as { judge?: unknown; goal?: unknown }
  return judge === true ? 'judge' : goal !== undefined ? 'plan' : 'workflow'
}

export function requireMode(script: Mode, args: unknown): void {
  const mode = modeOf(args)
  if (mode && mode !== script) throw new Error(`this is the ${SCRIPT_OF[script]} script; ${RUN_OF[mode]} uses engines/claude-code/${mode}.js`)
}
