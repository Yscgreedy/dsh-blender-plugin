/**
 * 队列作业的唯一传输面：POST /job，请求体统一带 surface=queue。
 *
 * 为什么要一个构造器：提交体原来在 src/tools/run/execute.ts 与 src/tools/op/local.ts 里各手写一遍
 * （surface 写两次、op="submit" 写两次、Gateway 不可达的回执写两份）。改一次 submit 语义就要同改两处，
 * 漏一处就是两个车道对同一个后端说不同的话 —— 而两者共用同一条 queue surface。
 *
 * 边界：这里只造请求体与传输失败回执；作业语义（排队/租约/台账）在 runtime/core/queue。
 */
import { text } from '../../contracts/dynamic.js'
import { backendPost } from '../../host/http.js'

/** 队列车道名（后端据此选 JobSurface；这里是唯一定义点）。 */
export const QUEUE_SURFACE = 'queue'

/** /job 请求体的唯一包装：任何动作都带 surface=queue。 */
export function queueJobBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { surface: QUEUE_SURFACE, ...fields }
}

/** 作业提交体：op="submit" 只在这里写（blender_run submit 与本地无头车道共用）。 */
export function jobSubmitBody(fields: Record<string, unknown>): Record<string, unknown> {
  return queueJobBody({ op: 'submit', ...fields })
}

/**
 * Gateway 不可达的统一回执：两个车道用同一组字段（ok/code/stage/root_cause/fix）。
 * 调用方可以照旧读 body.stage / body.code 去构造失败回执。
 */
export function gatewayUnreachable(e: unknown, fix: string): Record<string, unknown> {
  return {
    ok: false,
    code: 'gateway_unreachable',
    stage: 'transport',
    root_cause: 'Gateway 不可达 · ' + text(e instanceof Error ? e.message : e),
    fix,
  }
}

async function postJobBody(
  port: number,
  body: Record<string, unknown>,
  timeoutMs: number,
  fix: string,
): Promise<Record<string, unknown>> {
  try {
    return await backendPost(port, '/job', body, timeoutMs)
  } catch (e: unknown) {
    return gatewayUnreachable(e, fix)
  }
}

/** 发一个队列动作（list/status/wait/collect/cancel/perf…）。传输失败不抛。 */
export async function postQueueJob(
  port: number,
  fields: Record<string, unknown>,
  timeoutMs: number,
  fix: string,
): Promise<Record<string, unknown>> {
  return postJobBody(port, queueJobBody(fields), timeoutMs, fix)
}

/** 提交一个作业（op=submit；render/headless/本地车道）。传输失败不抛。 */
export async function postJobSubmit(
  port: number,
  fields: Record<string, unknown>,
  timeoutMs: number,
  fix: string,
): Promise<Record<string, unknown>> {
  return postJobBody(port, jobSubmitBody(fields), timeoutMs, fix)
}
