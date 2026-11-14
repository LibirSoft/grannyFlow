# granny on Claude Code

The engine is three Workflow scripts, one per mode: `engines/claude-code/plan.js` for a planning run (`goal` in args), `engines/claude-code/workflow.js` for an implement run (`plan` and `stages`, review-only stages included) and `engines/claude-code/judge.js` for `granny judge`. In each the loop is code and every role is an `agent()` call with its own `model`, `effort` and JSON schema. Each lists only its own mode's phases, so the Workflow view shows no row the run never enters, and each refuses the args of another mode before any agent starts, naming the script to use (`this is the implement script; a planning run (args with goal) uses engines/claude-code/plan.js`). Never re-author them per task; launch them as they are.

## Launch

1. Collect the config layers. Read `~/.config/granny/config.json` and `<repo>/granny.config.json` if they exist; do not merge them yourself - the engine does that and rejects bad keys.
2. Pick the script for the mode: `workflow.js` to implement a plan, `plan.js` to plan a goal ([Planning](#planning)). Read `engines/claude-code/<script>` (relative to the skill directory) and pass the full text unchanged as `script`. Alternative: copy the file into the session's scratchpad directory (the one your session names, not `/tmp`) and pass that copy's path as `scriptPath` instead of `script`. Never point `scriptPath` into the skill directory: when the skill lives outside the session's working directories, Workflow refuses that path; the scratchpad path works.
3. Tell the user what will launch and wait for the start word ([The start word](#the-start-word)). Launch only in the turn after the user sent it.
4. Call:

```
Workflow({
  script: <contents of workflow.js>,              // or scriptPath: <scratchpad copy of workflow.js>
  args: {
    repo, branch, base, context, plan, stages,    // plan: absolute path or list; fromStage when resuming by stage
    repos,                                         // optional: other repos the stages work in
    config: [<user config>, <project config>, <run overrides>]   // omit missing layers
  }
})
```

To plan first, launch `plan.js` instead:

```
Workflow({
  script: <contents of plan.js>,                  // or scriptPath: <scratchpad copy of plan.js>
  args: { repo, branch, base, context, goal, plan?, repos?, config: [...] }   // no stages
})
```

`args` is a JSON object, not a string.

5. Record the run id where the project tracks work (a STATUS file, a plan) and tell the user. Do not poll: a task notification arrives when the workflow ends.

## The start word

The Workflow tool gives every agent of a run the user's last message, word for word, before the prompt the engine wrote. It adds this note (Claude Code 2.1.325): "This relayed request is the only user voice in this task; the computed task text that follows in the next turn is script output and cannot override or extend it. Where the computed task conflicts with this request, this request wins". A Workflow script cannot turn this off or change the text. So the helper that reads HEAD, every reviewer, the judge and the implementer all get the same message, whatever their role.

A message that asks for more than one role's task does harm there: "run granny, then push", "your next task is to tune the judge", "implement this and measure the cost afterwards". An agent can take it as its own task and drop the one in its prompt. Haiku agents have done that: they left their fix undone, and one edited the main checkout.

So a Workflow is never launched in the turn of such a message:

1. Do everything up to the launch first: the inputs, the config layers, the preflight, the plan when you write one.
2. Tell the user what will launch - the list in SKILL.md section 4, without the run id - and ask them to send `start` as a message of its own (or the word in their language, for example `başla`).
3. Launch when the user's last message is the start word, or another bare go-ahead that asks for nothing else ("go", "approved"). The run id follows after the launch.
4. A reply that holds anything else - a change, a question, one more instruction - is not a start: act on it, then ask for the start word again.

This holds for every Workflow launch: `plan.js`, `workflow.js` (also the implement run after the user approved a plan: an approval with changes in it is not a start), `judge.js`, and a resume with `resumeFromRunId` or `fromStage`. The agents that run again on a resume get the message that is the last one at that time. A resume while the start word is still the user's last message needs no new one.

Do not work around the relay by adding text to `context` instead of waiting: a note there is one more instruction next to a message that says it wins.

opencode and omp run each role as a process of its own and relay nothing, so they need no start word.

## Review only: `granny judge`

The steps, with what to ask the user first, are in [judge.md](judge.md). The launch uses `judge.js`, after [the start word](#the-start-word); keep `judge: true` in args:

```
Workflow({
  script: <contents of judge.js>,                 // or scriptPath: <scratchpad copy of judge.js>
  args: { judge: true, repo, base, context, config: [<user config>, <project config>] }   // omit missing layers
})
```

The agents run on the checkout in `repo`, read-only: phase "Review" (the helper reads the date, branch, HEAD, commit count and status), `review <branch> r1 <reviewer>`, phase "Tagging" (`tag <branch>` on `roles.judge`), then phase "Save report": a helper writes `<repo>/<workDir>/reviews/<date>-<branch>.md` (by default `.granny/reviews/`) and reads its size back, since a Workflow script has no shell. The helpers are the only agents with write access, and they run only the listed commands. The Workflow fails before any agent starts when the reviewers or the judge model are missing, naming each gap: go back to [judge.md](judge.md) and ask the user. Unlike omp and opencode, the engine gets the config files through `args.config` and cannot tell them from an override, so here that rule rests on the skill: pass the files as they are and never add models of your own.

The result is `{ outcome, counts, demoted, findings, failedReviewers, notJudged, uncommitted, reportPath, written, report, note }`. With `written: false` the helper did not leave the exact report on disk: write `report` to `reportPath` with the Write tool yourself.

## Models

`opus`, `sonnet`, `haiku`, or a model ID the session accepts. A role without a model inherits the session model; the judge defaults to `haiku` (it only classifies findings; set `"roles": { "judge": { "model": "sonnet" } }` to switch back - see [The judge's model](config.md#the-judges-model)); a judge answer that comes back empty or leaves findings unclassified gets one retry, `judge <stage> r<n> retry`, before those findings are sent unjudged ([config.md](config.md#the-decision-table)). `effort` is passed through (`low` … `max`); of a host-keyed `effort` only the `claude-code` key is, and without that key the agent gets no effort. Workflow scripts have no shell, so every plain command - the worktree setup, the HEAD, commit-count and status reads, the timeout probe, the checks, a lane's merge and cleanup, and the steps of a review command - runs in a helper agent on `roles.helper` (default `haiku`, effort `low`); each runs one given command and reports its exit code and output, so these steps cost tokens and their results are relayed by a model, not read directly. This is a stopgap until Claude Code ships a deterministic `run(cmd)` Workflow primitive ([claude-code#98566](https://github.com/anthropics/claude-code/issues/98566)), when granny will run these commands through it and drop the helper agents. `roles.granny` covers the extraction fallback and the final check, so do not go below `sonnet` there.

## Worktree

With `worktree` on (the default) the run starts with phase "Worktree": a helper agent (label `worktree`, write access, `roles.helper`'s model) runs the setup script from `repo` and returns what it printed; the engine reads the `[granny] worktree: <path>` line from it and stops the run when the script fails - a dirty reused worktree, for example - before any other agent starts. Pass the main checkout as `repo` and leave `branch` alone: the script reuses the worktree that has it checked out or creates one ([config.md](config.md#worktree)). `agent()` has no working-directory option, so every later prompt carries the worktree instead: `Working repo: <worktree>` and `cd <worktree> &&` before each command; the review runner `cd`s there too. The result's `worktree` is the path. On resume the cached setup call returns the same path; a relaunch with `fromStage` runs the setup again and reuses the worktree.

## Planning

A planning run launches `plan.js` with `goal` in args (and no `stages`); its phases are "Worktree", "Plan" and "Plan review". Phase "Plan" runs after "Worktree": one `agent()` call, label `plan`, `roles.planner`'s model and effort, write access, schema `{ files, stages, summary, questions? }`. It writes the plan at the absolute path in its prompt - by default the main checkout's `<workDir>/plans/<branch-slug>.md`, which the session can write - then the plan review runs on it when `"planReview": true`, and the Workflow ends with `draft`, `plan`, `stages: []` and `final: null` ([config.md](config.md#planning)). Once the user approves, the implement run is a new launch of `workflow.js` with `plan: draft.files` and the approved `stages`, not a resume of the planning run. A bare approval is its start word; an approval that also asks for changes is not ([The start word](#the-start-word)).

## Parallel stages

With `parallel` on (the default) the engine starts independent stages together, up to `maxParallel` ([config.md](config.md#parallel-stages)): each stage's `agent()` calls run concurrently with the other stages', next to the reviewers each stage already runs at once. The Workflow runs a limited number of agents at a time and queues the rest, so keep `maxParallel` times the number of reviewers modest. With `repos`, phase "Worktree" runs one setup agent per repo (labels `worktree` and `worktree <repo name>`); a stage that runs in its own worktree has one more (`worktree <stage>`), and its merge, the check that the lane really is in HEAD and the cleanup run in helper agents (`roles.helper`) too (labels `merge <stage>`, `verify merge <stage>`, `cleanup <stage>`), since the Workflow script has no shell; a merge the helper reports wrongly is caught by that check ([config.md](config.md#parallel-stages)). For the same reason every implementing stage has two small helper agents in phase "Implement": `head <stage>` reads HEAD before the implementer runs (the stage's review base) and `commits <stage>` counts the commits since then. Granny reads the first line of their output shaped like a SHA or a count; a `note` the helper adds to a command that ran is logged, never read as output ([config.md](config.md#checks)). None: `status <stage> implement` reads `git status --porcelain`, a dirty tree gets one `commit <stage> implement` prompt and `commits <stage> after commit` counts again; still none ends the stage `no-changes`. The final check runs once per repo. Before it, phase "Final review" reviews each repo's whole branch ([config.md](config.md#final-review)) with the same `agent()` calls as a stage's review loop (labels `review final review r<n> <reviewer>`, `judge final review r<n>`, `fix final review r<n>`; `final review <repo name>` in another repo); the result has `finalReview`, and each entry of `repos` its own. The phase bar shows the phase the last stage entered; each agent's own phase is still right.

With `stepAgents` on ([config.md](config.md#step-agents)) and a stage with two or more steps, phase "Implement" runs one implementer `agent()` per step, in order, labelled `implement <stage> step <k>/<n>`. After a step that left work, a commit agent `commit <stage> step <k>/<n>` runs before the next step; the working tree reads around it are `status <stage> step <k>/<n>` and `status <stage> step <k>/<n> after commit`. The checks and the review loop then run once, after the last step, as they do after one agent. On a `resumeFromRunId` resume the finished steps come back from the cache, and the first call that did not finish runs again ([Resume](#resume)).

## Checks

With `checks` in the config ([config.md](config.md#checks)) phase "Checks" runs after a stage's implementer, after every fix, once per repo before the final review, and once more after the final check when it moved HEAD. When a check the stages select has a `timeout`, a helper agent first looks for `timeout` and then `gtimeout` on PATH (label `timeout probe`, before the worktree setup); with neither the run stops before any other agent starts ([config.md](config.md#checks)). Before each gate's checks a helper agent reads `git status --porcelain` (label `status <stage> <gate>`; the plan files do not count; a dirty tree goes to the implementer as `commit <stage> <gate> #<n>`, and a status the helper cannot read, also on one more read, fails the gate without running the checks, [config.md](config.md#checks)); after them a helper agent reads HEAD (label `head <stage> <gate>`), so the final gate reuses a one-stage repo's result only on the same commit; the final check's own HEAD read is `head pr-ready check`. The Workflow script has no shell, so each check command runs in a helper agent (label `check <stage> <check>`, `roles.helper`'s model, the "Granny - a check command" prompt in [prompts.md](prompts.md)) that runs it in the worktree and reports the exit code and output; granny then applies the pass rule and the metric itself, to the output only - a `note` the helper adds when the check ran is logged, not searched for the metric. That is weaker than a direct exec: the result is only as honest as the helper's report. The helper may shorten a very long output to its last 3000 characters; for a check with a `metric` it is told to keep every line the metric's pattern matches as well, so a coverage summary printed at the top of a long table is still found. A red check goes back to the implementer as an `agent()` call labelled `repair <stage> <gate> #<n>` (phase "Implement"); the `final` gate's labels read `check final review <check>` and `repair final review final #<n>`. Each stage's `checks` and the run's `checks` in the result list every run.

## Plan review

The plan review is optional; enable it with `"planReview": true`. It runs every reviewer, the judge and the implementer over the plan for up to `maxRounds` rounds before any code is written; each round is a full review + judge + fix, so it uses many more tokens and makes the run much longer (tens of minutes per round on high-effort models), so turn it on only when the user asks ([config.md](config.md#plan-review)); the Workflow log shows that warning when the phase starts. With `plan` in args and `planReview` on, phase "Plan review" runs after "Worktree" and before the first "Implement" ([config.md](config.md#plan-review)). The reviewers run as in a stage, each Codex engine through helper agents that start, wait for and read the plan-review script ([Reviewers](#reviewers)) (`codex exec --sandbox read-only ...` or the plugin's `node <companion> task ...`); the judge and the fix (`fix plan review r<n>`, the implementer with write access, result `{ files, changes, declined, deviations }`) are `agent()` calls in that phase. The fix agent writes the plan files at their absolute paths - a plan in the main checkout works, since the session works there too - and dates its `rN deltas` section with its shell's `date`, because the Workflow script has no clock. A plan review that ends `round-cap` or `review-failed` ends the Workflow there, with `stages: []` and `final: null`.

## Reviewers

Every entry of `reviewers` reviews every round, and all of them start at once: each is its own chain of `agent()` calls - an agent reviewer directly, every other engine through helper agents (`roles.helper`'s model) that run its review script. The Workflow runs a limited number of agents at a time; reviewers beyond that wait for a free slot.

A Codex, `command` or `opencode` review can run longer than the 10 minutes a Claude Code Bash call may take, so no helper waits for it on its own. The engine runs it in fixed steps, each a helper that runs one given command once ("Granny - a review command" in [prompts.md](prompts.md)):

1. `review <stage> r<n> <name>` starts the review script detached (`{ set -m; nohup bash -c '<script>' ... & }`) and returns at once. The script writes what it prints to `<workDir>/review-<stage>-r<n>-<name>.out`, its exit code to `.exit` and its process group id to `.pid`. The `rm` of the old review files runs before it, outside `bash -c`, where the helper's shell can check it.
2. `review <stage> r<n> <name> wait <k>` runs in the foreground, with the Bash timeout set to 600000 ms, a loop that checks the `.exit` file every 5 s for up to 9 minutes, then prints `done` or `pending`. The engine calls the next wait until it reads `done`; a wait that printed anything else, failed or returned nothing counts as `pending`. No helper decides how to wait.
3. `review <stage> r<n> <name> read` prints the `.out` file and exits with the code in `.exit`.
4. `review <stage> r<n> <name> save`, for an `opencode` reviewer only: after a read that exited 0, the engine takes the answer out of opencode's event stream and a helper writes it to the review's `.md` file with a here-document ("Granny - saving an opencode reviewer's answer" in [prompts.md](prompts.md)). A failed save is logged and the review goes on.

After 7 waits (63 minutes) without `done`, `review <stage> r<n> <name> stop` stops the process group, and the reviewer did not run (note `review command still running after 7 waits of up to 9 minutes (63 minutes) - stopped it`), so it gets its one retry ([config.md](config.md#a-reviewer-that-does-not-run)). A start that fails (note `review command did not start ...`) gets the same retry. The plan review runs its commands the same way. On opencode granny runs the review script directly and waits for it itself.


- `agent` runs a Claude Code subagent on the entry's `model` and `effort` (the `claude-code` key of a host-keyed `effort`), so Claude models only (`opus`, `sonnet`, `haiku`, a Claude model ID). To have GLM, Kimi or another provider review, use engine `opencode`.
- `opencode` runs `opencode run --standalone` in the detached script as a read-only agent opencode itself enforces, on the entry's opencode `provider/model` with `effort` as its variant - for example `{ "name": "glm", "engine": "opencode", "model": "opencode/glm-5.3-flash-free" }`. opencode must be installed and logged in to the provider where the helper agent's shell runs. The read prints opencode's answer as decoded plain text, every tool output left out; the answer goes to the `save` step above ([config.md](config.md#opencode-reviewers)).
- `auto` (an entry's engine when it names none; the default reviewer list is one `agent` entry instead): the review script looks for OpenAI's Codex plugin for Claude Code (the newest `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`) and runs `node <companion> review` when it finds one and `node` is on `PATH`, otherwise `codex exec review`. The shell script makes the choice at run time, since the Workflow script cannot read the filesystem; it prints the choice and the engine logs it every round as `<stage> r<n> <name>: reviewer: ...` - tell the user which one ran.
- `codex-plugin` makes the plugin mandatory: without it, or without `node`, the reviewer fails (and, after its retry, the stage ends `review-failed`) with a note naming the path it looked in. `mode: "adversarial-review"` (optionally with `focus`) runs the plugin's adversarial review; under `auto` it also needs the plugin and never falls back to a plain CLI review. Each plugin reviewer runs with its own `CLAUDE_PLUGIN_DATA` (`<workDir>/codex-plugin-<name>`) and stops the Codex app-server broker it started when its script exits, so it touches neither your session's broker nor another reviewer's, and leaves none behind for repos your session's `SessionEnd` hook never sees.
- `command` runs the template in the detached script, in the shell of the helper that started it; `{prompt}` arrives as one shell-quoted line.
- An `agent` reviewer, the judge and the extraction agent are read-only by default only by their prompt: granny prefixes it with `READ-ONLY ROLE: do not edit, create, stage or commit any file.`, and nothing stops a subagent that ignores it. opencode enforces it with session permissions. With `"readOnlyAgent": true` granny passes `agentType: "granny-readonly"` to their `agent()` calls: the agent definition the skill ships has Read, Grep, Glob and Bash but no Edit or Write, and the skill's PreToolUse hook lets that agent type's Bash run only read-only git and shell commands. Both must be installed first (`~/.claude/agents/`, `~/.claude/hooks/` and a `hooks` entry in `~/.claude/settings.json`); a missing agent stops the run at the first reviewer with `agent type 'granny-readonly' not found` ([config.md](config.md#read-only-roles)). Configure `checks` as the backstop either way: the clean-tree read before every gate and the HEAD each check run records catch, after the fact, a file such an agent left changed or a commit it made.

Details: [config.md](config.md#reviewers).

## Resume

Same script, same args: a run resumes with the script it was launched with (`plan.js`, `workflow.js` or `judge.js`), `Workflow({ scriptPath, args, resumeFromRunId })`, where `scriptPath` is the path the first launch returned when you passed `script`, or the same scratchpad copy you launched with (leave it in place until the run is done). Unchanged agent calls return cached results instantly, so the run continues where it stopped. The agents that run again get the user's last message as it is then, so when that is no longer the start word, ask for it before the resume ([The start word](#the-start-word)). To restart from a stage instead, add `fromStage` to args; when that stage's implementer finds its work already committed and adds nothing, the stage is reviewed over `<base>...HEAD` instead of ending `no-changes` ([config.md](config.md#checks), Reading git). With parallel stages, `fromStage` runs every stage from there on again, also those that finished beside the failed one (the log line `a stage failed ... Finished: ... Not finished: ...` names them), so prefer `resumeFromRunId`, which returns their cached results.

## When it ends

The result is `{ repo, branch, base, worktree, draft?, plan?, stages: [...], final, repos? }`; `repos` is there when the run spans several repos; `draft` is there in a planning run; `plan` is there when args had a `plan`. If anything looks empty, read `<transcriptDir>/journal.jsonl`, which records every agent's return value, before drawing conclusions. Then report per SKILL.md section 5 and wait.

## When the PR is opened

The run's review trail is in `<worktree>/.granny/trail/` (`trail.dir` in the result). Once the PR is open, run `cd <worktree> && node <skill-dir>/scripts/pr-comments.mjs` and relay its output; it posts every round as a review on the GitHub PR or GitLab MR, and on any other platform `--out <file>` writes the rounds for another client ([config.md](config.md#review-trail)). Only the script posts review comments - never write or post them yourself.
