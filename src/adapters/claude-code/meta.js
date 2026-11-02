export const meta = {
  name: 'granny-workflow',
  description: 'Plan a goal (then stop for approval), or implement a plan stage by stage; after each stage loop review -> judge -> fix until clean; end PR-ready without pushing',
  whenToUse: 'Launched by the granny-workflow skill with args {repo, branch, base, repos, context, goal, plan, stages, config}',
  phases: [
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Plan review' },
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'PR ready' },
  ],
}
