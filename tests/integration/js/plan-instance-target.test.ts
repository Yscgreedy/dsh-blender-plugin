/**
 * 3.1 multi-instance: a plan op must reach the caller's own Blender (§13.3 ②).
 *
 * With two instances connected the transport refuses an unqualified call, and the
 * host used to send every plan op unqualified — so the whole plan surface died
 * until someone closed a Blender window. The Gateway now targets the instance of
 * the caller's session, and `instance_id` in the payload overrides it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { startBackend } from '../../helpers/backend'
import { startFakeWsAddon } from '../../helpers/fake-ws-addon.mjs'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) {
    const close = closers.pop()!
    try {
      await close()
    } catch {
      /* best effort */
    }
  }
})

function headers(dshSessionId = 'dsh-1', agentId = 'agent-main') {
  return {
    'x-dsh-host-id': 'host-it',
    'x-dsh-session-id': dshSessionId,
    'x-dsh-agent-id': agentId,
    'x-dsh-agent-role': 'main',
  }
}

/**
 * Every fake addon answers the kernel injection marker plus a LOOP payload naming
 * itself. execute_code replies in the addon's own shape — `{executed, result}`
 * inside the envelope result (extension/…/commands/core/__init__.py) — because the
 * injection probe reads `result` out of a *string* payload.
 */
const behavior = (instanceId: string) => (type: string) =>
  type === 'execute_code'
    ? {
        status: 'success',
        result: {
          executed: true,
          result: 'GEO_READY v1\nLOOP {"ok": true, "via": "' + instanceId + '"}',
        },
      }
    : { status: 'success', result: { type } }

async function setup(instanceIds: string[]) {
  const backend = await startBackend({})
  closers.push(() => backend.stop())
  const addons: Array<{
    instanceId: string
    requests: Array<{ type: string; params: Record<string, unknown> }>
    close: () => Promise<void>
  }> = []
  for (const instanceId of instanceIds) {
    const addon = await startFakeWsAddon({
      gatewayPort: backend.port,
      instanceId,
      behavior: behavior(instanceId),
    })
    await addon.ready
    addons.push(addon as never)
    closers.push(() => addon.close())
  }
  return { backend, addons }
}

describe('plan op instance targeting (two Blenders connected)', () => {
  it('drives the caller session instance without the transport ambiguity error', async () => {
    const { backend, addons } = await setup(['inst-1', 'inst-2'])
    const attach = await backend.post(
      '/lease',
      { action: 'attach', instanceId: 'inst-1' },
      headers(),
    )
    expect(attach.status).toBe(200)
    const secondBefore = addons[1]!.requests.length

    const plan = await backend.post('/plan', { op: 'geo_selftest', args: {} }, headers())
    console.log('PLAN1', JSON.stringify(plan.json).slice(0, 600))

    expect(plan.status).toBe(200)
    expect(plan.json.ok).toBe(true)
    expect(plan.json.result).toMatchObject({ ok: true, via: 'inst-1' })
    // The other Blender saw nothing: no cross-driving, no ambiguity fallback.
    expect(addons[1]!.requests.length).toBe(secondBefore)
  })

  it('honours an explicit instance_id over the caller session instance', async () => {
    const { backend, addons } = await setup(['inst-1', 'inst-2'])
    expect(
      (await backend.post('/lease', { action: 'attach', instanceId: 'inst-1' }, headers())).status,
    ).toBe(200)
    const firstBefore = addons[0]!.requests.length

    const plan = await backend.post(
      '/plan',
      { op: 'geo_selftest', args: {}, instance_id: 'inst-2' },
      headers(),
    )

    expect(plan.status).toBe(200)
    expect(plan.json.ok).toBe(true)
    expect(plan.json.result).toMatchObject({ via: 'inst-2' })
    expect(addons[0]!.requests.length).toBe(firstBefore)
  })

  it('still reports the ambiguity when the caller owns nothing and names no instance', async () => {
    const { backend } = await setup(['inst-1', 'inst-2'])
    const plan = await backend.post('/plan', { op: 'geo_selftest', args: {} }, headers())
    console.log('PLAN3', plan.status, JSON.stringify(plan.json).slice(0, 600))
    expect(plan.status).toBe(200)
    expect(plan.json.ok).toBe(false)
    expect(String(plan.json.error)).toContain('instanceId')
  })
})
