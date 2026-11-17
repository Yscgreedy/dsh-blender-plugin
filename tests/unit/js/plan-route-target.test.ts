/**
 * 3.1 multi-instance: the /plan route decides which Blender a plan op drives.
 *
 * The router resolves the caller's own session instance once per request; a
 * payload-level `instance_id` overrides it. Without one of the two, every plan op
 * fails with the transport ambiguity error while two Blenders are connected.
 */
import { describe, expect, it } from 'vitest'
import { createPlanRoutes } from '../../../runtime/http/routes/plan.js'
import type { HttpRouteDeps } from '../../../runtime/http/routes/deps.js'
import { currentInstanceId, runWithInstance } from '../../../runtime/transport/instance-target.js'

interface Harness {
  seen: Array<string | null>
  body: Record<string, unknown>
}

async function callPlan(payload: Record<string, unknown>): Promise<Harness> {
  const seen: Array<string | null> = []
  let body: Record<string, unknown> = {}
  const routes = createPlanRoutes({
    engine: {
      plan: async () => {
        seen.push(currentInstanceId())
        return { ok: true }
      },
    },
    isReadOnly: () => true,
    leaseGate: () => null,
    readBody: async () => JSON.stringify(payload),
    json: (_res: unknown, _code: number, obj: unknown) => {
      body = obj as Record<string, unknown>
    },
    pushRtt: () => {},
    stats: {},
  } as unknown as HttpRouteDeps)
  await routes.plan({} as never, {} as never, new URL('http://127.0.0.1/plan'), '/plan')
  return { seen, body }
}

describe('/plan instance targeting', () => {
  it('keeps the request target the router resolved', async () => {
    const { seen } = await runWithInstance('inst-1', () => callPlan({ op: 'geo_selftest' }))
    expect(seen).toEqual(['inst-1'])
  })

  it('lets a payload instance_id override the request target', async () => {
    const { seen, body } = await runWithInstance('inst-1', () =>
      callPlan({ op: 'geo_selftest', instance_id: 'inst-2' }),
    )
    expect(seen).toEqual(['inst-2'])
    expect(body.ok).toBe(true)
  })

  it('accepts the camelCase instanceId spelling too', async () => {
    const { seen } = await runWithInstance('inst-1', () =>
      callPlan({ op: 'geo_selftest', instanceId: 'inst-2' }),
    )
    expect(seen).toEqual(['inst-2'])
  })

  it('passes no target through when nothing named one', async () => {
    const { seen } = await callPlan({ op: 'geo_selftest' })
    expect(seen).toEqual([null])
  })
})
