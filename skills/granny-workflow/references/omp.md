# granny on omp

The engine is an omp (oh-my-pi) extension (`engines/omp/extensions/granny-workflow/`). In your omp session it adds `granny_run`, `granny_judge`, `granny_status`, `granny_wait` and `granny_cancel`, the `/granny` command and the `alt+w` shortcut. The loop is code inside the extension, which runs in your omp process. Every role runs as its own `omp` process on its own model and answers through a `granny_submit_*` tool. The review commands and the checks run directly in your omp process.

## Install

1. The skill: omp reads skills from `~/.omp/agent/skills/`, `~/.agents/skills/` and a project's `.omp/skills/`, `.agents/skills/` and `.claude/skills/`. If `npx skills add` put the skill somewhere else, link or copy it into one of these.

2. Copy the extension directory into the global extensions directory:

   ```sh
   cp -r <skill-dir>/engines/omp/extensions/granny-workflow ~/.omp/agent/extensions/
   ```

   Install it globally. omp loads project extensions only from `<cwd>/.omp/extensions/`, and with `worktree` on (the default) the run works in the branch's worktree. The role processes do not need the install: they load the extension file by its absolute path. `granny_run` itself must be in your session, though, and a per-project copy is missing in every other directory you start omp in.

3. Quit omp and start it again. `granny_run`, `granny_judge`, `granny_status`, `granny_wait` and `granny_cancel` should be listed among the tools of the new session, and `/granny` among its commands.

There is no `granny` agent definition for omp: omp's agent files define task subagents, not the agent of your session. To run granny's roles on a particular model, start the session on that model - a role without its own model uses the model of the session that called `granny_run` - or set `model` on each role ([config.md](config.md#models-per-host)). `roles.granny` is only the model of the extraction fallback and the final PR-ready check; it does not change your session's model.

## Launch

```
granny_run({ repo, branch, base, context, plan?, stages, repos?, fromStage?, config? })
granny_run({ repo, branch, base, context, goal, plan?, config? })   // plan first, then stop
```

The inputs, the preflight and the run are the same as on opencode. With `goal` the planner writes the plan (to `plan`, default `<repo>/<workDir>/plans/<branch-slug>.md`) in a role process with write access on `roles.planner`'s model. The plan review runs when `"planReview": true`, and the run ends with `draft` in its result and nothing implemented ([config.md](config.md#planning)). `plan` is a list of absolute plan file paths, and every agent reads them. With `plan` and `"planReview": true` the run reviews the plan before stage 1 ([config.md](config.md#plan-review)). That runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written; each round is a full review + judge + fix, so it uses many more tokens and makes the run much longer (tens of minutes per round on high-effort models), so turn it on only when the user asks ([config.md](config.md#plan-review)). With it on, the `granny_run` reply carries that warning with the round cap, to pass on to the user.

The extension reads `~/.config/granny/config.json` (or `$GRANNY_CONFIG`) and `<repo>/granny.config.json` itself; `config` holds run overrides only. Before it starts, it adds the work dir to the common git dir's `info/exclude` and checks `repo`:

- `worktree` on (the default): `repo` may be on any branch and need not be clean. The exception is `branch` checked out in `repo`: then `repo` is the worktree the run reuses, and a dirty tree there refuses the run. Do not check out `branch` yourself. The run's first step, in the background, reuses the worktree that has `branch` checked out or creates one ([config.md](config.md#worktree)). A dirty reused worktree fails the run before any role process starts. Every role process starts in the worktree, and the review commands and checks run there.
- `worktree: false`: it refuses to start when `repo` is not on `branch` or the tree is dirty.
- `repos` (objects `{ repo, base? }`): every repo a stage names with `repo` gets the same checks, with the repo in front of each problem.

Independent stages run at the same time, up to `maxParallel` ([config.md](config.md#parallel-stages)), each with its own role processes. With `checks` in the config ([config.md](config.md#checks)) the extension runs each check command itself (`bash -c` in the stage's worktree, its exit code is the real one) after the implementer, after every fix, once per repo before the final review, and once more without repairs when the final check moved HEAD. The completion message is the same as on opencode ([opencode.md](opencode.md#launch) lists its lines).

`granny_run` returns a run id at once, and the run goes on in the background. Its reply tells the agent to wait with `granny_wait` or end its turn, and never to write its own watcher, sleep or poll loop on the run files. With `watch` `"full"` the reply also tells the agent to tell you where the [run navigator](#watching-a-role) is, and it lists every value a run's `config` changed ([Models and permissions](#models-and-permissions)). When every reviewer is an `agent` reviewer on the implementer's model (two roles with no model share the session model), it adds: "reviewers share the implementer's model; a different model may catch more". That is advice: the run starts either way, and the agent changes no model on its own. A Codex, `command` or `opencode` reviewer counts as different. When it ends, the extension posts a `[granny] Run … finished` message into the session that called `granny_run`, with a `- worktree: <path>` line - that is your cue to report. The message is an omp aside: in a running turn omp injects it at the next step boundary, cutting short an interruptible wait in progress (`granny_wait`, omp's `wait`), and in an idle session it starts a turn (in plan mode, or while an Esc is in effect, omp only adds it to the context). A turn blocked in a tool that is not interruptible - its own watcher, sleep or poll loop in `bash` - gets it only when that tool returns. When it cannot be posted, the journal has a `notify-failed` entry, and `granny_status` still has the result.

- `granny_status({ runId })` - status, journal tail, result. `granny_status({ repo })` finds the latest run in that repo. For a running run of this omp process it appends the [live view](#live-panel) under `live (this omp process):`, every active role, in any mode.
- `granny_wait({ runId, timeoutSeconds? })` - blocks the turn until the run ends and returns what the message would carry: the finish summary, the failure, or `Run <id> was cancelled.` A run that has already ended returns at once. After `timeoutSeconds` (default 1800, clamped to 1-7200) it returns `Run <id> is still running after <n> s. ...`; Esc returns `Stopped waiting; run <id> is still running.` omp then starts no turn by itself until you send a message, also when the run finishes, so the finish message waits in the session and a notice says to send one. It is interruptible: a message you type, or any other aside, ends it with that same text. A run that ends while a `granny_wait` for it is pending reports only through those waits: no message is posted, and the journal has `notified-via-wait`. It waits only for a run of this omp process (the run table is in memory); for any other run it points to `granny_status({ repo })`.
- `granny_cancel({ runId })` - interrupts every running step; nothing further starts. Every role process and every review command runs in its own process group. Each group gets SIGTERM, then SIGKILL 5 s later when it is still running. The run ends `cancelled` at once: the step that was running is not retried, and a reviewer or check it stopped is not reported as a failed review or a red check.

Run files: `<repo>/.granny/runs/<id>/` - `input.json`, `status.json`, `journal.jsonl`, `result.json` - in the main checkout you passed as `repo`, also when the run works in another worktree. Every terminal state writes `result.json`, after `status.json`, so a `result.json` means the run has ended and `status.json` already says how: `done` writes the run's result, `failed` and `cancelled` write `{ id, status, finishedAt, error }` with the error message (a failure's stack is in `status.json`; a cancel leaves `"error": "cancelled"` there). Each role process has its own directory there, `sessions/<n>-<label>/`, which holds its omp session (`<time>_<uuid>.jsonl`, its `task` subagents' sessions as `<time>_<uuid>/<Name>.jsonl`), `submission.json`, the arguments of its submit call, and with `watch` `"full"` its [event log](#watching-a-role) `events.jsonl`. The journal's `agent` entry `{ label, role, phase, session, model, effort?, cwd }` names the phase of the call and the directory the agent works in (`cwd`), and every agent that started is followed by `agent-end { label, session, outcome, error? }` - `done`, `failed` (no result, or the error it threw) or `cancelled` - in every `watch` mode. The journal has a `stage { number, name, event, outcome? }` entry when a stage starts and ends (`event` is `start` or `end`, `outcome` the stage's outcome on `end`; a stage that never started because one it builds on failed has one `end` with outcome `skipped`, and a stage before `fromStage` has none), and a `heartbeat { command }` entry every 60 s while a check or review command runs, which says only that the run is alive; `granny_status`'s journal tail leaves it out and the views draw nothing for it. `status.json` holds the run's `outline` from the start, `{ kind, branch, worktree, planReview, finalReview, reviewers, fromStage, stages: [{ number, name, implement, review, checks }] }` with `kind` `plan`, `implement` or `judge`: what the navigator needs to list stages and steps still to come. The PR body and the review outputs are in the worktree's `.granny/`.

## Review only: `granny judge`

```
granny_judge({ repo, base?, context?, config? })
```

The steps, with what to ask the user, are in [judge.md](judge.md). One review of the checkout's `<base>...HEAD` and one tagging of its findings, and the report goes to `<repo>/<workDir>/reviews/<date>-<branch>.md` (by default `.granny/reviews/`). It changes nothing else: no fix, commit, push, branch or worktree.

It refuses, with `granny_judge refused:`, before anything starts:

- when the reviewers or the judge model are missing from the config files: `reviewers: no config sets who reviews`, `reviewers[<n>] (<name>): no model for omp`, `roles.judge.model: no model for omp`. The reply ends by telling the agent to ask the user and write them to the config. The run's own `config` does not answer this, so the agent cannot pick the models itself; it can still open a gap, which is refused too.
- when a model it would use cannot run here, in the judge, the extraction agent (`roles.granny`) or an `agent` reviewer. A bad `roles.implementer.model` does not block a review that never uses it.
- when `repo` is not a git repository.

There is no preflight: a dirty tree is allowed, and the uncommitted files are listed in the report and the finish message; no branch is required, and a detached HEAD goes by its short SHA. The run's files, `granny_wait`, `granny_status` and `granny_cancel` work as on any run. `status.json`'s `outline` has `kind` `judge`, no stages and no worktree, and the [run navigator](#watching-a-role) lists `Review`, `Tag` and `Report`, with the role agents selectable as in any run. The start reply names the reviewers and the judge model, says nothing will be changed, and has the `granny_wait` sentence and the `overrides:` line. The finish message gives the report path first, the counts per heading, how many reviewer P0/P1 findings the judge placed lower, what was not reviewed and which reviewers did not run, and tells the agent to give the user the path and counts and to fix nothing unless asked. With `written: false` the report's text is in `result.json`, under `report`.

## Live panel

In the TUI, `granny_run` shows a widget above the editor (key `granny-<id>`) and a status line, `granny <id> · <phase> · <n> active · <elapsed>`:

```
granny 20261105-165811-dww8 · Plan · 11m02s · /granny or alt+w: agents
  plan (planner) · openai-codex/gpt-6.1-sol/max · thinking 6m02s · "Comparing authentication options"
    last tool: Reading auth controller routes (8m00s ago)
    └ task: BaselineGates ✓, PublishedContracts ✓
```

Per running role process: label, role, model/effort (`default model` when omp picks it), and what it does now and for how long - `starting`, `waiting for model`, `thinking` (with the latest `**heading**` of the reasoning, as GPT models stream them), `writing`, `preparing a tool call`, `running <tool>: <intent>` (the tool's intent, else a short argument: a path relative to the role's work directory, a command without its leading `cd <dir> && `, a pattern); then `last tool:` (✗ when it failed) and `└ task:` with the subagents of its latest `task` call (`…` while it runs, ✓ or ✗ when it ended). It reads the role processes' JSON events, so it moves while a long answer streams, before anything reaches the session files. With `watch` `"full"` its first line ends with `/granny or alt+w: agents`, the way into the [run navigator](#watching-a-role). At most 8 lines, the rest of the roles as `+N more`; redrawn at most once a second. When the run ends the widget goes, and the status line says `granny <id>: done`, `failed` or `cancelled` for a minute or until the next run starts. Without a UI (print, json, rpc mode) there is no panel; `granny_status` shows the same view. The journal gets a `subagent` entry `{ label, agents }` for every `task` call of a role, nothing per other tool call. With `"watch": "off"` ([config.md](config.md#watching-a-run)) there is no panel and no status line either; `/granny off` hides them for the rest of the omp session (running runs too) and `/granny on` brings them back, without writing any config. `granny_status`'s live view and the `subagent` entries stay in every mode.

## Watching a role

`watch` in the config ([config.md](config.md#watching-a-run)) sets how much of a run the session shows: `"full"` (default) the panel, an event log per role and the run navigator; `"panel"` the panel only; `"off"` nothing. The run itself is the same in every mode.

**Event log.** With `"full"`, each role process appends to `sessions/<n>-<label>/events.jsonl` while it streams (the file appears with its first entry). One JSON object per line, each with `t` (ISO time), condensed from the process's JSON events - never the raw stream, whose `message_update` lines carry the whole partial message each time:

- `{ type: "state", state }` - each change: `waiting for model`, `thinking`, `writing`, `preparing a tool call`, `running <tool>: <intent>`;
- `{ type: "heading", text }` - each new `**heading**` of the reasoning;
- `{ type: "tool", id?, name, intent?, arg? }` when a tool starts (`arg`: path, pattern or the first 200 characters of a command), `{ type: "tool-end", id?, name, error? }` when it ends;
- `{ type: "todo", todos }` - the list after a todo call, each `{ text, state }` with `state` `done`, `active` or `pending`;
- `{ type: "text", text }` - the final text of each answer, cut to 4000 characters;
- `{ type: "subagents", agents }` for a `task` call, `{ type: "exit", code }` when the process closes (each `--continue` follow-up adds its own entries to the same file).

A failed append is journalled once per role (`event-log-failed` with the path and error) and that role's log stops there; the run goes on.

**Run navigator.** `/granny` or `alt+w` in the omp TUI opens it; the run panel says so. It is a full-screen page (omp's alternate screen; an omp without it draws an overlay) on the latest running run of this omp process, else its latest run; `/granny <runId>` opens it on that run. It lists only this process's runs (the run table is in memory, as for `granny_wait`) with `watch` `"full"`; a second `/granny` or `alt+w` while it is open does nothing.

The navigator shows one level at a time. Enter goes down, Esc goes up, and the first row always says where you are: `granny › 2 Client pause UI › Round 2 of 4 › terra`. `/granny` or `alt+w` opens it on the stages, with the running one selected.

**1. The stages**: every piece of work in order, what it is doing, how many agents it had and how many run now.

```
granny  feat/pause  ● running · 21m36s

  ✓ Worktree                                                                2s
  │
  ✓ 1 Server pause domain      clean · 2 rounds       7 agents          12m04s
  │
› ● 2 Client pause UI          round 2 of 4           7 agents · 2 running  9m30s
  │
  · Final review               waiting
  │
  · PR ready                   waiting

  run details

↑↓ move · Enter open · Esc close
```

A row that has not started does not open. `run details` is the only place with the run's id, repo, branch, times, `result.json` path and result. With several runs the list of runs takes its place: Enter on another run shows it.

**2. A stage**: its implementer and checks, then the review loop with its rounds, the ones still possible and the round cap. With `stepAgents` on and a stage with steps, its implementer is one agent per step, each labelled `implement <stage> step <k>/<n>` ([config.md](config.md#step-agents)).

```
granny › 2 Client pause UI

  ✓ Implement     k3.1-pro                     1 agent     4m52s
  │
  ✓ Checks        passed
  │
┌ ↺ review loop · up to 4 rounds ───────────────────────────────────────┐
│   ✓ Round 1   4 findings: 3 sent back, 1 kept   5 agents        3m42s │
│ › ● Round 2   reviewing                         2 agents · 2 running 42s │
│   · Round 3   only if round 2 sends findings back                     │
│   · Round 4   the last one                                            │
└───────────────────────────────────────────────────────────────────────┘
  │
  · Next          Final review

↑↓ move · Enter open · l log · Esc back
```

`l` shows the stage's full name, state, time, outcome, checks result and journal lines. Final review and plan review have the same loop. A group without a loop lists its agents; a judge run has the groups `Review`, `Tag` and `Report`. A run journalled before round entries existed still has its rounds, without their findings.

**3. A round**: what happens in it in order, with the agents that run at the same time side by side (stacked when the terminal is narrow).

```
granny › 2 Client pause UI › Round 2 of 4

  ● Review   2 agents at the same time
    ┌──────────────────────────────┐  ┌──────────────────────────────┐
    │ ● terra  42s                 │  │ ● sol  38s                   │
    │ running read: PauseButton.tsx│  │ running bash: bun test       │
    └──────────────────────────────┘  └──────────────────────────────┘
  │
  · Judge    after the reviewers
  │
  · Fix      only if findings go back
  │
  · Checks   after the fix
  │
  · Next     Round 3, or the stage is done

↑↓←→ move · Enter open agent · [ ] other round · l log · Esc back
```

A finished round says what each step did: `2 findings` under Review, `1 sent back, 1 kept` at the judge, and on each reviewer's card how many it found. `f` lists the round's findings with `↺ sent back` or `· kept`; below the list, the selected one's file, what the reviewer said, how the judge classified it and why it went back or stayed. Enter opens the agent that found it. A checks row opens its journal lines.

**4. An agent**: the first rows are `<role> · <short model> · <time>` (the short model is the model without its provider and `#default`, plus its variant or effort: `gpt-6.1-sol/xhigh`, or `default model`), `! <error>` when it failed, then the summary. `t` opens its conversation file, `v` its full event list. Tab, `]` and `[` go through the other agents of its round and their subagents.

- `NOW`: what it does this moment and for how long - `● thinking 42s`, `● writing 5s`, `● bash · 7s` with the tool's intent or short argument on the next row, `… waiting for model 3s`. A finished agent's outcome goes here: `✓ done in 18m`, `✗ failed after 3m: <error>`, `⊘ cancelled after 2m`.
- `TODO`: one row with the items of its todo tool (`✓` done, `●` active, `·` pending), when it used one.
- `RECENT`: newest first, one row per item, cut and never wrapped: `HH:MM:SS  <tool>  <short argument>`, relative to the agent's work directory. Calls of the same tool within a few seconds collapse (`read   7 files · a.ts, b.ts, …`, `(2×)` for one target), a failed call ends in `✗`, and retries and provider errors from the journal are rows too.
- `LAST SAID`: the latest assistant text, at most two rows.
- `v` shows every event in time order instead; PgUp/PgDn and Home/End scroll that list, End and `f` follow its end, and `v` goes back to the summary.

Esc at the top closes the navigator; for half a second after that, one press too many does nothing, so it cannot stop the turn. The last row of the page is the keys of that level (`v details · t transcript · Tab/] [ agent · ←/Esc back · q close` on an agent). Rows fit any width: narrow, a row's middle column goes first, then its agents; a page too short for its rows drops the `│` rows and then scrolls to the selection.

A list opens at its end; follow is on for a running agent, so new lines keep the view at the end; scrolling up turns it off, End turns it on. Files are read by offset, only the new bytes, at most once a second while they grow and at once after a key; a list keeps its last 5000 events or lines, a group its last 200 journal lines, a checks row its last 50, and a first read of a file over 8 MB starts at its last 8 MB. Nothing in the run waits for the navigator, and a TUI that can no longer redraw it closes it.

`/granny off` / `/granny on` hide or show the panel (above). For a run with `"panel"` or `"off"`, `/granny` and `alt+w` say `watching is off for run <id> (watch: "<mode>")` and how to turn it on. Outside the TUI (print, json, rpc mode) `/granny` prints each role's `events.jsonl` path instead, as a message that starts no turn. The navigator is an omp page, not a terminal pane (omp's `openTerminal` needs a multiplexer), so to follow a log outside omp, `tail -f` its path. `alt+w` is free in omp 18.16; should a later omp bind it, `/granny` still opens the navigator.

## Role processes

Each role runs as

```sh
omp --mode json --no-title --no-extensions -e <extension file> --approval-mode yolo \
    --session-dir <run dir>/sessions/<n>-<label> [--model <model>] [--thinking <effort>]
```

in the worktree, with the prompt on stdin and `GRANNY_OMP_CHILD` set. Loaded that way, the extension registers only the role's submit tool and the permission guard below, so a role cannot start a nested run. omp loads it again for every `task` subagent the role spawns, so the guard covers subagents too, but only the role's top-level agent submits: a subagent's submit call records nothing and is told to return its findings to the agent that spawned it, and a subagent session drops the submit tool from its active tools when it starts. `--no-extensions` keeps your own extensions out of role processes: only granny's loads. The binary is `omp` on the `PATH` of your omp session; set `GRANNY_OMP_BIN` to use another one. When it cannot be found, the role throws `cannot run omp: "<bin>" was not found - install omp or set GRANNY_OMP_BIN to its path`.

The prompt ends by asking the role to call its submit tool exactly once. When the process exits, the extension reads `submission.json` and checks it against the result's schema. When the arguments do not fit, the role is asked to call the tool again, with the problems listed. When there was no call, the role is told `You stopped without calling <tool>. Call it now with your result.` Every follow-up runs the same command with `--continue`, so the role resumes its own session with its context. After 3 misses the role ends with nothing (`agent-failed`).

## Models and permissions

Models are what omp's `--model` takes: `provider/id` (exact, such as `anthropic/claude-sonnet-5-5`), a fuzzy id (`opus`), or a model role from your omp settings (`slow`, `@slow`). List them with `omp models`. A role or agent reviewer without a model uses the model of the session that called `granny_run`; when that is unknown, omp picks its default. `effort` is passed as `--thinking <effort>`: `low`, `medium`, `high`, `xhigh` and `max` are all omp thinking levels. Of a host-keyed `effort` only the `omp` key is passed, and without that key the role gets no `--thinking`.

`granny_run` checks every role's and every `agent` reviewer's model before anything starts. A Claude Code alias (`default`, `sonnet`, `opus`, `haiku`, `opusplan`) written as one string for every host gets `granny_run refused:` with one line per entry, the config layer it came from and the fix, a host-keyed model: `{ "claude-code": "sonnet", "omp": "<provider/model>" }`. Keyed to omp (`{ "omp": "opus" }`) the same word is your choice and goes to `--model` as a fuzzy id.

`roles.*.model`, `roles.*.effort`, `reviewers`, `threshold`, `maxRounds` and `checks` come from your config files. The agent that calls `granny_run` overrides them in `config` only when the user asked for that change in this conversation; when a provider limit or error blocks a run, it must stop and ask the user which model to use. The `granny_run` schema says so, and the start reply lists every value the run's `config` changed from the config files, for the agent to show you: `overrides: roles.implementer.model kimi-code/k3.1-pro (config: openai-codex/gpt-6.1-sol), ...`. Without a change there is no such line.

Role processes run with `--approval-mode yolo`: they never wait for an approval, and granny's guard, a `tool_call` handler, is what limits them. For every role it blocks:

- the `ask` tool - no one answers a role;
- the `github` tool's `pr_create`, `pr_push` and `pr_checkout` operations;
- a `bash` command that runs `git push`, `git remote add`, `git stash`, `git rebase`, `git reset --hard` or `gh pr` anywhere in its command line. That includes after `cd x &&`, `;`, `|` or `(`, inside `$(...)` and backticks, behind `env`, `sudo`, `nice`, `timeout`, `xargs`, `exec`, `command` or `time` and their options, behind git's own options (`git -C dir push`), and in a `bash -c`, `sh -c` or `eval` string.

Read-only roles (the judge, `agent` reviewers, the extraction agent) may call only `read`, `grep`, `glob`, `find`, `ast_grep`, `lsp`, `bash`, `web_search`, `todo`, `think`, `wait`, `yield` and their submit tool. Their `bash` commands additionally cannot `git add` or `git commit`. The guard reads only the `bash` tool's command line: it does not see code a writing role runs through `eval`, and a read-only role's `bash` can still write files. That matches opencode, whose rules cover the same commands.

Review commands and checks run in your omp process's environment: the CLI of every `command` reviewer and the `opencode` binary of every `opencode` reviewer must be on that `PATH` and logged in (an `opencode` reviewer to its model's provider).

## When the omp session exits mid-run

The run lives in your omp process; its role processes and review commands do not. Each is in its own process group, so when omp exits - you quit it, its terminal closes, or it crashes - nothing signals them. A review command runs to the end and writes `<workDir>/review-<stage>-r<n>-<reviewer>.md` and `.log`, but nobody reads them. A role process that was mid-turn is not stopped either and may keep editing and committing in the worktree. Find leftovers with `pgrep -af 'runs/<id>/sessions'` (every role process has its session dir on its command line) and stop them yourself.

Everything else stops with omp: `status.json` keeps `"status": "running"` without `finishedAt`, and since the run never reaches a terminal state there is no `result.json` and no message to your session. In a new omp process `granny_status({ repo })` still reads the run's files, but `granny_cancel` answers `No running granny run "<id>"` and `granny_wait` does not know the run, because the run table is in memory. Call `granny_cancel` before you quit omp. After an unplanned exit, stop the leftovers and relaunch with the same arguments and `fromStage`; the next review round deletes and rewrites the orphaned review files.

A new session inside the same omp process still sees the run: `granny_status`, `granny_wait` and `granny_cancel` find it there.

## Reviewers

Every entry of `reviewers` reviews every round, all at the same time: agent reviewers as concurrent role processes (each session dir is named after its label, `review <stage> r<n> <name>`), the other engines as concurrent review commands in your omp process.

- `agent` reviews in a read-only role process on the entry's `model` and `effort` (the `omp` key of a host-keyed `effort`) - any model omp has, GLM included (`zai/glm-5.3`).
- No Codex engine: `auto`, `codex` and `codex-plugin` - and so an entry without `engine` - are refused before the run starts, with a message naming the entry. omp reaches Codex models itself, so a Codex review here is an `agent` reviewer on one of them, e.g. `{ "name": "codex", "engine": "agent", "model": { "omp": "openai-codex/gpt-6.1-sol" } }` (`omp models` lists the ids); the message also names `"engine": "opencode"` for a model opencode reaches and omp does not.
- `command` runs the template in your omp process's shell; `{prompt}` arrives as one shell-quoted line.
- `opencode` runs `opencode run --standalone` in your omp process's shell as a read-only agent opencode enforces (only reading and read-only git), on the entry's opencode `provider/model` with `effort` as its variant - for a model opencode reaches and omp does not. opencode must be installed and logged in to that provider ([config.md](config.md#opencode-reviewers)).

The journal logs each reviewer's backend every round (`<stage> r<n> <name>: reviewer: ...`). Details: [config.md](config.md#reviewers).

## Provider errors

When a role process ends without a submit call, the extension reads the last assistant message among its JSON events. A message that ended on `stopReason: "error"`, or a process that exited non-zero without any assistant message, is a provider error, journaled as `provider-error` with its message. Transient errors - quota, rate limit, timeout, a dropped connection, overload (HTTP 429/502/503/504/529) - are retried with `--continue` after 30 s, 2 min, 5 min and 10 min, and the model is asked to continue where it stopped. Any other provider error, or a fifth transient one, ends the role with nothing (`agent-failed`). An implementer that returns nothing fails the run. An agent reviewer that returns nothing is retried once, then ends the stage `review-failed`. A judge that returns nothing is asked once more ([config.md](config.md#the-decision-table)); when that returns nothing too, every finding it was given goes to the implementer unjudged, and the journal says so.

A role process that cannot start throws. For a reviewer, that is a reviewer that did not run: it is retried once and then ends the stage `review-failed`. For any other role it fails the run.

## Resume

There is no result cache. Restart with the same arguments and `fromStage` set to the first stage that did not finish, exactly as on opencode ([opencode.md](opencode.md#resume)). Earlier stages are recorded as `skipped`, and so is the plan review when `fromStage` is above 1. The restart reuses the worktree of the first run; when the interrupted step left uncommitted changes there, the run fails at the worktree step until you commit or discard them.

## When the PR is opened

The run's review trail is in `<worktree>/.granny/trail/` (`trail.dir` in the result). Once the PR is open, run `cd <worktree> && node <skill-dir>/scripts/pr-comments.mjs` and relay its output; it posts every round as a review on the GitHub PR or GitLab MR, and on any other platform `--out <file>` writes the rounds for another client ([config.md](config.md#review-trail)). Only the script posts review comments - never write or post them yourself.
