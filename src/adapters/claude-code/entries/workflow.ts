import { runGranny } from '../../../core/engine'
import { claudeCodeHost, type WorkflowApi } from '../host'
import { requireMode } from '../modes'

export function main(api: WorkflowApi) {
  requireMode('workflow', api.args)
  return runGranny(claudeCodeHost(api), api.args)
}
