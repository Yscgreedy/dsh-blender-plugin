// HTTP 路由分发：注册表匹配 → 处理器；未命中 404，处理器抛错 500。
// 匹配顺序由 routes/index.mjs 的数组顺序决定（与拆分前 if 链顺序一致）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from './response.js'
import { errorDetail } from '../foundation/json.js'
import { callerFromRequest, runWithCaller } from './caller.js'
import { callerInstanceId } from './target.js'
import { runWithInstance } from '../transport/instance-target.js'
import type { SessionRegistry } from '../core/sessions/registry.js'

export interface RouteDef {
  method?: string | null
  paths?: string[]
  exact?: string
  prefix?: string
  fn: (req: IncomingMessage, res: ServerResponse, url: URL, p: string) => Promise<unknown> | unknown
}
export interface RouterDeps {
  HOST: string
  PORT: number
  bump: (p: string) => void
  routes: RouteDef[]
  /** Gateway 装配好的会话注册表：调用方会话 → 目标 Blender 实例。 */
  sessionRegistry?: SessionRegistry | null
}
export function createRouter(E: RouterDeps) {
  const routes = E.routes
  return async function router(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://' + E.HOST + ':' + String(E.PORT))
    const p = url.pathname
    E.bump(p)
    try {
      for (const r of routes) {
        if (r.method && req.method !== r.method) continue
        const matched = r.paths
          ? r.paths.indexOf(p) >= 0
          : p === r.exact || (r.prefix && p.startsWith(r.prefix))
        if (!matched) continue
        const caller = callerFromRequest(req)
        // 3.1 多实例：把"这次请求该驱动哪个 Blender"一次定下来（调用方会话的实例），
        // 否则 addon.send 省略 instanceId 时会报 ambiguity，plan op 直接变成死路。
        const target = callerInstanceId(caller, E.sessionRegistry ?? null)
        await runWithCaller(caller, () => runWithInstance(target, () => r.fn(req, res, url, p)))
        return
      }
      json(res, 404, { ok: false, error: 'not found', path: p })
    } catch (e) {
      json(res, 500, { ok: false, error: errorDetail(e) })
    }
  }
}
