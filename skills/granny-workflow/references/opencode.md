# granny on opencode

The engine is an opencode **v2** plugin (`engines/opencode/plugin/granny-workflow/`). Its server entry, `index.js`, adds `granny_run`, `granny_status`, `granny_cancel` and the `granny_submit_*` tools the role sessions answer through. The loop is code inside the plugin; every role runs in its own child session of your session, with its own model and permissions, and the review command runs directly in the opencode server. Its TUI entry, `tui.js`, shows a running run in the TUI ([Watching a run](#watching-a-run)).

## Install

Requires opencode 2.x (`opencode --version`). V1 plugins and this plugin are not interchangeable.

1. Copy the plugin directory into the global plugins directory:

   ```sh
   cp -r <skill-dir>/engines/opencode/plugin/granny-workflow ~/.config/opencode/plugins/
   ```

   The directory holds both entries, `index.js` (server) and `tui.js` (TUI); `cp -r` copies both. Install it globally. With `worktree` on (the default) every role session runs in the branch's worktree, and a plugin installed per project in `<project>/.opencode/plugins/` is missing there unless it is committed on the branch: those sessions then have no `granny_submit_*` tools and every role fails with `You stopped without calling granny_submit_...`. The opencode service also keeps a directory's first instance, so a worktree path that was first opened without the plugin keeps lacking it until `opencode service restart`.

2. Optional: the `granny` primary agent, whose model is granny's model in opencode:

   ```sh
   cp <skill-dir>/engines/opencode/agents/granny.md ~/.config/opencode/agents/
   ```

   Edit its `model:` line, then switch to it in the TUI.

3. `opencode service restart`, restart the TUI, then start a new session. `granny_run` should be listed among your tools, and

   ```sh
   opencode api GET /api/plugin -H "x-opencode-directory:$PWD"
   ```

   should list `granny-workflow` with `features: { server: true, tui: true }`. The TUI entry is written against the TUI plugin API of opencode 2.2.x; a TUI that cannot load it reports the plugin as failed and shows no granny view, and the runs work as before.

Run granny from the TUI, the desktop app or `opencode run` against the background service. `opencode run --standalone` stops its private server when the command exits, which ends a background run ([When the server stops mid-run](#when-the-server-stops-mid-run)).

## Launch

```
granny_run({ repo, branch, base, context, plan?, stages, repos?, fromStage?, config? })
granny_run({ repo, branch, base, context, goal, plan?, config? })   // plan first, then stop
```

With `goal` the planner writes the plan (to `plan`, default `<repo>/<workDir>/plans/<branch-slug>.md`) in a child session with write access on `roles.planner`'s model, the plan review runs when `"planReview": true`, and the run ends with `draft` in its result and nothing implemented ([config.md](config.md#planning)). Its session works in the worktree, so the default path is in the main checkout: check that your permissions let a session edit it.

`plan` is a list of absolute plan file paths; every agent reads them. The plan review is optional: with `plan` and `"planReview": true` in the config, the run reviews the plan before stage 1 ([Plan review](#plan-review)). It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written; each round is a full review + judge + fix, so it uses many more tokens and makes the run much longer (tens of minutes per round on high-effort models), so turn it on only when the user asks ([config.md](config.md#plan-review)). With it on, the `granny_run` reply carries that warning with the round cap, to pass on to the user.

The plugin reads `~/.config/granny/config.json` and `<repo>/granny.config.json` itself; `config` holds run overrides only. Before it starts it adds the work dir to the common git dir's `info/exclude` and checks `repo`:

- `worktree` on (the default): `repo` may be on any branch and need not be clean - unless `branch` is checked out in `repo`, because then `repo` is the worktree the run reuses, and a dirty tree there refuses the run. Do not check out `branch` yourself. The run's first step, in the background, reuses the worktree that has `branch` checked out or creates one ([config.md](config.md#worktree)); a dirty reused worktree fails the run before any child session starts. Every child session works in the worktree (it is moved there before its first prompt, [Watching a run](#watching-a-run)), and the review commands run there.
- `worktree: false`: it refuses to start when `repo` is not on `branch` or the tree is dirty.
- `repos` (objects `{ repo, base? }`): every repo a stage names with `repo` gets the same checks, with the repo in front of each problem.

Independent stages run at the same time, up to `maxParallel` ([config.md](config.md#parallel-stages)): each stage has its own child sessions, and a same-repo stage that runs in its own worktree has its sessions work there; its merge and cleanup run as commands in the server. The completion message lists each stage with its repo, the final review of every repo (`- final review: <outcome>, <n> review round(s)`, with the skip reason, or `- the branch still has unresolved findings; the final check ran anyway` after `round-cap` or `review-failed`; [config.md](config.md#final-review)), the final check of every other repo, and every repo's worktree. The final review's sessions are `granny · review final review r<n> <reviewer>`, `granny · judge final review r<n>` and `granny · fix final review r<n>`. With `checks` in the config ([config.md](config.md#checks)) the server executes each check command itself in the stage's worktree - a direct exec, the exit code is the real one; a check with a `timeout` runs in `timeout`, or `gtimeout` when only that is on PATH, and with neither the run fails before any session starts - after the implementer, after every fix, once per repo before the final review, and once more without repairs when the final check moved HEAD; a red check goes to a write session `granny · repair <stage> <gate> #<n>`, and uncommitted work found by the `git status --porcelain` read before each run to `granny · commit <stage> <gate> #<n>`. A stage that stays red is listed as `checks-failed` with its note; a red whole branch shows as `- final review: checks-failed, ... - NOT PR-ready, the checks fail: <note>`, and a red run after the final check, or one that left uncommitted files, as `- checks after the final check: RED - NOT PR-ready after the pr-ready check moved HEAD: <note>`. A stage or final review whose work stayed uncommitted ends its line with ` - uncommitted changes after <step>: ...`; a stage whose checks passed while the agent that last touched its code reported red gates ends it with ` - the checks passed, but <who> reported red gates: <gates>`; a `no-changes` stage ends its line with its note, which names the files it left uncommitted. A stage picks its checks with `stages[].checks` (names; default all). The global plugin install below is needed for every repo and every worktree a run touches.

It returns a run id at once and works in the background; its role sessions appear under your session as `granny · <step>` ([Watching a run](#watching-a-run)). When the run ends the plugin posts a `[granny] Run … finished` message into your session, with a `- worktree: <path>` line - that is your cue to report.

- `granny_status({ runId })` - status, journal tail, result. `granny_status({ repo })` finds the latest run in that repo. For a run of this server that is still running it ends with `active roles:`, one line per role at work: `- <label> (<role>, <model>) session <id> · <elapsed>`.
- `granny_cancel({ runId })` - interrupts every running step; nothing further starts. With several reviewers that is every child session running at that moment, and every review command: each command is stopped with everything it started - its process group gets SIGTERM, then SIGKILL 5 s later. A `codex-plugin` review script also stops the app-server broker its companion started outside that process group ([config.md](config.md#the-codex-plugin)). The run ends `cancelled` at once: the step that was running is not retried, and a reviewer or check it stopped is not reported as a failed review or a red check.

Run files: `<repo>/.granny/runs/<id>/` - `input.json`, `status.json`, `journal.jsonl`, `result.json` - in the main checkout you passed as `repo`, also when the run works in another worktree, so `granny_status({ repo })` and `granny_cancel` find runs as before. The PR body and the review outputs are in the worktree's `.granny/`. `status.json` names the session that called `granny_run` (`parent`) and the run's `watch` mode. In the journal every `agent { label, role, phase, session, model, linked }` entry is followed by one `agent-end { label, session, outcome, error? }` when the agent ends (`outcome` `done`, `failed` or `cancelled`), and a role session that could not be linked to your session adds `link-failed { label, error }`. Each role session also carries `metadata["granny-workflow"] = { run, dir, parent, label, role, phase, model }` (`dir` is the run directory, `model` is `provider/id[#variant]` or `null`), which the TUI view uses to find the run.

Reloading opencode's configuration or the plugin while a run is in progress (`opencode reload`, a changed plugin file) does not interrupt the run: the role sessions' results still reach it, and `granny_status` / `granny_cancel` still find it. Only stopping the server ends it.

## Watching a run

**Role sessions.** Every role session is a child of the session that called `granny_run`. opencode puts a new child at its parent's location, so granny moves each one into its work directory (the worktree, or a lane's worktree) before its first prompt and checks where it landed; the role's conversation opens with `The working directory has been changed to <worktree>.`, and the move itself starts no model turn. opencode's own UI then covers the run:

- In your session's composer, the **Subagents** tab lists the role sessions with their agent, title and running or idle state, each role's own `task` subagents nested under it; `ctrl+a` switches between the running and the inactive ones, Enter opens one, `ctrl+d` interrupts it. An interrupted role is asked to finish and call its submit tool, up to three times; after that it ends with nothing, as in [Provider errors](#provider-errors).
- In a role session, opencode's parent-session key goes back to your session and its next/previous child-session keys move between the roles.
- The session list shows top-level sessions only, so the role sessions are not in it; your session's cost total includes theirs.
- Deleting your session deletes its role sessions too, which fails a running run.

When linking a role session fails - creating it as a child throws, the move throws, or the session is not in its work directory afterwards - the journal gets one `link-failed { label, error }`, the half-made session is removed, and that role and every later one of the run run in top-level sessions created in their work directory, found in the session list as `granny · <step>`. The run goes on either way. Linking is the same in every `watch` mode.

**The TUI view** (`tui.js`). With `watch` at `"full"` (the default, [config.md](config.md#watching-a-run)), the TUI shows the run of the session you are in - your session or one of its role sessions; with several, the newest running one:

- **Sidebar**: a section `granny <last 4 characters of the run id> · <status>`, the current phase with its time, then one line per agent of that phase and per running or waiting agent, newest first, at most 8 (then `+N more`): marker, label, model, state and time. Markers: `●` running, `…` between turns (a backoff or retry), `✓` done, `✗` failed, `⊘` cancelled. A click on the section folds it to its first line or unfolds it, and opencode keeps the choice. A finished run shows one line, `granny <id> · done|failed|cancelled · <time>`, for 60 s, then nothing. A run still `running` whose `status.json` and journal have not changed for 10 minutes while none of its role sessions runs (the server died mid-run) shows `granny <id> · stale?`; the view stops polling it and takes it up again once its files change or a role session of it runs.
- **Prompt footer**: a chip `granny · <phase> · <n> running · <time>`; `granny · done` (or `failed`, `cancelled`) for 60 s after the end; `granny · <phase> · stale?` for a stale run.
- **Toasts** on a phase change, a failed role (`<label> failed: <error>`) and the run's end (`run <id> done · <time>`, or its failure or cancellation). They reach you in every session of this TUI once it has seen the run, and from a session outside the run's family opencode gives them an **Open** action that goes to the session that started the run. A TUI that starts watching a run already in progress shows no toasts for what happened before. At most three toasts a second; more become `+N more granny events`.
- **Run navigator**: `/granny`, `<leader>j` or `granny: run navigator` in the command palette opens a full-screen page on the run (`/granny <runId>` on another run this TUI knows; from a role session, with that role selected). The header names the run, its phase, status and time; the tree holds the runs this TUI knows (the chosen one expanded), each run's phases in order, round and stage groups, and agents with role, model, time and live state; under an agent, the child sessions of its role session (its `task` subagents, `●` running, `✓` done). The detail pane shows, for an agent: label and role, model and state, its session id and whether it is linked, its error, its subagents and its journal lines (start, end, retries, provider errors, a link failure; the last 40); for a phase: its journal lines (the last 200); for a run: status, repo, branch, start and end, and the `result.json` path. From 100 columns the tree is on the left and the detail on the right; narrower, the detail takes the last rows under the tree.

| Key | In the navigator |
| --- | --- |
| `↑` / `↓` (`k` / `j`) | move |
| PgUp / PgDn, Home / End | a page; the first or last row |
| Enter | on an agent or subagent: open its opencode session; on a run or phase: fold or unfold |
| Space | fold or unfold |
| Tab or `]`, `[` | the next or previous agent, across phases |
| `p` | the session that started the run |
| Esc or `q` | back where `/granny` was opened, else the session that started the run |

After Enter opened a role's session, `/granny` there brings the navigator back with that role selected. `/granny` inside the navigator does nothing. `<leader>j` is free in opencode 2.2's default keys; should a keybind of yours take it, `/granny` and the palette still open the navigator.

`watch` on opencode: `"full"` all of the above; `"panel"` the sidebar section and the chip only, and `/granny` answers `granny: watching is off for run <id> (watch: "panel")` with how to turn it on; `"off"` none of it. `/granny off` and `/granny on` hide or show the sidebar section and the chip in this TUI until it restarts. With no run in the session, `/granny` says `granny: no granny run in this session yet - role sessions appear once the run starts its first agent.`

The view reads the run files from disk at most once a second - only the journal's new bytes, and `status.json` only when it changed - while a run it knows is running (and not stale) or the navigator is open, and for a few seconds after a session is created or updated, to find new runs. A TUI on another machine than the server cannot read them: it lists the roles from their sessions' metadata only and says `run files not readable`. The view never talks to the server plugin and nothing in the run waits for it, so a TUI that fails to load `tui.js`, or an opencode whose TUI API differs, loses the view, not the run.

## Plan review

The plan review runs after the worktree step and before stage 1 ([config.md](config.md#plan-review)): the review commands run in the server (`codex exec --sandbox read-only ...` for `codex` and `auto`, the companion's `task` for `codex-plugin`), agent reviewers and the judge in read-only child sessions, and the fix in a write session, `granny · fix plan review r<n>`, that answers through `granny_submit_plan_fix`. That session works in the worktree and edits the plan files at their absolute paths without committing them; a plan inside the worktree, or in the main checkout's git-excluded `.granny/` when the worktree is the main checkout, is a path it can write. When the plan review ends `round-cap` or `review-failed`, the run ends `done` without implementing anything: the completion message starts with `- plan review: <outcome>, ... - stopped before stage 1, nothing was implemented`, and `result.json` has `plan`, an empty `stages` and `final: null`. Otherwise the message starts with the plan review line and goes on with the stages.

## Models and permissions

Models are `provider/model[#variant]` (`opencode models`). A role or agent reviewer without a model uses the model of the session that called `granny_run`. `effort` is ignored here; use the `#variant` suffix.

Every child session runs the `build` agent with these session rules: everything allowed except questions, `git push`, `git remote add`, `git stash`, `git rebase`, `git reset --hard` and `gh pr`. Read-only roles (judge, agent reviewers, extraction) additionally cannot edit, `git add` or `git commit`.

Review commands run in the opencode server's environment: `codex`, and the CLI of every `command` reviewer, must be on that PATH and logged in.

## When the server stops mid-run

The run lives in the opencode server; the review command does not. It runs in its own session and process group, so when the server exits - Ctrl+C, SIGTERM, SIGKILL or a crash - nothing signals the review: it runs to the end and writes `<workDir>/review-<stage>-r<n>-<reviewer>.md` and `.log` (with `codex-plugin` it then stops its app-server broker), but nobody reads them. Everything else stops with the server: `status.json` keeps `"status": "running"` without `finishedAt`, the journal ends at the review `command` entry, there is no `result.json` and no message to your session. After a restart, `granny_status` still reports `running` and `granny_cancel` answers `No running granny run "<id>"`, because the run table is in memory. Call `granny_cancel` before stopping the server; after an unplanned exit, relaunch with the same arguments and `fromStage` - the next review round deletes and rewrites the orphaned files.

## Reviewers

Every entry of `reviewers` reviews every round, all at the same time: agent reviewers as concurrent child sessions (`granny · review <stage> r<n> <name>`), the other engines as concurrent review commands in the server.

- `agent` reviews in a read-only child session on the entry's `model` - any `provider/model` the server has, GLM included.
- `auto` (an entry's engine when it names none; the default reviewer list is one `agent` entry instead) here always means the Codex CLI (`codex exec review`); it does not look for OpenAI's Codex plugin for Claude Code. To use the plugin, set the entry's `engine` to `codex-plugin`: the review script then runs the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`, read from the opencode server's environment, with `node`, and fails the reviewer with a note when the companion is not there or `node` is not on the server's `PATH`. `mode: "adversarial-review"` needs `codex-plugin` on opencode; with `auto`, `granny_run` refuses to start.
- `command` runs the template in the server's shell; `{prompt}` arrives as one shell-quoted line.

The journal logs each reviewer's backend every round (`<stage> r<n> <name>: reviewer: ...`). Details: [config.md](config.md#reviewers).

## Provider errors

When a child session's turn ends without a submit call, the plugin reads the session's messages. A turn that ended on a provider error is journaled as `provider-error` (type, message, status). Transient errors - quota, rate limit, timeout, dropped connection, overload (HTTP 429/502/503/504/529) - are retried after 30 s, 2 min, 5 min and 10 min, and the model is asked to continue where it stopped. Any other provider error, or a fifth transient one, ends the role with nothing (`agent-failed`): an implementer that returns nothing fails the run; an agent reviewer that returns nothing is retried once, then ends the stage `review-failed`; a judge that returns nothing is asked once more (`granny · judge <stage> r<n> retry`, [config.md](config.md#the-decision-table)), and when that returns nothing too every finding it was given goes to the implementer unjudged, and the journal says so.

A session API request that fails (creating, prompting or waiting on a child session) throws. For a reviewer that is a reviewer that did not run: it is retried once and then ends the stage `review-failed`, while the other reviewers finish their round and the run stays `running`, so `granny_cancel` still reaches them. For any other role it fails the run.

## Resume

There is no result cache. Restart with the same arguments and `fromStage` set to the first stage that did not finish; earlier stages are recorded as `skipped`, and so is the plan review when `fromStage` is above 1. When the interrupted run already committed the work of the stage you restart from, its implementer adds nothing; that stage is then reviewed over `<base>...HEAD` instead of ending `no-changes`, and the stages after it run ([config.md](config.md#checks), Reading git). A run that stopped in the plan review restarts without `fromStage` (or with `fromStage: 1`), which reviews the plan again. The restart reuses the worktree of the first run; when the interrupted step left uncommitted changes there, the run fails at the worktree step until you commit or discard them. With parallel stages, stages after the one that failed may have finished beside it - the failure line in the journal names the finished and the unfinished stages. A restart with `fromStage` runs every stage from there on again, finished ones included, so pass the stages still to do (drop the finished ones) or tell the implementer in `context` which are already on the branch. A lane worktree a failed stage left behind is reused like the run's own, and refuses the restart while it is dirty.
