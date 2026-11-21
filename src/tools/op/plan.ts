/** blender_op action=plan：catalog 契约算子执行（会话门由 dispatcher 先做）。 */
import { BACKEND_HINT } from '../../constants.js'
import { ensureBackend } from '../../host/backend/index.js'
import { backendPost, jsonPayload, leasedText } from '../../host/http.js'
import { isRecord, text } from '../../contracts/dynamic.js'
import type { HostContext } from '../../host/context.js'
import { toolError, withFailureEvidence } from '../errors.js'
import { finishPlanResponse } from './plan-response.js'

export async function executePlan(
  ctx: HostContext,
  port: number,
  argsIn: Record<string, unknown>,
): Promise<unknown> {
  if (!(await ensureBackend(port)))
    return toolError(
      'gateway_unreachable',
      'Gateway 不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  const op = text(argsIn.op) || 'status'
  const payload = jsonPayload(argsIn.args)
  if (
    !Object.keys(payload).length &&
    typeof argsIn.args === 'string' &&
    argsIn.args.trim() &&
    argsIn.args.trim() !== '{}'
  )
    return toolError(
      'invalid_params',
      'OP ' + op + ' 失败 · args 不是合法 JSON 对象：' + argsIn.args.slice(0, 200),
      'args 传 JSON 对象，例如 {"family":"audit"}',
    )
  if (op === 'report' && argsIn.path) payload.path = text(argsIn.path)
  const body: Record<string, unknown> = { op: op, args: payload }
  // 多实例：显式点名实例时透到 /plan；空串表示"按本会话自己的实例"（router 已定）。
  const instanceId = text(argsIn.instance_id).trim()
  if (instanceId) body.instance_id = instanceId
  // 反馈 1/3: the declared write scope is what a grant is checked against.
  // Omitting it keeps the historical 'exclusive' fallback in the Gateway.
  const writeScope = argsIn.write_scope ?? argsIn.write_scopes ?? argsIn.scope
  if (writeScope !== undefined && writeScope !== null && String(writeScope).trim() !== '')
    body.write_scope = writeScope
  const r = await backendPost(port, '/plan', body, 300000)
  const lt = leasedText(r)
  if (lt) return { text: lt }
  if (!r || r.ok !== true) {
    const code = text(r.code)
    if (code) {
      const failure = toolError(
        code,
        'OP ' + op + ' 被门禁拒绝 · ' + text(r.root_cause || r.error || code),
        text(r.fix || r.hint || '按回执里的 caller/owner/grant_holders 修权限后重试'),
        r.evidence ? JSON.stringify(r.evidence) : undefined,
        'session',
      )
      if (isRecord(r.evidence)) withFailureEvidence(failure, r.evidence)
      return failure
    }
    return toolError(
      'backend_error',
      'OP ' + op + ' 失败 · ' + text(r.error || r.raw || 'unknown'),
      '检查 /plan op 名与参数；不确定先 blender_op action=plan op=catalog',
    )
  }
  return await finishPlanResponse(ctx, op, r.result, argsIn)
}
