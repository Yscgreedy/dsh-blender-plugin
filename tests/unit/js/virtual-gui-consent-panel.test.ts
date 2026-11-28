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
  // 验收用例会在几十毫秒里连续 start；节流单独一条用例验。
  process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS = '0'
  // 锚定策略文件：文件不存在时 resolveConsentPolicy 会继续找 ~/.dsh/dsh-blender.config.json，
  // 操作者本机若写着 auto，manual 语义的用例会全部假红（本次审核的附加③）。
  fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: 'manual' }), 'utf8')
})

afterEach(() => {
  resetConsentRequests()
  resetConsentPolicyCache()
  delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
  // 不是删除：删掉就又会落回操作者真实配置。恢复成 manual 锚点。
  fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: 'manual' }), 'utf8')
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
  delete process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS
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

describe('策略写路径 consent_policy_set（唯一新写路径）', () => {
  const origin = 'http://127.0.0.1:51822'

  it('只写 virtualGuiConsent 一个键、留 .bak、立即生效', async () => {
    const { registry } = panelRegistry()
    fs.writeFileSync(
      policyFile,
      JSON.stringify(
        { httpPort: 39877, virtualGuiConsent: 'manual', features: { virtualGui: 'on' } },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    resetConsentPolicyCache()
    const res = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'auto' },
      undefined,
      origin,
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.effective).toBe('immediate')
    const policy = res.body.policy as Record<string, unknown>
    expect(policy.mode).toBe('auto')
    expect(policy.auto).toBe(true)
    expect(policy.source).toContain('file:')
    const audit = res.body.audit as Record<string, unknown>
    expect(Number(audit.at)).toBeGreaterThan(0)
    expect(audit.origin).toBe(origin)

    const after = JSON.parse(fs.readFileSync(policyFile, 'utf8')) as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual(['features', 'httpPort', 'virtualGuiConsent'])
    expect(after.virtualGuiConsent).toBe('auto')
    expect(after.httpPort).toBe(39877)
    expect((after.features as Record<string, unknown>).virtualGui).toBe('on')
    const backup = policyFile + '.bak'
    expect(fs.existsSync(backup)).toBe(true)
    expect(
      (JSON.parse(fs.readFileSync(backup, 'utf8')) as Record<string, unknown>).virtualGuiConsent,
    ).toBe('manual')

    // 下一次 start：不需要任何工具调用就已是 auto
    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((started.session as Record<string, unknown>).consent_source).toBe('policy:allow')
  })

  it('切回 manual：立即恢复弹卡片（不需要重启）', async () => {
    const { registry } = panelRegistry()
    const auto = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'auto' },
      undefined,
      origin,
    )
    expect(auto.status).toBe(200)
    expect((auto.body.policy as Record<string, unknown>).mode).toBe('auto')
    const manual = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'manual' },
      undefined,
      origin,
    )
    expect(manual.status).toBe(200)
    expect((manual.body.policy as Record<string, unknown>).mode).toBe('manual')
    expect((manual.body.policy as Record<string, unknown>).auto).toBe(false)
    const panel = registry.consentPanel('dsh-1')
    expect((panel.policy as Record<string, unknown>).auto).toBe(false)
    const pending = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
    expect(pending.ok).toBe(false)
    if (pending.ok) return
    expect(pending.evidence.state).toBe('pending')
    expect((manual.body.policy as Record<string, unknown>).source).toContain('file:')
  })

  it('带 DSH 身份头 → 403 consent_human_only（agent 改不了策略），且没写文件', async () => {
    fs.rmSync(policyFile, { force: true })
    resetConsentPolicyCache()
    const { registry } = panelRegistry()
    const res = await runWithCaller(main(), () =>
      dispatchSessionAction(registry, 'consent_policy_set', { mode: 'auto' }, undefined, origin),
    )
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('consent_human_only')
    expect(String(res.body.fix)).toContain('human')
    expect(fs.existsSync(policyFile)).toBe(false)
  })

  it('env 锁定时拒绝（409 policy_locked），不会假装改成功', async () => {
    fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: 'manual' }), 'utf8')
    resetConsentPolicyCache()
    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'manual'
    const { registry } = panelRegistry()
    const res = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'auto' },
      undefined,
      origin,
    )
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('policy_locked')
    expect(
      (JSON.parse(fs.readFileSync(policyFile, 'utf8')) as Record<string, unknown>)
        .virtualGuiConsent,
    ).toBe('manual')
    // 面板同步显示锁定
    const panel = registry.consentPanel('dsh-1')
    const view = panel.policy as Record<string, unknown>
    expect(view.locked).toBe(true)
    expect(view.lock_env).toBe('DSH_BLENDER_VIRTUAL_GUI_CONSENT')
    expect(view.writable).toBe(false)
    delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
  })

  it('非回环 Origin → 403 origin_not_allowed', async () => {
    const { registry } = panelRegistry()
    const res = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'auto' },
      undefined,
      'https://evil.example',
    )
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('origin_not_allowed')
  })

  it('非法 mode → 500 policy_write_failed（不写半截文件）', async () => {
    fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: 'manual' }), 'utf8')
    resetConsentPolicyCache()
    const { registry } = panelRegistry()
    const res = await dispatchSessionAction(
      registry,
      'consent_policy_set',
      { mode: 'sometimes' },
      undefined,
      origin,
    )
    expect(res.status).toBe(500)
    expect(String((res.body as Record<string, unknown>).root_cause)).toContain('mode must be')
    expect(
      (JSON.parse(fs.readFileSync(policyFile, 'utf8')) as Record<string, unknown>)
        .virtualGuiConsent,
    ).toBe('manual')
  })
})

describe('同意目录的保留与节流', () => {
  it('prune：删掉 7 天前的请求文件，保留最近的和仍 pending 的', async () => {
    const { registry } = panelRegistry()
    const pendingStart = registry.start(main(), { kind: 'virtual-gui', waitMs: 120 })
    await waitForCard(registry, 'dsh-1')
    const live = fs.readdirSync(consentDir).filter((n) => n.endsWith('.json'))
    expect(live.length).toBeGreaterThan(0)
    const oldFile = path.join(consentDir, '00000000-0000-4000-8000-000000000000.json')
    fs.writeFileSync(
      oldFile,
      JSON.stringify({
        request_id: path.basename(oldFile, '.json'),
        state: 'denied',
        expires_at: 1,
        caller: {},
      }),
      'utf8',
    )
    const old = new Date(Date.now() - 30 * 24 * 3600_000)
    fs.utimesSync(oldFile, old, old)
    const { pruneConsentFiles } = await import('../../../runtime/core/sessions/consent-requests.js')
    pruneConsentFiles()
    expect(fs.existsSync(oldFile)).toBe(false)
    for (const name of live) expect(fs.existsSync(path.join(consentDir, name))).toBe(true)
    await pendingStart
  })

  it('节流：同一 caller 一分钟内只落一条新请求（驳回后立刻重试被挡）', async () => {
    process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS = '60000'
    try {
      const { registry } = panelRegistry()
      const first = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
      expect(first.ok).toBe(false)
      if (first.ok) return
      const requestId = String(first.evidence.request_id)
      expect(registry.approveConsent(requestId, 'human').ok).toBe(true)
      const started = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
      expect(started.ok).toBe(true) // 消费掉那条批准
      // 现在再要一条新请求 → 被节流挡住
      const again = await registry.start(main(), { kind: 'virtual-gui', waitMs: 0 })
      expect(again.ok).toBe(false)
      if (again.ok) return
      expect(again.evidence.reason).toBe('rate_limited')
      expect(Number(again.evidence.retry_after_ms)).toBeGreaterThan(0)
      const filed = registry.requestConsent(main())
      expect(filed.ok).toBe(false)
      if (filed.ok) return
      expect(filed.code).toBe('consent_rate_limited')
    } finally {
      process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS = '0'
    }
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
      confirmAuto: '',
      onDecide: () => {},
      onPolicy: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('自动批准已开')
    expect(model.policyLabel).toContain('auto · file:c.json')
    expect(text).toContain('实例 1/4')
  })

  it('折叠行补两个数：待批准 N / 认领 M；策略区三态 + 来源 + 立即生效', () => {
    const self = clientSelf()
    const payload = panel({
      requests: [
        {
          handle: 'h-1',
          state: 'pending',
          expires_at: 1_700_000_000_000 + 60_000,
          expires_in_ms: 60_000,
          caller: { agentId: 'agent-main', dshSessionId: 'dsh-1', role: 'main' },
        },
      ],
      sessions: [
        {
          id: 'virtual-gui:v1',
          instanceId: 'v1',
          kind: 'virtual-gui',
          is_mine: true,
          owner: {
            dshSessionId: 'dsh-1',
            agentId: 'agent-main',
            heartbeat_age_ms: 0,
            expiresInMs: 1_800_000,
          },
          grants: [],
        },
        {
          id: 'user-gui:g1',
          instanceId: 'g1',
          kind: 'user-gui',
          is_mine: false,
          borrowed: true,
          owner: {
            dshSessionId: 'dsh-9',
            agentId: 'agent-other',
            heartbeat_age_ms: 5,
            expiresInMs: 1_799_000,
          },
          grants: [],
        },
      ],
    })
    const model = self.panelModel(payload, 1_700_000_000_000)
    const seen: string[] = []
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      confirmAuto: '',
      onDecide: () => {},
      onPolicy: (mode: string) => seen.push(mode),
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('Blender 会话 · 1 待批准')
    expect(text).toContain('待批准 1 ｜ 认领 2')
    expect(text).toContain('实例 1/4')
    expect(text).toContain('策略')
    expect(text).toContain('当前 manual · default')
    expect(text).toContain('改完立即生效，无需重启')
    const modes = findByType(tree, 'button').filter((b: any) => b.props['data-mode'])
    expect(modes.map((b: any) => b.props['data-mode'])).toEqual(['manual', 'auto', 'deny'])
    expect(treeText(modes[0])).toContain('● manual')
    expect(modes[0].props.disabled).toBe(false)
    // 点 auto 只是"进入二次确认"，由组件决定（纯树层只派发 mode）
    modes[1].props.onClick()
    expect(seen).toEqual(['auto'])
  })

  it('0 待批准 · 0 实例：入口仍可达且显示零值', () => {
    const self = clientSelf()
    const model = self.panelModel(panel(), Date.now())
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      confirmAuto: '',
      onDecide: () => {},
      onPolicy: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('待批准 0 ｜ 认领 0')
    expect(text).toContain('0 待批准 · 0 实例')
    expect(text).toContain('Blender 会话')
  })

  it('auto 二次确认：确认态文案写清后果', () => {
    const self = clientSelf()
    const model = self.panelModel(panel(), Date.now())
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      confirmAuto: 'auto',
      onDecide: () => {},
      onPolicy: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('确认自动批准')
    expect(text).toContain('以后每次 start 都直接放行、不再询问')
    expect(text).toContain('再点一次「确认自动批准」')
  })

  it('env 锁定时控件禁用并提示来源', () => {
    const self = clientSelf()
    const locked = panel({
      policy: {
        mode: 'auto',
        policy: 'allow',
        auto: true,
        source: 'env:DSH_BLENDER_VIRTUAL_GUI_CONSENT',
        file: null,
        locked: true,
        lock_env: 'DSH_BLENDER_VIRTUAL_GUI_CONSENT',
        lock_value: 'auto',
        writable: false,
      },
    })
    const model = self.panelModel(locked, Date.now())
    const tree = self.panelTree(h, {
      model,
      error: '',
      busy: '',
      collapsed: false,
      confirmAuto: '',
      onDecide: () => {},
      onPolicy: () => {},
      onToggle: () => {},
    })
    const modes = findByType(tree, 'button').filter((b: any) => b.props['data-mode'])
    expect(modes.every((b: any) => b.props.disabled === true)).toBe(true)
    expect(treeText(tree)).toContain('被环境变量 DSH_BLENDER_VIRTUAL_GUI_CONSENT=auto 锁定')
    expect(treeText(tree)).toContain('自动批准已开')
  })

  it('会话头部入口与极简状态行的文案（0 也可见）', () => {
    const self = clientSelf()
    const empty = self.panelModel(panel(), Date.now())
    expect(empty.chipLabel).toBe('Blender · 0 待批准')
    expect(empty.chipActive).toBe(false)
    const one = self.panelModel(
      panel({
        requests: [
          { handle: 'h-1', state: 'pending', expires_at: Date.now() + 60_000, caller: {} },
        ],
      }),
      Date.now(),
    )
    expect(one.chipLabel).toBe('Blender · 1 待批准')
    expect(one.chipActive).toBe(true)
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
      confirmAuto: '',
      onDecide: (handle: string, action: string) => decided.push(handle + ':' + action),
      onPolicy: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('待批准 · 启动一个可见的 virtual-gui Blender 窗口')
    expect(text).toContain('请求方 agent-main · 会话 dsh-1 · main')
    expect(text).toContain('影响：再起一个 Blender 进程 · 实例 1/4')
    expect(text).toContain('有效期剩余 4m00')
    expect(text).not.toContain('11111111-1111') // request_id 不进页面

    const buttons = findByType(tree, 'button').filter((b: any) => b.props['data-request'])
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
      confirmAuto: '',
      onDecide: () => {},
      onPolicy: () => {},
      onToggle: () => {},
    })
    const text = treeText(tree)
    expect(text).toContain('待批准 0 ｜ 认领 1')
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
