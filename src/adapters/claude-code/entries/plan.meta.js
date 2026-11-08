export const meta = {
  name: 'granny-plan',
  description: 'Plan a goal: a planner writes the plan and proposes stages, the plan review cleans it when planReview is on, then the run stops for the user to approve',
  whenToUse: 'Launched by the granny-workflow skill to plan a goal, with args {repo, branch, base, repos, context, goal, plan, config}',
  phases: [
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Plan review' },
  ],
}
