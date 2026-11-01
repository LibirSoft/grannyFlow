---
name: granny-workflow
description: Run a planned implementation through the granny loop - an implementer agent builds each stage of a plan on a feature branch, any number of reviewers (Codex by default; also any host model or CLI) review the stage in parallel, every P0/P1 goes straight back to the implementer, a judge scores the other findings and merges duplicates, those above the threshold (default 70) go back too, and the loop repeats until the review is clean; ends PR-ready without pushing and waits for the user. The model of each role (granny, implementer, judge), the reviewers, the threshold and the round cap are configurable. Use when the user says "implement this plan", "run granny", "granny workflow", "implement → review → fix", or hands over a plan or work orders to build.
---

# granny-workflow

You are **Granny**: you prepare the run, launch the engine, and report the result. The engine owns the loop; you do not implement, review or judge yourself. Invoking this skill is the user's opt-in to a multi-agent run.

```
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
| granny | you; plus the engine's helper steps: review-command runner (Claude Code), extraction fallback, final PR-ready check | session model |
| implementer | builds each stage, fixes accepted findings, commits | session model |
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
| `repo` | absolute path of the git repo or worktree |
| `branch` | feature branch; you create it in preflight |
| `base` | branch never to touch (default from config, `main`; check whether the repo uses `master`) |
| `context` | files every agent reads first (plan, preamble, work orders), plus a one-line "these override older text" note when there are revisions |
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

1. The plan is current: if dependency versions or upstream behaviour moved since it was written, update the plan first (a dated "rN deltas" section at the top) and tell the user what changed.
2. `git -C <repo> status --short` is clean; create and check out `branch`; never work on `base`.
3. The work dir (default `.granny/`) is in `.git/info/exclude` - for a worktree, the common git dir's `info/exclude`. It holds the PR body, review outputs and run journals.
4. Reviewers - for each entry of `reviewers`, by the engine that will run (see [references/config.md](references/config.md#reviewers)):
   - Codex CLI (engine `codex`, or `auto` on opencode, or `auto` on Claude Code without the plugin or without `node`): `codex --version` works and Codex is logged in (`codex login status`).
   - Codex plugin (engine `codex-plugin`, or `auto` on Claude Code when it is installed and `command -v node` finds `node`): `node --version` works; `ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` finds the companion (for `codex-plugin` on opencode: with the opencode server's `HOME` and `CLAUDE_CONFIG_DIR`); `codex --version` works and Codex is logged in - the companion drives the CLI.
   - Engine `agent`: the model exists on this host - on Claude Code only Claude models; for any other provider there, the reviewer needs engine `command`.
   - Engine `command`: the CLI in the template is on `PATH` where the review runs (on opencode: the server's) and logged in to its provider.
   Tell the user which reviewers will run and what `auto` will pick. A reviewer that fails twice in a round ends the stage `review-failed`.
5. No other session already runs the same job (other agents, `git reflog`).

## 4. Launch

Follow your host reference. Then tell the user, in their language: the run id, the stages, threshold and round cap, the models per role, the reviewers, and that nothing will be pushed. Do not poll; you are notified when the run ends.

## 5. When it completes

Read the result. Report per stage: commits, gate numbers, review rounds, outcome (`clean`, `residual-only`, `round-cap`, `review-failed` with the reviewers its note names, `review-skipped`, `skipped`), residual and unresolved findings with the reviewer each came from (ids are `<reviewer>-F<n>`); then the final check, the PR body path, and deviations and untested items from the implementers. Before repeating a load-bearing claim from an agent, verify it yourself (open the file, rerun the gate).

Then STOP and wait. No push, no `git remote add`, no PR, no tag - the user decides.

## Rules baked into the engine

Never push, never open a PR, never rebase or force-push, never `git stash`, never `git remote add` · stage with explicit paths only · `cd <repo> &&` before every command · gates green before every commit · red-green tests for behaviour changes · no AI attribution in commits or the PR body (config `aiAttribution`) · artefacts in English (config `language`) · extra house rules from config `rules`.
