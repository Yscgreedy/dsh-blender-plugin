/**
 * 无 GUI 本地车道（宿主侧闸门）。
 *
 * 只在这种组合下开：op 属于本地可执行白名单 + 调用方显式给 args.file（存在的 .blend）
 * + 当前没有 ready 的 GUI 会话。三者缺一，行为与原来完全一致 —— 有会话就继续走 /plan
 * （GUI 优先），没 file 就继续要会话。
 *
 * 提交复用现有作业入口（POST /job 的 queue surface，与 blender_run action=submit 同一条门），
 * 不新增 HTTP 路由；op 名如何变成 Python 调用由 runtime/execution/local-op 决定。
 * 回执只说"作业已提交"：取回结果之前不是 pass，作业失败一律 degraded + evidence。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AvailabilityStage } from '../../contracts/availability.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import type { HostContext } from '../../host/context.js'
import { backendPost } from '../../host/http.js'
import { workspacePayload, workspaceRoots } from '../../host/workspace.js'
import type { WorkspaceView } from '../../host/workspace.js'
import { toolError } from '../errors.js'
import type { ToolFailure } from '../errors.js'
import { requireReadySession } from '../shared/session.js'

const LF = String.fromCharCode(10)
const BLEND_END = '.blend'

/** 本地可执行白名单（与 runtime/execution/local-op/table.ts 对拍，见单测）。 */
export const LOCAL_OPS: readonly string[] = [
  'audit_mesh',
  'img_digest',
  'img_probe',
  'img_measure',
  'img_calib',
  'visualreport_report',
  'qc_render_views',
  'montage',
]

/** img_ 全族共用同一条车道（同一路由行）。 */
export const LOCAL_PREFIXES: readonly string[] = ['img_']

export function isLocalLaneOp(op: string): boolean {
  const name = op.trim()
  if (!name) return false
  if (LOCAL_OPS.includes(name)) return true
  return LOCAL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\' || p.startsWith('/')
}

interface ResolvedFile {
  path?: string
  failure?: ToolFailure
}

function missingFile(file: string, hint: string): ResolvedFile {
  return {
    failure: toolError(
      'invalid_params',
      '本地车道 · ' + hint + '：' + file + '（本次没有提交任何作业）',
      '给 args.file=<存在的 .blend 绝对路径>；要 GUI 就 blender_session action=attach',
    ),
  }
}

/**
 * args.file 预检：扩展名必须是 .blend，必须真的存在。
 *
 * 相对路径按会话工作区根解析（与 blender_run 的 file 同一口径）；解析不到就报
 * invalid_params 并列出试过的路径 —— 不静默转 headless，也不让 Blender 起来才报错。
 */
export function resolveBlendFile(file: string, exec: unknown, ctx: HostContext): ResolvedFile {
  if (!file.toLowerCase().endsWith(BLEND_END))
    return missingFile(file, 'file 不是 .blend（本地车道只打开 .blend 场景）')
  if (isAbsolutePath(file)) {
    if (fs.existsSync(file)) return { path: file }
    return missingFile(file, 'file 不存在')
  }
  const bases = workspaceRoots(exec, ctx).roots.map((root) => root.path)
  const tried = (bases.length ? bases : [process.cwd()]).map((base) => path.resolve(base, file))
  for (const candidate of tried) if (fs.existsSync(candidate)) return { path: candidate }
  return {
    failure: toolError(
      'invalid_params',
      '本地车道 · file 是相对路径且找不到：' +
        file +
        '（本次没有提交任何作业）已尝试：' +
        tried.join(' , '),
      '给绝对路径，或传会话工作区内的路径（args.file / blender_run 同一解析口径）',
    ),
  }
}

function resolveOutdir(raw: string, view: WorkspaceView): string {
  if (!raw) return ''
  if (isAbsolutePath(raw)) return raw
  const base = view.roots[0]
  return base ? path.resolve(base.path, raw) : raw
}

/**
 * 车道自己的键：file 是"先打开哪个 .blend"，不是 op 的参数；dry_run 更不该传给执行型 op。
 * op 需要自己的 file= 时放进 args.args 里（各模块 dispatch 会展开那一层）。
 */
export function opPayloadOf(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload }
  delete out.file
  delete out.dry_run
  return out
}

/** 车道提交：复用 queue surface（与 blender_run submit 同一条门，不新增路由）。 */
async function submitLocalJob(input: {
  port: number
  op: string
  file: string
  payload: Record<string, unknown>
  exec: unknown
  ctx: HostContext
}): Promise<Record<string, unknown>> {
  const view = workspaceRoots(input.exec, input.ctx)
  const body: Record<string, unknown> = {
    surface: 'queue',
    op: 'submit',
    kind: 'headless',
    file: input.file,
    catalog_op: input.op,
    op_args: opPayloadOf(input.payload),
  }
  const workspace = workspacePayload(view)
  if (workspace) body.workspace = workspace
  const outdir = resolveOutdir(text(input.payload.outdir).trim(), view)
  if (outdir) body.outdir = outdir
  try {
    return await backendPost(input.port, '/job', body, 60000)
  } catch (e: unknown) {
    return {
      ok: false,
      code: 'gateway_unreachable',
      stage: 'transport',
      root_cause: 'Gateway 不可达 · ' + text(e instanceof Error ? e.message : e),
    }
  }
}

/** 成功回执：job_id + 取件方式 + degraded 语义（异步作业在取件前不是 pass）。 */
export function localLaneReceipt(
  op: string,
  file: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const job = asRecord(body.job)
  const id = text(job.id || body.jobId)
  const take = 'blender_run(action="wait", id="' + id + '")'
  const lines = [
    'OP ' + op + ' · 没有 ready GUI 会话 → 本地无头车道（白名单 op + 显式 file）',
    'job_id: ' + id + ' · kind=headless · file: ' + file,
    '取件：' + take + '（status / collect / cancel；长活不在本次调用里同步等）',
    'verdict: degraded —— 作业已提交、结果未取回，不是 pass；作业失败或结果 ok=false 一律按 degraded + evidence 处理',
    '证据：驱动把 verdict/evidence 写进 HEADLESS 回执行，blender_run action=collect 可读',
  ]
  const envelope: Record<string, unknown> = {
    contract: 'receipt.v2',
    op,
    verdict: 'degraded',
    job_id: id,
    file,
    take,
    summary: '已提交本地无头作业 · ' + (text(job.status || job.state) || 'queued'),
    provenance: { route: '/job', surface: 'queue', kind: 'headless' },
  }
  if (text(job.outdir)) envelope.outdir = text(job.outdir)
  if (text(job.logDir)) envelope.log_dir = text(job.logDir)
  return { text: lines.join(LF), envelope }
}

export interface LocalLaneFailure {
  text: string
  envelope: Record<string, unknown>
}

/**
 * 提交失败回执：verdict 只能是 degraded，且必须带 evidence（file / stage / 错误摘要）。
 * 不伪装成功：code 与 stage 来自 Gateway 的结构化失败，job_id 明确为 null。
 */
export function localLaneFailure(
  op: string,
  file: string,
  body: Record<string, unknown>,
): LocalLaneFailure {
  const stage = (text(body.stage) || 'queue') as AvailabilityStage
  const code = text(body.code) || 'job_submit_failed'
  const reason = text(body.root_cause || body.error || body.raw || 'unknown')
  const evidence = { verdict: 'degraded', op, file, stage, error: reason, route: '/job' }
  const base = toolError(
    code,
    'OP ' + op + ' 的本地无头作业没有建立 · ' + reason,
    '读 evidence 修原因后重试；要 GUI 就 blender_session action=attach',
    JSON.stringify(evidence),
    stage,
  )
  return {
    text:
      base.text +
      LF +
      'verdict: degraded（作业没有建立，不伪装成功）' +
      LF +
      'evidence: ' +
      JSON.stringify(evidence),
    envelope: {
      ...base.envelope,
      contract: 'receipt.v2',
      verdict: 'degraded',
      job_id: null,
      file,
      evidence: { ...base.envelope.evidence, ...evidence },
    },
  }
}

export interface LocalLaneInput {
  ctx: HostContext
  port: number
  op: string
  payload: Record<string, unknown>
  instanceId: string
  exec?: unknown
}

/**
 * 车道入口：返回 null = 不走车道（调用方继续原来的会话门 / /plan）。
 * 返回对象 = 本次调用的最终回执（作业已提交，或参数/提交失败）。
 */
export async function tryLocalLane(input: LocalLaneInput): Promise<unknown | null> {
  if (!isLocalLaneOp(input.op)) return null
  if (input.payload.dry_run === true) return null
  const given = text(input.payload.file).trim()
  if (!given) return null
  const resolved = resolveBlendFile(given, input.exec, input.ctx)
  if (resolved.failure) return resolved.failure
  const file = text(resolved.path)
  const ready = await requireReadySession(input.port, undefined, input.instanceId)
  if (ready.ok) return null
  // 只有"确实没有 ready 会话"才开车道；会话查询本身失败（Gateway/传输）如实回错。
  if (ready.failure.envelope.error.code !== 'session_required') return ready.failure
  const body = await submitLocalJob({
    port: input.port,
    op: input.op,
    file,
    payload: input.payload,
    exec: input.exec,
    ctx: input.ctx,
  })
  const jobId = text(asRecord(body.job).id || body.jobId)
  if (body.ok === true && jobId) return localLaneReceipt(input.op, file, body)
  if (body.ok === true)
    return localLaneFailure(input.op, file, {
      ok: false,
      code: 'job_submit_failed',
      stage: 'queue',
      root_cause: '作业回执没有 job_id，无法取件',
    })
  return localLaneFailure(input.op, file, body)
}
