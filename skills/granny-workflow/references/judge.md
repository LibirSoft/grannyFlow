# granny judge

When the user says `granny judge`, or wants granny only to review, follow this instead of the normal run. One agent reviews the branch, a second agent tags what it found, and the result is a markdown file the user can read later. It works on every host.

It never implements, fixes, commits, pushes, or creates a branch or worktree. There is one review round and no loop, so it costs one review and one tagging, no fix rounds. `threshold`, `alwaysFix`, `maxRounds`, `checks` and the implementer play no part.

Talk to the user in their language. Ask with your host's question tool when you have one; otherwise ask in one numbered message and wait for the answer.

## 1. Look

- The repo, the two config files, which reviewers can run and the host's models: exactly as [setup.md](setup.md#1-look-first).
- The base: the config's `base` (default `main`); check whether the repo uses `master`.
- What gets reviewed is the checkout's `<base>...HEAD`. Uncommitted files are not reviewed: they are listed at the top of the report, and they do not refuse the run. To review another branch, the user checks it out or you pass that branch's worktree as `repo`. On the base branch with nothing ahead, say there is nothing to review and ask which branch.

## 2. Ask, only for what is missing

Something is missing when:

- no config file sets `reviewers` (the built-in default list does not count as a choice);
- an `agent` reviewer has no model for this host;
- the judge has no model for this host (on Claude Code the built-in `haiku` counts as set).

With nothing missing, go to step 4. Otherwise ask only about what is missing:

1. **Who reviews** - the reviewers, as [setup.md](setup.md#2-ask) question 2, then the model of each `agent` reviewer.
2. **Who tags** - the `judge` model. On Claude Code offer it too, with `haiku` marked as the default.
3. **Where to save** - this project (`<repo>/granny.config.json`) or every project (`~/.config/granny/config.json`).

Tell the user that a reviewer on another model than the tagger is a real second opinion, and that this costs one review and one tagging, no fix rounds. A parent never answers these for the user: do not pick a model because it looks suitable, and do not pass the models in the run's `config`. On omp and opencode the tool reads only the config files for this and refuses otherwise, naming what is missing.

## 3. Write

Write only those keys, merged by [setup.md](setup.md#3-write)'s rules: models keyed by host, other hosts' keys kept, every key not answered kept. A `haiku` judge on Claude Code is the built-in default, so it is not written. No `threshold`, `checks` or other keys.

```json
{
  "reviewers": [
    { "name": "reviewer", "engine": "agent", "model": { "omp": "openai-codex/gpt-6.1-sol" } }
  ],
  "roles": {
    "judge": { "model": { "omp": "anthropic/claude-haiku-5-5" } }
  }
}
```

Read it back as JSON to be sure it parses. Do not commit it.

## 4. Launch

- omp and opencode: `granny_judge({ repo, base?, context? })`. The reply names the reviewers and the judge model. Then wait as the reply says.
- Claude Code: the Workflow script `engines/claude-code/judge.js`, launched like a normal run ([claude-code.md](claude-code.md#review-only-granny-judge)), with `args: { judge: true, repo, base, context, config: [<user>, <project>] }`. Leave out a config file that does not exist.
- Anything else: [cursor.md](cursor.md#granny-judge), by hand.

`context` is optional: what the user wants looked at, or a plan to check against. A refusal or a failed Workflow that names missing models sends you back to step 2.

## 5. Report

The run's result comes in the finish message on omp and opencode, and as the Workflow's result on Claude Code.

Give the user the report path first, then the counts per heading, how many reviewer P0/P1 findings were demoted, what was not reviewed, and which reviewers did not run. List the P0 and P1 titles, no more: the file is the review.

On Claude Code with `written: false`, write `report` to `reportPath` with the Write tool yourself. On omp and opencode the same text is in the run's `result.json`.

Other outcomes have no report: `no-changes` (nothing in `<base>..HEAD`) and `review-failed` (no reviewer ran, also on a retry; its `note` says why). Say so.

Then stop. Nothing is fixed unless the user asks; if they want fixes, a normal run with an `implement: false` stage does it.

## 6. Later

When the user asks to read the last review: the newest file in `<repo>/<workDir>/reviews/`.

## The report

`<repo>/<workDir>/reviews/<date>-<branch>.md`, by default under `.granny/reviews/`, which git ignores through the excludes.

The heading is the tagging agent's call, through its classification and not the reviewer's severity:

| impact | heading |
|---|---|
| `critical` | `P0` |
| `major` | `P1` |
| `moderate` | `P2` |
| `minor` | `P3` |
| `none`, or verdict `refuted` | `Dismissed by the judge` |

- The four P headings always appear, with `None.` when empty. `Dismissed by the judge` appears only when it has entries, with the judge's reason on each.
- Without a `path:line` in its evidence a finding is `unverified` and drops one class.
- A finding the judge left unclassified, also after its one retry, stays under the reviewer's severity (critical, high, medium and low are `P0` to `P3`, anything else counts as `P2`) with the tag `not judged`, and the top of the report says so.
- Every finding carries its tags: verdict, impact, likelihood, fix cost and scope, the priority, and `reviewer: Pn`. A finding the judge placed lower than the reviewer did also has `demoted`. A normal run never lets a judge lower a P0 or P1 and a cheap judge can be wrong, so say how many of those were demoted.
- A reviewer that failed twice does not stop the review while another one ran: the top of the report names it.
