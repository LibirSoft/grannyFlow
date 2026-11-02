# Changelog

## 1.1.0

### Added

- **Planner**: a run with `goal` instead of `stages` plans the work first. A new `planner` role (`roles.planner`, session model by default) explores the repo in the worktree, writes the plan - to `plan`, or by default to the main checkout's git-excluded `<workDir>/plans/<branch-slug>.md` - with work orders and acceptance criteria, and proposes the stages. The plan review runs on it, and the run stops with `draft` (`{ files, stages, summary, questions? }`) in its result and nothing implemented; after the user approves, a second run with `plan` and the approved `stages` implements it. A planner that returns no plan file or no stage fails the run. On opencode the planner answers through `granny_submit_plan`; on Cursor through the new `granny-planner` subagent.

### Docs

- opencode: install the plugin globally. With `worktree` on, a per-project install in `<project>/.opencode/plugins/` is missing in the worktree where the role sessions run, so they have no `granny_submit_*` tools and fail.

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
