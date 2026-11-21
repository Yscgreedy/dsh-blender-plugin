/** blender_py：在 ready 的 GUI 会话里执行 agent 写的 Python（POST /act 通道）。 */
import fs from 'node:fs'
import { BACKEND_HINT } from '../../constants.js'
import { isRecord, text } from '../../contracts/dynamic.js'
import { ensureBackend } from '../../host/backend/index.js'
import type { HostContext } from '../../host/context.js'
import { backendPost, leasedText } from '../../host/http.js'
import { errorLine, toolError, withFailureEvidence } from '../errors.js'
import type { ToolFailure } from '../errors.js'
import { hostCancelled } from './cancel.js'
import { checkpointMode, takePreExecCheckpoint } from './checkpoint.js'
import type { PreExecCheckpoint } from './checkpoint.js'
import { actDeltaEvidence, formatActText } from './envelope.js'
import type { PyOutcomeMeta } from './envelope.js'
import { withFrame } from './frame.js'

const LF = String.fromCharCode(10)

/**
 * /act 的客户端等待窗口。到点只说明"没等到回执"，**不说明脚本失败** ——
 * Blender 侧可能还在跑（见 unknownOutcome）。
 */
const ACT_TIMEOUT_MS = 180000

/**
 * 痛点1b 伴生修法：wm.read_factory_settings / wm.read_homefile 在 **GUI 会话**里会把插件
 * 连同 addon 一起重置掉 —— 现场一次就把整条 GUI 通道打死（之后只有 session_required，
 * 只能全程 headless）。它不是"禁用某个对象"，而是把 DSH Blender Bridge 一起卸掉，所以
 * 在这里拦下来：换成"逐个删除"，或改走 headless / worker（那边没有 addon 可被卸掉）。
 * 真要重置时显式传 allow_factory_reset=true。
 */
const FACTORY_RESET = /(?:wm\.)?(?:read_factory_settings|read_homefile)\s*\(/

function factoryResetGuard(code: string, file: string | null): string | null {
  let source = code
  if (!source && file) {
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch {
      return null // 读不到就交给后端报错，别用一个假理由拦下
    }
  }
  if (!FACTORY_RESET.test(source)) return null
  return (
    'script 里有 wm.read_factory_settings / wm.read_homefile：在 GUI 会话里执行会重置 Blender 并把 ' +
    'DSH Blender Bridge 一起卸掉（会话随即 addon_disconnected，只能人工在 N 面板重新 Enable + Connect）。' +
    '换成：① 逐对象清理 bpy.ops.object.select_all + bpy.ops.object.delete 或 bpy.data.batch_remove(objs)；' +
    '② 场景重置放 blender_run(kind=headless) / action=worker（那边没有 addon 可被卸掉）；' +
    '③ 确认要重置则显式传 allow_factory_reset=true。'
  )
}

/**
 * "没拿到回执"的回执（超时/断连路径）。
 *
 * 现场：/act 的客户端等待是 180 s。超时或 addon 掉线后脚本**仍可能在 Blender 里跑**，
 * 若把它写成"失败"，模型会立刻重跑，场景里叠出第二份材质/节点 —— 而 audit_mesh 不会报
 * （重复材质不是 mesh 缺陷）。所以这里只说"结果未知"，并把 host 侧 request_id 与
 * 执行前回退点交出去，让下一步是"确认现场"而不是"再跑一遍"。
 */
function unknownOutcome(checkpoint: PreExecCheckpoint, cause: unknown): ToolFailure {
  const label = checkpoint.label
  const where = label
    ? 'checkpoint=' + label
    : checkpoint.mode === 'off'
      ? 'checkpoint=off（本次调用显式关了回退点）'
      : 'checkpoint=none（回退点没建成：' + clip(checkpoint.note, 80) + '）'
  const message = [
    'Python 结果未知：/act 等 ' +
      String(ACT_TIMEOUT_MS / 1000) +
      's 没回执（客户端超时或连接中断）—— 这不代表脚本失败：它可能仍在 Blender 里跑，也可能已经跑完并改了场景。',
    'request_id=' + checkpoint.requestId,
    where,
    '原因：' + clip(errorLine(cause), 120),
    '别直接重跑同一段脚本：重复的材质/节点不会被 audit_mesh 报出来（它不是 mesh 缺陷）。',
  ].join(LF)
  const next =
    '先确认现场：blender_inspect command=get_scene_info（看材质/节点有没有重复）；' +
    (label
      ? '要多退一步 → blender_session action=txn op=restore label=' +
        label +
        '（文件级快照，回到这次执行前）；'
      : '') +
    '对象级 mark 用 blender_session action=txn op=revert label=<MARK>；' +
    '只有确认场景没变（例如请求根本没送到 Blender）才直接重跑。'
  const failure = toolError('outcome_unknown', message, next, undefined, 'transport')
  failure.envelope.evidence.request_id = checkpoint.requestId
  failure.envelope.evidence.outcome = 'unknown'
  failure.envelope.evidence.checkpoint = label
  return failure
}

function clip(value: string, size: number): string {
  const trimmed = value.trim()
  return trimmed.length > size ? trimmed.slice(0, size) + '…' : trimmed
}

/**
 * Gateway gate (409 session_in_use / scope_required / human_paused): keep the code,
 * root cause, fix and the caller/owner/grant ids instead of "PY 失败 · unknown".
 */
function declaredScopeText(args: Record<string, unknown>): string {
  return [args.write_scope, args.write_scopes, args.scope]
    .filter((v) => v !== undefined && v !== null)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(String)
    .join(',')
}
function gateFailureReceipt(r: Record<string, unknown>): Record<string, unknown> | null {
  const code = text(r.code)
  if (!code) return null
  const evidence = isRecord(r.evidence) ? r.evidence : {}
  const failure = toolError(
    code,
    'PY 未执行 · ' + text(r.root_cause || r.error || code),
    text(r.fix || r.hint || '按回执里的 caller/owner/grant_holders 修权限后重试'),
    r.evidence ? JSON.stringify(r.evidence) : undefined,
    'session',
  )
  const caller = isRecord(evidence.caller) ? evidence.caller : null
  // Field retest: the gate detail was truncated at 400 chars and cut the UUID in
  // half. Promote the full identity to the top level (never truncated).
  const normalized = {
    ...evidence,
    caller,
    caller_agent_id: caller ? text(caller.agentId) || null : null,
    caller_dsh_session_id: caller ? text(caller.dshSessionId) || null : null,
    session_id: text(evidence.sessionId ?? evidence.session_id) || null,
    owner_agent: text(evidence.owner_agent) || null,
    required_scope: evidence.required_scope ?? evidence.requested ?? null,
    grant_holders: Array.isArray(evidence.grant_holders) ? evidence.grant_holders : [],
  }
  withFailureEvidence(failure, normalized)
  return { ...failure, ...normalized }
}
/**
 * 反馈 4: CANCELLED / no-effect / out-of-scope are failures with the numbers that
 * prove it, not a success with a warning buried in stdout.
 */
function pyFailureResult(r: Record<string, unknown>, kind: string): unknown {
  const delta = actDeltaEvidence(r)
  const code =
    kind === 'cancelled'
      ? 'op_cancelled'
      : kind === 'no_effect'
        ? 'op_no_effect'
        : kind === 'uv_failed'
          ? 'uv_failed'
          : kind === 'scope_violation'
            ? 'scope_violation'
            : 'py_error'
  const why =
    kind === 'cancelled'
      ? '算子返回 CANCELLED（没有执行，几何未改变）'
      : kind === 'no_effect'
        ? 'bpy.ops 返回 FINISHED 但场景内容没有变化（空选择 / 上下文不对）'
        : kind === 'uv_failed'
          ? 'uv.unwrap 报 Unwrap failed to solve（UV 没铺开）'
          : kind === 'scope_violation'
            ? '改动超出本次 grant 的写作用域'
            : 'PY 执行失败'
  const stdout = text(r.stdout || '').trim()
  const failure = toolError(
    code,
    why + ' · ' + text(r.error || r.raw || 'unknown'),
    kind === 'scope_violation'
      ? '缩小脚本的写入范围到 grant 的 collection/prefix，或让 main agent 扩大 grant'
      : kind === 'cancelled' || kind === 'no_effect'
        ? '先选中目标（bpy.context.view_layer.objects.active + select_set）并在 OBJECT 模式重试；读回执里的 faces_delta 确认几何真的变了'
        : '看 traceback/stderr 修脚本；脚本可以重跑。需要后台执行时用 blender_run(kind=headless)。',
    JSON.stringify({ ...delta, stdout: stdout.slice(-1200) }),
  )
  const payload = { ...delta, ...(stdout ? { stdout: stdout.slice(-1200) } : {}) }
  withFailureEvidence(failure, payload)
  // 反馈 4：失败回执也把 changed/faces/scope/rollback 提到顶层，别让 agent 二次解析 detail。
  return { ...failure, ...payload }
}

/** 成功回执的锚点：谁跑的、执行前退到哪。 */
function outcomeMeta(checkpoint: PreExecCheckpoint): PyOutcomeMeta {
  return {
    requestId: checkpoint.requestId,
    checkpoint: checkpoint.label,
    checkpointMode: checkpoint.mode,
    checkpointWarning: checkpoint.label ? null : checkpoint.note || null,
  }
}

/**
 * Execute code inside the GUI session's Blender. The dispatcher already
 * resolved the ready session; no path here starts a headless Blender.
 */
export async function executePy(
  ctx: HostContext,
  port: number,
  args: Record<string, unknown>,
  session: Record<string, unknown>,
): Promise<unknown> {
  if (!(await ensureBackend(port)))
    return toolError(
      'gateway_unreachable',
      'Gateway 不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  const code = String(args.code || '')
  const file = args.file ? String(args.file) : null
  if (!code && !file)
    return toolError(
      'invalid_params',
      'PY 需要 code 或 file 之一',
      '给 code（短 Python）或 file（磁盘上的 .py 脚本路径）',
    )
  const mode = checkpointMode(args.checkpoint)
  if (!mode)
    return toolError(
      'invalid_params',
      'blender_py checkpoint 只接受 auto / off，收到：' + text(args.checkpoint),
      '去掉 checkpoint（默认 auto）或显式写 checkpoint=off',
    )
  const blocked = args.allow_factory_reset === true ? null : factoryResetGuard(code, file)
  if (blocked)
    return toolError('factory_reset_blocked', blocked, '改用逐对象删除，或改走 headless/worker')
  // 执行前回退点（默认 auto）：快照失败不挡这次编辑，只在回执里告警。
  // 反馈 1：子 agent 的 collection grant 覆盖不了 exclusive，文件级快照必然
  // scope_required —— 直接跳过并说明，别用一个必然失败的调用污染回执。
  let checkpoint = await takePreExecCheckpoint(port, mode)
  const scopeText = declaredScopeText(args)
  if (mode === 'auto' && scopeText && !scopeText.includes('exclusive'))
    checkpoint = {
      ...checkpoint,
      label: null,
      note: 'scoped grant：文件级快照需要 exclusive，已跳过；要回退用对象级 mark/revert 或让 main agent 走 txn',
    }
  let r: Record<string, unknown>
  try {
    r = await backendPost(
      port,
      '/act',
      {
        code: code,
        file: file,
        py: true,
        sessionId: String(session.id || ''),
        waitMs: Number(args.wait_ms) || 0,
        ...(args.write_scope !== undefined ||
        args.write_scopes !== undefined ||
        args.scope !== undefined
          ? { write_scope: args.write_scope ?? args.write_scopes ?? args.scope }
          : {}),
      },
      ACT_TIMEOUT_MS,
    )
  } catch (e) {
    if (hostCancelled()) throw e
    return unknownOutcome(checkpoint, e)
  }
  const lt = leasedText(r)
  if (lt) return { text: lt }
  const gate = gateFailureReceipt(r)
  if (gate) return gate
  const kind = text(r.errorKind)
  if (!r || r.ok !== true) return pyFailureResult(r, kind)
  const out: Record<string, unknown> = {
    text: formatActText(r, outcomeMeta(checkpoint)).join(LF),
    ...actDeltaEvidence(r),
  }
  if (args.see === false) return out
  return await withFrame(ctx, port, args, out)
}
