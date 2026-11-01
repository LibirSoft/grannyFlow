# granny on opencode

The engine is an opencode **v2** plugin (`engines/opencode/plugin/granny-workflow/`). It adds `granny_run`, `granny_status`, `granny_cancel` and the `granny_submit_*` tools the role sessions answer through. The loop is code inside the plugin; every role runs in its own child session with its own model and permissions, and the review command runs directly in the opencode server.

## Install

Requires opencode 2.x (`opencode --version`). V1 plugins and this plugin are not interchangeable.

1. Copy the plugin directory - global, or per project:

   ```sh
   cp -r <skill-dir>/engines/opencode/plugin/granny-workflow ~/.config/opencode/plugins/
   # or: cp -r <skill-dir>/engines/opencode/plugin/granny-workflow <project>/.opencode/plugins/
   ```

2. Optional: the `granny` primary agent, whose model is granny's model in opencode:

   ```sh
   cp <skill-dir>/engines/opencode/agents/granny.md ~/.config/opencode/agents/
   ```

   Edit its `model:` line, then switch to it in the TUI.

3. `opencode service restart`, then start a new session. `granny_run` should be listed among your tools.

Run granny from the TUI, the desktop app or `opencode run` against the background service. `opencode run --standalone` stops its private server when the command exits, which ends a background run ([When the server stops mid-run](#when-the-server-stops-mid-run)).

## Launch

```
granny_run({ repo, branch, base, context, stages, fromStage?, config? })
```

The plugin reads `~/.config/granny/config.json` and `<repo>/granny.config.json` itself; `config` holds run overrides only. Before it starts it adds the work dir to the common git dir's `info/exclude` and checks `repo`:

- `worktree` on (the default): `repo` may be on any branch and need not be clean - unless `branch` is checked out in `repo`, because then `repo` is the worktree the run reuses, and a dirty tree there refuses the run. Do not check out `branch` yourself. The run's first step, in the background, reuses the worktree that has `branch` checked out or creates one ([config.md](config.md#worktree)); a dirty reused worktree fails the run before any child session starts. Every child session is created in the worktree (`location.directory`), and the review commands run there.
- `worktree: false`: it refuses to start when `repo` is not on `branch` or the tree is dirty.

It returns a run id at once and works in the background; child sessions appear as `granny · <step>`. When the run ends the plugin posts a `[granny] Run … finished` message into your session, with a `- worktree: <path>` line - that is your cue to report.

- `granny_status({ runId })` - status, journal tail, result. `granny_status({ repo })` finds the latest run in that repo.
- `granny_cancel({ runId })` - interrupts every running step; nothing further starts. With several reviewers that is every child session running at that moment, and every review command: each command is stopped with everything it started - its process group gets SIGTERM, then SIGKILL 5 s later. A `codex-plugin` review script also stops the app-server broker its companion started outside that process group ([config.md](config.md#the-codex-plugin)).

Run files: `<repo>/.granny/runs/<id>/` - `input.json`, `status.json`, `journal.jsonl`, `result.json` - in the main checkout you passed as `repo`, also when the run works in another worktree, so `granny_status({ repo })` and `granny_cancel` find runs as before. The PR body and the review outputs are in the worktree's `.granny/`.

Reloading opencode's configuration or the plugin while a run is in progress (`opencode reload`, a changed plugin file) does not interrupt the run: the role sessions' results still reach it, and `granny_status` / `granny_cancel` still find it. Only stopping the server ends it.

## Models and permissions

Models are `provider/model[#variant]` (`opencode models`). A role or agent reviewer without a model uses the model of the session that called `granny_run`. `effort` is ignored here; use the `#variant` suffix.

Every child session runs the `build` agent with these session rules: everything allowed except questions, `git push`, `git remote add`, `git stash`, `git rebase`, `git reset --hard` and `gh pr`. Read-only roles (judge, agent reviewers, extraction) additionally cannot edit, `git add` or `git commit`.

Review commands run in the opencode server's environment: `codex`, and the CLI of every `command` reviewer, must be on that PATH and logged in.

## When the server stops mid-run

The run lives in the opencode server; the review command does not. It runs in its own session and process group, so when the server exits - Ctrl+C, SIGTERM, SIGKILL or a crash - nothing signals the review: it runs to the end and writes `<workDir>/review-<stage>-r<n>-<reviewer>.md` and `.log` (with `codex-plugin` it then stops its app-server broker), but nobody reads them. Everything else stops with the server: `status.json` keeps `"status": "running"` without `finishedAt`, the journal ends at the review `command` entry, there is no `result.json` and no message to your session. After a restart, `granny_status` still reports `running` and `granny_cancel` answers `No running granny run "<id>"`, because the run table is in memory. Call `granny_cancel` before stopping the server; after an unplanned exit, relaunch with the same arguments and `fromStage` - the next review round deletes and rewrites the orphaned files.

## Reviewers

Every entry of `reviewers` reviews every round, all at the same time: agent reviewers as concurrent child sessions (`granny · review <stage> r<n> <name>`), the other engines as concurrent review commands in the server.

- `agent` reviews in a read-only child session on the entry's `model` - any `provider/model` the server has, GLM included.
- `auto` (default) here always means the Codex CLI (`codex exec review`); it does not look for OpenAI's Codex plugin for Claude Code. To use the plugin, set the entry's `engine` to `codex-plugin`: the review script then runs the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`, read from the opencode server's environment, with `node`, and fails the reviewer with a note when the companion is not there or `node` is not on the server's `PATH`. `mode: "adversarial-review"` needs `codex-plugin` on opencode; with `auto`, `granny_run` refuses to start.
- `command` runs the template in the server's shell; `{prompt}` arrives as one shell-quoted line.

The journal logs each reviewer's backend every round (`<stage> r<n> <name>: reviewer: ...`). Details: [config.md](config.md#reviewers).

## Provider errors

When a child session's turn ends without a submit call, the plugin reads the session's messages. A turn that ended on a provider error is journaled as `provider-error` (type, message, status). Transient errors - quota, rate limit, timeout, dropped connection, overload (HTTP 429/502/503/504/529) - are retried after 30 s, 2 min, 5 min and 10 min, and the model is asked to continue where it stopped. Any other provider error, or a fifth transient one, ends the role with nothing (`agent-failed`): an implementer that returns nothing fails the run; an agent reviewer that returns nothing is retried once, then ends the stage `review-failed`; a judge that returns nothing sends every finding it was given to the implementer unscored, and the journal says so.

A session API request that fails (creating, prompting or waiting on a child session) throws. For a reviewer that is a reviewer that did not run: it is retried once and then ends the stage `review-failed`, while the other reviewers finish their round and the run stays `running`, so `granny_cancel` still reaches them. For any other role it fails the run.

## Resume

There is no result cache. Restart with the same arguments and `fromStage` set to the first stage that did not finish; earlier stages are recorded as `skipped`. The restart reuses the worktree of the first run; when the interrupted step left uncommitted changes there, the run fails at the worktree step until you commit or discard them.
