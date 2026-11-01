import { runGranny, type RunInput } from '../../core/engine'
import type { AgentRequest, Host } from '../../core/types'

export interface WorkflowApi {
  agent: (prompt: string, opts: Record<string, unknown>) => Promise<any>
  log: (message: string) => void
  phase: (title: string) => void
  args: RunInput
}

export function main(api: WorkflowApi) {
  const host: Host = {
    name: 'claude-code',
    agent(req: AgentRequest) {
      const opts: Record<string, unknown> = { label: req.label, phase: req.phase, schema: req.schema }
      if (req.model) opts.model = req.model
      if (req.effort) opts.effort = req.effort
      const guard = req.access === 'read-only' ? 'READ-ONLY ROLE: do not edit, create, stage or commit any file.\n\n' : ''
      return api.agent(guard + req.prompt, opts)
    },
    log: message => api.log(message),
    phase: title => api.phase(title),
  }
  return runGranny(host, api.args)
}
