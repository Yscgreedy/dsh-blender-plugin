// Gateway 侧的热更 / 关停控制面（挂在既有 /lease 的动作分发上，不新增路由）。
//
// 为什么要分两个面（工具面 vs HTTP 面）：
//   - 宿主侧 src/host/reload/ 手里有 Gateway 子进程句柄，能真正「杀 → 重拉 → 复验 pid」；
//   - Gateway 自己只能重启自己（退出后由宿主看护/下次工具调用从磁盘重拉），拿不到 pidAfter。
// 所以这里返回同一套 ReloadReport 结构，但 mode/pidAfter 的语义按能做的写清楚，
// **失败不静默**：做不了的都进 needsRestart。
import type { HttpRouteDeps } from '../deps.js'
import { objArg } from '../deps.js'
import { hostProvenance } from '../../../foundation/evidence.js'
import type { HostLayerProvenance } from '../../../foundation/evidence.js'
import {
  decideReloadMode,
  emptyReloadReport,
  hotReloadView,
  splitChanged,
} from '../../../core/hot-reload.js'
import type { ReloadMode, ReloadReport } from '../../../core/hot-reload.js'
import type { SessionResult } from '../../../core/sessions/types.js'
import { hostLayerAtEdge } from '../health.js'

export type ControlResult = SessionResult<Record<string, unknown>>

/** 宿主（插件 disposer）与测试注入的收尾钩子；Gateway 进程入口会打开 selfExit。 */
export interface GatewayControl {
  selfExit: boolean
  close: () => void
  pid: number
}

function runtimeVerdictOf(prov: Record<string, unknown>): string {
  const rt = objArg(prov.runtime)
  return String(rt.verdict || prov.verdict || 'unknown')
}

/** 排定退出：先让响应写完，再关服务器收尾（自愈由宿主看护负责）。 */
function scheduleExit(E: HttpRouteDeps, code: number): boolean {
  const control = objArg(E.gatewayControl) as unknown as GatewayControl
  if (!control || control.selfExit !== true) return false
  setTimeout(() => {
    try {
      if (typeof control.close === 'function') control.close()
    } catch (e) {
      /* close 失败也要退：pid 必须换掉，否则「重启」是假的 */
    }
    process.exit(code)
  }, 120)
  return true
}

/** 相对包根的 posix 路径（runtime 层只认 facade：Gateway 只对 engine.js 做单点判定）。 */
function runtimeRelPath(prov: Record<string, unknown>): string {
  const src = String(prov.sourcePath || '')
    .split('\\')
    .join('/')
  const at = src.lastIndexOf('/lib/runtime/')
  if (at >= 0) return src.slice(at + 1)
  const tail = src.split('/').pop()
  return 'lib/runtime/' + String(tail || 'engine.js')
}

/** hmr 的成因分三种：宿主层真有变 / 判不了 / force。回执必须说清是哪一种。 */
function explainHmr(
  host: HostLayerProvenance,
  force: boolean,
): {
  root_cause: string
  needsRestart: string[]
  note: string
} {
  const changed = Number(host.changedCount || 0)
  const files = Array.isArray(host.changedFiles) ? host.changedFiles.slice(0, 3).join(', ') : ''
  if (changed > 0) {
    return {
      root_cause:
        '宿主层变了 ' +
        String(changed) +
        ' 个文件（' +
        files +
        '）：重组合 profile 只有宿主做得到，Gateway 只能诊断',
      needsRestart: [
        '宿主层变了 ' +
          String(changed) +
          ' 个文件：必须由宿主重组合 profile（HMR）——工具面 blender_session action=reload 会写 ' +
          'profile 的 cordis.patch.yml 触发它；HTTP 面拿不到这一步',
      ],
      note: 'Gateway 自身无需换：宿主层换代码必须由宿主重组合',
    }
  }
  const why = force
    ? 'force=true：跳过判据，强制重组合一次'
    : '宿主层判不了（' +
      String(host.note || '没有可信的已装载清单') +
      '）：无法证明宿主 fiber 已是磁盘这一代'
  return {
    root_cause: why + '；判不了 ≠ 已是最新，所以不回 noop',
    needsRestart: [
      why +
        '：只有宿主重组合能重写清单并自证 —— 工具面 blender_session action=reload 会写 profile 的 ' +
        'cordis.patch.yml；HTTP 面拿不到这一步',
    ],
    note: force
      ? 'force=true：已跳过判据，交给宿主重组合后重新自证'
      : '宿主层判不了（清单缺失/读不到/不属于本安装）→ 交给宿主重组合，别再拿增量 diff 当「已是最新」',
  }
}

/** 比对磁盘与已装载，给出 ReloadReport。apply=false 只诊断不动进程（dry-run）。 */
export function buildReloadReport(
  E: HttpRouteDeps,
  payload: Record<string, unknown>,
): ReloadReport {
  const t0 = Date.now()
  // 4a：宿主层快照在 HTTP 边界显式取一次（清单路径来自 env）—— engineProvenance 与
  // hostProvenance 共用同一份，foundation 不再自己发现 env/扫盘两次。
  const hostSnap = hostLayerAtEdge()
  const prov = objArg(E.engineProvenance({ layers: { host: hostSnap } }))
  // 宿主层必须吃 fresh：刚构建完就问，不能命中 /health 的短 TTL 缓存
  const host = hostProvenance(true, hostSnap)
  const runtimeStale = runtimeVerdictOf(prov) === 'stale'
  // current / stale = 有可信的「已装载」两侧；unknown = 判不了（缺清单 / 别人的清单）
  const hostKnown = host.verdict === 'current' || host.verdict === 'stale'
  const force = payload.force === true || payload.force === 'true'
  const mode: ReloadMode = force
    ? 'hmr'
    : decideReloadMode({ hostChanged: host.changedCount, runtimeStale, hostKnown })

  const paths: string[] = host.changedFiles.map((p) => 'lib/' + p)
  if (runtimeStale) paths.push(runtimeRelPath(prov))
  const { changed, count } = splitChanged(paths)
  const report = emptyReloadReport({
    ok: true,
    mode,
    changed,
    changedCount: count,
    pidBefore: process.pid,
    pidAfter: process.pid,
    verdict: (mode === 'noop'
      ? 'current'
      : host.verdict === 'stale' || runtimeStale
        ? 'stale'
        : 'unknown') as ReloadReport['verdict'],
    staleLayer: Array.isArray(prov.staleLayer) ? (prov.staleLayer as string[]) : [],
    hotReload: hotReloadView(),
    layers: { host, runtime: objArg(prov.runtime), hostKnown, forced: force },
    ms: 0,
    note: '',
  })
  const apply = payload.apply !== false && payload.apply !== 'false'
  if (mode === 'noop') {
    report.note =
      '磁盘两层（host / runtime）都与已装载一致：noop，没有动 pid（' + String(process.pid) + '）'
  } else if (mode === 'hmr') {
    report.ok = false
    report.pending = true
    // 失败面也要能自证：没有 code/root_cause 时，HTTP 边缘只会回一句 "request failed"，
    // 连 mode 都读不到（下游第二轮验收的原话：被包成 "SESSION reload 失败 · request failed"）。
    report.code = 'reload_host_layer'
    report.stage = 'config'
    const why = explainHmr(host, force)
    report.root_cause = why.root_cause
    report.fix =
      'blender_session action=reload（宿主面：写 profile 的 cordis.patch.yml 触发 HMR，并把同一份 ' +
      'ReloadReport 原样回给模型）；HTTP 面 POST /lease{action:"reload"} 只诊断'
    report.needsRestart = why.needsRestart
    report.note = why.note
  } else if (mode === 'gateway-restart') {
    report.pending = true
    report.pidAfter = null
    if (apply) {
      report.note =
        '本进程即将退出（120ms）：宿主看护/下次工具调用会从磁盘重拉 lib/runtime/gateway.js → 新 pid。' +
        'pidAfter=null + pending=true 是正常语义（本进程报不出自己的后继 pid）——' +
        '用 GET /health 的 backend.pid（等价 /status）复核新 pid，再问一次 provenance 应变 current'
      report.layers = { ...report.layers, exitScheduled: scheduleExit(E, 75) }
    } else {
      report.ok = false
      report.code = 'reload_dry_run'
      report.stage = 'config'
      report.root_cause =
        'apply=false（dry-run）：运行时层变了 ' + String(count.runtime) + ' 个文件，未执行重启'
      report.fix =
        '去掉 apply=false（或工具面 dry_run=false）再调一次；宿主面会把 Gateway 换代并回 pidAfter'
      report.needsRestart = [
        'apply=false（dry-run）：运行时层变了 ' + String(count.runtime) + ' 个文件，未执行重启',
      ]
      report.note = 'dry-run：只诊断不动进程'
    }
  }
  report.ms = Date.now() - t0
  return report
}

/** action=shutdown：插件 dispose / 热更重启前的收尾（H4 + H5）。 */
export async function drainGateway(
  E: HttpRouteDeps,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = String(payload.reason || 'gateway shutdown')
  const stopped = await E.sessionRegistry.disposeAll()
  const jobsDropped = E.jobQueue.cancelAll(reason)
  const exitScheduled = scheduleExit(E, 0)
  return {
    ok: true,
    stopped: stopped.stopped,
    failed: stopped.failed,
    jobsDropped,
    exitScheduled,
    reason,
    note:
      'virtual-gui 会话已按 ledger 收敛（helper + 隐藏 Blender 一并停），' +
      '非终态作业已置 canceled（重新入口 = 重新 submit）',
  }
}

export function controlFailure(code: string, rootCause: string, fix: string): ControlResult {
  return {
    ok: false,
    code,
    stage: 'transport',
    root_cause: rootCause,
    fix,
    fallback: { kind: 'unavailable', summary: rootCause },
    evidence: {},
  }
}
