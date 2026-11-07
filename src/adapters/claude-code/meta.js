export const meta = {
  name: 'granny-workflow',
  description: 'Plan a goal (then stop for approval), or implement a plan stage by stage; after each stage loop review -> judge -> fix until clean; end PR-ready without pushing. In judge mode: a review-only run, one review and one tagging of the current checkout, saved as a report file, changing nothing else',
  whenToUse: 'Launched by the granny-workflow skill with args {repo, branch, base, repos, context, goal, plan, stages, config}, or for granny judge with args {judge: true, repo, base, context, config}',
  phases: [
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Plan review' },
    { title: 'Implement' },
    { title: 'Checks' },
    { title: 'Review' },
    { title: 'Final review' },
    { title: 'PR ready' },
    { title: 'Tagging' },
    { title: 'Save report' },
  ],
}
