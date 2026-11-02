# granny on Cursor and other hosts

Cursor has subagents but no workflow engine, so you run the loop yourself, step by step, with the same prompts and the same rules. It is not deterministic: keep strictly to the steps below and keep a written log in `<workDir>/runs/<date>/journal.md`.

## Install the subagents

Copy `engines/cursor/agents/*.md` to `~/.cursor/agents/` (all projects) or `<project>/.cursor/agents/`, and set `model:` in each file (`inherit` uses the chat's model). Cursor sometimes ignores a subagent's `model:`; check which model actually ran when it matters.

Config: read `~/.config/granny/config.json` and `<repo>/granny.config.json` yourself and apply the layering in [config.md](config.md); only `threshold`, `maxRounds`, `planReview`, `base`, `gates`, `workDir`, `worktree`, `worktreeDir`, `language`, `aiAttribution`, `rules` and `reviewers` apply here - of a reviewer, its `name`, `engine`, `mode`, `focus`, `command`, and `model` where the engine passes it on. An `agent` reviewer runs `granny-reviewer` on whatever model that subagent has.

## The worktree

With `worktree` on (the default), set it up by hand before the first stage - also when you resume with `fromStage` - by the rules the engines follow ([config.md](config.md#worktree)):

1. Add the line `/<workDir>/` to `<common dir>/info/exclude` unless it is there, where `<common dir>` is what `git -C <repo> rev-parse --git-common-dir` prints (relative to `<repo>`).
2. `git -C <repo> worktree list --porcelain`. When a `branch refs/heads/<branch>` line belongs to a `worktree <path>` entry (the main checkout included), that path is the worktree: `git -C <path> status --short` must print nothing. If it prints anything, stop before any subagent runs and tell the user - they commit or discard it, not you.
3. Otherwise, when `git -C <repo> show-ref --verify --quiet refs/heads/<branch>` succeeds: `git -C <repo> worktree add <worktreeDir>/<branch-slug> <branch>`.
4. Otherwise: `git -C <repo> worktree add -b <branch> <worktreeDir>/<branch-slug> <base>`.

`<worktreeDir>` defaults to `<parent of repo>/<repo name>-worktrees`; `<branch-slug>` is the branch with every character other than letters, digits, `.`, `_` and `-` as `-` (`feat/login` → `feat-login`). The "Granny - worktree setup" command in [prompts.md](prompts.md) does all four steps in one go and prints `[granny] worktree: <path>`. From then on the worktree is `<repo>` in every prompt and every terminal command; name it in the report and never remove it. With `worktree: false`, work in `repo` on the branch checked out there.

## Planning

With a `goal` and no stages, after the worktree: delegate to `granny-planner` with the "Planner" prompt from [prompts.md](prompts.md), the plan path filled in (default `<repo>/<workDir>/plans/<branch-slug>.md`). Check with `git status --short` that it committed nothing. Then, with `planReview` on, run the plan review below on the files it returned; report the plan, the proposed stages and the questions, and stop - implement nothing until the user approves ([config.md](config.md#planning)).

## The plan review

The plan review is optional and off by default; enable it with `"planReview": true`. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. With plan files and `planReview` on, review the plan after the worktree and before stage 1; skip it when you resume with `fromStage` above 1 ([config.md](config.md#plan-review)). It is the review loop below, steps 2-5, on the plan instead of a diff, with these differences:

- Reviewers, round N, output `<workDir>/review-plan-review-rN-<name>.md` / `.log`, run from the worktree:
  - engine `codex`, or `auto`: `codex exec --sandbox read-only -o <workDir>/review-plan-review-rN-<name>.md '<prompt>' </dev/null > <workDir>/review-plan-review-rN-<name>.log 2>&1`, with the "Plan reviewer - codex exec, the Codex plugin task and the {prompt} of a command engine" prompt from [prompts.md](prompts.md) as `<prompt>` (shell-quoted, one line).
  - engine `codex-plugin`: `node <companion> task '<prompt>' </dev/null > ….md 2> ….log`, with `CLAUDE_PLUGIN_DATA=<workDir>/codex-plugin-<name>` exported - no `--write`, no `--background`. `Codex did not return a final message.` means it did not run.
  - engine `agent`: `granny-reviewer` with the "Plan reviewer - agent engine" prompt.
  - engine `command`: only a template with `{prompt}`, filled with the same one-line prompt; a reviewer without `{prompt}` sits the plan review out - say so in the journal. No reviewer left → the plan review fails.
- Judge: `granny-judge` with the "Judge - plan review" prompt.
- Fix: `granny-implementer` with the "Implementer - plan fix" prompt. It edits the plan files in place at their absolute paths, adds (round 1) or extends (later rounds) a `## rN deltas (<date>)` section at the top with the date from `date +%F`, and never stages or commits them. Check with `git status --short` that it committed nothing.
- `clean` or `residual-only` → go on to stage 1. `round-cap` or `review-failed` → stop: implement nothing, report the plan findings left unresolved, and wait.

## The loop

Prompts: [prompts.md](prompts.md). Each subagent ends its answer with a JSON block; read that block, not the prose.

For each stage, from `fromStage` on:

1. **Implement.** Read `git rev-parse HEAD` in the worktree yourself and keep it as `startSha` - not the one the implementer reports (when they differ, say so). Delegate to `granny-implementer` with the "Implementer - stage" prompt. Then, when `git rev-list --count <startSha>..HEAD` is 0, the implementer made no commit: the stage ends `no-changes` without a review, and the stages that build on it (its `after`, or the previous stage in its repo) are not started - they end `skipped` with a note naming it.
2. **Review**, round N (N starts at 1; skip the loop when the stage has `review: false`). Run every reviewer in `reviewers` - at the same time where you can (terminal commands in the background, subagents in parallel), otherwise one after another. For a reviewer named `<name>`:
   - engine `codex`, or `auto` (the default; here it means the Codex CLI): run in the terminal, from the worktree (the repo with `worktree: false`):
     `codex exec review --base <startSha> -o <workDir>/review-<stage>-rN-<name>.md > <workDir>/review-<stage>-rN-<name>.log 2>&1`
     It can take over 10 minutes; let it finish.
   - engine `codex-plugin`: the same, with the plugin command from [config.md](config.md#the-codex-plugin) (`node <companion> review --wait --base <startSha> --scope branch > ….md 2> ….log`, or `adversarial-review … -- <focus>`), with `CLAUDE_PLUGIN_DATA=<workDir>/codex-plugin-<name>` exported for it. No companion, or no `node` on `PATH`, is a failure. Adversarial findings read `- [high] Title (file:line)`: critical/high/medium/low are P0/P1/P2/P3.
   - engine `agent`: delegate to `granny-reviewer` with the "Reviewer - agent engine" prompt.
   - engine `command`: run the reviewer's `command` from the worktree, with `{base}` = `startSha`, `{out}` = `<workDir>/review-<stage>-rN-<name>.md`, `{model}` = its model, `{prompt}` = the "Reviewer - command engine" prompt - each value shell-quoted.

   Read the findings from `- [P1] Title — file:line` lines (from the `.md`, or what the command printed when the `.md` is empty) and number each reviewer's findings `<name>-F1`, `<name>-F2`, …, noting the reviewer on each. Never invent findings. Output with no such line is clean only when it says `No findings.` (or the plugin's `No material findings.`); otherwise read it: problems it describes in prose are findings, and output that is not a finished review saying the changes have no problems means the reviewer did not run (below).

   A reviewer that exits non-zero, prints that Codex got no usable result, (agent) returns no JSON block, or whose run or subagent call fails with an error did not run: let the other reviewers finish, then run that reviewer once more. If it fails again, the stage ends `review-failed`; name the failed reviewer(s) and keep the findings of the reviewers that ran as unresolved, plus the failed reviewer's findings from the round before - also one that the judge merged into another reviewer's finding.

   No reviewer reported a finding → stage `clean`.
3. **Route.** Every P0/P1 finding (also critical/high) goes to the implementer as it is - do not give it to the judge.
4. **Judge** - only when there are other findings. Delegate to `granny-judge` with the "Judge" prompt and only those findings. A finding it marks `duplicateOf: <id>` (an id in that same list, not itself, not a cycle) is merged into that finding: report it once, list the merged ids on it, and give it the highest score of the group.
5. **Triage**, exactly: a finding is sent back when its severity is P0/P1 (or critical/high), when the judge gave it no score, or when its score is **strictly greater** than `threshold` (default 70). Everything else is residual for the user.
   - Nothing to send → stage `residual-only`.
   - Otherwise delegate to `granny-implementer` with the "Implementer - fix" prompt and only the findings to send, then go to step 2 with N+1.
   - After `maxRounds` (default 4) reviews without reaching `clean` or `residual-only` → stage `round-cap`; the last round's findings are unresolved.

Dedupe happens only among the findings that are not P0/P1, so a P2 that repeats a P1 is judged on its own; and a reviewer that labels everything P0/P1 never reaches the judge.

After the last stage, do the "Granny - final check" yourself - in every repo the stages worked in - then report per SKILL.md section 5 and wait.

## Parallel stages

The engines run independent stages together ([config.md](config.md#parallel-stages)); here you may do the same when you can run subagents in parallel, otherwise run the stages in list order - the result is the same, only slower. Keep the order rules: a stage starts only after the stages in its `after` (without `after`: the previous stage in its repo). A stage in another repo of `repos` works in that repo's own worktree, set up like the first. A stage that runs while another stage of the same repo is still busy gets its own worktree: `git -C <repo> worktree add -b <branch>--s<N>-<stage-slug> <worktreeDir>/<branch-slug>--s<N>-<stage-slug> <branch>`. After its review loop, and once no stage works in the run's worktree, run `git merge --no-edit <lane branch>` there; on a conflict hand the "Implementer - merge" prompt to `granny-implementer`, and check that `git rev-parse -q --verify MERGE_HEAD` prints nothing afterwards. Then, when the lane has no uncommitted change, `git worktree remove --force <lane>` and `git branch -d <lane branch>`.
