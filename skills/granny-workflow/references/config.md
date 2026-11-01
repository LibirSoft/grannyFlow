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
| `roles.reviewer` | `{ "engine": "auto" }` | `engine`: `auto`, `codex-plugin`, `codex` or `agent`; `mode` and `focus` for the Codex plugin - see [Reviewer](#reviewer). `model`: with the Codex engines a string passed as `-m`; with `agent` a host model. `command`: custom review command, see below |
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

## Reviewer

| `engine` | runs |
|---|---|
| `auto` (default) | on Claude Code: the Codex plugin when its companion script is installed and `node` is on `PATH`, otherwise the Codex CLI. On opencode: always the Codex CLI |
| `codex-plugin` | OpenAI's Codex plugin for Claude Code, on either host. When the companion script is missing, or `node` is not on `PATH`, the review fails with a note saying so - it never falls back to the CLI |
| `codex` | the Codex CLI: `codex exec review` |
| `agent` | a model reviews the diff with the reviewer prompt; `model` is a host model |

The plugin path runs the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs` from the repo - the highest `<version>`, compared numerically field by field (`1.10.0` after `1.9.3`) with a plain `sort -t. -n` that BSD/macOS `sort` runs too:

```
node <companion> review --wait --base <stage start sha> --scope branch [-m <model>]
node <companion> adversarial-review --wait --base <stage start sha> --scope branch [-m <model>] [-- <focus>]
```

Its stdout goes to the round's `.md` file and its progress to the `.log`, the same files the CLI uses. The plugin needs `node` on `PATH` (checked with `command -v node` before the companion runs), and the Codex CLI installed and logged in (the companion drives it). The engine logs which backend ran each round, so you can see what `auto` chose:

```
<stage> r<n>: reviewer: codex-plugin review (<companion path>)
<stage> r<n>: reviewer: codex CLI (codex exec review) - no Codex plugin companion at <dir>/<version>/scripts/codex-companion.mjs
<stage> r<n>: reviewer: codex CLI (codex exec review) - node is not on PATH for the Codex plugin companion at <companion path>
<stage> r<n>: reviewer: codex-plugin review unavailable - node is not on PATH for the Codex plugin companion at <companion path>; install Node.js
```

| key | values | |
|---|---|---|
| `mode` | `review` (default), `adversarial-review` | `review` is Codex's built-in reviewer; `adversarial-review` is the plugin's skeptical, ship/no-ship review with `critical`/`high`/`medium`/`low` findings. It needs the plugin: engine `codex-plugin`, or `auto` on Claude Code, where a missing companion or a missing `node` fails the review instead of running a plain CLI review |
| `focus` | non-empty string | extra instructions for `adversarial-review` only (the plain review takes no focus text), passed shell-quoted after `--` |

Rejected before any agent starts: `adversarial-review` with engine `codex` or `agent`, or with `auto` on opencode (where `auto` means the CLI); `focus` without `adversarial-review`; `command` with `codex-plugin`, or with `adversarial-review`.

An adversarial review on both hosts:

```json
{ "roles": { "reviewer": { "engine": "codex-plugin", "mode": "adversarial-review", "focus": "data loss, retries and auth" } } }
```

## Custom review command

`roles.reviewer.command` replaces `codex exec review --base {base} -o {out}` (plus `-m {model}` when a codex model is set) for engines `codex` and `auto` - with `auto` a custom command always runs and the plugin is not looked for. Placeholders: `{base}` (required - the stage start sha), `{out}` (file the review should be written to), `{model}`. They are substituted already shell-quoted, so do not put quotes around them. The command runs in the repo; the engine deletes `{out}` and the round's log first, then reads `{out}` when the command left it non-empty, otherwise everything the command printed. A non-zero exit ends the stage as `review-failed`.

Findings are read from lines shaped like Codex's output - the built-in reviewer's form, and the Codex plugin's `adversarial-review` form:

```
- [P1] Title — path/to/file.ts:12-14
  Detail, indented, any number of lines.

- [high] Title (path/to/file.ts:12-14)
  Detail, indented.
  Recommendation: what to change.
```

The word severities map to `critical` → P0, `high` → P1, `medium` → P2, `low` → P3; for them the location is the last parenthesised part of the line (an ` — ` location is accepted too). Other bracketed words (`[note]`) are not findings. A marker bullet indented under a finding belongs to that finding's detail; it is neither a finding nor a marker. If the output has more markers than parseable findings, a granny helper agent extracts them instead. If it recovers fewer findings than markers, it is asked once more with the expected count; still short, the stage ends `review-failed` with the marker, parser and extraction counts and the raw review output in its note - findings are never dropped silently and the stage is never reported clean. Output in which the Codex plugin says it got no usable result (`Codex did not return valid structured JSON.`, `Codex returned JSON with an unexpected review shape.`, `Codex review completed without any stdout output.`) also ends the stage `review-failed`, even when the command exited 0.

## Example: everything set

```json
{
  "roles": {
    "granny": { "model": "sonnet", "effort": "medium" },
    "implementer": { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5#high" }, "effort": "high" },
    "reviewer": { "engine": "auto", "mode": "review" },
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
