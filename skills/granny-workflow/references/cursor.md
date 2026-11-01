# granny on Cursor and other hosts

Cursor has subagents but no workflow engine, so you run the loop yourself, step by step, with the same prompts and the same rules. It is not deterministic: keep strictly to the steps below and keep a written log in `<workDir>/runs/<date>/journal.md`.

## Install the subagents

Copy `engines/cursor/agents/*.md` to `~/.cursor/agents/` (all projects) or `<project>/.cursor/agents/`, and set `model:` in each file (`inherit` uses the chat's model). Cursor sometimes ignores a subagent's `model:`; check which model actually ran when it matters.

Config: read `~/.config/granny/config.json` and `<repo>/granny.config.json` yourself and apply the layering in [config.md](config.md); only `threshold`, `maxRounds`, `base`, `gates`, `workDir`, `language`, `aiAttribution`, `rules` and the reviewer engine apply here.

## The loop

Prompts: [prompts.md](prompts.md). Each subagent ends its answer with a JSON block; read that block, not the prose.

For each stage, from `fromStage` on:

1. **Implement.** Delegate to `granny-implementer` with the "Implementer - stage" prompt. Keep its `startSha`.
2. **Review**, round N (N starts at 1; skip the loop when the stage has `review: false`):
   - engine `codex`, or `auto` (the default; here it means the Codex CLI): run in the terminal, from the repo:
     `codex exec review --base <startSha> -o <workDir>/review-<stage>-rN.md > <workDir>/review-<stage>-rN.log 2>&1`
     It can take over 10 minutes; let it finish. Non-zero exit → the stage ends `review-failed`; never invent findings.
     Read the findings from `- [P1] Title — file:line` lines and number them F1, F2, ….
   - engine `codex-plugin`: the same, with the plugin command from [config.md](config.md#reviewer) (`node <companion> review --wait --base <startSha> --scope branch > ….md 2> ….log`, or `adversarial-review … -- <focus>`). No companion, or no `node` on `PATH` → `review-failed`. Adversarial findings read `- [high] Title (file:line)`: critical/high/medium/low are P0/P1/P2/P3.
   - engine `agent`: delegate to `granny-reviewer` with the "Reviewer - agent engine" prompt.
   - No findings → stage `clean`.
3. **Judge.** Delegate to `granny-judge` with the "Judge" prompt and the findings.
4. **Triage**, exactly: a finding is sent back when its severity is P0/P1 (or critical/high), when the judge gave it no score, or when its score is **strictly greater** than `threshold` (default 70). Everything else is residual for the user.
   - Nothing to send → stage `residual-only`.
   - Otherwise delegate to `granny-implementer` with the "Implementer - fix" prompt and only the findings to send, then go to step 2 with N+1.
   - After `maxRounds` (default 4) reviews without reaching `clean` or `residual-only` → stage `round-cap`; the last round's findings are unresolved.

After the last stage, do the "Granny - final check" yourself, then report per SKILL.md section 5 and wait.
