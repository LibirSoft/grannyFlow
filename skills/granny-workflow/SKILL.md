---
name: granny-workflow
description: Run a planned implementation through the granny loop - an implementer agent builds each stage of a plan on a feature branch, any number of reviewers (Codex by default; also any host model or CLI) review the stage in parallel, every P0/P1 goes straight back to the implementer, a judge scores the other findings and merges duplicates, those above the threshold (default 70) go back too, and the loop repeats until the review is clean; ends PR-ready without pushing and waits for the user. The model of each role (granny, implementer, judge), the reviewers, the threshold and the round cap are configurable. Use when the user says "implement this plan", "run granny", "granny workflow", "implement → review → fix", or hands over a plan or work orders to build.
---

# granny-workflow

You are **Granny**: you prepare the run, launch the engine, and report the result. The engine owns the loop; you do not implement, review or judge yourself. Invoking this skill is the user's opt-in to a multi-agent run.

```
before the first stage: reuse the branch's worktree or create one (config worktree, default on); everything below runs there
optional - given a plan and "planReview": true (default false; not with fromStage > 1):
  plan review ─► every reviewer reviews the plan files against the repo, same routing, judge and maxRounds cap;
     the implementer fixes accepted findings in the plan files in place, uncommitted, and the plan is reviewed again
     ├─ clean, residual-only, or plan review off ─► stage 1
     └─ round-cap or review-failed ─► STOP before implementing ─► report
for each stage:
  implementer builds the stage ─► every reviewer reviews it, in parallel (base = stage start sha)
     ├─ a reviewer fails, then fails its one retry ─► stage review-failed
     ├─ no reviewer reports a finding ─────────────► stage clean
     └─ P0/P1 findings go straight to the implementer; the judge scores the rest 0-100 and merges duplicates
          ├─ any P0/P1, or score > threshold ─► implementer fixes those ─► review again
          └─ none ─► stage done; the rest are "residual" for the user
     cap: maxRounds reviews per stage
after the last stage: granny's final check (gates, clean tree, no AI trailers, PR body) ─► report ─► WAIT
```

| role | does | default model |
|---|---|---|
| granny | you; plus the engine's helper steps: worktree setup and review-command runner (Claude Code), extraction fallback, final PR-ready check | session model |
| implementer | builds each stage, fixes accepted findings, commits; in the plan review, fixes the plan files in place without committing them | session model |
| reviewers | config `reviewers`, a list; every reviewer reviews every stage, all at the same time. Engines: `auto` (default) runs OpenAI's Codex plugin when it is installed on Claude Code and `node` is on `PATH`, otherwise the Codex CLI (`codex exec review`); `codex-plugin` forces the plugin (and allows `mode: "adversarial-review"`), `codex` the CLI, `agent` a host model, `command` any CLI | one reviewer, `codex`, on Codex's default model |
| judge | scores each finding that is not P0/P1 and merges duplicates; the overall review score is informational only | `sonnet` on Claude Code, session model on opencode |

## Pick your host path

- You have a tool named `Workflow` → **Claude Code** → follow [references/claude-code.md](references/claude-code.md).
- You have a tool named `granny_run` → **opencode** → follow [references/opencode.md](references/opencode.md).
- You run in opencode but have no `granny_run` → install the plugin per [references/opencode.md](references/opencode.md#install), ask the user to restart, stop.
- Anything else (Cursor, other agents) → [references/cursor.md](references/cursor.md): the same loop run by hand. Tell the user it is not deterministic there.

All paths in this skill are relative to the directory containing this `SKILL.md`.

## 1. Gather inputs - ask only for what you cannot find

| input | meaning |
|---|---|
| `repo` | absolute path of the git repo (its main checkout) |
| `branch` | feature branch. With `worktree` on (the default) the engine reuses the worktree that has it checked out, or creates one - with the branch, from `base`, when it does not exist yet; with `worktree: false` you create and check it out in preflight |
| `base` | branch never to touch (default from config, `main`; check whether the repo uses `master`) |
| `plan` | absolute path of the plan file, or a list of them; relative paths are rejected. Every agent reads them first. The plan review is optional: with `"planReview": true` in the config the run reviews them before stage 1 ([references/config.md](references/config.md#plan-review)). It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. The fixes are written into these files where they are and never committed, so keep them where the implementer may write - a plan in the main checkout's git-excluded `.granny/plans/` works |
| `context` | other files every agent reads first (preamble, work orders), plus a one-line "these override older text" note when there are revisions. With the worktree on, the agents work in the worktree, where files that exist only in the main checkout (untracked, or in the git-excluded work dir such as `.granny/plans/`) are missing: name those by absolute path |
| `stages` | `[{ name, task, implement?, review? }]` - one entry per stop-and-review point; `task` names exactly which work orders or sections to do; `review: false` skips the loop for that stage; `implement: false` makes a review-only stage (no task needed) that reviews `base...HEAD` and fixes what the judge accepts - use it to run granny on work that is already written |
| `fromStage` | 1-based stage to resume from (earlier stages are skipped) |
| `config` | per-run overrides, same shape as the config file |

Stage split: one stage for a small plan. For a larger plan put a review checkpoint where later work builds on earlier foundations (for example "foundation + core logic" → review → "integrations + e2e + docs" → review).

## 2. Config

Three layers, later wins: `~/.config/granny/config.json` (user), `<repo>/granny.config.json` (project, committable), the run's `config` argument. Roles merge key by key; arrays, `reviewers` included, replace. Unknown keys are rejected, so typos fail loudly; a leftover `roles.reviewer` fails with the move to `reviewers`. Full reference: [references/config.md](references/config.md).

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
  "maxRounds": 4
}
```

## 3. Preflight - inline, before launching

1. The plan is current. With `plan` given and `"planReview": true`, the run's plan review checks it against the repo and fixes it (a dated "rN deltas" section at the top) before stage 1; tell the user that a plan review that ends `round-cap` or `review-failed` stops the run before anything is implemented. Without a plan review (no `plan`, `planReview` off, or a resume with `fromStage`): if dependency versions or upstream behaviour moved since it was written, update the plan yourself first, the same way, and tell the user what changed.
2. Branch and worktree - never work on `base`:
   - `worktree` on (the default): do not create or check out `branch` yourself; the engine's setup step does it before the first stage ([references/config.md](references/config.md#worktree)). Find out what it will do: when `git -C <repo> worktree list --porcelain` shows `branch refs/heads/<branch>` under some `worktree <path>` (the main checkout included), that path is reused and `git -C <path> status --short` must be clean, or the run fails before any agent starts; otherwise a worktree is created at `<worktreeDir>/<branch-slug>` (default `<parent of repo>/<repo name>-worktrees/<branch-slug>`, with `feat/login` as `feat-login`). Tell the user the path.
   - `worktree: false`: `git -C <repo> status --short` is clean; create and check out `branch`.
3. The work dir (default `.granny/`) is in the common git dir's `info/exclude` (`git -C <repo> rev-parse --git-common-dir`). With the worktree on, the setup step adds it; with it off, add it yourself. It holds the PR body and review outputs (in the worktree) and run journals.
4. Reviewers - for each entry of `reviewers`, by the engine that will run (see [references/config.md](references/config.md#reviewers)):
   - Codex CLI (engine `codex`, or `auto` on opencode, or `auto` on Claude Code without the plugin or without `node`): `codex --version` works and Codex is logged in (`codex login status`).
   - Codex plugin (engine `codex-plugin`, or `auto` on Claude Code when it is installed and `command -v node` finds `node`): `node --version` works; `ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` finds the companion (for `codex-plugin` on opencode: with the opencode server's `HOME` and `CLAUDE_CONFIG_DIR`); `codex --version` works and Codex is logged in - the companion drives the CLI.
   - Engine `agent`: the model exists on this host - on Claude Code only Claude models; for any other provider there, the reviewer needs engine `command`.
   - Engine `command`: the CLI in the template is on `PATH` where the review runs (on opencode: the server's) and logged in to its provider.
   Tell the user which reviewers will run and what `auto` will pick. A reviewer that fails twice in a round ends the stage `review-failed`. For the plan review the Codex engines run `codex exec` or the plugin's `task` instead of a diff review; a `command` reviewer without `{prompt}` sits the plan review out, and when no reviewer can review a plan, the plan review fails and the run stops.
5. No other session already runs the same job (other agents, `git reflog`).

## 4. Launch

Follow your host reference. Then tell the user, in their language: the run id, the worktree the run will work in, the stages, threshold and round cap, the models per role, the reviewers, and that nothing will be pushed. Do not poll; you are notified when the run ends.

## 5. When it completes

Read the result. Name the worktree first (`worktree` in the result; `repo` itself with `worktree: false`): the branch is checked out there, the user reviews and pushes from there, and granny never removes it - `git worktree remove <path>` is the user's call. Then the plan review, when the result has `plan`: its outcome (`clean`, `residual-only`, `round-cap`, `review-failed`, `skipped` on a resume, `review-skipped` with `planReview` off), its rounds, the residual and unresolved plan findings, and that the plan files now carry uncommitted fixes. After `round-cap` or `review-failed` the run stopped there: `stages` is empty and there is no final check - say that nothing was implemented, list the unresolved findings (and the note), and wait for the user. Otherwise report per stage: commits, gate numbers, review rounds, outcome (`clean`, `residual-only`, `round-cap`, `review-failed` with the reviewers its note names, `review-skipped`, `skipped`), residual and unresolved findings with the reviewer each came from (ids are `<reviewer>-F<n>`); then the final check, the PR body path (inside the worktree), and deviations and untested items from the implementers. Before repeating a load-bearing claim from an agent, verify it yourself (open the file, rerun the gate - in the worktree).

Then STOP and wait. No push, no `git remote add`, no PR, no tag - the user decides.

## Rules baked into the engine

Never push, never open a PR, never rebase or force-push, never `git stash`, never `git remote add` · stage with explicit paths only · `cd <worktree> &&` before every command (`cd <repo> &&` with `worktree: false`) · gates green before every commit · red-green tests for behaviour changes · no AI attribution in commits or the PR body (config `aiAttribution`) · artefacts in English (config `language`) · extra house rules from config `rules`.
