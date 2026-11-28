/**
 * blender_op：执行 catalog 算子（plan 主体）+ loop / opt / preset 子面。
 *
 * 执行型 op 需要 ready 的 GUI 会话；catalog / 只读 op / dry-run 是本地或
 * Gateway 只读路径，不需要会话，也不会启动 Blender。
 *
 * 唯一例外是本地无 GUI 车道（见 local.ts）：白名单 op + 显式 args.file + 没有
 * ready 会话时，提交一个 headless 作业并回 job_id —— 不在工具调用里同步等长活。
 */
import { BACKEND_HINT } from '../../constants.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import type { HostContext } from '../../host/context.js'
import { ensureBackend } from '../../host/backend/index.js'
import { jsonPayload } from '../../host/http.js'
import { toolError } from '../errors.js'
import { resolveSession } from '../shared/session.js'
import { tryLocalLane } from './local.js'
import { executeLoop } from './loop.js'
import { executeOpt } from './opt.js'
import { executePlan } from './plan.js'
import { executePreset } from './preset.js'
import { READ_ONLY } from './read-only.js'

export function opHelp(): string {
  return [
    'blender_op 动作（catalog 算子与参数搜索；执行型需要 GUI 会话）：',
    '  action=plan   op=<catalog op> args={...}：38 family / 270 op 的主入口（op=catalog 看目录）',
    '    · op=catalog args={format:"json"} 取机器可读目录（families[].ops[].needs_gui/headless）',
    '    · headless=true + args.file：白名单 op 强制走本地无头车道（有 GUI 会话也不抢；audit_mesh / img_* / visualreport_report / qc_render_views / montage）',
    '  action=loop   op=start|status|stop|board|export|help|bench：参数搜索内环（target=gui|session）',
    '  action=opt    op=analyze|join|help：对象精简分析/合并',
    '  action=preset op=list|get|apply|save|delete|export|import|help：配方库',
    '旧工具迁移：blender_rt_plan → action=plan；blender_rt_loop → action=loop；',
    '  blender_rt_opt → action=opt；blender_rt_preset → action=preset。',
  ].join(String.fromCharCode(10))
}

function argsLooksInvalid(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const t = raw.trim()
  if (!t || t === '{}') return false
  try {
    const parsed: unknown = JSON.parse(t)
    return !(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
  } catch {
    return true
  }
}

function dryRun(raw: unknown): boolean {
  return asRecord(jsonPayload(raw)).dry_run === true
}

/** `instance_id` (snake_case, like blender_session) picks the target Blender. */
function targetInstance(args: Record<string, unknown>): string {
  return text(args.instance_id).trim()
}

/** Session gate for executing ops: null = proceed, otherwise the structured failure. */
async function gate(
  port: number,
  needsSession: boolean,
  instanceId?: string,
): Promise<unknown | null> {
  if (!needsSession) return null
  const ref = await resolveSession(port, undefined, instanceId)
  return ref.ok ? null : ref.failure
}

export async function executeOp(
  ctx: HostContext,
  port: number,
  args: Record<string, unknown>,
  exec?: unknown,
): Promise<unknown> {
  const action = text(args.action).trim() || 'plan'
  const instanceId = targetInstance(args)
  if (action === 'help') return { text: opHelp() }
  if (!(await ensureBackend(port)))
    return toolError(
      'gateway_unreachable',
      'Gateway 不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  if (action === 'plan') {
    const op = text(args.op) || 'status'
    if (argsLooksInvalid(args.args))
      return toolError(
        'invalid_params',
        'OP ' + op + ' 失败 · args 不是合法 JSON 对象：' + text(args.args).slice(0, 200),
        'args 传 JSON 对象，例如 {"family":"audit"}',
      )
    const lane = await tryLocalLane({
      ctx,
      port,
      op,
      payload: jsonPayload(args.args),
      instanceId,
      exec,
      force: args.headless === true || String(args.headless ?? '') === 'true',
    })
    if (lane) return lane
    const blocked = await gate(port, !READ_ONLY.has(op) && !dryRun(args.args), instanceId)
    if (blocked) return blocked
    return executePlan(ctx, port, Object.assign({ instance_id: instanceId }, args))
  }
  if (action === 'loop') {
    const target = text(args.target).trim() || 'gui'
    if (target !== 'gui' && target !== 'session')
      return toolError(
        'invalid_params',
        'loop target 只能是 gui 或 session',
        'target=session 走持久无头 worker',
      )
    const blocked = await gate(port, target !== 'session', instanceId)
    if (blocked) return blocked
    return executeLoop(port, args)
  }
  if (action === 'opt') {
    const blocked = await gate(port, true, instanceId)
    if (blocked) return blocked
    return executeOpt(port, args)
  }
  if (action === 'preset') {
    const blocked = await gate(port, true, instanceId)
    if (blocked) return blocked
    return executePreset(port, args)
  }
  return toolError(
    'invalid_params',
    '未知 blender_op action：' + action,
    '可用 action：plan | loop | opt | preset | help',
  )
}
