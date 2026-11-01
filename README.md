# granny-workflow

An agent skill that takes a plan to a PR-ready branch: an **implementer** builds it stage by stage, a **reviewer** reviews every stage, a **judge** scores each finding, and the findings that matter go back to the implementer until the review is clean. **Granny** - the agent you talk to - prepares the run, launches it, and reports. Nothing is pushed; you decide what happens next.

```
for each stage:
  implementer builds the stage ─► reviewer reviews (base = stage start sha)
     ├─ no findings ─────────────────────────────► stage clean
     └─ judge scores each finding 0-100
          ├─ any P0/P1, or score > threshold ─► implementer fixes those ─► review again
          └─ none ─► stage done; the rest are "residual" for you
     cap: maxRounds reviews per stage
after the last stage: final check (gates, clean tree, no AI trailers, PR body) ─► report ─► wait
```

The loop is code, not a prompt: on Claude Code and opencode an engine drives every step, so the threshold, round cap and stop conditions hold every time.

## Hosts

| host | engine | status |
|---|---|---|
| Claude Code | Workflow script (`engines/claude-code/workflow.js`): every role is an `agent()` call with its own model, effort and JSON schema | full |
| opencode 2.x | server plugin (`engines/opencode/plugin/granny-workflow/`): every role is a child session with its own model and permissions; the review command runs directly | full |
| Cursor | none - the skill walks the agent through the same loop with three subagents | manual, not deterministic |

## Install

```sh
npx skills add LibirSoft/grannyFlow
```

This puts `skills/granny-workflow/` where your agents look for skills. Then, per host:

- **Claude Code** - nothing else. Optional: OpenAI's Codex plugin (`/plugin marketplace add openai/codex-plugin-cc`, then `/plugin install codex@openai-codex`); the default reviewer uses it when it is installed and `node` is on `PATH`.
- **opencode** - install the plugin (and optionally the `granny` primary agent), then restart the service:

  ```sh
  cp -r <skill-dir>/engines/opencode/plugin/granny-workflow ~/.config/opencode/plugins/
  cp <skill-dir>/engines/opencode/agents/granny.md ~/.config/opencode/agents/   # optional; set its model:
  opencode service restart
  ```

- **Cursor** - copy the subagents and set `model:` in each:

  ```sh
  cp <skill-dir>/engines/cursor/agents/*.md ~/.cursor/agents/
  ```

The default reviewer is [Codex](https://github.com/openai/codex); install it and log in, or switch the reviewer to a model with `"engine": "agent"`. With the default engine `auto`, Claude Code runs the review through OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) when it is installed and `node` is on `PATH`, and through the Codex CLI (`codex exec review`) otherwise; opencode always uses the CLI unless you set `"engine": "codex-plugin"`. The run log says which one ran.

## Use

Ask your agent to implement a plan with granny:

> implement plans/auth/plan.md with granny - stage 1: WP-01..03, stage 2: WP-04..06

Granny gathers the inputs (repo, branch, base, context files, stages), runs the preflight (clean tree, feature branch, git-excluded work dir), launches the run and tells you the run id. When it ends you get, per stage: commits, gate numbers, review rounds, outcome and the findings left for you; plus the final check and the PR body at `.granny/PR-BODY.md`.

## Configure

Three layers, later wins: `~/.config/granny/config.json`, `<repo>/granny.config.json`, and per-run overrides.

```json
{
  "roles": {
    "granny":      { "model": { "claude-code": "opus", "opencode": "anthropic/claude-opus-5-5" } },
    "implementer": { "model": "opus", "effort": "high" },
    "reviewer":    { "engine": "auto" },
    "judge":       { "model": { "claude-code": "sonnet", "opencode": "anthropic/claude-sonnet-5-5" } }
  },
  "threshold": 70,
  "maxRounds": 4,
  "gates": ["bun test", "bun run check", "bun run build"]
}
```

| key | default | |
|---|---|---|
| `roles.<role>.model` | session model; judge `sonnet` on Claude Code | one string for every host, or `{ "claude-code": …, "opencode": … }` |
| `roles.<role>.effort` | inherit | Claude Code only; on opencode use a `#variant` model suffix |
| `roles.reviewer.engine` | `auto` | `auto`: the Codex plugin when installed and `node` is on `PATH` (Claude Code only), else the Codex CLI; `codex-plugin`: the plugin, required; `codex`: the CLI (customisable with `command`); `agent`: a model |
| `roles.reviewer.mode` | `review` | `adversarial-review` runs the Codex plugin's adversarial review, optionally steered by `roles.reviewer.focus` |
| `threshold` | `70` | findings scoring strictly above it are fixed; P0/P1 always are |
| `maxRounds` | `4` | review rounds per stage |
| `gates` | `auto` | agents discover test/lint/build/typecheck, or list them |
| `aiAttribution` | `false` | forbid Co-Authored-By / "Generated with" lines |
| `language`, `rules`, `base`, `workDir` | | see the reference |

Full reference: [skills/granny-workflow/references/config.md](skills/granny-workflow/references/config.md).

## Resume

- Claude Code: relaunch the Workflow with `resumeFromRunId`; finished agent calls come back from cache.
- opencode: no cache - relaunch with `fromStage` set to the first unfinished stage.

## Develop

```sh
bun install
bun run build   # regenerates skills/granny-workflow/engines/* and references/prompts.md from src/
bun run check   # typecheck + tests
```

`src/core` holds the loop, config, prompts and review parser, shared by both engines; `src/adapters` wires them to each host. The generated engine files are committed so the skill installs without a build step, and the tests fail when they drift from `src/`.

## License

MIT
