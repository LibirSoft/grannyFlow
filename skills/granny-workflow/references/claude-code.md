# granny on Claude Code

The engine is `engines/claude-code/workflow.js`, a Workflow script: the loop is code, every role is an `agent()` call with its own `model`, `effort` and JSON schema. Never re-author it per task; launch it as is.

## Launch

1. Collect the config layers. Read `~/.config/granny/config.json` and `<repo>/granny.config.json` if they exist; do not merge them yourself - the engine does that and rejects bad keys.
2. Read `engines/claude-code/workflow.js` (relative to the skill directory) and pass the full text unchanged as `script`. Alternative: copy the file into the session's scratchpad directory (the one your session names, not `/tmp`) and pass that copy's path as `scriptPath` instead of `script`. Never point `scriptPath` into the skill directory: when the skill lives outside the session's working directories, Workflow refuses that path; the scratchpad path works.
3. Call:

```
Workflow({
  script: <contents of workflow.js>,              // or scriptPath: <scratchpad copy of workflow.js>
  args: {
    repo, branch, base, context, plan, stages,    // plan: absolute path or list; fromStage when resuming by stage
    config: [<user config>, <project config>, <run overrides>]   // omit missing layers
  }
})
```

`args` is a JSON object, not a string.

4. Record the run id where the project tracks work (a STATUS file, a plan) and tell the user. Do not poll: a task notification arrives when the workflow ends.

## Models

`opus`, `sonnet`, `haiku`, or a model ID the session accepts. A role without a model inherits the session model; the judge defaults to `sonnet`. `effort` is passed through (`low` … `max`). The worktree setup and the review command run inside granny helper agents, because Workflow scripts have no shell; a cheap `roles.granny.model` keeps those steps inexpensive, but granny also runs the final check, so do not go below `sonnet` there.

## Worktree

With `worktree` on (the default) the run starts with phase "Worktree": a granny helper agent (label `worktree`, write access, `roles.granny`'s model) runs the setup script from `repo` and returns what it printed; the engine reads the `[granny] worktree: <path>` line from it and stops the run when the script fails - a dirty reused worktree, for example - before any other agent starts. Pass the main checkout as `repo` and leave `branch` alone: the script reuses the worktree that has it checked out or creates one ([config.md](config.md#worktree)). `agent()` has no working-directory option, so every later prompt carries the worktree instead: `Working repo: <worktree>` and `cd <worktree> &&` before each command; the review runner `cd`s there too. The result's `worktree` is the path. On resume the cached setup call returns the same path; a relaunch with `fromStage` runs the setup again and reuses the worktree.

## Plan review

With `plan` in args and `planReview` on, phase "Plan review" runs after "Worktree" and before the first "Implement" ([config.md](config.md#plan-review)). The reviewers run as in a stage, each Codex engine through its granny helper agent with the plan-review script (`codex exec --sandbox read-only ...` or the plugin's `node <companion> task ...`); the judge and the fix (`fix plan review r<n>`, the implementer with write access, result `{ files, changes, deviations }`) are `agent()` calls in that phase. The fix agent writes the plan files at their absolute paths - a plan in the main checkout works, since the session works there too - and dates its `rN deltas` section with its shell's `date`, because the Workflow script has no clock. A plan review that ends `round-cap` or `review-failed` ends the Workflow there, with `stages: []` and `final: null`.

## Reviewers

Every entry of `reviewers` reviews every round, and all of them start at once: each is its own `agent()` call - an agent reviewer directly, every other engine through its own granny helper agent that runs the review script. The Workflow runs a limited number of agents at a time; reviewers beyond that wait for a free slot.

- `agent` runs a Claude Code subagent on the entry's `model` and `effort`, so Claude models only (`opus`, `sonnet`, `haiku`, a Claude model ID). To have GLM or another provider review, use engine `command` with a CLI that reaches it - for example `"command": "opencode run -m opencode/glm-5.3-flash-free {prompt}"`, with opencode installed and logged in where the helper agent's shell runs.
- `auto` (default): the review script looks for OpenAI's Codex plugin for Claude Code (the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`) and runs `node <companion> review` when it finds one and `node` is on `PATH`, otherwise `codex exec review`. The shell script makes the choice at run time, since the Workflow script cannot read the filesystem; it prints the choice and the engine logs it every round as `<stage> r<n> <name>: reviewer: ...` - tell the user which one ran.
- `codex-plugin` makes the plugin mandatory: without it, or without `node`, the reviewer fails (and, after its retry, the stage ends `review-failed`) with a note naming the path it looked in. `mode: "adversarial-review"` (optionally with `focus`) runs the plugin's adversarial review; under `auto` it also needs the plugin and never falls back to a plain CLI review. Each plugin reviewer runs with its own `CLAUDE_PLUGIN_DATA` (`<workDir>/codex-plugin-<name>`) and stops the Codex app-server broker it started when its script exits, so it touches neither your session's broker nor another reviewer's, and leaves none behind for repos your session's `SessionEnd` hook never sees.
- `command` runs the template in the helper agent's shell; `{prompt}` arrives as one shell-quoted line.

Details: [config.md](config.md#reviewers).

## Resume

Same script, same args: `Workflow({ scriptPath, args, resumeFromRunId })`, where `scriptPath` is the path the first launch returned when you passed `script`, or the same scratchpad copy you launched with (leave it in place until the run is done). Unchanged agent calls return cached results instantly, so the run continues where it stopped. To restart from a stage instead, add `fromStage` to args.

## When it ends

The result is `{ repo, branch, base, worktree, plan?, stages: [...], final }`; `plan` is there when args had a `plan`. If anything looks empty, read `<transcriptDir>/journal.jsonl`, which records every agent's return value, before drawing conclusions. Then report per SKILL.md section 5 and wait.
