// Which Blender instance a request should drive.
//
// 3.1 can hold several addon connections at once. The transport refuses an
// unqualified call in that state, so every host request resolves its target once
// here: the instance of the caller's own GUI session. Payload-level overrides
// (`instance_id`) are applied by the route that accepts them.
import { sessionRegistry } from './session-gate.js'
import { currentInstanceId } from '../transport/instance-target.js'
import type { CallerIdentity } from '../core/sessions/types.js'

/** The Blender instance this caller already owns; null when nothing is attached. */
export function callerInstanceId(caller: CallerIdentity | null): string | null {
  if (!caller) return null
  const registry = sessionRegistry()
  const found = registry ? registry.findForCaller(caller) : null
  const own = found && found.instanceId ? String(found.instanceId) : ''
  if (own) return own
  // 反馈 1/3: a subagent (or another DSH session on this host) has no owned
  // session, but read-only see/op calls still need a target. Routing to the one
  // readable session lets the receipt carry owner/is_mine instead of guessing
  // from whatever addon happens to be connected; writes stay gated.
  const readable = registry ? registry.readableInstanceFor(caller) : null
  return readable || null
}

/**
 * 多实例下"这次调用该驱动哪台 Blender"根本没定：调用方既没在 payload 里点名
 * `instance_id`，也没有自己的会话。此时写门只会给出 `session_unavailable`，
 * 模型看不出 `instance_id` 这个出口；这里直接把可选实例列出来（不执行任何
 * Blender 调用），让它下一步就能自解。
 *
 * `ready` 由会话注册表给出：engine 面在装配时按自有属性复制，addon 客户端上的
 * 原型 getter（instances）到不了宿主侧。
 */
export function targetAmbiguity(
  op: string,
  payload: Record<string, unknown>,
  ready: string[],
): Record<string, unknown> | null {
  const named = String(payload.instance_id ?? payload.instanceId ?? '').trim()
  if (named || currentInstanceId()) return null
  if (ready.length < 2) return null
  return {
    ok: false,
    op,
    error:
      'ambiguous_instance: 有多个 Blender 实例连接（' +
      ready.join(' / ') +
      '），调用必须显式给 instanceId：这次既没有 payload.instanceId，也没有调用方会话可以推断',
    stage: 'transport',
    instances: ready,
    fix: 'body 加 instanceId: "' + ready[0] + '"（instance_id 同义）后重试',
    hint: 'instance_id 省略时只有"恰好一个 ready 实例"才允许。',
  }
}
