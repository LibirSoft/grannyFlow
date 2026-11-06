import { runGranny, runJudge } from '../../core/engine'
import { claudeCodeHost, type WorkflowApi } from './host'

export function main(api: WorkflowApi) {
  const host = claudeCodeHost(api)
  return api.args?.judge === true ? runJudge(host, api.args) : runGranny(host, api.args)
}
