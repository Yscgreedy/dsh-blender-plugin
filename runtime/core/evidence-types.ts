import type { DiskCatalog } from '../catalog/index.js'

export interface EngineSelf {
  sourcePath: string
  loadedAt: number
  loadedAtText: string
  loadedHash: string | null
  loadedBytes: number | null
  error: string | null
}
export interface PathWarning {
  code: string
  evidence?: string
  value?: string
  hint?: string
  [k: string]: unknown
}
export interface DiskVerdict {
  ok: boolean
  note?: string
  matchesLoadedCatalog?: boolean
  families?: number
  opsCount?: number
  catalogHash?: string
  pluginVersion?: unknown
}
/** 单层判定：一层（host 或 runtime）的「已装载 vs 磁盘现况」。 */
export interface LayerVerdict {
  loadedHash: string | null
  currentHash: string | null
  verdict: 'current' | 'stale' | 'unknown'
}

/**
 * 宿主层聚合指纹（H1）。
 *
 * 存在的理由：旧实现只比对 lib/runtime/engine.js —— 改 lib/constants.js / lib/tools/**
 * 它照样回 current，下游只能拿 gateway.pid 猜。宿主层是「插件整代」里另一半，
 * 必须同样自证：聚合 sha256:12 + 差异清单，判定与运行时层合成到顶层 verdict。
 */
export interface HostLayerProvenance extends LayerVerdict {
  /** 宿主层根目录（<pkg>/lib）；找不到目录时 null */
  root: string | null
  /** 被计入的路径范围（人读的一句话） */
  scope: string
  /**
   * 「已装载」这一侧的来源（H1 修复的关键字段）：
   * - manifest = 宿主插件装载那一刻写的清单（DSH_BLENDER_HOST_MANIFEST）→ 可信
   * - self     = Gateway 启动时扫的盘（旧实现）→ 降级，note 里会写清
   * - none     = 两侧都拿不到（未构建/隔离副本）→ unknown，不冒充 current
   */
  source: 'manifest' | 'self' | 'none'
  /** 已装载侧的捕获时间（manifest 由宿主写，self 是本进程模块求值时刻） */
  loadedAt: string | null
  loadedFileCount: number
  fileCount: number
  /** 磁盘与已装载不一致的相对路径（≤20 条；超出部分看 changedCount） */
  changedFiles: string[]
  changedCount: number
  truncated: boolean
  note: string
}

export interface Provenance {
  sourcePath: string
  pluginVersion: string | null
  hashAlgo: string
  loadedAt: string
  loadedHash: string | null
  loadedBytes: number | null
  loadedReadError: string | null
  currentHash: string | null
  currentBytes: number | null
  currentMtime: string | null
  verdict: 'current' | 'stale' | 'unknown'
  stale: boolean | null
  staleReason: string | null
  /** 顶层 verdict 由哪几层 stale 合成（H1：任一层 stale 即 stale） */
  staleLayer: ('host' | 'runtime')[]
  /** 运行时层（Gateway 自己跑的那一层）单层判定 */
  runtime: LayerVerdict
  /** 宿主层聚合判定（H1） */
  host: HostLayerProvenance
  catalogHash: string
  families: number
  opsCount: number
  toolDetailKeys: number
  commandCatalogKeys: number
  note: string
  diskCatalog?: DiskCatalog
  diskVerdict?: DiskVerdict
}
