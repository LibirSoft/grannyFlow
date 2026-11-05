import { describe, expect, it } from 'bun:test'
import { messageActivity } from '../src/adapters/opencode/activity'
import { summarise } from '../src/adapters/runview/activity'

const T0 = Date.parse('2026-11-05T20:31:00.000Z')
const S = 1000
const WT = '/w/asena-peer-pong-worktrees/feat-pause'
const at = (s: number) => T0 + s * S

const tool = (id: string, name: string, input: unknown, status: string, time: Record<string, number>, extra: Record<string, unknown> = {}) => ({ type: 'tool', id, name, state: { status, input, ...extra }, time })
const assistant = (id: string, created: number, content: unknown[], completed?: number) => ({ id, type: 'assistant', time: { created, ...(completed !== undefined ? { completed } : {}) }, agent: 'build', model: { id: 'k3.1-pro', providerID: 'kimi-code-plan-global', variant: 'default' }, content })

const target = () => [
  { id: 'msg_u', type: 'user', time: { created: at(0) }, text: 'go' },
  assistant('msg_1', at(1), [tool('t1', 'read', { path: `${WT}/src/services/GameService.ts` }, 'completed', { created: at(2), ran: at(2), completed: at(3) })], at(4)),
  assistant('msg_2', at(10), [tool('t2', 'edit', { path: `${WT}/src/game/protocol.ts`, oldString: 'a', newString: 'b' }, 'completed', { created: at(15), completed: at(16) })], at(17)),
  assistant('msg_3', at(40), [{ type: 'text', text: 'Added pause/resume messages to the protocol.\nmore' }], at(41)),
  assistant('msg_4', at(60), [
    { type: 'reasoning', text: 'Run the tests', time: { created: at(60), completed: at(61) } },
    tool('t3', 'shell', { command: `cd ${WT} && bun test test/GameService.test.ts`, workdir: WT }, 'running', { created: at(62), ran: at(63) }),
  ]),
]

describe('messageActivity', () => {
  it('turns tool and text parts into items and the unfinished last message into NOW', () => {
    const a = messageActivity(target())
    expect(a.items).toEqual([
      { t: at(2), kind: 'tool', name: 'read', id: 't1', arg: `${WT}/src/services/GameService.ts` },
      { t: at(3), kind: 'tool-end', name: 'read', id: 't1' },
      { t: at(15), kind: 'tool', name: 'edit', id: 't2', arg: `${WT}/src/game/protocol.ts` },
      { t: at(16), kind: 'tool-end', name: 'edit', id: 't2' },
      { t: at(40), kind: 'text', text: 'Added pause/resume messages to the protocol.\nmore' },
      { t: at(62), kind: 'tool', name: 'shell', id: 't3', arg: `cd ${WT} && bun test test/GameService.test.ts` },
    ])
    expect(a.now).toEqual({ state: 'running', tool: 'shell', arg: `cd ${WT} && bun test test/GameService.test.ts`, since: at(63) })
  })

  it('feeds the shared summary: NOW on the running shell, RECENT newest first with short paths, LAST SAID', () => {
    const a = messageActivity(target())
    const s = summarise(a.items, at(75), { cwd: WT, ...(a.now ? { live: a.now } : {}) })
    expect(s.now).toEqual({ text: '● shell · 12s', tone: 'info', detail: 'bun test test/GameService.test.ts' })
    expect(s.recent.map(r => `${r.tool} ${r.text}`)).toEqual(['edit src/game/protocol.ts', 'read src/services/GameService.ts'])
    expect(s.lastSaid).toBe('Added pause/resume messages to the protocol. more')
  })

  it('reads thinking, writing, waiting and a finished message from the last message', () => {
    const thinking = [assistant('m', at(0), [{ type: 'reasoning', text: 'hm', time: { created: at(5) } }])]
    expect(messageActivity(thinking).now).toEqual({ state: 'thinking', since: at(5) })
    const writing = [assistant('m', at(0), [{ type: 'text', text: 'Hel', time: { created: at(7) } }])]
    expect(messageActivity(writing).now).toEqual({ state: 'writing', since: at(7) })
    const empty = [assistant('m', at(3), [])]
    expect(messageActivity(empty).now).toEqual({ state: 'waiting', since: at(3) })
    const streaming = [assistant('m', at(0), [tool('t', 'write', {}, 'streaming', { created: at(8) })])]
    expect(messageActivity(streaming).now).toEqual({ state: 'running', tool: 'write', since: at(8) })
    const between = [assistant('m', at(0), [tool('t', 'read', { path: 'a' }, 'completed', { created: at(1), completed: at(2) })])]
    expect(messageActivity(between).now).toEqual({ state: 'waiting', since: at(2) })
    expect(messageActivity([assistant('m', at(0), [], at(9))]).now).toBeUndefined()
    expect(messageActivity([{ id: 'u', type: 'user', time: { created: at(0) } }]).now).toBeUndefined()
  })

  it('marks a failed tool with its error, from a string or an object', () => {
    const items = messageActivity([
      assistant('m', at(0), [
        tool('t1', 'subagent', { agent: 'x', description: 'Audit' }, 'error', { created: at(1), completed: at(2) }, { error: { type: 'tool.execution', message: 'Subagent depth limit reached (1).\nmore' } }),
        tool('t2', 'shell', { command: 'false' }, 'error', { created: at(3), completed: at(4) }, { error: 'exit 1' }),
      ], at(5)),
    ]).items
    expect(items).toEqual([
      { t: at(1), kind: 'tool', name: 'subagent', id: 't1', arg: 'Audit' },
      { t: at(2), kind: 'error', name: 'subagent', id: 't1', text: 'Subagent depth limit reached (1).' },
      { t: at(3), kind: 'tool', name: 'shell', id: 't2', arg: 'false' },
      { t: at(4), kind: 'error', name: 'shell', id: 't2', text: 'exit 1' },
    ])
  })

  it('turns a todowrite call into the todo list', () => {
    const items = messageActivity([
      assistant('m', at(0), [
        tool('t', 'todowrite', { todos: [{ content: 'Model', status: 'completed' }, { content: 'Lifecycle', status: 'in_progress' }, { content: 'Docs', status: 'pending' }, { status: 'pending' }] }, 'completed', { created: at(1), completed: at(1) }),
      ], at(2)),
    ]).items
    expect(items).toEqual([
      {
        t: at(1),
        kind: 'todo',
        todos: [
          { text: 'Model', state: 'done' },
          { text: 'Lifecycle', state: 'active' },
          { text: 'Docs', state: 'pending' },
        ],
      },
    ])
  })

  it('reads only the last messages and keeps the last items', () => {
    const many = Array.from({ length: 20 }, (_, i) => assistant(`m${i}`, at(i), [tool(`t${i}`, 'read', { path: `f${i}` }, 'completed', { created: at(i), completed: at(i) })], at(i)))
    const a = messageActivity(many, { maxMessages: 3 })
    expect(a.items.filter(i => i.kind === 'tool').map(i => i.arg)).toEqual(['f17', 'f18', 'f19'])
    expect(messageActivity(many, { maxItems: 4 }).items.map(i => `${i.kind}:${i.arg ?? i.id}`)).toEqual(['tool:f18', 'tool-end:t18', 'tool:f19', 'tool-end:t19'])
  })

  it('skips malformed messages and parts, never throwing', () => {
    const messy = [null, 7, 'x', { type: 'assistant' }, { type: 'assistant', content: 'no' }, assistant('m', at(0), [null, { type: 'tool' }, { type: 'text' }, { type: 'tool', name: 'read', state: null }], at(1))]
    expect(() => messageActivity(messy)).not.toThrow()
    expect(messageActivity(messy).items).toEqual([{ t: at(0), kind: 'tool', name: 'read' }])
    expect(messageActivity(undefined).items).toEqual([])
    expect(messageActivity({}).now).toBeUndefined()
  })

  it('changes its key when the session grows, a part changes or the text streams, and only then', () => {
    const base = target()
    const key = messageActivity(base).key
    expect(messageActivity(target()).key).toBe(key)
    const more = target()
    ;(more[4] as any).content.push({ type: 'text', text: 'a' })
    expect(messageActivity(more).key).not.toBe(key)
    const longer = target()
    ;(longer[4] as any).content.push({ type: 'text', text: 'ab' })
    expect(messageActivity(longer).key).not.toBe(messageActivity(more).key)
    const done = target()
    ;(done[4] as any).content[1].state.status = 'completed'
    expect(messageActivity(done).key).not.toBe(key)
    expect(messageActivity([...target(), { id: 'msg_5', type: 'assistant', time: { created: at(70) }, content: [] }]).key).not.toBe(key)
  })
})
