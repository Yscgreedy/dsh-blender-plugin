/**
 * runtime-bridge：src 侧对编译产物 lib/runtime/*.js 的唯一入口。
 * 为什么需要桥：src 是 TypeScript 插件层，runtime 是独立编译的 Blender 侧宿主层；
 * 两层的模块格式/发布布局不同（src 构建到 lib，runtime 构建到 lib/runtime）。
 * 原来 4 个 src 文件各自直 import '../../lib/runtime/*.js' —— 目录搬迁/发布布局变化
 * 会散落修改。集中到本文件后，src 内只允许通过 host/runtime-bridge.ts 触碰 runtime 层。
 */
export { probeHttp, waitHttp, decideStart } from '../../lib/runtime/backend_probe.js'
export { winKillPids, winSamePortHolders } from '../../lib/runtime/win_proc.js'
export { detectFileAlias } from '../../lib/runtime/file_guard.js'
export { serverPidsFromProcRows } from '../../lib/runtime/ports.js'
// H1：宿主层清单。扫描/哈希规则只有一套（runtime/core/layers.ts），宿主与 Gateway 共用 ——
// 不允许在 src 里再写第二套，否则两层会各自「自证」成 current。
export {
  scanLayer,
  writeHostManifest,
  forgetHostManifest,
  LAYER_SCHEMA,
  HOST_LAYER_SKIP,
  HOST_MANIFEST_ENV,
} from '../../lib/runtime/core/layers.js'
export type { LayerManifest, HostManifestMeta } from '../../lib/runtime/core/layers.js'
// H2：reload 回执结构 + 两次落盘的状态文件。宿主只做「动作」，结构与语义只有这一份
// （runtime/core/hot-reload.ts / reload-state.ts），工具面与 HTTP 面因此天然同构。
export {
  emptyReloadReport,
  hotReloadView,
  decideReloadMode,
  splitChanged,
  classifyChangedPath,
  reloadNeedsRestart,
} from '../../lib/runtime/core/hot-reload.js'
export type {
  ReloadReport,
  ReloadMode,
  ReloadChanged,
  ReloadCount,
} from '../../lib/runtime/core/hot-reload.js'
export {
  readReloadState,
  writeReloadState,
  settleReloadState,
  reloadStatePath,
} from '../../lib/runtime/core/reload-state.js'
export type { ReloadState } from '../../lib/runtime/core/reload-state.js'
