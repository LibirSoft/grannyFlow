# Changelog

## Unreleased

### Fixed

- Checks: every check run records the HEAD it ran on (`checks[].head`). The final gate of a one-stage repo reuses the stage's last result only when HEAD is still that commit, and its log names the SHA; when a reviewer or the judge committed after the last gate, or HEAD could not be read, the checks run again. When the final check moves HEAD, the checks run once more without repairs (gate `pr-ready`); a red result sets `recheck: { passed: false, note }` and the branch is not PR-ready.
- Checks: granny never runs the checks on, or reviews over, uncommitted work. Every check gate reads `git status --porcelain` first; a dirty tree goes to the implementer as a commit prompt (`commit <stage> <gate> #<n>`) that spends a repair, and a tree still dirty when the budget is spent ends the gate `checks-failed` with `checks not run at <gate> - uncommitted changes: ...`. Without checks, a dirty tree after the implementer or a fix gets one commit prompt, and what stays uncommitted is named in the stage's or final review's note. After the `pr-ready` checks pass, a tree they left dirty sets `recheck: { passed: false }`; opencode's finish summary names both.
- Checks: the run's plan files inside the repo stay uncommitted, as the planner and plan-fix prompts require, so the status read leaves them out (`:(exclude,literal)` pathspecs) and the commit prompt and the final check's clean-tree rule tell the agent to leave them alone. Before, a plan fix that left `plan.md` changed with `worktree: false` cost a commit prompt at every gate and ended the stage `checks-failed`.
- Stages: an implementer that made no commit but left uncommitted work gets one commit prompt (`commit <stage> implement`) before the stage ends `no-changes`; with a commit then, the stage goes on to its checks and review. Still no commit, the `no-changes` note names the uncommitted files, and opencode's finish summary prints it.
- Claude Code: a `note` the granny helper adds to a command that ran stays out of the command's output; it is logged as `<label>: the helper's note, kept out of the command's output: ...`. Before, it was appended to the output, so a sentence note broke the stage's HEAD read and commit count (the review fell back to `<base>...HEAD` and an empty stage was not caught as `no-changes`), a one-word note such as `Done` became the review base, and a number in it could become a check's metric. The HEAD read now takes the first line that is a hex SHA and the commit count the first whole-number line.

## 1.5.0

### Added

- **Checks** (`"checks": [{ name, run, maxRepairs?, timeout?, metric? }]`, default `[]`): commands granny runs itself instead of trusting the implementer's `gatesGreen`. They run after the implementer finished a stage, after every fix round (stage reviews and the final review), and once per repo on the whole branch before the final review, all before any review sees the code. A check passes when it exits 0 and, with `metric: { pattern, min?, max? }`, the last match's first capture group is a number within the bounds; `timeout` runs it as `timeout <s> bash -c '<run>'`.
- **Repair loop**: red checks go back to the implementer (`repair <stage> <gate> #<n>`) with their command, exit code, metric note and output tail, and the rule never to delete, skip or weaken a test, check, threshold, the granny config or a check script; then every check runs again. `maxRepairs` (default 2) caps the repairs per gate; a check's own `maxRepairs` overrides it. Repairs are not review rounds.
- Stage outcome `checks-failed`: the checks stayed red, so the review did not run or stopped; the stages that build on it, and the later stages of its repo when it left its red commits on the run's branch, are not started. A red stage that ran in its own worktree is not merged back; its lane branch and worktree are left in place. A red whole branch ends `finalReview` `checks-failed`, so the run is not PR-ready - it is repaired only when a final review follows and no stage of the repo ended `checks-failed`; the final check still runs. A stage whose checks ran is never `gates-red`. A one-stage repo with no lane merge reuses its stage's last check result at the final gate instead of running the same checks on the same HEAD again.
- `stages[].checks` selects checks by name (default all, `[]` none); an unknown name stops the run before any agent starts. A repo's whole-branch gate runs the checks its stages selected.
- The result records every check run: `stages[].checks`, and `checks` (also per repo in `repos`) for the whole-branch gate, each `{ at, attempt, results }`.
- On opencode the server executes the check commands; on Claude Code a granny helper agent runs each one and reports its exit code (phase "Checks"). A helper that returns nothing or no exit code gets one retry; then the gate ends `checks-failed` with `check runner failed`, without spending a repair.

### Changed

- A stage that runs in its own worktree branches from the commit the stage busy in the run's worktree started on, not from the run's branch tip, so its checks never run on that stage's unfinished commits.

## 1.4.0

### Changed

- **The default reviewer is the host's model**: without `reviewers` in the config, one `agent` reviewer named `reviewer` runs on the model selected in the host (pin one with `model` on the entry). Codex is an opt-in entry (`"engine": "auto"`, `"codex"` or `"codex-plugin"`); an entry that names no engine still means `auto`.
- Reviewers get the stage's task (`Stage N/M "name" ... its TASK`). They check the diff against it - a missing part is a finding, and so is a change outside it; work the task leaves to other stages is not - and report clean-code and design problems (duplication, naming, needless abstraction, deviations from the plan) as P2/P3. The judge scores findings against the task. Codex's built-in review takes no prompt, so only agent and command reviewers and the judge see the task.

### Added

- **Final review** (`"finalReview": true` by default): after every stage finished, each repo's whole branch (`base...HEAD`) goes through the review loop once more, before the final check, looking for cross-stage duplication and inconsistencies and checking merge commits and their conflict resolutions. Fixes land on the run's branch. A repo with one stage and no lane merge skips it; the result has `finalReview`, and each entry of `repos` its own. After `round-cap` or `review-failed` the final check still runs and the result says the branch has unresolved findings.
- **Declined findings stop coming back**: from round 2 on the judge sees the findings already sent to the fixer and the fixer's `deviations`. It marks a finding that repeats one with `repeatOf`; a repeat the fixer declined with a convincing reason scores low and stays residual for the user, a wrong reason is overruled and the fixer is told why. A first-time P0/P1 still goes to the implementer without the judge; once a fixer declined something, P0/P1 findings go through the judge too. A `deviations` text of "None" or "N/A" is not a decline.
- Stage outcomes `no-changes` (the implementer made no commit; nothing is reviewed and the stages that build on it end `skipped`) and `gates-red` (the review found nothing to fix but the gates were left red).

### Fixed

- A stage is `clean` only when a review looked at real changes. Granny reads HEAD itself before the implementer runs and reviews from there, not from the `startSha` the implementer reports. Reviewer output with no finding bullets is clean only when it says "No findings." (or the Codex plugin's "No material findings."); anything else goes to the extraction agent, which must find the findings or confirm a clean review, otherwise the reviewer did not run.

## 1.3.0

### Added

- **Parallel stages**, on by default (`"parallel": true`, at most `maxParallel` stages at once, default 3). A stage waits only for the stages in its new `after` list (1-based, earlier stages only); without `after` it waits for the previous stage in its repo, so existing stage lists run as before. `"parallel": false` runs one stage at a time in list order.
- **Several repos in one run**: `repos` lists the other repos (paths, or `{ repo, base }`) and a stage names its repo with `repo`. Each repo gets its own worktree on the run's branch, every prompt names the other repos and forbids touching them, and the final check runs in every repo; the result has `repos: [{ repo, base, worktree, final }]` and each stage in another repo carries `repo`. On opencode the preflight checks every stage repo.
- **Parallel stages in one repo**: a stage whose repo is busy runs in its own worktree on `<branch>--s<N>-<stage-slug>`, is implemented and reviewed there, then merged into the run's branch once no stage works there (`git merge --no-edit`). On a conflict the implementer resolves the merge; a merge left unfinished fails the run. The lane worktree and branch are removed after a clean merge. The lane's PR-body notes go to `<workDir>/PR-BODY-s<N>-<stage-slug>.md` in the run's worktree, and the final check folds them in.
- The planner sets `after` on every stage so independent work runs in parallel, and with `repos` it explores those repos and gives each repo its own stage.
- When a stage throws while others run, nothing new starts, the running stages finish, then the run fails with that error.

## 1.2.0

### Added

- **Planner**: a run with `goal` instead of `stages` plans the work first. A new `planner` role (`roles.planner`, session model by default) explores the repo in the worktree, writes the plan - to `plan`, or by default to the main checkout's git-excluded `<workDir>/plans/<branch-slug>.md` - with work orders and acceptance criteria, and proposes the stages. With `"planReview": true` the plan review runs on it. The run stops with `draft` (`{ files, stages, summary, questions? }`) in its result and nothing implemented; after the user approves, a second run with `plan` and the approved `stages` implements it. A planner that returns no plan file or no stage fails the run. On opencode the planner answers through `granny_submit_plan`; on Cursor through the new `granny-planner` subagent.

### Docs

- opencode: install the plugin globally. With `worktree` on, a per-project install in `<project>/.opencode/plugins/` is missing in the worktree where the role sessions run, so they have no `granny_submit_*` tools and fail.

## 1.1.0

- Plan review is opt-in: it runs only when the run has `plan` and the config sets `"planReview": true`; `planReview` defaults to `false`. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. Plan files given via `plan` reach every agent's context with the plan review on or off.
- The loop diagram and the text loop in the README and SKILL.md mark the plan review as optional.

## 1.0.0

The first release of granny-workflow: an agent skill that takes a plan to a PR-ready branch through an implement → review → judge → fix loop, and stops without pushing.

### Hosts

- **Claude Code**: a Workflow script (`engines/claude-code/workflow.js`). Every role is an `agent()` call with its own model, effort and JSON schema; resume with `resumeFromRunId` or `fromStage`.
- **opencode 2.x**: a server plugin (`engines/opencode/plugin/granny-workflow/`) with `granny_run`, `granny_status` and `granny_cancel`. Every role is a child session with its own model and permissions; `granny_cancel` interrupts every running child session and stops every review command with its whole process group.
- **Cursor and other agents**: the same loop as a manual protocol with three subagents (`granny-implementer`, `granny-reviewer`, `granny-judge`).

### The loop

- Stages: the implementer builds each stage and commits with the gates green; every stage is reviewed against its start sha, `review: false` skips the review and `implement: false` reviews work that is already written.
- Reviewers: any number, all reviewing every round in parallel. Engines `auto`, `codex` (the Codex CLI), `codex-plugin` (OpenAI's Codex plugin for Claude Code, including its adversarial review with `mode` and `focus`), `agent` (a host model with its own model and effort) and `command` (any CLI, with the `{base}`, `{out}`, `{model}` and `{prompt}` placeholders).
- Each reviewer has its own output files, log lines, finding ids (`<reviewer>-F<n>`) and Codex plugin broker, which it stops when its review ends.
- A reviewer that does not run is run once more; when it fails again the stage ends `review-failed`, naming it, with the other reviewers' findings kept as unresolved.
- Judge routing: P0/P1 findings go straight to the implementer and never reach the judge. The judge scores the rest 0-100 and merges duplicates; findings above `threshold` (default 70) are fixed, the rest are reported as residual. `maxRounds` (default 4) caps the reviews per stage.
- Review output is read from Codex-style `- [P1] Title — path:line` and `- [high] Title (path:line)` lines; when the parser comes up short a helper agent extracts the findings, and a review that still cannot be read ends the stage `review-failed` instead of reading as clean.
- Worktree (on by default): the run works in the branch's own git worktree, reusing the one that has the branch checked out or creating one under `worktreeDir`; a dirty reused worktree stops the run before any agent starts. Granny never removes it.
- Plan review (on by default when the run has `plan`): the same reviewers, routing and round cap check the plan files against the repo before stage 1; the implementer fixes accepted findings in the plan files in place, under a dated `rN deltas` section, without committing them. A plan review that ends `round-cap` or `review-failed` stops the run before anything is implemented.
- Final check: gates, a clean tree, no AI attribution in commits, and the PR body at `<workDir>/PR-BODY.md`. Nothing is ever pushed.

### Config

- Three layers, later wins: `~/.config/granny/config.json`, `<repo>/granny.config.json`, and the run's overrides. Unknown keys and invalid values stop the run before any agent starts, with every problem and its path listed.
- Keys: `roles` (`granny`, `implementer`, `judge`), `reviewers`, `threshold`, `maxRounds`, `planReview`, `base`, `gates`, `workDir`, `worktree`, `worktreeDir`, `language`, `aiAttribution`, `rules`. Models are one string or an object keyed by host.
