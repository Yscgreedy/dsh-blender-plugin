/**
 * blender_run：唯一作业入口（第 6 节有界队列的模型面）。
 *
 * submit 立即返回 jobId；之后用 status/wait/collect/cancel/list/perf 观察。
 * 没有同步模式、没有第二个作业工具。tune 保留旧 Cycles 分析（/perf）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BACKEND_HINT } from '../../constants.js'
import type { AvailabilityStage } from '../../contracts/availability.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import { ensureBackend } from '../../host/backend/index.js'
import { execCaller } from '../../host/exec-context.js'
import { backendPost, jsonPayload } from '../../host/http.js'
import type { WorkspaceView } from '../../host/workspace.js'
import { workspaceNote, workspacePayload, workspaceRoots } from '../../host/workspace.js'
import { toolError } from '../errors.js'
import { postJobSubmit, postQueueJob } from '../shared/queue-job.js'
import { resolveSession } from '../shared/session.js'
import { executeWorker } from './worker.js'
import {
  formatCancel,
  formatCollect,
  formatJob,
  formatList,
  formatPerf,
  formatSubmit,
  formatWait,
  jobApplied,
  jobEnvelope,
  jobFields,
  listEnvelope,
  listRows,
  runHelp,
  submitEnvelope,
} from './presenter.js'

const LF = String.fromCharCode(10)

/**
 * T-2：headless 的临时脚本映射（executor 写在 result.provenance.script_map 里）。
 * 两个路径都在才算数；render / 内联脚本 / 老记录一律没有这个键。
 */
function scriptMapOf(job: Record<string, unknown>): Record<string, string> | null {
  const map = asRecord(asRecord(asRecord(job.result).provenance).script_map)
  const tempPath = text(map.temp_path)
  const sourcePath = text(map.source_path)
  if (!tempPath || !sourcePath) return null
  return { temp_path: tempPath, source_path: sourcePath }
}

/** 一行提示：traceback 的行号指的是那份临时副本，不是源脚本。 */
function withScriptMapHint(body: string, map: Record<string, string> | null): string {
  if (!map) return body
  return (
    body +
    LF +
    'script_map  traceback 行号对应临时副本 ' +
    map.temp_path +
    '（源脚本 ' +
    map.source_path +
    '）'
  )
}

/**
 * 渲染通道（render / alpha / mask / ink）：允许列表与默认值只在这一处。
 *
 * 台账（docs/archive/2026-11-20-角色动画与卡通渲染需求.md 第 72-74 行，render channels 条）：
 * kind=render 支持 channels，默认只渲 render；未知通道一律 invalid_params 并把允许值列出来。
 */
export const CHANNEL_NAMES = ['render', 'alpha', 'mask', 'ink'] as const
export type ChannelName = (typeof CHANNEL_NAMES)[number]

function isChannel(name: string): name is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(name)
}

function allowed(): string {
  return CHANNEL_NAMES.join(' | ')
}

/**
 * 归一化 channels 参数：undefined → 默认 ["render"]；string 按逗号分词；数组逐项收窄。
 * 去空白、去重、保序；未知通道/空列表/非字符串项都是 invalid_params 的错误文本。
 */
export function normalizeChannels(value: unknown): { channels: ChannelName[] } | { error: string } {
  if (value === undefined || value === null) return { channels: ['render'] }
  const raw = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(raw))
    return {
      error:
        'channels 只认字符串数组（如 ["render","alpha"]；也收逗号分隔的字符串），收到 ' +
        typeof value,
    }
  const out: ChannelName[] = []
  for (const item of raw) {
    if (typeof item !== 'string')
      return {
        error:
          'channels 的每一项都必须是字符串通道名（收到 ' + typeof item + '）；允许：' + allowed(),
      }
    const name = item.trim()
    if (!name) continue
    if (!isChannel(name))
      return {
        error: '未知的渲染通道：' + name + '；允许：' + allowed() + '（默认只渲 render）',
      }
    if (!out.includes(name)) out.push(name)
  }
  if (out.length === 0)
    return { error: 'channels 不能是空列表；允许：' + allowed() + '（不传就是 ["render"]）' }
  return { channels: out }
}

const RENDER_KEYS = [
  'file',
  'output',
  'outdir',
  'frames',
  'resolution',
  'samples',
  'engine',
  'format',
  'camera',
  'device',
  'compute_device_type',
  // Q-5：render 唯一放行的脚本钩子（渲染前跑一次的场景准备）。漏在这里 = 静默丢弃。
  'pre_script',
]
const HEADLESS_KEYS = [
  'script',
  'script_file',
  'file',
  'outdir',
  'timeout_ms',
  'engine',
  // C-9：headless 也接受设备参数（以前被白名单静默丢弃）
  'device',
  'compute_device_type',
  'preload',
  'factory_startup',
  'bootstrap',
  'workdir',
  'include_noise',
  'out_json',
  'args',
  'env',
  'shots',
  'expect',
  'hard_exit',
  'gpu',
  'run_id',
]
const ACTIONS = [
  'submit',
  'status',
  'wait',
  'collect',
  'cancel',
  'list',
  'perf',
  'tune',
  'worker',
  'help',
]

/**
 * 痛点2：提交前把相对路径绝对化并校验存在性。
 *
 * 现场：script_file="out/.../step1.py" 被后端按 Gateway 进程 cwd（DSH profile 目录）
 * 解析，先起进程再报 FileNotFoundError。3.2.0-alpha.1 复测又抓到第二层：宿主进程 cwd
 * 也不是会话工作区，而三个工作区 env 在本机是空的 —— "工作区环境变量"那一档等于没有。
 * 所以基址改从**调用方 exec** 取（见 host/workspace.ts）：workingDirectory 服务 →
 * Session header 的 cwd → 工作区 env → 宿主 cwd；只落到最后一档时回执必须点名回落。
 */
const INPUT_KEYS = ['file', 'script_file'] as const

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\' || p.startsWith('/')
}

interface PreflightHit {
  path?: string
  /** The base the relative input was resolved against (undefined for absolute input). */
  base?: string
  error?: string
}

/** 绝对化一个输入路径；相对路径按给定基址依次尝试，找不到就报错。 */
function preflightInput(key: string, given: string, bases: string[]): PreflightHit {
  const raw = given.trim()
  if (!raw) return { error: key + ' 是空字符串 —— 要么给真实路径，要么不要传' }
  if (isAbsolute(raw)) {
    if (fs.existsSync(raw)) return { path: raw }
    return { error: key + ' 不存在：' + raw + '（本次没有启动任何 Blender 进程）' }
  }
  const tried: string[] = []
  for (const base of bases) {
    const candidate = path.resolve(base, raw)
    tried.push(candidate)
    if (fs.existsSync(candidate)) return { path: candidate, base }
  }
  return {
    error:
      key +
      ' 是相对路径且找不到：' +
      raw +
      '（本次没有启动任何 Blender 进程）已尝试：' +
      tried.join(' , ') +
      ' —— 给绝对路径或传 workdir=<工作区根>',
  }
}

/**
 * 把 workdir 与 file/script_file 就地绝对化（headless 与 render 共用）。
 * 返回解析所用的基址（回执要写清是"会话工作区"还是"回落"），出错则只给 error。
 */
function absolutizePayload(
  payload: Record<string, unknown>,
  view: WorkspaceView,
): { error?: string; base?: string } {
  const roots = view.roots.map((r) => r.path)
  const given =
    payload.workdir !== undefined && payload.workdir !== null && String(payload.workdir).trim()
      ? String(payload.workdir).trim()
      : ''
  const workdir = given
    ? isAbsolute(given)
      ? given
      : path.resolve(roots[0] || process.cwd(), given)
    : ''
  if (workdir) payload.workdir = workdir
  const bases: string[] = []
  for (const b of [workdir, ...roots]) if (b && !bases.includes(b)) bases.push(b)
  let base: string | undefined
  for (const key of INPUT_KEYS) {
    const value = payload[key]
    if (value === undefined || value === null || String(value).trim() === '') continue
    const hit = preflightInput(key, String(value), bases)
    if (hit.error) return { error: hit.error }
    payload[key] = hit.path
    if (!base && hit.base) base = hit.base
  }
  // 会话工作区也给后端一份：它自己的相对解析（workdir 之后的第二档）就不再靠那几个空 env。
  const workspace = workspacePayload(view)
  if (workspace) payload.workspace = workspace
  return { base }
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function failureOf(body: Record<string, unknown>, action: string): unknown {
  const code = text(body.code) || 'backend_error'
  const stage = typeof body.stage === 'string' ? (body.stage as AvailabilityStage) : undefined
  if (code === 'queue_unknown_job')
    return toolError(
      'queue_unknown_job',
      'RUN ' + action + ' 失败 · 没有这个 jobId：' + text(body.root_cause || body.error || ''),
      '先 blender_run action=list 取现有 jobId',
      JSON.stringify(body.evidence || {}),
      'queue',
    )
  if (body.root_cause || body.fix)
    return toolError(
      code,
      'RUN ' + action + ' 失败 · ' + text(body.root_cause || body.error || 'unknown'),
      text(body.fix || '读日志修原因后重新 submit'),
      body.evidence ? JSON.stringify(body.evidence) : undefined,
      stage,
    )
  return toolError(
    'backend_error',
    'RUN ' + action + ' 失败 · ' + text(body.error || body.raw || 'unknown'),
    '先 blender_session action=status 看 Gateway/addon 状态',
    undefined,
    stage,
  )
}

/** 队列动作走唯一传输面（surface=queue 与不可达回执都在 shared/queue-job.ts）。 */
function postQueue(
  port: number,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return postQueueJob(port, payload, timeoutMs, BACKEND_HINT)
}

function submitPayload(args: Record<string, unknown>): Record<string, unknown> | string {
  const kind = text(args.kind).trim()
  if (kind !== 'render' && kind !== 'headless')
    return 'submit 需要 kind=render|headless（render=声明式最终渲染；headless=跑脚本）'
  // op="submit" 由 jobSubmitBody 写（本地无头车道共用同一个构造器）。
  const payload: Record<string, unknown> = { kind }
  if (present(args.priority)) payload.priority = Number(args.priority)
  if (kind === 'render') {
    if (present(args.script) || present(args.script_file))
      return 'render 不接受 script/script_file：最终渲染是声明式入口；跑脚本请用 kind=headless 或 blender_py'
    // Blender 的 // 是"相对当前 .blend 目录"的规范写法；没有 file 就没有基准，提前拒掉，
    // 别让后端把它当绝对路径去 mkdir 'C:\'（阶段=spawn 的错误完全不含路径语义）。
    const out = present(args.output) ? String(args.output).trim() : ''
    if (out.startsWith('//') && !present(args.file))
      return 'output 以 // 开头（Blender 相对 .blend 目录），需要同时给 file=<.blend> 作为基准；或直接给绝对路径'
    for (const k of RENDER_KEYS) if (present(args[k])) payload[k] = args[k]
    // render channels：默认 ["render"]，非法值 invalid_params 并把允许列表还回去。
    const channels = normalizeChannels(args.channels)
    if ('error' in channels) return channels.error
    payload.channels = channels.channels
    return payload
  }
  if (args.channels !== undefined)
    return 'channels 只对 kind=render 有效（headless 跑脚本，没有通道回执）：删掉 channels 或改用 kind=render'
  if (!present(args.script) && !present(args.script_file) && !present(args.file))
    return 'headless 需要 script / script_file / file 之一'
  for (const k of HEADLESS_KEYS) if (present(args[k])) payload[k] = args[k]
  return payload
}

async function tune(port: number, args: Record<string, unknown>): Promise<unknown> {
  const op = text(args.op).trim() || 'status'
  const pargs = jsonPayload(args.args)
  let r: Record<string, unknown>
  try {
    r = await backendPost(
      port,
      '/perf',
      { op, args: Object.keys(pargs).length ? pargs : undefined },
      600000,
    )
  } catch (e: unknown) {
    return toolError('gateway_unreachable', 'RUN tune 失败 · ' + text(e), BACKEND_HINT)
  }
  if (!r || r.ok !== true)
    return toolError(
      'backend_error',
      'RUN tune ' + op + ' 失败 · ' + text(r.error || r.raw || 'unknown'),
      'op=status 看渲染设置；analyze 需要已打开的场景',
    )
  return { text: 'RUN tune ' + op + ' ' + JSON.stringify(r.result ?? r) }
}

/** submit 分支：参数收窄 → 路径绝对化 → 入队 → 结构化句柄（executeRun 保持 <120 行）。 */
async function submitRun(
  ctx: unknown,
  port: number,
  args: Record<string, unknown>,
  exec?: unknown,
): Promise<unknown> {
  const built = submitPayload(args)
  if (typeof built === 'string')
    return toolError('invalid_params', built, 'action=help 查看 render/headless 参数')
  const ws = workspaceRoots(exec, ctx)
  const resolved = absolutizePayload(built, ws)
  if (resolved.error)
    return toolError(
      'input_missing',
      resolved.error,
      '给绝对路径，或传 workdir=<工作区根>',
      workspaceNote(ws),
    )
  const body = await postJobSubmit(port, built, 60000, BACKEND_HINT)
  if (body.ok !== true) return failureOf(body, 'submit')
  // 结构化句柄：并发时调用方不必再正则 "RUN (job-…)" —— jobId/state/slot 与回执信封同源。
  const job = asRecord(body.job)
  return {
    text: formatSubmit(job) + LF + workspaceNote(ws, resolved.base),
    ...jobFields(job),
    queued_ahead: typeof job.queued_ahead === 'number' ? job.queued_ahead : null,
    envelope: submitEnvelope(job, job.queued_ahead, resolved.base),
  }
}

/**
 * list 的 owner 解析：先看已解析的会话 ref（mine 会话的 ref.owner 就是调用方的
 * DSH 会话 id）；没有 ready 会话、或只有别人的只读会话时，回退到 exec 调用方。
 * viewer 会话的 owner 属于另一个 DSH 会话，不能当作 "me"。
 */
async function listOwner(port: number, ownerArg: string): Promise<string> {
  if (ownerArg === 'all') return ''
  if (ownerArg && ownerArg !== 'me') return ownerArg
  const ref = await resolveSession(port)
  if (ref.ok && ref.source === 'mine' && ref.owner) return ref.owner
  return String(execCaller()?.dshSessionId || '')
}

/**
 * wait 回执（T-1/T-2/Q-4 的字段都在这里组装）：队列层单独成一块，executeRun 只留一行分支。
 * 字段与语义与拆分前逐字一致（waited_ms / timed_out / still_running / script_map / envelope）。
 */
async function waitRun(port: number, id: string, args: Record<string, unknown>): Promise<unknown> {
  const action = 'wait'
  const timeoutMs = Number(args.timeout_ms) || 120000
  const budget = Math.min(600000, Math.max(1000, timeoutMs)) + 30000
  const body = await postQueue(port, { op: 'wait', id, timeout_ms: timeoutMs }, budget)
  if (body.ok !== true) return failureOf(body, action)
  const job = asRecord(body.job)
  const scriptMap = scriptMapOf(job)
  return {
    text: withScriptMapHint(formatWait(job, body.waitedMs, body.waitTimedOut), scriptMap),
    ...jobFields(job),
    applied: jobApplied(job),
    waited_ms: typeof body.waitedMs === 'number' ? body.waitedMs : null,
    timed_out: body.waitTimedOut === true,
    // Q-4：超时不是失败。终态时队列层不带这个字段，这里如实落 false（不编造"还在跑"）。
    still_running: body.still_running === true,
    // T-2：additive；只有 headless 临时脚本才有值。
    ...(scriptMap ? { script_map: scriptMap } : {}),
    envelope: jobEnvelope(action, job),
  }
}

export async function executeRun(
  ctx: unknown,
  port: number,
  args: Record<string, unknown>,
  exec?: unknown,
): Promise<unknown> {
  const action = text(args.action).trim() || (present(args.kind) ? 'submit' : 'list')
  if (action === 'help') return { text: runHelp() }
  if (!ACTIONS.includes(action))
    return toolError(
      'invalid_params',
      '未知 blender_run action：' + action,
      '可用：' + ACTIONS.join(' | '),
    )
  if (!(await ensureBackend(port)))
    return toolError(
      'gateway_unreachable',
      'Gateway 不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  if (action === 'tune') return tune(port, args)
  // 痛点7/8：同一个热进程里连续 exec/see + checkpoint 栈（不再每次冷启动、不再手工另存 .blend）
  if (action === 'worker') return executeWorker(ctx, port, args, exec)

  if (action === 'submit') return submitRun(ctx, port, args, exec)
  if (action === 'list') {
    const payload: Record<string, unknown> = { op: 'list' }
    for (const k of ['state', 'kind']) if (present(args[k])) payload[k] = args[k]
    // C-13：默认只看**本会话**，`owner=all` 才放开；默认 20 条，`limit=0` = 不分页。
    const owner = await listOwner(port, text(args.owner).trim())
    if (owner) payload.owner = owner
    const limitRaw = args.limit === undefined ? 20 : Number(args.limit)
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(0, Math.trunc(limitRaw))) : 20
    if (limit > 0) payload.limit = limit
    const offset = Math.max(0, Math.trunc(Number(args.offset) || 0))
    if (offset > 0) payload.offset = offset
    if (Number(args.since_ms) > 0) payload.since_ms = Number(args.since_ms)
    const body = await postQueue(port, payload, 60000)
    if (body.ok !== true) return failureOf(body, action)
    const jobs = Array.isArray(body.jobs) ? (body.jobs as Array<Record<string, unknown>>) : []
    const total = Number(body.total) || jobs.length
    const pageOffset = Number(body.offset) || 0
    return {
      text: formatList(jobs, { total, offset: pageOffset }),
      jobs: listRows(jobs),
      count: jobs.length,
      total,
      offset: pageOffset,
      owner: owner || 'all',
      envelope: listEnvelope(jobs),
    }
  }
  if (action === 'perf') {
    const body = await postQueue(port, { op: 'perf' }, 60000)
    if (body.ok !== true) return failureOf(body, action)
    return { text: formatPerf((body.perf || {}) as Record<string, unknown>) }
  }
  if (!present(args.id))
    return toolError(
      'invalid_params',
      action + ' 需要 id（jobId）',
      '先 action=submit 或 action=list',
    )
  const id = text(args.id)
  if (action === 'status') {
    const body = await postQueue(port, { op: 'status', id }, 60000)
    if (body.ok !== true) return failureOf(body, action)
    const job = asRecord(body.job)
    return {
      text: formatJob(job).join(String.fromCharCode(10)),
      ...jobFields(job),
      applied: jobApplied(job),
      envelope: jobEnvelope(action, job),
    }
  }
  if (action === 'wait') return waitRun(port, id, args)
  if (action === 'collect') {
    const body = await postQueue(
      port,
      { op: 'collect', id, tail: Number(args.tail) || 4000 },
      60000,
    )
    if (body.ok !== true) return failureOf(body, action)
    const job = asRecord(body.job)
    const scriptMap = scriptMapOf(job)
    return {
      text: withScriptMapHint(formatCollect(job), scriptMap),
      ...jobFields(job),
      applied: jobApplied(job),
      // T-2：additive；只有 headless 临时脚本才有值。
      ...(scriptMap ? { script_map: scriptMap } : {}),
      envelope: jobEnvelope(action, job),
    }
  }
  // cancel
  const body = await postQueue(port, { op: 'cancel', id }, 60000)
  if (body.ok !== true) return failureOf(body, action)
  const job = asRecord(body.job)
  return {
    text: formatCancel(body),
    ...jobFields(job),
    canceled: body.canceled === true,
    already_finished: body.alreadyFinished === true,
    envelope: jobEnvelope(action, job),
  }
}
