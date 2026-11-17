/**
 * host/backend/host-manifest：H1（热更新不重启）的**宿主层清单**。
 *
 * 问题（2026-11-16 下游验收实测）：Gateway 的 provenance 把「宿主层已装载」理解成
 * **Gateway 启动那一刻扫的盘**。于是「改 lib/constants.js → 只重启 Gateway」之后
 * host.verdict 会自己变回 current —— 磁盘上还留着改动、宿主进程里还是旧代码，
 * 下游只能回去拿 gateway.pid 猜。
 *
 * 修法：宿主插件在自己**装载那一刻**（= 本模块被这一代 fiber import 的时刻）把 lib/**
 * （跳 lib/runtime，那是运行时层自己的单点判定）扫成清单落盘，路径经
 * DSH_BLENDER_HOST_MANIFEST 传给 Gateway。宿主 fiber 不换 → 清单不换 → 宿主层一直是 stale。
 * 只有 HMR 重组合（新 fiber）才会重写清单，那一刻磁盘上的代码才真的是「已装载」。
 *
 * 失败一律降级（返回 ''）：没有清单时 Gateway 退回旧的扫盘自证，并在 note 里写「降级」。
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_PATH, HERE, PLUGIN_VERSION } from '../../constants.js'
import { writeHostManifest } from '../runtime-bridge.js'

let memo: string | null = null

/**
 * 「本模块是**新**求值出来的一代吗？」
 *
 * HMR 的两条路径都会重新 activate 插件，但只有**真重组合**（新 fiber）才意味着磁盘上的
 * lib/** 已经被装载。若宿主只是复用已缓存的模块实例（重组合没成/软重载），本模块求值次数
 * 不会增加 —— 这时**绝不能**重写清单，否则旧代码又自证成 current，把 H1 那个洞原样还回来。
 *
 * 判据：模块求值计数（globalThis 上，跨 ESM 实例可见）> 上一次 activate 时记下的计数。
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

/** 宿主层根：构建布局 = <pkg>/lib（gateway 在 <pkg>/lib/runtime/ 下）。 */
export function hostLayerRoot(): string {
  const fromGateway = path.resolve(path.dirname(GATEWAY_PATH), '..')
  if (existsSync(fromGateway)) return fromGateway
  // 开发/测试布局（HERE = <pkg>/src）：宿主层仍是 <pkg>/lib
  return path.resolve(HERE, '..', 'lib')
}

/** 清单文件放在工作目录（与 gateway 日志同一处），跨进程可读、不污染包目录。 */
export function hostManifestPath(): string {
  const dir = process.env.DSH_BLENDER_WORKDIR
    ? path.join(process.env.DSH_BLENDER_WORKDIR, 'logs')
    : path.join(os.tmpdir(), 'dsh-blender-gateway')
  return path.join(dir, 'host-manifest.json')
}

/**
 * 保证清单存在并返回其路径；拿不到返回 ''（= 降级）。
 * 清单内容在**首次调用时**定型（写盘 + 模块级 memo），之后即使磁盘又变了也不重写 ——
 * 这正是「宿主 fiber 是旧一代」要说的话。
 */
export function ensureHostManifest(): string {
  if (memo) {
    if (existsSync(memo)) return memo
    memo = null
  }
  const written = writeHostManifest(hostLayerRoot(), hostManifestPath(), {
    pluginVersion: PLUGIN_VERSION,
    hostPid: process.pid,
    pluginRoot: path.resolve(HERE, '..'),
  })
  // 空扫描 = 没构建过（或布局不对）：宁可不写清单（Gateway 降级并说明），也不写一份空清单
  if (!written || written.fileCount === 0) return ''
  memo = hostManifestPath()
  return memo
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
      : '清单写不出来（未构建/布局不对）→ Gateway 降级回扫盘自证，note 里会写「降级」',
  }
}
