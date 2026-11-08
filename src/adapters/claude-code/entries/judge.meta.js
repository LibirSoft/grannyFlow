export const meta = {
  name: 'granny-judge',
  description: 'granny judge: a review-only run, one review and one tagging of the current checkout, saved as a report file, changing nothing else',
  whenToUse: 'Launched by the granny-workflow skill for granny judge, with args {judge: true, repo, base, context, config}',
  phases: [
    { title: 'Review' },
    { title: 'Tagging' },
    { title: 'Save report' },
  ],
}
