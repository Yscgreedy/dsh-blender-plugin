// plan/qc/audit 前缀路由（由 config/routing.json 生成表驱动）
import { WIN_TMP, blenderJoin } from '../../paths.js'
import { extractLoop } from '../../foundation/output/index.js'
import { KERNEL_BOOTSTRAP } from '../../foundation/kernel/index.js'
import { normalizeSelftestReceipt } from '../selftest.js'
import type { PlanCallDeps } from './index.js'
import { MAIN_ROUTES, MODULE_ROUTES } from '../../contracts/routes.generated.js'
import type { GuiRoute } from '../../contracts/routes.generated.js'
import { routeMatches } from '../../contracts/route-match.js'

export type RouteDecision = { matched: true; result: Promise<unknown> } | { matched: false }

export const hit = (result: unknown): RouteDecision => ({
  matched: true,
  result: Promise.resolve(result),
})
export const miss = (): RouteDecision => ({ matched: false })

/** evidence：先注入默认 view.path 再走契约层 */
export async function prepareEvidencePayload(
  E: PlanCallDeps,
  o: string,
  payload: unknown,
): Promise<unknown> {
  if (o !== 'evidence') return payload
  await E.ensureView()
  const { SESSION_NAME } = E
  const p: Record<string, unknown> =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const viewRec: Record<string, unknown> =
    p.view !== null && typeof p.view === 'object' ? (p.view as Record<string, unknown>) : {}
  if (!viewRec.path)
    viewRec.path = blenderJoin(
      WIN_TMP,
      'dsh_evidence_' + SESSION_NAME.replace(/[^A-Za-z0-9_.-]/g, '_') + '.png',
    )
  p.view = viewRec
  return p
}

/** 通用：把 op 派给 Blender 侧内核模块的 dispatch(op, json) */
export async function dispatchViaKernelModule(
  E: PlanCallDeps,
  ensure: () => Promise<unknown>,
  api: string,
  subOp: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  await ensure()
  const body =
    'print("LOOP " + K.' +
    api +
    '["dispatch"](' +
    JSON.stringify(subOp) +
    ', _json.dumps(_json.loads(' +
    JSON.stringify(JSON.stringify(payload || {})) +
    '))))'
  return extractLoop(
    await E.addon.send(
      'execute_code',
      { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body },
      timeoutMs,
    ),
  )
}

/** 固定 sub（别名）优先；否则按表里的 strip 长度从 op 上切掉前缀。 */
function routeSubOp(route: GuiRoute, o: string): string {
  return route.sub === null ? o.slice(route.strip) : route.sub
}

async function handleQcRender(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  const p: Record<string, unknown> =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  if (p.asJob) {
    const { preloadChunk, jobStart } = E
    const mods = String(route.preload || 'qc,qc_render')
      .split(',')
      .map(preloadChunk)
      .join(String.fromCharCode(10))
    const driver =
      'import json as _json' +
      String.fromCharCode(10) +
      'print("HEADLESS " + K.' +
      route.api +
      '["render_views"](_json.loads(' +
      JSON.stringify(JSON.stringify(p)) +
      ')))'
    const j = jobStart({
      file: p.file,
      outdir: p.outdir || WIN_TMP,
      engine: p.engine && String(p.engine) !== 'keep' ? String(p.engine) : 'eevee',
      timeoutMs: Number(p.timeoutMs) || 3600000,
      script: mods + String.fromCharCode(10) + driver,
    })
    return {
      ok: true,
      mode: 'job',
      jobId: j.id,
      ms: 0,
      outdir: j.outdir,
      logDir: j.logDir,
      jsonl: blenderJoin(String(p.outdir || WIN_TMP), 'render_views.jsonl'),
      job: j,
      hint:
        '长活已转作业层：blender_run(action=""status"/"collect", id="' +
        j.id +
        '") 跟进；产物与日志在 outdir/jobs/ 下',
    }
  }
  return dispatchViaKernelModule(
    E,
    E[route.ensure],
    route.api,
    routeSubOp(route, o),
    p,
    route.timeoutMs,
  )
}

/**
 * montage：`K.dsh_montage_api["montage"](paths, cols, tile, out, labels, grid, scale_m)` 返回的是
 * **dict**（不是 dispatch 那种 JSON 字符串），所以不能写字面量拼接 —— 那是
 * `TypeError: can only concatenate str (not "dict") to str`（现场 P1-7：montage 整族必死，
 * 连同 montage_help）。这里显式 dumps，并且只解一层 payload。
 */
async function handleMontage(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  await E[route.ensure]()
  // montage 族的 route 是 prefix=montage / strip=0 ⇒ 到这里 op 还是全名：montage / montage_help / montage_selftest
  const raw = (o || '').slice(route.strip) || 'montage'
  const sub = raw.indexOf('montage_') === 0 ? raw.slice('montage_'.length) : raw
  const body = [
    'import json as _json',
    'A = K.' + route.api,
    'N = ' + JSON.stringify(sub),
    'P = _json.loads(' + JSON.stringify(JSON.stringify(payload || {})) + ')',
    'if isinstance(P, dict) and isinstance(P.get("args"), dict): P = P["args"]',
    'if isinstance(P, dict) and "paths" not in P and isinstance(P.get("files"), (list, str)): P["paths"] = P["files"]',
    'if N not in A:',
    '    R = {"ok": False, "error": "unknown montage op", "op": N, "ops": sorted(_k for _k in A if not _k.startswith("_"))}',
    'else:',
    '    R = A[N](**P) if isinstance(P, dict) else A[N](P)',
    'print("LOOP " + (_json.dumps(R, ensure_ascii=False, default=str) if not isinstance(R, str) else R))',
  ].join(String.fromCharCode(10))
  return extractLoop(
    await E.addon.send(
      'execute_code',
      { code: KERNEL_BOOTSTRAP + String.fromCharCode(10) + body },
      route.timeoutMs,
    ),
  )
}

/** motion_/deliver_ 的模块 API 不是统一 dispatch，需要按函数名直调。 */
async function handleModuleAlias(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  await E[route.ensure]()
  const name = o.slice(route.strip)
  const body = [
    'import json as _json',
    'A = K.' + route.api,
    'P = _json.loads(' + JSON.stringify(JSON.stringify(payload || {})) + ')',
    'if isinstance(P, dict) and isinstance(P.get("args"), dict): P = P["args"]',
    'print("LOOP " + (A["dispatch"](' +
      JSON.stringify(name) +
      ', _json.dumps(P)) if A.get("dispatch") else A[' +
      JSON.stringify(name) +
      '](**P)))',
  ].join(String.fromCharCode(10))
  return extractLoop(
    await E.addon.send('execute_code', { code: KERNEL_BOOTSTRAP + '\n' + body }, route.timeoutMs),
  )
}

/** gui_* 走 dsh_view_api 的直调入口（名字固定带 gui_ 前缀）。 */
async function handleView(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  await E[route.ensure]()
  const name = 'gui_' + o.slice(route.strip)
  const body =
    'print("LOOP " + K.' +
    route.api +
    '[' +
    JSON.stringify(name) +
    '](**_json.loads(' +
    JSON.stringify(JSON.stringify(payload || {})) +
    ')))'
  return extractLoop(
    await E.addon.send(
      'execute_code',
      { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body },
      route.timeoutMs,
    ),
  )
}

/** render_* 的锁查询别名（render_lock_status -> status）在 routing.json 里显式声明。 */
async function handleRender(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  await E[route.ensure]()
  const rest = o.slice(route.strip)
  const sub = route.subAliases[rest] || rest
  const body =
    'print("LOOP " + K.' +
    route.api +
    '["dispatch"](' +
    JSON.stringify(sub) +
    ', _json.dumps(_json.loads(' +
    JSON.stringify(JSON.stringify(payload || {})) +
    '))))'
  return extractLoop(
    await E.addon.send(
      'execute_code',
      { code: KERNEL_BOOTSTRAP + '\nimport json as _json\n' + body },
      route.timeoutMs,
    ),
  )
}

/** 按生成行的 kind 选择调用形态；api/strip/sub/preload/timeout 一律来自 config/routing.json。 */
export async function handleRoute(
  E: PlanCallDeps,
  route: GuiRoute,
  o: string,
  payload: unknown,
): Promise<unknown> {
  switch (route.kind) {
    case 'qc-render':
      return handleQcRender(E, route, o, payload)
    case 'montage':
      return handleMontage(E, route, o, payload)
    case 'motion':
    case 'deliver':
      return handleModuleAlias(E, route, o, payload)
    case 'view':
      return handleView(E, route, o, payload)
    case 'render':
      return handleRender(E, route, o, payload)
    default:
      return dispatchViaKernelModule(
        E,
        E[route.ensure],
        route.api,
        routeSubOp(route, o),
        payload,
        route.timeoutMs,
      )
  }
}

async function routeTable(
  E: PlanCallDeps,
  o: string,
  payload: unknown,
  routes: readonly GuiRoute[],
): Promise<RouteDecision> {
  for (const route of routes) {
    if (!routeMatches(route, o)) continue
    return hit(normalizeSelftestReceipt(o, await handleRoute(E, route, o, payload)))
  }
  return miss()
}

export async function routeMainPlanOps(
  E: PlanCallDeps,
  o: string,
  payload: unknown,
): Promise<RouteDecision> {
  return routeTable(E, o, payload, MAIN_ROUTES)
}

export async function routeModulePlanOps(
  E: PlanCallDeps,
  o: string,
  payload: unknown,
): Promise<RouteDecision> {
  return routeTable(E, o, payload, MODULE_ROUTES)
}
