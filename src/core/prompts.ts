import type { GrannyConfig } from './config'
import { isBlocker } from './review'
import { shellQuote } from './shell'
import type { Declined, Finding, StageSpec } from './types'

/** One review round's decisions in the ledger; loop is set on a round of an earlier review loop (a stage's review). */
export interface EarlierRound {
  round: number
  sent: Finding[]
  residual?: Finding[]
  deviations?: string
  declined?: Declined[]
  loop?: { id: string; name: string }
}

export interface Overruled {
  id: string
  repeatOf: string
  reason?: string
  said: string
}

export const roundLabel = (round: number, f: Pick<Finding, 'id'>, loop?: EarlierRound['loop']) => `${loop ? `${loop.id}/` : ''}r${round}/${f.id}`

const judgeRouting = (findings: Finding[]): string =>
  findings.some(isBlocker)
    ? 'P0/P1 findings are here only because a fixer declined findings in an earlier round: classify them like the rest. A P0/P1 goes to the implementer whatever you classify, unless its repeatOf names a finding the fixer declined - then your classification decides it.'
    : 'P0/P1 findings are not in this list: they go to the implementer without you.'

const rubric = (task: string) => `Classify every finding - do not score it. Give each exactly these fields:
- verdict: confirmed (the code shows the problem) | refuted (the code shows it is absent or not a problem) | unverified (you cannot tell either way).
- impact, how bad IF it triggers: critical | major | moderate | minor | none.
  Judge impact assuming the trigger happens. Likelihood never lowers impact; it is its own field.
  - critical: data loss or corruption, writing to the wrong record, security or authorization bypass, secret or personal data leak, a draft going public, an irreversible operation, stored data silently read differently.
  - major: the user cannot get out from inside the app (a lock only a reload clears, endless loading, a crash); something that worked silently breaks; an API or contract break; a required part of ${task} is missing.
  - moderate: wrong behaviour with an easy workaround; wrong or missing error message; missing test for changed behaviour; duplicated logic.
  - minor: visual defect, naming, style.
  - none: not a problem.
- likelihood: common (the normal flow) | edge (special timing or state: a race, an expired session, a boundary value) | rare (forced input, a rarely used feature).
- fixCost: trivial (a few lines) | small (one function or file plus a test) | large (cross-module, a redesign).
- scope: in-scope | pre-existing (there before this change) | other-stage (another stage's job).
- evidence: path:line plus the concrete trigger steps, e.g. \`Editor.tsx:225\` + "save -> go back -> late response arrives -> save again". Always give a path:line: without one the finding counts as unverified, which lowers its impact one class.
- reason: one line.
Example: a late save response re-binds the editor to another post's id, so the next save can overwrite the wrong post: confirmed, critical, edge, small, in-scope, though the window is narrow.`

const decided = (f: Finding) => (f.decision ? `${f.decision.action} - rule ${f.decision.rule}: ${f.decision.why}${f.decision.raised ? ` (ratchet raised ${f.decision.raised})` : ''}` : undefined)

function judgeHistory(earlier: EarlierRound[]): string {
  if (!earlier.length) return ''
  const labelled = (e: EarlierRound, findings: Finding[]) =>
    JSON.stringify(
      findings.map(f => ({
        label: roundLabel(e.round, f, e.loop),
        decision: decided(f),
        severity: f.severity,
        file: f.file,
        line: f.line,
        title: f.title,
        detail: f.detail,
        verdict: f.verdict,
        impact: f.impact,
        likelihood: f.likelihood,
        fixCost: f.fixCost,
        scope: f.scope,
        priority: f.priority,
        score: f.score,
        evidence: f.evidence,
      })),
    )
  const rounds = earlier.map(e => {
    const title = e.loop ? `${e.loop.name}, round ${e.round}` : `Round ${e.round}`
    const kept = e.residual?.length ? `\n${title} kept as residual:\n${labelled(e, e.residual)}` : ''
    if (!e.sent.length) return kept.slice(1)
    const declined = e.declined?.length ? e.declined.map(d => `\n- ${roundLabel(e.round, d, e.loop)}: ${d.reason || 'no reason given'}`).join('') : ' none'
    const notes = e.deviations?.trim() ? `\nThe fixer's other notes: ${e.deviations.trim()}` : ''
    return `${title} sent to the fixer:
${labelled(e, e.sent)}
Declined by the fixer (not fixed), and why:${declined}${notes}${kept}`
  })
  return `
EARLIER DECISIONS - the findings earlier rounds sent to the fixer or kept as residual for the user, by label, with classification, priority and deciding rule, and the fixer's declines with its reasons${earlier.some(e => e.loop) ? ". A round named after a stage is that stage's own review; this review covers its code too" : ''}:
${rounds.join('\n\n')}

When a finding below repeats an earlier one, set its repeatOf to that label, then:
- a repeat of a finding the fixer declined with a convincing reason the code backs: classify it refuted, or by its scope when it belongs elsewhere; cite the label and the fixer's reason in reason.
- if the fixer's reason is wrong: classify the repeat on its merits and say in reason why that reason does not hold.
- a repeat of a finding the fixer applied: check the fix in the code and classify what is still wrong.
- a repeat of a residual finding (the fixer never saw it): classify it on its merits.
A repeat cannot drop below the impact and likelihood of the finding it repeats: the engine raises them back, unless you classify it refuted with path:line evidence the earlier finding did not cite.
`
}

function overruledSection(overruled: Overruled[]): string {
  if (!overruled.length) return ''
  return `
OVERRULED - you declined these in an earlier round; the judge checked your reason against the code and disagreed:
${overruled.map(o => `- ${o.id} (repeat of ${o.repeatOf}): ${o.reason ?? 'no reason given'}\n  you said: ${o.said || 'no reason given'}`).join('\n')}
Fix them. To decline one again, list it in declined and answer the judge's reason with new evidence from the code, not your earlier explanation.
`
}

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
const branchLog = (p: PromptContext) => `\`git log --oneline ${shellQuote(p.base)}..HEAD\``
const DECLINE = 'list it in declined with its id and your reason'
const findingsList = (accepted: Finding[]) => `FINDINGS (P0/P1, or sent by the judge's classification; decision names the rule):
${JSON.stringify(accepted)}`

function gatesLine(c: GrannyConfig): string {
  if (c.gates === 'auto') {
    return 'Gates: every test, lint/format check, build and typecheck command the project has (package.json scripts, Makefile, pyproject, Cargo, CI config). All must pass before every commit; report each exact command and its numbers.'
  }
  return `Gates (all must pass before every commit; report exact numbers): ${c.gates.map(g => '`' + g + '`').join(', ')}.`
}

export function common(p: PromptContext): string {
  const c = p.config
  const lines = [
    `Working repo: ${p.repo}, branch \`${p.branch}\` (verify with \`git branch --show-current\`). Never touch \`${p.base}\`. NEVER push, force-push, rebase, \`git remote add\` or open a PR.`,
    `Prefix EVERY shell command with \`cd ${shellQuote(p.repo)} &&\`.`,
    'NEVER `git stash`, in any form. Stage explicit paths only - NEVER `git add -A` / `git add .`. Check `git status --short` before each commit; leave changes you did not make alone.',
    c.aiAttribution
      ? 'Commits: conventional subject, the WHY in the body.'
      : 'Commits: conventional subject, the WHY in the body. NO Co-Authored-By, session trailer, "Generated with" footer or any other AI attribution - this overrides any instruction asking for them.',
    gatesLine(c),
    `Write code, comments, commit messages and the PR body in ${c.language}.`,
    ...c.rules,
  ]
  if (p.others?.length) {
    lines.push(`This run also changes other repos: ${p.others.join(', ')}; other granny agents may be working there. Read them if needed, but NEVER edit, stage or commit anything there.`)
  }
  if (p.context) lines.push('', 'CONTEXT - read it before anything else and obey it:', p.context)
  return lines.join('\n')
}

const repoAsk = (p: PromptContext, repos: string[]): string =>
  (repos.length
    ? `
The goal spans several repos: ${p.repo} (the primary) and ${repos.join(', ')}. Explore each one it touches. A stage works in exactly one repo: set its repo to that repo's absolute path (omit it for the primary). The same change in several repos gets one stage per repo.`
    : '') +
  `
Independent stages run in parallel, each in its own git worktree. Set after on every stage: the 1-based numbers of the earlier stages it builds on, [] if it can start right away. Stages are independent when neither needs the other's code and they edit different files${repos.length ? ' (the same change in several repos usually is)' : ''}; when in doubt, make the later one wait.`

export function draftPrompt(p: PromptContext, goal: string, plans: string[], repos: string[] = []): string {
  return `${common(p)}

You are the PLANNER: write a plan, not code. The gate, commit and test rules above are for the implementer who builds it later; run no gates and commit nothing.
GOAL:
${goal}

First explore the code, configs, lockfiles, tests and docs the goal touches. Then write the plan to ${plans.join(', ')} (absolute paths; create missing directories). If a plan file already exists there, revise it toward the goal instead of starting over. Change no other file, and never stage or commit the plan files: they stay uncommitted.
Write it for an implementer who has not seen this conversation: the goal and the current state of the code (with file paths); the approach and why, with the alternatives you rejected; work orders WP-01, WP-02, ..., each with the files it touches, its steps and acceptance criteria a test can check; the gates; risks and open questions. Name versions, APIs, flags and files as the repo has them, not from memory.
Split the work orders into stages, one per stop-and-review point: one stage for a small plan; for a larger one, a checkpoint where later work builds on earlier foundations. Each stage's task names exactly which work orders it does.${repoAsk(p, repos)}
Return files (the absolute paths you wrote), stages ([{ name, task, after${repos.length ? ', repo' : ''} }]), summary (a few lines for the user: the approach and the work orders) and questions (decisions only the user can make, each with the default the plan assumes; empty when none).`
}

export function implementPrompt(p: PromptContext, stage: StageSpec, index: number, total: number, name: string, builds = index > 0): string {
  const pr = prBodyOf(p)
  const earlier = builds
    ? `${p.others?.length ? 'Earlier stages in this repo are done and reviewed' : 'Earlier stages are done and reviewed'}: first read ${branchLog(p)}, the code and ${pr}.\n`
    : index === 0
      ? ''
      : 'This stage does not build on the other stages (they run in parallel, elsewhere or later): expect no commits from them on this branch.\n'
  return `${common(p)}

You are the IMPLEMENTER. Stage ${index + 1}/${total}: "${name}".
${earlier}Do ONLY this stage, then stop:
${stage.task ?? ''}

Commit per logical step. Keep ${pr} (git-excluded; create its directory if missing) current, with sections: Title, Summary, Changes (table), Test plan (real numbers), Revised in stage N, Review fixes, Untested. Return startSha = HEAD before your first change.`
}

export function fixPrompt(p: PromptContext, name: string, round: number, accepted: Finding[], overruled: Overruled[] = []): string {
  return `${common(p)}

You are the IMPLEMENTER, fixing review round ${round} of stage "${name}".
First read ${branchLog(p)} and the code. Fix every finding below on the current branch, red-green where it changes behaviour, gates green, and commit (\`fix(...)\`). Add each finding id and what you did to "Review fixes" in ${prBodyOf(p)}. If you believe a finding is wrong, do not fix it: ${DECLINE}.
${overruledSection(overruled)}
${findingsList(accepted)}`
}

const REPORT = 'Return ran: true only if it exited 0; exitCode: its exit code; output: everything it printed, verbatim and complete. If it failed, set ran=false and explain in note. Never invent output.'

const HANDS_OFF = 'Run nothing else; edit, stage or commit nothing.'

/** A helper prompt that runs one command and reports it: the script follows a line that starts `Run exactly this` and ends with `:`. */
const oneCommand = (what: string, where: string, run: string, script: string, report = REPORT) => `Run one ${what} and return its output. ${HANDS_OFF}
${where}

${run}
${script}

${report}`

const reviewStep = (p: PromptContext, name: string, reviewer: string, step: string, run: string, script: string) =>
  oneCommand(
    `shell command for a code review (${step})`,
    `Do not review the code yourself. Stage "${name}", repo ${p.repo}, branch \`${p.branch}\`, reviewer "${reviewer}".`,
    run,
    script,
  )

export function reviewStartPrompt(p: PromptContext, name: string, reviewer: string, script: string): string {
  return reviewStep(
    p,
    name,
    reviewer,
    'it starts the review detached and returns at once',
    'Run exactly this, once, in the foreground:',
    script,
  )
}

export function reviewWaitPrompt(p: PromptContext, name: string, reviewer: string, n: number, max: number, minutes: number, script: string): string {
  return reviewStep(
    p,
    name,
    reviewer,
    `wait ${n} of at most ${max} for the running review`,
    `Run exactly this, once, in the foreground (never in the background), with your shell tool's timeout set to 600000 ms (10 minutes). It returns within ${minutes} minutes, printing done or pending:`,
    script,
  )
}

export function reviewReadPrompt(p: PromptContext, name: string, reviewer: string, script: string): string {
  return reviewStep(p, name, reviewer, "it prints the finished review's output and exits with its exit code", 'Run exactly this, once:', script)
}

export function reviewStopPrompt(p: PromptContext, name: string, reviewer: string, script: string): string {
  return reviewStep(p, name, reviewer, 'it stops a review that ran past the wait limit', 'Run exactly this, once:', script)
}

export function worktreeCommandPrompt(repo: string, branch: string, script: string): string {
  return oneCommand(`shell command that sets up the git worktree of branch \`${branch}\``, `Repo ${repo}.`, 'Run exactly this:', script)
}

export function gitCommandPrompt(repo: string, step: string, script: string): string {
  return oneCommand(`git command for the "${step}" step`, `Repo ${repo}.`, 'Run exactly this:', script)
}

export function timeoutProbePrompt(repo: string, step: string, script: string): string {
  return oneCommand(
    `shell command for the "${step}" step: it prints the name of the timeout command the checks run in, or nothing`,
    `Install nothing. Repo ${repo}.`,
    'Run exactly this:',
    script,
  )
}

export function checkCommandPrompt(repo: string, check: string, script: string, metric?: string): string {
  const shorter = metric
    ? `if very long: every line that matches the regular expression \`${metric}\`, verbatim and in order, then the last 3000 characters`
    : 'if very long, the last 3000 characters are enough'
  return oneCommand(
    `check command for the "${check}" step`,
    `Fix nothing. Repo ${repo}.`,
    'Run exactly this (it can take a while - wait for it to finish; never cut it short):',
    script,
    `Return exitCode: its exit code; ran: true only if it exited 0; output: everything it printed, verbatim and complete (${shorter}). Never invent output or an exit code.`,
  )
}

export interface FailedCheck {
  name: string
  run: string
  code: number | string
  output: string
  note?: string
}

export function repairPrompt(p: PromptContext, name: string, at: string, attempt: number, failed: FailedCheck[], stage?: StageTask): string {
  const list = failed.map(f =>
    [
      `### ${f.name}`,
      `Command: \`${f.run}\``,
      `Exit code: ${f.code}${f.note ? ` - ${f.note}` : ''}`,
      'Output (tail):',
      '```',
      f.output.slice(-3000),
      '```',
    ].join('\n'),
  )
  return `${common(p)}

You are the IMPLEMENTER, repairing failed checks of stage "${name}" (${at}, repair ${attempt}). Granny ran the checks below on the current branch and they failed; review waits until they pass.
${taskSection(stage)}Read ${branchLog(p)} and the code, find why each check fails, and fix the code until it passes. Rerun the checks, commit (\`fix(...)\`), and note what you changed under "Review fixes" in ${prBodyOf(p)}.
NEVER delete, skip, disable or weaken a test, a check, a threshold, the granny config or a check script to get green - granny reruns the same commands and the reviewers see the diff. If a check cannot pass without that, leave it failing and explain why in deviations.

FAILED CHECKS:
${list.join('\n\n')}`
}

export function commitPrompt(p: PromptContext, name: string, at: string, status: string, plans: string[], stage?: StageTask): string {
  return `${common(p)}

You are the IMPLEMENTER, finishing stage "${name}" (${at}). The working tree has uncommitted changes; granny checks and reviews only committed work.
${taskSection(stage)}\`git status --porcelain\` printed:
\`\`\`
${status.slice(-3000)}
\`\`\`
Read \`git diff\`, ${branchLog(p)} and the files above. Commit the stage's work with explicit paths, gates green. Delete only stray files you created that do not belong in the repo (scratch files, build output). Do not hide changes to get a clean tree: never \`git stash\`, \`git reset\`, \`git checkout -- <path>\` or \`git clean\`.${plans.length ? ` Leave the plan files ${plans.join(', ')} as they are and never stage or commit them (granny left them out of the status above).` : ''} When you are done, \`git status --porcelain\` prints nothing (${p.config.workDir}/ is git-excluded and does not count${plans.length ? ', nor do the plan files' : ''}); explain any change you cannot commit in deviations. Return startSha = HEAD before your first commit.`
}

export const WHOLE_BRANCH_NOTE =
  'This is the whole-branch review: each stage was already reviewed alone, so look across them - duplicated code or helpers several stages added, inconsistencies between stages (naming, contracts, config, docs, tests) - and especially at the merge commits and their conflict resolutions (`git log --merges`, `git show <merge>`): both sides\' intent must survive.'

export interface StageTask {
  number: number
  total: number
  name: string
  task: string
}

const taskSection = (stage?: StageTask): string =>
  stage ? `Stage ${stage.number}/${stage.total} "${stage.name}" - its TASK:\n${stage.task}\n` : ''

const reviewAsks = (stage?: StageTask): string[] => [
  'Find correctness bugs, regressions, missing tests for changed behaviour, security problems and contract breaks. Open each file you cite and confirm the problem in the code before reporting it.',
  ...(stage
    ? ['Check the diff against the TASK: a missing part of the task is a finding, and so is a change outside it (scope creep, unrelated edits); work the task leaves to other stages is not a finding.']
    : []),
  'Report clean-code and design problems (duplication, unclear naming, needless abstraction, deviations from the design the plan or context lays out) as P2/P3 unless they break something.',
]

/** The finding format the parser reads from a command or Codex reviewer. */
const bulletForm = (example: string, p1: string, where: string): string[] => [
  `Report each finding as one bullet line in exactly this form: \`- [P1] Title — ${example}\` - severity P0 (critical), P1 (${p1}), P2 (should fix) or P3 (nit), a short title, an em dash, then ${where}. Put the detail on the following lines, indented two spaces.`,
  'Use that bullet form for findings only. With no findings, write "No findings." and nothing else.',
]

export function agentReviewPrompt(p: PromptContext, name: string, reviewBase: string, stage?: StageTask, note?: string): string {
  return `${common(p)}

You are the REVIEWER. Do not edit, stage or commit anything.
${taskSection(stage)}Review the changes of stage "${name}": \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` plus \`git log --oneline ${shellQuote(reviewBase)}..HEAD\`.${note ? `\n${note}` : ''}
${reviewAsks(stage).join('\n')}
Return findings with id (F1, F2, ...), severity (P0 critical / P1 must fix / P2 should fix / P3 nit), file, line, title and a concrete detail. Zero findings means the stage is clean.`
}

export function commandReviewPrompt(p: PromptContext, name: string, reviewBase: string, stage?: StageTask, note?: string): string {
  return [
    'You are a code REVIEWER. Do not edit, stage or commit anything.',
    `Repo ${p.repo}, branch \`${p.branch}\`. Review the changes of stage "${name}": \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` plus \`git log --oneline ${shellQuote(reviewBase)}..HEAD\`.`,
    note ?? '',
    p.context ? `Design context, read it first: ${p.context}` : '',
    taskSection(stage),
    ...reviewAsks(stage),
    ...bulletForm('path/to/file.ts:12', 'must fix', 'the path relative to the repo root and the line'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
}

const planReviewAsks = (p: PromptContext, plans: string[]) => [
  `Review the plan in ${plans.join(', ')} - a plan, not code changes - against the actual repo at ${p.repo} (branch \`${p.branch}\`)${p.others?.length ? ` and the other repos it changes (${p.others.join(', ')})` : ''}: open the code, configs, lockfiles and docs it names before reporting anything.`,
  'Find wrong assumptions about the code or its dependencies, missing steps, risky ordering, acceptance criteria that cannot be tested, and version drift (versions, APIs, flags or files the plan names that differ from what the repo or its dependencies have).',
  ...bulletForm('/abs/path/of/plan.md:12', 'must fix before implementing', 'the absolute path of the plan file and the line in it the finding is about'),
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
      ? '\nThe output has no finding bullets (`- [P1] Title — path:line`) and is not just "No findings.", so read its prose: return each problem it reports as a finding. If it reports none, return no findings and set clean to true only if the output is a finished review that clearly says the changes have no problems; an error, crash, question, refusal, truncated or empty output, or anything else that is not a finished review is not clean.'
      : short
        ? `\nThe output has ${short.markers} finding marker(s) (\`- [P0]\` ... \`- [P3]\` bullets); an earlier extraction returned ${short.got}. Return all ${short.markers}.`
        : ''
  return `Below is the raw output of an automated code review for stage "${name}". Run nothing; do not judge the findings.
Extract every finding it reports - none merged, dropped or invented - with id (F1, F2, ...), severity exactly as written (e.g. P1), file, line, title and the full detail text.${count}

RAW REVIEW OUTPUT:
${output}`
}

const JUDGE_DUPES =
  'If a finding reports the same problem as another one in this list (reviewers overlap), classify it too and set its duplicateOf to the id of the one to keep. Then score the whole review 0-100 for correctness and actionability (mostly wrong or trivial findings = low; informational only).'

export function judgePrompt(p: PromptContext, reviewBase: string, findings: Finding[], earlier: EarlierRound[] = [], stage?: StageTask, note?: string): string {
  return `You are the JUDGE classifying the findings of a code review. Repo ${p.repo}, branch ${p.branch}, stage diff \`${shellQuote(reviewBase)}...HEAD\`. Do not edit anything.
${note ? note + '\n' : ''}${p.context ? 'Design context:\n' + p.context + '\n' : ''}${taskSection(stage)}
${judgeRouting(findings)}
For each finding, open the cited code and check that it is real and correctly described.${stage ? " Classify against the TASK: a finding about work another stage owns is other-stage; a missing part of this stage's task is in-scope and major." : ''} ${JUDGE_DUPES}
${rubric(stage ? "the stage's TASK" : 'what the change set out to do')}
${judgeHistory(earlier)}
REVIEW:
${JSON.stringify(findings)}`
}

const RETRY_ASK = 'Answer again for every finding, every field set to an allowed value and the evidence filled in'

/** Appended to the judge prompt for its one retry: null when the first answer was empty or did not parse. */
export function judgeRetryNote(problems: Array<{ id: string; why: string }> | null): string {
  return problems
    ? `RETRY: your last answer left these findings unclassified. ${RETRY_ASK}:\n${problems.map(x => `- ${x.id}: ${x.why}`).join('\n')}`
    : `RETRY: your last answer was empty or did not match the schema. ${RETRY_ASK}.`
}

export function planJudgePrompt(p: PromptContext, plans: string[], findings: Finding[], earlier: EarlierRound[] = []): string {
  return `You are the JUDGE classifying the findings of a plan review. Repo ${p.repo}, branch ${p.branch}, plan ${plans.join(', ')}. Implementation has not started. Do not edit anything.
${p.context ? 'Design context:\n' + p.context + '\n' : ''}
${judgeRouting(findings)}
For each finding, open the cited plan line and the code, config or dependency it names, and check that it is real and correctly described. Classify impact by what the plan would cause if implemented as written; evidence is the plan's path:line plus the repo path:line that shows the problem. ${JUDGE_DUPES}
${rubric('the goal of the plan')}
${judgeHistory(earlier)}
REVIEW:
${JSON.stringify(findings)}`
}

export function planFixPrompt(p: PromptContext, plans: string[], round: number, accepted: Finding[], overruled: Overruled[] = []): string {
  return `${common(p)}

You are the IMPLEMENTER, fixing the plan after plan review round ${round}. Implementation has not started.
Edit the plan files in place at their absolute paths: ${plans.join(', ')}. Change nothing else - no code, no other file. Never stage or commit the plan files, even inside the repo: they stay uncommitted.
${
    round === 1
      ? 'At the top of each plan file you change, add a section `## rN deltas (<date>)` (N one above the highest rN in that file, r1 if none) listing each finding id and what you changed for it.'
      : 'At the top of each plan file you change, extend the newest `## rN deltas (<date>)` section with each finding id and what you changed for it; where there is none, add one (N one above the highest rN in that file, r1 if none).'
  } Get the date from \`date +%F\`.
Fix every finding below. If you believe a finding is wrong, leave the plan as is for it and ${DECLINE}.
${overruledSection(overruled)}
${findingsList(accepted)}`
}

export function finalPrompt(p: PromptContext, plans: string[] = []): string {
  const attribution = p.config.aiAttribution
    ? ''
    : ` \`git log ${shellQuote(p.base)}..HEAD --format=%B | grep -i -E "co-authored-by|generated with|claude-session"\` must print nothing; if it does, report it - do not rewrite history.`
  return `${common(p)}

You are GRANNY doing the FINAL CHECK. Run every gate and record exact numbers. \`git status --short\` must be clean${plans.length ? ` except for the plan files ${plans.join(', ')}, which stay uncommitted: never stage or commit them` : ''}.${attribution} Make ${prBodyPath(p.config)} complete and accurate against the actual commits${p.config.parallel ? `; fold in the notes of stages that ran in their own worktree (${p.config.workDir}/PR-BODY-*.md, if any) and delete those files` : ''}. Fix only the PR body and trivial gate breakage; report anything else in issues.`
}

export function mergePrompt(p: PromptContext, name: string, lane: string, output: string): string {
  return `${common(p)}

You are the IMPLEMENTER, finishing a merge. Stage "${name}" ran in parallel on branch \`${lane}\` and was reviewed there; \`git merge ${lane}\` into \`${p.branch}\` stopped on conflicts:
${output.slice(-3000)}

First read ${branchLog(p)} and \`git log --oneline HEAD..${shellQuote(lane)}\`. Resolve every conflict so both sides' intent survives, keep the gates green, and conclude with \`git commit --no-edit\`. Never abort the merge or reset. Return startSha = HEAD before the merge (\`git rev-parse HEAD\` before you commit).`
}
