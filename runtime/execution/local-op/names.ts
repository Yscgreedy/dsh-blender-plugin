// 无 GUI 本地车道的**名字**白名单（纯常量，无 import）。
//
// 单独放一个文件是为了让 catalog（runtime/core/output/render.ts）能判断
// "这个 op 能否 headless"而**不引入** table.ts → dispatcher/plan-call.ts → output 的循环。
// 真正的调用形态（api/preload/mode）仍只在 table.ts 里由 generated routing 表推导。
export const LOCAL_OP_NAMES: readonly string[] = [
  'audit_mesh',
  'img_digest',
  'img_probe',
  'img_measure',
  'img_calib',
  'visualreport_report',
  'qc_render_views',
  'montage',
]

/** img_ 全族共用同一条车道（同一路由行、同一 preload 模块）。 */
export const LOCAL_OP_PREFIXES: readonly string[] = ['img_']

/** 只做名字判定：是否属于本地无头车道的白名单。 */
export function isLocalOpName(op: unknown): boolean {
  const name = String(op === undefined || op === null ? '' : op).trim()
  if (!name) return false
  if (LOCAL_OP_NAMES.includes(name)) return true
  return LOCAL_OP_PREFIXES.some((prefix) => name.startsWith(prefix))
}
