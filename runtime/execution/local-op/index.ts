// 无 GUI 本地车道（作业侧）：op 名 → preload 模块 + Python API 调用 + 回执语义。
export {
  LOCAL_OP_NAMES,
  LOCAL_OP_PREFIXES,
  isLocalOp,
  localOpRoute,
  localOpTarget,
} from './table.js'
export type { LocalOpMode, LocalOpTarget } from './table.js'
export { buildLocalOpJob, driverSource, DRIVER_FILE } from './driver.js'
export type { LocalOpJob } from './driver.js'
