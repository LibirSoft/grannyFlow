# granny-workflow

## Why granny

GrannyFlow is not for designing a project from scratch and building it. It takes work that is already planned and gets it to a PR-ready branch, running independent work in parallel, so that the PR needs as little human review as possible.

What it sets out to improve is the review load: less work for the human reviewer, and better code reaching them. To get there it does not lean on skill files alone. A deterministic workflow generator builds the loop as code for Claude Code and opencode, so the limits the agents work within - stages, review rounds, thresholds, stop conditions - hold on every run instead of depending on how a prompt is read.

## What it does

An agent skill that takes a plan to a PR-ready branch: an **implementer** builds it stage by stage, any number of **reviewers** - the host model by default, Codex, any CLI - review every stage in parallel, P0/P1 findings go straight back to the implementer, a **judge** scores the rest and merges duplicates, and the findings that matter go back to the implementer until the review is clean. **Granny** - the agent you talk to - prepares the run, launches it, and reports. Nothing is pushed; you decide what happens next.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/loop-dark.svg">
  <img src="docs/images/loop-light.svg" alt="The granny loop: an optional plan review (planReview: true), then for each stage the implementer builds, optional checks run (red ones go back for a repair), reviewers review in parallel, P0/P1 go straight back, the judge scores the rest, and a final check ends with a PR-ready branch that is not pushed">
</picture>

<details>
<summary>The same loop as text</summary>

```
before the first stage: reuse the branch's worktree or create one; everything below runs there
optional - given a plan and "planReview": true (default false):
  plan review ─► the same reviewers, routing and cap; the implementer fixes the plan in place (never committed)
     ├─ clean, residual-only, or plan review off ─► stage 1
     └─ round-cap or review-failed ─► stop and report; nothing is implemented
for each stage - independent stages at the same time (parallel, default on):
  granny reads HEAD, the implementer builds the stage
     ├─ no commit since that HEAD ─► one commit prompt when the tree is dirty; still no commit ─► stage no-changes,
     │  not reviewed; the stages that build on it are skipped
  checks (config checks, default none): granny runs them itself; red ones go back to the implementer for a repair, up to maxRepairs
     never on uncommitted work: a dirty tree goes back to the implementer to commit, which spends a repair;
     a status granny cannot read, also on one more read, fails the gate
     ├─ still red ─► stage checks-failed, not reviewed; the stages that build on it, and the later ones in its repo, are skipped
  every reviewer reviews it, in parallel (base = the HEAD granny read)
     ├─ a reviewer fails, then fails its one retry ─► stage review-failed
     ├─ no reviewer reports a finding ─────────────► stage clean (without checks: gates-red when the last implementer or fix left gates red)
     └─ P0/P1 findings go straight to the implementer; the judge scores the rest 0-100 and merges duplicates
          ├─ any P0/P1, or score > threshold ─► implementer fixes those ─► checks again ─► review again
          └─ none ─► stage done; the rest are "residual" for you, with the residual of earlier rounds
     cap: maxRounds reviews per stage
     a stage in another repo works in that repo's worktree; one whose repo is busy works in its own worktree, merged back after
after the last stage (none threw): the checks its stages selected on every repo's whole branch (repaired only when a final review follows; red: not PR-ready, no final review),
     then the final review in every repo with more than one stage or a lane merge (finalReview, default on)
     ─► the same loop on the whole branch (base...HEAD): cross-stage duplication, inconsistencies, merge resolutions
then: final check in every repo (gates, clean tree, no AI trailers, PR body); with checks, when it moved HEAD,
     the checks run once more (no repairs; red: not PR-ready) ─► report ─► wait
```

</details>

The loop is code, not a prompt: on Claude Code and opencode an engine drives every step, so the threshold, round cap and stop conditions hold every time.

- **Worktree** - the run works in the branch's own git worktree: the one that already has the branch checked out, or a new one next to the repo. Your main checkout stays as it is, and granny never removes the worktree.
- **Planner** - no plan yet? Give granny the goal instead: a planner agent explores the repo, writes the plan to the git-excluded `.granny/plans/<branch>.md` and proposes the stages, and the run stops for your approval (with `"planReview": true`, after the plan review has cleaned the plan). Approve (or edit) and granny implements it in a second run.
- **Plan review** (optional, `"planReview": true`) - given plan files, the reviewers check the plan against the actual repo before anything is built; the implementer fixes it in place until it is clean, and a plan review that cannot get there stops the run. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. Without it, the plan files still go to every agent.
- **Parallel stages** (on by default, `"parallel": false` turns it off) - independent stages run at the same time. One run can span several repos (`repos`): the same logo change in two frontends, a Resilience4j config in every service - each repo gets its own worktree and its stages start together. Inside one repo, a stage that does not build on the one before (`after: []`, which the planner sets) runs in its own worktree and is merged back after its review loop; the implementer resolves a merge conflict, and granny checks with `git merge-base --is-ancestor` that the lane really is in the branch before it removes the lane - a lane that did not merge fails the run and stays where it is. A stage without `after` waits for the previous stage in its repo, so a plain stage list runs in order as before.
- **Checks** (optional, `checks`) - commands granny runs itself, not the agents: after the implementer, after every fix, on the whole branch before the final review, and once more when the final check moved HEAD. A red check - a failing exit code, or a metric such as coverage outside its bounds - goes back to the implementer for a repair, at most `maxRepairs` times; a stage that stays red is never reviewed. Granny reads `git status --porcelain` before every check run and never checks or reviews uncommitted work: the implementer is asked to commit it first (the plan files stay uncommitted and do not count). On opencode granny executes the command directly; on Claude Code a helper agent runs it and reports the exit code.
- **Reviewers** - as many as you configure, of any kind: Codex (the CLI or OpenAI's Codex plugin), a host model, or any CLI that answers a prompt. They all review every round at the same time; one that fails twice ends the stage `review-failed` instead of reading as clean.
- **Judge** - P0/P1 findings skip it and go straight to the implementer. It scores every other finding 0-100 and merges duplicates across reviewers; findings above the threshold are fixed, the rest are left for you as residual - every round's, so a stage that ends `clean` can still list residual findings from an earlier round.

## Hosts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hosts-dark.svg">
  <img src="docs/images/hosts-light.svg" alt="One core engine in src/core is built into a Claude Code Workflow script and an opencode plugin; Cursor follows the same rules by hand. Roles: granny, planner, implementer, reviewers, judge, each with its own model and effort">
</picture>

| host | engine | status |
|---|---|---|
| Claude Code | Workflow script (`engines/claude-code/workflow.js`): every role is an `agent()` call with its own model, effort and JSON schema; the reviewers are concurrent calls, and a Codex or `command` review runs detached while the engine waits for it in short helper calls | full |
| opencode 2.x | server plugin (`engines/opencode/plugin/granny-workflow/`): every role is a child session with its own model and permissions; review commands run directly, concurrently with agent reviewers | full |
| Cursor | none - the skill walks the agent through the same loop with four subagents | manual, not deterministic |

## Install

```sh
npx skills add LibirSoft/grannyFlow
```

This puts `skills/granny-workflow/` where your agents look for skills. Then, per host:

- **Claude Code** - nothing else. Optional: OpenAI's Codex plugin (`/plugin marketplace add openai/codex-plugin-cc`, then `/plugin install codex@openai-codex`); a reviewer with engine `auto` or `codex-plugin` uses it when it is installed and `node` is on `PATH`.
- **opencode** - install the plugin globally (and optionally the `granny` primary agent), then restart the service. A per-project install breaks with worktrees on, since the role sessions run in the worktree, where the plugin is missing:

  ```sh
  cp -r <skill-dir>/engines/opencode/plugin/granny-workflow ~/.config/opencode/plugins/
  cp <skill-dir>/engines/opencode/agents/granny.md ~/.config/opencode/agents/   # optional; set its model:
  opencode service restart
  ```

- **Cursor** - copy the subagents and set `model:` in each:

  ```sh
  cp <skill-dir>/engines/cursor/agents/*.md ~/.cursor/agents/
  ```

The default is one reviewer on the model you selected in the host (`"engine": "agent"`). Add others as you like: [Codex](https://github.com/openai/codex) (`"engine": "auto"`; install it and log in) or any CLI that answers a prompt (`"engine": "command"`, e.g. `"opencode run -m <provider/model> {prompt}"`). With engine `auto`, Claude Code runs the Codex review through OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) when it is installed and `node` is on `PATH`, and through the Codex CLI (`codex exec review`) otherwise; opencode always uses the CLI unless you set `"engine": "codex-plugin"`. The run log says which one ran.

## Use

Ask your agent to implement a plan with granny:

> implement plans/auth/plan.md with granny - stage 1: WP-01..03, stage 2: WP-04..06

No plan yet? Ask granny to plan it first:

> plan OAuth login with granny on feat/oauth

The planner writes `.granny/plans/feat-oauth.md` with work orders and proposed stages - the reviewers review it too with `"planReview": true` - and the run stops: you get the plan, the stages and the planner's open questions. Once you approve, granny launches the implementation run with that plan and those stages.

Granny gathers the inputs (repo, branch, base, plan files, context files, stages), runs the preflight (reviewers ready, git-excluded work dir), launches the run and tells you the run id. Every agent reads the plan files. With `"planReview": true` in the config, the run reviews the plan first: the reviewers check it against the actual repo (wrong assumptions, missing steps, risky ordering, untestable acceptance criteria, version drift), the implementer fixes the accepted findings in the plan files in place - with a dated `rN deltas` section at the top, never committed - and the plan is reviewed again until it is clean. If the plan review hits the round cap or a reviewer fails, the run stops before implementing anything and reports. The run works in the branch's own git worktree: the one that already has the branch checked out, or a new one at `<parent of repo>/<repo name>-worktrees/<branch-slug>`, created for the branch or from `base`; your main checkout stays as it is. When it ends you get the worktree path and, per stage: commits, gate numbers, review rounds, outcome and the findings left for you; plus the final check and the PR body at `.granny/PR-BODY.md` in the worktree. Review and push from the worktree; granny never removes it.

## Configure

Three layers, later wins: `~/.config/granny/config.json`, `<repo>/granny.config.json`, and per-run overrides.

```json
{
  "roles": {
    "granny":      { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" } },
    "implementer": { "model": "opus", "effort": "high" },
    "judge":       { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5" } }
  },
  "reviewers": [
    { "name": "codex", "engine": "auto" },
    { "name": "opus",  "engine": "agent", "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" } }
  ],
  "threshold": 70,
  "maxRounds": 4,
  "gates": ["bun test", "bun run check", "bun run build"]
}
```

| key | default | |
|---|---|---|
| `roles.<role>.model` | session model; judge `sonnet` on Claude Code | one string for every host, or `{ "claude-code": …, "opencode": … }` |
| `roles.<role>.effort` | inherit | Claude Code only; on opencode use a `#variant` model suffix |
| `reviewers` | `[{ "name": "reviewer", "engine": "agent" }]` | all review every round, in parallel; each has a unique `name`, an `engine` and its own `model`/`effort` |
| `reviewers[].engine` | `auto` | `auto`: the Codex plugin when installed and `node` is on `PATH` (Claude Code only), else the Codex CLI; `codex-plugin`: the plugin, required; `codex`: the CLI; `agent`: a host model (Claude models only on Claude Code); `command`: any CLI, with `{base}`, `{out}`, `{model}` and `{prompt}` placeholders |
| `reviewers[].mode` | `review` | `adversarial-review` runs the Codex plugin's adversarial review, optionally steered by `focus` |
| `threshold` | `70` | findings scoring strictly above it are fixed; P0/P1 always are, without the judge - except a repeat of a finding the fixer listed in `declined`, which the judge scores like the rest |
| `maxRounds` | `4` | review rounds per stage, and for the plan review; check repairs do not count |
| `planReview` | `false` | `true` reviews the plan files before stage 1 when the run has a `plan` (extra tokens); skipped when it resumes with `fromStage` |
| `finalReview` | `true` | after the last stage, review each repo's whole branch for cross-stage duplication, inconsistencies and merge resolutions; skipped for a repo with one stage and no lane merge |
| `parallel` | `true` | run independent stages at the same time (other repos, or `after` in the same repo); `false`: one at a time, in order |
| `maxParallel` | `3` | the most stages running at once |
| `gates` | `auto` | agents discover test/lint/build/typecheck, or list them |
| `checks` | `[]` | `[{ name, run, maxRepairs?, timeout?, metric? }]` granny runs itself before every review and the final review; a stage selects some with `checks: [names]` |
| `maxRepairs` | `2` | repairs per check gate before the stage ends `checks-failed` |
| `worktree` | `true` | work in the branch's own git worktree; `false` works in `repo` on the branch you checked out |
| `worktreeDir` | `<parent of repo>/<repo name>-worktrees` | where new worktrees go; absolute, or relative to the repo's parent |
| `aiAttribution` | `false` | forbid Co-Authored-By / "Generated with" lines |
| `language`, `rules`, `base`, `workDir` | | see the reference |

### Several reviewers

Codex, Opus and GLM reviewing every stage. On opencode every reviewer that is not Codex can be an `agent` on a provider model:

```json
{
  "reviewers": [
    { "name": "codex", "engine": "auto" },
    { "name": "opus", "engine": "agent", "model": { "opencode": "anthropic/claude-opus-5-5" } },
    { "name": "glm", "engine": "agent", "model": { "opencode": "opencode/glm-5.3-flash-free" } }
  ]
}
```

A Claude Code agent runs Claude models only, so there GLM reviews through a CLI that reaches it - `opencode run`, with `{prompt}` filled with the review prompt:

```json
{
  "reviewers": [
    { "name": "codex", "engine": "auto" },
    { "name": "opus", "engine": "agent", "model": "opus", "effort": "high" },
    { "name": "glm", "engine": "command", "command": "opencode run -m opencode/glm-5.3-flash-free {prompt}" }
  ]
}
```

Full reference: [skills/granny-workflow/references/config.md](skills/granny-workflow/references/config.md).

## Resume

- Claude Code: relaunch the Workflow with `resumeFromRunId`; finished agent calls come back from cache.
- opencode: no cache - relaunch with `fromStage` set to the first unfinished stage.

Either way the run works in the worktree the first launch used.

## Develop

```sh
bun install
bun run build   # regenerates skills/granny-workflow/engines/* and references/prompts.md from src/
bun run check   # typecheck + tests
```

`src/core` holds the loop, config, prompts and review parser, shared by both engines; `src/adapters` wires them to each host. The generated engine files are committed so the skill installs without a build step, and the tests fail when they drift from `src/`.

## License

MIT
