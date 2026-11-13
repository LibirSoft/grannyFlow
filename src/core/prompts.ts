import type { GrannyConfig } from './config'
import { isBlocker } from './review'
import { shellQuote } from './shell'
import type { Declined, Finding, PlanResult, StageResult, StageSpec } from './types'

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

const rubric = (task: string) => `Classify every finding with exactly these fields:
- verdict: confirmed (the code shows the problem) | refuted (the code shows it is absent or not a problem) | unverified (you cannot tell either way).
- impact, how bad IF it triggers: critical | major | moderate | minor | none.
  Judge impact assuming the trigger happens. Likelihood never lowers impact; it is its own field: a narrow window, a forced input or "the caller can retry" count there, not here.
  Take the first class that fits, from the top:
  - critical: data or money lost, corrupted or given to the wrong party; writing to the wrong record; security or authorization bypass; secret or personal data leak; a draft going public; an irreversible operation; stored data silently read differently.
  - major, any of:
    - something stays wrong after the trigger until someone repairs it by hand: a record others rely on (audit trail, ledger, export, log, notification) that is missing, duplicated or false; work the system accepted or owes that is stuck, dropped or refused for good; two stores that disagree.
    - a well-formed request or a job fails where it should succeed: a crash, a 5xx, a hang, a lock only a reload clears, endless loading; or input anyone can send takes the service down or exhausts it.
    - a call reports success without having done what was asked.
    - something that worked before the change silently breaks; an API or contract break; an existing test edited or removed so that the change passes.
    - a required part of ${task} is missing.
  - moderate: one call gives a wrong result and nothing stays wrong: a wrong status code, error message or figure that a retry or the next read gets right; odd or malformed input refused more strictly than documented. Also upkeep, which breaks nothing today and lets a defect through later: a missing or hollow test for changed behaviour, duplicated logic, user docs that describe behaviour the code does not have, a problem that needs a future code change to appear.
  - minor: no effect on behaviour: visual defect, naming, style, wording, a wrong comment, where a file or test lives, dead code.
  - none: not a problem.
- likelihood: common (the normal flow) | edge (special timing or state: a race, a retry, an expired session, a boundary value, a dependency that fails) | rare (forced or malformed input, a rarely used feature). Upkeep has no trigger: use edge.
- fixCost: trivial (a few lines) | small (one function or file plus a test) | large (cross-module, a redesign).
- scope: in-scope | pre-existing (there before this change, and the change neither causes it nor opens a new way to reach it) | other-stage (another stage's job).
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

const AUTO_GATES = 'every test, lint/format check, build and typecheck command the project has (package.json scripts, Makefile, pyproject, Cargo, CI config)'
const gateList = (c: GrannyConfig) => (c.gates === 'auto' ? AUTO_GATES : c.gates.map(g => '`' + g + '`').join(', '))

function gatesLine(c: GrannyConfig): string {
  if (c.gates === 'auto') return `Gates: ${AUTO_GATES}. All must pass before every commit; report each exact command and its numbers.`
  return `Gates (all must pass before every commit; report exact numbers): ${gateList(c)}.`
}

const repoLine = (p: PromptContext) => `Working repo: ${p.repo}, branch \`${p.branch}\` (verify with \`git branch --show-current\`).`
const cdLine = (p: PromptContext) => `Prefix EVERY shell command with \`cd ${shellQuote(p.repo)} &&\`.`

/** What every agent prompt ends its header with: the language of what it writes, the user's rules, the other repos and the run's CONTEXT. */
function headerTail(p: PromptContext, writes: string, others: (repos: string) => string): string[] {
  const lines = [`Write ${writes} in ${p.config.language}.`, ...p.config.rules]
  if (p.others?.length) lines.push(others(p.others.join(', ')))
  if (p.context) lines.push('', 'CONTEXT - read it before anything else and obey it:', p.context)
  return lines
}

/** The header of every agent that edits, stages or commits: the workspace plus the git, commit and gate rules. */
export function common(p: PromptContext): string {
  const c = p.config
  return [
    `${repoLine(p)} Never touch \`${p.base}\`. NEVER push, force-push, rebase, \`git remote add\` or open a PR.`,
    cdLine(p),
    'NEVER `git stash`, in any form. Stage explicit paths only - NEVER `git add -A` / `git add .`. Check `git status --short` before each commit; leave changes you did not make alone.',
    c.aiAttribution
      ? 'Commits: conventional subject, the WHY in the body.'
      : 'Commits: conventional subject, the WHY in the body. NO Co-Authored-By, session trailer, "Generated with" footer or any other AI attribution - this overrides any instruction asking for them.',
    gatesLine(c),
    ...headerTail(p, 'code, comments, commit messages and the PR body', repos => `This run also changes other repos: ${repos}; other granny agents may be working there. Read them if needed, but NEVER edit, stage or commit anything there.`),
  ].join('\n')
}

/** The header of an agent that commits nothing (the agent reviewers and the planner): the workspace without the git, commit and gate rules. */
export function readOnlyHeader(p: PromptContext, writes: string, extra: string[] = []): string {
  return [repoLine(p), cdLine(p), ...extra, ...headerTail(p, writes, repos => `This run also changes other repos: ${repos}; read them if needed.`)].join('\n')
}

const repoAsk = (p: PromptContext, repos: string[]): string =>
  (repos.length
    ? `
The goal spans several repos: ${p.repo} (the primary) and ${repos.join(', ')}. Explore each one it touches. A stage works in exactly one repo: set its repo to that repo's absolute path (omit it for the primary). The same change in several repos gets one stage per repo.`
    : '') +
  `
Independent stages run in parallel, each in its own git worktree. Set after on every stage: the 1-based numbers of the earlier stages it builds on, [] if it can start right away. Stages are independent when neither needs the other's code and they edit different files${repos.length ? ' (the same change in several repos usually is)' : ''}; when in doubt, make the later one wait.`

const PLANNER_STEPS = `Each step of a stage is built by its own implementer agent, which has not seen the other steps' conversations and knows only the plan, the branch and its step's task. Split every stage into steps, one per logical commit point: a change that builds, passes the gates and is committed on its own, in the order they must land. A step's task names its work orders or the part of one, the files to read first, the files it changes and the acceptance criteria a test can check, and it never needs code a later step writes. A stage that is one commit gets one step.`

export function draftPrompt(p: PromptContext, goal: string, plans: string[], repos: string[] = []): string {
  return `${readOnlyHeader(p, 'the plan', [`The implementer's gates: ${gateList(p.config)}; all must pass before every commit.`])}

You are the PLANNER: write a plan, not code. Run no gates and commit nothing.
GOAL:
${goal}

First explore the code, configs, lockfiles, tests and docs the goal touches. Then write the plan to ${plans.join(', ')} (absolute paths; create missing directories). If a plan file already exists there, revise it toward the goal instead of starting over. Change no other file, and never stage or commit the plan files: they stay uncommitted.
Write it for an implementer who has not seen this conversation: the goal and the current state of the code (with file paths); the approach and why, with the alternatives you rejected; work orders WP-01, WP-02, ..., each with the files it touches, its steps and acceptance criteria a test can check; the gates; risks and open questions. Name versions, APIs, flags and files as the repo has them, not from memory.
Split the work orders into stages, one per stop-and-review point: one stage for a small plan; for a larger one, a checkpoint where later work builds on earlier foundations. Each stage's task names exactly which work orders it does.${repoAsk(p, repos)}${p.config.stepAgents ? `\n${PLANNER_STEPS}` : ''}
Return files (the absolute paths you wrote), stages ([{ name, task, after${repos.length ? ', repo' : ''}${p.config.stepAgents ? ', steps' : ''} }]), summary (a few lines for the user: the approach and the work orders) and questions (decisions only the user can make, each with the default the plan assumes; empty when none).`
}

/** How the implementer works: few round trips, and the three places where a first version usually goes wrong. */
const BUILD_METHOD = `How to build it:
1. Work in few, large steps: every round trip costs. Read the task, the code you will change and the code that will meet yours without being changed (whatever reads the data you write, calls what you alter, logs it, or runs beside it) in one or two commands. Take the work orders or logical steps one at a time: write all the files and tests of one in one command, run the gates and commit it in the next, then start the following one - a stage with several of them is never one commit. Do not re-read what you already have, and do not run a gate twice on the same tree.
2. Every input you add (a body field, header, query, argument, file, setting): decide what is valid and refuse the rest where it enters - the wrong type, a value the parser accepts but that means something else, the far ends of its range.
3. Everything that can run twice, beside itself or beside a request (a job, a retry, a second process): act only on state read in the same transaction, decide what a crash between two steps leaves behind, and let one bad item fail alone.
4. Every failure path: what is stored and what the caller is told must agree with what really happened.
5. Where the task is silent, do what the nearest existing code does, and note the choice.`

/** The name a step is shown by: its own, or `step <k>` (1-based) when it has none. */
export const stepName = (step: { name?: string }, k: number): string => step.name ?? `step ${k + 1}`

/** The line on the earlier stages; `withSteps`, for a step after the first, joins the earlier steps of the stage into the same read. */
function earlierLine(p: PromptContext, index: number, builds: boolean, withSteps = false): string {
  if (builds) return `${p.others?.length ? 'Earlier stages in this repo are done and reviewed' : 'Earlier stages are done and reviewed'}${withSteps ? ', and the earlier steps of this stage are committed by other agents' : ''}: first read ${branchLog(p)}, the code and ${prBodyOf(p)}.\n`
  return index === 0 ? '' : 'This stage does not build on the other stages (they run in parallel, elsewhere or later): expect no commits from them on this branch.\n'
}

function prBodyInstruction(p: PromptContext, unit: 'stage' | 'step'): string {
  const whose = unit === 'stage' ? "the stage's" : "this step's"
  return `When ${whose} code is committed, bring ${prBodyOf(p)} up to date in one edit (git-excluded; create its directory if missing), with sections: Title, Summary, Changes (table), Test plan (real numbers), Revised in stage N, Review fixes, Untested. Return startSha = HEAD before your first change.`
}

export function implementPrompt(p: PromptContext, stage: StageSpec, index: number, total: number, name: string, builds = index > 0): string {
  const steps = stage.steps?.length ? `\n\nIts steps, in this order - commit each one before you start the next:\n${stage.steps.map((s, k) => `${k + 1}. ${stepName(s, k)}: ${s.task}`).join('\n')}` : ''
  return `${common(p)}

You are the IMPLEMENTER. Stage ${index + 1}/${total}: "${name}".
${earlierLine(p, index, builds)}Do ONLY this stage, then stop:
${stage.task ?? ''}${steps}

${BUILD_METHOD}

${prBodyInstruction(p, 'stage')}`
}

/** One step of a stage with stepAgents on: its own agent, which sees the other steps by name only. `k` is the step's 0-based index. */
export function implementStepPrompt(p: PromptContext, stage: StageSpec, index: number, total: number, name: string, k: number, builds = index > 0): string {
  const steps = stage.steps ?? []
  const step = steps[k]
  const pr = prBodyOf(p)
  const earlierSteps = `The earlier steps of this stage are committed by other agents: first read ${branchLog(p)}, the code and ${pr}.\n`
  const earlier = builds ? earlierLine(p, index, true, k > 0) : `${earlierLine(p, index, false)}${k === 0 ? '' : earlierSteps}`
  const order = steps.map((s, j) => `${j + 1}. ${stepName(s, j)}${j === k ? ' (yours)' : ''}`).join(', ')
  return `${common(p)}

You are the IMPLEMENTER. Stage ${index + 1}/${total}: "${name}", step ${k + 1} of ${steps.length}: "${stepName(step!, k)}".
${earlier}The steps of this stage are built by one agent each, in this order: ${order}.
Do ONLY step ${k + 1}, then stop; the other steps are other agents' work:
${step!.task}
If the branch log shows this step is already committed, change nothing and say so in deviations.

${BUILD_METHOD}

${prBodyInstruction(p, 'step')}`
}

export function fixPrompt(p: PromptContext, name: string, round: number, accepted: Finding[], overruled: Overruled[] = []): string {
  return `${common(p)}

You are the IMPLEMENTER, fixing review round ${round} of stage "${name}".
First read ${branchLog(p)} and the code. Fix every finding below on the current branch, red-green where it changes behaviour, gates green, and commit (\`fix(...)\`). Add each finding id and what you did to "Review fixes" in ${prBodyOf(p)} (git-excluded: never stage or commit it). If you believe a finding is wrong, do not fix it: ${DECLINE}.
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

export const ONE_SHOT_NOTE = 'This is a one-shot review: nobody fixes anything in this run, so report every problem you can confirm in the code.'

export function judgeStepPrompt(repo: string, step: string, script: string): string {
  return oneCommand(`shell command for the "${step}" step of a review-only run`, `Repo ${repo}.`, 'Run exactly this:', script)
}

const VERBATIM = 'Run exactly this, as one command with its line breaks and every character kept, down to its last line:'

export function reportWritePrompt(repo: string, step: string, script: string): string {
  return oneCommand(`shell command for the "${step}" step of a review-only run, which saves the review report (the one file this run writes),`, `Repo ${repo}.`, VERBATIM, script)
}

export function reviewSavePrompt(repo: string, step: string, script: string): string {
  return oneCommand(`shell command for the "${step}" step, which saves a reviewer's answer to its review file under the work dir (the one file this step writes),`, `Do not review the code yourself. Repo ${repo}.`, VERBATIM, script)
}

export function trailWritePrompt(repo: string, step: string, script: string): string {
  return oneCommand(
    `shell command for the "${step}" step, which saves or checks the record of one review round in the run's work dir,`,
    `Repo ${repo}.`,
    VERBATIM,
    script,
  )
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
${taskSection(stage)}Read ${branchLog(p)} and the code, find why each check fails, and fix the code until it passes. Rerun the checks, commit (\`fix(...)\`), and note what you changed under "Review fixes" in ${prBodyOf(p)} (git-excluded: never stage or commit it).
NEVER delete, skip, disable or weaken a test, a check, a threshold, the granny config or a check script to get green - granny reruns the same commands and the reviewers see the diff. If a check cannot pass without that, leave it failing and explain why in deviations.

FAILED CHECKS:
${list.join('\n\n')}`
}

export function commitPrompt(p: PromptContext, name: string, at: string, status: string, plans: string[], stage?: StageTask, step?: StageTask): string {
  const opening = step
    ? `You are the IMPLEMENTER, after step ${step.number}/${step.total} ("${step.name}") of stage "${name}". The working tree has uncommitted changes; granny checks and reviews only committed work.`
    : `You are the IMPLEMENTER, finishing stage "${name}" (${at}). The working tree has uncommitted changes; granny checks and reviews only committed work.`
  const commit = step
    ? "Commit this step's work with explicit paths, gates green. Build nothing of the later steps: other agents do them."
    : "Commit the stage's work with explicit paths, gates green."
  return `${common(p)}

${opening}
${step ? taskSection(step, 'Step') : taskSection(stage)}\`git status --porcelain\` printed:
\`\`\`
${status.slice(-3000)}
\`\`\`
Read \`git diff\`, ${branchLog(p)} and the files above. ${commit} Delete only stray files you created that do not belong in the repo (scratch files, build output). Do not hide changes to get a clean tree: never \`git stash\`, \`git reset\`, \`git checkout -- <path>\` or \`git clean\`.${plans.length ? ` Leave the plan files ${plans.join(', ')} as they are and never stage or commit them (granny left them out of the status above).` : ''} When you are done, \`git status --porcelain\` prints nothing (${p.config.workDir}/ is git-excluded and does not count${plans.length ? ', nor do the plan files' : ''}); explain any change you cannot commit in deviations. Return startSha = HEAD before your first commit.`
}

export const WHOLE_BRANCH_NOTE =
  'This is the whole-branch review: each stage was already reviewed alone, so look across them - duplicated code or helpers several stages added, inconsistencies between stages (naming, contracts, config, docs, tests) - and especially at the merge commits and their conflict resolutions (`git log --merges`, `git show <merge>`): both sides\' intent must survive.'

export interface StageTask {
  number: number
  total: number
  name: string
  task: string
}

const taskSection = (stage?: StageTask, unit = 'Stage'): string =>
  stage ? `${unit} ${stage.number}/${stage.total} "${stage.name}" - its TASK:\n${stage.task}\n` : ''

const reviewAsks = (stage: StageTask | undefined, base: string): string[] => [
  'Review it the way a careful senior engineer would, in this order. Take the time it needs: a problem missed here ships.',
  '1. What the change promises. Read the commit messages and every doc, comment and test name the change adds or edits. List for yourself each behaviour, rule, limit, number and worked example they state.',
  '2. Promise against code. For each item on that list, find the code that is meant to do it and follow it to the end. Where the docs give a number or an example, compute what the code actually returns for it. A promise the code does not keep is a finding; so is one it keeps only on the path the tests take.',
  ...(stage
    ? ['Check the diff against the TASK in the same way: a missing part of the task is a finding, and so is a change outside it (scope creep, unrelated edits); work the task leaves to other stages is not a finding.']
    : []),
  '3. Every changed file, top to bottom. For each new or changed function ask what happens with: a missing or unknown id, a null, an empty or huge value, a boundary value, a value in another unit or scale, text with separators, quotes or line breaks, the same call or the same message arriving twice, calls arriving out of order, a failure halfway through, the end of a month or a day. Check who is allowed to call it, and whether that check is made on the right party and the right record.',
  `4. Code that was moved or rewritten. When a commit moves code or says it changes no behaviour, compare the old version (\`git show ${base}:<path>\`) with the new one line by line. A check, a branch or a default that did not come along is a finding.`,
  '5. Beyond the diff. For everything the change renames, removes or gives a new meaning (a function, a type, a column, a route, a config key, a stored value), search the repo for what still uses it. Read the untouched code the new code calls or relies on, and the untouched code that reads what the new code writes: does it still hold when the new code feeds it new values? A problem the change causes in a file it does not touch is a finding: cite that file and line.',
  '6. The tests. For each new test ask whether it could fail if the code were wrong: an expectation computed with the same formula as the code, an assertion on a side effect instead of the result, only the happy path. Name the promised behaviours that no test would catch breaking.',
  '7. Small things last: a name that breaks the convention of its file or schema, leftovers (debug output, TODOs, commented-out code), a constant that is defined and not used, duplication, needless abstraction, a deviation from the design the plan or context lays out.',
  'Before you report a finding, open the code and confirm it; when it is cheap, run it (an existing test, or a one-line command that writes no file) instead of reasoning about it. Before you say something is missing - a test, a check, a doc line - search for it. Do not report what you could not confirm. Give each problem its own finding: do not fold two into one, and do not report one twice.',
  'Severity is what happens when the problem triggers; how rarely it triggers does not lower it.',
  '- P0: data loss or corruption, money or records written wrong, a security or authorization bypass, a leaked secret. A check that guards money, access or data and no longer runs is a bypass, also when it went missing in a refactor.',
  '- P1: something that worked before breaks, a crash, a broken contract, a required part of the change that is missing or does not work.',
  '- P2: wrong behaviour with an easy workaround, a wrong or missing error, a missing test for changed behaviour, duplicated logic.',
  '- P3: naming, style, leftovers. What step 7 finds is P3, or P2 for duplicated logic, unless it breaks something.',
]

/** The finding format the parser reads from a command or Codex reviewer. */
const bulletForm = (example: string, p1: string, where: string): string[] => [
  `Report each finding as one bullet line in exactly this form: \`- [P1] Title — ${example}\` - severity P0 (critical), P1 (${p1}), P2 (should fix) or P3 (nit), a short title, an em dash, then ${where}. Put the detail on the following lines, indented two spaces.`,
  'Use that bullet form for findings only. With no findings, write "No findings." and nothing else.',
]

const REVIEW_ASK =
  'Do a thorough code review: correctness bugs, regressions, security problems, data integrity, contract breaks, missing or wrong tests, and code quality. Report every problem you can confirm in the code.'

/** The places an agent reviewer goes back to once its first list is written; the project's rules come last, so they do not steer the first pass. */
function secondPass(p: PromptContext, base: string): string[] {
  const places = [
    'what the plan, the README, comments and test names promise, against what the code does, also on the paths the tests do not take',
    'every new or changed function with unusual input: missing, unknown, empty, huge, at a boundary, in another unit or scale, with separators, quotes or line breaks; the same call or message twice, calls out of order, a failure halfway through',
    'who may call it, and whether that is checked on the right party and the right record',
    `code that was moved or rewritten, against its old version (\`git show ${base}:<path>\`)`,
    'untouched code that calls what the change touched, or reads what it writes',
    'tests that could not fail if the code were wrong, and promised behaviour that no test covers',
  ]
  const rules = p.config.rules.length ? ["- the project's rules, as the author of the change was given them:", ...p.config.rules.map(rule => `  ${rule}`)] : []
  return [
    'When you have your list, you are not done: a first pass finds about half of what is there. Go through the change once more, this time place by place, looking only for problems that are not on your list yet, and add them:',
    ...places.map((place, i) => `- ${place}${i < places.length - 1 || rules.length ? ';' : '.'}`),
    ...rules,
  ]
}

/** What P0 to P3 mean for an agent reviewer; it follows the return line, so it labels the findings without steering the search for them. */
const SEVERITY_TIERS = [
  'Severity is what happens when the problem triggers; how rarely it triggers does not lower it.',
  '- P0: data loss or corruption, money or records written wrong, a security or authorization bypass, a leaked secret.',
  '- P1: something that worked before breaks, a crash, a broken contract, a required part of the change that is missing or does not work.',
  '- P2: wrong behaviour with an easy workaround, a wrong or missing error, a missing test for changed behaviour, duplicated logic.',
  '- P3: naming, style, leftovers.',
]

/**
 * The agent reviewer gets a short, open review request and then a second pass. Measured on frozen first versions of one plan
 * (Sonnet reviewer, known defects, blind scoring): a step list, the rules or a clean-stage sentence in front of the open request
 * each cost it known defects (21% raised with the step list, 47% with the open request alone); this form raised 48%.
 */
export function agentReviewPrompt(p: PromptContext, name: string, reviewBase: string, stage?: StageTask, note?: string): string {
  return [
    `Review a pull request. The repository is ${p.repo}, on branch \`${p.branch}\`; the base is \`${reviewBase}\`.`,
    ...(stage ? [`The change is stage ${stage.number}/${stage.total} "${name}" of a plan. The stage's task:\n${stage.task}`] : []),
    ...(p.context ? [`Context: ${p.context}`] : []),
    ...(p.others?.length ? [`This run also changes other repos: ${p.others.join(', ')}; read them if needed.`] : []),
    '',
    `Look at the changes with \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` and \`git log --oneline ${shellQuote(reviewBase)}..HEAD\`, and read any other file in the repository you need to judge them. Do not edit, create, stage or commit anything.`,
    ...(note ? [note] : []),
    '',
    REVIEW_ASK,
    ...(stage && stage.total > 1 ? ['Work the task leaves to other stages is not a finding.'] : []),
    ...secondPass(p, reviewBase),
    '',
    `Return findings with id (F1, F2, ...), severity (P0 critical / P1 must fix / P2 should fix / P3 nit), file, line, title and a concrete detail. Write them in ${p.config.language}.`,
    ...SEVERITY_TIERS,
  ].join('\n')
}

/** `inWorktree`: the reviewer already runs in the worktree and its bash rules refuse `cd` and quoted arguments (the opencode engine). */
export function commandReviewPrompt(p: PromptContext, name: string, reviewBase: string, stage?: StageTask, note?: string, inWorktree = false): string {
  const diff = inWorktree
    ? `, from the worktree you run in: \`git diff ${reviewBase}...HEAD\` plus \`git log --oneline ${reviewBase}..HEAD\``
    : `: \`cd ${shellQuote(p.repo)} && git diff ${shellQuote(reviewBase)}...HEAD\` plus \`git log --oneline ${shellQuote(reviewBase)}..HEAD\``
  return [
    'You are a code REVIEWER. Do not edit, stage or commit anything.',
    `Repo ${p.repo}, branch \`${p.branch}\`. Review the changes of stage "${name}"${diff}.`,
    note ?? '',
    p.context ? `Design context, read it first: ${p.context}` : '',
    taskSection(stage),
    ...reviewAsks(stage, reviewBase),
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
  return `${readOnlyHeader(p, 'your findings')}

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
  'If a finding reports the same problem as another one in this list (reviewers overlap), classify it too and set its duplicateOf to the id of the one to keep.'

export function judgePrompt(p: PromptContext, reviewBase: string, findings: Finding[], earlier: EarlierRound[] = [], stage?: StageTask, note?: string): string {
  return `You are the JUDGE classifying the findings of a code review. Repo ${p.repo}, branch ${p.branch}, ${note === WHOLE_BRANCH_NOTE ? 'branch' : 'stage'} diff \`${shellQuote(reviewBase)}...HEAD\`. Do not edit anything.
${note ? note + '\n' : ''}${p.context ? 'Design context:\n' + p.context + '\n' : ''}${taskSection(stage)}
${judgeRouting(findings)}
For each finding, open the cited code and check that it is real and correctly described.${stage ? " Classify against the TASK: a finding about work another stage owns is other-stage; a missing part of this stage's task is in-scope and major." : ''} ${JUDGE_DUPES}
${rubric(stage ? "the stage's TASK" : 'what the change set out to do')}
${judgeHistory(earlier)}
REVIEW:
${JSON.stringify(findings)}`
}

/** The judge of a `granny judge` run: nothing is routed or fixed, so its classification alone places every finding. */
export function tagPrompt(p: PromptContext, reviewBase: string, findings: Finding[]): string {
  return `You are the JUDGE tagging the findings of a one-shot code review. Repo ${p.repo}, branch ${p.branch}, diff \`${shellQuote(reviewBase)}...HEAD\`. Do not edit anything.
${p.context ? 'Design context:\n' + p.context + '\n' : ''}
Nobody fixes anything in this run. Your classification decides under which heading of the user's report each finding goes, so classify every finding on its merits: the reviewer's severity does not bind you, in either direction.
For each finding, open the cited code and check that it is real and correctly described. Use scope in-scope or pre-existing only. ${JUDGE_DUPES}
${rubric('what the change set out to do')}

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

/** How this run's reviews ended, for one repo's final check. */
export interface RunOutcomes {
  stages: StageResult[]
  finalReview?: PlanResult
  plan?: PlanResult
  reviewOnly: boolean
}

function outcomeLine(name: string, r: PlanResult): string {
  const listed = (kind: string, findings: Finding[]) => (findings.length ? `; ${kind}: ${findings.map(f => `${f.id} ${f.title.replace(/\s+/g, ' ').trim()}`).join(', ')}` : '')
  const note = r.note?.split('\n')[0]
  return `- ${name}: ${r.outcome}, ${r.rounds} review round(s)${listed('residual', r.residual)}${listed('unresolved', r.unresolved)}${note ? ` - ${note}` : ''}`
}

function outcomesList(o: RunOutcomes): string {
  return [
    ...(o.plan ? [outcomeLine('plan review', o.plan)] : []),
    ...(o.stages.length ? o.stages.map(s => outcomeLine(`stage "${s.stage}"`, s)) : ['- no stage of this run worked in this repo']),
    ...(o.finalReview ? [outcomeLine('final review', o.finalReview)] : []),
  ].join('\n')
}

export function finalPrompt(p: PromptContext, plans: string[], outcomes: RunOutcomes): string {
  const attribution = p.config.aiAttribution
    ? ''
    : ` \`git log ${shellQuote(p.base)}..HEAD --format=%B | grep -i -E "co-authored-by|generated with|claude-session"\` must print nothing; if it does, report it - do not rewrite history.`
  return `${common(p)}

You are GRANNY doing the FINAL CHECK. Run every gate and record exact numbers. \`git status --short\` must be clean${plans.length ? ` except for the plan files ${plans.join(', ')}, which stay uncommitted: never stage or commit them` : ''}.${attribution} Make ${prBodyPath(p.config)} complete and accurate against the actual commits${p.config.parallel ? `; fold in the notes of stages that ran in their own worktree (${p.config.workDir}/PR-BODY-*.md, if any) and delete those files` : ''}.
The commits do not show how this run's reviews ended. They ended like this:
${outcomesList(outcomes)}
${outcomes.reviewOnly ? 'This run only reviewed: every stage is review-only (implement: false), so any commit it made is a review fix. Say so in the PR body.\n' : ''}Rewrite the PR body's review and status section from this list, adding the section if there is none and replacing any claim of an earlier run on this branch. Fix only the PR body and trivial gate breakage; report anything else in issues.`
}

export function mergePrompt(p: PromptContext, name: string, lane: string, output: string): string {
  return `${common(p)}

You are the IMPLEMENTER, finishing a merge. Stage "${name}" ran in parallel on branch \`${lane}\` and was reviewed there; \`git merge ${lane}\` into \`${p.branch}\` stopped on conflicts:
${output.slice(-3000)}

First read ${branchLog(p)} and \`git log --oneline HEAD..${shellQuote(lane)}\`. Resolve every conflict so both sides' intent survives, keep the gates green, and conclude with \`git commit --no-edit\`. Never abort the merge or reset. Return startSha = HEAD before the merge (\`git rev-parse HEAD\` before you commit).`
}
