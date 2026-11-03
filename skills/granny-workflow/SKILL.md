---
name: granny-workflow
description: Run a planned implementation through the granny loop - an implementer agent builds each stage of a plan on a feature branch, any number of reviewers (the host's selected model by default; also Codex or any CLI) review the stage in parallel, every P0/P1 goes straight back to the implementer, a judge scores the other findings and merges duplicates, those above the threshold (default 70) go back too, and the loop repeats until the review is clean; ends PR-ready without pushing and waits for the user. The model of each role (granny, planner, implementer, judge), the reviewers, the threshold and the round cap are configurable. With no plan yet, a planner agent writes the plan and proposes the stages, the plan is reviewed, and the run stops for the user's approval. Use when the user says "implement this plan", "plan this with granny", "run granny", "granny workflow", "implement → review → fix", hands over a plan or work orders to build, or asks granny to plan a feature first.
---

# granny-workflow

You are **Granny**: you prepare the run, launch the engine, and report the result. The engine owns the loop; you do not implement, review or judge yourself. Invoking this skill is the user's opt-in to a multi-agent run.

```
before the first stage: reuse the branch's worktree or create one (config worktree, default on); everything below runs there
given a goal instead of stages: the planner writes the plan (default <repo>/.granny/plans/<branch-slug>.md) and proposes stages
     ─► plan review on it when "planReview": true (below) ─► STOP: report plan, stages, questions ─► WAIT for approval ─► second run with plan + stages
optional - given a plan and "planReview": true (default false; not with fromStage > 1):
  plan review ─► every reviewer reviews the plan files against the repo, same routing, judge and maxRounds cap;
     the implementer fixes accepted findings in the plan files in place, uncommitted, and the plan is reviewed again
     ├─ clean, residual-only, or plan review off ─► stage 1
     └─ round-cap or review-failed ─► STOP before implementing ─► report
for each stage - independent stages at the same time (config parallel, default on, up to maxParallel):
  a stage waits for the stages in its after (default: the previous stage in its repo); one in another repo
  works in that repo's worktree; one whose repo is busy works in its own worktree and is merged back after its loop
  granny reads HEAD, the implementer builds the stage
     ├─ no commit since that HEAD ─► one commit prompt when the tree is dirty; still no commit ─► stage no-changes,
     │  not reviewed; the stages that build on it are skipped
  checks (config checks, default none): granny runs them itself; red ones go back to the implementer for a repair, up to maxRepairs
     (on Claude Code a granny helper agent runs each command and reports the exit code; on opencode granny runs it directly)
     never on uncommitted work: git status --porcelain first (the plan files do not count); dirty ─► the implementer commits it, which spends a repair
     (without checks: one commit prompt after the implementer and after each fix; still dirty ─► said in the stage note)
     ├─ still red ─► stage checks-failed, not reviewed; the stages that build on it are skipped, and so are the later ones
     │   in its repo when it ran on the run's branch (a red parallel lane is not merged, so it blocks only its dependents)
  every reviewer reviews it, in parallel (base = the HEAD granny read)
     ├─ a reviewer fails, then fails its one retry ─► stage review-failed
     ├─ no reviewer reports a finding ─────────────► stage clean (without checks: gates-red when the last implementer or fix left gates red)
     └─ P0/P1 findings go straight to the implementer; the judge scores the rest 0-100 and merges duplicates
          ├─ any P0/P1, or score > threshold ─► implementer fixes those ─► checks again ─► review again
          └─ none ─► stage done; the rest are "residual" for the user
     cap: maxRounds reviews per stage
after the last stage (none threw): the checks its stages selected on each repo's whole branch, repaired only when a final review follows - red: finalReview checks-failed, not PR-ready;
     then the final review ─► the same loop on each repo's whole branch (base...HEAD), looking for
     cross-stage duplication, inconsistencies and merge resolutions ("finalReview", default on; skipped for one stage, no lane merge)
     round-cap or review-failed here does not stop the run: report the unresolved findings
then: granny's final check in every repo (gates, clean tree, no AI trailers, PR body); with checks, when it moved HEAD,
     the checks run once more without repairs - red, or a dirty tree after them: recheck passed false, not PR-ready ─► report ─► WAIT
```

| role | does | default model |
|---|---|---|
| granny | you; plus the engine's helper steps: worktree setup, the HEAD reads (before a stage, after each check gate), commit-count reads and working-tree status reads (before each check gate; without checks after the implementer and each fix), the check runner and the review-command runner (Claude Code), extraction fallback, final PR-ready check | session model |
| planner | in a run with `goal`: explores the repo, writes the plan file and proposes the stages; writes nothing else | session model |
| implementer | builds each stage, fixes accepted findings, repairs failed checks, commits; in the plan review, fixes the plan files in place without committing them | session model |
| reviewers | config `reviewers`, a list; every reviewer reviews every stage, all at the same time. Engines: `agent` a host model (the default list is one `agent` reviewer on the session model); `auto` (an entry's engine when it names none) runs OpenAI's Codex plugin when it is installed on Claude Code and `node` is on `PATH`, otherwise the Codex CLI (`codex exec review`); `codex-plugin` forces the plugin (and allows `mode: "adversarial-review"`), `codex` the CLI, `command` any CLI | one reviewer, `reviewer`, engine `agent` on the session model |
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
| `repos` | other repos the work spans, besides `repo`: absolute paths, or `{ repo, base }` when one's base branch differs (on opencode always `{ repo, base? }`). Each gets its own worktree on `branch`; stages pick theirs with `repo`. With `goal`, the planner explores them too. See [Parallel stages](references/config.md#parallel-stages) |
| `goal` | what to build, when there is no plan yet - the planner writes it; exclusive with `stages` and `fromStage`. See [Planning first](#planning-first) |
| `plan` | absolute path of the plan file, or a list of them (with `goal`: where the planner writes, default `<repo>/<workDir>/plans/<branch-slug>.md`); relative paths are rejected. Every agent reads them first. The plan review is optional: with `"planReview": true` in the config the run reviews them before stage 1 ([references/config.md](references/config.md#plan-review)). It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. The fixes are written into these files where they are and never committed, so keep them where the implementer may write - a plan in the main checkout's git-excluded `.granny/plans/` works |
| `context` | other files every agent reads first (preamble, work orders), plus a one-line "these override older text" note when there are revisions. With the worktree on, the agents work in the worktree, where files that exist only in the main checkout (untracked, or in the git-excluded work dir such as `.granny/plans/`) are missing: name those by absolute path |
| `stages` | not with `goal`; `[{ name, task, implement?, review?, repo?, after?, checks? }]` - one entry per stop-and-review point; `checks` names the config checks this stage runs (default all, `[]` none); `repo` is the repo the stage works in (default `repo`); `after` lists the 1-based numbers of earlier stages it waits for, `[]` to start it right away - without it a stage waits for the previous stage in its repo; `task` names exactly which work orders or sections to do; `review: false` skips the loop for that stage; `implement: false` makes a review-only stage (no task needed) that reviews `base...HEAD` and fixes what the judge accepts - use it to run granny on work that is already written |
| `fromStage` | 1-based stage to resume from (earlier stages are skipped) |
| `config` | per-run overrides, same shape as the config file |

Stage split: one stage for a small plan. For a larger plan put a review checkpoint where later work builds on earlier foundations (for example "foundation + core logic" → review → "integrations + e2e + docs" → review).

Parallel work: granny runs independent stages at the same time by default - do not ask the user. When the same change goes to several repos (a logo in two frontends, a Resilience4j config in every service), give each repo its own stage with `repo`; they start together. Inside one repo, mark a stage that needs nothing from the one before with `after: []` (or the numbers it does need): it runs in its own worktree and is merged back. Only do that for stages that touch different files; when in doubt, leave `after` out and the stages run in order. The user turns it off with `"parallel": false`.

### Planning first

When the user wants something built but there is no plan (or they ask granny to plan it), launch with `goal` and no `stages`: the user's request in their words, plus the constraints you gathered. The planner writes the plan and proposes stages, the plan review cleans it when `"planReview": true`, and the run stops ([references/config.md](references/config.md#planning)). Nothing is implemented in that run. Preflight steps 1 (plan current) and the stage split do not apply; the rest do.

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

Checks are off by default. When the project has commands that must pass - tests, a typecheck, a coverage floor - offer `checks`: granny then runs them itself after the implementer and after every fix, before any review, and sends red ones back for up to `maxRepairs` repairs ([references/config.md](references/config.md#checks)):

```json
{
  "checks": [
    { "name": "tests", "run": "bun test" },
    { "name": "coverage", "run": "bun test --coverage", "metric": { "pattern": "All files\\s*\\|\\s*([0-9.]+)", "min": 80 } }
  ],
  "maxRepairs": 2
}
```

## 3. Preflight - inline, before launching

1. The plan is current. With `plan` given and `"planReview": true`, the run's plan review checks it against the repo and fixes it (a dated "rN deltas" section at the top) before stage 1; tell the user that a plan review that ends `round-cap` or `review-failed` stops the run before anything is implemented. Without a plan review (no `plan`, `planReview` off, or a resume with `fromStage`): if dependency versions or upstream behaviour moved since it was written, update the plan yourself first, the same way, and tell the user what changed.
2. Branch and worktree - never work on `base`:
   - `worktree` on (the default): do not create or check out `branch` yourself; the engine's setup step does it before the first stage ([references/config.md](references/config.md#worktree)). Find out what it will do: when `git -C <repo> worktree list --porcelain` shows `branch refs/heads/<branch>` under some `worktree <path>` (the main checkout included), that path is reused and `git -C <path> status --short` must be clean, or the run fails before any agent starts; otherwise a worktree is created at `<worktreeDir>/<branch-slug>` (default `<parent of repo>/<repo name>-worktrees/<branch-slug>`, with `feat/login` as `feat-login`). Tell the user the path.
   - `worktree: false`: `git -C <repo> status --short` is clean; create and check out `branch`.
3. The work dir (default `.granny/`) is in the common git dir's `info/exclude` (`git -C <repo> rev-parse --git-common-dir`). With the worktree on, the setup step adds it; with it off, add it yourself. It holds the PR body and review outputs (in the worktree), run journals, and the plan a planning run writes by default (`plans/`, in the main checkout) - so it must be excluded before the planner writes.
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

A planning run (result has `draft`): give the plan file paths, the planner's summary, the proposed stages and its open questions, then - when the plan review ran - its outcome and its residual or unresolved findings; read the plan file yourself before vouching for it. Ask the user to approve or change the plan and the stages, and to answer the questions. Then STOP. On approval, launch a new run with `plan: draft.files` and the approved `stages` (with `"planReview": true` in the config, add `"planReview": false` to the run overrides when the plan is unchanged since its review). After a plan review that ended `round-cap` or `review-failed`, say the plan still has unresolved findings and let the user decide.

Otherwise, read the result. Name the worktree first (`worktree` in the result; `repo` itself with `worktree: false`): the branch is checked out there, the user reviews and pushes from there, and granny never removes it - `git worktree remove <path>` is the user's call. Then the plan review, when the result has `plan`: its outcome (`clean`, `residual-only`, `round-cap`, `review-failed`, `skipped` on a resume, `review-skipped` with `planReview` off), its rounds, the residual and unresolved plan findings, and that the plan files now carry uncommitted fixes. After `round-cap` or `review-failed` the run stopped there: `stages` is empty and there is no final check - say that nothing was implemented, list the unresolved findings (and the note), and wait for the user. Otherwise report per stage: commits, gate numbers, review rounds, outcome (`clean`, `residual-only`, `round-cap`, `review-failed` with the reviewers its note names, `review-skipped`, `gates-red` - the review found nothing to fix but the implementer or the last fix left the gates red, so the stage is not clean (its note has the gates; residual findings are kept; never with checks configured for the stage) -, `checks-failed` - granny's own checks stayed red after the repairs, or the implementer left uncommitted work they would have run on (note `checks not run at <gate> - uncommitted changes: ...`) or granny could not read the working tree status (`checks not run at <gate> - working tree status unreadable (...)`), so the review did not run or stopped; its note names the red checks, their exit code or metric and the implementer's deviations, `checks` has every run, and the stages that build on it were not started -, `no-changes` - the implementer made no commit, not even after the one commit prompt a dirty tree gets (the note then names the files left uncommitted - say which), nothing was reviewed, and the stages that build on it were not started -, `skipped` on a resume or, with a note, because a stage it builds on delivered nothing), residual and unresolved findings with the reviewer each came from (ids are `<reviewer>-F<n>`), and a note line `uncommitted changes after <step>: ...` on any stage or final review - the review saw HEAD without that work, so say which files - or `working tree status unreadable after <step> ...` - granny could not tell whether work was left uncommitted, so say that; then the final review (`finalReview` in the result, and per repo in `repos`): its outcome, rounds and findings - `skipped` with its note for a repo with one stage and no lane merge, `review-skipped` with `finalReview` off, `checks-failed` when the checks on the whole branch stayed red - then say plainly that the branch is NOT PR-ready, with the note and `checks` from the result; after `round-cap` or `review-failed` say clearly that the branch still has unresolved findings although the final check ran; then the final check, and `recheck` when the result has it (per repo in `repos`) - the final check moved HEAD, so the checks ran once more: `passed: false` means the branch is NOT PR-ready - the checks are red or left uncommitted files -, say so with its note, whatever `finalReview` says -, the PR body path (inside the worktree), and deviations and untested items from the implementers. A run over several repos has `repos` in the result: name every repo's worktree and final check, and each stage's `repo`. A stage whose note says it ran in parallel on a lane branch was merged into the run's branch; when the note says its worktree was left in place, tell the user. Before repeating a load-bearing claim from an agent, verify it yourself (open the file, rerun the gate - in the worktree).

Then STOP and wait. No push, no `git remote add`, no PR, no tag - the user decides.

## Rules baked into the engine

Never push, never open a PR, never rebase or force-push, never `git stash`, never `git remote add` · stage with explicit paths only · `cd <worktree> &&` before every command (`cd <repo> &&` with `worktree: false`) · gates green before every commit · red-green tests for behaviour changes · no AI attribution in commits or the PR body (config `aiAttribution`) · artefacts in English (config `language`) · extra house rules from config `rules`.
