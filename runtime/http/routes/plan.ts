import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../core/json.js'
import { runWithInstance } from '../../transport/instance-target.js'
import { targetAmbiguity } from '../target.js'
// HTTP 路由 /plan：契约层/规划器/catalog
export function createPlanRoutes(E: HttpRouteDeps) {
  const { engine, isReadOnly, json, leaseGate, pushRtt, readBody, sessionRegistry, stats } = E
  return {
    async plan(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      // 契约层与规划器统一入口：op + args
      const raw = await readBody(req)
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw)
      } catch (e) {
        payload = {}
      }
      const op = String(payload.op || 'status')
      // 多实例：没点名 instance_id、调用方也没有会话时，"驱动哪台"是没定的。
      // 先按实例表说清楚（不执行任何 Blender 调用），别把它伪装成 session_unavailable。
      if (!isReadOnly('/plan', op)) {
        const ready = sessionRegistry ? sessionRegistry.readyInstanceIds() : []
        const ambiguous = targetAmbiguity(op, payload, ready)
        if (ambiguous) {
          json(res, 200, ambiguous)
          return
        }
      }
      const gate = isReadOnly('/plan', op) ? null : leaseGate(payload)
      if (gate) {
        json(res, 409, gate)
        return
      }
      stats.plan = (stats.plan || 0) + 1
      const t0p = Date.now()
      // 多实例：payload.instance_id 显式点名实例时它压过调用方会话的默认目标；
      // 省略（空串）时 runWithInstance 不换上下文，router 定的目标实例继续生效。
      const instanceId = String(payload.instance_id ?? payload.instanceId ?? '')
      try {
        const out2 = await runWithInstance(instanceId, () => engine.plan(op, payload.args || {}))
        stats.lastPlanMs = Date.now() - t0p
        pushRtt('plan', stats.lastPlanMs)
        json(res, 200, { ok: true, op: op, result: out2 })
      } catch (e) {
        stats.lastError = errorMessage(e)
        json(res, 200, {
          ok: false,
          op: op,
          error: stats.lastError,
          diagnosis: errorField(e, 'diagnosis') || null,
        })
      }
      return
    },
  }
}
