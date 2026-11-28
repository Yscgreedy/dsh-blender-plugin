// 热无头 worker 会话池入口（拆分）
import { CFG } from '../../config.js'
import { errorMessage } from '../../foundation/json.js'
import type { WorkerRecord } from './api.js'
import {
  sameWorkerFile,
  workerAlive,
  workerCall,
  workerList,
  workerSnapshot,
  workerState,
} from './api.js'
import type { WorkersCtx, WorkersDeps } from './api.js'
import { workerStart } from './worker-start.js'
import { createWorkerReaper, workerRestart, workerStop } from './lifecycle.js'

export type { WorkersDeps, WorkerRecord } from './api.js'
export type { WorkerInfo } from './worker-start.js'

function workerFileFailure(
  code: string,
  message: string,
  fix: string,
  evidence: Record<string, unknown>,
): Error {
  const e: Error & { code?: string; fix?: string; evidence?: Record<string, unknown> } = new Error(
    message,
  )
  e.code = code
  e.fix = fix
  e.evidence = evidence
  return e
}

/** A live worker must already have the requested scene; never exec against another file. */
async function assertWorkerFile(w: WorkerRecord, wanted: string): Promise<void> {
  let current = w.file
  if (!current) {
    try {
      const st = await workerCall(w, { op: 'status' }, 15000)
      const status = (st && (st.status as Record<string, unknown>)) || {}
      current = status.file === undefined || status.file === null ? null : String(status.file)
      if (current) w.file = current
      if (typeof status.objects === 'number') w.objects = status.objects
    } catch (e) {
      /* fall through to the explicit unknown error below */
    }
  }
  if (!current) {
    throw workerFileFailure(
      'worker_file_unverified',
      'worker 没有可核对的文件路径（requested ' + wanted + '）',
      'op=restart 带 file=<目标 .blend>；或先 op=status 确认 bpy.data.filepath',
      { requested_file: wanted, worker: w.name },
    )
  }
  if (!sameWorkerFile(wanted, current)) {
    throw workerFileFailure(
      'worker_file_mismatch',
      'worker 已打开另一个文件：' + current + '（请求 ' + wanted + '）',
      'op=restart 带 file=<目标 .blend> 换干净进程，或换一个 session 名',
      { current_file: current, requested_file: wanted, worker: w.name },
    )
  }
}

async function workerStatusOf(
  ctx: WorkersCtx,
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  if (!workerAlive(w) || !w.ready) return workerSnapshot(w)
  w.lastUsed = Date.now()
  try {
    const r = await workerCall(w, { op: 'status' }, 15000)
    return Object.assign(workerSnapshot(w), { status: r.status || null })
  } catch (e) {
    w.lastError = errorMessage(e)
    return Object.assign(workerSnapshot(w), { statusError: w.lastError })
  }
}

/** 工单 7：内容哈希基线（digest_scope=scene；不改场景、不落盘）。 */
async function workerDigestOf(
  ctx: WorkersCtx,
  nameArg?: unknown,
  fileArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  const wanted = fileArg === undefined || fileArg === null ? '' : String(fileArg).trim()
  if (!workerAlive(w) || !w.ready) {
    await workerStart(ctx, wanted ? { file: wanted } : {}, w.name)
  }
  if (wanted) await assertWorkerFile(w, wanted)
  w.lastUsed = Date.now()
  ctx.metrics.workerExecs = (ctx.metrics.workerExecs || 0) + 1
  try {
    return await workerCall(w, { op: 'digest' }, 120000)
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

/** exec：按 name 取/起 worker，可带内容哈希开关（工单 7）。 */
async function workerExecOf(
  ctx: WorkersCtx,
  code: string,
  timeoutMs = 120000,
  purgePrefixes: unknown = null,
  nameArg?: unknown,
  fileArg?: unknown,
  withDigest = false,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  const wanted = fileArg === undefined || fileArg === null ? '' : String(fileArg).trim()
  if (!workerAlive(w) || !w.ready) {
    await workerStart(ctx, wanted ? { file: wanted } : {}, w.name)
  }
  if (wanted) await assertWorkerFile(w, wanted)
  w.lastUsed = Date.now()
  ctx.metrics.workerExecs++
  try {
    const r = await workerCall(
      w,
      {
        op: 'exec',
        code: String(code || ''),
        purgePrefixes: purgePrefixes || undefined,
        digest: withDigest ? true : undefined,
      },
      timeoutMs,
    )
    if (r && typeof r.objects === 'number') w.objects = r.objects
    if (r && r.file !== undefined) w.file = r.file === null ? null : String(r.file)
    return r
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

async function workerSeeOf(
  ctx: WorkersCtx,
  spec: unknown,
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  if (!workerAlive(w) || !w.ready) await workerStart(ctx, {}, w.name)
  w.lastUsed = Date.now()
  ctx.metrics.workerExecs = (ctx.metrics.workerExecs || 0) + 1
  try {
    return await workerCall(w, { op: 'see', spec: spec || {} }, 60000)
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

async function workerWatchOf(
  ctx: WorkersCtx,
  spec: unknown,
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  if (!workerAlive(w) || !w.ready)
    await workerStart(ctx, { engine: 'workbench', warmup: true }, w.name)
  w.lastUsed = Date.now()
  ctx.metrics.workerExecs = (ctx.metrics.workerExecs || 0) + 1
  try {
    return await workerCall(w, { op: 'watch', spec: spec || {} }, 180000)
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

async function workerAuxOf(
  ctx: WorkersCtx,
  op: string,
  spec: unknown,
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  if (!workerAlive(w) || !w.ready) await workerStart(ctx, {}, w.name)
  w.lastUsed = Date.now()
  ctx.metrics.workerExecs = (ctx.metrics.workerExecs || 0) + 1
  try {
    return await workerCall(w, { op: op, spec: spec || {} }, 120000)
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

async function workerResetOf(ctx: WorkersCtx, nameArg?: unknown): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  if (!workerAlive(w) || !w.ready) await workerStart(ctx, {}, w.name)
  try {
    return await workerCall(w, { op: 'reset' }, 60000)
  } catch (e) {
    w.lastError = errorMessage(e)
    throw e
  }
}

export function createWorkersApi(E: WorkersDeps) {
  const ctx: WorkersCtx = {
    metrics: E.metrics,
    preloadChunk: E.preloadChunk,
    WORKERS: new Map<string, WorkerRecord>(),
    WORKER_PORT:
      Number(process.env.DSH_WORKER_PORT || process.env.DSH_BLENDER_WORKER_PORT) ||
      CFG.workerPort ||
      9879,
  }
  const start = (opts: Record<string, unknown> = {}, nameArg?: unknown) =>
    workerStart(ctx, opts, nameArg)
  const workerExec = (
    code: string,
    timeoutMs = 120000,
    purgePrefixes: unknown = null,
    nameArg?: unknown,
    fileArg?: unknown,
    withDigest = false,
  ) => workerExecOf(ctx, code, timeoutMs, purgePrefixes, nameArg, fileArg, withDigest)
  const workerDigest = (nameArg?: unknown, fileArg?: unknown) =>
    workerDigestOf(ctx, nameArg, fileArg)

  const workerSee = (spec: unknown, nameArg?: unknown) => workerSeeOf(ctx, spec, nameArg)
  const workerWatch = (spec: unknown, nameArg?: unknown) => workerWatchOf(ctx, spec, nameArg)
  // checkpoint / revert / checkpoints share one op name + one spec (痛点8).
  const workerAux = (op: string, spec: unknown, nameArg?: unknown) =>
    workerAuxOf(ctx, op, spec, nameArg)

  const workerReset = (nameArg?: unknown) => workerResetOf(ctx, nameArg)
  const workerStatus = (nameArg?: unknown) => workerStatusOf(ctx, nameArg)
  const { clearWorkerReaper, killWorkers } = createWorkerReaper(ctx)
  return {
    workerStart: start,
    workerExec,
    workerDigest,
    workerSee,
    workerWatch,
    workerReset,
    workerAux,
    workerStatus,
    workerStop: (nameArg?: unknown) => workerStop(ctx, nameArg),
    workerRestart: (nameArg?: unknown, opts?: Record<string, unknown>) =>
      workerRestart(ctx, nameArg, opts),
    workerList: () => workerList(ctx),
    workerSnapshot,
    workerState: (name: unknown) => workerState(ctx, name),
    clearWorkerReaper,
    killWorkers,
  }
}
