import { resolveConfig } from '../../core/config'
import { configLayers, type RunInput } from '../../core/engine'
import type { AgentRequest, Host } from '../../core/types'
import { READ_ONLY_AGENT, READ_ONLY_ROLES, readOnlyPrefix } from './readonly'

export interface WorkflowApi {
  agent: (prompt: string, opts: Record<string, unknown>) => Promise<any>
  log: (message: string) => void
  phase: (title: string) => void
  args: RunInput & { judge?: boolean }
}

export function claudeCodeHost(api: WorkflowApi): Host {
  let readOnlyAgent: boolean | undefined
  return {
    name: 'claude-code',
    agent(req: AgentRequest) {
      const opts: Record<string, unknown> = { label: req.label, phase: req.phase, schema: req.schema }
      if (req.model) opts.model = req.model
      if (req.effort) opts.effort = req.effort
      if (req.access !== 'read-only') return api.agent(req.prompt, opts)
      readOnlyAgent ??= resolveConfig(configLayers(api.args), 'claude-code').readOnlyAgent
      const enforced = readOnlyAgent && READ_ONLY_ROLES.includes(req.role)
      if (enforced) opts.agentType = READ_ONLY_AGENT
      return api.agent(readOnlyPrefix(enforced) + req.prompt, opts)
    },
    log: message => api.log(message),
    phase: title => api.phase(title),
  }
}
