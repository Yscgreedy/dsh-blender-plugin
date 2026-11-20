/**
 * 契约：/status?evidence=1&evidenceOnly=1 的 local_evidence 形状（验收口径 v2），
 * 以及 addon 视图必须取自与 status 同一个 client（E.addon），不能是空壳。
 */
import { describe, expect, it } from 'vitest'
import { createHealthRoutes } from '../../../runtime/http/routes/health.js'

interface Captured {
  code: number
  body: Record<string, unknown> | null
}

function routesWith(addonClient: unknown, sessions: unknown[] = []) {
  const captured: Captured = { code: 0, body: null }
  const json = (_res: unknown, code: number, body: unknown) => {
    captured.code = code
    captured.body = body as Record<string, unknown>
  }
  const E = {
    PORT: 39877,
    engine: {
      addon: addonClient,
      status: async () => ({}),
      metrics: () => ({}),
      doctor: async () => ({ ok: false, kind: 'no-addon' }),
    },
    addon: addonClient,
    sessionRegistry: { list: () => sessions },
    json,
    leaseView: () => ({}),
    reqCounts: new Map(),
    rttView: () => ({}),
    stats: { startedAt: Date.now() },
    engineProvenance: () => ({}),
  }
  return { routes: createHealthRoutes(E as never), captured }
}

const addonClient = {
  instances: [
    {
      instanceId: 'db7bf4af',
      ready: true,
      kind: 'user-gui',
      version: '2.0.0',
      protocol: 12,
      project: 'untitled',
      capabilities: [],
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      epoch: 1,
    },
  ],
}

describe('evidence contract', () => {
  it('returns sessions/local_processes/ports/ports_evidence with scanned_at', async () => {
    const { routes, captured } = routesWith(addonClient, [])
    await routes.status(
      {} as never,
      {} as never,
      new URL('http://127.0.0.1:39877/status?evidence=1&evidenceOnly=1'),
      '',
    )
    const body = captured.body as Record<string, unknown>
    const evidence = body.local_evidence as Record<string, unknown>
    expect(Array.isArray(evidence.sessions)).toBe(true)
    expect(evidence.sessions).toHaveLength(0)
    expect(Array.isArray(evidence.local_processes)).toBe(true)
    expect(Array.isArray(evidence.ports)).toBe(true)
    expect(evidence.ports).toHaveLength(3)
    for (const row of evidence.ports as Array<Record<string, unknown>>) {
      expect(Array.isArray(row.pids)).toBe(true)
      expect(Array.isArray(row.pids_raw)).toBe(true)
      expect(['fixture', 'live']).toContain(String(row.mode))
    }
    const portsEvidence = evidence.ports_evidence as Record<string, unknown>
    expect(['netstat', 'fixture', 'ps', 'lsof', 'ss', 'unavailable']).toContain(
      String(portsEvidence.source),
    )
    expect(String(portsEvidence.scanned_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof evidence.degraded).toBe('boolean')
  })

  it('takes the addon view from the same client as status', async () => {
    const { routes, captured } = routesWith(addonClient, [])
    await routes.status(
      {} as never,
      {} as never,
      new URL('http://127.0.0.1:39877/status?evidence=1&evidenceOnly=1'),
      '',
    )
    const body = captured.body as Record<string, unknown>
    const addon = body.addon as Record<string, unknown>
    expect(addon.connected).toBe(true)
    expect(addon.ready_instances).toBe(1)
    expect(addon.instanceId).toBe('db7bf4af')
    expect((body.next_actions as string[])[0]).toContain(
      'blender_session action=attach instance_id=db7bf4af',
    )
  })

  it('says addon unknown/absent honestly when no instance exists', async () => {
    const { routes, captured } = routesWith({ instances: [] }, [])
    await routes.status(
      {} as never,
      {} as never,
      new URL('http://127.0.0.1:39877/status?evidence=1&evidenceOnly=1'),
      '',
    )
    const addon = (captured.body as Record<string, unknown>).addon as Record<string, unknown>
    expect(addon.connected).toBe(false)
    expect(addon.ready_instances).toBe(0)
  })
})
