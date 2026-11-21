// 无 GUI 本地车道：哪些 op 能在没有 GUI 会话时带 file 交给 headless 作业。
//
// 这是**窄车道**：名字来自需求清单（audit_mesh / img_* / visualreport_report /
// qc_render_views / montage）。API 属性、子操作名与 preload 模块一律从
// runtime/core/dispatcher/routes.generated.ts（config/routing.json 生成）里取，
// 本文件不维护第二份映射表 —— 路由改了，车道跟着改；对拍断言在
// tests/unit/js/op-local-lane.test.ts。
import { EXT_ROUTES, MAIN_ROUTES, MODULE_ROUTES } from '../../core/dispatcher/routes.generated.js'
import type { GuiRoute } from '../../core/dispatcher/routes.generated.js'
import { routeMatches } from '../../core/dispatcher/plan-call.js'
import { isLocalOpName } from './names.js'

export { LOCAL_OP_NAMES, LOCAL_OP_PREFIXES, isLocalOpName } from './names.js'

/** routing.json 的 montage 行走显式 API 调用，那一行没有 preload 字段。 */
const MODULE_BY_KIND: Record<string, readonly string[]> = { montage: ['montage'] }

/** 车道里的调用形态：dispatch(op, json) 或 montage 的显式函数调用。 */
export type LocalOpMode = 'dispatch' | 'montage'

export interface LocalOpTarget {
  op: string
  mode: LocalOpMode
  api: string
  sub: string
  preload: readonly string[]
}

const ALL_ROUTES: readonly GuiRoute[] = [...MAIN_ROUTES, ...MODULE_ROUTES, ...EXT_ROUTES]

/**
 * 车道是否覆盖这个 op。
 *
 * 只做名字判定，不看 file / 会话 —— "要不要真的转作业"由调用方（宿主工具）决定，
 * 后端只负责把活干对。
 */
export function isLocalOp(op: unknown): boolean {
  return isLocalOpName(op)
}

/** 路由行（按 generated 表的顺序匹配，与 /plan 的派发口径一致）。 */
export function localOpRoute(op: unknown): GuiRoute | null {
  const name = String(op === undefined || op === null ? '' : op).trim()
  if (!name) return null
  for (const route of ALL_ROUTES) if (routeMatches(route, name)) return route
  return null
}

function modeOf(route: GuiRoute): LocalOpMode | null {
  if (route.kind === 'dispatch' || route.kind === 'qc-render') return 'dispatch'
  if (route.kind === 'montage') return 'montage'
  return null
}

/** 子操作名：别名优先，否则按表的 strip 长度切前缀（montage 另有 montage_ 子名）。 */
function subOf(route: GuiRoute, op: string): string {
  if (route.sub) return route.sub
  const raw = op.slice(route.strip) || op
  if (route.kind === 'montage' && raw.startsWith('montage_')) return raw.slice('montage_'.length)
  return raw
}

function preloadOf(route: GuiRoute): string[] {
  const declared = String(route.preload || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (declared.length) return declared
  return [...(MODULE_BY_KIND[route.kind] || [])]
}

/** op → 调用目标（不认识 / 调用形态不支持时 null）。 */
export function localOpTarget(op: unknown): LocalOpTarget | null {
  const name = String(op === undefined || op === null ? '' : op).trim()
  if (!isLocalOp(name)) return null
  const route = localOpRoute(name)
  if (!route) return null
  const mode = modeOf(route)
  if (!mode) return null
  return { op: name, mode, api: route.api, sub: subOf(route, name), preload: preloadOf(route) }
}
