import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Theme = 'light' | 'dark'
type Tone = 'neutral' | 'blue' | 'purple' | 'amber' | 'red' | 'green' | 'muted'

const palette = {
  light: {
    text: '#1f2328',
    muted: '#59636e',
    frame: '#d1d9e0',
    tones: {
      neutral: ['#f6f8fa', '#818b98'],
      blue: ['#ddf4ff', '#0969da'],
      purple: ['#fbefff', '#8250df'],
      amber: ['#fff8c5', '#9a6700'],
      red: ['#ffebe9', '#cf222e'],
      green: ['#dafbe1', '#1a7f37'],
      muted: ['#f6f8fa', '#818b98'],
    },
  },
  dark: {
    text: '#e6edf3',
    muted: '#9198a1',
    frame: '#3d444d',
    tones: {
      neutral: ['#151b23', '#656c76'],
      blue: ['#0d2240', '#4493f8'],
      purple: ['#231537', '#ab7df8'],
      amber: ['#2e2208', '#d29922'],
      red: ['#3a1416', '#f85149'],
      green: ['#0f2a18', '#3fb950'],
      muted: ['#151b23', '#656c76'],
    },
  },
} as const

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function canvas(theme: Theme, width: number, height: number, title: string) {
  const p = palette[theme]
  const out: string[] = []
  const markers = (Object.keys(p.tones) as Tone[])
    .map(
      (t) =>
        `<marker id="a-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.tones[t][1]}"/></marker>`,
    )
    .join('')

  const api = {
    p,
    text(x: number, y: number, s: string, o: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean; spacing?: number } = {}) {
      out.push(
        `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : FONT}" font-size="${o.size ?? 14}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? p.text}" text-anchor="${o.anchor ?? 'start'}"${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${esc(s)}</text>`,
      )
    },
    box(x: number, y: number, w: number, h: number, tone: Tone, title: string, lines: string[] = [], o: { dashed?: boolean; mono?: boolean } = {}) {
      const [fill, stroke] = p.tones[tone]
      out.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${o.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
      )
      const total = 20 + lines.length * 19
      let ty = y + (h - total) / 2 + 15
      api.text(x + w / 2, ty, title, { size: 15, weight: 600, anchor: 'middle' })
      for (const line of lines) {
        ty += 19
        api.text(x + w / 2, ty, line, { size: 12.5, fill: p.muted, anchor: 'middle', mono: o.mono })
      }
    },
    frame(x: number, y: number, w: number, h: number, label: string) {
      out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="none" stroke="${p.frame}" stroke-width="1.5" stroke-dasharray="7 5"/>`)
      api.text(x + w - 18, y + 24, label, { size: 11.5, weight: 700, fill: p.muted, spacing: 1.2, anchor: 'end' })
    },
    path(d: string, tone: Tone, o: { dashed?: boolean; head?: boolean } = {}) {
      const stroke = p.tones[tone][1]
      out.push(
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2"${o.dashed ? ' stroke-dasharray="5 4"' : ''}${o.head === false ? '' : ` marker-end="url(#a-${tone})"`}/>`,
      )
    },
    label(x: number, y: number, s: string, tone: Tone, anchor = 'middle') {
      api.text(x, y, s, { size: 12, weight: 600, fill: p.tones[tone][1], anchor })
    },
    done() {
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
        `<title>${esc(title)}</title>`,
        `<defs>${markers}</defs>`,
        ...out,
        '</svg>',
        '',
      ].join('\n')
    },
  }
  return api
}

function loop(theme: Theme): string {
  const c = canvas(theme, 1000, 790, 'granny-workflow: plan review, then implement, review, judge and fix for every stage')

  c.text(24, 34, 'BEFORE STAGE 1 · GIVEN A PLAN', { size: 11.5, weight: 700, fill: c.p.muted, spacing: 1.2 })
  c.box(24, 52, 150, 70, 'neutral', 'Plan files', ['your plan'])
  c.path('M174,87 L222,87', 'neutral')
  c.box(224, 52, 230, 70, 'purple', 'Plan review', ['reviewers check it', 'against the real repo'])
  c.path('M454,74 L540,74', 'purple')
  c.label(497, 66, 'findings', 'purple')
  c.box(542, 52, 230, 70, 'blue', 'Implementer fixes plan', ['in place, never committed'])
  c.path('M542,100 L456,100', 'blue')
  c.label(499, 117, 'review again', 'blue')
  c.path('M772,87 L830,87', 'red', { dashed: true })
  c.label(801, 79, 'cap', 'red')
  c.box(832, 52, 144, 70, 'red', 'Stop', ['nothing is built'])

  c.path('M339,122 L339,152 L135,152 L135,226', 'green')
  c.label(345, 145, 'clean or residual-only', 'green', 'start')

  c.frame(12, 186, 976, 404, 'FOR EACH STAGE · IN THE BRANCH’S OWN GIT WORKTREE')

  c.box(40, 228, 190, 82, 'blue', 'Implementer', ['builds the stage', 'and commits'])
  c.path('M230,269 L278,269', 'blue')

  c.box(280, 222, 230, 238, 'purple', '', [])
  c.text(395, 248, 'Reviewers', { size: 15, weight: 600, anchor: 'middle' })
  c.text(395, 266, 'all in parallel', { size: 12.5, fill: c.p.muted, anchor: 'middle' })
  const chips = ['Codex CLI / plugin', 'host model (agent)', 'any CLI  {prompt}']
  chips.forEach((chip, i) => {
    const y = 282 + i * 44
    c.box(298, y, 194, 34, 'neutral', '', [])
    c.text(395, y + 22, chip, { size: 13, anchor: 'middle', mono: i === 2 })
  })
  c.text(395, 434, 'one that fails twice →', { size: 11.5, fill: c.p.muted, anchor: 'middle' })
  c.text(395, 449, 'stage review-failed', { size: 11.5, fill: c.p.muted, anchor: 'middle' })

  c.path('M510,250 L630,250', 'green')
  c.label(570, 242, 'no findings', 'green')
  c.box(632, 224, 344, 52, 'green', 'Stage clean → next stage', [])

  c.path('M510,342 L630,342', 'amber')
  c.label(570, 334, 'P2 / P3', 'amber')
  c.box(632, 304, 170, 76, 'amber', 'Judge', ['scores 0–100,', 'merges duplicates'])
  c.path('M802,330 L852,330', 'muted')
  c.label(827, 322, '≤ 70', 'muted')
  c.box(854, 304, 122, 52, 'muted', 'Residual', ['reported to you'])

  c.path('M510,412 L560,412 L560,530 L135,530 L135,312', 'red')
  c.label(566, 430, 'P0 / P1: skip the judge', 'red', 'start')
  c.path('M722,380 L722,530 L560,530', 'amber', { head: false })
  c.label(730, 410, '> 70', 'amber', 'start')
  c.text(340, 555, 'implementer fixes them → every reviewer reviews again · cap: maxRounds', { size: 12.5, fill: c.p.muted, anchor: 'middle' })

  c.path('M500,590 L500,632', 'neutral')
  c.label(510, 616, 'after the last stage', 'neutral', 'start')
  c.box(40, 634, 430, 80, 'neutral', 'Final check', ['gates · clean tree · no AI trailers · PR body'])
  c.path('M470,674 L528,674', 'green')
  c.box(530, 634, 446, 80, 'green', 'PR-ready branch', ['nothing is pushed: you review and decide'])

  c.text(500, 760, 'The loop is code, not a prompt: thresholds, caps and stop conditions hold on every run.', { size: 12.5, fill: c.p.muted, anchor: 'middle' })
  return c.done()
}

function hosts(theme: Theme): string {
  const c = canvas(theme, 1000, 470, 'granny-workflow: one core engine, generated for Claude Code and opencode; Cursor follows it by hand')

  c.box(300, 24, 400, 92, 'neutral', 'src/core: one engine', ['loop · routing · judge · config · review parsing', 'written once in TypeScript'])

  c.path('M420,116 L420,150 L160,150 L160,188', 'blue')
  c.path('M580,116 L580,150 L500,150 L500,188', 'purple')
  c.label(500, 140, 'scripts/build.ts', 'neutral')
  c.path('M700,70 L840,70 L840,188', 'muted', { dashed: true })
  c.label(770, 62, 'same rules, by hand', 'muted')

  c.box(24, 190, 290, 150, 'blue', 'Claude Code', ['Workflow script', 'every role is an agent() call', 'with its own model, effort, schema', 'reviewers run as concurrent calls'])
  c.box(355, 190, 290, 150, 'purple', 'opencode 2.x', ['server plugin', 'granny_run · granny_status · granny_cancel', 'every role is a child session', 'review CLIs run directly'])
  c.box(686, 190, 290, 150, 'muted', 'Cursor and others', ['manual protocol in the skill', 'four subagents', 'same loop, not deterministic'], { dashed: true })

  const roles: Array<[string, string, Tone]> = [
    ['granny', 'launches and reports', 'neutral'],
    ['planner', 'writes the plan', 'green'],
    ['implementer', 'builds and fixes', 'blue'],
    ['reviewers', 'find issues, in parallel', 'purple'],
    ['judge', 'scores and dedupes', 'amber'],
  ]
  c.text(24, 384, 'ROLES · EACH WITH ITS OWN MODEL AND EFFORT', { size: 11.5, weight: 700, fill: c.p.muted, spacing: 1.2 })
  roles.forEach(([name, what, tone], i) => c.box(24 + i * 193, 398, 180, 58, tone, name, [what]))
  return c.done()
}

const dir = join(import.meta.dir, '..', 'docs', 'images')
mkdirSync(dir, { recursive: true })
for (const theme of ['light', 'dark'] as const) {
  writeFileSync(join(dir, `loop-${theme}.svg`), loop(theme))
  writeFileSync(join(dir, `hosts-${theme}.svg`), hosts(theme))
}
console.log(`wrote ${dir}`)
