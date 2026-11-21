import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../core/json.js'

/** 失败信封：只透出插件约定的 code，并为已知配置错误补齐四问字段。 */
function workerFailureBody(e: unknown, op: string): Record<string, unknown> {
  const error = errorMessage(e)
  const code = errorField(e, 'code')
  const known =
    code === 'blender_exe_missing' ||
    code === 'worker_file_mismatch' ||
    code === 'worker_file_unverified'
  return {
    ok: false,
    op: op,
    error: error,
    hint: errorField(e, 'hint') || null,
    // Node 内部错误码（ERR_INVALID_ARG_TYPE 等）不该变成模型可见的结构化错误码。
    code: known ? code : null,
    // 安全 fallback：已知配置错误必须带齐四问字段，不能只给一句错误文本。
    ...(known
      ? {
          stage: errorField(e, 'stage') || 'config',
          root_cause: error,
          fix: errorField(e, 'fix') || errorField(e, 'hint') || null,
          fallback: errorField(e, 'fallback') || null,
          evidence: errorField(e, 'evidence') || {},
        }
      : {}),
  }
}

/** exec 分支：purge 解析 + digest 开关 + 信封层错误/回溯。 */
async function execResponse(
  E: HttpRouteDeps,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const purge = payload.purgePrefix
    ? String(payload.purgePrefix)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : null
  const r = await E.engine.worker.exec(
    String(payload.code || ''),
    Number(payload.timeoutMs) || 120000,
    purge,
    payload && payload.name,
    payload && payload.file,
    payload.digest === true,
  )
  // v0.8.4：错误/回溯提到信封层，避免客户端只看到 unknown
  return {
    ok: !!r.ok,
    op: 'exec',
    result: r,
    error: r && r.error ? String(r.error) : null,
    traceback: r && r.traceback ? String(r.traceback) : null,
  }
}

/** /worker 的 op 分派（信封固定 {ok, op, result, error?, traceback?}）。 */
async function dispatchWorker(
  E: HttpRouteDeps,
  op: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { engine } = E
  const name = payload && payload.name
  // v0.9.4：全部按 name 走（缺省 = 'default'，与老调用逐字节同义）
  // start/restart 的 result 是 worker 快照；补显式 ok 让两层一致（stop 不补）。
  if (op === 'start')
    return {
      ok: true,
      op: op,
      result: Object.assign({ ok: true }, await engine.worker.start(payload, name)),
    }
  if (op === 'stop') return { ok: true, op: op, result: await engine.worker.stop(name) }
  if (op === 'restart')
    return {
      ok: true,
      op: op,
      result: Object.assign({ ok: true }, await engine.worker.restart(name, payload)),
    }
  if (op === 'list')
    return { ok: true, op: op, result: { ok: true, workers: engine.worker.list() } }
  if (op === 'digest')
    return { ok: true, op: op, result: await engine.worker.digest(name, payload.file) }
  if (op === 'exec') return execResponse(E, payload)
  if (op === 'see')
    return {
      ok: true,
      op: op,
      result: await engine.worker.see(payload.spec || payload.see || {}, name),
    }
  if (op === 'watch')
    return {
      ok: true,
      op: op,
      result: await engine.worker.watch(payload.spec || payload.watch || {}, name),
    }
  if (op === 'reset') return { ok: true, op: op, result: await engine.worker.reset(name) }
  // 痛点8：文件级 checkpoint 栈 —— 与 exec/see 同一个热进程。
  if (op === 'checkpoint' || op === 'revert' || op === 'checkpoints' || op === 'relocate') {
    const spec = (payload.spec || payload.checkpoint || payload.revert || {}) as unknown
    return { ok: true, op: op, result: await engine.worker.aux(op, spec, name) }
  }
  return { ok: true, op: 'status', result: await engine.worker.status(name) }
}

// HTTP 路由 /worker：热无头会话
export function createWorkerRoutes(E: HttpRouteDeps) {
  const { isReadOnly, json, leaseGate, readBody, stats, streamJson } = E
  return {
    async worker(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      const raw = await readBody(req)
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(raw)
      } catch (e) {
        payload = {}
      }
      const op = String(payload.op || 'status')
      // worker 是**独立无头进程**，不碰 live GUI 场景 ⇒ 显式 isolated:true 时不占全局写租约。
      const gate = payload.isolated || isReadOnly('/worker', op) ? null : leaseGate(payload)
      if (gate) {
        json(res, 409, gate)
        return
      }
      stats.worker = (stats.worker || 0) + 1
      await streamJson(res, async () => {
        try {
          return await dispatchWorker(E, op, payload)
        } catch (e) {
          stats.lastError = errorMessage(e)
          return workerFailureBody(e, op)
        }
      })
    },
  }
}
