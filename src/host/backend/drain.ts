/**
 * host/backend/drain：让 Gateway **自己**把会话与作业收干净，再终止进程（H4 / H5 的优雅面）。
 *
 * 为什么不是"直接杀"：helper（dsh-blender-hidden-desktop）与它拉起的隐藏 Blender 是 Gateway
 * 的子/孙进程；粗暴 kill 之后，会话与未完成作业只在磁盘台账里留下 running —— 下一位调用者
 * 面对的就是"僵尸作业"与"没人停的 helper"（现场：热更 10 次后 helper 越堆越多、目录替换半残）。
 * POST /lease{action:"shutdown"} 走 sessionRegistry.disposeAll() + jobQueue.cancelAll()，
 * 回执里的 stopped / jobsDropped 就是"这次收了什么"的证据。
 *
 * 身份：关停不是任何 agent 的权限动作（registry.disposeAll 的注释同义），所以没有 exec 上下文
 * （dispose / 看护 / reload 这些宿主路径）时用宿主身份说话，字段集与 callerHeaders() 一致 ——
 * 有 exec 上下文时优先沿用真实调用者，便于 Gateway 侧归因。
 */
import { HOLDER } from '../../constants.js'
import { callerHeaders } from '../exec-context.js'
import { backendJson } from '../http.js'

/** 一次优雅收尾的回执（失败也要有话说，绝不静默）。 */
export interface DrainReceipt {
  ok: boolean
  /** 被停掉的会话 id（helper + 隐藏 Blender 一并停） */
  stopped: string[]
  failed: string[]
  /** 被置 canceled 的作业 id（重新入口 = 重新 submit） */
  jobsDropped: string[]
  /** Gateway 是否已排定退出（true = 它自己会走，不必再杀） */
  exitScheduled: boolean
  ms: number
  error: string | null
}

/** 宿主控制身份：hostId 用 pid 打头，session/agent 用 host-control（Gateway 只要求三个头齐全）。 */
export function controlHeaders(): Record<string, string> {
  const caller = callerHeaders()
  if (caller['x-dsh-host-id'] && caller['x-dsh-session-id'] && caller['x-dsh-agent-id'])
    return caller
  return {
    'x-dsh-host-id': 'host-pid-' + String(process.pid),
    'x-dsh-session-id': 'host-control',
    'x-dsh-agent-id': 'host-control',
    'x-dsh-agent-role': 'main',
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x) => String(x)).filter(Boolean) : []
}

/**
 * 请 Gateway 收尾（会话 → 作业 → 自退）。有界：超时/不可达只降级成 ok=false + error，
 * 调用方照样可以杀进程树（"收了没有"和"杀不杀"是两件事，别让一个失败拖死另一个）。
 */
export async function drainGateway(
  port: number,
  reason: string,
  timeoutMs = 5000,
): Promise<DrainReceipt> {
  const t0 = Date.now()
  try {
    const body = await backendJson(port, '/lease', timeoutMs, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...controlHeaders() },
      body: JSON.stringify({ action: 'shutdown', reason, holder: HOLDER }),
    })
    const ok = body.ok !== false
    return {
      ok,
      stopped: stringList(body.stopped),
      failed: stringList(body.failed),
      jobsDropped: stringList(body.jobsDropped),
      exitScheduled: body.exitScheduled === true,
      ms: Date.now() - t0,
      error: ok ? null : String(body.root_cause || body.error || body.code || 'drain rejected'),
    }
  } catch (e: unknown) {
    return {
      ok: false,
      stopped: [],
      failed: [],
      jobsDropped: [],
      exitScheduled: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
