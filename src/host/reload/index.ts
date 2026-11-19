/**
 * host/reload：H2（一步式 reload）的**宿主侧执行面**。
 *
 * 分工（两轮验收后的定论）：
 *   - Gateway（runtime/http/routes/session/control.ts）只能**诊断**：它看得见两层 provenance，
 *     但对宿主 fiber 与 profile 都无权限 —— 撞宿主层只能回 409 `mode=hmr` + needsRestart。
 *   - 宿主（本模块）才做得到：写 profile 的 cordis.patch.yml 触发 HMR 重组合；
 *     或杀掉自己手里的 Gateway 子进程句柄后从磁盘重拉（运行时层）。
 *
 * 回执只有一份 ReloadReport（runtime/core/hot-reload.ts 定义，工具面与 HTTP 面同构）：
 * 本模块拿 Gateway 的诊断当底稿，再把**宿主真正做了的事**填进去（pidAfter / pending / receipt /
 * needsRestart / note）。所以模型永远看得到「为什么没换干净」，不会被包成一句 request failed。
 *
 * H5（作业跨 reload）：两条路径都**先 drain 再动进程**，把 drain 回执并进 ReloadReport ——
 * jobsDropped / stopped 是"你的作业已经被取消"的唯一证据（上一轮实测：作业被置 canceled，
 * 回执却什么都没有，用户以为它还在跑）。note 里点名列 id，并说明"重跑 = 重新 submit"。
 */
import { asRecord, text } from '../../contracts/dynamic.js'
import { backendJson, backendPost } from '../http.js'
import { killChildHandle, ensureBackend, sleep } from '../backend/index.js'
import { drainGateway } from '../backend/drain.js'
import type { DrainReceipt } from '../backend/drain.js'
import {
  emptyReloadReport,
  readReloadState,
  settleReloadState,
  writeReloadState,
} from '../runtime-bridge.js'
import type { ReloadMode, ReloadReport } from '../runtime-bridge.js'
import { hostSelfProvenance } from '../backend/host-manifest.js'
import type { HostSelfProvenance } from '../backend/host-manifest.js'
import { resolveProfileDir, triggerProfileHmr } from './profile.js'
import type { PatchReceipt } from './profile.js'

export { PROFILE_DIR_ENV, PATCH_FILE, resolveProfileDir, triggerProfileHmr } from './profile.js'

const RELOAD_MODES = ['noop', 'hmr', 'gateway-restart', 'unavailable'] as const

export interface HostReloadInput {
  port: number
  /** false = dry-run（只诊断，不写 profile、不动 pid） */
  apply?: boolean
  reason?: string
  /** 测试注入：取 Gateway pid */
  gatewayPid?: (port: number) => Promise<number | null>
  /** 测试注入：重启 Gateway 子进程（默认 killChildHandle + ensureBackend） */
  restart?: (port: number) => Promise<boolean>
  /** 测试注入：profile 触发动作 */
  trigger?: (opts: { dir?: string | null; reason?: string; now?: Date }) => PatchReceipt
  /** 测试注入：drain 回执（默认真打 POST /lease{action:"shutdown"}） */
  drain?: (port: number, reason: string) => Promise<DrainReceipt>
  /** 测试注入：drain 之后 HMR 触发失败时的补偿重拉（默认 ensureBackend） */
  recover?: (port: number) => Promise<boolean>
  /** 测试注入：现在 */
  now?: () => Date
  /**
   * 测试注入：宿主自己的层自证（默认 hostSelfProvenance：**装载时**指纹 vs 磁盘现在）。
   * 工具面用它兜底 Gateway 的诊断 —— 清单可能缺失/被别的安装覆盖，但那都不影响宿主自己知道
   * 「我装载的是哪一代」。
   */
  hostSelf?: () => HostSelfProvenance
  /** true = 不看判据，强制重组合一次（把中断过的热更救回来）；dry-run 时只报会做什么 */
  force?: boolean
}

/** Gateway 的 pid（来自 /health.backend.pid；拿不到返回 null）。 */
export async function gatewayPid(port: number): Promise<number | null> {
  try {
    const health = await backendJson(port, '/health', 5000)
    const pid = Number(asRecord(health.backend).pid)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** /status.provenance.verdict —— reload 之后「到底换干净没有」的唯一判据。 */
export async function provenanceVerdict(port: number): Promise<ReloadReport['verdict']> {
  try {
    const status = await backendJson(port, '/status', 20000)
    const verdict = String(asRecord(status.provenance).verdict || '')
    return verdict === 'current' || verdict === 'stale' ? verdict : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 等新 pid 出现（Gateway 换代是异步的：旧进程退出 + 新进程监听都要时间）。 */
async function waitForNewPid(
  port: number,
  before: number | null,
  timeoutMs: number,
  getPid: (port: number) => Promise<number | null> = gatewayPid,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = await getPid(port)
    if (pid !== null && pid !== before) return pid
    await sleep(250)
  }
  return await getPid(port)
}

function unreachable(port: number, error: string): ReloadReport {
  return emptyReloadReport({
    ok: false,
    mode: 'unavailable',
    verdict: 'unknown',
    needsRestart: [
      'Gateway 不可达（127.0.0.1:' +
        String(port) +
        '：' +
        error +
        '）：两层 provenance 都在 Gateway 里，读不到就无法判定哪层变了',
    ],
    note: 'reload 需要 Gateway 的 /lease{action:reload,apply:false} 诊断；先让插件拉起 Gateway（blender_session action=doctor）',
  })
}

/** 向 Gateway 要一份**只诊断**的 ReloadReport（apply:false → 它不会自己退出）。 */
async function diagnose(port: number): Promise<{ report: ReloadReport; error: string | null }> {
  let body: Record<string, unknown>
  try {
    body = await backendPost(port, '/lease', { action: 'reload', apply: false }, 20000)
  } catch (e: unknown) {
    return {
      report: unreachable(port, e instanceof Error ? e.message : String(e)),
      error: 'transport',
    }
  }
  const mode = String(body.mode || '')
  if (!(RELOAD_MODES as readonly string[]).includes(mode)) {
    const why = String(body.root_cause || body.error || body.code || body.raw || 'no ReloadReport')
    return { report: unreachable(port, why), error: why }
  }
  return { report: body as unknown as ReloadReport, error: null }
}

function changedOf(report: ReloadReport): { host: string[]; runtime: string[] } {
  const changed = asRecord(report.changed)
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(text) : [])
  return { host: list(changed.host), runtime: list(changed.runtime) }
}

function needsOf(report: ReloadReport): string[] {
  return Array.isArray(report.needsRestart) ? report.needsRestart.map(text).filter(Boolean) : []
}

/** 本次 reload 用哪套 drain（默认真的去 Gateway 要 shutdown 回执；测试可注入）。 */
function drainOf(input: HostReloadInput): (port: number, reason: string) => Promise<DrainReceipt> {
  return input.drain || ((port: number, reason: string) => drainGateway(port, reason))
}

/**
 * 把 drain 回执并进 ReloadReport（H5）：`jobsDropped` / `stopped` 是模型**唯一**看得见的
 * "作业已经没了"的证据 —— 上一轮实测里 reload 把作业置了 canceled，回执却什么都没报，
 * 用户以为它还在跑。整份 drain 回执另外留在 layers.drain 里（含 failed / exitScheduled / ms）。
 */
function mergeDrain(report: ReloadReport, drained: DrainReceipt): void {
  report.layers = { ...report.layers, drain: drained }
  report.jobsDropped = [...drained.jobsDropped]
  report.stopped = [...drained.stopped]
}

/** drain 的一句话（拼进 note）：取消的作业必须点名列 id，并说清"重跑 = 重新 submit"。 */
function drainNote(drained: DrainReceipt): string {
  const parts: string[] = []
  if (drained.jobsDropped.length) {
    parts.push(
      '本次取消 ' +
        String(drained.jobsDropped.length) +
        ' 个在跑作业（' +
        drained.jobsDropped.join(', ') +
        '），重跑请重新 submit',
    )
  }
  if (drained.stopped.length) {
    parts.push(
      '停了 ' + String(drained.stopped.length) + ' 个会话（' + drained.stopped.join(', ') + '）',
    )
  }
  if (drained.failed.length) {
    parts.push(
      '收尾失败 ' + String(drained.failed.length) + ' 个会话（' + drained.failed.join(', ') + '）',
    )
  }
  if (!drained.ok) {
    parts.push(
      'drain 未成功（' +
        String(drained.error || 'unknown') +
        '）：作业可能随进程树被直接带走，台账里会留 running（下一位调用者看到 lost/stale）',
    )
  }
  if (parts.length === 0)
    parts.push('drain 干净：没有在跑作业/会话要收（' + String(drained.ms) + 'ms）')
  return parts.join('；')
}

/**
 * 一步式 reload（工具面入口）。
 *
 * mode=noop            → 不动 pid（也不写 profile）：磁盘两层都已装载。
 * mode=hmr             → 写 profile patch 触发 HMR 重组合（pidAfter=null / pending=true 是正常语义）。
 * mode=gateway-restart → 杀宿主手里的 Gateway 句柄 + 从磁盘重拉，回 pidAfter 与复核后的 verdict。
 */
export async function hostReload(input: HostReloadInput): Promise<ReloadReport> {
  const t0 = Date.now()
  const port = input.port
  const apply = input.apply !== false
  const now = input.now || (() => new Date())
  const pidBefore = await (input.gatewayPid || gatewayPid)(port)
  const diag = await diagnose(port)
  const report: ReloadReport = {
    ...diag.report,
    pidBefore: pidBefore ?? diag.report.pidBefore ?? null,
  }
  const finish = (): ReloadReport => {
    report.ms = Date.now() - t0
    return report
  }
  if (diag.error !== null) {
    report.pidAfter = report.pidBefore
    return finish()
  }
  const diagMode = String(report.mode || 'noop')
  // 宿主自己知道装载的是哪一代：装载时指纹 vs 磁盘。判不了/不一致就不许 noop ——
  // Gateway 可能拿的是别人的清单，或者清单根本没写成（2026-11-19 的假绿）。
  const self = (input.hostSelf || hostSelfProvenance)()
  report.layers = { ...report.layers, hostSelf: self }
  const escalated = input.force === true || self.verdict === 'stale'
  const mode: ReloadMode = escalated ? 'hmr' : (diagMode as ReloadMode)
  report.mode = mode

  if (mode === 'noop') {
    report.ok = true
    report.pending = false
    report.pidAfter = report.pidBefore
    report.verdict = 'current'
    report.needsRestart = needsOf(report).filter((n) => !/dry-run/.test(n))
    report.note =
      '宿主层与运行时层都已装载 = 磁盘：noop，没有动 pid（' +
      String(report.pidBefore) +
      '）、没有写 profile'
    return finish()
  }

  // 两种动作都由宿主完成，且都**就地**改写同一份 report（工具面拿到的就是它）
  const basis =
    mode === 'hmr' ? escalatedDiag(diag.report, self, input.force === true) : diag.report
  if (escalated) {
    report.changed = basis.changed
    report.changedCount = basis.changedCount
    report.staleLayer = basis.staleLayer
    report.needsRestart = basis.needsRestart
  }
  if (mode === 'hmr') await hostLayerReload(report, input, apply, now, basis)
  else await runtimeLayerReload(report, input, apply, diag.report)
  if (escalated) {
    // 成功触发时 needsRestart 按语义清空（pending=true 就是"已经动手了"），所以「为什么升成
    // hmr」必须写进 note，否则下游只看到 mode=hmr 而不知道为什么。
    const why =
      input.force === true
        ? 'force=true：不看判据，强制重组合'
        : '宿主层装载时指纹与磁盘不一致（' +
          String(self.changedCount) +
          ' 个文件）：不采信 Gateway 的 noop'
    report.note = why + '；' + report.note
  }
  return finish()
}

/**
 * 把「宿主自己判出旧一代 / force」并进 diag：hmr 路径的 reasons 与 changed 都从 diag 取，
 * 不并进去就会出现 mode=hmr 但 changedCount.host=0、needsRestart=[] 的空回执。
 */
function escalatedDiag(diag: ReloadReport, self: HostSelfProvenance, force: boolean): ReloadReport {
  const files = self.changedFiles.length ? self.changedFiles : []
  const why = force
    ? 'force=true：跳过判据，强制重组合一次'
    : '宿主层装载时指纹与磁盘不一致（' + String(self.changedCount) + ' 个文件）'
  return {
    ...diag,
    mode: 'hmr',
    changed: { ...diag.changed, host: files.map((p) => 'lib/' + p) },
    changedCount: { ...diag.changedCount, host: self.changedCount },
    staleLayer: Array.from(new Set([...(diag.staleLayer || []), 'host'])),
    needsRestart: [...needsOf(diag), why + '：要宿主重组合（HMR）后才能自证'],
  }
}

/** 宿主层：写 profile 的 cordis.patch.yml，让 dsh-hmr 拆旧 fiber / 拉新 fiber。 */
async function hostLayerReload(
  report: ReloadReport,
  input: HostReloadInput,
  apply: boolean,
  now: () => Date,
  diag: ReloadReport,
): Promise<ReloadReport> {
  const reasons = needsOf(diag)
  if (!apply) {
    report.ok = false
    report.pending = false
    report.pidAfter = report.pidBefore
    report.needsRestart = [
      ...reasons,
      'dry-run（dry_run=true / apply=false）：只诊断，没有写 profile patch',
    ]
    report.note =
      'dry-run：宿主层需要重组合（变了 ' +
      String(diag.changedCount?.host ?? reasons.length) +
      ' 处；' +
      String(reasons[0] || '见 needsRestart') +
      '），未写 profile patch'
    return report
  }
  const trigger = input.trigger || triggerProfileHmr
  const dir = resolveProfileDir()
  // H5：**先**让旧 Gateway 自己收尾（作业置 canceled、会话停掉），**再**触发重组合。
  // 顺序不能反：重组合会拆旧 fiber → dispose 直接杀进程树，那时作业只能算"被带走"
  // （台账留 running、回执也拿不到 jobsDropped），正是上一轮实测的痛点。
  const drained = await drainOf(input)(input.port, 'blender_session action=reload（宿主层 HMR）')
  mergeDrain(report, drained)
  const receipt = trigger({
    dir,
    reason: input.reason || 'blender_session action=reload',
    now: now(),
  })
  const changed = changedOf(diag)
  writeReloadState({
    schema: 1,
    mode: 'hmr',
    pidBefore: report.pidBefore,
    pidAfter: null,
    startedAt: now().toISOString(),
    finishedAt: receipt.ok ? null : now().toISOString(),
    pending: receipt.ok,
    verdict: 'stale',
    changed,
    needsRestart: receipt.ok ? [] : [...reasons, ...receipt.needsRestart],
    error: receipt.ok ? null : receipt.note,
    jobsDropped: [...drained.jobsDropped],
  })
  report.ok = receipt.ok
  report.pending = receipt.ok
  report.pidAfter = null
  report.receipt = receipt.comment
  report.layers = {
    ...report.layers,
    profile: { dir: receipt.profileDir, patchPath: receipt.patchPath, bytes: receipt.bytes },
  }
  report.needsRestart = receipt.ok ? [] : [...reasons, ...receipt.needsRestart]
  if (receipt.ok) {
    report.note =
      drainNote(drained) +
      '；已写 profile 触发 HMR 重组合：本 fiber 会被拆掉、插件从磁盘重新装载，Gateway 随之换 pid。' +
      'pending=true / pidAfter=null 是正常语义 —— 用 GET /health 的 backend.pid 与 /status.provenance.verdict 复核' +
      '（新 fiber 激活时插件会把 lastReload 收尾：pidAfter/verdict 落到 ' +
      'DSH_BLENDER_WORKDIR/state/last-reload.json）'
  } else {
    // drain 已经把旧 Gateway 送走了：HMR 没触发就得立刻把它拉回来，别把"没重组合"升级成"没有后端"。
    const back = await (input.recover || ensureBackend)(input.port)
    report.note =
      receipt.note +
      '；' +
      drainNote(drained) +
      '；HMR 未触发 → 宿主按磁盘重拉 Gateway：' +
      (back ? 'ok（pid 已换新）' : '失败（15s 内的看护会再试一次）')
  }
  return report
}

/**
 * 默认换代动作（H4）：杀进程树，再从磁盘重拉。
 *
 * drain 由调用方（runtimeLayerReload）在**杀之前**做完 —— 这样 stopped / jobsDropped 才进得了
 * 回执（H5）。顺序依旧不能反：先杀的话 helper / 隐藏 Blender / 在跑作业只能靠 OS 收尸，
 * 台账里留一堆 running；先 drain 则 stop/cancel 都落在台账里。
 */
function defaultRestart(port: number) {
  return async (): Promise<boolean> => {
    killChildHandle()
    // 旧进程退出与端口释放是异步的：先给它一点时间，不然 ensureBackend 会探测到"还在"而不重拉
    await sleep(300)
    return await ensureBackend(port)
  }
}

/** 运行时层：宿主杀自己的 Gateway 句柄，再从磁盘重拉；回执给不可伪造的 pidAfter。 */
async function runtimeLayerReload(
  report: ReloadReport,
  input: HostReloadInput,
  apply: boolean,
  diag: ReloadReport,
): Promise<ReloadReport> {
  const reasons = needsOf(diag)
  if (!apply) {
    report.ok = false
    report.pending = false
    report.pidAfter = report.pidBefore
    report.needsRestart = [
      ...reasons,
      'dry-run（dry_run=true / apply=false）：只诊断，没有重启 Gateway',
    ]
    report.note =
      'dry-run：运行时层变了 ' + String(diag.changedCount?.runtime ?? 0) + ' 处，未执行重启'
    return report
  }
  // H5：先 drain（作业置 canceled、会话停掉，回执里点名），再杀进程树重拉。
  const drained = await drainOf(input)(input.port, 'blender_session action=reload（运行时层）')
  mergeDrain(report, drained)
  const restart = input.restart || defaultRestart(input.port)
  const restarted = await restart(input.port)
  const getPid = input.gatewayPid || gatewayPid
  const pidAfter = restarted
    ? await waitForNewPid(input.port, report.pidBefore, 10000, getPid)
    : null
  const verdict = restarted ? await provenanceVerdict(input.port) : 'unknown'
  const changed = changedOf(diag)
  settleReloadState({
    mode: 'gateway-restart',
    pidBefore: report.pidBefore,
    pidAfter,
    pending: !restarted,
    verdict,
    changed,
    needsRestart: restarted
      ? []
      : [...reasons, '宿主重拉 Gateway 失败：看 POST /health 与 gateway-host.log'],
    error: restarted ? null : 'Gateway 重启失败（ensureBackend 返回 false）',
    jobsDropped: [...drained.jobsDropped],
  })
  report.ok = restarted
  report.pending = !restarted
  report.pidAfter = pidAfter
  report.verdict = verdict
  report.needsRestart = restarted
    ? []
    : [...reasons, '宿主重拉 Gateway 失败：verify POST /health、看一眼 gateway-host.log']
  report.note =
    (restarted
      ? 'Gateway 已按磁盘重拉：pid ' +
        String(report.pidBefore) +
        ' → ' +
        String(pidAfter) +
        '，复核 verdict=' +
        verdict
      : '运行时层需要换 Gateway，但宿主重拉失败（pid 未变）：' + text(report.pidBefore)) +
    '；' +
    drainNote(drained)
  return report
}

/**
 * 新宿主 fiber 激活后的收尾：上一代触发的 HMR 到底成不成？
 *
 * pending 记录是**两段式**的（runtime/core/reload-state.ts）：旧 fiber 只写得下"已触发"，
 * 「换完之后 pid 与 verdict」只有**新一代**写得出来 —— 那正是"换了没有"的证据。
 */
export async function settlePendingReload(port: number): Promise<boolean> {
  const state = readReloadState()
  if (!state || !state.pending) return false
  const pidAfter = await gatewayPid(port)
  const verdict = await provenanceVerdict(port)
  settleReloadState({ pidAfter, pending: false, verdict, error: null })
  return true
}
