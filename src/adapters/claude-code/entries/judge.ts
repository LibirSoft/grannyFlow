import { runJudge } from '../../../core/engine'
import { claudeCodeHost, type WorkflowApi } from '../host'
import { requireMode } from '../modes'

export function main(api: WorkflowApi) {
  requireMode('judge', api.args)
  return runJudge(claudeCodeHost(api), api.args)
}
