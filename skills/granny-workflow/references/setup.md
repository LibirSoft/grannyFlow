# granny setup

When the user says `granny setup` or `granny init` (or asks to set up or configure granny for a project), walk them through the project's config and write it. Setup launches no run and starts no agent; it only reads the repo and writes one JSON file. It works on every host; only the models it offers and the roles it asks about depend on the host.

Talk to the user in their language. Ask with your host's question tool when you have one (several questions in one call); otherwise ask in one numbered message and wait for the answer.

## 1. Look first

1. The repo: `git rev-parse --show-toplevel` in the current directory. Not in a git repo → ask which repo; setup can still write the user config.
2. What is already set: read `<repo>/granny.config.json` and `~/.config/granny/config.json` (`$XDG_CONFIG_HOME/granny/config.json` when that is set) when they exist. Tell the user what they hold and offer those values as the current answers.
3. Which reviewers can run here (see [config.md](config.md#reviewers)):
   - Codex: `codex --version` works and `codex login status` says logged in.
   - Claude Code only, the Codex plugin: `ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` finds it and `node --version` works. Engine `auto` uses it then.
   - opencode as a reviewer, on any host: `opencode --version` works; `opencode models` lists the `provider/model` ids it can run.
4. The project's commands, as candidate checks: the `test`, `check`, `typecheck`, `lint` and `build` scripts in `package.json` (run with the package manager the lock file names: `bun.lock` → `bun run`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, otherwise `npm run`), `Makefile` targets of those names, `cargo test` with a `Cargo.toml`, `go test ./...` with a `go.mod`, `pytest` with a `pyproject.toml` or `pytest.ini`. Offer only commands that exist.
5. The host and its models (see [config.md](config.md#models-per-host)):
   - Claude Code (you have a `Workflow` tool): `opus`, `sonnet`, `haiku`, or a model ID the session accepts.
   - opencode (you have `granny_run` and run in opencode): `opencode models` lists `provider/model`; a `#variant` suffix (`anthropic/claude-sonnet-5-5#high`) sets the reasoning level.
   - omp (you have `granny_run` and run in omp): `omp models` lists `provider/id`.
   - Note the session's own model: every role that names none runs on it.

## 2. Ask

Ask these five, each with the current value (or the default) marked:

1. **Review strictness** - how many of the judged findings go back to the implementer. P0/P1 findings and `critical` or `major` impacts are always fixed, in every preset; the preset sets `threshold` for the rest:

   | preset | `threshold` | also fixed |
   |---|---|---|
   | strict | `55` | `moderate` issues on the common path, even when the fix is large, and on edge paths when the fix is trivial |
   | normal (default) | `70` | `moderate` issues on the common path, unless the fix is large |
   | relaxed | `85` | `moderate` issues on the common path only when the fix is trivial |

   `minor` findings are never fixed by the threshold in any preset (at most 50); they are listed for the user. Stricter means more fix rounds and more tokens. A number of their own (0-100) is fine too.

2. **Reviewers** - offer only what step 1.3 found working:
   - the host model only (default): `[{ "name": "reviewer", "engine": "agent" }]`
   - the host model and Codex: `[{ "name": "reviewer", "engine": "agent" }, { "name": "codex", "engine": "auto" }]`
   - Codex only: `[{ "name": "codex", "engine": "auto" }]`

   - with opencode found in step 1.3, on any host: the host model and an `opencode` reviewer on a model from `opencode models` that the user picks, `[{ "name": "reviewer", "engine": "agent" }, { "name": "<short name>", "engine": "opencode", "model": "<provider/model>" }]`. It runs any provider opencode reaches (Kimi, GLM, ...), read-only as opencode enforces it; an `effort` becomes the model's variant ([config.md](config.md#opencode-reviewers)).

   Codex not found: say how to get it (install the Codex CLI and `codex login`) and offer only the host model. On omp granny runs no Codex reviewer: offer the host model only, or the host model and an `agent` reviewer on a Codex model, `{ "name": "codex", "engine": "agent", "model": { "omp": "openai-codex/<model>" } }` with `<model>` from `omp models`. Other reviewers (a pinned model, any CLI) are in [config.md](config.md#reviewers); add them when the user asks.

3. **Checks** (multi-select) - the commands from step 1.4 that granny should run itself after every implementation and fix, before any review; a red one goes back to the implementer. None (default) leaves it to the agents to run the gates.

4. **Models** - keep the defaults (default: every role on the session model, except the ones the table below names) or choose a model per role. With "choose per role", ask about each role in this order, one question each (several per call is fine), offering the session model, the current value and two or three models from step 1.5; the user may type any other:

   | # | role | what it does | default | ask on |
   |---|---|---|---|---|
   | 1 | `implementer` | writes the code, fixes the accepted findings, repairs red checks, commits | session model | every host |
   | 2 | each `agent` reviewer from question 2 | reviews every stage; a reviewer on another model than the implementer catches more | session model | every host |
   | 3 | `judge` | classifies the findings that are not P0/P1; the engine decides from that, so a cheap model is enough | `haiku` on Claude Code, session model elsewhere | every host |
   | 4 | `planner` | writes the plan when a run starts from a goal | session model | every host |
   | 5 | `granny` | the final PR-ready check and the extraction fallback | session model | every host |
   | 6 | `helper` | runs granny's plain commands (worktree setup, git reads, checks) and reports the exit code; decides nothing | `haiku`, effort `low` | Claude Code only |

   Skip `helper` on opencode and omp: granny runs those commands itself there and starts no helper. On Claude Code and omp, ask the implementer's and the planner's effort too (`low`, `medium`, `high`, `xhigh`, `max`; default: the host's own); omp passes it as `--thinking`. On opencode effort is ignored: offer the model's `#variant` instead. A Codex reviewer keeps Codex's own model unless the user names one.

   When the answers leave every reviewer an `agent` reviewer on the implementer's model (two roles with no model share the session model; a Codex, `command` or `opencode` reviewer counts as different), tell the user: "reviewers share the implementer's model; a different model may catch more". This is advice on every host: never refuse, and write what the user chose.

5. **Where to save** - this project (`<repo>/granny.config.json`, default; commit it to share it with the team) or every project (`~/.config/granny/config.json`).

Plan review, round cap and language keep their defaults. Mention in one line that the user can ask for them (`planReview`, `maxRounds`, `language`), and set them only when asked; say that plan review is off by default because every round is a full review + judge + fix, which uses many more tokens and makes runs much longer. When the user asks to turn it on, state that cost, with the round cap (`maxRounds`), before writing it.

## 3. Write

Build the config from the answers:

- `threshold`: always written, so the file shows the choice.
- `reviewers`: written when it is not the default, or when the file already had a different list.
- `checks`: one entry per chosen command, `{ "name": "<script or target name>", "run": "<command>" }`, every name unique. Left out when none were chosen.
- `roles.<role>.model` and a reviewer entry's `model`: an object keyed by the current host, `{ "<host>": "<model>" }` with host `claude-code`, `opencode` or `omp`, so the same file works on the other hosts. Merge the key into the object the file already has, keeping the other hosts' keys; a string already there becomes an object that keeps it for the other hosts. A role left on its default gets no key for this host (drop a key the file had for it, then an empty object, then an empty role). A choice equal to the built-in default (`haiku` for the judge or the helper on Claude Code) is not written either.
- `roles.<role>.effort` and a reviewer's `effort`: written only when chosen. It is not keyed by host: Claude Code and omp use it, opencode ignores it. An `opencode` reviewer's `effort` is its model variant on every host.
- An `opencode` reviewer's `model`: one string, not keyed by host - it is opencode's model wherever the reviewer runs.

When the file already exists, keep every key the user did not answer for and replace only the ones they did. Use only keys from [config.md](config.md#keys): granny rejects unknown keys when a run starts.

Show the JSON, write it, and read it back as JSON to be sure it parses. Create `~/.config/granny/` when it is missing. Do not commit the file and do not start a run. Then tell the user, in two or three lines: where the file is, what each choice does, and how to start - `implement <plan> with granny` or `plan <goal> with granny on <branch>`.

Example - strict, the host model and Codex, two checks, the defaults for models:

```json
{
  "threshold": 55,
  "reviewers": [
    { "name": "reviewer", "engine": "agent" },
    { "name": "codex", "engine": "auto" }
  ],
  "checks": [
    { "name": "test", "run": "bun test" },
    { "name": "typecheck", "run": "bun run typecheck" }
  ]
}
```

Example - on omp, normal strictness, models chosen per role: Opus writes the code with high thinking, a GPT model reviews, a cheap model judges, the rest stay on the session model:

```json
{
  "threshold": 70,
  "roles": {
    "implementer": { "model": { "omp": "anthropic/claude-opus-5-5" }, "effort": "high" },
    "judge": { "model": { "omp": "anthropic/claude-haiku-5-5" } }
  },
  "reviewers": [
    { "name": "reviewer", "engine": "agent", "model": { "omp": "openai-codex/gpt-6.1-sol" } }
  ]
}
```
