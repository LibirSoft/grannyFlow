# granny config reference

Layers, later wins:

1. built-in defaults (below)
2. `~/.config/granny/config.json` - user (`$XDG_CONFIG_HOME/granny/config.json`; opencode also honours `$GRANNY_CONFIG`)
3. `<repo>/granny.config.json` - project, safe to commit
4. the run's `config` argument

`roles.<role>` objects merge key by key (set a key to `null` to drop it); every other key replaces the lower layer. Unknown keys and invalid values stop the run before any agent starts, with every problem listed.

## Keys

| key | default | meaning |
|---|---|---|
| `roles.granny` | `{}` | model/effort for granny's helper steps: the review-command runner (Claude Code), the extraction fallback, the final PR-ready check |
| `roles.implementer` | `{}` | builds each stage and fixes accepted findings |
| `roles.reviewer` | `{ "engine": "codex" }` | `engine`: `codex` runs a command, `agent` asks a model to review the diff. `model`: with `codex` a string passed as `codex -m`; with `agent` a host model. `command`: custom review command, see below |
| `roles.judge` | `{ "model": { "claude-code": "sonnet" } }` | scores each finding 0-100 |
| `threshold` | `70` | a finding is sent back to the implementer when it is P0/P1 (also `critical`/`high`), when the judge gave it no score, or when its score is **strictly above** this. The overall review score gates nothing |
| `maxRounds` | `4` | review rounds per stage; the stage ends `round-cap` after the last one |
| `base` | `"main"` | branch never to touch; the run's `base` argument overrides it |
| `gates` | `"auto"` | `"auto"`: agents discover the project's test/lint/build/typecheck commands. Or a list, e.g. `["bun test", "bun run check", "bun run build"]` |
| `workDir` | `".granny"` | repo-relative, git-excluded: PR body, review outputs, run journals |
| `language` | `"English"` | language of code, comments, commits and the PR body |
| `aiAttribution` | `false` | `false` forbids Co-Authored-By / "Generated with" lines and the final check greps for them |
| `rules` | red-green tests; code comments default none | extra house rules appended to every working prompt; `[]` removes them |

## Models per host

A role's `model` is either one string for every host, or an object keyed by host:

```json
{ "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" } }
```

- **Claude Code** passes it to `agent({ model })`: `opus`, `sonnet`, `haiku`, or a model ID the session accepts. `effort` (`low`, `medium`, `high`, `xhigh`, `max`) is passed as the agent's reasoning effort.
- **opencode** needs `provider/model`, optionally `#variant` (`anthropic/claude-sonnet-5-5#high`); list them with `opencode models`. `effort` is ignored - use the variant suffix. A role with no model uses the model of the session that called `granny_run`.
- **Cursor** reads no config; set `model:` in the subagent files (see cursor.md).

A host key that is missing means "inherit" on that host.

## Custom review command

`roles.reviewer.command` replaces `codex exec review --base {base} -o {out}` (plus `-m {model}` when a codex model is set). Placeholders: `{base}` (required - the stage start sha), `{out}` (file the review should be written to), `{model}`. They are substituted already shell-quoted, so do not put quotes around them. The command runs in the repo; the engine deletes `{out}` and the round's log first, then reads `{out}` when the command left it non-empty, otherwise everything the command printed. A non-zero exit ends the stage as `review-failed`.

Findings are read from lines shaped like Codex's output:

```
- [P1] Title — path/to/file.ts:12-14
  Detail, indented, any number of lines.
```

A `- [Px]` bullet indented under a finding belongs to that finding's detail; it is neither a finding nor a marker. If the output has more `[P0-3]` markers than parseable findings, a granny helper agent extracts them instead. If it recovers fewer findings than markers, it is asked once more with the expected count; still short, the stage ends `review-failed` with the marker, parser and extraction counts and the raw review output in its note - findings are never dropped silently and the stage is never reported clean.

## Example: everything set

```json
{
  "roles": {
    "granny": { "model": "sonnet", "effort": "medium" },
    "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5#high" }, "effort": "high" },
    "reviewer": { "engine": "codex" },
    "judge": { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5" } }
  },
  "threshold": 70,
  "maxRounds": 4,
  "base": "main",
  "gates": ["bun test", "bun run check", "bun run build"],
  "workDir": ".granny",
  "language": "English",
  "aiAttribution": false,
  "rules": ["Code comments: default none."]
}
```
