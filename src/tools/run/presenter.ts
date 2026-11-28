/** blender_run 的呈现层：作业记录、等待/收集、队列指标、tune 回执。 */
import { asRecord, text } from '../../contracts/dynamic.js'
import { receiptV2 } from '../receipt.js'

const LF = String.fromCharCode(10)

export function iso(ms: unknown): string {
  const n = Number(ms)
  return n > 0 ? new Date(n).toISOString() : '-'
}

function ag(ms: unknown): string {
  const n = Number(ms)
  if (!(n > 0)) return '-'
  const s = Math.max(0, Math.round((Date.now() - n) / 1000))
  return s < 60 ? String(s) + 's ago' : String(Math.round(s / 60)) + 'm ago'
}

function clip(s: string, n = 3000): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

export function formatJob(job: Record<string, unknown>): string[] {
  const result = asRecord(job.result)
  const decision = asRecord(job.decision)
  const err = asRecord(job.error)
  const lines = [
    'RUN ' +
      text(job.id) +
      ' · ' +
      text(job.kind) +
      ' · ' +
      text(job.state) +
      ' · slot=' +
      text(job.slot || '-') +
      ' · priority=' +
      text(job.priority),
    'timing  created=' +
      iso(job.createdAt) +
      ' started=' +
      iso(job.startedAt) +
      ' finished=' +
      iso(job.finishedAt) +
      (job.result ? ' · result=' + text(result.ms) + 'ms' : ''),
    'pid     ' + text(job.pid || '-') + ' · updated ' + ag(job.updatedAt),
  ]
  if (job.decision)
    lines.push(
      'decision ' +
        text(decision.outcome) +
        ' · ' +
        text(decision.reason) +
        (decision.detail ? ' · ' + text(decision.detail) : ''),
    )
  if (job.result)
    lines.push(
      'result  exit=' +
        text(
          result.exitCode === null || result.exitCode === undefined ? 'signal' : result.exitCode,
        ) +
        (result.signal ? ' · signal=' + text(result.signal) : '') +
        (result.parsed !== undefined
          ? ' · parsed=' + clip(JSON.stringify(result.parsed), 1200)
          : ''),
    )
  const channelLines = formatChannels(result.parsed)
  if (channelLines.length) lines.push(...channelLines)
  const appliedLines = formatApplied(result.parsed)
  if (appliedLines.length) lines.push(...appliedLines)
  const provenance = asRecord(result.provenance)
  if (result.provenance)
    lines.push(
      'provenance  args=' +
        clip(JSON.stringify(provenance.args ?? []), 400) +
        ' · env=' +
        clip(JSON.stringify(provenance.env_keys ?? provenance.env ?? []), 400) +
        (Array.isArray(provenance.preloads) && provenance.preloads.length
          ? ' · preloads=' + provenance.preloads.join(',')
          : '') +
        ' · bootstrap=' +
        text(provenance.bootstrap),
    )
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : []
  if (artifacts.length) {
    lines.push('artifacts ' + String(artifacts.length) + ' 个')
    for (const a of artifacts.slice(0, 8)) lines.push('  · ' + text(a))
    if (artifacts.length > 8) lines.push('  · …另有 ' + String(artifacts.length - 8) + ' 个')
  }
  if (job.lost === true)
    lines.push(
      'lost    true · ' +
        text(job.lostReason || '上一个 Gateway 换代时进程被收走') +
        '（产物未生成；重新入口 = 同一组参数再 action=submit）',
    )
  if (job.error)
    lines.push(
      'error   ' + text(err.code) + ' · stage=' + text(err.stage) + ' · ' + text(err.root_cause),
      'fix     ' + text(err.fix || '-'),
    )
  return lines
}

/**
 * render 的 applied 块：engine / samples / device / compute_device_type / devices_used。
 * 现场（设备回执）：CPU 日志也会打 "Copying BVH to device"，只看日志会误判；这里给的是 Cycles 实际绑定结果。
 */
export function formatApplied(parsed: unknown): string[] {
  const applied = asRecord(asRecord(parsed).applied)
  if (!Object.keys(applied).length) return []
  const used = Array.isArray(applied.devices_used)
    ? applied.devices_used.map((d) => text(d)).filter(Boolean)
    : []
  const lines = [
    'applied  engine=' +
      (text(applied.engine) || '-') +
      (applied.engine_source
        ? ' (' +
          text(applied.engine_source) +
          (applied.engine_source === 'inherit' && applied.engine_before
            ? ': 继承 .blend，未显式传 engine'
            : '') +
          ')'
        : '') +
      ' · samples=' +
      (applied.samples === null || applied.samples === undefined
        ? text(applied.samples_requested ?? '-')
        : text(applied.samples)) +
      ' · device=' +
      (text(applied.scene_device) || '-') +
      ' · compute_device_type=' +
      (text(applied.compute_device_type) || '-') +
      ' · devices_used=' +
      (used.length ? used.join(', ') : '-'),
  ]
  if (applied.fell_back_to_cpu === true)
    lines.push('warning  GPU 请求没有生效：本次已回落 CPU（warnings 里是原因）')
  const warnings = Array.isArray(applied.warnings) ? applied.warnings : []
  for (const w of warnings.slice(0, 4)) lines.push('warning  ' + text(w))
  return lines
}

/** status/wait/collect 顶层的结构化 applied（submit 还没有结果时是 null）。 */
export function jobApplied(job: Record<string, unknown>): Record<string, unknown> | null {
  const applied = asRecord(asRecord(asRecord(job.result).parsed).applied)
  return Object.keys(applied).length ? applied : null
}

/**
 * render channels 回执：verdict + 每通道路径/四项指标（或 skipped 原因）+ 可抄的 repro。
 * 数据来自 result.parsed（队列执行器把 CHANNELS 标记折成这个形状）；没请求通道时不出行。
 */
export function formatChannels(parsed: unknown): string[] {
  const p = asRecord(parsed)
  const verdict = text(p.verdict)
  if (!verdict) return []
  const evidence = asRecord(p.evidence)
  const head =
    'channels  verdict=' +
    verdict +
    (Array.isArray(evidence.requested) && evidence.requested.length
      ? ' · requested=' + evidence.requested.map((n) => text(n)).join(',')
      : '') +
    (Array.isArray(evidence.skipped) && evidence.skipped.length
      ? ' · skipped=' + evidence.skipped.map((n) => text(n)).join(',')
      : '') +
    (evidence.frame === undefined || evidence.frame === null
      ? ''
      : ' · frame=' + text(evidence.frame))
  const lines = [head]
  for (const raw of Array.isArray(p.channels) ? p.channels : []) {
    const c = asRecord(raw)
    const m = asRecord(c.metrics)
    let line = '  ' + text(c.name) + ' · ' + text(c.status)
    if (text(c.path)) line += ' · ' + text(c.path)
    if (m.foreground_px !== undefined)
      line +=
        ' · foreground_px=' +
        text(m.foreground_px) +
        ' · coverage=' +
        text(m.coverage) +
        ' · n_components=' +
        text(m.n_components) +
        ' · bbox=' +
        (Array.isArray(m.bbox) ? m.bbox.map((n) => text(n)).join(',') : '-')
    if (text(c.reason)) line += ' · ' + text(c.reason)
    lines.push(line)
  }
  if (text(p.repro)) lines.push('repro  ' + text(p.repro))
  return lines
}

export function formatSubmit(job: Record<string, unknown>): string {
  const lines = formatJob(job)
  lines.push(
    'next  blender_run action=wait id=' +
      text(job.id) +
      '（默认 120s，上限 600s，超时不取消）；action=collect 取日志/产物；action=cancel 取消',
  )
  lines.push(
    'list  blender_run action=list（本工具的队列枚举；DSH 宿主的 job_list 只列宿主后台作业，不含 Blender 作业）',
  )
  return lines.join(LF)
}

/** 作业句柄的稳定字段（submit/status/wait/collect/cancel 共用；调用方不必再正则扒文本）。 */
export function jobFields(job: Record<string, unknown>): Record<string, unknown> {
  const id = text(job.id)
  return {
    jobId: id || null,
    id: id || null,
    state: text(job.state) || null,
    slot: text(job.slot) || null,
    priority: typeof job.priority === 'number' ? job.priority : null,
    kind: text(job.kind) || null,
  }
}

/**
 * 回执信封：与 blender_op 共用同一份契约（构造器见 tools/receipt.ts）。
 * submit 是"作业已建立"不是判定，verdict 固定 null；job_id 与 queued_ahead 是结构化句柄。
 */
export function submitEnvelope(
  job: Record<string, unknown>,
  queuedAhead: unknown,
  workspaceBase: string | undefined,
): Record<string, unknown> {
  const id = text(job.id)
  return receiptV2({
    op: 'blender_run',
    action: 'submit',
    verdict: null,
    summary: 'RUN ' + id + ' · ' + text(job.kind) + ' · ' + text(job.state),
    job_id: id || null,
    jobId: id || null,
    state: text(job.state) || null,
    status: text(job.state) || null,
    slot: text(job.slot) || null,
    priority: typeof job.priority === 'number' ? job.priority : null,
    kind: text(job.kind) || null,
    queued_ahead: typeof queuedAhead === 'number' ? queuedAhead : null,
    next: id
      ? [
          { op: 'blender_run', args: { action: 'wait', id: id } },
          { op: 'blender_run', args: { action: 'collect', id: id } },
        ]
      : [],
    provenance: {
      route: '/job',
      surface: 'queue',
      workspace_base: workspaceBase || null,
    },
  })
}

/** status/wait/collect/cancel 的信封：同一套 job_id/state，action 区分来源。 */
export function jobEnvelope(action: string, job: Record<string, unknown>): Record<string, unknown> {
  const id = text(job.id)
  return receiptV2({
    op: 'blender_run',
    action: action,
    verdict: null,
    summary: 'RUN ' + id + ' · ' + text(job.kind) + ' · ' + text(job.state),
    job_id: id || null,
    jobId: id || null,
    state: text(job.state) || null,
    slot: text(job.slot) || null,
    provenance: { route: '/job', surface: 'queue' },
  })
}

/** list 的结构化行（只留可枚举字段；文本仍给人读）。 */
export function listRows(jobs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return jobs.map((j) => {
    const owner = asRecord(j.owner)
    const decision = asRecord(j.decision)
    return {
      ...jobFields(j),
      createdAt: typeof j.createdAt === 'number' ? j.createdAt : null,
      updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : null,
      pid: typeof j.pid === 'number' ? j.pid : null,
      owner: {
        dshSessionId: text(owner.dshSessionId) || null,
        agentId: text(owner.agentId) || null,
      },
      // Q-4：detail 一起透出（status 文本本来就有 detail，这里只是让结构化行对齐）。
      decision: j.decision
        ? {
            outcome: text(decision.outcome) || null,
            reason: text(decision.reason) || null,
            detail: text(decision.detail) || null,
          }
        : null,
    }
  })
}

export function listEnvelope(jobs: Array<Record<string, unknown>>): Record<string, unknown> {
  const rows = listRows(jobs)
  const CAP = 64
  return receiptV2({
    op: 'blender_run',
    action: 'list',
    verdict: null,
    jobs_count: rows.length,
    truncated: rows.length > CAP,
    jobs: rows.slice(0, CAP),
    provenance: { route: '/job', surface: 'queue' },
  })
}

export function formatWait(
  job: Record<string, unknown>,
  waitedMs: unknown,
  timedOut: unknown,
): string {
  const lines = formatJob(job)
  lines.push(
    'wait ' +
      String(waitedMs) +
      'ms · ' +
      (timedOut === true
        ? '仍在 ' +
          text(job.state) +
          '（等待超时不取消作业；稍后 action=status 或再加长 action=wait）'
        : '到达终态 ' + text(job.state)),
  )
  return lines.join(LF)
}

export function formatCollect(job: Record<string, unknown>): string {
  const logs = asRecord(job.logs)
  const lines = formatJob(job)
  if (logs.stdout && String(logs.stdout).trim())
    lines.push('--- stdout ---' + LF + clip(String(logs.stdout)))
  if (logs.stderr && String(logs.stderr).trim())
    lines.push('--- stderr ---' + LF + clip(String(logs.stderr)))
  if (!logs.stdout && !logs.stderr) lines.push('logs 空（作业还没产出输出）')
  return lines.join(LF)
}

export function formatCancel(body: Record<string, unknown>): string {
  const job = asRecord(body.job)
  if (body.alreadyFinished === true)
    return 'RUN cancel · 作业已到终态 ' + text(job.state) + '（幂等，未再终止）'
  return 'RUN cancel ok · ' + text(job.id) + ' → ' + text(job.state) + '（进程树已清理）'
}

/** 文本里最多列多少行（rows 本身由 limit/offset 控制，这里只防一次刷屏）。 */
const LIST_ROWS_SHOWN = 20

export function formatList(
  jobs: Array<Record<string, unknown>>,
  paging: { total?: number; offset?: number } = {},
): string {
  const total = typeof paging.total === 'number' ? paging.total : jobs.length
  const offset = Number(paging.offset) || 0
  if (!jobs.length)
    return (
      'RUN list · 0 个作业' +
      (total
        ? '（total=' + String(total) + '，用 offset 翻页）'
        : '（Blender 作业队列为空；DSH 宿主的 job_list 不含本队列）')
    )
  const shown = jobs.slice(0, LIST_ROWS_SHOWN)
  const paged = offset > 0 || total > shown.length
  const lines = [
    paged
      ? 'RUN list · 显示 ' +
        String(shown.length) +
        ' / ' +
        String(total) +
        ' 个作业' +
        (offset ? '（offset=' + String(offset) + '）' : '')
      : 'RUN list · ' + String(shown.length) + ' 个作业',
  ]
  for (const j of shown)
    lines.push(
      '· ' +
        text(j.id) +
        ' · ' +
        text(j.kind) +
        ' · ' +
        text(j.state) +
        ' · slot=' +
        text(j.slot || '-') +
        ' · priority=' +
        text(j.priority) +
        ' · created=' +
        iso(j.createdAt),
    )
  if (total > offset + shown.length)
    lines.push(
      '… 另有 ' +
        String(total - offset - shown.length) +
        ' 条：limit/offset 翻页；owner=all 看全部会话，owner=<session id> 看指定会话',
    )
  return lines.join(LF)
}

export function formatPerf(perf: Record<string, unknown>): string {
  const byState = asRecord(perf.byState)
  const slots = asRecord(perf.slots)
  const gpu = asRecord(slots.gpu)
  const cpu = asRecord(slots.cpu)
  const lines = [
    'RUN perf · pending=' + text(perf.pending),
    'byState  ' +
      ['queued', 'assigned', 'running', 'completed', 'failed', 'canceled']
        .map((s) => s + '=' + text(byState[s] ?? 0))
        .join(' '),
    'slots    gpu ' +
      text(gpu.used) +
      '/' +
      text(gpu.total) +
      ' (reserved=' +
      text(gpu.reserved || 0) +
      ') · cpu ' +
      text(cpu.used) +
      '/' +
      text(cpu.total),
    'oldestQueuedAt ' + iso(perf.oldestQueuedAt),
  ]
  return lines.join(LF)
}

export function runHelp(): string {
  return [
    'blender_run 动作（唯一作业入口：submit → jobId → status/wait/collect/cancel；无同步模式）：',
    '  action=submit kind=render|headless + 参数',
    '    render（声明式，不接受 script）：file/output/outdir/frames/resolution/samples/engine/format/camera/device/compute_device_type/channels/priority',
    '      · channels=["render","alpha","mask","ink"]（默认 ["render"]）：每通道给路径 + foreground_px/coverage/n_components/bbox；' +
      '缺 ink 对象时该通道 skipped、整体 verdict=degraded（degraded ≠ 通过，但不是失败）',
    '      · device=auto（默认，能绑 GPU 就绑）/gpu/cpu + compute_device_type=OPTIX|CUDA|HIP|ONEAPI|METAL|NONE；' +
      '回执 result.parsed.applied 带实际 compute_device_type / devices_used / samples，绑不上 GPU 有 warning（不静默跑 CPU）',
    '    headless（跑脚本）：script/script_file/file/outdir/timeout_ms/engine/preload/factory_startup/bootstrap/workdir/include_noise/out_json/args/env/priority',
    '      · 默认注入内核 K（bootstrap=false 才关）+ preload 模块；preload 名不存在 → job_prepare_failed',
    '      · args=string（引号分词）| string[]；env={KEY:VALUE}；两者都写进 result.provenance 供对账',
    '  action=status|wait|collect|cancel id=<jobId>；wait 默认 120s、上限 600s，超时不取消',
    '  action=list [state=kind=owner=] | action=perf（队列容量与槽位）',
    '    · list 是本工具的唯一队列枚举（submit 的 jobId）；DSH 宿主的 job_list 只列宿主后台作业，看不到 Blender 作业',
    '  action=tune op=status|analyze|apply|revert|help（旧 blender_run 的 Cycles 分析）',
    '旧工具迁移：blender_rt_headless / blender_rt_job → blender_run action=submit（kind=headless / render）；blender_rt_perf → blender_run action=tune。',
  ].join(LF)
}
