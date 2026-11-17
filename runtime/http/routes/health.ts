import type { IncomingMessage, ServerResponse } from 'node:http'
import { objArg } from './deps.js'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../core/json.js'
import { PLUGIN_VERSION } from '../../core/evidence.js'
import { hotReloadView } from '../../core/hot-reload.js'
import { readReloadState } from '../../core/reload-state.js'
import { blenderExeInfo } from '../../blender-exe.js'

/** provenance 单点取值：/health 与 /status 都要，坏了只降级不炸响应。 */
function provenanceOf(fn: (opts?: unknown) => unknown): Record<string, unknown> {
  try {
    return objArg(fn({}))
  } catch (e) {
    return { verdict: 'unknown', error: errorMessage(e) }
  }
}

/** H5：队列里被标 lost 的作业（最多 5 条，字段精简成"丢了什么"）。 */
function lostJobsOf(queue: unknown): Array<Record<string, unknown>> {
  try {
    const list = (queue as { list?: (filter?: unknown) => unknown } | null)?.list
    const rows = typeof list === 'function' ? list.call(queue, {}) : []
    if (!Array.isArray(rows)) return []
    return rows
      .filter((row) => objArg(row).lost === true)
      .slice(-5)
      .map((row) => {
        const job = objArg(row)
        return {
          id: job.id ?? null,
          kind: job.kind ?? null,
          state: job.state ?? null,
          finishedAt: job.finishedAt ?? null,
          lostReason: job.lostReason ?? null,
        }
      })
  } catch {
    return []
  }
}

/**
 * /status 的 payload（H7 版本自证 + H1 两层 provenance + H3 热更边界）。
 *
 * 为什么单独成函数：createHealthRoutes 是**路由表**（一行一个 handler），payload 是另一种职责；
 * 混在一起时它已经顶到 function-budget 的 120 行硬限。字段顺序 = 契约顺序，别重排。
 */
function statusPayload(
  E: HttpRouteDeps,
  prov: Record<string, unknown>,
  s: Record<string, unknown>,
  m: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: true,
    // H7：顶层版本自证。旧版只能从 provenance.pluginVersion 摸，脚本一步到位读不到。
    pluginVersion: PLUGIN_VERSION,
    // 宿主进程装载的 lib/index.js 版本 —— Gateway 看不到宿主进程，由宿主面合并
    // （blender_session action=status 会补）；直连 /status 时是 null + versions.note 说明。
    hostModuleVersion: null,
    // Gateway 自报（= 本进程装载的那一代）
    runtimeVersion: PLUGIN_VERSION,
    // H1：宿主层（宿主装载清单）+ 运行时层的合成自证（与 plugin.provenance 同一份，顶层直读）
    provenance: prov,
    // H3：热更边界声明（能热更什么 / 什么必须重启）+ H2 的**读侧**：
    // lastReload 是 DSH_BLENDER_WORKDIR/state/last-reload.json 的原样投影（两段式：
    // 旧宿主写 pending/pidBefore，新一代宿主补 pidAfter/verdict）。以前只写不读，
    // /status.hotReload.lastReload 恒 null —— 下游只能去 %TEMP% 翻文件。
    hotReload: { ...hotReloadView(), lastReload: readReloadState() },
    region: s.region,
    // statusView 已经把 addon 失败收进 addonError；路由必须透出，否则
    // presenter 的 addonError / addon_unresponsive 判定在生产里是死代码。
    addonError: s.addonError || null,
    readiness: s.readiness || null,
    plugin: s.plugin || null,
    versions: {
      plugin: PLUGIN_VERSION,
      hostModule: null,
      runtime: PLUGIN_VERSION,
      note:
        'plugin=磁盘构建版本 · runtime=Gateway 自报 · hostModule=宿主进程装载的 lib/index.js（' +
        '只有宿主面能填：blender_session action=status / action=reload）——三者一致且 verdict=current 才算换干净',
    },
    runs: s.runs || [],
    jobs: s.jobs || [],
    // H5：上一个 Gateway 换代时丢掉的作业（lost=true）。进程没了、记录还在 ——
    // /status 必须自己说出来，否则调用者面对 status=unknown 只能猜。
    jobsLost: lostJobsOf(E.jobQueue),
    ledger: s.ledger || null,
    stats: E.stats,
    metrics: m,
    // P2-9：实际被 spawn 的 blender.exe 与版本（"headless 跑 5.2、GUI 是 5.3" 这类差异必须可见）
    blender: blenderExeInfo(),
    diagnosis: m.lastError && m.lastDiagnosis ? m.lastDiagnosis : null,
  }
}

// HTTP 路由 /health：健康/状态/医生 + 已移除面板 410
export function createHealthRoutes(E: HttpRouteDeps) {
  const {
    PORT,
    describeConfig,
    engine,
    engineProvenance,
    json,
    leaseView,
    reqCounts,
    rttView,
    stats,
  } = E
  return {
    async health(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      json(res, 200, {
        ok: true,
        stats: stats,
        lease: leaseView(),
        requests: Object.fromEntries(reqCounts),
        // v0.9.4：分布 + 后端自身内存。⚠ 不含 blender.exe 的 RSS ——
        // 它在 Windows 侧，取一次要起 tasklist（~百 ms 级），不该塞进健康探针的热路径。
        rtt: rttView(),
        // v0.9.6：加载版本自证（内容哈希，不是 mtime）——"要不要重启后端"在这里一眼可见。
        // 只做本地读+哈希（~0.5 ms），不 spawn 干净进程；强对拍走 /plan op=catalog args={verify:true}。
        provenance: provenanceOf(engineProvenance),
        gateway: typeof E.gatewayOwner === 'function' ? (E.gatewayOwner as () => unknown)() : null,
        backend: {
          pid: process.pid,
          rssMB: Math.round(process.memoryUsage().rss / 1048576),
          uptimeMs: Date.now() - stats.startedAt,
        },
      })
      return
    },
    async gone(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      json(res, 410, {
        ok: false,
        error: 'gone',
        reason: '人肉视口面板（网页 UI + MJPEG 直播 + 输入注入）已移除',
        hint: '请关闭此标签页；Blender 交互改用 AI 通道：blender_see / blender_py / blender_see',
        removedAt: '2026-09-12',
      })
      return
    },
    async status(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      try {
        const s = objArg(await engine.status())
        const m = objArg(engine.metrics())
        json(res, 200, statusPayload(E, provenanceOf(engineProvenance), s, m))
      } catch (e) {
        const m2 = objArg(engine.metrics())
        json(res, 200, {
          ok: false,
          error: errorMessage(e),
          stats: stats,
          metrics: m2,
          diagnosis: errorField(e, 'diagnosis') || m2.lastDiagnosis || null,
        })
      }
      return
    },
    async doctor(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      try {
        const d = objArg(await engine.doctor())
        json(res, 200, {
          ok: true,
          ...d,
          config: describeConfig({ httpPort: PORT }),
          metrics: engine.metrics(),
          stats: stats,
        })
      } catch (e) {
        json(res, 200, { ok: false, error: errorMessage(e), metrics: engine.metrics() })
      }
      return
    },
  }
}
