import { runGranny } from '../../core/engine'
import { claudeCodeHost, type WorkflowApi } from './host'

export function main(api: WorkflowApi) {
  return runGranny(claudeCodeHost(api), api.args)
}
