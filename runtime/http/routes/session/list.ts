// /session 路由：who（拆分）
//
// crew[] 的实现已下沉到 core/sessions/session-views.ts（台账 B：/who、/lease action=list
// 与 consent_panel 面板行共用同一份纯投影）—— 这里只把本 Gateway 的作业队列喂给它。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from '../deps.js'
import { currentCaller } from '../../caller.js'
import { crewRows } from '../../../core/sessions/session-views.js'

export function createWhoHandler(E: HttpRouteDeps) {
  const {
    PORT,
    describeConfig,
    engine,
    jobQueue,
    json,
    leaseView,
    reqCounts,
    sessionRegistry,
    stats,
  } = E
  return async function who(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    _p: string,
  ): Promise<void> {
    const caller = currentCaller()
    json(res, 200, {
      ok: true,
      sessions: crewRows(
        !sessionRegistry ? [] : caller ? sessionRegistry.listFor(caller) : sessionRegistry.list(),
        jobQueue,
      ),
      lease: leaseView(),
      metrics: engine.metrics(),
      stats: stats,
      config: describeConfig({ httpPort: PORT }),
      requests: Object.fromEntries(reqCounts),
    })
    return
  }
}
