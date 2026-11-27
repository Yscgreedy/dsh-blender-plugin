import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../foundation/json.js'
import { shouldGateWrite } from '../write-skip.js'
// HTTP 路由 /opt：优化
export function createOptRoutes(E: HttpRouteDeps) {
  const { engine, json, leaseGate, readBody, stats } = E
  return {
    async opt(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      const raw = await readBody(req)
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw)
      } catch (e) {
        payload = {}
      }
      const op = String(payload.op || 'opt_analyze')
      const gate = shouldGateWrite('/opt', payload) ? leaseGate(payload) : null
      if (gate) {
        json(res, 409, gate)
        return
      }
      stats.opt = (stats.opt || 0) + 1
      try {
        const out = await engine.opt(op, payload.args)
        json(res, 200, { ok: true, op: op, result: out })
      } catch (e) {
        json(res, 200, {
          ok: false,
          op: op,
          error: errorMessage(e),
          diagnosis: errorField(e, 'diagnosis') || null,
        })
      }
      return
    },
  }
}
