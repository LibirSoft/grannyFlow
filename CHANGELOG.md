# Changelog

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
