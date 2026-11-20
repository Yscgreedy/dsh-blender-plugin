// worker 生命周期：stop/restart/空闲回收
import type { WorkerRecord, WorkersCtx } from './api.js'
import { workerAlive, workerCall, workerState } from './api.js'
import { workerStart } from './worker-start.js'

/** Grace after a shutdown frame; a healthy worker.py exits well inside this window. */
const STOP_GRACE_MS = 2000
/** Grace after SIGKILL; a process that survives this is reported alive, not "stopped". */
const STOP_KILL_MS = 2000
const STOP_POLL_MS = 25

/**
 * Wait for the child to actually exit.
 *
 * The old stop slept 300 ms and then *assumed* the process was gone, so the receipt
 * said "stopped" while the port was still held — and the symmetric bug (start saying
 * FAIL while the worker was booting) made agents retry into a port collision.
 */
function waitWorkerExit(w: WorkerRecord, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = w.child
    if (!workerAlive(w) || !child) {
      resolve(true)
      return
    }
    let timer: NodeJS.Timeout | null = null
    let deadline: NodeJS.Timeout | null = null
    let done = false
    const finish = (exited: boolean): void => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      if (deadline) clearTimeout(deadline)
      try {
        child.removeListener('close', onExit)
        child.removeListener('exit', onExit)
      } catch (e) {
        /* ignore */
      }
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    child.once('close', onExit)
    child.once('exit', onExit)
    timer = setInterval(() => {
      if (!workerAlive(w)) finish(true)
    }, STOP_POLL_MS)
    deadline = setTimeout(() => finish(!workerAlive(w)), ms)
  })
}

/**
 * Dead worker → 清 ready/pid/child，并把**清掉的值**回给调用方。
 *
 * 复测现场（3.2.0-alpha.1）：stop 之后立刻 status 短暂出现 `alive:false` 但 `pid` 还是旧值，
 * 读起来像没停干净。pid 本身没有歧义（有 pid 就该活着），所以这里两头都收口：
 * 快照对死进程一律回 pid=null，stop 回执再用 `cleared` 说明清掉了什么。
 */
function clearDeadWorker(w: WorkerRecord): Record<string, unknown> | null {
  const had = w.pid !== null || w.ready || w.child !== null
  const cleared = { pid: w.pid, ready: w.ready }
  w.ready = false
  w.pid = null
  w.child = null
  w.file = null
  w.objects = null
  return had ? cleared : null
}

export async function workerStop(
  ctx: WorkersCtx,
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg)
  // 正在 boot 的进程先等它的 start 落地：否则 start 的等待会看到被我们杀掉的 child，
  // 把一次"用户主动停掉"报成 "worker 未就绪"。
  if (w.starting) {
    try {
      await w.starting
    } catch (e) {
      /* start 自己已经失败，继续停 */
    }
  }
  if (!workerAlive(w)) {
    return {
      name: w.name,
      stopped: false,
      wasAlive: false,
      alive: false,
      pid: null,
      cleared: clearDeadWorker(w),
    }
  }
  let bye = null
  try {
    bye = await workerCall(w, { op: 'shutdown' }, 8000)
  } catch (e) {
    /* shutdown 不通就直接杀 */
  }
  let signaled = false
  if (!(await waitWorkerExit(w, STOP_GRACE_MS)) && workerAlive(w)) {
    try {
      if (w.child) w.child.kill('SIGKILL')
      signaled = true
    } catch (e) {}
  }
  if (signaled) await waitWorkerExit(w, STOP_KILL_MS)
  const alive = workerAlive(w)
  // 只有真退出才清 pid/child：还活着就如实说 alive=true，让 agent 去 status 看。
  const cleared = alive ? null : clearDeadWorker(w)
  if (alive) w.ready = false
  return {
    name: w.name,
    stopped: !alive,
    wasAlive: true,
    alive,
    signaled,
    bye,
    // 停干净之后 pid 一定是 null；cleared 说明这次清掉了哪个 pid / ready
    pid: w.pid,
    port: w.port,
    cleared,
  }
}

/** 重启：换一个干净会话（复用 = 放弃进程隔离，脚本脏了就用它） */
export async function workerRestart(
  ctx: WorkersCtx,
  nameArg?: unknown,
  opts?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await workerStop(ctx, nameArg)
  return workerStart(ctx, opts || {}, nameArg)
}

// 会话池：空闲回收（默认 15 min；DSH_WORKER_TTL_MS 可调；0=关闭）。只回收 ready 且无请求在飞的热进程。
export function createWorkerReaper(ctx: WorkersCtx): {
  clearWorkerReaper: () => void
  killWorkers: () => void
} {
  const WORKER_TTL_MS = (() => {
    const n = Number(process.env.DSH_WORKER_TTL_MS)
    return Number.isFinite(n) && n >= 0 ? n : 900000
  })()
  let workerReaper: NodeJS.Timeout | null = null
  if (WORKER_TTL_MS > 0) {
    workerReaper = setInterval(() => {
      const now = Date.now()
      for (const w of ctx.WORKERS.values()) {
        if (!workerAlive(w) || !w.ready) continue
        if (w.lastUsed && now - w.lastUsed > WORKER_TTL_MS) {
          try {
            workerStop(ctx, w.name).catch(() => {})
          } catch (e) {
            /* 下一轮再试 */
          }
        }
      }
    }, 30000)
    try {
      if (workerReaper.unref) workerReaper.unref()
    } catch (e) {}
  }
  function clearWorkerReaper(): void {
    if (workerReaper) {
      try {
        clearInterval(workerReaper)
      } catch (e) {}
      workerReaper = null
    }
  }
  function killWorkers(): void {
    try {
      for (const w of ctx.WORKERS.values()) {
        if (workerAlive(w) && w.child) w.child.kill('SIGKILL')
      }
    } catch (e) {}
  }
  return { clearWorkerReaper, killWorkers }
}
