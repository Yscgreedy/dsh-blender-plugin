// 版本/指纹自证、路径审计、场景卫生审计。ENGINE_SELF 指向 runtime/engine.ts 门面。
// @imports
import fs from 'node:fs'
import { IS_MAC, PKG_ROOT } from '../config.js'
import { createHash } from 'node:crypto'
import { catalogFingerprint, probeDiskCatalog } from '../catalog/index.js'
import type { CatalogFingerprint, DiskCatalog } from '../catalog/index.js'
import { pyModuleFile, pyModuleNames } from '../paths.js'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorMessage, errorCode } from './json.js'
// H1：宿主层「已装载」的权威来源（宿主写的清单）。扫描/哈希规则只有一套，就是这里。
import { hostLayerSnapshot } from './layers.js'
import type { LayerSnapshot } from './layers.js'

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_VERSION: string | null = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch (e) {
    return null
  }
})()
function sha12(buf: string | Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12)
}

/** 门面入口：构建布局 lib/runtime/engine.js 与源码布局下包内 lib/runtime/engine.js 的候选 */
export const ENGINE_SOURCE_PATH: string = (() => {
  const built = path.join(RUNTIME_DIR, 'engine.js')
  const fromPkg = path.resolve(RUNTIME_DIR, '..', 'lib', 'runtime', 'engine.js')
  for (const c of [built, fromPkg]) {
    try {
      if (fs.existsSync(c)) return c
    } catch (e) {
      /* ignore */
    }
  }
  return built
})()
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
const ENGINE_SELF: EngineSelf = (() => {
  const info: EngineSelf = {
    sourcePath: ENGINE_SOURCE_PATH,
    loadedAt: Date.now(),
    loadedAtText: '',
    loadedHash: null,
    loadedBytes: null,
    error: null,
  }
  info.loadedAtText = new Date(info.loadedAt).toISOString()
  try {
    const buf = fs.readFileSync(ENGINE_SOURCE_PATH)
    info.loadedHash = sha12(buf)
    info.loadedBytes = buf.length
  } catch (e) {
    info.error = errorMessage(e).slice(0, 200)
  }
  return info
})()

/* ────────────────────────────────────────────────────────────────────────────
 * H1：宿主层聚合指纹
 *
 * 范围 = <pkg>/lib 下除 lib/runtime/** 之外的全部 .js/.mjs/.cjs
 *        （lib/index.js、lib/constants.js、lib/plugin*.js、lib/tools/**、lib/host/**、
 *         lib/contracts/**、lib/plan/**、lib/ui/**、lib/tui/**、lib/utils/**、lib/headless/**）
 * 跳过 = lib/runtime/**（那是运行时层，由 engine.js 单点判定）、*.d.ts / *.map（类型与源图不是行为）、
 *        node_modules 与点目录（.build-ok / .build.lock 是构建锁，不是代码）
 *
 * 判定仍是**内容哈希**：mtime 只做缓存键，不参与判定。
 * loaded 侧在模块 import 时一次性取（= 本进程真正加载的那一代），current 侧每次现读（带 (size,mtime) 缓存）。
 * ──────────────────────────────────────────────────────────────────────────── */
export const HOST_DIR = path.join(PKG_ROOT, 'lib')
export const HOST_SCOPE =
  'lib/** 去掉 lib/runtime/**（宿主层：index/constants/plugin*/tools/host/contracts/plan/ui/tui/utils/headless）'

/** 宿主层文件清单（相对 posix 路径，已排序）。目录不存在时返回空数组。 */
export function hostFileList(root: string = HOST_DIR): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const ent of entries) {
      const rel = prefix ? prefix + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'types' || ent.name.startsWith('.'))
          continue
        // 只跳过**顶层** lib/runtime：运行时层有自己的单点判定，混进来会让 staleLayer 归因失真
        if (!prefix && ent.name === 'runtime') continue
        walk(path.join(dir, ent.name), rel)
        continue
      }
      if (!ent.isFile()) continue
      if (!/\.(js|mjs|cjs)$/.test(ent.name)) continue
      out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

const _hostFileCache = new Map<string, { key: string; hash: string }>()

function hostFileHash(file: string): string | null {
  try {
    const st = fs.statSync(file)
    const key = String(st.size) + ':' + String(Math.round(st.mtimeMs))
    const hit = _hostFileCache.get(file)
    if (hit && hit.key === key) return hit.hash
    const hash = sha12(fs.readFileSync(file))
    _hostFileCache.set(file, { key, hash })
    return hash
  } catch (e) {
    return null
  }
}

export interface HostSnapshot {
  root: string | null
  files: Map<string, string>
  aggregate: string | null
}

/**
 * 快照缓存：/health 由看护每 15s 打一次、catalog 每次调用都会走到这里。
 * 逐文件 stat 250 个文件约 1–3 ms，直接每次都走也能接受，但同一请求里
 * （catalogPayload → provenance → doctor）会重复走多次，所以留一个很短的 TTL。
 * **热更判定必须 fresh**（hostProvenance(true)）：刚构建完就问，不能吃缓存。
 */
const HOST_SNAP_TTL_MS = 250
let _hostSnapCache: { at: number; snap: HostSnapshot } | null = null

/** 宿主层现况快照（聚合 = 排序后 "rel:hash" 拼串再 sha256:12）。 */
export function hostSnapshot(root: string = HOST_DIR, fresh = false): HostSnapshot {
  if (!fresh && _hostSnapCache && _hostSnapCache.snap.root === root) {
    if (Date.now() - _hostSnapCache.at < HOST_SNAP_TTL_MS) return _hostSnapCache.snap
  }
  const snap = buildHostSnapshot(root)
  _hostSnapCache = { at: Date.now(), snap }
  return snap
}

/** 目录存在且可读；不存在 / 无权限 / 断链统一按 false（降级面由 source=none 表达）。 */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function buildHostSnapshot(root: string): HostSnapshot {
  // 目录不存在 / 不可读 → 一律按"没有宿主层"处理（降级面由 source=none 表达）
  if (!isDirectory(root)) return { root: null, files: new Map(), aggregate: null }
  const files = new Map<string, string>()
  const lines: string[] = []
  for (const rel of hostFileList(root)) {
    const hash = hostFileHash(path.join(root, rel.split('/').join(path.sep)))
    if (!hash) continue
    files.set(rel, hash)
    lines.push(rel + ':' + hash)
  }
  return { root, files, aggregate: files.size ? sha12(lines.join('\n')) : null }
}

/** 本进程装载那一刻的宿主层快照（= 「正在跑的是哪一代」的凭据） */
const HOST_SELF = hostSnapshot()

/** 宿主层差异清单（磁盘 vs 已装载），≤20 条；含新增与删除。 */
export function hostChangedFiles(
  loaded: HostSnapshot,
  current: HostSnapshot,
  limit = 20,
): { files: string[]; count: number; truncated: boolean } {
  const all: string[] = []
  for (const [rel, hash] of current.files) {
    if (loaded.files.get(rel) !== hash) all.push(rel)
  }
  for (const rel of loaded.files.keys()) {
    if (!current.files.has(rel)) all.push(rel)
  }
  all.sort()
  return { files: all.slice(0, limit), count: all.length, truncated: all.length > limit }
}

/* ────────────────────────────────────────────────────────────────────────────
 * H1 修复（2026-11-16 下游验收）：宿主层「已装载」**不再**是 Gateway 启动扫的盘。
 *
 * 旧实现（HOST_SELF）的洞：改 lib/constants.js → 只重启 Gateway → Gateway 重新扫盘，
 * 读到的是改过的磁盘 → host.verdict 自证成 current，而宿主进程里仍是旧代码。
 *
 * 现在「已装载」= 宿主插件装载那一刻写下的清单（runtime/core/layers.ts 的
 * writeHostManifest + DSH_BLENDER_HOST_MANIFEST）。宿主 fiber 不换，清单就不换 → 一直 stale，
 * 直到真的重组合。清单缺失（直接跑 gateway.js / 测试 / 隔离副本）才降级回扫盘，并写明降级。
 * ──────────────────────────────────────────────────────────────────────────── */
const HOST_PROV_TTL_MS = 250
let _hostProvCache: { at: number; value: HostLayerProvenance } | null = null

/**
 * H1：宿主层判定。目录不存在/清单缺失 → unknown（判不了，不冒充 current）。
 * fresh=true 绕过 250ms 缓存（reload 刚构建完就问，必须现读）。
 */
export function hostProvenance(fresh = false): HostLayerProvenance {
  if (!fresh && _hostProvCache && Date.now() - _hostProvCache.at < HOST_PROV_TTL_MS)
    return _hostProvCache.value
  const value = hostProvenanceNow()
  _hostProvCache = { at: Date.now(), value }
  return value
}

function hostProvenanceNow(): HostLayerProvenance {
  const layer = hostLayerSnapshot()
  if (layer.available) return hostProvenanceFromLayer(layer)
  const self = hostProvenanceFromSelf()
  self.note = self.note + '（降级：' + String(layer.note || '宿主层清单不可用') + '）'
  return self
}

/** 清单来源的判定：已装载 = 宿主写的那一代，current = 磁盘。 */
function hostProvenanceFromLayer(layer: LayerSnapshot): HostLayerProvenance {
  const stale = layer.verdict === 'stale'
  const out: HostLayerProvenance = {
    root: layer.root,
    scope: HOST_SCOPE,
    source: 'manifest',
    loadedAt: layer.loadedAt,
    loadedHash: layer.loadedHash,
    currentHash: layer.currentHash,
    loadedFileCount: layer.fileCount ?? 0,
    fileCount: layer.currentFileCount ?? 0,
    changedFiles: layer.changedFiles,
    changedCount: layer.changedCount,
    truncated: layer.truncated,
    verdict: layer.verdict,
    note: '',
  }
  const head = layer.changedFiles.slice(0, 5).join(', ')
  out.note = stale
    ? '宿主层磁盘已变（' +
      String(out.changedCount) +
      ' 个文件：' +
      head +
      (out.changedCount > 5 ? ' …' : '') +
      '）→ 本宿主 fiber 是旧一代（装载于 ' +
      String(layer.loadedAt || '?') +
      '）：只重启 Gateway 不会换掉宿主层，要 blender_session action=reload 触发热组合（或重启 DSH）'
    : '宿主层 ' +
      String(out.fileCount) +
      ' 个文件与宿主装载的那一代一致（装载于 ' +
      String(layer.loadedAt || '?') +
      '，聚合 ' +
      String(layer.currentHash) +
      '）'
  return out
}

/** 降级路径：没有宿主清单时，退回「本进程启动扫的盘」当已装载（旧行为，note 会标明）。 */
function hostProvenanceFromSelf(): HostLayerProvenance {
  const current = hostSnapshot()
  const out: HostLayerProvenance = {
    root: HOST_DIR,
    scope: HOST_SCOPE,
    source: HOST_SELF.files.size ? 'self' : 'none',
    loadedAt: HOST_SELF.aggregate ? new Date().toISOString() : null,
    loadedHash: HOST_SELF.aggregate,
    currentHash: current.aggregate,
    loadedFileCount: HOST_SELF.files.size,
    fileCount: current.files.size,
    changedFiles: [],
    changedCount: 0,
    truncated: false,
    verdict: 'unknown',
    note: '',
  }
  if (!HOST_SELF.files.size) {
    out.note =
      '宿主层取不到已装载指纹（' +
      HOST_DIR +
      ' 无 .js 落地：源码布局未构建，或本进程是隔离副本）→ host 层判不了，不冒充 current'
    return out
  }
  const diff = hostChangedFiles(HOST_SELF, current)
  out.changedFiles = diff.files
  out.changedCount = diff.count
  out.truncated = diff.truncated
  if (out.loadedHash && out.loadedHash === out.currentHash) {
    out.verdict = 'current'
    out.note =
      '宿主层 ' +
      String(out.fileCount) +
      ' 个文件与本进程启动时一致（聚合 ' +
      String(out.currentHash) +
      '）'
    return out
  }
  out.verdict = 'stale'
  out.note =
    '宿主层磁盘已变（' +
    String(out.changedCount) +
    ' 个文件：' +
    diff.files.slice(0, 5).join(', ') +
    (diff.count > 5 ? ' …' : '') +
    '）→ 本宿主 fiber 是旧一代：blender_session action=reload（或改 profile cordis.patch.yml 触发 HMR 重组合）'
  return out
}

/**
 * 按内容哈希（不是 size+mtime）—— 缓存键仍然是 (size, mtime) 以省 IO，但**返回的是内容指纹**。
 *
 * 键集合保持不变：Python 资产仍用旧的扁平模块名 `<name>.py` 作键，但实现文件
 * 一律按 `runtime/py/modules.json` 清单解析（现在没有扁平 shim，generator / uv_tools
 * 也在 geometry 领域包），不会随目录里有没有 shim 而漂移。
 */
const _fpCache = new Map<string, { key: string; hash: string }>()
function runtimeFingerprint(): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (p: string, key: string): void => {
    const st = fs.statSync(p)
    const cacheKey = String(st.size) + ':' + String(Math.round(st.mtimeMs))
    let hit = _fpCache.get(p)
    if (!hit || hit.key !== cacheKey) {
      hit = { key: cacheKey, hash: sha12(fs.readFileSync(p)) }
      _fpCache.set(p, hit)
    }
    out[key] = hit.hash
  }
  try {
    // 非 Python 的运行时文件（构建产物 lib/runtime/*.js，或源码树 runtime/*.ts）。
    for (const f of fs.readdirSync(RUNTIME_DIR)) {
      if (!/\.(js|ts)$/.test(f) || /\.d\.ts$/.test(f)) continue
      add(path.join(RUNTIME_DIR, f), f)
    }
    // Python 实现：唯一清单 runtime/py/modules.json；键名沿用旧扁平文件名（<name>.py）。
    for (const name of pyModuleNames()) add(pyModuleFile(name), name + '.py')
  } catch (e) {
    /* ignore */
  }
  return out
}

function pidAlive(pid: unknown): boolean {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return !!(errorCode(e) === 'EPERM')
  }
}

function pathAudit(stdout: unknown, stderr: unknown): PathWarning[] {
  const warns: PathWarning[] = []
  const text = String(stdout || '') + '\n' + String(stderr || '')
  const re = /Saved:\s*'([^']*)'/g
  let m
  // macOS 上宿主与 Blender 同 OS，不存在「POSIX 路径被 Windows API 改写成 D:home…」这类问题
  while (!IS_MAC && (m = re.exec(text)) !== null) {
    const p = m[1]
    if (/^[A-Za-z]:(home|mnt|tmp|var|usr|root|opt)/i.test(p)) {
      warns.push({
        code: 'posix_path_rewritten',
        evidence: p.slice(0, 200),
        hint:
          "Blender 是 Windows 进程：'/home/…' 被当成「当前盘根下的相对路径」→ 实际写到 C:\\home\\…。" +
          "脚本里用 K.win_path('/home/…')（或 dsh_win_path）换成 Windows 可用形式再交给 bpy。",
      })
    }
  }
  const re2 = /DSH_PATH_WARN (\{[^\n]*\})/g
  while ((m = re2.exec(String(stdout || ''))) !== null) {
    try {
      const o = JSON.parse(m[1]) as { warnings?: PathWarning[] }
      for (const w of o.warnings || []) warns.push(w)
    } catch (e) {
      /* ignore */
    }
  }
  // 去重（同一路径可能被 Saved: 打多次）
  const seen = new Set()
  return warns.filter((w: PathWarning) => {
    const k = w.code + '|' + String(w.evidence || w.value || '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 骨架：容器 + 目录指纹（不含任何「已装载 vs 磁盘」判定）。 */
function baseProvenance(cat: CatalogFingerprint): Provenance {
  return {
    sourcePath: ENGINE_SOURCE_PATH,
    pluginVersion: PLUGIN_VERSION,
    hashAlgo: 'sha256:12',
    loadedAt: ENGINE_SELF.loadedAtText,
    loadedHash: ENGINE_SELF.loadedHash,
    loadedBytes: ENGINE_SELF.loadedBytes,
    loadedReadError: ENGINE_SELF.error,
    currentHash: null,
    currentBytes: null,
    currentMtime: null,
    // 三态：'' current = 进程里的就是磁盘上这份；stale = 磁盘被改过、须重启后端；unknown = 读不到/判不了
    verdict: 'unknown',
    stale: null,
    staleReason: null,
    staleLayer: [],
    runtime: { loadedHash: ENGINE_SELF.loadedHash, currentHash: null, verdict: 'unknown' },
    host: {
      root: HOST_DIR,
      scope: HOST_SCOPE,
      source: 'none',
      loadedAt: null,
      loadedHash: null,
      currentHash: null,
      loadedFileCount: 0,
      fileCount: 0,
      changedFiles: [],
      changedCount: 0,
      truncated: false,
      verdict: 'unknown',
      note: '',
    },
    catalogHash: cat.catalogHash,
    families: cat.families,
    opsCount: cat.opsCount,
    toolDetailKeys: cat.toolDetailKeys,
    commandCatalogKeys: cat.commandCatalogKeys,
    // mtime **只作参考**，不参与判定（这正是旧实现的问题）
    note: '判定用内容哈希（sha256:12），不是 size/mtime；stale=true 表示磁盘已改、本进程还是旧一代 → 重启后端再问一次',
  }
}

/** 运行时层：现读磁盘上的 engine.js，与本进程装载那一刻那份比对（current / stale / unknown）。 */
function applyRuntimeLayer(out: Provenance): void {
  try {
    const buf = fs.readFileSync(ENGINE_SOURCE_PATH)
    const st = fs.statSync(ENGINE_SOURCE_PATH)
    out.currentHash = sha12(buf)
    out.currentBytes = buf.length
    out.currentMtime = new Date(st.mtimeMs).toISOString()
  } catch (e) {
    out.staleReason = '读不到磁盘上的 engine.mjs：' + errorMessage(e).slice(0, 160)
  }
  if (!ENGINE_SELF.loadedHash) {
    out.verdict = 'unknown'
    out.stale = null
    out.staleReason =
      out.staleReason || '加载时就没读到源码：' + String(ENGINE_SELF.error || 'unknown')
  } else if (!out.currentHash) {
    out.verdict = 'unknown'
    out.stale = null
  } else if (out.currentHash === ENGINE_SELF.loadedHash) {
    out.runtime.verdict = 'current'
  } else {
    out.runtime.verdict = 'stale'
    out.staleReason =
      '磁盘内容已变（loaded ' +
      ENGINE_SELF.loadedHash +
      ' ≠ current ' +
      out.currentHash +
      '，加载于 ' +
      ENGINE_SELF.loadedAtText +
      '）→ 本进程的目录/路由是旧一代：重启后端再问一次，' +
      '或用 catalog args={verify:true} 起干净进程对拍'
  }
  out.runtime.currentHash = out.currentHash
}

/** 顶层判定的合成：任一层 stale 即 stale，staleLayer 说清是哪一层（H1）。 */
function composeLayerVerdict(out: Provenance, fresh = false): void {
  out.staleLayer = []
  if (out.runtime.verdict === 'stale') out.staleLayer.push('runtime')

  // H1：宿主层同样自证，并与运行时层合成顶层判定（fresh 绕过 250ms 快照缓存）。
  const host = hostProvenance(fresh)
  out.host = host
  if (host.verdict === 'stale') out.staleLayer.push('host')

  if (out.staleLayer.length > 0) {
    out.verdict = 'stale'
    out.stale = true
    if (out.staleLayer.includes('host')) {
      out.staleReason = (out.staleReason ? out.staleReason + '；' : '') + host.note
    }
  } else if (out.runtime.verdict === 'current' || host.verdict === 'current') {
    out.verdict = 'current'
    out.stale = false
  } else {
    out.verdict = 'unknown'
    out.stale = null
  }
}

/** opts.verify：起一次干净进程读磁盘 catalog，与本进程的目录指纹对拍。 */
function applyDiskVerify(
  out: Provenance,
  o: Record<string, unknown>,
  cat: CatalogFingerprint,
): void {
  const disk: DiskCatalog = probeDiskCatalog(o.verifyTimeoutMs)
  out.diskCatalog = disk
  if (disk && disk.ok) {
    const sameHash = disk.catalogHash === cat.catalogHash
    out.diskVerdict = {
      ok: true,
      matchesLoadedCatalog: sameHash,
      families: disk.families,
      opsCount: disk.opsCount,
      catalogHash: disk.catalogHash,
      pluginVersion: disk.pluginVersion,
      note: sameHash
        ? '干净进程读磁盘得到的 catalog 指纹与本进程一致 —— 目录不是旧版'
        : '干净进程读磁盘是 ' +
          String(disk.families) +
          ' 个 family / ' +
          String(disk.opsCount) +
          ' 个 op（' +
          disk.catalogHash +
          '），本进程回答的是 ' +
          String(cat.families) +
          ' / ' +
          String(cat.opsCount) +
          '（' +
          cat.catalogHash +
          '）→ **本进程目录是旧版**，以干净进程那份为准（磁盘 ' +
          String(ENGINE_SOURCE_PATH) +
          '）',
    }
  } else {
    out.diskVerdict = {
      ok: false,
      note: '干净进程对拍失败（不影响本进程回答）：' + String((disk && disk.error) || 'unknown'),
    }
  }
}

/**
 * 版本/指纹自证入口：两层（运行时 + 宿主）合成。
 *
 * 2026-11-16 拆函数（function-budget 硬限 120 行 + 每块单一职责）：
 * baseProvenance（骨架）→ applyRuntimeLayer（运行时层）→ composeLayerVerdict（合成）
 * → applyDiskVerify（opts.verify 的干净进程对拍）。
 */
export function engineProvenance(opts?: unknown): Provenance {
  const o: Record<string, unknown> =
    opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {}
  const cat = catalogFingerprint()
  const out = baseProvenance(cat)
  applyRuntimeLayer(out)
  composeLayerVerdict(out, o.fresh === true)
  if (o.verify) applyDiskVerify(out, o, cat)
  return out
}

/**
 * v2.6（本轮反馈 #3）：多灯卫生 —— EEVEE 阴影池溢出的**结构化告警**。
 *
 * 现场（4 小时里刷了几千行）：36 盏灯 → 控制台每一帧刷
 *   Error: Shadow buffer full, may result in missing shadows and lower performance. (3040 / 2048)
 * 而 scene.eevee.shadow_pool_size = 4096 **静默无效** —— 它是枚举，上限就是 2048（2 GB）。
 * 旧行为：告警只在 stderr 里刷屏，模型得自己看懂；新行为：进回执 warnings[]，附一条能直接粘贴的修法。
 */
export function sceneHygieneAudit(stdout: unknown, stderr: unknown): PathWarning[] {
  const text = String(stdout || '') + String.fromCharCode(10) + String(stderr || '')
  const warns: PathWarning[] = []
  const hits = text.match(/Shadow buffer full[^()]*\((\d+)\s*\/\s*(\d+)\)/g) || []
  if (hits.length) {
    const last = hits[hits.length - 1].match(/\((\d+)\s*\/\s*(\d+)\)/)
    const FIX = [
      'import bpy',
      'bpy.context.scene.eevee.shadow_pool_size = "2048"   # 枚举上限就是 2048，写 4096 无效',
      'for o in bpy.data.objects:',
      '    if o.type == "LIGHT" and o.data.type in {"POINT", "SPOT"}:',
      '        o.data.use_shadow = False   # practical 灯基本不需要投影',
    ].join(String.fromCharCode(10))
    warns.push({
      code: 'eevee_shadow_pool_full',
      occurrences: hits.length,
      used_mb: last ? Number(last[1]) : null,
      limit_mb: last ? Number(last[2]) : null,
      hint:
        'EEVEE 阴影池溢出（' +
        (last ? last[1] : '?') +
        '/' +
        (last ? last[2] : '?') +
        ' MB，出现 ' +
        hits.length +
        ' 次）：' +
        '阴影会缺失、渲染变慢，但**不会报错退出** —— 不处理就是一张「阴影丢了」的图。' +
        '改法：① shadow_pool_size 是枚举且上限 2048（写 4096 会被静默忽略）；' +
        '② 主力是减投影灯：点光/面光的 use_shadow 全关，只留 2–4 盏真正要投影的；' +
        '③ 大场景再降 shadow_resolution_scale。',
      fix: FIX,
      also: 'K.light_hygiene(apply=True) 可一次做完（返回 before/after 计数）',
    })
  }
  return warns
}

export { sha12, ENGINE_SELF, RUNTIME_DIR, runtimeFingerprint, pidAlive, pathAudit }
