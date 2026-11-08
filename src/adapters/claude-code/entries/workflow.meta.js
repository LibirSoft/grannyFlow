export const meta = {
  name: 'granny-workflow',
  description: 'Implement a plan stage by stage, or review work already written; after each stage loop review -> judge -> fix until clean; end PR-ready without pushing',
  whenToUse: 'Launched by the granny-workflow skill to implement a plan, with args {repo, branch, base, repos, context, plan, stages, fromStage, config}',
  phases: [
    { title: 'Worktree' },
    { title: 'Plan review' },
    { title: 'Implement' },
    { title: 'Checks' },
    { title: 'Review' },
    { title: 'Final review' },
    { title: 'PR ready' },
  ],
}
