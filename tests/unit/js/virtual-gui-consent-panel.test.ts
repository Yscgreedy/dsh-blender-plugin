import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import type { CallerIdentity, InstanceRef } from '../../../runtime/core/sessions/types.js'
import { resetConsentRequests } from '../../../runtime/core/sessions/consent-requests.js'
import { resetConsentPolicyCache } from '../../../runtime/core/sessions/consent-policy.js'
import { dispatchSessionAction } from '../../../runtime/http/routes/session/api.js'
import { runWithCaller } from '../../../runtime/http/caller.js'
import { pkgPath } from '../../helpers/pkg'

const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-1',
  agentId: 'agent-main',
  role: 'main',
  ...over,
})

const caps = () => ({
  platform: process.platform,
  provider: 'win-hidden-desktop',
  provider_implemented: true,
  feature: 'on' as const,
  feature_source: 'config',
  enabled: true,
  preview: false,
  hardware_gl: true,
  ready: true,
  needs_approval: false,
  prerequisites: [],
  missing: [],
  reason: null,
  fix: '',
})

/** Every fake provider start is counted: "deny must not spawn" is a number, not a claim. */
function panelRegistry(instances: InstanceRef[] = []) {
  const state = { instances, starts: 0 }
  const registry = new SessionRegistry(() => state.instances, {
    display: caps,
    selectProvider: () => ({
      kind: 'win-hidden-desktop',
      capabilities: caps,
      health: async () => ({ ok: true, detail: '' }),
      start: async () => {
        state.starts += 1
        return {
          id: 'disp-' + String(state.starts),
          provider: 'win-hidden-desktop',
          display: 'hidden-desktop',
          pid: 4200 + state.starts,
        }
      },
      stop: async () => undefined,
    }),
    waitForInstance: async (instanceId: string) => {
      state.instances = [{ instanceId, ready: true }]
      return true
    },
    limits: () => ({
      limit: 4,
      configured: 4,
      low_resource: false,
      reason: 'configured' as const,
      total_mem_bytes: 32 * 1024 ** 3,
      free_mem_bytes: 16 * 1024 ** 3,
    }),
  })
  return { registry, state }
}

let consentDir = ''
let policyFile = ''

beforeAll(() => {
  consentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-consent-panel-'))
  policyFile = path.join(consentDir, 'policy.json')
  process.env.DSH_BLENDER_CONSENT_DIR = consentDir
  process.env.DSH_BLENDER_CONSENT_POLICY_FILE = policyFile
})

afterEach(() => {
  resetConsentRequests()
  resetConsentPolicyCache()
  delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
  try {
    fs.rmSync(policyFile, { force: true })
  } catch {
    /* fine */
  }
  for (const name of fs.existsSync(consentDir) ? fs.readdirSync(consentDir) : []) {
    if (name.endsWith('.json') && name !== 'policy.json') {
      try {
        fs.rmSync(path.join(consentDir, name), { force: true })
      } catch {
        /* fine */
      }
    }
  }
})

afterAll(() => {
  delete process.env.DSH_BLENDER_CONSENT_DIR
  delete process.env.DSH_BLENDER_CONSENT_POLICY_FILE
  try {
    fs.rmSync(consentDir, { recursive: true, force: true })
  } catch {
    /* fine */
  }
})

function setPolicy(mode: string): void {
  fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: mode }), 'utf8')
  resetConsentPolicyCache()
}

/** Wait until the panel shows a pending request (the panel's own responsiveness). */
async function waitForCard(
  registry: SessionRegistry,
  sessionId: string,
  budgetMs = 1000,
): Promise<{ elapsedMs: number; panel: Record<string, unknown> }> {
  const t0 = Date.now()
  for (;;) {
    const panel = registry.consentPanel(sessionId)
    const rows = Array.isArray(panel.requests) ? panel.requests : []
    if (rows.some((r) => (r as Record<string, unknown>).state === 'pending'))
      return { elapsedMs: Date.now() - t0, panel }
    if (Date.now() - t0 > budgetMs) throw new Error('no pending card within ' + budgetMs + 'ms')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * 痛点（3.3.0 实测）：virtual-gui 首次 start 回 consent_required，回执要人复制 uuid 去终端
 * curl，再回对话催 agent 重调一次 —— 第一步就卡住，真能力等于不存在。
 * 这组用例覆盖面板需求书的 5 条验收。
 */
describe('virtual-gui consent panel (3.3.1)', () => {
  it('[验收1] manual：卡片 ≤1 s 出现；批准让同一次 start 落地（consent_source=approved_request）', async () => {
    const { registry, state } = panelRegistry()
    const pendingStart = registry.start(main(), { kind: 'virtual-gui', waitMs: 15000 })
    const card = await waitForCard(registry, 'dsh-1')
    expect(card.elapsedMs).toBeLessThanOrEqual(1000)
    const handle = String((card.panel.requests as Record<string, unknown>[])[0].handle)
    expect(handle.startsWith('h-')).toBe(true)

    const t0 = Date.now()
    const decided = await dispatchSessionAction(
      registry,
      'consent_approve',
      { handle, source: 'panel' },
      undefined,
      'http://127.0.0.1:51822',
    )
    expect(decided.status).toBe(200)
    expect(decided.body.decided).toBe('approved')

    const started = await pendingStart
    expect(Date.now() - t0).toBeLessThanOrEqual(2000)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((started.session as Record<string, unknown>).consent_source).toBe('approved_request')
    expect(state.starts).toBe(1)
  })

  it('[验收1b] 批准只释放它自己那条请求：第二次 start 需要新的批准', async () => {
    const { registry, state } = panelRegistry()
    const first = registry.start(main(), { kind: 'virtual-gui', waitMs: 3000 })
    const card = await waitForCard(registry, 'dsh-1')
    const handle = String((card.panel.requests as Record<string, unknown>[])[0].handle)
    await dispatchSessionAction(registry, 'consent_approve', { handle }, undefined, undefined)
    const started = await first
    expect(started.ok).toBe(true)
    resetConsentRequests() // 新进程视角：只留磁盘
    const second = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.evidence.reason).toBe('missing')
    expect(second.evidence.state).toBe('pending')
    expect(state.starts).toBe(1)
  })

  it('[验收2] auto：不弹卡片、consent_source=policy:allow、面板常显自动批准', async () => {
    setPolicy('auto')
    const { registry } = panelRegistry()
    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((started.session as Record<string, unknown>).consent_source).toBe('policy:allow')

    const panel = registry.consentPanel('dsh-1')
    const policy = panel.policy as Record<string, unknown>
    expect(policy.mode).toBe('auto')
    expect(policy.policy).toBe('allow')
    expect(policy.auto).toBe(true)
    expect(policy.source).toContain('file:')
    const pending = (panel.requests as Record<string, unknown>[]).filter(
      (r) => r.state === 'pending',
    )
    expect(pending.length).toBe(0)

    // 同一条投影给面板 UI：auto 必须常显（不是只在配置文件里）
    const model = clientSelf().panelModel(panel, Date.now())
    expect(model.auto).toBe(true)
    expect(model.autoBanner).toContain('自动批准已开')
    expect(model.title).toContain('自动批准已开')
  })

  it('[验收3] deny：reason=policy_denied 且不 spawn', async () => {
    setPolicy('deny')
    const { registry, state } = panelRegistry()
    const denied = await registry.start(main(), { kind: 'virtual-gui' })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.code).toBe('consent_required')
    expect(denied.evidence.reason).toBe('policy_denied')
    expect(denied.evidence.mode).toBe('deny')
    expect(state.starts).toBe(0)
    expect(registry.list().length).toBe(0)
    const panel = registry.consentPanel('dsh-1')
    expect((panel.policy as Record<string, unknown>).auto).toBe(false)
    expect((panel.policy as Record<string, unknown>).mode).toBe('deny')
  })

  it('[验收4] 认领表与 blender_session status 逐字段一致', async () => {
    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'allow'
    const { registry } = panelRegistry()
    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const sessionId = String((started.session as Record<string, unknown>).id)

    const status = registry.status(main(), sessionId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    const st = status.session as Record<string, unknown>
    const panel = registry.consentPanel('dsh-1')
    const row = (panel.sessions as Record<string, unknown>[]).find((r) => r.id === sessionId)
    expect(row).toBeTruthy()
    if (!row) return
    const stOwner = st.owner as Record<string, unknown>
    const rowOwner = row.owner as Record<string, unknown>
    expect(row.id).toBe(st.id)
    expect(row.instanceId).toBe(st.instanceId)
    expect(row.kind).toBe(st.kind)
    expect(rowOwner.dshSessionId).toBe(stOwner.dshSessionId)
    expect(rowOwner.agentId).toBe(stOwner.agentId)
    expect(rowOwner.role).toBe(stOwner.role)
    expect(rowOwner.heartbeatAt).toBe(stOwner.heartbeatAt)
    expect(row.is_mine).toBe(st.is_mine)
    expect(row.is_mine).toBe(true)
    expect(row.borrowed).toBe(st.borrowed)
    expect(
      Math.abs(Number(rowOwner.expiresInMs) - Number(stOwner.expiresInMs)),
    ).toBeLessThanOrEqual(50)
    expect(Array.isArray(row.grants)).toBe(true)
    expect((row.grants as unknown[]).length).toBe(0)
    // viewer 是"这条 DSH 会话在该窗口里有没有 presence"，与 status 的 is_mine 无关
    expect(typeof row.viewer).toBe('boolean')
  })

  it('[验收5a] 热更（Gateway 换代）后面板状态不丢：待批准从磁盘恢复并可批准', async () => {
    const { registry } = panelRegistry()
    void registry.start(main(), { kind: 'virtual-gui', waitMs: 200 })
    const card = await waitForCard(registry, 'dsh-1')
    const handle = String((card.panel.requests as Record<string, unknown>[])[0].handle)

    resetConsentRequests() // 新进程：内存空，只剩 <consentDir>/<id>.json
    const after = registry.consentPanel('dsh-1')
    const rows = after.requests as Record<string, unknown>[]
    expect(rows.length).toBe(1)
    expect(rows[0].state).toBe('pending')
    expect(rows[0].handle).toBe(handle)

    const decided = await dispatchSessionAction(
      registry,
      'consent_approve',
      { handle },
      undefined,
      'http://127.0.0.1:51822',
    )
    expect(decided.status).toBe(200)
    const retried = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect((retried.session as Record<string, unknown>).consent_source).toBe('approved_request')
  })

  it('[验收5b] user-gui 的 claim/release/viewer 语义不变', async () => {
    const { registry } = panelRegistry([{ instanceId: 'inst-1', ready: true }])
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    expect((attached.session as Record<string, unknown>).kind).toBe('user-gui')

    // 另一条 DSH 会话（同机、非家族）只能以 viewer 身份读：is_mine=false / borrowed=true
    const other = main({ dshSessionId: 'dsh-9', agentId: 'agent-other', role: 'main' })
    const viewer = registry.attach(other)
    expect(viewer.ok).toBe(true)
    if (!viewer.ok) return
    expect(viewer.viewer).toBe(true)
    expect((viewer.session as Record<string, unknown>).is_mine).toBe(false)
    expect((viewer.session as Record<string, unknown>).borrowed).toBe(true)

    const panel = registry.consentPanel('dsh-1')
    const row = (panel.sessions as Record<string, unknown>[])[0]
    expect(row.kind).toBe('user-gui')
    expect(row.is_mine).toBe(true)
    expect(row.borrowed).toBe(false)

    const released = registry.release(main())
    expect(released.ok).toBe(true)
    const afterRelease = registry.list()
    expect(afterRelease[0].owner).toBe(null)
    // 释放后可以被重新认领（原 3.1 语义不变）
    const reclaimed = registry.attach(main())
    expect(reclaimed.ok).toBe(true)
    if (!reclaimed.ok) return
    expect((reclaimed.session as Record<string, unknown>).is_mine).toBe(true)
  })

  it('人点「拒绝」：等待中的 start 立刻回 request_denied 且不 spawn', async () => {
    const { registry, state } = panelRegistry()
    const pendingStart = registry.start(main(), { kind: 'virtual-gui', waitMs: 15000 })
    const card = await waitForCard(registry, 'dsh-1')
    const handle = String((card.panel.requests as Record<string, unknown>[])[0].handle)
    const t0 = Date.now()
    const decided = await dispatchSessionAction(
      registry,
      'consent_deny',
      { handle },
      undefined,
      'http://127.0.0.1:51822',
    )
    expect(decided.status).toBe(200)
    expect(decided.body.decided).toBe('denied')
    const result = await pendingStart
    expect(Date.now() - t0).toBeLessThanOrEqual(2000)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('consent_required')
    expect(result.evidence.reason).toBe('request_denied')
    expect(state.starts).toBe(0)
    expect(registry.list().length).toBe(0)
  })

  it('闸门收口：agent 不能自批——带 DSH 身份的 consent_approve/deny 一律 403 consent_human_only', async () => {
    const { registry, state } = panelRegistry()
    const pendingStart = registry.start(main(), { kind: 'virtual-gui', waitMs: 400 })
    const card = await waitForCard(registry, 'dsh-1')
    const handle = String((card.panel.requests as Record<string, unknown>[])[0].handle)
    const requestId = String((card.panel.requests as Record<string, unknown>[])[0].request_id)

    // 同一个 agent（身份头齐全）试图批准自己刚落的请求
    const self = await runWithCaller(main(), () =>
      dispatchSessionAction(
        registry,
        'consent_approve',
        { handle, requestId },
        undefined,
        undefined,
      ),
    )
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('consent_human_only')
    expect(String(self.body.root_cause)).toContain('an agent cannot decide')

    const selfDeny = await runWithCaller(main(), () =>
      dispatchSessionAction(registry, 'consent_deny', { handle }, undefined, undefined),
    )
    expect(selfDeny.status).toBe(403)
    expect(selfDeny.body.code).toBe('consent_human_only')

    // 请求仍然是 pending：自批没有留下任何痕迹
    const panel = registry.consentPanel('dsh-1')
    expect((panel.requests as Record<string, unknown>[])[0].state).toBe('pending')

    // 人（无身份）批准才生效
    const human = await dispatchSessionAction(
      registry,
      'consent_approve',
      { handle },
      undefined,
      'http://127.0.0.1:51822',
    )
    expect(human.status).toBe(200)
    const started = await pendingStart
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((started.session as Record<string, unknown>).consent_source).toBe('approved_request')
    expect(state.starts).toBe(1)
  })

  it('不认识 handle：404，不会误批准别人的请求', async () => {
    const { registry } = panelRegistry()
    const decided = await dispatchSessionAction(
      registry,
      'consent_approve',
      { handle: 'h-deadbeef' },
      undefined,
      undefined,
    )
    expect(decided.status).toBe(404)
    expect(decided.body.code).toBe('consent_missing')
  })

  it('面板只答本地来源：非回环 Origin 拿不到数据也做不了决定', async () => {
    const { registry } = panelRegistry()
    const blockedRead = await dispatchSessionAction(
      registry,
      'consent_panel',
      { dshSessionId: 'dsh-1' },
      undefined,
      'https://evil.example',
    )
    expect(blockedRead.status).toBe(403)
    expect(blockedRead.body.code).toBe('origin_not_allowed')

    const filed = registry.requestConsent(main())
    expect(filed.ok).toBe(true)
    if (!filed.ok) return
    const handle = String((filed.request as Record<string, unknown>).handle)
    const blockedDecide = await dispatchSessionAction(
      registry,
      'consent_approve',
      { handle },
      undefined,
      'https://evil.example',
    )
    expect(blockedDecide.status).toBe(403)

    const allowed = await dispatchSessionAction(
      registry,
      'consent_panel',
      { dshSessionId: 'dsh-1' },
      undefined,
      'http://localhost:51822',
    )
    expect(allowed.status).toBe(200)
    expect(allowed.cors).toBe(true)
    expect((allowed.body.policy as Record<string, unknown>).mode).toBe('manual')
  })

  it('wait_ms=0：立刻回 state=pending，批准后一次 start 即消费', async () => {
    const { registry } = panelRegistry()
    const pending = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
    expect(pending.ok).toBe(false)
    if (pending.ok) return
    expect(pending.evidence.state).toBe('pending')
    expect(String(pending.evidence.request_id).length).toBeGreaterThan(20)
    expect(pending.evidence.wait_ms).toBe(0)

    const approved = registry.approveConsent(String(pending.evidence.request_id), 'human')
    expect(approved.ok).toBe(true)
    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)
  })
})

/** 面板渲染树的文字（用于断言"人真的能看到什么"）。 */
function treeText(node: any): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' | ')
  return treeText(node.children)
}

function findByType(node: any, type: string, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findByType(n, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  findByType(node.children, type, out)
  return out
}

/** 极简 createElement：面板树是纯函数，不需要 React 也不需要 DOM。 */
function h(type: string, props: Record<string, any> | null, ...children: any[]): any {
  return {
    type,
    props: props || {},
    children: children.reduce((acc: any[], c: any) => acc.concat(c), []),
  }
}

describe('session panel rendering (client half)', () => {
  const panel = (over: Record<string, unknown> = {}) => ({
    ok: true,
    ts: 1_700_000_000_000,
    policy: { mode: 'manual', policy: 'ask', auto: false, source: 'default', file: null },
    resources: {
      instances: 1,
      limit: 4,
      low_resource: false,
      ready_instances: 1,
      connected: true,
    },
    requests: [],
    sessions: [],
    ...over,
  })

  it('auto：收起状态下也常显「自动批准已开」', () => {
    const self = clientSelf()
    const model = self.panelModel(
      panel({ policy: { mode: 'auto', policy: 'allow', auto: true, source: 'file:c.json' } }),
      Date.now(),
    )
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: true,
      onDecide: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('自动批准已开')
    expect(text).toContain('策略 auto · file:c.json')
    expect(text).toContain('实例 1/4')
  })

  it('manual：卡片带请求方、资源影响、倒计时与两个按钮；按钮携带 handle', () => {
    const self = clientSelf()
    const payload = panel({
      requests: [
        {
          request_id: '11111111-1111-1111-1111-111111111111',
          handle: 'h-abcdef',
          state: 'pending',
          expires_at: 1_700_000_000_000 + 240_000,
          expires_in_ms: 240_000,
          caller: { agentId: 'agent-main', dshSessionId: 'dsh-1', role: 'main' },
        },
      ],
    })
    const model = self.panelModel(payload, 1_700_000_000_000)
    const decided: string[] = []
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      onDecide: (handle: string, action: string) => decided.push(handle + ':' + action),
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('待批准 · 启动一个可见的 virtual-gui Blender 窗口')
    expect(text).toContain('请求方 agent-main · 会话 dsh-1 · main')
    expect(text).toContain('影响：再起一个 Blender 进程 · 实例 1/4')
    expect(text).toContain('有效期剩余 4m00')
    expect(text).not.toContain('11111111-1111') // request_id 不进页面

    const buttons = findByType(tree, 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].props['data-request']).toBe('h-abcdef')
    expect(treeText(buttons[0])).toBe('批准')
    buttons[0].props.onClick()
    buttons[1].props.onClick()
    expect(decided).toEqual(['h-abcdef:approve', 'h-abcdef:deny'])
  })

  it('认领表展示 owner / is_mine / viewer / borrowed / 心跳 / 归属剩余 / grant', () => {
    const self = clientSelf()
    const payload = panel({
      sessions: [
        {
          id: 'virtual-gui:vgui-1',
          kind: 'virtual-gui',
          instanceId: 'vgui-1',
          status: 'ready',
          is_mine: false,
          borrowed: true,
          viewer: true,
          owner: {
            dshSessionId: 'dsh-9',
            agentId: 'agent-other',
            role: 'main',
            heartbeat_age_ms: 1500,
            expiresInMs: 1798500,
          },
          grants: [{ id: 'grant-1', scopes: [{ kind: 'exclusive' }] }],
        },
      ],
    })
    const model = self.panelModel(payload, 1_700_000_000_000)
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      onDecide: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('vgui-1')
    expect(text).toContain('dsh-9/agent-other')
    expect(text).toContain('is_mine ✗')
    expect(text).toContain('viewer')
    expect(text).toContain('borrowed')
    expect(text).toContain('心跳 2s')
    expect(text).toContain('归属剩 29m59')
    expect(text).toContain('grant ×1')
  })
})

/** The shipped client bundle, loaded the way the DSH web app loads it. */
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
      localStorage: { getItem: () => null, setItem: () => {} },
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
