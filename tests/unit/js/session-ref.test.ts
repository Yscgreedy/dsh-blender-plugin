/**
 * 宿主侧"什么算 ready 会话"的唯一解析点。
 *
 * 现场：see / py / op / run / session 各自从 Gateway 的行里挖 id、instanceId、
 * owner，再各自拼一遍 session_required —— 同一份失败有的带 instance 线索、有的不带。
 * 这个文件钉住值对象 `sessionRefOf` 与唯一解析入口 `resolveSession` 的判据，
 * 以及兼容包装 `requireReadySession` 的形状。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  replies: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))

vi.mock('../../../src/host/http.js', () => ({
  backendPost: vi.fn(async (_port: number, path: string, body: Record<string, unknown>) => {
    h.calls.push({ path, body })
    const next = h.replies.shift()
    if (!next) throw new Error('no scripted reply')
    return next
  }),
  backendJson: vi.fn(),
  jsonPayload: (value: unknown) => value,
}))

import {
  requireReadySession,
  resolveSession,
  sessionIdOf,
  sessionRefOf,
} from '../../../src/tools/shared/session.js'

function reply(body: Record<string, unknown>): void {
  h.replies.push(body)
}

function listReply(sessions: Array<Record<string, unknown>>): void {
  reply({ ok: true, sessions })
}

/** One Gateway session row, as /lease list returns it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-gui:inst-1',
    kind: 'user-gui',
    status: 'ready',
    instanceId: 'inst-1',
    is_mine: true,
    owner: { hostId: 'host-a', dshSessionId: 'dsh-1', agentId: 'main' },
    ...over,
  }
}

beforeEach(() => {
  h.replies.length = 0
  h.calls.length = 0
})

describe('sessionRefOf: 行 → 值对象', () => {
  it('mine：id / instance / owner 直接来自行，source=mine', () => {
    const ref = sessionRefOf(row())
    expect(ref).toMatchObject({
      ok: true,
      sessionId: 'user-gui:inst-1',
      instanceId: 'inst-1',
      owner: 'dsh-1',
      source: 'mine',
    })
    // row 原样保留，presenter 还要读 kind / status / agents
    expect(ref.row.kind).toBe('user-gui')
    expect(ref.row.status).toBe('ready')
  })

  it('visible：别人的会话仍给出 owner（归属可回执），但 source=visible', () => {
    const ref = sessionRefOf(
      row({ is_mine: false, owner: { hostId: 'host-a', dshSessionId: 'dsh-2', agentId: 'other' } }),
    )
    expect(ref.source).toBe('visible')
    expect(ref.owner).toBe('dsh-2')
  })

  it('缺 is_mine 的旧行按 visible 处理：没证据就不认成自己的会话', () => {
    const ref = sessionRefOf(row({ is_mine: undefined }))
    expect(ref.source).toBe('visible')
  })

  it('缺 instance / owner 过期时给空串而不是 "undefined"', () => {
    const ref = sessionRefOf(row({ instanceId: undefined, owner: null }))
    expect(ref.instanceId).toBe('')
    expect(ref.owner).toBe('')
    expect(ref.sessionId).toBe('user-gui:inst-1')
  })

  it('owner 以裸字符串到达时原样透传（动态边界），空行不炸', () => {
    expect(sessionRefOf(row({ owner: 'dsh-raw' })).owner).toBe('dsh-raw')
    expect(sessionRefOf({}).sessionId).toBe('')
    expect(sessionRefOf({}).instanceId).toBe('')
  })

  it('sessionIdOf 与 sessionRefOf 同源：id 只解析一次', () => {
    expect(sessionIdOf(row())).toBe(sessionRefOf(row()).sessionId)
    expect(sessionIdOf({})).toBe('')
  })
})

describe('resolveSession: 唯一解析入口', () => {
  it('一次 /lease list + 自己的会话优先于别人的只读会话', async () => {
    listReply([
      row({
        id: 'user-gui:inst-2',
        instanceId: 'inst-2',
        is_mine: false,
        owner: { dshSessionId: 'dsh-2' },
      }),
      row({ id: 'virtual-gui:inst-1', kind: 'virtual-gui', instanceId: 'inst-1' }),
    ])
    const ref = await resolveSession(1)
    expect(ref.ok).toBe(true)
    if (!ref.ok) return
    expect(ref.sessionId).toBe('virtual-gui:inst-1')
    expect(ref.source).toBe('mine')
    expect(h.calls).toEqual([{ path: '/lease', body: { action: 'list' } }])
  })

  it('instanceId 收窄到指定 Blender（多实例路由）', async () => {
    listReply([
      row({ id: 'user-gui:inst-1', instanceId: 'inst-1' }),
      row({ id: 'user-gui:inst-2', instanceId: 'inst-2' }),
    ])
    const ref = await resolveSession(1, undefined, 'inst-2')
    expect(ref.ok).toBe(true)
    if (!ref.ok) return
    expect(ref.instanceId).toBe('inst-2')
    expect(ref.sessionId).toBe('user-gui:inst-2')
  })

  it('kind 收窄：只要 virtual-gui 时不把 user-gui 顶上来', async () => {
    listReply([row(), row({ id: 'virtual-gui:inst-1', kind: 'virtual-gui' })])
    const ref = await resolveSession(1, 'virtual-gui')
    expect(ref.ok).toBe(true)
    if (!ref.ok) return
    expect(ref.row.kind).toBe('virtual-gui')
  })

  it('没有 ready 会话 → session_required（决策请求），不启动任何东西', async () => {
    listReply([row({ status: 'starting' }), row({ id: 'user-gui:inst-2', instanceId: '' })])
    const ref = await resolveSession(1)
    expect(ref.ok).toBe(false)
    if (ref.ok) return
    expect(ref.failure.envelope.error.code).toBe('session_required')
    expect(ref.failure.envelope.stage).toBe('session')
    expect(ref.failure.text).toContain('Blender 未附着')
    expect(ref.failure.envelope.error.next_action).toContain('action=attach')
  })

  it('instance 线索保留：指名实例失败时回 instance_id=', async () => {
    listReply([row({ instanceId: 'inst-1' })])
    const ref = await resolveSession(1, undefined, 'inst-9')
    expect(ref.ok).toBe(false)
    if (ref.ok) return
    expect(ref.failure.envelope.error.code).toBe('session_required')
    expect(ref.failure.envelope.error.detail).toContain('instance_id=inst-9')
    expect(ref.failure.envelope.error.detail).toContain('action=attach instance_id=inst-9')
  })

  it('kind 线索：指名 kind 失败时说清少的是哪一类会话', async () => {
    listReply([row()])
    const ref = await resolveSession(1, 'virtual-gui')
    expect(ref.ok).toBe(false)
    if (ref.ok) return
    expect(ref.failure.envelope.error.detail).toContain('kind=virtual-gui')
  })

  it('Gateway list 失败原样映射成工具失败（不伪装成 session_required）', async () => {
    reply({ ok: false, code: 'gateway_down', root_cause: 'lease 通道关闭', fix: '重启插件' })
    const ref = await resolveSession(1)
    expect(ref.ok).toBe(false)
    if (ref.ok) return
    expect(ref.failure.envelope.error.code).toBe('gateway_down')
    expect(ref.failure.text).toContain('session list 失败')
  })

  it('requireReadySession 兼容包装：成功给 row+instance，失败给同一个 failure', async () => {
    listReply([row()])
    const ready = await requireReadySession(1)
    expect(ready.ok).toBe(true)
    if (!ready.ok) return
    expect(ready.session.id).toBe('user-gui:inst-1')
    expect(ready.instanceId).toBe('inst-1')

    listReply([])
    const missing = await requireReadySession(1, undefined, 'inst-3')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.failure.envelope.error.code).toBe('session_required')
    expect(missing.failure.envelope.error.detail).toContain('instance_id=inst-3')
  })
})
