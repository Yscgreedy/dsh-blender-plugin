/**
 * 工单 B：crew[] 可见性 —— 让人和主控看到“谁在改什么”。
 *
 * 纯函数测试：crewView(session 行, 作业行) 只读 JSON 形状，不碰 HTTP、不碰真实队列；
 * 另外锁 presenter 的 crew 摘要行（每会话一行、无 crew 不显示、既有行不动）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { pkgPath } from '../../helpers/pkg'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import { grantView } from '../../../runtime/core/sessions/types.js'
import type { CallerIdentity, InstanceRef } from '../../../runtime/core/sessions/types.js'
import type { JobQueue } from '../../../runtime/core/queue/manager.js'
import { runWithCaller } from '../../../runtime/http/caller.js'
import { dispatchSessionAction } from '../../../runtime/http/routes/session/api.js'
import { crewView } from '../../../runtime/core/sessions/session-views.js'
import { formatSessionList } from '../../../src/tools/session/presenter.js'

const NOW = 1_763_000_000_000

interface CallerLike {
  hostId: string
  dshSessionId: string
  agentId: string
  parentAgentId: string | null
  role: string
}

/** 真 registry 要的 CallerIdentity（action=list 那条路用它，不是 JSON 视图）。 */
function mainCaller(over: Partial<CallerIdentity> = {}): CallerIdentity {
  return { hostId: 'host-a', dshSessionId: 'dsh-1', agentId: 'agent-main', role: 'main', ...over }
}

function subCaller(over: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    hostId: 'host-a',
    dshSessionId: 'dsh-1',
    agentId: 'agent-sub',
    parentAgentId: 'agent-main',
    role: 'subagent',
    ...over,
  }
}

function caller(over: Partial<CallerLike> = {}): CallerLike & Record<string, unknown> {
  return {
    hostId: 'host-a',
    dshSessionId: 'dsh-1',
    agentId: 'agent-main',
    parentAgentId: null,
    role: 'main',
    ...over,
  }
}

function owner(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostId: 'host-a',
    dshSessionId: 'dsh-1',
    agentId: 'agent-main',
    parentAgentId: null,
    role: 'main',
    claimedAt: NOW - 60_000,
    heartbeatAt: NOW - 1_000,
    heartbeat_age_ms: 1_000,
    stale_after_ms: 1_800_000,
    stale: false,
    ...over,
  }
}

function presence(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    agent,
    displayName: String(agent.agentId),
    color: '#4C8DFF',
    attachedAt: NOW - 30_000,
    lastSeen: NOW - 2_000,
    view: null,
    selected: [],
    activity: '',
  }
}

function grant(
  holder: Record<string, unknown>,
  scopes: unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'grant-' + String(holder.agentId) + '-' + scopes.length,
    holder,
    grantedBy: caller(),
    scopes,
    createdAt: NOW - 10_000,
    heartbeatAt: NOW - 10_000,
    expiresAt: NOW + 60_000,
    expiresInMs: 60_000,
    ...over,
  }
}

function sessionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-gui:inst-1',
    kind: 'user-gui',
    instanceId: 'inst-1',
    status: 'ready',
    owner: owner(),
    agents: [
      presence(caller()),
      presence(caller({ agentId: 'agent-sub', parentAgentId: 'agent-main', role: 'subagent' })),
      presence(caller({ agentId: 'agent-sub-2', parentAgentId: 'agent-main', role: 'subagent' })),
    ],
    grants: [],
    ...over,
  }
}

function job(agentId: string, state: string): { state: string; owner: { agentId: string } } {
  return { state, owner: { agentId } }
}

describe('crewView：谁在这个会话里、在改什么', () => {
  it('lists the owner first and then each attached agent, without duplicating the owner', () => {
    const crew = crewView(sessionRow(), [], NOW)
    expect(crew.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub', 'agent-sub-2'])
    expect(crew[0]).toMatchObject({
      role: 'main',
      parentAgentId: null,
      scopes: [],
      grant_expires_in_ms: null,
      last_write_at: null,
      jobs_running: 0,
      jobs_queued: 0,
      state: 'idle',
      blocked_reason: null,
    })
    expect(crew[1]).toMatchObject({ role: 'subagent', parentAgentId: 'agent-main' })
    expect(crew[2]).toMatchObject({ role: 'subagent', parentAgentId: 'agent-main' })
  })

  it('projects the grant scopes and expiry of the agent that holds them', () => {
    const row = sessionRow({
      grants: [
        grant(caller({ agentId: 'agent-sub', parentAgentId: 'agent-main', role: 'subagent' }), [
          { kind: 'collection', value: 'COL_A' },
          { kind: 'prefix', value: 'LGT-' },
        ]),
      ],
    })
    const crew = crewView(row, [], NOW)
    const sub = crew.find((m) => m.agentId === 'agent-sub')
    expect(sub && sub.scopes).toEqual(['collection:COL_A', 'prefix:LGT-'])
    expect(sub && sub.grant_expires_in_ms).toBe(60_000)
    expect(sub && sub.last_write_at).toBe(NOW - 10_000)
    // 主控写场景不需要 grant：owner 行的 scopes 永远是空。
    const main = crew.find((m) => m.agentId === 'agent-main')
    expect(main && main.scopes).toEqual([])
    expect(main && main.grant_expires_in_ms).toBeNull()
  })

  it('counts running and queued jobs per owning agent and ignores terminal states', () => {
    const jobs = [
      job('agent-main', 'running'),
      job('agent-main', 'completed'),
      job('agent-main', 'failed'),
      job('agent-sub', 'queued'),
      job('agent-sub', 'assigned'),
      job('agent-sub', 'canceled'),
      job('agent-sub-2', 'queued'),
    ]
    const crew = crewView(sessionRow(), jobs, NOW)
    expect(crew.find((m) => m.agentId === 'agent-main')).toMatchObject({
      jobs_running: 1,
      jobs_queued: 0,
      state: 'working',
    })
    expect(crew.find((m) => m.agentId === 'agent-sub')).toMatchObject({
      jobs_running: 1,
      jobs_queued: 1,
      state: 'working',
    })
    expect(crew.find((m) => m.agentId === 'agent-sub-2')).toMatchObject({
      jobs_running: 0,
      jobs_queued: 1,
      state: 'working',
    })
  })

  it('reports blocked with instance_gone when the Blender instance is gone', () => {
    const crew = crewView(sessionRow({ status: 'starting', instanceId: null }), [], NOW)
    expect(crew.length).toBe(3)
    for (const member of crew) {
      expect(member.state).toBe('blocked')
      expect(member.blocked_reason).toBe('instance_gone')
    }
  })

  it('reports blocked with owner_stale when the owner heartbeat is stale or already expired', () => {
    const stale = crewView(sessionRow({ owner: owner({ stale: true }) }), [], NOW)
    expect(stale.every((m) => m.blocked_reason === 'owner_stale')).toBe(true)
    expect(stale.every((m) => m.state === 'blocked')).toBe(true)

    // 归属已过期（owner=null）但 agent presence 还在：这正是现场 release 前后的形态。
    const expired = crewView(sessionRow({ owner: null, owner_expired: true }), [], NOW)
    expect(expired.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub', 'agent-sub-2'])
    expect(expired.every((m) => m.blocked_reason === 'owner_stale')).toBe(true)
  })

  it('falls back to the grant createdAt when the view carries no heartbeat yet', () => {
    const row = sessionRow({
      grants: [
        grant(
          caller({ agentId: 'agent-sub', parentAgentId: 'agent-main', role: 'subagent' }),
          [{ kind: 'object', value: 'Cube' }],
          { heartbeatAt: undefined },
        ),
      ],
    })
    const sub = crewView(row, [], NOW).find((m) => m.agentId === 'agent-sub')
    expect(sub && sub.scopes).toEqual(['object:Cube'])
    expect(sub && sub.last_write_at).toBe(NOW - 10_000)
    expect(sub && sub.grant_expires_in_ms).toBe(60_000)
  })

  it('treats a missing job queue as zero jobs instead of failing', () => {
    const fromUndefined = crewView(sessionRow(), undefined, NOW)
    expect(fromUndefined.every((m) => m.jobs_running === 0 && m.jobs_queued === 0)).toBe(true)
    expect(fromUndefined.every((m) => m.state === 'idle')).toBe(true)
    const fromNull = crewView(sessionRow(), null, NOW)
    expect(fromNull).toEqual(fromUndefined)
    // 老 Gateway 的脏数据（非数组）同样只按 0 个作业算。
    const fromGarbage = crewView(sessionRow(), 'not-a-queue' as unknown as never[], NOW)
    expect(fromGarbage).toEqual(fromUndefined)
  })

  it('keeps a grant holder that is not in the attached-agent list', () => {
    const row = sessionRow({
      grants: [
        grant(caller({ agentId: 'agent-granted', parentAgentId: 'agent-main', role: 'subagent' }), [
          { kind: 'exclusive' },
        ]),
      ],
    })
    const crew = crewView(row, [], NOW)
    expect(crew.map((m) => m.agentId)).toEqual([
      'agent-main',
      'agent-sub',
      'agent-sub-2',
      'agent-granted',
    ])
    expect(crew[3]).toMatchObject({ scopes: ['exclusive'], parentAgentId: 'agent-main' })
  })
})

describe('session list 文本的 crew 摘要行', () => {
  it('adds one compact crew line per session and leaves the existing line untouched', () => {
    const row = sessionRow({
      is_mine: true,
      crew: crewView(
        sessionRow({
          grants: [
            grant(caller({ agentId: 'agent-sub', parentAgentId: 'agent-main', role: 'subagent' }), [
              { kind: 'collection', value: 'COL_A' },
            ]),
          ],
        }),
        [job('agent-sub', 'running')],
        NOW,
      ),
    })
    const text = formatSessionList([row])
    const lines = text.split(String.fromCharCode(10))
    expect(lines[0]).toBe('SESSION list · 1 个会话')
    expect(lines[1]).toContain(
      '· user-gui:inst-1 · user-gui · ready · instance=inst-1 · owner=agent-main',
    )
    expect(lines[2]).toContain('crew(3)')
    expect(lines[2]).toContain('agent-main/main idle')
    expect(lines[2]).toContain('agent-sub/subagent working')
    expect(lines[2]).toContain('scopes=collection:COL_A')
    expect(lines[2]).toContain('jobs=1r/0q')
  })

  it('prints no crew line when the row has no crew (old Gateway)', () => {
    const text = formatSessionList([
      { id: 'user-gui:inst-1', kind: 'user-gui', status: 'ready', instanceId: 'inst-1' },
    ])
    expect(text).not.toContain('crew(')
    expect(text).not.toContain('crew:')
  })
})

describe('/lease action=list：模型侧回执也带 crew[]', () => {
  function registryWithInstance(): SessionRegistry {
    const instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]
    return new SessionRegistry(() => instances)
  }

  function fakeQueue(jobs: Array<{ state: string; owner: { agentId: string } }>): JobQueue {
    // 只实现 crew 用到的那一条读接口：按 state 过滤（与 JobQueue.list 的语义一致）。
    return {
      list: (filter: { state?: string } = {}) =>
        jobs.filter((j) => !filter.state || j.state === filter.state),
    } as unknown as JobQueue
  }

  function attachedRegistry(): { registry: SessionRegistry; sessionId: string } {
    const registry = registryWithInstance()
    const sessionId = 'user-gui:inst-1'
    expect(registry.attach(mainCaller()).ok).toBe(true)
    expect(registry.attach(subCaller()).ok).toBe(true)
    expect(registry.grant(mainCaller(), sessionId, ['collection:COL_A'], subCaller()).ok).toBe(true)
    return { registry, sessionId }
  }

  it('adds crew[] to the rows and keeps every existing field', async () => {
    const { registry, sessionId } = attachedRegistry()
    const queue = fakeQueue([{ state: 'running', owner: { agentId: 'agent-sub' } }])
    const res = await runWithCaller(mainCaller(), () =>
      dispatchSessionAction(
        registry,
        'list',
        {},
        {
          reload: () => ({ ok: true }),
          shutdown: async () => ({ ok: true }),
          jobQueue: queue,
        },
      ),
    )
    expect(res.status).toBe(200)
    const rows = res.body.sessions as Array<Record<string, unknown>>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(1)
    // additive：既有字段一个不少
    expect(rows[0].id).toBe(sessionId)
    expect(rows[0].status).toBe('ready')
    expect((rows[0].owner as Record<string, unknown>).agentId).toBe('agent-main')
    expect((rows[0].agents as unknown[]).length).toBe(2)
    // crew 落地（owner 先，子 agent 带 scope 与在跑作业）
    const crew = rows[0].crew as Array<Record<string, unknown>>
    expect(crew.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub'])
    expect(crew[0]).toMatchObject({ role: 'main', scopes: [], jobs_running: 0, state: 'idle' })
    expect(crew[1]).toMatchObject({
      role: 'subagent',
      parentAgentId: 'agent-main',
      scopes: ['collection:COL_A'],
      jobs_running: 1,
      state: 'working',
    })
    expect(Number(crew[1].grant_expires_in_ms)).toBeGreaterThan(0)
    expect(Number(crew[1].last_write_at)).toBeGreaterThan(0)
  })

  it('answers action=list without a jobQueue: crew is there, counts are zero', async () => {
    const { registry } = attachedRegistry()
    const res = await runWithCaller(mainCaller(), () => dispatchSessionAction(registry, 'list', {}))
    expect(res.status).toBe(200)
    const rows = res.body.sessions as Array<Record<string, unknown>>
    const crew = rows[0].crew as Array<Record<string, unknown>>
    expect(crew.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub'])
    for (const member of crew) {
      expect(member.jobs_running).toBe(0)
      expect(member.jobs_queued).toBe(0)
      expect(member.state).toBe('idle')
    }
    // 队列缺失不影响“谁持有什么 scope”这条判据
    expect(crew[1].scopes).toEqual(['collection:COL_A'])
  })

  it('feeds the presenter so the model sees the crew line on action=list text', async () => {
    const { registry } = attachedRegistry()
    const res = await runWithCaller(mainCaller(), () =>
      dispatchSessionAction(
        registry,
        'list',
        {},
        {
          reload: () => ({ ok: true }),
          shutdown: async () => ({ ok: true }),
          jobQueue: fakeQueue([{ state: 'queued', owner: { agentId: 'agent-sub' } }]),
        },
      ),
    )
    const text = formatSessionList(res.body.sessions as Array<Record<string, unknown>>)
    expect(text).toContain('crew(2)')
    expect(text).toContain('agent-sub/subagent working')
    expect(text).toContain('scopes=collection:COL_A')
    expect(text).toContain('jobs=0r/1q')
  })
})

describe('grantView 的心跳 → last_write_at', () => {
  it('publishes heartbeatAt so last_write_at is the real grant heartbeat', () => {
    const holder = subCaller()
    const view = grantView({
      id: 'grant-1',
      sessionId: 'user-gui:inst-1',
      holder,
      grantedBy: mainCaller(),
      scopes: [{ kind: 'collection', value: 'COL_A' }],
      createdAt: NOW - 60_000,
      heartbeatAt: NOW - 3_000,
      expiresAt: NOW + 60_000,
    })
    expect(view.heartbeatAt).toBe(NOW - 3_000)
    const sub = crewView(sessionRow({ grants: [view] }), [], NOW).find(
      (m) => m.agentId === 'agent-sub',
    )
    expect(sub && sub.last_write_at).toBe(NOW - 3_000)
    expect(sub && sub.grant_expires_in_ms).toBe(60_000)
  })
})

describe('consent_panel 面板行：crew[] 与 /who、action=list 同源', () => {
  function registryWithGrant(): SessionRegistry {
    const instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]
    const registry = new SessionRegistry(() => instances)
    expect(registry.attach(mainCaller()).ok).toBe(true)
    expect(registry.attach(subCaller()).ok).toBe(true)
    expect(
      registry.grant(mainCaller(), 'user-gui:inst-1', ['collection:COL_A'], subCaller()).ok,
    ).toBe(true)
    return registry
  }

  function fakeQueue(jobs: Array<{ state: string; owner: { agentId: string } }>): JobQueue {
    return {
      list: (filter: { state?: string } = {}) =>
        jobs.filter((j) => !filter.state || j.state === filter.state),
    } as unknown as JobQueue
  }

  it('adds crew[] to every panel row when the route passes the queue', async () => {
    const registry = registryWithGrant()
    const res = await dispatchSessionAction(
      registry,
      'consent_panel',
      { dshSessionId: 'dsh-1' },
      {
        reload: () => ({ ok: true }),
        shutdown: async () => ({ ok: true }),
        jobQueue: fakeQueue([{ state: 'running', owner: { agentId: 'agent-sub' } }]),
      },
    )
    expect(res.status).toBe(200)
    // 既有面板字段一个不少
    for (const key of ['ok', 'ts', 'panel_session', 'policy', 'resources', 'requests', 'sessions'])
      expect(res.body).toHaveProperty(key)
    const rows = res.body.sessions as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('user-gui:inst-1')
    const crew = rows[0].crew as Array<Record<string, unknown>>
    expect(crew.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub'])
    expect(crew[1]).toMatchObject({
      scopes: ['collection:COL_A'],
      jobs_running: 1,
      state: 'working',
    })
    // 一行摘要由服务端压好（客户端只显示，不复制判据）
    expect(rows[0].crew_text).toBe(
      'agent-main/main idle · agent-sub/subagent working scopes=collection:COL_A jobs=1r/0q',
    )
  })

  it('still answers the panel without a jobQueue: crew is there, counts are zero', async () => {
    const registry = registryWithGrant()
    const res = await dispatchSessionAction(registry, 'consent_panel', { dshSessionId: 'dsh-1' })
    expect(res.status).toBe(200)
    const crew = (res.body.sessions as Array<Record<string, unknown>>)[0].crew as Array<
      Record<string, unknown>
    >
    expect(crew.map((m) => m.agentId)).toEqual(['agent-main', 'agent-sub'])
    for (const member of crew) {
      expect(member.jobs_running).toBe(0)
      expect(member.jobs_queued).toBe(0)
      expect(member.state).toBe('idle')
    }
    expect(crew[1].scopes).toEqual(['collection:COL_A'])
  })
})

describe('面板客户端：panelRow 的 crew 摘要行', () => {
  /** 与 blender-session-panel-ops.test.ts 同款：按 DSH web app 的方式加载已构建的 bundle。 */
  function clientSelf(): Record<string, any> {
    const source = fs.readFileSync(pkgPath('lib', 'client.js'), 'utf8')
    let registration: any = null
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (def: any) => {
            registration = def
          },
        },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      },
      console,
      fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    }
    vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
    const react = { useEffect: () => {}, useRef: (v: unknown) => ({ current: v }) }
    const exported = registration.factory((id: string) => {
      if (id === 'react') return react
      throw new Error('unexpected require: ' + id)
    })
    return exported.__selftest
  }

  it('carries the one-line crew summary on the panel row', () => {
    const row = clientSelf().panelRow({
      id: 'user-gui:inst-1',
      kind: 'user-gui',
      status: 'ready',
      owner: { dshSessionId: 'dsh-1', agentId: 'agent-main', role: 'main' },
      crew: [{ agentId: 'agent-sub', role: 'subagent', state: 'working' }],
      crew_text:
        'agent-main/main idle · agent-sub/subagent working scopes=collection:COL_A jobs=1r/0q',
    })
    expect(row.crewText).toBe(
      'agent-main/main idle · agent-sub/subagent working scopes=collection:COL_A jobs=1r/0q',
    )
    // 既有字段与顺序不受影响
    expect(row.id).toBe('user-gui:inst-1')
    expect(row.ownerAgent).toBe('agent-main')
    expect(row.grantCount).toBe(0)
  })

  it('keeps the row unchanged when the panel has no crew (old Gateway)', () => {
    const row = clientSelf().panelRow({
      id: 'user-gui:inst-1',
      kind: 'user-gui',
      status: 'ready',
      owner: { dshSessionId: 'dsh-1', agentId: 'agent-main', role: 'main' },
    })
    expect(row.crewText).toBe('')
  })
})
