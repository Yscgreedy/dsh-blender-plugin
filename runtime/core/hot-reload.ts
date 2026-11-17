// 热更新（不重启 DSH）的**唯一能力声明 + 结果结构定义**。
//
// 背景（2026-11-16，下游 BlenderProject 实测）：DSH desktop 自带 @deepseek-ai/dsh-hmr，
// 改 profile 的 cordis.patch.yml 会触发一次 profile 重组合，把 profile 下磁盘已变的已加载插件
// 整代换掉（宿主进程不动）；插件 dispose 杀 Gateway 子进程，新 fiber 从磁盘重拉
// lib/runtime/gateway.js。于是有两条热更路径：
//
//   host 层变（lib/index.js、lib/tools/**…） → 宿主重组合（HMR），Gateway 随之换新
//   runtime 层变（lib/runtime/**）           → 只重启 Gateway 子进程
//
// 这个文件只做三件事：① 声明边界（H3 的 hotReload 表）② 把相对路径归到层（changed 清单）
// ③ 定义 reload 回执结构（工具面与 HTTP 面同构）。执行动作在宿主侧 src/host/reload/，
// 因为「重启 Gateway 子进程」只有宿主有句柄。

/** 可以热更生效的改动（H3 表的前四行）。 */
export const HOT_RELOAD_SUPPORTED: readonly string[] = [
  'lib/runtime/**（gateway.js / engine.js / .py 内核 / catalog 表）→ 重启 Gateway 子进程即可，不碰宿主',
  'lib/tools/**、lib/host/**、lib/plugin*.js、lib/constants.js、lib/contracts/** → 宿主重组合（HMR）；新工具名/参数建议刷新页面',
  'runtime/py/** 与 skills/**、docs/** → 下一次调用读盘（Python 内核按需装载，文本按需读取）',
  'extension/** → 与 DSH 无关：Blender 侧 Reload Scripts（或面板重新启用扩展）',
]

/**
 * reload 的**副作用**（不是"要不要重启"，而是"这一下会顺手收掉什么"）。
 *
 * H5 实测的痛点：reload 会把在跑作业置 canceled（Gateway 换代 → 作业是它的子进程），
 * 但上一版回执里什么都不说，用户以为作业还在跑。这行既是 H3 表的一行，
 * 也是 /status.hotReload.sideEffects 的原样内容。
 */
export const HOT_RELOAD_SIDE_EFFECTS: readonly string[] = [
  'reload 会取消在跑作业（headless / job 一律置 canceled）并停掉 virtual-gui 会话：长作业请避开热更窗口，或等 resume 能力；被取消的 id 在回执 jobsDropped 里，重跑请重新 submit',
]

/** 必须重启 DSH（或人工介入）的改动（H3 表的后两行）。 */
export const HOT_RELOAD_NEEDS_RESTART: readonly string[] = [
  'package.json 的 dependencies / peerDependencies / engines 变化：HMR 只报 pending，宿主依赖必须重启 DSH',
  'cordis.patch.yml 的加载结构变化（新增/删除插件 entry、bundle 列表）：profile 重组合后才定型，重组合失败要重启',
  '宿主 dsh 自身版本升级（@deepseek-ai/*）：插件与宿主同版本面，必须重启',
  '浏览器 client bundle（dsh-client-*）：与宿主热更是两套，走 dsh-client-hmr / 刷新页面',
]

export type ReloadMode = 'noop' | 'hmr' | 'gateway-restart' | 'unavailable'

export interface ReloadChanged {
  host: string[]
  runtime: string[]
  other: string[]
}

export interface ReloadCount {
  host: number
  runtime: number
  other: number
}

/**
 * reload 回执（工具面 blender_session action=reload 与 HTTP 面 POST /lease{action:reload} 同构）。
 *
 * mode=noop 的硬约束：**不动 pid**（不杀 Gateway、不写 profile patch）。
 */
export interface ReloadReport {
  ok: boolean
  mode: ReloadMode
  changed: ReloadChanged
  changedCount: ReloadCount
  pidBefore: number | null
  pidAfter: number | null
  verdict: 'current' | 'stale' | 'unknown'
  staleLayer: string[]
  /** 为什么还得重启（不可热更项 / 失败原因）；空数组 = 已经是最新代码 */
  needsRestart: string[]
  hotReload: { supported: string[]; needsRestart: string[] }
  layers: Record<string, unknown>
  /** reload 前被丢弃的作业 id（Gateway 重启会断 HTTP，作业是 Gateway 的子进程） */
  jobsDropped: string[]
  /** reload 前被停掉的会话 id（drain 回执的 stopped：helper + 隐藏 Blender 一并停） */
  stopped: string[]
  /** true = 触发已发出但尚未在等待窗口内观测到新进程（HMR 常见） */
  pending: boolean
  receipt: string | null
  ms: number
  note: string
  /**
   * 失败面的四问信封（与 availability 契约同构）：ok=false 时**必须**有，
   * 否则 HTTP 边缘的 normalizeAvailability 只能填一句 "request failed" ——
   * 下游与模型就再也看不到 mode=hmr 与「为什么必须重启」。
   */
  code?: string
  stage?: string
  root_cause?: string
  fix?: string
}

export function hotReloadView(): {
  supported: string[]
  needsRestart: string[]
  sideEffects: string[]
} {
  return {
    supported: [...HOT_RELOAD_SUPPORTED],
    needsRestart: [...HOT_RELOAD_NEEDS_RESTART],
    sideEffects: [...HOT_RELOAD_SIDE_EFFECTS],
  }
}

/**
 * 把一个相对包根的路径归到层。未命中的进 other（skills/docs/extension 之类不参与热更判定）。
 * 只吃 posix 相对路径（跨平台统一用 '/'）。
 */
export function classifyChangedPath(rel: string): 'host' | 'runtime' | 'other' {
  const p = String(rel || '')
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
  if (p.startsWith('lib/runtime/')) return 'runtime'
  if (p.startsWith('lib/')) return 'host'
  return 'other'
}

/** 按层拆分差异清单（每层最多 keep 条，计数仍是真实值）。 */
export function splitChanged(
  paths: readonly string[],
  keep = 20,
): { changed: ReloadChanged; count: ReloadCount } {
  const changed: ReloadChanged = { host: [], runtime: [], other: [] }
  const count: ReloadCount = { host: 0, runtime: 0, other: 0 }
  for (const raw of paths) {
    const layer = classifyChangedPath(raw)
    count[layer] += 1
    if (changed[layer].length < keep) changed[layer].push(String(raw).split('\\').join('/'))
  }
  return { changed, count }
}

/**
 * 模式判定（纯函数，也是契约用例的判据）：
 * - 两层都 current → noop（**不得**动 pid）
 * - 宿主层有变 → hmr（重组合会把 Gateway 一起换新）
 * - 只有运行时层有变 → gateway-restart
 */
export function decideReloadMode(input: {
  hostChanged: number
  runtimeStale: boolean
}): ReloadMode {
  if (input.hostChanged > 0) return 'hmr'
  if (input.runtimeStale) return 'gateway-restart'
  return 'noop'
}

/** 把「为什么还要重启」拼成给人看的一条（失败不静默）。 */
export function reloadNeedsRestart(reasons: readonly string[]): string[] {
  return reasons.map(String).filter(Boolean)
}

export function emptyReloadReport(over: Partial<ReloadReport> = {}): ReloadReport {
  return {
    ok: false,
    mode: 'unavailable',
    changed: { host: [], runtime: [], other: [] },
    changedCount: { host: 0, runtime: 0, other: 0 },
    pidBefore: null,
    pidAfter: null,
    verdict: 'unknown',
    staleLayer: [],
    needsRestart: [],
    hotReload: hotReloadView(),
    layers: {},
    jobsDropped: [],
    stopped: [],
    pending: false,
    receipt: null,
    ms: 0,
    note: '',
    ...over,
  }
}
