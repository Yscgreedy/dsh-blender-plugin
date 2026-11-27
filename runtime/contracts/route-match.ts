// 生成路由表（runtime/contracts/routes.generated.ts）的匹配口径。
//
// 纯函数，只依赖 GuiRoute 类型：dispatch 层与无 GUI 本地车道（execution/local-op）
// 用同一套匹配规则，执行层因此不必 import core/dispatcher。
import type { GuiRoute } from './routes.generated.js'

/** 生成表共用的匹配/切片口径：exact 行按 op 全等，prefix 行按前缀命中。 */
export function routeMatches(route: GuiRoute, o: string): boolean {
  return route.match === 'exact' ? o === route.op : o.indexOf(route.prefix) === 0
}
