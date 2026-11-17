/**
 * H1（热更新不重启）：两层「已装载 vs 磁盘」自证 —— 宿主层 + 运行时层。
 *
 * 现状问题：/status.provenance 原来只对 lib/runtime/engine.js 做 sha256:12 比对，
 * 宿主层（lib/tools/**、lib/host/**、lib/constants.js…）被改时它仍然报 current，
 * 下游只能拿 gateway.pid 猜「这次改的东西到底上线了没有」。
 *
 * 这里把两层都做成「已装载快照 vs 磁盘清单」的逐文件差异：
 *   - runtime 层：Gateway 进程启动那一刻把 lib/runtime/** 逐文件哈希记进内存（RUNTIME_SELF）。
 *   - host   层：宿主插件启动那一刻把 lib/**（不含 lib/runtime）算成清单文件，路径通过
 *               DSH_BLENDER_HOST_MANIFEST 传给 Gateway；Gateway 读它当「已装载」。
 * 两侧用同一套哈希规则（scanLayer），所以清单可以直接逐文件对拍。
 *
 * 纯 fs/crypto，没有运行时依赖：宿主侧 src/host 通过 runtime-bridge 复用同一份实现，
 * 不允许出现第二套哈希规则（否则两层会各自"自证"成 current）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 清单 schema 版本：宿主写、Gateway 读，不匹配就不认（宁可 unknown 也不谎报 current）。 */
export const LAYER_SCHEMA = 1
/** 差异清单上限（超过只报前 N 条 + count + truncated）。 */
export const CHANGED_FILE_CAP = 20
/** 宿主层清单文件路径的环境变量名（由 src/host 的 spawnChild 注入）。 */
export const HOST_MANIFEST_ENV = 'DSH_BLENDER_HOST_MANIFEST'
/** 宿主层扫描要整枝跳过的首层目录名：runtime 层单独自证，不能混进宿主层。 */
export const HOST_LAYER_SKIP = ['runtime']

export interface LayerScan {
  /** 整层聚合哈希（sha256:12） */
  hash: string
  /** 相对 posix 路径 → sha256:12 */
  files: Record<string, string>
  fileCount: number
  bytes: number
}

export interface LayerManifest extends LayerScan {
  schema: number
  root: string
  loadedAt: string
  pluginVersion: string | null
  hostPid?: number
  pluginRoot?: string
}

export type LayerName = 'host' | 'runtime'
export type LayerVerdict = 'current' | 'stale' | 'unknown'

export interface LayerSnapshot {
  layer: LayerName
  /** 有没有「已装载」这一侧可对拍（宿主层清单缺失时 false） */
  available: boolean
  root: string | null
  loadedHash: string | null
  currentHash: string | null
  fileCount: number | null
  currentFileCount: number | null
  changedFiles: string[]
  changedCount: number
  truncated: boolean
  verdict: LayerVerdict
  loadedAt: string | null
  note: string | null
}

export interface LayerVerdicts {
  host: LayerSnapshot
  runtime: LayerSnapshot
}

export interface ComposedVerdict {
  verdict: LayerVerdict
  staleLayer: LayerName[]
  changedFiles: string[]
  changedCount: number
  staleReason: string | null
}

const CODE_RE = /\.(?:js|mjs|cjs|ts|mts)$/
const DECL_RE = /\.d\.(?:ts|mts)$/

/** sha256 前 12 位（与 evidence.ts / runtimeFingerprint 同一口径） */
export function sha12(buf: string | Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12)
}

function posixPath(rel: string): string {
  return rel.split(path.sep).join('/')
}

/**
 * 递归列出某层的代码文件（相对 posix 路径、排序稳定）。
 * 只收 .js/.mjs/.cjs/.ts/.mts，跳过 .d.ts 与 *.map —— 声明和 sourcemap 不改变已装载行为。
 */
export function listLayerFiles(root: string, skipTop: ReadonlyArray<string> = []): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile() || !CODE_RE.test(entry.name) || DECL_RE.test(entry.name)) continue
      const rel = posixPath(path.relative(root, abs))
      if (skipTop.includes(rel.split('/')[0])) continue
      out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

const _hashCache = new Map<string, { key: string; hash: string; bytes: number }>()

/** 按内容哈希（缓存键仍是 size+mtime，只省 IO，不参与判定）。读不到返回 null。 */
export function hashFile(abs: string): { hash: string; bytes: number } | null {
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return null
  }
  const key = String(st.size) + ':' + String(Math.round(st.mtimeMs))
  const hit = _hashCache.get(abs)
  if (hit && hit.key === key) return { hash: hit.hash, bytes: hit.bytes }
  try {
    const buf = fs.readFileSync(abs)
    const rec = { key, hash: sha12(buf), bytes: buf.length }
    _hashCache.set(abs, rec)
    return { hash: rec.hash, bytes: rec.bytes }
  } catch {
    return null
  }
}

/** 一层目录的清单：{hash, files, fileCount, bytes}；聚合哈希 = sha256:12("rel:hash\n")。 */
export function scanLayer(root: string, skipTop: ReadonlyArray<string> = []): LayerScan {
  const files: Record<string, string> = {}
  const lines: string[] = []
  let bytes = 0
  for (const rel of listLayerFiles(root, skipTop)) {
    const one = hashFile(path.join(root, rel))
    if (!one) continue
    files[rel] = one.hash
    bytes += one.bytes
    lines.push(rel + ':' + one.hash)
  }
  return { hash: sha12(lines.join(String.fromCharCode(10))), files, fileCount: lines.length, bytes }
}

/** 逐文件对拍：缺失 / 哈希不同都算变更（新增文件也会被抓到）。结果排序稳定。 */
export function diffLayers(
  loaded: Record<string, string>,
  disk: Record<string, string>,
): { changed: string[]; count: number } {
  const changed: string[] = []
  for (const rel of Object.keys(loaded)) if (disk[rel] !== loaded[rel]) changed.push(rel)
  for (const rel of Object.keys(disk)) if (!(rel in loaded)) changed.push(rel)
  changed.sort()
  return { changed, count: changed.length }
}

function capped(list: string[]): { files: string[]; truncated: boolean } {
  return list.length > CHANGED_FILE_CAP
    ? { files: list.slice(0, CHANGED_FILE_CAP), truncated: true }
    : { files: list, truncated: false }
}

/** Gateway 自己的运行时层：加载那一刻的快照（模块求值时抓，和 ENGINE_SELF 同一时刻）。 */
export const RUNTIME_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_SELF: { loadedAt: string; scan: LayerScan } = (() => {
  const loadedAt = new Date().toISOString()
  return { loadedAt, scan: scanLayer(RUNTIME_ROOT) }
})()

export function runtimeLayerSnapshot(): LayerSnapshot {
  const loaded = RUNTIME_SELF.scan
  let disk: LayerScan | null = null
  let error: string | null = null
  try {
    disk = scanLayer(RUNTIME_ROOT)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (!disk || loaded.fileCount === 0) {
    return {
      layer: 'runtime',
      available: false,
      root: RUNTIME_ROOT,
      loadedHash: loaded.hash,
      currentHash: disk ? disk.hash : null,
      fileCount: loaded.fileCount,
      currentFileCount: disk ? disk.fileCount : null,
      changedFiles: [],
      changedCount: 0,
      truncated: false,
      verdict: 'unknown',
      loadedAt: RUNTIME_SELF.loadedAt,
      note: error ? '读不到磁盘上的运行时层：' + error : '运行时层没有可比对的已装载文件',
    }
  }
  const { changed, count } = diffLayers(loaded.files, disk.files)
  const page = capped(changed)
  return {
    layer: 'runtime',
    available: true,
    root: RUNTIME_ROOT,
    loadedHash: loaded.hash,
    currentHash: disk.hash,
    fileCount: loaded.fileCount,
    currentFileCount: disk.fileCount,
    changedFiles: page.files,
    changedCount: count,
    truncated: page.truncated,
    verdict: count === 0 ? 'current' : 'stale',
    loadedAt: RUNTIME_SELF.loadedAt,
    note:
      count === 0
        ? '运行时层已装载 = 磁盘（宿主层见 host 子对象）'
        : '运行时层磁盘已变 ' +
          String(count) +
          ' 个文件 → 重启 Gateway 子进程即生效（宿主进程不动）',
  }
}

const _manifestCache = new Map<string, { key: string; manifest: LayerManifest | null }>()

/** 读宿主层清单（按 mtime 缓存）；读不到/坏 JSON 返回 null，绝不抛。 */
export function readHostManifest(file: string): LayerManifest | null {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  const key = String(st.size) + ':' + String(Math.round(st.mtimeMs))
  const hit = _manifestCache.get(file)
  if (hit && hit.key === key) return hit.manifest
  let manifest: LayerManifest | null = null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rec = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    const files = rec && rec.files && typeof rec.files === 'object' ? rec.files : null
    if (rec && Number(rec.schema) === LAYER_SCHEMA && typeof rec.root === 'string' && files) {
      const table: Record<string, string> = {}
      for (const [rel, hash] of Object.entries(files as Record<string, unknown>)) {
        if (typeof hash === 'string') table[rel] = hash
      }
      manifest = {
        schema: LAYER_SCHEMA,
        root: rec.root,
        loadedAt: typeof rec.loadedAt === 'string' ? rec.loadedAt : '',
        pluginVersion: typeof rec.pluginVersion === 'string' ? rec.pluginVersion : null,
        hostPid: Number.isFinite(Number(rec.hostPid)) ? Number(rec.hostPid) : undefined,
        pluginRoot: typeof rec.pluginRoot === 'string' ? rec.pluginRoot : undefined,
        hash: typeof rec.hash === 'string' ? rec.hash : '',
        files: table,
        fileCount: Number.isFinite(Number(rec.fileCount))
          ? Number(rec.fileCount)
          : Object.keys(table).length,
        bytes: Number.isFinite(Number(rec.bytes)) ? Number(rec.bytes) : 0,
      }
    }
  } catch {
    manifest = null
  }
  _manifestCache.set(file, { key, manifest })
  return manifest
}

export interface HostManifestMeta {
  pluginVersion?: string | null
  hostPid?: number
  pluginRoot?: string
}

/**
 * 写宿主层清单（H1 的接线点）：宿主插件在**装载那一刻**把 lib/** scan 成清单落盘，
 * 路径经 DSH_BLENDER_HOST_MANIFEST 传给 Gateway；Gateway 每次都读这份文件当「已装载」。
 *
 * 为什么必须是「装载那一刻」而不是「每次 spawn 时现扫」：只重启 Gateway 时，
 * 现扫会读到磁盘上的新代码 → 宿主层自证成 current —— 那正是旧实现（HOST_SELF）的洞。
 * 清单由宿主 fiber 写，fiber 不换，清单就不换，宿主层就一直是 stale。
 *
 * 失败返回 null，绝不抛：没有清单 = Gateway 降级回扫盘自证（不是致命错）。
 */
export function writeHostManifest(
  root: string,
  file: string,
  meta: HostManifestMeta = {},
): LayerManifest | null {
  try {
    const scan = scanLayer(root, HOST_LAYER_SKIP)
    const manifest: LayerManifest = {
      schema: LAYER_SCHEMA,
      root,
      loadedAt: new Date().toISOString(),
      pluginVersion: meta.pluginVersion ?? null,
      hostPid: meta.hostPid,
      pluginRoot: meta.pluginRoot,
      ...scan,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(manifest) + String.fromCharCode(10), 'utf8')
    // 原子替换：Gateway 任何时刻都读不到半截 JSON（读坏 = 降级 = 又回到拿 pid 猜）
    fs.renameSync(tmp, file)
    forgetHostManifest(file)
    return manifest
  } catch {
    return null
  }
}

/** 丢掉某份清单的读取缓存：写完必须调（同尺寸 + 同毫秒的重写会命中旧缓存）。 */
export function forgetHostManifest(file: string): void {
  _manifestCache.delete(file)
}

/** 宿主层：已装载清单（宿主写）vs 磁盘清单（Gateway 现算）。 */
export function hostLayerSnapshot(): LayerSnapshot {
  const manifestPath = String(process.env[HOST_MANIFEST_ENV] || '')
  const empty: LayerSnapshot = {
    layer: 'host',
    available: false,
    root: null,
    loadedHash: null,
    currentHash: null,
    fileCount: null,
    currentFileCount: null,
    changedFiles: [],
    changedCount: 0,
    truncated: false,
    verdict: 'unknown',
    loadedAt: null,
    note: null,
  }
  if (!manifestPath) {
    empty.note =
      '宿主层不可自证：Gateway 不由插件宿主 spawn（缺 ' +
      HOST_MANIFEST_ENV +
      '）→ 只看运行时层；宿主层改动请用 blender_session action=reload'
    return empty
  }
  const manifest = readHostManifest(manifestPath)
  if (!manifest) {
    empty.note = '宿主层清单读不到或 schema 不匹配（' + manifestPath + '）→ 只看运行时层'
    return empty
  }
  let disk: LayerScan
  try {
    disk = scanLayer(manifest.root, HOST_LAYER_SKIP)
  } catch (e) {
    empty.root = manifest.root
    empty.loadedHash = manifest.hash
    empty.note = '宿主层磁盘扫描失败：' + (e instanceof Error ? e.message : String(e))
    return empty
  }
  const { changed, count } = diffLayers(manifest.files, disk.files)
  const page = capped(changed)
  return {
    layer: 'host',
    available: true,
    root: manifest.root,
    loadedHash: manifest.hash,
    currentHash: disk.hash,
    fileCount: manifest.fileCount,
    currentFileCount: disk.fileCount,
    changedFiles: page.files,
    changedCount: count,
    truncated: page.truncated,
    verdict: count === 0 ? 'current' : 'stale',
    loadedAt: manifest.loadedAt || null,
    note:
      count === 0
        ? '宿主层已装载 = 磁盘（宿主插件是这一代）'
        : '宿主层磁盘已变 ' +
          String(count) +
          ' 个文件 → 需要宿主重组合（HMR）或重启 DSH；只重启 Gateway 不会换掉宿主层',
  }
}

/** 两层快照一次取齐。 */
export function layerVerdicts(): LayerVerdicts {
  return { host: hostLayerSnapshot(), runtime: runtimeLayerSnapshot() }
}

function joinReason(base: string | null, extra: string): string {
  return base ? base + '；' + extra : extra
}

/**
 * 顶层判定的合成规则：任一层 stale 即 stale（staleLayer 说清是哪层），
 * 宿主层不可用（没有清单）时**不参与**合成 —— 缺证据不等于陈旧，否则下游脚本会被 unknown 噎住。
 */
export function composeVerdict(
  engineVerdict: LayerVerdict,
  engineReason: string | null,
  layers: LayerVerdicts,
): ComposedVerdict {
  const staleLayer: LayerName[] = []
  if (layers.host.verdict === 'stale') staleLayer.push('host')
  if (layers.runtime.verdict === 'stale' || engineVerdict === 'stale') staleLayer.push('runtime')
  const { changed, count } = splitChanged(layers)
  let reason = engineReason
  if (layers.host.verdict === 'stale')
    reason = joinReason(reason, '宿主层变了：' + summarize(layers.host))
  if (layers.runtime.verdict === 'stale' && engineVerdict !== 'stale')
    reason = joinReason(reason, '运行时层变了：' + summarize(layers.runtime))
  if (staleLayer.length > 0)
    return {
      verdict: 'stale',
      staleLayer,
      changedFiles: changed,
      changedCount: count,
      staleReason: reason,
    }
  if (engineVerdict === 'unknown' && layers.runtime.verdict !== 'current')
    return {
      verdict: 'unknown',
      staleLayer,
      changedFiles: changed,
      changedCount: count,
      staleReason: reason,
    }
  return {
    verdict: engineVerdict === 'unknown' ? 'unknown' : 'current',
    staleLayer,
    changedFiles: changed,
    changedCount: count,
    staleReason: null,
  }
}

/** 两层差异合并成一条清单（去重、按层顺序），count 是两层原始变更数之和。 */
function splitChanged(layers: LayerVerdicts): { changed: string[]; count: number } {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of [layers.host.changedFiles, layers.runtime.changedFiles]) {
    for (const rel of list) {
      if (seen.has(rel)) continue
      seen.add(rel)
      out.push(rel)
    }
  }
  return {
    changed: out.slice(0, CHANGED_FILE_CAP),
    count: layers.host.changedCount + layers.runtime.changedCount,
  }
}

function summarize(snap: LayerSnapshot): string {
  const head = snap.changedFiles.slice(0, 3)
  const more = snap.changedCount > head.length ? ' 等 ' + String(snap.changedCount) + ' 个' : ''
  return head.join(', ') + more
}
