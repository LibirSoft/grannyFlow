# granny config reference

Layers, later wins:

1. built-in defaults (below)
2. `~/.config/granny/config.json` - user (`$XDG_CONFIG_HOME/granny/config.json`; opencode and omp also honour `$GRANNY_CONFIG`)
3. `<repo>/granny.config.json` - project, safe to commit
4. the run's `config` argument

`roles.<role>` objects merge key by key (set a key to `null` to drop it); every other key, `reviewers` included, replaces the lower layer. Unknown keys and invalid values stop the run before any agent starts, with every problem listed and its path (`reviewers[2].focus ...`).

## Keys

| key | default | meaning |
|---|---|---|
| `roles.granny` | `{}` | model/effort for the extraction fallback and the final PR-ready check |
| `roles.helper` | `{ "model": { "claude-code": "haiku" }, "effort": "low" }` | Claude Code only: model/effort for the helper agents that run granny's plain commands, because a Workflow script has no shell - the worktree setup, the HEAD, commit-count and working-tree status reads, the timeout probe, the checks, a lane's merge and cleanup, and the start, wait, read and stop steps of a Codex or `command` review. Each is given one fixed command to run once and reports its exit code and output; it decides nothing, so a cheap model is enough. On opencode granny runs these commands itself and no helper starts |
| `roles.planner` | `{}` | writes the plan and proposes the stages in a run with `goal` ([Planning](#planning)) |
| `roles.implementer` | `{}` | builds each stage, fixes accepted findings and repairs failed checks; fixes the plan in the plan review |
| `roles.judge` | `{ "model": { "claude-code": "haiku" } }` | classifies each finding that is not P0/P1 (verdict, impact, likelihood, fix cost, scope, evidence) and marks duplicates; the engine decides from that ([The decision table](#the-decision-table)). Haiku on Claude Code because the judge only classifies and the engine decides; on a measured set it matched the user's later fixes more often than Sonnet, and its errors lean toward an extra fix round rather than a real bug left open ([The judge's model](#the-judges-model)). `"roles": { "judge": { "model": "sonnet" } }` switches back. On opencode and omp the judge uses the session model |
| `reviewers` | `[{ "name": "reviewer", "engine": "agent" }]` | the reviewers; every one of them reviews every round, all at the same time - see [Reviewers](#reviewers) |
| `threshold` | `70` | a finding whose computed priority is **strictly above** this is sent back to the implementer (rule 7 of [the decision table](#the-decision-table)); P0/P1 (also `critical`/`high`) skip the judge and are always sent, and so is a finding the judge did not classify, also on its one retry. |
| `alwaysFix` | `["critical", "major"]` | impact classes the implementer always fixes, whatever their likelihood, fix cost and priority (rule 6 of [the decision table](#the-decision-table)); `[]`: only `threshold` decides. Values: `critical`, `major`, `moderate`, `minor`, `none` |
| `maxRounds` | `4` | review rounds per stage, for the plan review and for the final review; the stage ends `round-cap` after the last one. Check repairs are not review rounds and do not count |
| `planReview` | `false` | `true`: with a `plan` in the run's input, review the plan files before stage 1 - see [Plan review](#plan-review). Each round is a full review + judge + fix, so it uses many more tokens and makes the run much longer (`maxRounds` caps the rounds); set it only when the user asks for a plan review. No effect without `plan` |
| `finalReview` | `true` | after the last stage, review each repo's whole branch (`<base>...HEAD`) once more for cross-stage duplication, inconsistencies and merge resolutions - see [Final review](#final-review). Skipped for a repo with one stage and no lane merge; `false`: never |
| `parallel` | `true` | run independent stages at the same time - stages in different repos, and stages whose `after` frees them from the one before; a same-repo stage runs in its own worktree and is merged back - see [Parallel stages](#parallel-stages). `false`: one stage at a time, in list order |
| `maxParallel` | `3` | the most stages running at once (each runs its own reviewers too) |
| `base` | `"main"` | branch never to touch; the run's `base` argument overrides it |
| `checks` | `[]` | commands granny runs itself after the implementer, after every fix, on the whole branch before the final review, and once more after the final check when it moved HEAD; a red one goes back to the implementer for a repair, and one that stays red ends the stage `checks-failed` - see [Checks](#checks). `[]`: off |
| `maxRepairs` | `2` | repairs per check gate before a red check ends it `checks-failed`; a check's own `maxRepairs` overrides it |
| `gates` | `"auto"` | `"auto"`: agents discover the project's test/lint/build/typecheck commands. Or a list, e.g. `["bun test", "bun run check", "bun run build"]` |
| `workDir` | `".granny"` | repo-relative, git-excluded: PR body, review outputs, run journals |
| `worktree` | `true` | work in the branch's own git worktree: reuse the one that has the branch checked out, or create one - see [Worktree](#worktree). `false`: work in `repo`, on the branch checked out there |
| `worktreeDir` | `<parent of repo>/<repo name>-worktrees` | where new worktrees go: an absolute path, or a path relative to the repo's parent directory (`~` is not expanded). A worktree is `<worktreeDir>/<branch-slug>` |
| `language` | `"English"` | language of code, comments, commits and the PR body; the planner writes the plan and the `agent` reviewers their findings in it |
| `aiAttribution` | `false` | `false` forbids Co-Authored-By / "Generated with" lines and the final check greps for them |
| `readOnlyAgent` | `false` | Claude Code only: `true` runs `agent` reviewers, the judge and the extraction agent as the `granny-readonly` agent type (Read, Grep, Glob and Bash; no Edit or Write) with a PreToolUse hook that lets their Bash run only read-only git and shell commands - see [Read-only roles](#read-only-roles). Install the agent and the hook first; without the agent the run stops at the first reviewer with `agent type 'granny-readonly' not found`. opencode enforces read-only with permissions and ignores it |
| `watch` | `"full"` | omp and opencode: how much of a running run you can watch - `"full"` everything: on omp the live panel, an event log per role and the run navigator, on opencode the sidebar section, the prompt-footer chip, toasts and the `/granny` navigator; `"panel"` the omp panel, or the opencode sidebar section and chip, only; `"off"` none of them. The run itself is the same in every mode - see [Watching a run](#watching-a-run). Claude Code accepts it and ignores it |
| `rules` | red-green tests; code comments default none | extra house rules appended to every agent prompt that carries the run's header (the implementer's, the planner's and an `agent` reviewer's); `[]` removes them |
| `$schema` | | accepted and ignored, so an editor can point a config file at a JSON schema of your own; granny ships none |

There is no `roles.reviewer`: a config that has one is rejected with the migration - move its keys into `"reviewers": [{ "name": "codex", ...the same keys }]`, and a custom `command` into an entry with `"engine": "command"`.

## Models per host

A role's or a reviewer's `model` is either one string for every host, or an object keyed by host:

```json
{
  "roles": { "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5", "omp": "anthropic/claude-opus-5-5" } } },
  "reviewers": [{ "name": "codex", "engine": "codex", "model": "gpt-5.5" }]
}
```

- **Claude Code** passes it to `agent({ model })`: `opus`, `sonnet`, `haiku`, or a model ID the session accepts. `effort` (`low`, `medium`, `high`, `xhigh`, `max`) is passed as the agent's reasoning effort.
- **opencode** needs `provider/model`, optionally `#variant` (`anthropic/claude-sonnet-5-5#high`); list them with `opencode models`. `effort` is ignored - use the variant suffix. A role with no model uses the model of the session that called `granny_run`.
- **omp** takes what `omp --model` takes: `provider/id` (exact, `anthropic/claude-sonnet-5-5`), a fuzzy id (keyed to omp, `{ "omp": "opus" }`) or a model role from the omp settings (`slow`); list them with `omp models`. `effort` is passed as `--thinking <effort>`. A role with no model uses the model of the session that called `granny_run`.
- **Cursor** reads no config; set `model:` in the subagent files (see cursor.md).

On opencode and omp `granny_run` refuses a run with a model the host cannot run, before anything starts, with one line per entry, the config layer it came from and the fix. A Claude Code alias (`sonnet`, `opus`, ...) written as one string for every host is refused on both, so key it to `claude-code` in a config you share between hosts. Claude Code takes its aliases.

A host key that is missing means "inherit" on that host. Reviewers take `model` and `effort` from their own entry, never from a role.

## Worktree

With `worktree` on (the default) a setup step runs before the first stage - also on a resume and with `fromStage` - and picks where the run works:

1. The branch is checked out somewhere, as `git worktree list --porcelain` lists it (the main checkout included): that path is reused.
2. The branch exists but no worktree has it: `git worktree add <worktreeDir>/<branch-slug> <branch>`.
3. The branch does not exist: `git worktree add -b <branch> <worktreeDir>/<branch-slug> <base>`.
4. The reused worktree has uncommitted changes: the run fails before any agent starts, with that worktree's `git status --short` in the error. Commit or discard them, then run again.

A resumed run, or one started again with `fromStage`, finds the worktree the first run made (case 1). `<branch-slug>` is the branch with every run of characters other than letters, digits, `.`, `_` and `-` turned into `-`, case kept (`feat/login` → `feat-login`). For repo `/work/app` and branch `feat/login` the new worktree is `/work/app-worktrees/feat-login`; with `"worktreeDir": "trees"` it is `/work/trees/feat-login`.

Before it looks at the worktree, the step adds `/<workDir>/` to the common git dir's `info/exclude` (once), so the work dir never counts as a change. The step is a generated shell script, like the review script: on Claude Code a helper agent (`roles.helper`) with write access runs it (label `worktree`, phase "Worktree"), on opencode and omp the plugin or extension runs it directly ([prompts.md](prompts.md) shows it). It prints `[granny] worktree: <path>`, and the engine logs `worktree: <path>`.

From then on everything happens in that worktree: every agent prompt (`Working repo: <worktree>`, `cd <worktree> &&`), every review command, the gates, the review outputs and the PR body in `<worktree>/<workDir>/`, and the final check. The run's result names it as `worktree`. Granny never removes it: the user reviews and pushes from there.

- Files that exist only in the main checkout - untracked, or in its git-excluded work dir - are not in a new worktree. Give plan files as `plan`, and other such files in `context`, by absolute path.
- The project config is still read from `<repo>/granny.config.json`, the main checkout as it is.
- On opencode and omp the run files stay in `<repo>/<workDir>/runs/<id>/`, so `granny_status` finds runs by `repo`.

With `worktree: false` the run works in `repo` itself, on the branch you checked out there.

## Planning

A run with `goal` instead of `stages` plans the work and stops; it implements nothing. `goal` says what to build, in the user's words plus whatever granny gathered; `context` works as in any run. In phase "Plan", after the worktree setup, the planner (role `planner`, write access, label `plan`) explores the repo in the worktree and writes the plan to `plan` - one absolute path or a list - or, without `plan`, to `<repo>/<workDir>/plans/<branch-slug>.md` in the main checkout (git-excluded, so never committed; `feat/login` → `feat-login.md`). An existing file there is revised, not replaced. The plan names the current state of the code, the approach, work orders `WP-01`, … with files, steps and testable acceptance criteria, the gates, risks and open questions. The planner's prompt gives the gates as the implementer's, without the commit, stash and attribution rules: it runs no gates and commits nothing. The planner returns `{ files, stages: [{ name, task, after, repo? }], summary, questions? }`: it marks each stage's `after` (`[]` for one that can start right away) so independent work runs in parallel, and with `repos` in the input it explores those repos too and gives each repo its own stage; a planner that returns nothing, no absolute plan path or no stage with a task fails the run.

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

**Scheduling.** A stage starts once every stage it waits for has finished (whatever its outcome), with at most `maxParallel` running. Stages before `fromStage` count as finished; the first stage from `fromStage` on reviews `<base>...HEAD` when it makes no new commit (see Reading git below). When a stage throws (an implementer that returns nothing, a worktree that cannot be set up), nothing new starts, the stages already running finish, then the run fails with that error.

**Several repos.** Each repo the stages use gets its own worktree on the run's branch, set up like the primary's ([Worktree](#worktree)); with a `worktreeDir`, other repos' worktrees are `<worktreeDir>/<repo name>-<branch-slug>` so they do not collide. Every agent prompt names the other repos' worktrees; the prompts of the agents that write forbid touching them. After the last stage, the final check runs in every repo (labels `pr-ready check` and `pr-ready check <repo name>`), and the result's `repos` lists `{ repo, base, worktree, finalReview?, checks?, recheck?, final }` for each; `worktree`, `finalReview` and `final` stay the primary's. Each stage in another repo carries `repo` in the result. Only the primary's `granny.config.json` is read: a `gates` list applies to every repo, so keep `"auto"` when the repos differ.

**The same repo.** A stage whose repo is busy with another stage runs in its own worktree on the branch `<branch>--s<N>-<stage-slug>`, branched from the commit the stage busy in the run's worktree started on - not from that stage's unfinished commits, such as a failing test it commits before the fix, which would turn the lane's checks red on code it did not write (logged `<stage>: <branch> is busy in <repo> - running in parallel on <lane branch>` and `<stage>: branching <lane branch> from <sha>, where the stage still running on <branch> started, not from its unfinished commits`). When the worktree is busy with a merge or a review-only stage instead, the lane branches from the run's branch as it is then. It is implemented and reviewed there, and writes its PR-body notes to `<workDir>/PR-BODY-s<N>-<stage-slug>.md` in the run's worktree; the final check folds them into the PR body. Once its review loop ends, granny waits until no stage is working in the run's worktree, then runs `git merge --no-edit <lane branch>` there. When the merge fails, the implementer resolves the conflict (label `resolve merge <stage>`) and concludes the merge; a merge it leaves unfinished fails the run. Then granny checks that the merge really landed: `git merge-base --is-ancestor <lane branch> HEAD` in the run's worktree (label `verify merge <stage>`). A lane that is not in HEAD - a merge that failed without a conflict, such as uncommitted changes in the run's worktree that the merge would overwrite, or a merge result the Claude Code helper misreported - fails the run with `merge <stage>: <lane branch> is not merged into <branch> (git merge-base --is-ancestor exit <code>) - its worktree <path> and branch <lane branch> are left in place; merge it in <run worktree>, then resume with fromStage`, followed by the merge's output when it failed; nothing is cleaned up, so the lane's commits stay on its branch and in its worktree. A merged lane is cleaned up in one chain that starts with the same ancestry check, then requires a lane with no uncommitted change, removes the lane worktree and deletes its branch (`git branch -d`). The stage's `note` records `ran in parallel on <lane branch>, merged` (`..., merged after the implementer resolved conflicts` after a conflict). When a step of the cleanup fails, the note adds what it left: `; its worktree <path> and branch <lane branch> were left in place (<why>)` - `uncommitted changes in the worktree`, `git worktree remove failed` or `the cleanup could not confirm the merge` - or `; its worktree <path> was removed, but its branch <lane branch> was left in place`, and the log says `merge <stage>: left ... in place - remove it yourself once you have checked it`. Only stages with no shared files belong in parallel; the planner marks them with `after`.

## Final review

Each stage is reviewed on its own diff, so nothing looks at the branch as a whole: duplication between stages, stages that disagree with each other, and the implementer's conflict resolutions after parallel lanes are merged. The final review does. It is on by default; `"finalReview": false` turns it off (the result says `review-skipped`).

It runs once every stage has finished - not when a stage threw and the run failed - in phase "Final review", before the final check, so the PR body includes its fixes. For each repo that had stages it runs the stage review loop on that repo's run branch with the diff `<base>...HEAD` (the repo's base, so the whole branch since the merge-base): every reviewer, the one retry, P0/P1 straight to the implementer, the judge, `threshold` and `maxRounds`. Its name is `final review` (`final review <repo name>` for another repo of `repos`), so the labels read `review final review r<n> <reviewer>`, `judge final review r<n>` and `fix final review r<n>`, and the outputs are `<workDir>/review-final-review-r<n>-<reviewer>.md`. Its judge sees every stage review's decisions in that repo as EARLIER DECISIONS from round 1 on, so a finding a stage already decided is marked as its repeat and held to its classes ([The decision ledger and the ratchet](#the-decision-ledger-and-the-ratchet)). The judge prompt, an `agent` reviewer's prompt and a `command` reviewer's `{prompt}` carry a note that this is the whole-branch review: look across the stages for duplicated code and inconsistencies, and check the merge commits and their conflict resolutions especially ([prompts.md](prompts.md)). The Codex engines (`codex`, `codex-plugin`, `auto`) take no prompt for a diff review, so they review the whole branch diff without that note. The fixes are made by the implementer on the run's branch, like a stage's.

A repo with exactly one stage and no lane merge is skipped - its stage review already covered the same diff - with the log line `final review skipped - one stage and no lane merge, so its stage review already covered the whole branch` and outcome `skipped` (that holds for a single stage with `review: false` too: it opted out of review). A repo no stage worked in gets no final review.

The result's `finalReview` is the primary repo's `{ outcome, rounds, residual, unresolved, history, note? }`, and each entry of `repos` carries its own `finalReview`. A final review that ends `round-cap` or `review-failed` does not stop the run: the final check still runs, the log says `final review ended <outcome> - the final check still runs, but the branch has <n> unresolved finding(s)`, and the report must say the branch still has unresolved findings. With `checks`, a final check that moves HEAD is followed by one more check run without repairs ([Checks](#checks), gate `pr-ready`); when it is red, `recheck` says `passed: false` and the branch is not PR-ready, whatever `finalReview` says. The final check's prompt carries these outcomes, per stage the outcome, rounds and residual and unresolved ids and titles, plus the final review and the plan review, and tells the agent to rewrite the PR body's review section from them, replacing what an earlier run on the branch left there; a stage a resumed run skipped past keeps what the PR body says about it.

## Checks

`gates` are what the agents are told to run; whether they did is their own report (`gatesGreen`). `checks` are run by granny itself, and a stage does not reach review until they pass. Off by default (`[]`).

```json
{
  "checks": [
    { "name": "tests", "run": "bun test", "timeout": 600 },
    { "name": "typecheck", "run": "bun run typecheck", "maxRepairs": 1 },
    { "name": "coverage", "run": "bun test --coverage", "metric": { "pattern": "All files\\s*\\|\\s*([0-9.]+)", "min": 80 } }
  ],
  "maxRepairs": 2
}
```

A check is `{ name, run, maxRepairs?, timeout?, metric? }`: a unique `name`, the shell command `run`, its own repair budget (else the top-level `maxRepairs`), `timeout` in seconds - the command then runs as `timeout <s> bash -c '<run>'`; exit 124 is reported as `timed out after <s>s` - and `metric: { pattern, min?, max? }`. A check passes when its command exits 0 and, with `metric`, the **last** match of `pattern` (a JavaScript regular expression, matched with the `g` and `m` flags) in the output has a first capture group that parses as a number within `[min, max]`. No match, or no number in it, fails with `metric not found in output`. `pattern` must compile and have a capture group, and `metric` needs `min`, `max` or both.

**Where they run** - each place is one *check gate*, in phase "Checks":

- `implement`: after the implementer finished a stage (and made a commit), before its review. Not for a review-only stage (`implement: false`).
- `fix r<n>`: after every fix round of a stage review and of the final review, before the next review round. Not in the plan review.
- `final`: once per repo that had stages, on the whole branch with the checks that repo's stages selected, after the last stage and the lane merges, before the final review - also with `finalReview` off or skipped. It gets repairs only when the final review follows (so a reviewer sees them) and no stage of that repo ended `checks-failed` (that stage already spent its budget on it); otherwise it runs once and only reports. A repo with one stage and no lane merge does not run it again when that stage's last checks were the same selection, their runner did not fail, and HEAD is still the commit they ran on: granny reads HEAD and compares it with the SHA that run recorded, so their result counts (logged `final review: final checks not rerun - <N> (<stage>) ran them green last on <sha>, HEAD unchanged`; red ends `finalReview` `checks-failed` with the note `... red on <sha>, HEAD unchanged`). When HEAD moved since - a reviewer or the judge committed after the stage's last gate - or either SHA could not be read, it runs the checks (`final review: running the final checks - <N> (<stage>) ran them last on <sha>, but HEAD is now <sha>`).
- `pr-ready`: once per repo whose `final` gate had checks, after the final check (label `pr-ready check`), when HEAD moved since the last check run of that repo - the final check runs with write access and may commit - or either SHA could not be read. It runs the same checks once, without repairs (logged `pr-ready check: HEAD moved from <sha> to <sha> after the final checks - running them once more, without repairs`). Red means the branch is not PR-ready: the log says `pr-ready check: the checks are red after the pr-ready check - the branch is not PR-ready`, and the result's `recheck` is `{ passed: false, note }`. Like every gate it reads `git status --porcelain` first, and since it has no repairs a dirty tree fails it at once (`checks not run at pr-ready - uncommitted changes: ...`). Green, it reads the status once more: a check that wrote files leaves a dirty branch, so `recheck` is `{ passed: false, note: 'uncommitted changes after the checks at pr-ready: <status lines>' }` (logged `pr-ready check: the checks left uncommitted changes after the pr-ready check - the branch is not PR-ready: ...`). A status that cannot be read there, also on one more read, sets `recheck: { passed: false, note: 'working tree status unreadable after the checks at pr-ready (exit <code>: <output>)' }`. HEAD unchanged: no run, no `recheck`.

A stage runs every check unless its spec lists `checks` by name (`"checks": ["tests"]`; `[]` runs none at its gates). A name the config does not have stops the run before any agent starts. The `final` gate of a repo runs every check one of its stages selected - all of them when a stage of it lists no `checks` - and none when every stage of it lists `[]`, so a repo can opt out of a check that does not fit its tooling.

**A gate** first reads `git status --porcelain` in the stage's worktree (label `status <stage> <gate>`; lines for the git-excluded work dir do not count, nor do the run's plan files when they sit inside the stage's worktree - granny leaves them out with `:(exclude,literal)<path>` pathspecs, since the plan files stay uncommitted), because the checks run on the working tree while the reviewers review the commits: granny never runs the checks on, or reviews over, uncommitted work. A dirty tree is not checked: the implementer gets a commit prompt (label `commit <stage> <gate> #<n>`, the "Implementer - commit" prompt in [prompts.md](prompts.md)) with the status lines, told to commit the stage's work with explicit paths, leave the plan files inside the repo uncommitted, delete only stray files it created, and never stash, reset, check out or clean anything away. That spends a repair from the gate's count, against the largest repair budget of the gate's checks (logged `<stage>: uncommitted changes before the checks at implement - repair 1/2: M f.txt`), and the status is read again. Still dirty with that budget spent - at once for a gate whose checks have no repairs - the gate fails with the note `checks not run at <gate> - uncommitted changes: <status lines> (still there after <n> repair(s))`. A clean tree costs the status read only (on Claude Code one helper agent call per gate attempt). A status read that fails - git errors, or the Claude Code helper reports it did not run or returns nothing - is read once more (logged `status <stage> <gate>: could not read the working tree status (exit <code>) - reading it once more`); failing again, granny does not take the tree for clean: the gate fails at once, without running the checks or spending a repair, with the note `checks not run at <gate> - working tree status unreadable (exit <code>: <output>)`. The commit count comes first: when the implementer made no commit, granny reads the status right away (label `status <stage> implement`) and, on a dirty tree, gives one commit prompt (label `commit <stage> implement`, not a repair from the gate's budget) and counts the commits again (label `commits <stage> after commit`). Still no commit, the stage ends `no-changes` - with the note `the implementer made no commit: the work it left is uncommitted (<status lines>), so there was nothing to review` when the tree is still dirty - and no check runs. A commit now, the gate runs as usual, its own status read and repair budget included. A clean tree with no commit costs that one status read and ends `no-changes` as before.

Then the gate runs its checks one after another in the stage's worktree. All green: on to the review. Otherwise, when a red check has used its repair budget at this gate, the gate fails; else the implementer gets a repair (label `repair <stage> <gate> #<n>`) with each red check's name, command, exit code, metric note and the last 3000 characters of its output, told to fix the code and never delete, skip or weaken a test, check, threshold, the granny config or a check script - and to explain in `deviations` when it cannot pass without that. Then every check of the gate runs again. Each gate has its own repair count; repairs are not review rounds.

A failed gate ends the stage `checks-failed` without a review (or ends its review loop), with a note naming the red checks, their exit code or metric, and the last repair's deviations; the stages that build on it are not started, as after `no-changes`, and when it ran on the run's branch no later stage of that repo starts either - its red commits are on that branch, so their checks would fail on code they did not write. A stage that ran in its own worktree is not merged back: its red commits stay on its lane branch and its worktree is left in place (the note names both), so the run's branch stays green for the other stages. A failed `final` gate means the branch is not PR-ready: the final review does not run, `finalReview` says `checks-failed` with that note, and the final check still runs. A stage whose gates ran is never `gates-red`: the checks decide, not the implementer's report. That report is not dropped, though: granny keeps the last gates report of the agent that touched the stage's code - the implementer, a commit prompt (`commit <stage> <gate> #<n>`, or `commit <stage> implement` when the implementer made no commit), a repair or a fix, whichever came last - and when the checks passed but that report is red, the stage's note gets a line `the checks passed, but <who> reported red gates: <gates>` (`<who>` is `the implementer`, `the commit step (<label>)`, `the last repair (<label>)` or `the last fix (fix <stage> r<n>)`), logged as `<stage>: the checks passed, but ...`. A gate the checks do not cover - `lint` red with only the tests as a check - still shows in the result that way. The outcome does not change, and a `checks-failed` stage gets no such line. With no checks configured, `gates-red` applies as usual.

**Without checks** for a stage (none configured, or its `checks` is `[]`) there is no gate to hold the review, so granny still reads `git status --porcelain` after the implementer and after every fix round (also the final review's). A dirty tree gets one commit prompt (label `commit <stage> implement` or `commit <stage> fix r<n>`, no repair budget involved; a stage with no commit after the implementer gets its prompt before the commit count is read again, as above, and no second one); its gates report then counts as the last implementer's for `gates-red` (`... but the commit step (commit <stage> implement) left the gates red`). Still dirty, the review goes on over HEAD, and the stage's (or `finalReview`'s) note gets a line `uncommitted changes after <step>: <status lines> - the review saw HEAD without them`; the outcome does not change. A status that cannot be read, also on one more read, is not taken for clean either: no commit prompt (there are no status lines to give), and the note gets `working tree status unreadable after <step> (exit <code>: <output>) - the review saw HEAD and may have missed uncommitted work`; a stage with no commit ends `no-changes` with `...; the working tree status could not be read (exit <code>: <output>), so uncommitted work may be left` added to its note. The final check's own clean-tree rule still applies.

The labels are `check <stage> <check>` (`check final review <check>` for the `final` gate, `check pr-ready check <check>` for the `pr-ready` one), `status <stage> <gate>` and `commit <stage> <gate> #<n>` for the clean-tree step, the logs `<stage>: check tests failed (exit 1) - repair 1/2` and `<stage>: checks green after 1 repair (implement: tests)`. The result records every run: `stages[].checks`, and the `final` gate's, the final review's and the `pr-ready` one's in `checks` (and `repos[].checks`), each `{ at, attempt, head?, results: [{ name, passed, code, metric?, note? }] }` - `head` is the SHA of HEAD right after the checks ran (`git rev-parse --verify HEAD`, missing when it could not be read); outputs are not kept. A `pr-ready` run also sets `recheck: { passed, note? }` (and `repos[].recheck`).

On **opencode** and **omp** granny executes the command itself. On **Claude Code** the Workflow script has no shell, so a helper agent (role `helper`, `roles.helper`'s model and effort) runs it and reports the exit code and output; the check is only as reliable as that report. Since Claude Code's Bash tool shows no exit code when a command succeeds, every command a helper runs ends with `echo "[granny] exit=$?"` (as `( cd <dir> && <command> ) 2>&1; echo "[granny] exit=$?"`), and granny takes the exit code from the last such line of the output over what the helper reports, and drops that line from the output; the git reads, the status reads, the timeout probe, the worktree setup, the merge steps and the start, wait, read and stop steps of a detached review command run the same way. When the helper returns nothing, or neither that line nor an exit code, granny runs the check once more; failing again, the gate ends `checks-failed` with the note `check runner failed` (code `?`) and no repair - the code may be fine, so the implementer is not asked to change it. On **Cursor** the session runs the checks itself.

**The timeout command.** A check with `timeout` needs GNU coreutils `timeout`; macOS has none by default, and `brew install coreutils` installs it as `gtimeout`. When a check the stages select has a `timeout`, granny looks once per run, before the worktree setup and any agent, for `timeout` and then `gtimeout` on PATH (label `timeout probe`; on Claude Code through the helper, retried once when it returns no exit code), and wraps the checks in the one it finds (logged `` checks: no `timeout` on PATH - the checks with a timeout run in `gtimeout` ``). With neither, the run stops with ``checks with a timeout (<names>) run as `timeout <s> bash -c '<run>'`, but neither `timeout` nor `gtimeout` is on PATH - install GNU coreutils (macOS: `brew install coreutils`), or drop `timeout` from those checks``. A check with a timeout that still exits 127 with `timeout: command not found` (or `gtimeout: ...`) in its output is a runner failure, like a helper that returns nothing: the gate ends `checks-failed` with the note `<timeout command> command not found` and no repair. Exit 127 for the check's own command (`bun: command not found`) is a red check and gets repairs.

**Reading git.** Before a stage's implementer runs, granny reads HEAD (`git rev-parse --verify HEAD`, label `head <stage>`) as the stage's review base; after it, it counts the commits since then (`git rev-list --count <sha>..HEAD`, label `commits <stage>`). It takes the first line of the output that is a hex SHA (7 to 64 characters) or a whole number, not whatever the last line says. No SHA: the stage reviews `<base>...HEAD` instead (logged `<stage>: could not read HEAD before the implementer ran - reviewing <base>...HEAD instead (exit <code>): ...`). No count: the stage is reviewed anyway and cannot end `no-changes` (`<stage>: could not count the commits in <sha>..HEAD - reviewing it anyway ...`). On a resume with `fromStage`, the first resumed stage that has no commit since its HEAD (also after the commit prompt) counts `<base>..HEAD` too (label `commits <stage> on resume`): the interrupted run may have committed that stage's work already, so a non-empty or unreadable count sends it on to its checks and a review of `<base>...HEAD` (logged `<stage>: no new commit on resume - reviewing <base>...HEAD instead`), as a review-only stage reviews, and the stages after it run. Only when `<base>..HEAD` is empty too does it end `no-changes` (`... <sha>..HEAD is empty, and so is <base>..HEAD on this resume, ...`). Every later stage ends `no-changes` on no commit, as on a fresh run. The working tree status read fails closed instead, after one more read - see the gate above. On Claude Code a helper agent runs these reads, the checks and the other git steps, and its `note` is for a command that did not run: a note on a command that ran is logged (`<label>: the helper's note, kept out of the command's output: ...`) and never read as output, so a word or a number in it cannot become the review base, the count or a check's metric. When the command did not run, the note is added to its output for the logs and gate notes.

## Plan review

The run's `plan` input is one absolute path or a list of them (a relative path is rejected before anything runs). Every agent prompt, the judge's and a command reviewer's `{prompt}` name them: `Plan files - read them first: <paths>`. The plan review is optional and off by default; enable it with `"planReview": true`. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written; each round is a full review + judge + fix, so it uses many more tokens and makes the run much longer (tens of minutes per round on high-effort models). Set it only when the user asks for a plan review. The `granny_run` schema on omp and opencode tells the agent so, their start reply carries the warning with the round cap for the agent to pass on, and every host logs it once when the plan review starts (journal, `granny_status`, the run views, the Claude Code Workflow log). With it on, the run reviews the plan files in phase "Plan review", after the worktree setup and before stage 1. It is skipped - and the result's `plan` says `skipped` - when the run resumes with `fromStage` > 1; with `planReview` off the result's `plan` says `review-skipped`. A run without `plan` has no `plan` in its result.

The loop is a stage's review loop on the plan files instead of a diff: every reviewer in parallel, the one retry, P0/P1 straight to the implementer, the judge for the rest (with a plan-review judge prompt) and its duplicates, `threshold`, and the `maxRounds` cap. Labels and log lines read `plan review r<n> <name>`, the outputs are `<workDir>/review-plan-review-r<n>-<name>.md` and `.log` (on Claude Code the command runs in the start, wait and read steps of [On Claude Code](#on-claude-code)), and finding ids are `<name>-F<n>` as in a stage. Each reviewer gets a plan-review prompt asking, against the actual repo, for wrong assumptions about the code or its dependencies, missing steps, risky ordering, acceptance criteria that cannot be tested, and version drift, in the form `- [P1] Title — <absolute plan path>:<line>` ([prompts.md](prompts.md) shows it). Findings keep that absolute path.

| `engine` | plan review runs |
|---|---|
| `codex`, and `auto` on opencode and omp | `codex exec --sandbox read-only [-m <model>] -o <out> <prompt> </dev/null` - stdin is closed because `codex exec` appends a piped stdin to the prompt |
| `codex-plugin`, and `auto` on Claude Code with the plugin | the companion's `task` command, read-only (no `--write`) and in the foreground (no `--background`): `node <companion> task [-m <model>] <prompt>`, with the same lookup, `node` check, own `CLAUDE_PLUGIN_DATA` and broker shutdown as the diff review. `auto` without the companion or `node` falls back to `codex exec` above; `codex-plugin` fails. `mode` and `focus` do not apply to a plan |
| `agent` | the "Plan reviewer - agent engine" prompt in a read-only subagent |
| `command` | the template with `{prompt}` filled with the plan-review prompt (`{base}` is the run's base: the `base` input when given, else the config's `base`). A template without `{prompt}` cannot review a plan: it is skipped for the plan review with the log line `plan review: reviewer <name> skipped - its command has no {prompt}, so it cannot review a plan`. When that leaves no reviewer, the plan review fails |

The companion's `Codex did not return a final message.` (an empty `task` answer, exit 0) means the reviewer did not run, like the diff review's no-result renders.

The fix step is the implementer with write access (label `fix plan review r<n>`). It edits the plan files in place at their absolute paths and never stages or commits them: in a worktree, a plan that is untracked in the main checkout does not exist, so the absolute path is the only copy. A plan file inside the repo that it leaves changed or untracked does not count as uncommitted work at a check gate or after a step ([Checks](#checks)), so it costs no commit prompt, and the commit prompt and the final check's clean-tree rule both name it as a file to leave uncommitted. In round 1 it adds a section `## rN deltas (<date>)` at the top of each plan file it changes (N one higher than the highest one already there, r1 when there is none), in later rounds it extends that section; the date comes from `date +%F` in its shell. It returns the files it changed, what it changed per finding id, the findings it did not apply in `declined` (`[{ id, reason }]`, as a stage fix does - [Judge routing](#judge-routing)) and anything else in `deviations`. The implementer must be able to write the plan's path: on opencode and omp its session works in the worktree, so keep the plan inside the worktree or the main checkout's git-excluded `<workDir>/` and check that your permissions let a session edit it.

| plan review outcome | then |
|---|---|
| `clean`, `residual-only` | stage 1 starts; the residual plan findings are in the result for the user |
| `round-cap`, `review-failed` | **fail closed**: the run stops before implementing. The result has `plan` with `{ outcome, rounds, residual, unresolved, history, note? }`, an empty `stages` and `final: null`; the log ends `plan review ended <outcome> - stopping before stage 1; nothing was implemented` |

## Reviewers

`reviewers` is a list, one entry per reviewer. Without it, one `agent` reviewer named `reviewer` runs on the host's model - the model you selected, or `model` on the entry to pin one; Codex and other CLIs are opt-in entries. Every round all of them review the stage in parallel: on Claude Code as concurrent `agent()` calls, on opencode as concurrent child sessions and commands, on omp as concurrent `omp` processes and commands.

| key | values | |
|---|---|---|
| `name` | unique; `a-z`, `0-9`, `-` | names the reviewer's output files, log lines and finding ids. Omitted: `<engine>-<n>`, with `n` its 1-based position (`agent-2`) |
| `engine` | `auto` (default), `codex`, `codex-plugin`, `agent`, `command` | which reviewer runs, below |
| `model` | a string or an object keyed by host | the Codex engines pass it as `-m`; `agent` runs that host model; `command` puts it in `{model}` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | the agent's reasoning effort, for engine `agent` on Claude Code and omp (as `--thinking`); the other engines do not use it |
| `mode`, `focus` | | the Codex plugin only (engines `auto` and `codex-plugin`) - see [The Codex plugin](#the-codex-plugin) |
| `command` | a command template | engine `command` only, and required there - see [Command reviewers](#command-reviewers) |

| `engine` | runs |
|---|---|
| `auto` (default) | on Claude Code: the Codex plugin when its companion script is installed and `node` is on `PATH`, otherwise the Codex CLI. On opencode: always the Codex CLI. Not on omp |
| `codex-plugin` | OpenAI's Codex plugin for Claude Code, on Claude Code and opencode. When the companion script is missing, or `node` is not on `PATH`, the reviewer fails with a note saying so - it never falls back to the CLI |
| `codex` | the Codex CLI: `codex exec review`; not on omp |
| `agent` | a host subagent told to stay read-only ([Read-only roles](#read-only-roles)) reviews the diff with the "Reviewer - agent engine" prompt, on this entry's `model` and `effort`. On Claude Code that means Claude models only (`opus`, `sonnet`, `haiku`, a Claude model ID); to have GLM or another provider review there, use engine `command` with a CLI that reaches it, such as `opencode run`. On opencode, any `provider/model` the server has; on omp, any model omp has |
| `command` | your command, any CLI - see [Command reviewers](#command-reviewers) |

**omp runs no Codex reviewer.** The Codex engines - `auto`, `codex` and `codex-plugin`, so also an entry that names no `engine` - are refused before an omp run starts. omp reaches Codex models itself: for a Codex review there, use an `agent` reviewer on one of them (`omp models` lists the `openai-codex/...` ids):

```json
{
  "reviewers": [
    { "name": "codex", "engine": "agent", "model": { "omp": "openai-codex/gpt-6.1-sol" } },
    { "name": "opus", "engine": "agent", "model": { "omp": "anthropic/claude-opus-5-5" } },
    { "name": "glm", "engine": "agent", "model": { "omp": "zai/glm-5.3" } }
  ]
}
```

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
    { "name": "opus", "engine": "agent", "model": { "claude-code": "opus" }, "effort": "high" },
    { "name": "glm", "engine": "command", "command": "opencode run -m opencode/glm-5.3-flash-free {prompt}" }
  ]
}
```

### Each reviewer on its own

- Output files: `<workDir>/review-<stage>-r<n>-<name>.md` and `.log`; on Claude Code also `.out` (what the script printed), `.exit` (its exit code) and `.pid` (its process group), see [On Claude Code](#on-claude-code).
- Log line every round: `<stage> r<n> <name>: reviewer: <backend>`.
- Finding ids: `<name>-F1`, `<name>-F2`, … Each finding also carries `reviewer: "<name>"` into the judge prompt, the fix prompt, the round history, residual and unresolved.
- Codex plugin broker: `<workDir>/codex-plugin-<name>` (below).

### On Claude Code

The Workflow script has no shell, so a Codex or `command` reviewer's script runs in helper agents (role `helper`, `roles.helper`'s model and effort). A review can take longer than the 10 minutes a Claude Code Bash call may run, and a helper left to wait on its own in the background may return before the review is done or never stop waiting, so the engine runs the script in fixed steps, each a helper that runs one given command once:

| step | label | command |
|---|---|---|
| start | `review <stage> r<n> <name>` | stops an earlier run of the same files still going (its `.pid`, when there is no `.exit`), deletes `.md`, `.log`, `.out`, `.exit` and `.pid`, then runs the review script detached - `{ set -m; nohup bash -c '<script>' > /dev/null 2>&1 < /dev/null & }` - and prints `started`. The detached script writes its process group id to `.pid`, what it prints to `.out` and its exit code to `.exit`. Every `rm` runs here, outside `bash -c`, where the helper's shell can check it |
| wait | `review <stage> r<n> <name> wait <k>` | in the foreground, with the Bash timeout set to 600000 ms: `bash -c 'until [ -s <.exit> ] \|\| [ "$SECONDS" -ge 540 ]; do sleep 5; done'`, then `done` or `pending` |
| read | `review <stage> r<n> <name> read` | prints `.out` and exits with the code in `.exit` |
| stop | `review <stage> r<n> <name> stop` | only after the last wait: `kill -TERM` to the process group in `.pid` |

The engine calls the next wait until one prints `done`; a wait that printed anything else, failed or returned nothing counts as `pending`. After 7 waits (63 minutes) without `done` it stops the review and the reviewer did not run (below), with the note `review command still running after 7 waits of up to 9 minutes (63 minutes) - stopped it`. A start the helper reports as failed is a reviewer that did not run too (`review command did not start (exit <code>): <output>`). The plan review uses the same steps; on opencode granny runs the script directly and waits for it itself. `set -m` and bash's `$SECONDS` stand in for `setsid` and `timeout`, which macOS does not ship.

These steps run on the cheap `roles.helper` (Haiku at low effort by default) because no helper decides how or how long to wait: the start returns at once and each wait runs one fixed loop in the foreground. A helper told to start a review and wait for it on its own is not safe on a cheap model - Haiku at low effort started the review in the background, returned at once and reported a placeholder exit code.

### A reviewer that does not run

A reviewer did not run when its command exits non-zero, when its command did not start or was still running after the last wait on Claude Code ([On Claude Code](#on-claude-code)), when the Codex plugin says it got no usable result (below), when an agent reviewer returns nothing, when an extraction of its output stays short (below), when output without finding bullets that is not just `No findings.` yields no extracted finding and no confirmation that it is a clean review (below), or when a call it needs fails with an error (an opencode session request, the command runner, an extraction agent) - the note then reads `reviewer call failed: <error>`. The round waits for every reviewer before it ends, so one reviewer's error never cuts the others short. It is run once more, on its own - the other reviewers keep their results - with labels and log lines tagged `#2`, after the log line `<stage> r<n> <name>: did not run - retrying once. <why>`. If it fails again, the stage ends `review-failed`: the note names every reviewer that failed with its last error, and `unresolved` keeps the findings of the reviewers that did run (and the failed reviewer's findings from the round before, also those the judge merged into another reviewer's finding: a merged finding it kept stays merged, one it lost to another reviewer comes back under its own id), so nothing is lost. A stage is `clean` only when every reviewer ran and none reported a finding.

### Judge routing

1. P0/P1 findings (also `critical`/`high`) go straight to the implementer, without the judge - until a fixer declines findings. A fixer declines a finding by listing it in `declined: [{ id, reason }]` in its result: the id exactly as it was sent, and why it did not fix it. An id it was not sent is ignored (log: `<stage> r<n>: the fixer declined id(s) it was not sent - ignored: ...`; the id of a finding the judge merged into another counts as that finding), and a result without `declined` declines nothing. `deviations` is free text for the report and never counts as a decline, whatever it says. From the round after the first decline on, P0/P1 findings of that review loop go to the judge with the rest (log: `<stage> r<n>: <k> P0/P1 finding(s) go to the judge too - ...`), so the judge can mark which earlier finding each repeats; going to the judge does not make a P0/P1 droppable (step 4). The final review counts the declines of the stage reviews in its repo too ([The decision ledger and the ratchet](#the-decision-ledger-and-the-ratchet)), so after a stage's fixer declined a finding its P0/P1 findings go to the judge from round 1 on.
2. The judge is called only when there are findings for it. It classifies each of them ([The decision table](#the-decision-table)) and may mark one `duplicateOf: <id>` when it reports the same problem as another finding in its list. The duplicate is merged into the finding it points at, which is reported once, lists the merged ids in `duplicates` and takes the judgement of the strongest copy of the group - one the table sends to the implementer before one it keeps residual, then the higher priority (an unclassified copy is sent, so it wins over a residual one) - so a merge never drops a finding that would have been fixed. The log says `<stage> r<n>: judge merged <id> into <id> (duplicate)`. A `duplicateOf` that points at itself, at an id not in the list, or back in a cycle is ignored.
3. From round 2 on, the judge prompt has an EARLIER DECISIONS block, the loop's part of [the decision ledger](#the-decision-ledger-and-the-ratchet): every finding already sent to the fixer under a round-qualified label (`r1/codex-F2` - ids restart every round), the ones each round's fixer declined, with its reasons, that round's `deviations` as the fixer's other notes, and the findings each round kept as residual, labelled the same way - each with its decision (`fix - rule 6: <why>`), classification, priority and evidence. The final review's judge also gets every stage review's decisions in its repo, from round 1 on, labelled `s<k>/r<n>/<id>` (`s2/r1/codex-F3`: stage 2, round 1). The judge sets `repeatOf: <label>` on a finding that repeats one of them; a `repeatOf` naming no listed label is ignored. A repeat of a finding the fixer declined with a reason the code backs is classified `refuted`, or by its `scope` when it belongs elsewhere; one whose reason is wrong is classified on its merits, with the reason saying why.
4. The decision table decides each finding: it goes to the implementer or stays residual for the user. Every P0/P1 goes to the implementer whatever the judge classified (rule 1), unless its `repeatOf` names a finding a fixer declined - a P0/P1 that repeats a finding the fixer fixed, or one kept as residual, goes to the implementer like a first-time one. A residual repeat of a declined finding is logged `<stage> r<n>: <id> dropped as a repeat of <label>, which the fixer declined (rule <n>: <why>) - kept as residual`, so a disagreement the judge settles for the fixer ends `residual-only` instead of running to `round-cap`.

   Residual findings add up over the rounds of a review loop (a stage's review, the plan review, the final review): a finding kept as residual in round 1 is never sent to the fixer, so it stays in the result's `residual` when a later round is clean, ends `residual-only`, ends `checks-failed` or hits the cap. It leaves `residual` only when the judge marks a later finding as its repeat: a repeat that goes to the implementer drops it, since it is being fixed; a repeat kept as residual again takes its place (the latest version, with its `repeatOf`), so each problem is listed once, also when a third round repeats the first round's version. A repeat of a residual finding is not a repeat of a declined one: it is not logged as dropped and never overrules the fixer. The outcome says how the last round ended, not whether residual is left: `clean` means the last review found nothing, and its `residual` can still hold findings of earlier rounds; `residual-only` means the last round had findings and none to send. After `round-cap`, `residual` holds the earlier rounds' residual and the last round's findings - its residual ones too - are in `unresolved`. After `review-failed`, `residual` is empty; the earlier rounds' findings are in `history`.
5. A repeat of a declined finding that goes back to the implementer is logged `<stage> r<n>: the judge overruled the fixer on <id> (repeat of <label>, rule <n>: <why>)`, and the fix prompt gets an OVERRULED block: those findings, the judge's reasons and the reason the fixer gave when it declined each, so it fixes them or answers the reason instead of repeating itself. Each round's `declined` and `deviations` are also kept on its `history` entry (log: `<stage> r<n>: the fixer declined <ids>`).

Two consequences:

- Dedupe happens only among the findings that are not P0/P1 (once P0/P1 findings go to the judge, one may be merged into another P0/P1, never into a P2/P3). A P2 that duplicates a P1 is classified on its own, and may reach the implementer next to the P1.
- A reviewer that labels everything P0/P1 bypasses the judge until a fixer declines one of its findings, and even then only a repeat of a declined finding can end up residual.

### The decision table

The judge does not score findings: it classifies each one, and the engine decides. For every finding it gets, the judge returns:

- `verdict`: `confirmed` | `refuted` | `unverified` - is it really in the code?
- `impact`: `critical` | `major` | `moderate` | `minor` | `none` - how bad it is if it triggers. The judge prompt says to judge impact assuming the trigger happens: likelihood never lowers impact, it is its own field. `critical`: data loss or corruption, writing to the wrong record, a security or authorization bypass, a secret or personal data leak, a draft going public, an irreversible operation, stored data silently read differently. `major`: the user cannot get out from inside the app (a lock only a reload clears, endless loading, a crash), something that worked silently breaks, an API or contract break, a required part of the stage's task is missing. `moderate`: wrong behaviour with an easy workaround, a wrong or missing error message, a missing test for changed behaviour, duplicated logic. `minor`: a visual defect, naming, style.
- `likelihood`: `common` (the normal flow) | `edge` (special timing or state: a race, an expired session, a boundary value) | `rare` (forced input, a rarely used feature).
- `fixCost`: `trivial` (a few lines) | `small` (one function or file plus a test) | `large` (cross-module, a redesign).
- `scope`: `in-scope` | `pre-existing` (it was there before this stage) | `other-stage` (another stage's job).
- `evidence`: `path:line` plus the concrete trigger steps; `reason`: one line.

The plan review's judge returns the same fields, with impact judged by what the plan would cause once implemented as written.

The engine normalizes the classification first: evidence without a `path:line` (anything matching `\S+:\d+`) turns a `confirmed` or `refuted` verdict into `unverified`, and an `unverified` finding's impact is lowered one class (`critical` → `major` → `moderate` → `minor` → `none`). A missing field or an unknown value makes the whole classification invalid: the finding counts as not judged.

Before a finding falls to rule 2 for that, the judge is asked once more: when it returned nothing, or left any finding it was given unclassified (left out of its answer, a missing field, an unknown value, an empty `evidence`), the engine calls it again with the same prompt plus a RETRY note (label `judge <stage> r<n> retry`). The note names each unclassified finding and what was wrong with it (`- codex-F2: invalid classification: impact "severe"`, or `no classification in your answer`), or says the answer was empty or did not match the schema. The log says `<stage> r<n>: judge left <k> finding(s) unclassified - retrying once: <id> (<why>), ...` or `<stage> r<n>: judge returned nothing - retrying once`. From the retry's answer the engine takes only the findings that were unclassified; a classification that was valid the first time stays as it was. What is still unclassified after the retry goes to rule 2, logged `<stage> r<n>: judge left <k> finding(s) unclassified, also on a retry - to the implementer unjudged (rule 2): <id> (<why>), ...`, or, when both answers were empty, `<stage> r<n>: judge returned nothing, also on a retry - all <k> finding(s) go to the implementer unjudged (rule 2)`. A finding with only a number and no classification counts as unclassified. On Claude Code `agent()` with a schema already forces structured output, so there the retry covers an empty return and what the engine finds invalid in the fields (an unknown class, an empty `evidence`, a finding left out). It matters more with a cheap judge model: in the measured comparison ([The judge's model](#the-judges-model)) Haiku returned malformed structured output on the first try in 2 of 8 calls, Sonnet in none.

The priority is the table value for impact × likelihood, plus the fix cost (`trivial` +15, `small` 0, `large` −15; not for `none`, which stays 0), clamped to 0..100:

| impact | common | edge | rare |
|---|---|---|---|
| critical | 100 | 95 | 90 |
| major | 90 | 80 | 65 |
| moderate | 75 | 55 | 35 |
| minor | 35 | 25 | 15 |
| none | 0 | 0 | 0 |

Then the first matching rule decides:

1. P0/P1, unless it repeats a finding the fixer declined → **fix** (P0/P1 do not go to the judge until a fixer declined a finding - [Judge routing](#judge-routing)).
2. Not judged, or an invalid classification (also when the judge returned nothing), still after the judge's one retry → **fix**.
3. `verdict` `refuted` → residual, `refuted`.
4. `scope` `other-stage` → residual, `left to the stage that owns it`.
5. `scope` `pre-existing` → residual, `pre-existing`; with impact `critical` or `major` it is flagged `pre-existing - ATTENTION: impact <impact>`, carries `attention: true` and is logged `<stage> r<n>: ATTENTION <id> is pre-existing with impact <impact> - left for the user`. It is not fixed: the stage did not cause it, so it is left for you to decide.
6. impact in `alwaysFix` (default `["critical", "major"]`) → **fix**, whatever the likelihood, the fix cost and `threshold`.
7. priority strictly above `threshold` → **fix**.
8. Everything else → residual, `under the bar: <impact>/<likelihood>/<fixCost> -> <priority>`.

Each finding keeps its normalized classification, its `priority`, the judge's `reason` and `decision: { rule, action, why, attention?, raised? }` (`action` is `fix` or `residual`; the `why` of a lowered unverified finding says so; `raised` says what [the ratchet](#the-decision-ledger-and-the-ratchet) raised) - in the fix prompt, the round's `history`, `residual` and `unresolved`. Every round logs `<stage> r<n>: to the implementer: <id> (rule <n>: <why>), ...` and `<stage> r<n>: <k> finding(s) kept as residual, not sent: <id> (rule <n>: <why>), ...`.

With the defaults, these hold:

- `minor` never passes the default threshold: its highest priority is 35 + 15 = 50.
- `moderate` passes only when `common` with a `small` or `trivial` fix (75 or 90); `moderate`/`edge`/`trivial` is 70, and 70 > 70 is false, so it stays residual.
- `refuted` and `other-stage` findings always stay residual, whatever their impact.
- The fixer can still decline a finding with evidence (`declined`), and the judge can agree by classifying the repeat `refuted` or by its scope; `maxRounds` still caps the loop.

`"alwaysFix": []` leaves only `threshold`: a `critical`/`rare`/`large` finding (75) is then fixed, a `major`/`rare`/`small` one (65) is not.

`granny setup` ([setup.md](setup.md)) offers three presets for `threshold`: strict `55`, normal `70` (the default) and relaxed `85`. A lower threshold fixes more: at `55` a `moderate`/`common`/`large` finding (60) and a `moderate`/`edge`/`trivial` one (70) are fixed too; at `85` a `moderate` finding is fixed only when `common` and `trivial` (90). `alwaysFix` is the same in all three.

Four findings from a real run, which an earlier 0-100 judge score all left under the bar - with the classes, the first three are fixed:

| finding | old score | classes | priority | now |
|---|---|---|---|---|
| a late save response re-binds the editor to another post, so the next save overwrites it | 55, then 68 | critical · edge · small | 95 | **fix** (rule 6) |
| an expired session leaves Save dead until a reload | 68, then 62 | major · edge · small | 80 | **fix** (rule 6) |
| a YAML merge drops the inherited `published: false`, so a draft can go public | 55 | critical · rare · trivial | 100 | **fix** (rule 6) |
| a countdown reads "in 0 months" at exactly 30 days | 52 | minor · edge · trivial | 40 | residual (rule 8) |

### The decision ledger and the ratchet

Every finding a round decides - sent to the implementer or kept residual - goes into a ledger with its classification, priority and `decision`, under its round-qualified label, with the fixer's `declined` reason when it declined it. Later rounds of the same review loop see it as EARLIER DECISIONS ([Judge routing](#judge-routing), step 3). Each stage review also records its rounds into its repo's ledger, and the final review of that repo shows them to its judge from round 1 on, in stage order, labelled `s<k>/r<n>/<id>`; a stage review's last round is in it too, also when it only kept findings residual. The plan review keeps its own ledger, and one stage review never sees another's. A stage skipped on a `fromStage` resume recorded nothing, so the final review of a resumed run sees only the stages that ran in it.

When the judge marks a finding as a repeat (`repeatOf`) of a ledger entry, the engine applies a ratchet before it computes the priority: the repeat's impact and likelihood cannot drop below the entry's (`critical` > `major` > `moderate` > `minor` > `none`; `common` > `edge` > `rare`). A lower class is raised back to the entry's - after the normalization, so an unverified repeat lowered one class is raised too - and the decision records it in `raised` (`repeat of r1/codex-F2: impact moderate -> major, likelihood rare -> edge`), which the next round's EARLIER DECISIONS shows after the why. The log says `<stage> r<n>: the ratchet raised <id> - repeat of <label>: <what>`. A repeat escapes the ratchet only when its verdict is `refuted` with evidence that cites a `path:line` the entry's evidence did not (compared by file name and line, so `` `a.ts:3` `` and `src/a.ts:3` are the same spot); a `refuted` repeat without new evidence has its classes raised as well, and still stays residual by rule 3. An entry without classes - an unjudged P0/P1 - sets no floor, and neither is a repeat the judge left unclassified. Raised classes go into the ledger, so a third round is held to them too.

Residual findings still add up per loop: a final-review repeat of a stage's residual finding does not remove it from that stage's `residual`.

### The judge's model

On Claude Code the judge runs on `haiku` by default. Since it only classifies and the engine's table decides, the classification is what matters, and it was measured on 4 real findings, 2 refuted fakes and 1 duplicate, 2 runs per model, with the rubric prompt:

| | Haiku | Sonnet |
|---|---|---|
| outcomes matching the user's later fixes | 3/4 | 2/4 |
| direction of the errors | toward fix (an extra fix round) | toward residual (a real bug left open) |
| fakes refuted, duplicate caught | 8/8 | 8/8 |
| same outcome across runs | every finding | every finding |
| cost per call | ~$0.004 | ~$0.025 |
| malformed structured output on the first try | 2/8 (recovered) | 0/8 |

The deciding case was a fail-open `git status` probe the user fixed later: Haiku classified it `major` (fix) in both runs, Sonnet `moderate` (residual) in both, reasoning that it was a rare failure - likelihood lowering impact, which the rubric forbids. To trade the extra fix rounds for Sonnet's fewer ones, set:

```json
{ "roles": { "judge": { "model": { "claude-code": "sonnet" } } } }
```

On opencode and omp the judge keeps the session model unless `roles.judge.model` names one.

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

The companion talks to Codex through an app-server broker it starts in the background (`app-server-broker.mjs` with a `codex app-server` child) and leaves running when it exits. Granny gives each plugin reviewer its own plugin data directory, `<workDir>/codex-plugin-<name>` (as `CLAUDE_PLUGIN_DATA`), so a review never shares or stops the broker of another reviewer running next to it or of a Claude Code session working in the same repo, and stops its own broker with the plugin's `scripts/session-lifecycle-hook.mjs SessionEnd` when the review script exits - after the review, after a failure, and on SIGTERM, SIGINT or SIGHUP (so `granny_cancel` on opencode and omp stops it too). A SIGKILL skips that step and leaves the broker running.

| key | values | |
|---|---|---|
| `mode` | `review` (default), `adversarial-review` | `review` is Codex's built-in reviewer; `adversarial-review` is the plugin's skeptical, ship/no-ship review with `critical`/`high`/`medium`/`low` findings. It needs the plugin: engine `codex-plugin`, or `auto` on Claude Code, where a missing companion or a missing `node` fails the reviewer instead of running a plain CLI review |
| `focus` | non-empty string | extra instructions for `adversarial-review` only (the plain review takes no focus text), passed shell-quoted after `--` |

Rejected before any agent starts: `mode` on engines `codex`, `agent` and `command`; `adversarial-review` with `auto` on opencode (where `auto` means the CLI); every Codex engine on omp; `focus` without `adversarial-review`.

An adversarial review on Claude Code and opencode (omp runs no Codex reviewer):

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

The template must contain `{base}` or `{prompt}`. Every value is substituted already shell-quoted, in one pass, so do not put quotes around a placeholder. On Claude Code the command runs detached and the engine waits for it ([On Claude Code](#on-claude-code)). The engine deletes `{out}` and the reviewer's log first, then reads `{out}` when the command left it non-empty, otherwise everything the command printed. A non-zero exit means the reviewer did not run.

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

### Read-only roles

`agent` reviewers (the default reviewer is one), the judge and the extraction agent are read-only roles: they must not edit, create, stage or commit a file, and their prompts carry no commit, stash, attribution or gate rules. How that holds depends on the host:

- On Claude Code, by default, it is only prompt text. granny puts `READ-ONLY ROLE: do not edit, create, stage or commit any file.` at the top of the role's prompt, and the subagent still has its write tools and can ignore that line. With `readOnlyAgent` on, it is enforced - see below.
- On opencode the role's child session gets permission rules that deny edits, `git add` and `git commit` ([opencode.md](opencode.md#models-and-permissions)).
- On omp the role's process gets a guard that lets it call only omp's reading tools, `bash` and its submit tool, and blocks `git add` and `git commit` in its `bash` ([omp.md](omp.md#models-and-permissions) lists the tools).

**`readOnlyAgent` (Claude Code).** With `"readOnlyAgent": true` granny passes `agentType: "granny-readonly"` to the Workflow `agent()` call of every `agent` reviewer, the judge (the plan judge too) and the extraction agent, and lists the commands they may run after the `READ-ONLY ROLE` line ("Claude Code - the lines before the prompt ..." in [prompts.md](prompts.md)). Two files enforce it, both shipped in the skill:

- `engines/claude-code/agents/granny-readonly.md`, the agent definition: tools Read, Grep, Glob and Bash - no Edit, Write or NotebookEdit. The Workflow adds the StructuredOutput tool for the result's schema and applies the role's `effort`; the definition sets no `model`, so the role's model is the one granny passes from the config (not yet confirmed in a real Workflow run - check the judge's model in the run's journal).
- `engines/claude-code/hooks/granny-readonly-guard.mjs`, a PreToolUse hook run with `node`. For a call from agent type `granny-readonly` (or `<plugin>:granny-readonly`) it blocks Edit, Write, MultiEdit and NotebookEdit, and a Bash command unless every part of it is one of: `git diff`, `git log`, `git show`, `git blame`, `git status`, `git rev-parse`, `git merge-base`, `git ls-files` (not with `--output`; git's only global options allowed are `-C <dir>`, `--no-pager` and `-P`), `git branch --show-current` (or `--list`, `-a`, `-r`, `-v`), `cat`, `sed -n '<from>,<to>p'`, `grep`, `find` without `-exec`, `-delete` or `-fprint`, `ls`, `head`, `tail`, `wc`, `pwd` and `cd`. The parts may be joined with `&&`, `||`, `;` and `|`; output may go to `/dev/null` (`2>&1` too). `$(...)`, backticks, `$VARIABLES`, `VAR=value` prefixes, subshells, here-documents, a background `&` and a redirection into any file are refused. A blocked call exits 2 and its reason goes back to the agent. Calls from every other agent, and from your own session, pass untouched.

The skill install puts neither file where Claude Code looks, so the key is off by default. Install both once, then turn it on:

```sh
mkdir -p ~/.claude/agents ~/.claude/hooks
cp <skill-dir>/engines/claude-code/agents/granny-readonly.md ~/.claude/agents/
cp <skill-dir>/engines/claude-code/hooks/granny-readonly-guard.mjs ~/.claude/hooks/
```

and add the hook to `~/.claude/settings.json` (merge it into an existing `hooks.PreToolUse` list):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/granny-readonly-guard.mjs\"" }]
      }
    ]
  }
}
```

```json
{ "readOnlyAgent": true }
```

What to know:

- The hook goes into the settings, not into the agent's frontmatter, because Claude Code skips frontmatter hooks of an agent whose folder is not trusted; a settings hook runs for every agent, so it starts `node` on every Bash call of every session and lets all but `granny-readonly` through. Without `node` on `PATH` the hook fails with a non-blocking error and the command runs - read-only is then the tool list only.
- Without the agent definition, `agent()` throws `agent type 'granny-readonly' not found` and the run stops at the first reviewer. Without the hook, the agent still has no Edit or Write, but its Bash runs anything.
- An `agent` reviewer cannot run the tests or any other command outside the list; it reads the code.
- The helpers that start, wait for, read and stop a review command keep the default agent: they write the review's `.out`, `.exit` and `.pid` files.
- Changing the key changes the `agent()` options, so `resumeFromRunId` runs those roles again instead of reusing their cached results.
- The guard reads the command as a shell would only for the forms above; anything it cannot read that way is refused, not guessed.

On Claude Code, configure `checks` as the backstop (with `readOnlyAgent` on, too); they catch the damage after the fact, they do not prevent it. Every check gate reads `git status --porcelain` before it runs the checks, so a file a read-only role left changed shows up at the next gate that runs - after a fix round, or the `final` gate (a one-stage repo whose `final` gate reuses the stage's result reads no status there) - and goes to the implementer as a commit prompt (or fails the gate when no repair is left) instead of being checked or reviewed unseen. Every check run records the HEAD it ran on (`checks[].head`), so a commit a reviewer or the judge made after a stage's last gate makes the `final` gate of a one-stage repo run the checks again instead of reusing that result, and the `pr-ready` gate runs them once more when HEAD moved after the final checks ([Checks](#checks)). Without checks, the status read after the implementer and after every fix still names uncommitted work in the note, but nothing reruns on a commit a read-only role made.

### Reading the output

Findings are read from lines shaped like Codex's output - the built-in reviewer's form, and the Codex plugin's `adversarial-review` form:

```
- [P1] Title — path/to/file.ts:12-14
  Detail, indented, any number of lines.

- [high] Title (path/to/file.ts:12-14)
  Detail, indented.
  Recommendation: what to change.
```

The word severities map to `critical` → P0, `high` → P1, `medium` → P2, `low` → P3; for them the location is the last parenthesised part of the line (an ` — ` location is accepted too). Other bracketed words (`[note]`) are not findings. A marker bullet indented under a finding belongs to that finding's detail; it is neither a finding nor a marker. If the output has more markers than parseable findings, a granny agent (`roles.granny`) extracts them instead. If it recovers fewer findings than markers, it is asked once more with the expected count; still short, the reviewer did not run (above), and when the retry ends short too, the stage ends `review-failed` with the marker, parser and extraction counts and the raw review output in its note - findings are never dropped silently and the stage is never reported clean. Output in which the Codex plugin says it got no usable result (`Codex did not return valid structured JSON.`, `Codex returned JSON with an unexpected review shape.`, `Codex review completed without any stdout output.`, and for the plan review's `task`, `Codex did not return a final message.`) also means the reviewer did not run, even when the command exited 0. Output with no marker at all reads as a clean review only when the no-findings sentence is all there is: `No findings.` or the Codex plugin's `No material findings.` (case and the period do not matter) on a line of its own, with nothing else but granny's leading `[granny] reviewer: ...` line and the plugin's frame - its `# Codex Review` or `# Codex Adversarial Review` heading and `Target: ...` line, and in its structured render with `Verdict: approve` the one-paragraph summary before the sentence and the `Next steps:` and `Reasoning:` lists of one-line bullets after it, which the plugin prints around the sentence when its findings list is empty. A no-findings line next to anything else - a finding written as prose or as a heading in another section, a second summary paragraph, `Verdict: needs-attention`, text after the sentence - does not make the output clean. Otherwise - prose findings, a native Codex review (the plugin's `review` or `codex exec review`), or a sentence like `Review could not be completed: ... No code was inspected` that the CLI prints with exit 0 when its sandbox cannot run commands - a granny agent (`roles.granny`) reads it (`extract <stage> r<n> <reviewer>`, after the log line `<stage> r<n> <reviewer>: no finding in the expected form and not just "No findings." - asking an agent to extract findings`): the findings it extracts go on as the reviewer's findings; with none, the review is clean only when the agent confirms (`clean: true`) that the output is a finished review saying the changes have no problems, and otherwise the reviewer did not run (above), with the note `reviewer output had no findings in the expected form and was not just No findings, and an extraction found none in it` and the raw output. A clean native Codex review (`No actionable regressions were identified. Type checking passed; ...`) therefore costs one extraction call: the sentence is the model's own prose, worded differently and followed by different caveats on every run, so granny does not match a phrase in it, and the extraction agent confirms it as clean.

## Watching a run

`watch` decides what the session that started a run shows of it, on omp and on opencode. The run, its journal and `granny_status` are the same in every mode.

On omp:

- `"full"` (default): the live panel and status line, plus a condensed event log per role process (`sessions/<n>-<label>/events.jsonl`: state changes, reasoning headings, tool calls, the final text of each answer) and the run navigator (`/granny`, `alt+w`): the run's stages and agents, what the selected agent is doing now, its full event list or its transcript.
- `"panel"`: the live panel and status line only; no event log, and `/granny` and `alt+w` say watching is off for that run.
- `"off"`: no panel, no status line, no event log.

On opencode, where the TUI plugin entry `tui.js` draws the view:

- `"full"` (default): a sidebar section with the run's stage, phase and agents, a chip in the prompt footer, toasts on phase changes, failed roles and the run's end, and the run navigator (`/granny`, `<leader>j`): the run's stages and agents beside what the selected agent is doing now, and Enter opens a role's opencode session.
- `"panel"`: the sidebar section and the chip only; `/granny` says watching is off for that run.
- `"off"`: none of them.

The role sessions are children of the session that called `granny_run` in every mode, so opencode's Subagents tab lists them even with `"off"`.

```json
{ "watch": "panel" }
```

Claude Code (`/workflows`) has its own view of a run; it accepts the key and ignores it. Details: [omp.md](omp.md#watching-a-role), [opencode.md](opencode.md#watching-a-run).

## Example: everything set

```json
{
  "roles": {
    "granny": { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5", "omp": "anthropic/claude-sonnet-5-5" }, "effort": "medium" },
    "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5#high", "omp": "anthropic/claude-opus-5-5" }, "effort": "high" },
    "judge": { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5", "omp": "anthropic/claude-sonnet-5-5" } }
  },
  "reviewers": [
    { "name": "codex", "engine": "auto", "mode": "review" },
    { "name": "opus", "engine": "agent", "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5", "omp": "anthropic/claude-opus-5-5" }, "effort": "high" },
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
