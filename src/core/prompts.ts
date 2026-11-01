import type { GrannyConfig } from './config'
import { shellQuote } from './shell'
import type { Finding, StageSpec } from './types'

export interface PromptContext {
  repo: string
  branch: string
  base: string
  context?: string
  config: GrannyConfig
}

export const prBodyPath = (c: GrannyConfig) => `${c.workDir}/PR-BODY.md`

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
  if (p.context) lines.push('', 'CONTEXT - read these before anything else and obey them:', p.context)
  return lines.join('\n')
}

export function implementPrompt(p: PromptContext, stage: StageSpec, index: number, total: number, name: string): string {
  const pr = prBodyPath(p.config)
  const earlier = index === 0 ? '' : `Earlier stages are done and reviewed - read \`git log --oneline ${shellQuote(p.base)}..HEAD\`, the code and ${pr} first.\n`
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
Apply the review findings on top of the current branch state (read \`git log --oneline ${shellQuote(p.base)}..HEAD\` and the code first). Fix every finding below, red-green where it changes behaviour, keep the gates green, commit (\`fix(...)\`), and add each finding id with what you did to the "Review fixes" section of ${prBodyPath(p.config)}. A finding you believe is wrong: do not fix it, explain why in deviations.

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

export function extractPrompt(name: string, output: string, short?: { markers: number; got: number }): string {
  const count = short
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
For each finding below, open the cited code and judge whether it is real, correctly described and worth fixing; score it 0-100 (findings the code refutes score low). Then score the whole review 0-100 (correctness + actionability; mostly wrong or trivial findings = low).

REVIEW:
${JSON.stringify(findings, null, 2)}`
}

export function finalPrompt(p: PromptContext): string {
  const attribution = p.config.aiAttribution
    ? ''
    : ` \`git log ${shellQuote(p.base)}..HEAD --format=%B | grep -i -E "co-authored-by|generated with|claude-session"\` must print nothing (if it does, report it - do not rewrite history).`
  return `${common(p)}

You are GRANNY doing the FINAL CHECK - no push, no remote, no PR. Run every gate and record exact numbers. \`git status --short\` must be clean.${attribution} Make ${prBodyPath(p.config)} complete and accurate against the actual commits. Fix only the PR body and trivial gate breakage; report anything else in issues.`
}
