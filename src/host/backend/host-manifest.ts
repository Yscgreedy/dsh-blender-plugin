/**
 * host/backend/host-manifest：H1（热更新不重启）的**宿主层清单**。
 *
 * 问题（2026-11-16 下游验收实测）：Gateway 的 provenance 把「宿主层已装载」理解成
 * **Gateway 启动那一刻扫的盘**。于是「改 lib/constants.js → 只重启 Gateway」之后
 * host.verdict 会自己变回 current —— 磁盘上还留着改动、宿主进程里还是旧代码，
 * 下游只能回去拿 gateway.pid 猜。
 *
 * 修法：宿主插件在装载时刻把 lib/**（跳 lib/runtime，那是运行时层自己的单点判定）扫成清单落盘，
 * 路径经 DSH_BLENDER_HOST_MANIFEST 传给 Gateway。宿主 fiber 不换 → 清单不换 → 宿主层一直是 stale。
 * 只有 HMR 重组合（新 fiber）才会重写清单，那一刻磁盘上的代码才真的是「已装载」。
 *
 * 2026-11-19（复测第四轮）补三个洞 —— 都是「假 noop → src 层修复永远装不上」的成因：
 *   ① **装载时快照**：扫描在**模块求值那一刻**定型（LOAD_SCAN），不是首次 spawn 时现扫。
 *      否则「镜像完成 → 首次 spawn 之前被中断」这一小段里，清单会把新磁盘记成已装载。
 *   ② **清单归属**：文件名带宿主层根指纹（别的安装/仓库副本不会覆盖本安装的清单），
 *      并且字段里写明 root —— Gateway 只认与自己 root 一致的那份（layers.sameRoot）。
 *   ③ **root 只看自己**：宿主层根由本模块位置推出（HERE），不再由 GATEWAY_PATH 推 ——
 *      DSH_BLENDER_GATEWAY_ENTRY 之类的生僻覆盖不该把「我加载了哪些文件」也挪走。
 *
 * 失败一律降级（返回 ''）：没有清单时 Gateway 的宿主层结论是 unknown（不冒充 current）。
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HERE, PLUGIN_VERSION } from '../../constants.js'
import { diffLayers, scanLayer, sha12, writeLayerManifest } from '../runtime-bridge.js'
import type { LayerScan } from '../runtime-bridge.js'
import { HOST_LAYER_SKIP } from '../runtime-bridge.js'

/** 宿主层根：构建布局 HERE = <pkg>/lib；源码布局 HERE = <pkg>/src → <pkg>/lib。 */
export function hostLayerRoot(here: string = HERE): string {
  return path.basename(here).toLowerCase() === 'lib' ? here : path.resolve(here, '..', 'lib')
}

/** 包根（清单里的 pluginRoot，诊断用）：lib 的上一级，或 src 布局的 HERE 本身。 */
export function pluginRootOf(here: string = HERE): string {
  return path.basename(here).toLowerCase() === 'lib' ? path.resolve(here, '..') : here
}

/**
 * 清单文件放在工作目录（与 gateway 日志同一处），跨进程可读、不污染包目录。
 *
 * 文件名带宿主层根指纹：共享目录里可能同时有仓库开发副本、另一个 profile 的安装副本 ——
 * 旧实现共用一个 host-manifest.json，谁后写谁说了算（2026-11-19 现场就是这么被覆盖的）。
 */
export function hostManifestPath(root: string = hostLayerRoot()): string {
  const dir = process.env.DSH_BLENDER_WORKDIR
    ? path.join(process.env.DSH_BLENDER_WORKDIR, 'logs')
    : path.join(os.tmpdir(), 'dsh-blender-gateway')
  return path.join(dir, 'host-manifest-' + sha12(root) + '.json')
}

/**
 * 本代装载时刻的宿主层指纹（**模块求值那一刻**抓，之后不变）。
 * 这就是「宿主 fiber 里跑的到底是哪一代」的唯一凭据 —— 别在 spawn 时重扫。
 */
const LOADED_AT = new Date().toISOString()
const LOAD_SCAN: { root: string; scan: LayerScan | null; error: string | null } = (() => {
  const root = hostLayerRoot()
  try {
    return { root, scan: scanLayer(root, HOST_LAYER_SKIP), error: null }
  } catch (e) {
    return { root, scan: null, error: e instanceof Error ? e.message : String(e) }
  }
})()

let memo: string | null = null

/**
 * 求值代号（测试与自证用）：HMR 真重组合会重新求值本模块 → +1；模块实例被复用则不变。
 */
const GENERATION_KEY = '__dshBlenderHostManifestGeneration'
const ACTIVATED_KEY = '__dshBlenderHostManifestActivatedGeneration'
const REGISTRY = globalThis as unknown as Record<string, unknown>
const MY_GENERATION = Number(REGISTRY[GENERATION_KEY] || 0) + 1
REGISTRY[GENERATION_KEY] = MY_GENERATION

/** 本模块实例的求值代号（测试与自证用）。 */
export function hostManifestGeneration(): number {
  return MY_GENERATION
}

/**
 * 保证清单存在并返回其路径；拿不到返回 ''（= 降级）。
 *
 * 内容 = **本模块求值那一刻**的 LOAD_SCAN（写盘一次 + 模块级 memo）。之后即使磁盘又变了也不重写 ——
 * 这正是「宿主 fiber 是旧一代」要说的话。
 */
export function ensureHostManifest(): string {
  if (memo) {
    if (existsSync(memo)) return memo
    memo = null
  }
  if (!LOAD_SCAN.scan || LOAD_SCAN.scan.fileCount === 0) return ''
  const file = hostManifestPath(LOAD_SCAN.root)
  const written = writeLayerManifest(LOAD_SCAN.scan, LOAD_SCAN.root, file, {
    pluginVersion: PLUGIN_VERSION,
    hostPid: process.pid,
    pluginRoot: pluginRootOf(),
  })
  // 空扫描 = 没构建过（或布局不对）：宁可不写清单（Gateway 判不了），也不写一份空清单
  if (!written || written.fileCount === 0) return ''
  memo = file
  return memo
}

export interface HostSelfProvenance {
  available: boolean
  root: string
  loadedAt: string
  loadedHash: string | null
  currentHash: string | null
  fileCount: number
  currentFileCount: number
  changedFiles: string[]
  changedCount: number
  verdict: 'current' | 'stale' | 'unknown'
  note: string
}

/**
 * 宿主**自己**的层自证（工具面 reload 的判据）：装载时指纹 vs 磁盘现在。
 *
 * 为什么不问 Gateway：Gateway 读的是共享目录里的一份 JSON，可能被别的安装覆盖；宿主这里拿的是
 * 本模块求值时抓下的 LOAD_SCAN，谁也改不了。工具面用它兜底，判不了就升级成 hmr，绝不回 noop。
 */
export function hostSelfProvenance(): HostSelfProvenance {
  const root = LOAD_SCAN.root
  const loaded = LOAD_SCAN.scan
  const base = {
    root,
    loadedAt: LOADED_AT,
    loadedHash: loaded ? loaded.hash : null,
    fileCount: loaded ? loaded.fileCount : 0,
  }
  if (!loaded || loaded.fileCount === 0) {
    return {
      ...base,
      available: false,
      currentHash: null,
      currentFileCount: 0,
      changedFiles: [],
      changedCount: 0,
      verdict: 'unknown',
      note:
        '本代装载时没扫到宿主层代码（' +
        root +
        (LOAD_SCAN.error ? '；' + LOAD_SCAN.error : '') +
        '）→ 判不了，不冒充 current',
    }
  }
  let disk: LayerScan
  try {
    disk = scanLayer(root, HOST_LAYER_SKIP)
  } catch (e) {
    return {
      ...base,
      available: false,
      currentHash: null,
      currentFileCount: 0,
      changedFiles: [],
      changedCount: 0,
      verdict: 'unknown',
      note: '宿主层磁盘扫描失败：' + (e instanceof Error ? e.message : String(e)),
    }
  }
  const { changed, count } = diffLayers(loaded.files, disk.files)
  return {
    ...base,
    available: true,
    currentHash: disk.hash,
    currentFileCount: disk.fileCount,
    changedFiles: changed.slice(0, 20),
    changedCount: count,
    verdict: count === 0 ? 'current' : 'stale',
    note:
      count === 0
        ? '宿主层装载时 = 磁盘（' + String(loaded.fileCount) + ' 个文件，装载于 ' + LOADED_AT + '）'
        : '宿主层磁盘已变 ' +
          String(count) +
          ' 个文件（' +
          changed.slice(0, 5).join(', ') +
          '）：本宿主 fiber 是旧一代，要重组合（HMR）',
  }
}

/**
 * 新宿主 fiber 激活时调用（registerLifecycle 第一步）。
 *
 * 只有「本模块确实是新求值的一代」才重写清单：此刻磁盘上的 lib/** 就是刚被装载的那一代，
 * 宿主层理应转 current。若模块实例被复用（HMR 没击穿模块缓存），保留上一代清单 ——
 * 宿主层继续 stale，下游看到的是真话，而不是被洗成 current。
 */
export function refreshHostManifest(): { rewritten: boolean; generation: number; note: string } {
  const activated = Number(REGISTRY[ACTIVATED_KEY] || 0)
  if (MY_GENERATION <= activated) {
    return {
      rewritten: false,
      generation: MY_GENERATION,
      note:
        '本模块实例被复用（求值代号 ' +
        String(MY_GENERATION) +
        ' ≤ 上次激活 ' +
        String(activated) +
        '）→ 保留上一代清单：宿主 fiber 仍是旧一代，宿主层继续 stale（别自证成最新）',
    }
  }
  REGISTRY[ACTIVATED_KEY] = MY_GENERATION
  memo = null
  const written = ensureHostManifest()
  return {
    rewritten: Boolean(written),
    generation: MY_GENERATION,
    note: written
      ? '新 fiber 装载时重写宿主层清单（已装载 = 磁盘这一代）'
      : '清单写不出来（未构建/布局不对）→ Gateway 判不了宿主层，note 里会写明',
  }
}
