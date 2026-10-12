import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

import type { Delivery } from '../hooks/companion-protocol'
import { SESSION, worldOf } from './world'

export const SESSION_ID = 's1'
export const DEFAULT_SOCKET = '/home/me/Library/Application Support/AgentBrief/agent-brief.sock'

export type Call = { method: string; path: string; body: unknown; socketPath: string | undefined; at: number }

export type FakeCompanion = {
  /** False makes every request fail as a refused connection, held polls included. */
  isUp: boolean
  /** True answers /open like an app before 0.2.3, which drops a note's text. */
  isOldApp: boolean
  /** True makes the prompt box refuse fills, as under a dialog. */
  isBoxBlocked: boolean
  /** True makes the ack route answer 500. */
  isAckBroken: boolean
  /** True answers GET and PATCH /sessions/:id with 404, like an app before 0.2.6. */
  isPreTrackingApp: boolean
  /** Sessions the app knows, by id, with their item tracking and the mode the mod mirrored. */
  sessions: Map<string, { cwd: string; trackItems: boolean; mode?: string; fidelity?: string }>
  /** The prompt box. */
  box: { text: string; cursor: number }
  fills: { text: string; mode: string }[]
  /** Deliveries the app holds until they are acked, for any session. */
  queue: Delivery[]
  /** Queues a delivery and wakes the polls waiting for one. */
  push: (d: Delivery) => void
  calls: Call[]
  /** Calls to one route, in order. */
  to: (method: string, path: string) => Call[]
}

export const delivery = (
  id: string,
  draft: string,
  mode: Delivery['mode'] = 'fill',
  sessionId = SESSION_ID,
): Delivery => ({
  id,
  sessionId,
  dir: `/work/.feedback/sketches/${id}`,
  draft,
  mode,
  createdAt: 1,
})

/** Seats a fake companion app, a prompt box and a session id beneath the plugin. */
export function fakeCompanion(on: On, clock: MockClock): FakeCompanion {
  let up = true
  const waiters = new Set<() => void>()
  const wake = () => [...waiters].forEach(w => w())

  const fake: FakeCompanion = {
    get isUp() {
      return up
    },
    set isUp(value: boolean) {
      up = value
      wake()
    },
    isOldApp: false,
    isBoxBlocked: false,
    isAckBroken: false,
    isPreTrackingApp: false,
    sessions: new Map(),
    box: { text: '', cursor: 0 },
    fills: [],
    queue: [],
    push: d => {
      fake.queue.push(d)
      wake()
    },
    calls: [],
    to: (method, path) => fake.calls.filter(c => c.method === method && c.path === path),
  }

  const reply = (status: number, body: unknown) => ({
    value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) },
  })

  on('http.fetch', async ($, e) => {
    const url = new URL(e.url)
    const path = url.pathname
    const method = e.init?.method ?? 'GET'
    const text = e.init?.body
    fake.calls.push({
      method,
      path: path === '/deliveries' ? `${path}${url.search}` : path,
      body: text === undefined ? undefined : JSON.parse(text),
      socketPath: e.init?.socketPath,
      at: clock.now(),
    })
    if (!fake.isUp) return { deny: 'connect ECONNREFUSED' }
    if (path === '/health') return reply(200, { ok: true, version: 1, pid: 42, panelVisible: false, currentBoard: 'main' })
    if (path === '/deliveries') {
      const session = url.searchParams.get('session')
      const waitMs = Number(url.searchParams.get('wait') ?? 0) * 1000
      const mine = () => fake.queue.filter(d => d.sessionId === session)
      if (mine().length === 0 && waitMs > 0) {
        // Holds like the app: until a delivery for this session arrives, the app drops, or the wait runs out.
        const deadline = clock.now() + waitMs
        const timeout = clock.sleep(waitMs)
        while (up && mine().length === 0 && clock.now() < deadline) {
          await Promise.race([new Promise<void>(r => waiters.add(r)), timeout])
          waiters.clear()
          if (clock.now() >= deadline) break
        }
        if (!up) return { deny: 'connect ECONNRESET' }
      }
      return reply(200, { deliveries: mine() })
    }
    if (path === '/open') {
      const open = text === undefined ? {} : JSON.parse(text)
      const tookText = !fake.isOldApp && open.mode === 'write' && Boolean(open.text)
      return reply(200, { board: 'main', ...(tookText ? { noteText: true } : {}) })
    }
    if (path === '/sessions' && method === 'POST') {
      const info = JSON.parse(text!) as { sessionId: string; cwd: string }
      const known = fake.sessions.get(info.sessionId)
      fake.sessions.set(info.sessionId, { ...known, cwd: info.cwd, trackItems: known?.trackItems ?? false })
      return reply(200, { sessions: [] })
    }
    const sessionId = /^\/sessions\/([^/]+)$/.exec(path)?.[1]
    if (sessionId !== undefined && (method === 'GET' || method === 'PATCH')) {
      const known = fake.sessions.get(decodeURIComponent(sessionId))
      if (fake.isPreTrackingApp || !known) return reply(404, { error: 'not found', code: 'not_found' })
      if (method === 'PATCH') {
        const patch = JSON.parse(text!) as { trackItems?: boolean; mode?: string; fidelity?: string }
        if (patch.trackItems !== undefined) known.trackItems = patch.trackItems
        if (patch.mode !== undefined) {
          known.mode = patch.mode
          known.fidelity = patch.fidelity
        }
      }
      return reply(200, {
        sessionId,
        cwd: known.cwd,
        trackItems: known.trackItems,
        ...(known.trackItems ? { itemsPath: `${known.cwd}/.feedback/items/${sessionId}.md` } : {}),
      })
    }
    const ackId = /^\/deliveries\/([^/]+)\/ack$/.exec(path)?.[1]
    if (ackId !== undefined) {
      if (fake.isAckBroken) return reply(500, { error: 'boom', code: 'internal' })
      fake.queue = fake.queue.filter(d => d.id !== ackId)
      return reply(200, { ok: true })
    }
    return reply(200, { ok: true })
  })

  on('prompt.read', () => ({ value: { text: fake.box.text, cursor: fake.box.cursor } }))
  on('prompt.fill', ($, e) => {
    if (fake.isBoxBlocked) return { isFilled: false, refusal: 'dialog' as const }
    fake.fills.push({ text: e.text, mode: e.mode })
    fake.box.text = e.mode === 'replace' ? e.text : fake.box.text + e.text
    fake.box.cursor = fake.box.text.length
    return { isFilled: true }
  })
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  return fake
}

/** Seats the world, the mocked clock and the fake app, then starts the session. */
export async function setupCompanion($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const world = worldOf(on)
  const clock = mock.clock(on)
  mock.store(on)
  const app = fakeCompanion(on, clock)
  return { world, clock, app, start: () => $.session.start(SESSION) }
}
