# granny setup

When the user says `granny setup` (or asks to set up or configure granny for a project), walk them through the project's config and write it. Setup launches no run and starts no agent; it only reads the repo and writes one JSON file. It works the same on every host.

Talk to the user in their language. Ask with your host's question tool when you have one (several questions in one call); otherwise ask in one numbered message and wait for the answer.

## 1. Look first

1. The repo: `git rev-parse --show-toplevel` in the current directory. Not in a git repo → ask which repo; setup can still write the user config.
2. What is already set: read `<repo>/granny.config.json` and `~/.config/granny/config.json` (`$XDG_CONFIG_HOME/granny/config.json` when that is set) when they exist. Tell the user what they hold and offer those values as the current answers.
3. Which reviewers can run here (see [config.md](config.md#reviewers)):
   - Codex: `codex --version` works and `codex login status` says logged in.
   - Claude Code only, the Codex plugin: `ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` finds it and `node --version` works. Engine `auto` uses it then.
4. The project's commands, as candidate checks: the `test`, `check`, `typecheck`, `lint` and `build` scripts in `package.json` (run with the package manager the lock file names: `bun.lock` → `bun run`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, otherwise `npm run`), `Makefile` targets of those names, `cargo test` with a `Cargo.toml`, `go test ./...` with a `go.mod`, `pytest` with a `pyproject.toml` or `pytest.ini`. Offer only commands that exist.

## 2. Ask

Ask these four, each with the current value (or the default) marked:

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

   Codex not found: say how to get it (install the Codex CLI and `codex login`) and offer only the host model. On omp granny runs no Codex reviewer: offer the host model only, or the host model and an `agent` reviewer on a Codex model, `{ "name": "codex", "engine": "agent", "model": { "omp": "openai-codex/<model>" } }` with `<model>` from `omp models`. Other reviewers (a pinned model, any CLI) are in [config.md](config.md#reviewers); add them when the user asks.

3. **Checks** (multi-select) - the commands from step 1.4 that granny should run itself after every implementation and fix, before any review; a red one goes back to the implementer. None (default) leaves it to the agents to run the gates.

4. **Where to save** - this project (`<repo>/granny.config.json`, default; commit it to share it with the team) or every project (`~/.config/granny/config.json`).

Plan review, round cap, language and per-role models keep their defaults. Mention in one line that the user can ask for them (`planReview`, `maxRounds`, `language`, `roles`), and set them only when asked.

## 3. Write

Build the config from the answers:

- `threshold`: always written, so the file shows the choice.
- `reviewers`: written when it is not the default, or when the file already had a different list.
- `checks`: one entry per chosen command, `{ "name": "<script or target name>", "run": "<command>" }`, every name unique. Left out when none were chosen.

When the file already exists, keep every key the user did not answer for and replace only the ones they did. Use only keys from [config.md](config.md#keys): granny rejects unknown keys when a run starts.

Show the JSON, write it, and read it back as JSON to be sure it parses. Create `~/.config/granny/` when it is missing. Do not commit the file and do not start a run. Then tell the user, in two or three lines: where the file is, what each choice does, and how to start - `implement <plan> with granny` or `plan <goal> with granny on <branch>`.

Example - strict, the host model and Codex, two checks:

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
