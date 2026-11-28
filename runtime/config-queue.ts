/**
 * 作业队列容量的配置解析（Q-1）—— 从 runtime/config.ts 抽出来的独立模块。
 *
 * 为什么单独一个文件：config.ts 有自己的行预算（structure 600 行），而"四个容量键 + 解析规则"
 * 本来就是完整的一组；放在一起比散在大文件里更好读，也不必给 config.ts 开 file-budget 例外。
 *
 * 三段式与其它配置一致：环境变量 → 配置文件 `features.queue.<键>` → 默认值。
 * 默认恒为 **1 / 2 / 64 / 8**，**不做自适应**（不按设备数/核数/空闲内存浮动）——同一台机器
 * 今天 2 个 GPU slot、明天 1 个，比"配置要手写"更难排查。要改就显式写配置。
 */
import { isRecord, readString } from './foundation/json.js'

export interface QueueSetting {
  value: number
  source: string
}

/** 四个键的最终值与来源：CFG.features.queue / queueSource 直接引用这两个对象。 */
export interface QueueSettings {
  queue: { gpu: number; cpu: number; pending: number; ownerQuota: number }
  source: { gpu: string; cpu: string; pending: string; ownerQuota: string }
}

/**
 * 作业队列容量单键解析：env → 配置文件 `features.queue.<键>` → 默认值。
 *
 * 非法值（非数字 / 0 / 负数）回落到 `fallback`，来源记成 `invalid:*` —— 不假装是默认值，
 * doctor 与日志能看出"你配了但没生效"。纯函数：env 与文件值都由调用方给，单测不必起进程
 * （tests/unit/js/job-queue.test.ts）。
 */
export function resolveQueueSetting(input: {
  envName: string
  envValue: unknown
  /** 配置文件里这一键的原始值；**省略 = 配置段里没有这个键**（同一段缺键也是常态）。 */
  fileValue?: unknown
  fallback: number
  fileFrom?: string | null
}): QueueSetting {
  const fileFrom = String(input.fileFrom || 'config')
  const env = readString(input.envValue)
  if (env && env.trim()) {
    const n = Number(env)
    if (Number.isFinite(n) && n > 0) return { value: Math.trunc(n), source: 'env:' + input.envName }
    return { value: input.fallback, source: 'invalid:env:' + input.envName }
  }
  const raw = input.fileValue
  const given = raw !== undefined && raw !== null && String(raw).trim() !== ''
  if (!given) return { value: input.fallback, source: 'default' }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return { value: Math.trunc(n), source: 'file:' + fileFrom }
  return { value: input.fallback, source: 'invalid:file:' + fileFrom }
}

/** 配置文件里的 features.queue 段（缺失或类型不对一律当空段）。 */
function fileQueue(cfg: Record<string, unknown>): Record<string, unknown> {
  const features = isRecord(cfg.features) ? cfg.features : null
  const queue = features && isRecord(features.queue) ? features.queue : null
  return queue || {}
}

/**
 * 读出四个容量键。cfg / env / fileFrom 全由调用方给：这里不读文件、不碰 process.env，
 * 于是单测可以在任何机器上对拍而不受本机环境影响。
 */
export function readQueueSettings(
  cfg: Record<string, unknown>,
  env: Record<string, string | undefined>,
  fileFrom: string | null,
): QueueSettings {
  const file = fileQueue(cfg)
  const gpu = resolveQueueSetting({
    envName: 'DSH_BLENDER_QUEUE_GPU',
    envValue: env.DSH_BLENDER_QUEUE_GPU,
    fileValue: file.gpu,
    fallback: 1,
    fileFrom,
  })
  const cpu = resolveQueueSetting({
    envName: 'DSH_BLENDER_QUEUE_CPU',
    envValue: env.DSH_BLENDER_QUEUE_CPU,
    fileValue: file.cpu,
    fallback: 2,
    fileFrom,
  })
  const pending = resolveQueueSetting({
    envName: 'DSH_BLENDER_QUEUE_PENDING',
    envValue: env.DSH_BLENDER_QUEUE_PENDING,
    fileValue: file.pending,
    fallback: 64,
    fileFrom,
  })
  const ownerQuota = resolveQueueSetting({
    envName: 'DSH_BLENDER_QUEUE_OWNER_QUOTA',
    envValue: env.DSH_BLENDER_QUEUE_OWNER_QUOTA,
    fileValue: file.ownerQuota,
    fallback: 8,
    fileFrom,
  })
  return {
    queue: {
      gpu: gpu.value,
      cpu: cpu.value,
      pending: pending.value,
      ownerQuota: ownerQuota.value,
    },
    source: {
      gpu: gpu.source,
      cpu: cpu.source,
      pending: pending.source,
      ownerQuota: ownerQuota.source,
    },
  }
}
