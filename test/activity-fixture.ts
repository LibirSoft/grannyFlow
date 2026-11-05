// An agent's event stream like the one on the screen the user called unreadable (24a): state churn, read
// bursts, long absolute paths, a todo, a task and a running bash.
import type { ActivityItem } from '../src/adapters/runview/activity'

export const T0 = Date.parse('2026-11-05T20:32:00.000Z')
export const S = 1000
export const WT = '/home/u/empo-worktrees/chore-auth'
export const at = (s: number) => T0 + s * S
export const state = (s: number, text: string): ActivityItem => ({ t: at(s), kind: 'state', text })
export const tool = (s: number, name: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({ t: at(s), kind: 'tool', name, ...extra })
export const end = (s: number, name: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({ t: at(s), kind: 'tool-end', name, ...extra })

export const SCREEN: ActivityItem[] = [
  state(0, 'starting'),
  state(1, 'waiting for model'),
  state(2, 'thinking'),
  { t: at(3), kind: 'heading', text: 'Planning the recovery' },
  state(4, 'preparing a tool call'),
  ...['auth.md', 'database-and-caching.md', 'testing.md', 'sessions.md', 'cookies.md'].flatMap((f, i) => [tool(8, 'read', { id: `s${i}`, arg: `skill://asena/references/${f}` }), end(8, 'read', { id: `s${i}` })]),
  state(9, 'waiting for model'),
  tool(10, 'task', { id: 'task1', intent: 'Auditing the auth recovery' }),
  { t: at(10), kind: 'subagents', names: ['AuthRecoveryAudit'] },
  end(44, 'task', { id: 'task1' }),
  state(45, 'thinking'),
  state(46, 'preparing a tool call'),
  tool(48, 'bash', { id: 'b1', intent: 'Carrying interrupted auth work into recovery branch', arg: `cd ${WT} && git checkout -b recovery && git cherry-pick a1b2c3` }),
  end(51, 'bash', { id: 'b1' }),
  state(52, 'waiting for model'),
  tool(52, 'bash', { id: 'b2', intent: 'Installing recovered locked auth dependencies', arg: `cd ${WT} && bun install --frozen-lockfile` }),
  end(52, 'bash', { id: 'b2' }),
  ...['auth-http', 'session-store', 'cookie-security', 'csrf', 'oauth', 'tokens', 'roles'].flatMap((f, i) => [
    tool(52 + (i > 3 ? 1 : 0), 'read', { id: `r${i}`, arg: `${WT}/tests/auth/${f}.test.ts` }),
    end(53, 'read', { id: `r${i}` }),
  ]),
  state(54, 'thinking'),
  state(60, 'preparing a tool call'),
  tool(61, 'bash', { id: 'b3', intent: 'Running recovered auth suite for actual failures', arg: `cd ${WT} && bun test tests/auth` }),
  end(65, 'bash', { id: 'b3', failed: true }),
  { t: at(66), kind: 'todo', todos: [{ text: 'Tracking complete auth recovery stage', state: 'done' }, { text: 'Advancing to durable session completion', state: 'active' }, { text: 'Final checks', state: 'pending' }] },
  tool(137, 'read', { id: 'c1', arg: `${WT}/tests/auth/cookie-security.test.ts` }),
  end(137, 'read', { id: 'c1' }),
  tool(137, 'read', { id: 'c2', arg: `${WT}/tests/auth/cookie-security.test.ts` }),
  end(138, 'read', { id: 'c2' }),
  state(139, 'writing'),
  { t: at(140), kind: 'text', text: '\nStage 1 foundation is green; resuming the auth cutover from the recovery branch where the interrupted run stopped.\nNext I check the build.' },
  state(141, 'thinking'),
  { t: at(142), kind: 'heading', text: 'Comparing recovery source against clean foundation' },
  state(143, 'preparing a tool call'),
  tool(150, 'bash', { id: 'b4', intent: 'Checking integrated build and full behavioral suite', arg: `cd ${WT} && bun run build && bun test` }),
]
