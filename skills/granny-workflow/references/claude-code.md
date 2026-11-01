# granny on Claude Code

The engine is `engines/claude-code/workflow.js`, a Workflow script: the loop is code, every role is an `agent()` call with its own `model`, `effort` and JSON schema. Never re-author it per task; launch it as is.

## Launch

1. Collect the config layers. Read `~/.config/granny/config.json` and `<repo>/granny.config.json` if they exist; do not merge them yourself - the engine does that and rejects bad keys.
2. Read `engines/claude-code/workflow.js` (relative to the skill directory). The skill directory is usually outside the session's working directories, where `scriptPath` is refused, so pass the full text unchanged as `script`.
3. Call:

```
Workflow({
  script: <contents of workflow.js>,
  args: {
    repo, branch, base, context, stages,          // fromStage when resuming by stage
    config: [<user config>, <project config>, <run overrides>]   // omit missing layers
  }
})
```

`args` is a JSON object, not a string.

4. Record the run id where the project tracks work (a STATUS file, a plan) and tell the user. Do not poll: a task notification arrives when the workflow ends.

## Models

`opus`, `sonnet`, `haiku`, or a model ID the session accepts. A role without a model inherits the session model; the judge defaults to `sonnet`. `effort` is passed through (`low` … `max`). The review command runs inside a granny helper agent, because Workflow scripts have no shell; a cheap `roles.granny.model` keeps that step inexpensive, but granny also runs the final check, so do not go below `sonnet` there.

## Reviewer

With the default engine `auto`, the review script looks for OpenAI's Codex plugin for Claude Code (the newest `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`) and runs `node <companion> review` when it finds one, otherwise `codex exec review`. The shell script makes the choice at run time, since the Workflow script cannot read the filesystem; it prints the choice and the engine logs it every round as `<stage> r<n>: reviewer: ...` - tell the user which one ran. `codex-plugin` makes the plugin mandatory: without it the review fails and the stage ends `review-failed` with a note naming the path it looked in. `mode: "adversarial-review"` (optionally with `focus`) runs the plugin's adversarial review; under `auto` it also needs the plugin and never falls back to a plain CLI review. Details: [config.md](config.md#reviewer).

## Resume

Same script, same args: `Workflow({ scriptPath: <path the first launch returned>, args, resumeFromRunId })`. Unchanged agent calls return cached results instantly, so the run continues where it stopped. To restart from a stage instead, add `fromStage` to args.

## When it ends

The result is `{ repo, branch, base, stages: [...], final }`. If anything looks empty, read `<transcriptDir>/journal.jsonl`, which records every agent's return value, before drawing conclusions. Then report per SKILL.md section 5 and wait.
