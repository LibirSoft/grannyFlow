# granny config reference

Layers, later wins:

1. built-in defaults (below)
2. `~/.config/granny/config.json` - user (`$XDG_CONFIG_HOME/granny/config.json`; opencode also honours `$GRANNY_CONFIG`)
3. `<repo>/granny.config.json` - project, safe to commit
4. the run's `config` argument

`roles.<role>` objects merge key by key (set a key to `null` to drop it); every other key, `reviewers` included, replaces the lower layer. Unknown keys and invalid values stop the run before any agent starts, with every problem listed and its path (`reviewers[2].focus ...`).

## Keys

| key | default | meaning |
|---|---|---|
| `roles.granny` | `{}` | model/effort for granny's helper steps: the worktree setup and the review-command runner (Claude Code), the extraction fallback, the final PR-ready check |
| `roles.planner` | `{}` | writes the plan and proposes the stages in a run with `goal` ([Planning](#planning)) |
| `roles.implementer` | `{}` | builds each stage and fixes accepted findings; fixes the plan in the plan review |
| `roles.judge` | `{ "model": { "claude-code": "sonnet" } }` | scores each finding that is not P0/P1 0-100 and marks duplicates |
| `reviewers` | `[{ "name": "codex", "engine": "auto" }]` | the reviewers; every one of them reviews every round, all at the same time - see [Reviewers](#reviewers) |
| `threshold` | `70` | a finding is sent back to the implementer when it is P0/P1 (also `critical`/`high`; these skip the judge), when the judge gave it no score, or when its score is **strictly above** this. The overall review score gates nothing |
| `maxRounds` | `4` | review rounds per stage, for the plan review and for the final review; the stage ends `round-cap` after the last one |
| `planReview` | `false` | `true`: with a `plan` in the run's input, review the plan files before stage 1 - see [Plan review](#plan-review). It costs extra tokens; no effect without `plan` |
| `finalReview` | `true` | after the last stage, review each repo's whole branch (`<base>...HEAD`) once more for cross-stage duplication, inconsistencies and merge resolutions - see [Final review](#final-review). Skipped for a repo with one stage and no lane merge; `false`: never |
| `parallel` | `true` | run independent stages at the same time - stages in different repos, and stages whose `after` frees them from the one before; a same-repo stage runs in its own worktree and is merged back - see [Parallel stages](#parallel-stages). `false`: one stage at a time, in list order |
| `maxParallel` | `3` | the most stages running at once (each runs its own reviewers too) |
| `base` | `"main"` | branch never to touch; the run's `base` argument overrides it |
| `gates` | `"auto"` | `"auto"`: agents discover the project's test/lint/build/typecheck commands. Or a list, e.g. `["bun test", "bun run check", "bun run build"]` |
| `workDir` | `".granny"` | repo-relative, git-excluded: PR body, review outputs, run journals |
| `worktree` | `true` | work in the branch's own git worktree: reuse the one that has the branch checked out, or create one - see [Worktree](#worktree). `false`: work in `repo`, on the branch checked out there |
| `worktreeDir` | `<parent of repo>/<repo name>-worktrees` | where new worktrees go: an absolute path, or a path relative to the repo's parent directory (`~` is not expanded). A worktree is `<worktreeDir>/<branch-slug>` |
| `language` | `"English"` | language of code, comments, commits and the PR body |
| `aiAttribution` | `false` | `false` forbids Co-Authored-By / "Generated with" lines and the final check greps for them |
| `rules` | red-green tests; code comments default none | extra house rules appended to every working prompt; `[]` removes them |
| `$schema` | | accepted and ignored, so an editor can point a config file at a JSON schema of your own; granny ships none |

There is no `roles.reviewer`: a config that has one is rejected with the migration - move its keys into `"reviewers": [{ "name": "codex", ...the same keys }]`, and a custom `command` into an entry with `"engine": "command"`.

## Models per host

A role's or a reviewer's `model` is either one string for every host, or an object keyed by host:

```json
{
  "roles": { "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" } } },
  "reviewers": [{ "name": "codex", "engine": "codex", "model": "gpt-5.5" }]
}
```

- **Claude Code** passes it to `agent({ model })`: `opus`, `sonnet`, `haiku`, or a model ID the session accepts. `effort` (`low`, `medium`, `high`, `xhigh`, `max`) is passed as the agent's reasoning effort.
- **opencode** needs `provider/model`, optionally `#variant` (`anthropic/claude-sonnet-5-5#high`); list them with `opencode models`. `effort` is ignored - use the variant suffix. A role with no model uses the model of the session that called `granny_run`.
- **Cursor** reads no config; set `model:` in the subagent files (see cursor.md).

A host key that is missing means "inherit" on that host. Reviewers take `model` and `effort` from their own entry, never from a role.

## Worktree

With `worktree` on (the default) a setup step runs before the first stage - also on a resume and with `fromStage` - and picks where the run works:

1. The branch is checked out somewhere, as `git worktree list --porcelain` lists it (the main checkout included): that path is reused.
2. The branch exists but no worktree has it: `git worktree add <worktreeDir>/<branch-slug> <branch>`.
3. The branch does not exist: `git worktree add -b <branch> <worktreeDir>/<branch-slug> <base>`.
4. The reused worktree has uncommitted changes: the run fails before any agent starts, with that worktree's `git status --short` in the error. Commit or discard them, then run again.

A resumed run, or one started again with `fromStage`, finds the worktree the first run made (case 1). `<branch-slug>` is the branch with every run of characters other than letters, digits, `.`, `_` and `-` turned into `-`, case kept (`feat/login` → `feat-login`). For repo `/work/app` and branch `feat/login` the new worktree is `/work/app-worktrees/feat-login`; with `"worktreeDir": "trees"` it is `/work/trees/feat-login`.

Before it looks at the worktree, the step adds `/<workDir>/` to the common git dir's `info/exclude` (once), so the work dir never counts as a change. The step is a generated shell script, like the review script: on Claude Code a granny helper agent with write access runs it (label `worktree`, phase "Worktree"), on opencode the plugin runs it directly ([prompts.md](prompts.md) shows it). It prints `[granny] worktree: <path>`, and the engine logs `worktree: <path>`.

From then on everything happens in that worktree: every agent prompt (`Working repo: <worktree>`, `cd <worktree> &&`), every review command, the gates, the review outputs and the PR body in `<worktree>/<workDir>/`, and the final check. The run's result names it as `worktree`. Granny never removes it: the user reviews and pushes from there.

- Files that exist only in the main checkout - untracked, or in its git-excluded work dir - are not in a new worktree. Give plan files as `plan`, and other such files in `context`, by absolute path.
- The project config is still read from `<repo>/granny.config.json`, the main checkout as it is.
- On opencode the run files stay in `<repo>/<workDir>/runs/<id>/`, so `granny_status` finds runs by `repo`.

With `worktree: false` the run works in `repo` itself, on the branch you checked out there.

## Planning

A run with `goal` instead of `stages` plans the work and stops; it implements nothing. `goal` says what to build, in the user's words plus whatever granny gathered; `context` works as in any run. In phase "Plan", after the worktree setup, the planner (role `planner`, write access, label `plan`) explores the repo in the worktree and writes the plan to `plan` - one absolute path or a list - or, without `plan`, to `<repo>/<workDir>/plans/<branch-slug>.md` in the main checkout (git-excluded, so never committed; `feat/login` → `feat-login.md`). An existing file there is revised, not replaced. The plan names the current state of the code, the approach, work orders `WP-01`, … with files, steps and testable acceptance criteria, the gates, risks and open questions. The planner returns `{ files, stages: [{ name, task, after, repo? }], summary, questions? }`: it marks each stage's `after` (`[]` for one that can start right away) so independent work runs in parallel, and with `repos` in the input it explores those repos too and gives each repo its own stage; a planner that returns nothing, no absolute plan path or no stage with a task fails the run.

The files it returned are then the run's plan: with `"planReview": true`, the plan review below runs on them as on any plan. Then the run ends with `draft` (the planner's result), `plan` (the plan review's outcome, `review-skipped` with `planReview` off), `stages: []` and `final: null`. Granny shows the user the plan, the proposed stages and the open questions, and waits. Once the user approves - after editing the plan or the stages if they want - granny launches a second run with `plan: draft.files` and the approved `stages`; with the plan review on, add the run override `"planReview": false` when the plan is unchanged since its review, so it is not reviewed twice. `goal` is exclusive with `stages` and `fromStage`.

## Parallel stages

A run can span several repos and run stages side by side. On by default (`"parallel": true`); `"parallel": false` runs one stage at a time in list order, as before.

**Inputs.** `repos` lists the other repos the work touches, besides `repo` (the primary): absolute paths, or `{ "repo": "/abs", "base": "master" }` when a repo's base branch is not the run's. A stage names the repo it works in with `repo` (default: the primary). `after` lists the 1-based numbers of the earlier stages it waits for; `[]` starts it right away. A stage without `after` waits for the previous stage in the same repo, so a plain list of stages in one repo still runs in order, and stages in different repos start together.

```jsonc
{
  "repo": "/work/web-a", "branch": "feat/new-logo",
  "repos": ["/work/web-b", { "repo": "/work/api", "base": "master" }],
  "stages": [
    { "name": "logo web-a", "task": "WP-01" },
    { "name": "logo web-b", "task": "WP-01", "repo": "/work/web-b" },
    { "name": "resilience4j", "task": "WP-02", "repo": "/work/api" },
    { "name": "retry config", "task": "WP-03", "repo": "/work/api", "after": [] }
  ]
}
```

**Scheduling.** A stage starts once every stage it waits for has finished (whatever its outcome), with at most `maxParallel` running. Stages before `fromStage` count as finished. When a stage throws (an implementer that returns nothing, a worktree that cannot be set up), nothing new starts, the stages already running finish, then the run fails with that error.

**Several repos.** Each repo the stages use gets its own worktree on the run's branch, set up like the primary's ([Worktree](#worktree)); with a `worktreeDir`, other repos' worktrees are `<worktreeDir>/<repo name>-<branch-slug>` so they do not collide. Every prompt names the other repos' worktrees and forbids touching them. After the last stage, the final check runs in every repo (labels `pr-ready check` and `pr-ready check <repo name>`), and the result's `repos` lists `{ repo, base, worktree, finalReview?, final }` for each; `worktree`, `finalReview` and `final` stay the primary's. Each stage in another repo carries `repo` in the result. Only the primary's `granny.config.json` is read: a `gates` list applies to every repo, so keep `"auto"` when the repos differ.

**The same repo.** A stage whose repo is busy with another stage runs in its own worktree on the branch `<branch>--s<N>-<stage-slug>`, branched from the run's branch as it is when the stage starts (logged `<stage>: <branch> is busy in <repo> - running in parallel on <lane branch>`). It is implemented and reviewed there, and writes its PR-body notes to `<workDir>/PR-BODY-s<N>-<stage-slug>.md` in the run's worktree; the final check folds them into the PR body. Once its review loop ends, granny waits until no stage is working in the run's worktree, then runs `git merge --no-edit <lane branch>` there. On a conflict the implementer resolves it (label `resolve merge <stage>`) and concludes the merge; a merge it leaves unfinished fails the run. Then the lane worktree is removed and its branch deleted (only when the lane has no uncommitted change; otherwise both stay, and the stage's note says so). The stage's `note` records `ran in parallel on <lane branch>, merged`. Only stages with no shared files belong in parallel; the planner marks them with `after`.

## Final review

Each stage is reviewed on its own diff, so nothing looks at the branch as a whole: duplication between stages, stages that disagree with each other, and the implementer's conflict resolutions after parallel lanes are merged. The final review does. It is on by default; `"finalReview": false` turns it off (the result says `review-skipped`).

It runs once every stage has finished - not when a stage threw and the run failed - in phase "Final review", before the final check, so the PR body includes its fixes. For each repo that had stages it runs the stage review loop on that repo's run branch with the diff `<base>...HEAD` (the repo's base, so the whole branch since the merge-base): every reviewer, the one retry, P0/P1 straight to the implementer, the judge, `threshold` and `maxRounds`. Its name is `final review` (`final review <repo name>` for another repo of `repos`), so the labels read `review final review r<n> <reviewer>`, `judge final review r<n>` and `fix final review r<n>`, and the outputs are `<workDir>/review-final-review-r<n>-<reviewer>.md`. The judge prompt, an `agent` reviewer's prompt and a `command` reviewer's `{prompt}` carry a note that this is the whole-branch review: look across the stages for duplicated code and inconsistencies, and check the merge commits and their conflict resolutions especially ([prompts.md](prompts.md)). The Codex engines (`codex`, `codex-plugin`, `auto`) take no prompt for a diff review, so they review the whole branch diff without that note. The fixes are made by the implementer on the run's branch, like a stage's.

A repo with exactly one stage and no lane merge is skipped - its stage review already covered the same diff - with the log line `final review skipped - one stage and no lane merge, so its stage review already covered the whole branch` and outcome `skipped` (that holds for a single stage with `review: false` too: it opted out of review). A repo no stage worked in gets no final review.

The result's `finalReview` is the primary repo's `{ outcome, rounds, residual, unresolved, history, note? }`, and each entry of `repos` carries its own `finalReview`. A final review that ends `round-cap` or `review-failed` does not stop the run: the final check still runs, the log says `final review ended <outcome> - the final check still runs, but the branch has <n> unresolved finding(s)`, and the report must say the branch still has unresolved findings.

## Plan review

The run's `plan` input is one absolute path or a list of them (a relative path is rejected before anything runs). Every agent prompt, the judge's and a command reviewer's `{prompt}` name them: `Plan files - read them first: <paths>`. The plan review is optional and off by default; enable it with `"planReview": true`. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens. With it on, the run reviews the plan files in phase "Plan review", after the worktree setup and before stage 1. It is skipped - and the result's `plan` says `skipped` - when the run resumes with `fromStage` > 1; with `planReview` off the result's `plan` says `review-skipped`. A run without `plan` has no `plan` in its result.

The loop is a stage's review loop on the plan files instead of a diff: every reviewer in parallel, the one retry, P0/P1 straight to the implementer, the judge for the rest (with a plan-review judge prompt) and its duplicates, `threshold`, and the `maxRounds` cap. Labels and log lines read `plan review r<n> <name>`, the outputs are `<workDir>/review-plan-review-r<n>-<name>.md` and `.log`, and finding ids are `<name>-F<n>` as in a stage. Each reviewer gets a plan-review prompt asking, against the actual repo, for wrong assumptions about the code or its dependencies, missing steps, risky ordering, acceptance criteria that cannot be tested, and version drift, in the form `- [P1] Title — <absolute plan path>:<line>` ([prompts.md](prompts.md) shows it). Findings keep that absolute path.

| `engine` | plan review runs |
|---|---|
| `codex`, and `auto` on opencode | `codex exec --sandbox read-only [-m <model>] -o <out> <prompt> </dev/null` - stdin is closed because `codex exec` appends a piped stdin to the prompt |
| `codex-plugin`, and `auto` on Claude Code with the plugin | the companion's `task` command, read-only (no `--write`) and in the foreground (no `--background`): `node <companion> task [-m <model>] <prompt>`, with the same lookup, `node` check, own `CLAUDE_PLUGIN_DATA` and broker shutdown as the diff review. `auto` without the companion or `node` falls back to `codex exec` above; `codex-plugin` fails. `mode` and `focus` do not apply to a plan |
| `agent` | the "Plan reviewer - agent engine" prompt in a read-only subagent |
| `command` | the template with `{prompt}` filled with the plan-review prompt (`{base}` is the run's base: the `base` input when given, else the config's `base`). A template without `{prompt}` cannot review a plan: it is skipped for the plan review with the log line `plan review: reviewer <name> skipped - its command has no {prompt}, so it cannot review a plan`. When that leaves no reviewer, the plan review fails |

The companion's `Codex did not return a final message.` (an empty `task` answer, exit 0) means the reviewer did not run, like the diff review's no-result renders.

The fix step is the implementer with write access (label `fix plan review r<n>`). It edits the plan files in place at their absolute paths and never stages or commits them: in a worktree, a plan that is untracked in the main checkout does not exist, so the absolute path is the only copy. In round 1 it adds a section `## rN deltas (<date>)` at the top of each plan file it changes (N one higher than the highest one already there, r1 when there is none), in later rounds it extends that section; the date comes from `date +%F` in its shell. It returns the files it changed, what it changed per finding id, and the findings it did not apply in `deviations`. The implementer must be able to write the plan's path: on opencode its session works in the worktree, so keep the plan inside the worktree or the main checkout's git-excluded `<workDir>/` and check that your permissions let a session edit it.

| plan review outcome | then |
|---|---|
| `clean`, `residual-only` | stage 1 starts; the residual plan findings are in the result for the user |
| `round-cap`, `review-failed` | **fail closed**: the run stops before implementing. The result has `plan` with `{ outcome, rounds, residual, unresolved, history, note? }`, an empty `stages` and `final: null`; the log ends `plan review ended <outcome> - stopping before stage 1; nothing was implemented` |

## Reviewers

`reviewers` is a list, one entry per reviewer. Every round all of them review the stage in parallel: on Claude Code as concurrent `agent()` calls, on opencode as concurrent child sessions and commands.

| key | values | |
|---|---|---|
| `name` | unique; `a-z`, `0-9`, `-` | names the reviewer's output files, log lines and finding ids. Omitted: `<engine>-<n>`, with `n` its 1-based position (`agent-2`) |
| `engine` | `auto` (default), `codex`, `codex-plugin`, `agent`, `command` | which reviewer runs, below |
| `model` | a string or an object keyed by host | the Codex engines pass it as `-m`; `agent` runs that host model; `command` puts it in `{model}` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | the agent's reasoning effort, for engine `agent` on Claude Code; the other engines do not use it |
| `mode`, `focus` | | the Codex plugin only (engines `auto` and `codex-plugin`) - see [The Codex plugin](#the-codex-plugin) |
| `command` | a command template | engine `command` only, and required there - see [Command reviewers](#command-reviewers) |

| `engine` | runs |
|---|---|
| `auto` (default) | on Claude Code: the Codex plugin when its companion script is installed and `node` is on `PATH`, otherwise the Codex CLI. On opencode: always the Codex CLI |
| `codex-plugin` | OpenAI's Codex plugin for Claude Code, on either host. When the companion script is missing, or `node` is not on `PATH`, the reviewer fails with a note saying so - it never falls back to the CLI |
| `codex` | the Codex CLI: `codex exec review` |
| `agent` | a read-only host subagent reviews the diff with the "Reviewer - agent engine" prompt, on this entry's `model` and `effort`. On Claude Code that means Claude models only (`opus`, `sonnet`, `haiku`, a Claude model ID); to have GLM or another provider review there, use engine `command` with a CLI that reaches it, such as `opencode run`. On opencode, any `provider/model` the server has |
| `command` | your command, any CLI - see [Command reviewers](#command-reviewers) |

Codex, Opus and GLM reviewing every stage. On opencode the GLM reviewer is an agent on a provider model:

```json
{
  "reviewers": [
    { "name": "codex", "engine": "auto" },
    { "name": "opus", "engine": "agent", "model": { "opencode": "anthropic/claude-opus-5-5" } },
    { "name": "glm", "engine": "agent", "model": { "opencode": "opencode/glm-5.3-flash-free" } }
  ]
}
```

On Claude Code it goes through `opencode run`, because a Claude Code agent runs Claude models only:

```json
{
  "reviewers": [
    { "name": "codex", "engine": "auto" },
    { "name": "opus", "engine": "agent", "model": "opus", "effort": "high" },
    { "name": "glm", "engine": "command", "command": "opencode run -m opencode/glm-5.3-flash-free {prompt}" }
  ]
}
```

### Each reviewer on its own

- Output files: `<workDir>/review-<stage>-r<n>-<name>.md` and `.log`.
- Log line every round: `<stage> r<n> <name>: reviewer: <backend>`.
- Finding ids: `<name>-F1`, `<name>-F2`, … Each finding also carries `reviewer: "<name>"` into the judge prompt, the fix prompt, the round history, residual and unresolved.
- Codex plugin broker: `<workDir>/codex-plugin-<name>` (below).

### A reviewer that does not run

A reviewer did not run when its command exits non-zero, when the Codex plugin says it got no usable result (below), when an agent reviewer returns nothing, when an extraction of its output stays short (below), or when a call it needs fails with an error (an opencode session request, the command runner, an extraction agent) - the note then reads `reviewer call failed: <error>`. The round waits for every reviewer before it ends, so one reviewer's error never cuts the others short. It is run once more, on its own - the other reviewers keep their results - with labels and log lines tagged `#2`, after the log line `<stage> r<n> <name>: did not run - retrying once. <why>`. If it fails again, the stage ends `review-failed`: the note names every reviewer that failed with its last error, and `unresolved` keeps the findings of the reviewers that did run (and the failed reviewer's findings from the round before, also those the judge merged into another reviewer's finding: a merged finding it kept stays merged, one it lost to another reviewer comes back under its own id), so nothing is lost. A stage is `clean` only when every reviewer ran and none reported a finding.

### Judge routing

1. P0/P1 findings (also `critical`/`high`) go straight to the implementer. They are never sent to the judge and have no score.
2. The judge is called only when there are other findings. It scores each of them 0-100 and may mark one `duplicateOf: <id>` when it reports the same problem as another finding in its list. The duplicate is merged into the finding it points at, which is reported once, lists the merged ids in `duplicates` and takes the highest score of the group (none when any of them is unscored), so a merge never drops a finding that would have been fixed. The log says `<stage> r<n>: judge merged <id> into <id> (duplicate)`. A `duplicateOf` that points at itself, at an id not in the list, or back in a cycle is ignored.
3. A finding above `threshold`, or one the judge gave no score (also when the judge returned nothing), goes to the implementer; the rest are residual for the user.

Two consequences:

- Dedupe happens only among the findings that are not P0/P1. A P2 that duplicates a P1 is scored on its own, and may reach the implementer next to the P1.
- A reviewer that labels everything P0/P1 bypasses the judge: every finding it reports goes to the implementer.

### The Codex plugin

The plugin path runs the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs` from the worktree - the highest `<version>`, compared numerically field by field (`1.10.0` after `1.9.3`) with `sort -t. -k1,1n -k2,2n -k3,3n`, which BSD/macOS `sort` runs too:

```
node <companion> review --wait --base <stage start sha> --scope branch [-m <model>]
node <companion> adversarial-review --wait --base <stage start sha> --scope branch [-m <model>] [-- <focus>]
```

Its stdout goes to the reviewer's `.md` file and its progress to the `.log`, the same files the CLI uses. The plugin needs `node` on `PATH` (checked with `command -v node` before the companion runs), and the Codex CLI installed and logged in (the companion drives it). The engine logs which backend ran each round, so you can see what `auto` chose:

```
<stage> r<n> <name>: reviewer: codex-plugin review (<companion path>)
<stage> r<n> <name>: reviewer: codex CLI (codex exec review) - no Codex plugin companion at <dir>/<version>/scripts/codex-companion.mjs
<stage> r<n> <name>: reviewer: codex CLI (codex exec review) - node is not on PATH for the Codex plugin companion at <companion path>
<stage> r<n> <name>: reviewer: codex-plugin review unavailable - node is not on PATH for the Codex plugin companion at <companion path>; install Node.js
```

The companion talks to Codex through an app-server broker it starts in the background (`app-server-broker.mjs` with a `codex app-server` child) and leaves running when it exits. Granny gives each plugin reviewer its own plugin data directory, `<workDir>/codex-plugin-<name>` (as `CLAUDE_PLUGIN_DATA`), so a review never shares or stops the broker of another reviewer running next to it or of a Claude Code session working in the same repo, and stops its own broker with the plugin's `scripts/session-lifecycle-hook.mjs SessionEnd` when the review script exits - after the review, after a failure, and on SIGTERM, SIGINT or SIGHUP (so `granny_cancel` on opencode stops it too). A SIGKILL skips that step and leaves the broker running.

| key | values | |
|---|---|---|
| `mode` | `review` (default), `adversarial-review` | `review` is Codex's built-in reviewer; `adversarial-review` is the plugin's skeptical, ship/no-ship review with `critical`/`high`/`medium`/`low` findings. It needs the plugin: engine `codex-plugin`, or `auto` on Claude Code, where a missing companion or a missing `node` fails the reviewer instead of running a plain CLI review |
| `focus` | non-empty string | extra instructions for `adversarial-review` only (the plain review takes no focus text), passed shell-quoted after `--` |

Rejected before any agent starts: `mode` on engines `codex`, `agent` and `command`; `adversarial-review` with `auto` on opencode (where `auto` means the CLI); `focus` without `adversarial-review`.

An adversarial review on both hosts:

```json
{ "reviewers": [{ "name": "codex", "engine": "codex-plugin", "mode": "adversarial-review", "focus": "data loss, retries and auth" }] }
```

### Command reviewers

Engine `command` runs the entry's `command` from the worktree (`repo` with `worktree: false`). Placeholders:

| placeholder | filled with |
|---|---|
| `{base}` | the stage start sha; in the plan review, the run's base |
| `{out}` | the file the review should be written to |
| `{model}` | the entry's `model` for this host; empty without one |
| `{prompt}` | a review prompt the engine writes for the stage - one line, asking for the finding format below ("Reviewer - command engine" in [prompts.md](prompts.md)) |

The template must contain `{base}` or `{prompt}`. Every value is substituted already shell-quoted, in one pass, so do not put quotes around a placeholder. The engine deletes `{out}` and the reviewer's log first, then reads `{out}` when the command left it non-empty, otherwise everything the command printed. A non-zero exit means the reviewer did not run.

With `{prompt}`, any CLI that answers a prompt can review:

```json
{
  "reviewers": [
    { "name": "glm", "engine": "command", "command": "opencode run -m opencode/glm-5.3-flash-free {prompt}" },
    { "name": "claude", "engine": "command", "command": "claude -p {prompt}" },
    { "name": "gemini", "engine": "command", "command": "gemini -p {prompt}" }
  ]
}
```

With `{base}`, the command reviews the diff itself, the way `codex exec review --base {base} -o {out}` does - for example `my-review --since {base} --out {out}`.

A command reviewer runs with the permissions its CLI grants. The prompt tells it not to edit, stage or commit, but granny does not enforce that; use the CLI's read-only mode or agent where it has one.

### Reading the output

Findings are read from lines shaped like Codex's output - the built-in reviewer's form, and the Codex plugin's `adversarial-review` form:

```
- [P1] Title — path/to/file.ts:12-14
  Detail, indented, any number of lines.

- [high] Title (path/to/file.ts:12-14)
  Detail, indented.
  Recommendation: what to change.
```

The word severities map to `critical` → P0, `high` → P1, `medium` → P2, `low` → P3; for them the location is the last parenthesised part of the line (an ` — ` location is accepted too). Other bracketed words (`[note]`) are not findings. A marker bullet indented under a finding belongs to that finding's detail; it is neither a finding nor a marker. If the output has more markers than parseable findings, a granny helper agent extracts them instead. If it recovers fewer findings than markers, it is asked once more with the expected count; still short, the reviewer did not run (above), and when the retry ends short too, the stage ends `review-failed` with the marker, parser and extraction counts and the raw review output in its note - findings are never dropped silently and the stage is never reported clean. Output in which the Codex plugin says it got no usable result (`Codex did not return valid structured JSON.`, `Codex returned JSON with an unexpected review shape.`, `Codex review completed without any stdout output.`, and for the plan review's `task`, `Codex did not return a final message.`) also means the reviewer did not run, even when the command exited 0. Output with no marker at all reads as a clean review, and `codex exec review` can produce that when it could not review: with its sandbox unable to run commands (for example `bubblewrap` missing from `PATH`) it exits 0 with a sentence like `Review could not be completed: ... No code was inspected`. Check the reviewer's `.md` when a stage ends clean suspiciously fast.

## Example: everything set

```json
{
  "roles": {
    "granny": { "model": "sonnet", "effort": "medium" },
    "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5#high" }, "effort": "high" },
    "judge": { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5" } }
  },
  "reviewers": [
    { "name": "codex", "engine": "auto", "mode": "review" },
    { "name": "opus", "engine": "agent", "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" }, "effort": "high" },
    { "name": "glm", "engine": "command", "command": "opencode run -m opencode/glm-5.3-flash-free {prompt}" }
  ],
  "threshold": 70,
  "maxRounds": 4,
  "planReview": true,
  "base": "main",
  "gates": ["bun test", "bun run check", "bun run build"],
  "workDir": ".granny",
  "worktree": true,
  "worktreeDir": "/work/worktrees",
  "language": "English",
  "aiAttribution": false,
  "rules": ["Code comments: default none."]
}
```
