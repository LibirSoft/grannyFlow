import { runGranny } from '../../../core/engine'
import { claudeCodeHost, type WorkflowApi } from '../host'
import { requireMode } from '../modes'

export function main(api: WorkflowApi) {
  requireMode('plan', api.args)
  return runGranny(claudeCodeHost(api), api.args)
}
