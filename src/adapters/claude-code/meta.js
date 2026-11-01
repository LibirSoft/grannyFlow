export const meta = {
  name: 'granny-workflow',
  description: 'Implement a plan stage by stage; after each stage loop review -> judge -> fix until clean; end PR-ready without pushing',
  whenToUse: 'Launched by the granny-workflow skill with args {repo, branch, base, context, stages, config}',
  phases: [
    { title: 'Worktree' },
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'PR ready' },
  ],
}
