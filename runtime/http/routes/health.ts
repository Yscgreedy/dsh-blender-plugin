import type { IncomingMessage, ServerResponse } from 'node:http'
import { objArg } from './deps.js'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../core/json.js'
import { PLUGIN_VERSION } from '../../core/evidence.js'
import { hotReloadView } from '../../core/hot-reload.js'
import { readReloadState } from '../../core/reload-state.js'
import { blenderExeInfo } from '../../blender-exe.js'
import { collectLocalEvidence } from '../../core/local-evidence.js'
import { gatewayInstances } from '../../transport/addon-ws.js'

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
    // 顶层镜像：status 不需要去 region 里翻；老 presenter/老 agent 也能直读。
    runtimeModules: objArg(objArg(s.region).runtime_modules),
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

/** 查询串里的真值：1/true/yes 都算（工单 6 注入点用它，别要求用户记大小写）。 */
function truthy(v: string | null | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * 工单 6：/status?evidence=1[&probeFixture=…]。
 * 默认**不扫**（tasklist/netstat 是百毫秒级，不该塞进 status 热路径）；list 与 doctor 显式要。
 */
function evidenceFor(
  url: URL | undefined,
  gatewayPort: number,
  extra: {
    workerPids?: Array<number | { pid?: number; port?: number }>
    addonConnected?: boolean
  } = {},
): Record<string, unknown> | null {
  const q = url?.searchParams
  if (!q) return null
  const fixture = q.get('probeFixture') || q.get('probe_fixture')
  if (fixture)
    return collectLocalEvidence({
      gatewayPort,
      probeFixture: fixture,
      ...extra,
    }) as unknown as Record<string, unknown>
  if (!truthy(q.get('evidence') || q.get('evidenceOnly') || q.get('localEvidence'))) return null
  return collectLocalEvidence({ gatewayPort, ...extra }) as unknown as Record<string, unknown>
}

/**
 * worker 注册表里活着的 pid + 真实端口（工单 6d）。
 * 反馈 7: reporting only pids made every worker inherit the default port 9879.
 */
function workerPidsOf(engine: {
  worker?: { list?: () => Array<Record<string, unknown>> }
}): Array<{ pid: number; port?: number }> {
  try {
    const rows = engine.worker?.list?.() || []
    return rows
      .filter((w) => w.alive === true)
      .map((w) => {
        const pid = Number(w.pid)
        const port = Number(w.port)
        return Number.isInteger(port) && port > 0 ? { pid, port } : { pid }
      })
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0)
  } catch {
    return []
  }
}

/**
 * 工单 6 的 /doctor 注入点（工单里的键必须真能激活）：
 *   forceNoAddon=1 / force_no_addon=1（或 DSH_BLENDER_FORCE_NO_ADDON=1）→ 不看 addon 也出诊断
 *   probeFixture=<path> → 用诱饵 fixture 回放端口证据（6c）
 *
 * 其它 P11 的注入键（版本漂移自证）走 P11 自己的差异面，不在这一份补丁里。
 */
function doctorOptions(url: URL | undefined): Record<string, unknown> {
  const q = url?.searchParams
  const forceNoAddon =
    truthy(q?.get('forceNoAddon') || q?.get('force_no_addon') || null) ||
    truthy(process.env.DSH_BLENDER_FORCE_NO_ADDON)
  return {
    forceNoAddon,
    probeFixture: q?.get('probeFixture') || q?.get('probe_fixture') || null,
  }
}

/** local_evidence.sessions 的投影（未认领时长度 0；字段与 list 行一致）。 */
function sessionBriefs(E: HttpRouteDeps): unknown[] {
  try {
    return E.sessionRegistry.list().map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      instanceId: row.instanceId || null,
    }))
  } catch {
    return []
  }
}

/**
 * 0 会话文案要用的「addon 在不在 + 可粘贴的 attach」。
 * 只读 Gateway 内存里的实例表（不探测），所以 list 不需要额外往返。
 */
function attachView(engineAddon: unknown): Record<string, unknown> {
  const instances = gatewayInstances(engineAddon) || []
  const ready = instances.filter((x) => x.ready)
  return {
    connected: ready.length > 0,
    ready_instances: ready.length,
    instanceId: ready.length === 1 ? ready[0].instanceId : null,
    next_actions: ready
      .slice(0, 3)
      .map((x) => 'blender_session action=attach instance_id=' + String(x.instanceId)),
  }
}

/** GET /status：常规状态 + 可选本地证据（工单 6）；evidenceOnly=1 是 list 的轻量取证据面。 */
async function statusRoute(E: HttpRouteDeps, res: ServerResponse, url: URL): Promise<void> {
  const { PORT, engine, engineProvenance, json, stats } = E
  if (truthy(url.searchParams.get('evidenceOnly'))) {
    const attach = attachView(E.addon ?? engine.addon)
    const evidence = evidenceFor(url, PORT, {
      workerPids: workerPidsOf(engine),
      addonConnected: attach.connected === true,
    })
    if (evidence) evidence.sessions = sessionBriefs(E)
    json(res, 200, {
      ok: true,
      local_evidence: evidence,
      addon: attach,
      next_actions: attach.next_actions,
    })
    return
  }
  try {
    const s = objArg(await engine.status())
    const m = objArg(engine.metrics())
    const payload = statusPayload(E, provenanceOf(engineProvenance), s, m)
    // 工单 6：list 要能看见 local_processes / ports / ports_evidence —— 显式 evidence=1 才扫。
    const attach = attachView(E.addon ?? engine.addon)
    const evidence = evidenceFor(url, PORT, {
      workerPids: workerPidsOf(engine),
      addonConnected: attach.connected === true,
    })
    if (evidence) payload.local_evidence = evidence
    json(res, 200, payload)
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
}

/** GET /doctor：forced no-addon / fixture 回放 + 同源证据（6b/c）。 */
async function doctorRoute(E: HttpRouteDeps, res: ServerResponse, url: URL): Promise<void> {
  const { PORT, describeConfig, engine, json, stats } = E
  try {
    const opts = doctorOptions(url)
    const attach = attachView(E.addon ?? engine.addon)
    // The addon probe waits on a socket (up to its own budget); run the local
    // process/port scan while that wait is in flight instead of after it, so a
    // half-open addon does not pay both budgets back to back (doctor-bounded).
    const evidencePromise = new Promise<Record<string, unknown>>((resolve) => {
      setImmediate(() => {
        resolve(
          collectLocalEvidence({
            gatewayPort: PORT,
            probeFixture: typeof opts.probeFixture === 'string' ? opts.probeFixture : null,
            workerPids: workerPidsOf(engine),
            addonConnected: attach.connected === true,
          }) as unknown as Record<string, unknown>,
        )
      })
    })
    const d = objArg(await engine.doctor(opts))
    // 工单 6：no-addon 态也必须给端口证据 —— 证据在路由层合并，engine 不必知道扫描。
    d.local_evidence = await evidencePromise
    const evidence = objArg(d.local_evidence)
    evidence.sessions = sessionBriefs(E)
    // verdict 判的是"现场证据是否完整可信"（ok 判 addon 通道，两件事分开）。
    d.verdict = evidence.ok === true && evidence.degraded !== true ? 'ok' : 'degraded'
    if (evidence.degraded === true) d.evidence_error = evidence.error || 'scan degraded'
    // 0 会话/无 addon 时也要给**可粘贴**的 attach（3.1+ addon 主动拨入，不需要点 Connect）。
    if (!Array.isArray(d.next_actions) || d.next_actions.length === 0) {
      d.next_actions = attach.next_actions
    }
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
}

// HTTP 路由 /health：健康/状态/医生 + 已移除面板 410
export function createHealthRoutes(E: HttpRouteDeps) {
  const { engineProvenance, json, leaseView, reqCounts, rttView, stats } = E
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
    status(req: IncomingMessage, res: ServerResponse, url: URL, _p: string): Promise<void> {
      return statusRoute(E, res, url)
    },
    doctor(req: IncomingMessage, res: ServerResponse, url: URL, _p: string): Promise<void> {
      return doctorRoute(E, res, url)
    },
  }
}
