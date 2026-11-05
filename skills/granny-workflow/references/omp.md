# granny on omp

The engine is an omp (oh-my-pi) extension (`engines/omp/extensions/granny-workflow/`). In your omp session it adds `granny_run`, `granny_status`, `granny_wait` and `granny_cancel`. The loop is code inside the extension, which runs in your omp process. Every role runs as its own `omp` process on its own model and answers through a `granny_submit_*` tool. The review commands and the checks run directly in your omp process.

## Install

1. The skill: omp reads skills from `~/.omp/agent/skills/`, `~/.agents/skills/` and a project's `.omp/skills/`, `.agents/skills/` and `.claude/skills/`. If `npx skills add` put the skill somewhere else, link or copy it into one of these.

2. Copy the extension directory into the global extensions directory:

   ```sh
   cp -r <skill-dir>/engines/omp/extensions/granny-workflow ~/.omp/agent/extensions/
   ```

   Install it globally. omp loads project extensions only from `<cwd>/.omp/extensions/`, and with `worktree` on (the default) the run works in the branch's worktree. The role processes do not need the install: they load the extension file by its absolute path. `granny_run` itself must be in your session, though, and a per-project copy is missing in every other directory you start omp in.

3. Quit omp and start it again. `granny_run`, `granny_status`, `granny_wait` and `granny_cancel` should be listed among the tools of the new session.

There is no `granny` agent definition for omp: omp's agent files define task subagents, not the agent of your session. To run granny's roles on a particular model, start the session on that model - a role without its own model uses the model of the session that called `granny_run` - or set `model` on each role ([config.md](config.md#models-per-host)). `roles.granny` is only the model of the extraction fallback and the final PR-ready check; it does not change your session's model.

## Launch

```
granny_run({ repo, branch, base, context, plan?, stages, repos?, fromStage?, config? })
granny_run({ repo, branch, base, context, goal, plan?, config? })   // plan first, then stop
```

The inputs, the preflight and the run are the same as on opencode. With `goal` the planner writes the plan (to `plan`, default `<repo>/<workDir>/plans/<branch-slug>.md`) in a role process with write access on `roles.planner`'s model. The plan review runs when `"planReview": true`, and the run ends with `draft` in its result and nothing implemented ([config.md](config.md#planning)). `plan` is a list of absolute plan file paths, and every agent reads them. With `plan` and `"planReview": true` the run reviews the plan before stage 1 ([config.md](config.md#plan-review)). That runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written, so it costs extra tokens.

The extension reads `~/.config/granny/config.json` (or `$GRANNY_CONFIG`) and `<repo>/granny.config.json` itself; `config` holds run overrides only. Before it starts, it adds the work dir to the common git dir's `info/exclude` and checks `repo`:

- `worktree` on (the default): `repo` may be on any branch and need not be clean. The exception is `branch` checked out in `repo`: then `repo` is the worktree the run reuses, and a dirty tree there refuses the run. Do not check out `branch` yourself. The run's first step, in the background, reuses the worktree that has `branch` checked out or creates one ([config.md](config.md#worktree)). A dirty reused worktree fails the run before any role process starts. Every role process starts in the worktree, and the review commands and checks run there.
- `worktree: false`: it refuses to start when `repo` is not on `branch` or the tree is dirty.
- `repos` (objects `{ repo, base? }`): every repo a stage names with `repo` gets the same checks, with the repo in front of each problem.

Independent stages run at the same time, up to `maxParallel` ([config.md](config.md#parallel-stages)), each with its own role processes. With `checks` in the config ([config.md](config.md#checks)) the extension runs each check command itself (`bash -c` in the stage's worktree, its exit code is the real one) after the implementer, after every fix, once per repo before the final review, and once more without repairs when the final check moved HEAD. The completion message is the same as on opencode ([opencode.md](opencode.md#launch) lists its lines).

`granny_run` returns a run id at once, and the run goes on in the background. Its reply tells the agent to wait with `granny_wait` or end its turn, and never to write its own watcher, sleep or poll loop on the run files. When it ends, the extension posts a `[granny] Run … finished` message into the session that called `granny_run`, with a `- worktree: <path>` line - that is your cue to report. The message is an omp aside: in a running turn omp injects it at the next step boundary, cutting short an interruptible wait in progress (`granny_wait`, omp's `wait`), and in an idle session it starts a turn (in plan mode, or while an Esc is in effect, omp only adds it to the context). A turn blocked in a tool that is not interruptible - its own watcher, sleep or poll loop in `bash` - gets it only when that tool returns. When it cannot be posted, the journal has a `notify-failed` entry, and `granny_status` still has the result.

- `granny_status({ runId })` - status, journal tail, result. `granny_status({ repo })` finds the latest run in that repo. For a running run of this omp process it appends the [live view](#live-panel) under `live (this omp process):`, every active role, in any mode.
- `granny_wait({ runId, timeoutSeconds? })` - blocks the turn until the run ends and returns what the message would carry: the finish summary, the failure, or `Run <id> was cancelled.` A run that has already ended returns at once. After `timeoutSeconds` (default 1800, clamped to 1-7200) it returns `Run <id> is still running after <n> s. ...`; Esc returns `Stopped waiting; run <id> is still running.` It is interruptible: a message you type, or any other aside, ends it with that same text. A run that ends while a `granny_wait` for it is pending reports only through those waits: no message is posted, and the journal has `notified-via-wait`. It waits only for a run of this omp process (the run table is in memory); for any other run it points to `granny_status({ repo })`.
- `granny_cancel({ runId })` - interrupts every running step; nothing further starts. Every role process and every review command runs in its own process group. Each group gets SIGTERM, then SIGKILL 5 s later when it is still running.

Run files: `<repo>/.granny/runs/<id>/` - `input.json`, `status.json`, `journal.jsonl`, `result.json` - in the main checkout you passed as `repo`, also when the run works in another worktree. Every terminal state writes `result.json`, after `status.json`, so a `result.json` means the run has ended and `status.json` already says how: `done` writes the run's result, `failed` and `cancelled` write `{ id, status, finishedAt, error }` with the error message (the stack is in `status.json`). Each role process has its own directory there, `sessions/<n>-<label>/`, which holds its omp session and `submission.json`, the arguments of its submit call. The PR body and the review outputs are in the worktree's `.granny/`.

## Live panel

In the TUI, `granny_run` shows a widget above the editor (key `granny-<id>`) and a status line, `granny <id> · <phase> · <n> active · <elapsed>`:

```
granny 20261105-165811-dww8 · Plan · 11m02s
  plan (planner) · openai-codex/gpt-6.1-sol/max · thinking 6m02s · "Comparing authentication options"
    last tool: Reading auth controller routes (8m00s ago)
    └ task: BaselineGates ✓, PublishedContracts ✓
```

Per running role process: label, role, model/effort (`default model` when omp picks it), and what it does now and for how long - `starting`, `waiting for model`, `thinking` (with the latest `**heading**` of the reasoning, as GPT models stream them), `writing`, `preparing a tool call`, `running <tool>: <intent>` (the tool's intent, else a short argument: path, command, pattern); then `last tool:` (✗ when it failed) and `└ task:` with the subagents of its latest `task` call (`…` while it runs, ✓ or ✗ when it ended). It reads the role processes' JSON events, so it moves while a long answer streams, before anything reaches the session files. At most 8 lines, the rest of the roles as `+N more`; redrawn at most once a second. When the run ends the widget goes, and the status line says `granny <id>: done`, `failed` or `cancelled` for a minute or until the next run starts. Without a UI (print, json, rpc mode) there is no panel; `granny_status` shows the same view. The journal gets a `subagent` entry `{ label, agents }` for every `task` call of a role, nothing per other tool call.

## Role processes

Each role runs as

```sh
omp --mode json --no-title --no-extensions -e <extension file> --approval-mode yolo \
    --session-dir <run dir>/sessions/<n>-<label> [--model <model>] [--thinking <effort>]
```

in the worktree, with the prompt on stdin and `GRANNY_OMP_CHILD` set. Loaded that way, the extension registers only the role's submit tool and the permission guard below, so a role cannot start a nested run. omp loads it again for every `task` subagent the role spawns, so the guard covers subagents too, but only the role's top-level agent submits: a subagent's submit call records nothing and is told to return its findings to the agent that spawned it, and a subagent session drops the submit tool from its active tools when it starts. `--no-extensions` keeps your own extensions out of role processes: only granny's loads. The binary is `omp` on the `PATH` of your omp session; set `GRANNY_OMP_BIN` to use another one. When it cannot be found, the role throws `cannot run omp: "<bin>" was not found - install omp or set GRANNY_OMP_BIN to its path`.

The prompt ends by asking the role to call its submit tool exactly once. When the process exits, the extension reads `submission.json` and checks it against the result's schema. When the arguments do not fit, the role is asked to call the tool again, with the problems listed. When there was no call, the role is told `You stopped without calling <tool>. Call it now with your result.` Every follow-up runs the same command with `--continue`, so the role resumes its own session with its context. After 3 misses the role ends with nothing (`agent-failed`).

## Models and permissions

Models are what omp's `--model` takes: `provider/id` (exact, such as `anthropic/claude-sonnet-5-5`), a fuzzy id (`opus`), or a model role from your omp settings (`slow`, `@slow`). List them with `omp models`. A role or agent reviewer without a model uses the model of the session that called `granny_run`; when that is unknown, omp picks its default. `effort` is passed as `--thinking <effort>`: `low`, `medium`, `high`, `xhigh` and `max` are all omp thinking levels.

Role processes run with `--approval-mode yolo`: they never wait for an approval, and granny's guard, a `tool_call` handler, is what limits them. For every role it blocks:

- the `ask` tool - no one answers a role;
- the `github` tool's `pr_create`, `pr_push` and `pr_checkout` operations;
- a `bash` command that runs `git push`, `git remote add`, `git stash`, `git rebase`, `git reset --hard` or `gh pr` anywhere in its command line. That includes after `cd x &&`, `;`, `|` or `(`, inside `$(...)` and backticks, behind `env`, `sudo`, `nice`, `timeout`, `xargs`, `exec`, `command` or `time` and their options, behind git's own options (`git -C dir push`), and in a `bash -c`, `sh -c` or `eval` string.

Read-only roles (the judge, `agent` reviewers, the extraction agent) may call only `read`, `grep`, `glob`, `find`, `ast_grep`, `lsp`, `bash`, `web_search`, `todo`, `think`, `wait`, `yield` and their submit tool. Their `bash` commands additionally cannot `git add` or `git commit`. The guard reads only the `bash` tool's command line: it does not see code a writing role runs through `eval`, and a read-only role's `bash` can still write files. That matches opencode, whose rules cover the same commands.

Review commands and checks run in your omp process's environment: the CLI of every `command` reviewer must be on that `PATH` and logged in.

## When the omp session exits mid-run

The run lives in your omp process; its role processes and review commands do not. Each is in its own process group, so when omp exits - you quit it, its terminal closes, or it crashes - nothing signals them. A review command runs to the end and writes `<workDir>/review-<stage>-r<n>-<reviewer>.md` and `.log`, but nobody reads them. A role process that was mid-turn is not stopped either and may keep editing and committing in the worktree. Find leftovers with `pgrep -af 'runs/<id>/sessions'` (every role process has its session dir on its command line) and stop them yourself.

Everything else stops with omp: `status.json` keeps `"status": "running"` without `finishedAt`, and since the run never reaches a terminal state there is no `result.json` and no message to your session. In a new omp process `granny_status({ repo })` still reads the run's files, but `granny_cancel` answers `No running granny run "<id>"` and `granny_wait` does not know the run, because the run table is in memory. Call `granny_cancel` before you quit omp. After an unplanned exit, stop the leftovers and relaunch with the same arguments and `fromStage`; the next review round deletes and rewrites the orphaned review files.

A new session inside the same omp process still sees the run: `granny_status`, `granny_wait` and `granny_cancel` find it there.

## Reviewers

Every entry of `reviewers` reviews every round, all at the same time: agent reviewers as concurrent role processes (each session dir is named after its label, `review <stage> r<n> <name>`), the other engines as concurrent review commands in your omp process.

- `agent` reviews in a read-only role process on the entry's `model` and `effort` - any model omp has, GLM included (`zai/glm-5.3`).
- No Codex engine: `auto`, `codex` and `codex-plugin` - and so an entry without `engine` - are refused before the run starts, with a message naming the entry. omp reaches Codex models itself, so a Codex review here is an `agent` reviewer on one of them, e.g. `{ "name": "codex", "engine": "agent", "model": { "omp": "openai-codex/gpt-6.1-sol" } }` (`omp models` lists the ids).
- `command` runs the template in your omp process's shell; `{prompt}` arrives as one shell-quoted line.

The journal logs each reviewer's backend every round (`<stage> r<n> <name>: reviewer: ...`). Details: [config.md](config.md#reviewers).

## Provider errors

When a role process ends without a submit call, the extension reads the last assistant message among its JSON events. A message that ended on `stopReason: "error"`, or a process that exited non-zero without any assistant message, is a provider error, journaled as `provider-error` with its message. Transient errors - quota, rate limit, timeout, a dropped connection, overload (HTTP 429/502/503/504/529) - are retried with `--continue` after 30 s, 2 min, 5 min and 10 min, and the model is asked to continue where it stopped. Any other provider error, or a fifth transient one, ends the role with nothing (`agent-failed`). An implementer that returns nothing fails the run. An agent reviewer that returns nothing is retried once, then ends the stage `review-failed`. A judge that returns nothing is asked once more ([config.md](config.md#the-decision-table)); when that returns nothing too, every finding it was given goes to the implementer unjudged, and the journal says so.

A role process that cannot start throws. For a reviewer, that is a reviewer that did not run: it is retried once and then ends the stage `review-failed`. For any other role it fails the run.

## Resume

There is no result cache. Restart with the same arguments and `fromStage` set to the first stage that did not finish, exactly as on opencode ([opencode.md](opencode.md#resume)). Earlier stages are recorded as `skipped`, and so is the plan review when `fromStage` is above 1. The restart reuses the worktree of the first run; when the interrupted step left uncommitted changes there, the run fails at the worktree step until you commit or discard them.
