import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import type { CallerIdentity, InstanceRef } from '../../../runtime/core/sessions/types.js'
import { resetConsentRequests } from '../../../runtime/core/sessions/consent-requests.js'
import { dispatchSessionAction } from '../../../runtime/http/routes/session/api.js'
import { formatConsent } from '../../../src/tools/session/presenter.js'

const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-1',
  agentId: 'agent-main',
  role: 'main',
  ...over,
})

function setup(instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]) {
  const state = { instances }
  const registry = new SessionRegistry(() => state.instances)
  return { registry, state }
}

afterEach(() => {
  resetConsentRequests()
  delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
})

/**
 * 痛点1a field report: after wm.read_factory_settings killed the addon, attach still
 * answered ok/ready (a stale receipt) and the next real call said session_required.
 * A record that outlives its instance must not be revived.
 */
describe('attach liveness (痛点1a)', () => {
  it('refuses to revive a user-gui record whose instance is gone', () => {
    const { registry, state } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    state.instances = []
    const r = registry.attach(main())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('addon_disconnected')
    expect(r.stage).toBe('session')
    expect(String(r.fix)).toContain('Connect')
    expect(r.evidence.ready_instances).toBe(0)
    expect(r.evidence.instanceId).toBe('inst-1')
  })

  it('marks the dead record stopped so status cannot imply ready', () => {
    const { registry, state } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    state.instances = []
    registry.attach(main())
    const st = registry.status(main())
    expect(st.ok).toBe(true)
    if (!st.ok) return
    const live = st.session.live as Record<string, unknown>
    expect(live.instanceReady).toBe(false)
    expect(st.session.status).toBe('stopped')
  })

  it('reports live=true while the instance is still listed and ready', () => {
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    const st = registry.status(main())
    expect(st.ok).toBe(true)
    if (!st.ok) return
    expect((st.session.live as Record<string, unknown>).instanceReady).toBe(true)
  })

  it('attachChecked turns a silent socket into addon_unresponsive', async () => {
    const state = { instances: [{ instanceId: 'inst-1', ready: true }] as InstanceRef[] }
    const registry = new SessionRegistry(() => state.instances, {
      verify: async () => false,
    })
    const r = await registry.attachChecked(main())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('addon_unresponsive')
    expect(r.evidence.probe).toBe('ping')
  })
})

/**
 * 痛点1b field report: consent_required was a dead end — no request, no token, no
 * prompt the human ever saw. A start must file an approvable request, and an
 * approval from the human side must make the next start work once.
 */
describe('virtual-gui consent requests (痛点1b)', () => {
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

  function consentRegistry() {
    const state = { instances: [] as InstanceRef[] }
    const registry = new SessionRegistry(() => state.instances, {
      display: caps,
      selectProvider: () => ({
        kind: 'win-hidden-desktop',
        capabilities: caps,
        health: async () => ({ ok: true, detail: '' }),
        start: async () => ({
          id: 'disp-1',
          provider: 'win-hidden-desktop',
          display: 'hidden-desktop',
          pid: 4242,
        }),
        stop: async () => undefined,
      }),
      waitForInstance: async (instanceId: string) => {
        state.instances = [{ instanceId, ready: true }]
        return true
      },
    })
    return registry
  }

  it('files a request and answers consent_required with its id', async () => {
    const registry = consentRegistry()
    const r = await registry.start(main(), { kind: 'virtual-gui' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('consent_required')
    expect(typeof r.evidence.request_id).toBe('string')
    expect(String(r.evidence.request_id).length).toBeGreaterThan(20)
    expect(r.evidence.policy).toBe('ask')
  })

  it('start succeeds after the human approves the filed request, and only once', async () => {
    const registry = consentRegistry()
    const first = await registry.start(main(), { kind: 'virtual-gui' })
    if (first.ok) throw new Error('expected consent_required')
    const requestId = String(first.evidence.request_id)
    const view = registry.consentStatus(main())
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect((view.requests as unknown[]).length).toBe(1)

    const approved = registry.approveConsent(requestId, 'human')
    expect(approved.ok).toBe(true)

    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((started.session as Record<string, unknown>).consent_source).toBe('approved_request')

    const again = registry.consentStatus(main())
    if (!again.ok) return
    const rows = again.requests as Array<Record<string, unknown>>
    expect(rows[0].state).toBe('consumed')
  })

  it('honours the host policy env instead of asking', async () => {
    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'allow'
    const registry = consentRegistry()
    const r = await registry.start(main(), { kind: 'virtual-gui' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.session as Record<string, unknown>).consent_source).toBe('policy:allow')

    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'deny'
    const denied = await registry.start(main({ agentId: 'agent-2' }), { kind: 'virtual-gui' })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.code).toBe('consent_required')
    expect(denied.evidence.reason).toBe('policy_denied')
  })

  it('a terminal without DSH identity headers can approve a filed request', async () => {
    const registry = consentRegistry()
    const filed = registry.requestConsent(main())
    expect(filed.ok).toBe(true)
    if (!filed.ok) return
    const requestId = String((filed.request as Record<string, unknown>).request_id)

    // No caller context: this is the human's curl, not the agent's tool call.
    const approved = await dispatchSessionAction(registry, 'consent_approve', { requestId })
    expect(approved.status).toBe(200)
    expect(approved.body.decided).toBe('approved')

    const started = await registry.start(main(), { kind: 'virtual-gui' })
    expect(started.ok).toBe(true)

    // The approval was already spent by that start: it must not be re-armed.
    const replay = await dispatchSessionAction(registry, 'consent_approve', { requestId })
    expect(replay.status).toBe(409)
    expect(replay.body.code).toBe('consent_consumed')
  })

  it('the receipt carries the exact human commands when a route base is known', async () => {
    const registry = consentRegistry()
    const denied = await dispatchSessionAction(
      registry,
      'consent_deny',
      { requestId: 'nope' },
      { reload: () => ({}), shutdown: async () => ({}), httpBase: 'http://127.0.0.1:39877' },
    )
    expect(denied.status).toBe(404)
    expect(denied.body.code).toBe('consent_missing')
  })

  it('the tool receipt shows the human the exact command to run', () => {
    const text = formatConsent({
      code: 'consent_required',
      request_id: 'req-1',
      evidence: { policy: 'ask' },
      human_action: {
        approve:
          'curl.exe -s "http://127.0.0.1:39877/lease?action=consent_approve&requestId=req-1"',
        deny: 'curl.exe -s "http://127.0.0.1:39877/lease?action=consent_deny&requestId=req-1"',
      },
    })
    expect(text).toContain('req-1')
    expect(text).toContain('consent_approve')
    expect(text).toContain('再调一次 blender_session action=start')
  })

  it('a stale or foreign request id cannot be approved', async () => {
    const registry = consentRegistry()
    const r = await registry.start(main(), { kind: 'virtual-gui' })
    if (r.ok) throw new Error('expected consent_required')
    const approved = registry.approveConsent('00000000-0000-0000-0000-000000000000', 'human')
    expect(approved.ok).toBe(false)
    if (approved.ok) return
    expect(approved.code).toBe('consent_missing')
  })
})
