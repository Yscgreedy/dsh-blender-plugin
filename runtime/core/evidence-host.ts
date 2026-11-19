// H1：宿主层聚合指纹（从 evidence.ts 拆出；纯移动，行为不变）。
import fs from 'node:fs'
import path from 'node:path'
import { PKG_ROOT } from '../config.js'
import { hostLayerSnapshot } from './layers.js'
import type { LayerSnapshot } from './layers.js'
import { sha12 } from './evidence-util.js'
import type { HostLayerProvenance } from './evidence-types.js'

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
  // root 必须给：清单在共享目录里，可能来自另一处装载（仓库副本/别的 profile）。
  // 只认「本进程的宿主层根」这份，别的 root 一律判不了（见 layers.sameRoot）。
  const layer = hostLayerSnapshot({ root: HOST_DIR })
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
    // 「Gateway 启动时扫的盘」不是宿主 fiber 的证据（fiber 可能更早装载）。旧实现在这里回
    // current —— 只要 Gateway 在镜像之后才起，两头就都自证成最新，正是 2026-11-19 的假绿。
    out.verdict = 'unknown'
    out.note =
      '宿主层判不了：没有宿主清单，本进程（Gateway）启动时扫的盘不代表宿主 fiber 装载的那一代（' +
      String(out.fileCount) +
      ' 个文件、聚合 ' +
      String(out.currentHash) +
      '）→ 不冒充 current；要宿主重组合后写清单才能自证'
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
