/**
 * H2（热更新不重启）：reload 状态文件 —— 宿主层重组合是**异步**的（触发现有 DSH HMR，
 * 旧 fiber 被拆、新 fiber 重新 activate），所以「谁触发、pid 从几换到几、最后判定如何」
 * 必须落一份盘上的两段式记录，否则工具面只能回一句 pending，下游没法自证。
 *
 * 写：宿主侧（src/host/reload.ts）在触发重组合前写 { pending: true, mode: 'hmr', pidBefore }
 * 补：新一代宿主 activate 后（registerLifecycle）写 { pending: false, pidAfter, verdict }
 * 读：/status.hotReload.lastReload、blender_session action=reload 的最近一次结果
 *
 * 纯 fs/path：Gateway 与宿主两侧共用同一份路径规则（宿主经 runtime-bridge 复用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ReloadState {
  /** schema 版本，不匹配就当没有记录 */
  schema: 1
  /** 谁触发的：hmr（宿主重组合）/ gateway-restart（只换 Gateway）/ noop */
  mode: 'noop' | 'hmr' | 'gateway-restart'
  /** 触发时的 Gateway pid */
  pidBefore: number | null
  /** 换完之后的新 Gateway pid（重组合路径由新一代宿主补写） */
  pidAfter: number | null
  /** 触发时刻（ISO） */
  startedAt: string
  /** 收尾时刻（ISO）；pending=true 时为空 */
  finishedAt: string | null
  /** 还没收尾 → true（上一代宿主可能已经不在，别假装成功） */
  pending: boolean
  /** 收尾时的 provenance.verdict */
  verdict: string | null
  /** 变化清单（最多 20 条） */
  changed: { host: string[]; runtime: string[] }
  /** 为什么必须重启（宿主依赖 / 客户端 bundle 等） */
  needsRestart: string[]
  /** 触发/收尾失败原因 */
  error: string | null
  /** 这次 reload 取消掉的作业 id（H5：换代后仍要能从 lastReload 里查到"我的作业去哪了"） */
  jobsDropped: string[]
}

const STATE_DIR_ENV = 'DSH_BLENDER_WORKDIR'
const STATE_FILE = 'last-reload.json'

/** 状态目录：与 Gateway 日志同一套来源（DSH_BLENDER_WORKDIR/state 或 os.tmpdir()/dsh-blender-gateway）。 */
export function reloadStateDir(): string {
  const workdir = String(process.env[STATE_DIR_ENV] || '')
  return workdir ? path.join(workdir, 'state') : path.join(os.tmpdir(), 'dsh-blender-gateway')
}

export function reloadStatePath(): string {
  return path.join(reloadStateDir(), STATE_FILE)
}

/** 读最近一次 reload 记录；没有/坏掉返回 null。 */
export function readReloadState(): ReloadState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(reloadStatePath(), 'utf8'))
    const rec = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    if (!rec || Number(rec.schema) !== 1) return null
    const mode = String(rec.mode || 'noop')
    return {
      schema: 1,
      mode: mode === 'hmr' || mode === 'gateway-restart' ? mode : 'noop',
      pidBefore: Number.isFinite(Number(rec.pidBefore)) ? Number(rec.pidBefore) : null,
      pidAfter: Number.isFinite(Number(rec.pidAfter)) ? Number(rec.pidAfter) : null,
      startedAt: String(rec.startedAt || ''),
      finishedAt: typeof rec.finishedAt === 'string' ? rec.finishedAt : null,
      pending: rec.pending === true,
      verdict: typeof rec.verdict === 'string' ? rec.verdict : null,
      changed: {
        host: stringList(rec.changed, 'host'),
        runtime: stringList(rec.changed, 'runtime'),
      },
      needsRestart: stringList(rec, 'needsRestart'),
      error: typeof rec.error === 'string' ? rec.error : null,
      jobsDropped: stringList(rec, 'jobsDropped'),
    }
  } catch {
    return null
  }
}

function stringList(source: unknown, key: string): string[] {
  const rec = source && typeof source === 'object' ? (source as Record<string, unknown>) : {}
  const raw = Array.isArray(rec[key]) ? (rec[key] as unknown[]) : []
  return raw.map((x) => String(x))
}

/** 写最近一次 reload 记录（目录不存在就建；失败返回 false，不抛）。 */
export function writeReloadState(state: ReloadState): boolean {
  try {
    fs.mkdirSync(reloadStateDir(), { recursive: true })
    fs.writeFileSync(
      reloadStatePath(),
      JSON.stringify(state, null, 2) + String.fromCharCode(10),
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/** 把一次 reload 的收尾结果合并进已有记录（没有就新建）。 */
export function settleReloadState(patch: Partial<ReloadState>): ReloadState | null {
  const base = readReloadState()
  const now = new Date().toISOString()
  const merged: ReloadState = {
    schema: 1,
    mode: patch.mode || base?.mode || 'noop',
    pidBefore: patch.pidBefore ?? base?.pidBefore ?? null,
    pidAfter: patch.pidAfter ?? base?.pidAfter ?? null,
    startedAt: patch.startedAt || base?.startedAt || now,
    finishedAt: patch.finishedAt === undefined ? now : patch.finishedAt,
    pending: patch.pending === undefined ? false : patch.pending,
    verdict: patch.verdict ?? base?.verdict ?? null,
    changed: patch.changed || base?.changed || { host: [], runtime: [] },
    needsRestart: patch.needsRestart || base?.needsRestart || [],
    error: patch.error === undefined ? (base?.error ?? null) : patch.error,
    jobsDropped: patch.jobsDropped || base?.jobsDropped || [],
  }
  return writeReloadState(merged) ? merged : null
}
