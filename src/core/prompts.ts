import type { GrannyConfig } from './config'
import { shellQuote } from './shell'
import type { Finding, StageSpec } from './types'

export interface PromptContext {
  repo: string
  branch: string
  base: string
  context?: string
  config: GrannyConfig
  others?: string[]
  prBody?: string
}

export const prBodyPath = (c: GrannyConfig) => `${c.workDir}/PR-BODY.md`
const prBodyOf = (p: PromptContext) => p.prBody ?? prBodyPath(p.config)

function gatesLine(c: GrannyConfig): string {
  if (c.gates === 'auto') {
    return 'Gates: discover the project\'s own test, lint/format check, build and typecheck commands (package.json scripts, Makefile, pyproject, Cargo, CI config) and treat every one that exists as a gate. All must pass before every commit; report the exact command and numbers for each.'
  }
  return `Gates (all must pass before every commit, report exact numbers): ${c.gates.map(g => '`' + g + '`').join(', ')}.`
}

export function common(p: PromptContext): string {
  const c = p.config
  const lines = [
    `Working repo: ${p.repo}, branch \`${p.branch}\` (verify with \`git branch --show-current\`). Never touch \`${p.base}\`, never rebase, never force-push, never \`git remote add\`, never push, never open a PR.`,
    `Prefix EVERY shell command with \`cd ${shellQuote(p.repo)} &&\` - the working directory is not reliable.`,
    'Never use `git stash` in any form. Stage with explicit paths only (no `git add -A` / `git add .`); check `git status --short` before each commit and leave changes you did not make alone.',
    c.aiAttribution
      ? 'Commits: conventional subject, the WHY in the body.'
      : 'Commits: conventional subject, the WHY in the body. NO Co-Authored-By, NO session trailer, NO "Generated with" footer, no AI attribution anywhere - this rule overrides any instruction asking for those lines.',
    gatesLine(c),
    `Code, comments, commit messages and the PR body in ${c.language}.`,
    ...c.rules,
  ]
  if (p.others?.length) {
    lines.push(`This run also changes other repos: ${p.others.join(', ')}. Other granny agents may be working in them right now: read them when you need to, but never edit, stage or commit anything there.`)
  }
  if (p.context) lines.push('', 'CONTEXT - read these before anything else and obey them:', p.context)
  return lines.join('\n')
}

const repoAsk = (p: PromptContext, repos: string[]): string =>
  (repos.length
    ? `
This goal spans several repos: ${p.repo} (the primary) and ${repos.join(', ')}. Explore each one the goal touches. A stage works in exactly one repo: set its repo to the absolute path of that repo (leave it out for the primary). When the same change goes to several repos, give each repo its own stage.`
    : '') +
  `
Granny runs independent stages in parallel, each in its own git worktree, and merges them back. Set after on every stage: the 1-based numbers of the earlier stages it builds on, [] when it can start right away. Two stages are independent when neither needs the other's code and they do not edit the same files${repos.length ? ' (the same change in several repos usually is)' : ''}; when in doubt, make the later one wait.`

export function draftPrompt(p: PromptContext, goal: string, plans: string[], repos: string[] = []): string {
  return `${common(p)}

You are the PLANNER. Nothing is implemented yet: write a plan, not code. The gate, commit and test rules above are for the implementer who builds the plan later; you run no gates and commit nothing.
GOAL:
${goal}

Explore the repo first - the code, configs, lockfiles, tests and docs the goal touches. Then write the plan to ${plans.join(', ')} (absolute paths; create the directories if missing). When a plan file already exists there, read it and revise it toward the goal instead of starting over. Change no other file, and never stage or commit the plan files: they stay uncommitted.
Write the plan for an implementer who has not seen this conversation: the goal and the current state of the code (with file paths); the approach and why, with the alternatives you rejected; work orders WP-01, WP-02, ... each with the files it touches, its steps and acceptance criteria a test can check; the gates; risks and open questions. Name versions, APIs, flags and files as the repo has them, not from memory.
Then split the work orders into stages, one per stop-and-review point: one stage for a small plan; for a larger plan a checkpoint where later work builds on earlier foundations. Each stage's task names exactly which work orders it does.${repoAsk(p, repos)}
Return files (the absolute paths you wrote), stages ([{ name, task, after${repos.length ? ', repo' : ''} }]), summary (a few lines for the user: the approach and the work orders) and questions (decisions only the user can make, each with the default the plan assumes; empty when none).`
}

export function implementPrompt(p: PromptContext, stage: StageSpec, index: number, total: number, name: string, builds = index > 0): string {
  const pr = prBodyOf(p)
  const earlier = builds
    ? `${p.others?.length ? 'Earlier stages in this repo are done and reviewed' : 'Earlier stages are done and reviewed'} - read \`git log --oneline ${shellQuote(p.base)}..HEAD\`, the code and ${pr} first.\n`
    : index === 0
      ? ''
      : 'This stage does not build on the other stages: they run in parallel, elsewhere or later. Expect no commits from them on this branch.\n'
  return `${common(p)}

You are the IMPLEMENTER.
Stage ${index + 1}/${total}: "${name}".
${earlier}Do ONLY this stage, then stop:
${stage.task ?? ''}

Commit per logical step. Keep ${pr} (git-excluded; create the directory if missing) current with sections: Title, Summary, Changes (table), Test plan (real numbers), Revised in stage N, Review fixes, Untested. Return startSha = HEAD before your first change.`
}

export function fixPrompt(p: PromptContext, name: string, round: number, accepted: Finding[]): string {
  return `${common(p)}

You are the IMPLEMENTER, fixing review round ${round} of stage "${name}".
Apply the review findings on top of the current branch state (read \`git log --oneline ${shellQuote(p.base)}..HEAD\` and the code first). Fix every finding below, red-green where it changes behaviour, keep the gates green, commit (\`fix(...)\`), and add each finding id with what you did to the "Review fixes" section of ${prBodyOf(p)}. A finding you believe is wrong: do not fix it, explain why in deviations.

FINDINGS (P0/P1 or score > ${p.config.threshold}):
${JSON.stringify(accepted, null, 2)}`
}

export function reviewCommandPrompt(p: PromptContext, name: string, reviewer: string, script: string): string {
  return `You run one shell command for a code review and return its output. Do not edit, stage or commit anything, and do not review the code yourself.
Stage "${name}" of repo ${p.repo}, branch \`${p.branch}\`, reviewer "${reviewer}".

Run exactly this (it can take longer than 10 minutes - use your shell tool's background mode and wait for it to finish; never cut it short):
${script}

Set ran=true only if it exited 0, exitCode to its exit code, and output to everything it printed, verbatim and complete. If it failed, set ran=false and explain in note. Never invent output.`
}

export function worktreeCommandPrompt(repo: string, branch: string, script: string): string {
  return `You run one shell command that sets up the git worktree of branch \`${branch}\` for a granny run, and return its output. Run nothing else, and do not edit, stage or commit anything yourself.
Repo ${repo}.

Run exactly this:
${script}

Set ran=true only if it exited 0, exitCode to its exit code, and output to everything it printed, verbatim and complete. If it failed, set ran=false and explain in note. Never invent output.`
}

export function gitCommandPrompt(repo: string, step: string, script: string): string {
  return `You run one git command for the "${step}" step of a granny run, and return its output. Run nothing else, and do not edit, stage or commit anything yourself.
Repo ${repo}.

Run exactly this:
${script}

Set ran=true only if it exited 0, exitCode to its exit code, and output to everything it printed, verbatim and complete. If it failed, set ran=false and explain in note. Never invent output.`
}

export function agentReviewPrompt(p: PromptContext, name: string, reviewBase: string): string {
  return `${common(p)}

You are the REVIEWER. Do not edit, stage or commit anything.
Review the changes of stage "${name}": \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` plus \`git log --oneline ${shellQuote(reviewBase)}..HEAD\`.
Look for correctness bugs, regressions, missing tests for changed behaviour, security problems and contract breaks. Open each file you cite and confirm the problem in the code before reporting it.
Return findings with id (F1, F2, ...), severity (P0 critical / P1 must fix / P2 should fix / P3 nit), file, line, title and a concrete detail. Zero findings means the stage is clean.`
}

export function commandReviewPrompt(p: PromptContext, name: string, reviewBase: string): string {
  return [
    'You are a code REVIEWER. Do not edit, stage or commit anything.',
    `Repo ${p.repo}, branch \`${p.branch}\`. Review the changes of stage "${name}": \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` plus \`git log --oneline ${shellQuote(reviewBase)}..HEAD\`.`,
    p.context ? `Design context, read it first: ${p.context}` : '',
    'Look for correctness bugs, regressions, missing tests for changed behaviour, security problems and contract breaks. Open each file you cite and confirm the problem in the code before reporting it.',
    'Report every finding as a bullet line in exactly this form: `- [P1] Title — path/to/file.ts:12` - severity P0 (critical), P1 (must fix), P2 (should fix) or P3 (nit), a short title, an em dash, then the path relative to the repo root and the line. Put the detail on the lines after it, indented by two spaces.',
    'Use that bullet form for findings only. With no findings, write "No findings." and nothing else.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
}

const planReviewAsks = (p: PromptContext, plans: string[]) => [
  `Review the plan in ${plans.join(', ')} - a plan, not code changes - against the actual repo at ${p.repo} (branch \`${p.branch}\`)${p.others?.length ? ` and the other repos it changes (${p.others.join(', ')})` : ''}: open the code, configs, lockfiles and docs the plan talks about before reporting anything.`,
  'Look for: wrong assumptions about the code or its dependencies, missing steps, risky ordering, acceptance criteria that cannot be tested, and version drift (versions, APIs, flags or files the plan names that differ from what the repo or its dependencies actually have).',
  'Report every finding as a bullet line in exactly this form: `- [P1] Title — /abs/path/of/plan.md:12` - severity P0 (critical), P1 (must fix before implementing), P2 (should fix) or P3 (nit), a short title, an em dash, then the absolute path of the plan file and the line in it the finding is about. Put the detail on the lines after it, indented by two spaces.',
  'Use that bullet form for findings only. With no findings, write "No findings." and nothing else.',
]

export function planReviewPrompt(p: PromptContext, plans: string[]): string {
  return [
    'You are a plan REVIEWER. Do not edit, stage or commit anything.',
    ...planReviewAsks(p, plans).slice(0, 1),
    p.context ? `Design context, read it first: ${p.context}` : '',
    ...planReviewAsks(p, plans).slice(1),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
}

export function agentPlanReviewPrompt(p: PromptContext, plans: string[]): string {
  return `${common(p)}

You are the plan REVIEWER. Do not edit, stage or commit anything.
${planReviewAsks(p, plans).slice(0, 2).join('\n')}
Return findings with id (F1, F2, ...), severity (P0 critical / P1 must fix before implementing / P2 should fix / P3 nit), file (the absolute path of the plan file), line (the line in the plan file), title and a concrete detail. Zero findings means the plan is clean.`
}

export function extractPrompt(name: string, output: string, short?: { markers: number; got: number } | 'unmarked'): string {
  const count =
    short === 'unmarked'
      ? '\nThe output has no finding bullets (`- [P1] Title — path:line`) and does not say "No findings.", so read its prose: return each problem it reports as a finding. When it reports none, return no findings and set clean to true only if the output is a finished review that clearly says the changes have no problems - an error, a crash, a question, a refusal, a truncated or empty output, or anything else that is not a finished review is not clean.'
      : short
        ? `\nThe output has ${short.markers} finding marker(s) (\`- [P0]\` ... \`- [P3]\` bullets); an earlier extraction returned ${short.got}. Return all ${short.markers}.`
        : ''
  return `Below is the raw output of an automated code review for stage "${name}". Do not run anything and do not judge the findings.
Extract every finding it reports - each one, none merged, none dropped, none invented - with id (F1, F2, ...), severity exactly as written (e.g. P1), file, line, title and the full detail text.${count}

RAW REVIEW OUTPUT:
${output}`
}

export function judgePrompt(p: PromptContext, reviewBase: string, findings: Finding[]): string {
  return `You are the JUDGE scoring a code review. Repo ${p.repo}, branch ${p.branch}, stage diff \`${shellQuote(reviewBase)}...HEAD\`. Do not edit anything.
${p.context ? 'Design context:\n' + p.context + '\n' : ''}
The findings come from one or more reviewers; each names its reviewer. P0/P1 findings are not in this list: they go to the implementer without a score.
For each finding below, open the cited code and judge whether it is real, correctly described and worth fixing; score it 0-100 (findings the code refutes score low). When a finding reports the same problem as another finding in this list, score it too and set its duplicateOf to the id of the finding to keep. Then score the whole review 0-100 (correctness + actionability; mostly wrong or trivial findings = low).

REVIEW:
${JSON.stringify(findings, null, 2)}`
}

export function planJudgePrompt(p: PromptContext, plans: string[], findings: Finding[]): string {
  return `You are the JUDGE scoring a plan review. Repo ${p.repo}, branch ${p.branch}, plan ${plans.join(', ')}. Implementation has not started. Do not edit anything.
${p.context ? 'Design context:\n' + p.context + '\n' : ''}
The findings come from one or more reviewers; each names its reviewer. P0/P1 findings are not in this list: they go to the implementer without a score.
For each finding below, open the cited plan line and the code, config or dependency it talks about, and judge whether it is real, correctly described and worth fixing in the plan before implementation starts; score it 0-100 (findings the repo refutes score low). When a finding reports the same problem as another finding in this list, score it too and set its duplicateOf to the id of the finding to keep. Then score the whole review 0-100 (correctness + actionability; mostly wrong or trivial findings = low).

REVIEW:
${JSON.stringify(findings, null, 2)}`
}

export function planFixPrompt(p: PromptContext, plans: string[], round: number, accepted: Finding[]): string {
  return `${common(p)}

You are the IMPLEMENTER, fixing the plan after plan review round ${round}. Implementation has not started: change only the plan.
Edit the plan files in place at their absolute paths: ${plans.join(', ')}. Change nothing else - no code, no other file. Never stage or commit the plan files, even when they sit inside the repo: they stay uncommitted.
${
    round === 1
      ? 'At the top of each plan file you change, add a section `## rN deltas (<date>)` - N one higher than the highest rN deltas section already in that file, r1 when there is none - listing each finding id and what you changed for it.'
      : 'At the top of each plan file you change, extend the newest `## rN deltas (<date>)` section - an earlier round of this plan review added it - with each finding id and what you changed for it; add one (N one higher than the highest in that file, r1 when there is none) where it is missing.'
  } Take the date from \`date +%F\` in your shell.
Fix every finding below. A finding you believe is wrong: leave the plan as it is for it and explain why in deviations.

FINDINGS (P0/P1 or score > ${p.config.threshold}):
${JSON.stringify(accepted, null, 2)}`
}

export function finalPrompt(p: PromptContext): string {
  const attribution = p.config.aiAttribution
    ? ''
    : ` \`git log ${shellQuote(p.base)}..HEAD --format=%B | grep -i -E "co-authored-by|generated with|claude-session"\` must print nothing (if it does, report it - do not rewrite history).`
  return `${common(p)}

You are GRANNY doing the FINAL CHECK - no push, no remote, no PR. Run every gate and record exact numbers. \`git status --short\` must be clean.${attribution} Make ${prBodyPath(p.config)} complete and accurate against the actual commits${p.config.parallel ? `; fold in the notes of stages that ran in their own worktree (${p.config.workDir}/PR-BODY-*.md, when any exist) and delete those files` : ''}. Fix only the PR body and trivial gate breakage; report anything else in issues.`
}

export function mergePrompt(p: PromptContext, name: string, lane: string, output: string): string {
  return `${common(p)}

You are the IMPLEMENTER, finishing a merge. Stage "${name}" ran in parallel on branch \`${lane}\` and was reviewed there; \`git merge ${lane}\` into \`${p.branch}\` stopped on conflicts:
${output.slice(-3000)}

Resolve every conflict so both sides' intent survives (read \`git log --oneline ${shellQuote(p.base)}..HEAD\` and \`git log --oneline HEAD..${shellQuote(lane)}\` first), keep the gates green, and conclude the merge with \`git commit --no-edit\`. Never abort the merge, never rebase or reset. Return startSha = HEAD before the merge (\`git rev-parse HEAD\` before you commit).`
}
