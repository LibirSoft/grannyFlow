# granny-workflow

Granny takes a plan and turns it into a PR-ready branch. An **implementer** agent builds the plan stage by stage, **reviewers** check every stage, a **judge** decides which findings are worth fixing, and the loop repeats until the review is clean. Nothing is pushed: you get a branch, a PR body and a short report, and you decide what happens next.

It works on Claude Code, opencode and omp (oh-my-pi), where the loop runs as code (the round cap and thresholds hold on every run), and on Cursor, where the agent follows the same steps by hand.

## Install

1. Add the skill:

   ```sh
   npx skills add LibirSoft/grannyFlow
   ```

2. Finish the install for your host (`<skill-dir>` is where the skill landed, e.g. `~/.claude/skills/granny-workflow`):

   - **Claude Code** - nothing else to do.
   - **opencode** - install the plugin globally and restart:

     ```sh
     cp -r <skill-dir>/engines/opencode/plugin/granny-workflow ~/.config/opencode/plugins/
     opencode service restart
     ```

   - **omp** - install the extension globally, then quit omp and start it again. omp must find the skill in `~/.omp/agent/skills/` or `~/.agents/skills/`; link it there if it landed elsewhere:

     ```sh
     cp -r <skill-dir>/engines/omp/extensions/granny-workflow ~/.omp/agent/extensions/
     ```

   - **Cursor** - copy the subagents and set `model:` in each:

     ```sh
     cp <skill-dir>/engines/cursor/agents/*.md ~/.cursor/agents/
     ```

3. Optional: Codex as a second reviewer. Install the [Codex CLI](https://github.com/openai/codex) and run `codex login`. On Claude Code, OpenAI's [Codex plugin](https://github.com/openai/codex-plugin-cc) is used instead when it is installed. omp runs no Codex reviewer: use an `agent` reviewer on one of omp's `openai-codex/...` models.

   Optional: any model [opencode](https://opencode.ai) reaches (Kimi, GLM, ...) as a reviewer, on every host. Install opencode, log in to the provider, and add a reviewer with `"engine": "opencode"` and a model from `opencode models`; opencode's permission rules keep it to reading and read-only git, as far as their patterns reach - see [opencode reviewers](skills/granny-workflow/references/config.md#opencode-reviewers).

4. In your project, ask your agent:

   > granny setup

## Setup

`granny setup` (or `granny init`) asks five questions and writes `granny.config.json` in your repo (or `~/.config/granny/config.json` for every project). It does not start a run.

1. **Review strictness** - how many findings go back to the implementer. P0/P1 findings and critical or major issues are always fixed; the preset decides the rest:

   | preset | threshold | fixes more or fewer findings |
   |---|---|---|
   | strict | 55 | more: moderate issues on the common path even when the fix is large, and cheap fixes on edge paths |
   | normal | 70 | the default |
   | relaxed | 85 | fewer: a moderate issue only when it is on the common path and trivial to fix |

2. **Reviewers** - the host model, the host model and Codex, or Codex only; with opencode installed, the host model and an opencode model.
3. **Checks** - the project's test, typecheck, lint or build commands that granny runs itself before every review. A red check goes back to the implementer.
4. **Models** - keep the defaults, or pick a model for each role in turn: who writes the code (implementer), who reviews, who judges the findings, who plans, and granny's own final check. Claude Code also asks about the helper that runs plain commands; opencode and omp have none, granny runs those commands itself.
5. **Where to save** - this project or every project.

## Use

Hand granny a plan:

> implement plans/auth/plan.md with granny - stage 1: WP-01..03, stage 2: WP-04..06

No plan yet? Let granny plan it first:

> plan OAuth login with granny on feat/oauth

A planner writes the plan to `.granny/plans/feat-oauth.md` and proposes the stages, then the run stops. Approve it (or edit it) and granny builds it in a second run.

When a run ends you get the worktree path, and per stage: commits, review rounds, the outcome, and the findings left for you to decide. The PR body is at `.granny/PR-BODY.md` in the worktree. Review and push from there.

## Review only: `granny judge`

Want granny only for a review? In your project, ask your agent:

> granny judge

If the agents are not configured yet, granny asks who reviews and who tags, and writes the config. Then one agent reviews the checkout's `<base>...HEAD`, a second agent tags what it found, and the review goes to `.granny/reviews/<date>-<branch>.md`. You get the path and the counts, and you can read the file later. Nothing is fixed or committed, and no branch or worktree is created; uncommitted files are not reviewed, and the report lists them.

```markdown
# Granny judge - feat/login

- Reviewed: `main...HEAD` at 1a2b3c4d, 3 commit(s), in /work/app
- When: 20261106-101010
- Reviewers: reviewer (agent, openai-codex/gpt-6.1-sol) · Judge: anthropic/claude-haiku-5-5
- Totals: P0 1, P1 0, P2 1, P3 0, dismissed 0

## P0

### Session cookie is not marked secure

`src/auth.ts:12` · `confirmed` `critical` `common` `small` `in-scope` · priority 95 · `reviewer: P1` · from `reviewer-F1`

The detail, the evidence and the judge's reason follow here.

## P1

None.
```

The heading is the tagging agent's call: `critical` goes under P0, `major` under P1, `moderate` under P2 and `minor` under P3; what it refutes goes under `Dismissed by the judge`, with its reason. A finding it placed below the reviewer's severity is tagged `demoted`. Details: [references/judge.md](skills/granny-workflow/references/judge.md).

## The review trail on the PR

Every review round is recorded as it ends: the findings, the judge's tags and what became of each one, with the commit ids. Granny never pushes or opens the PR, so once you have opened it, ask your agent to post the trail, or run it yourself in the worktree:

```sh
node <skill-dir>/scripts/pr-comments.mjs
```

Each round becomes one review on the PR, in order. A finding sits on its line, and lines a later fix changed show as *Outdated*:

```markdown
**granny · Stage 1 (engine) · round 1 · `codex-F2`** (reviewer `codex`, P2)
**Retry loop never gives up**

`fetchAll` retries on every error, including 404.

---
**Judge:** `confirmed` `major` `common` `trivial` `in-scope` · priority 82 · rule 6 → fix: impact major is in alwaysFix (major/common/trivial -> 82)
**Evidence:** src/fetch.ts:41 - a 404 loops forever
**What happened:** fixed in fix r1: a1b2c3d..d4e5f6a (2 commits)
```

A script posts it, not an agent, and a rerun posts only what is missing. It posts to a GitHub PR or a GitLab MR, whichever your remote is on; for any other platform, `--out <file>` writes the rounds as JSON for another client to post. Details: [references/config.md](skills/granny-workflow/references/config.md#review-trail).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/loop-dark.svg">
  <img src="docs/images/loop-light.svg" alt="The granny loop: an optional plan review, then for each stage the implementer builds, optional checks run, reviewers review in parallel, P0/P1 go straight back, the judge classifies the rest, and a final check ends with a PR-ready branch that is not pushed">
</picture>

- **Worktree** - the run works in the branch's own git worktree, next to your repo. Your main checkout is not touched.
- **Implementer** - builds one stage, commits, and later fixes the findings sent back to it.
- **Checks** (optional) - commands granny runs itself; a red one goes back to the implementer before any review.
- **Reviewers** - all of them review every stage at the same time.
- **Judge** - P0/P1 findings skip it and go straight back. For the rest it rates impact, likelihood and fix cost; code turns that into a priority. Critical and major issues are always fixed, the others when their priority is above the threshold. What is not fixed is listed for you, with the reason.
- **Final review** - after the last stage, the whole branch is reviewed once more for problems between stages.
- **Parallel stages** - stages that do not depend on each other, also in other repos, run at the same time.

The full rules: [the decision table](skills/granny-workflow/references/config.md#the-decision-table).

## Configure

`granny setup` covers the common choices. To edit by hand: settings are read from `~/.config/granny/config.json`, then `<repo>/granny.config.json`, then the run's own overrides - later wins.

```json
{
  "threshold": 70,
  "maxRounds": 4,
  "reviewers": [
    { "name": "reviewer", "engine": "agent" },
    { "name": "codex", "engine": "auto" },
    { "name": "kimi", "engine": "opencode", "model": "kimi-code-plan-global/k3.1-pro", "effort": "max" }
  ],
  "checks": [
    { "name": "test", "run": "bun test" }
  ]
}
```

| key | default | |
|---|---|---|
| `threshold` | `70` | findings with a priority above it are fixed |
| `alwaysFix` | `["critical", "major"]` | impact classes that are always fixed |
| `maxRounds` | `4` | review rounds per stage |
| `reviewers` | the host model | any mix of host models, Codex, opencode models and other CLIs |
| `checks` | none | commands granny runs before every review |
| `planReview` | `false` | review the plan itself before building it - many more tokens and a much longer run; only when asked |
| `finalReview` | `true` | review the whole branch after the last stage |
| `parallel` | `true` | run independent stages at the same time |
| `roles.<role>.model` | the session model; on Claude Code the judge and helper use Haiku | model per role: `implementer`, `planner`, `judge`, `granny`, `helper` |

Every key, reviewer engines and examples: [config.md](skills/granny-workflow/references/config.md).

## Hosts

| host | how the loop runs |
|---|---|
| Claude Code | a Workflow script; every role is its own agent with its own model |
| opencode | a server plugin; every role is its own session with its own model |
| omp | an extension in your omp session; every role is its own `omp` process with its own model |
| Cursor | the agent follows the steps by hand with four subagents - not deterministic |

On Claude Code, plain commands (git, checks) run through a small Haiku helper agent, because Workflow scripts have no shell ([claude-code#98566](https://github.com/anthropics/claude-code/issues/98566)).

To resume a stopped run: on Claude Code relaunch it with `resumeFromRunId`; on opencode and omp relaunch it with `fromStage` set to the first unfinished stage.

## Develop

```sh
bun install
bun run build   # regenerates the engines, scripts/pr-comments.mjs and references/prompts.md from src/
bun run check   # typecheck + tests
```

`src/core` holds the loop, shared by every engine; `src/adapters` connects it to each host; `src/pr` is the trail poster. The generated engine files are committed so the skill installs without a build step.

## License

MIT
