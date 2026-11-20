// worker 登记与单次请求
import net from 'node:net'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

export interface WorkersDeps {
  metrics: { workerStarts: number; workerExecs: number; [k: string]: unknown }
  preloadChunk: (name: string) => string
}

export interface WorkerRecord {
  [k: string]: unknown
  name: string
  child: ChildProcess | null
  port: number
  ready: boolean
  startedAt: number | null
  gpu: unknown
  pid: number | null
  /** bpy.data.filepath after the worker opened/created its scene (null until hello/status). */
  file: string | null
  /** len(bpy.data.objects) for the same moment; 0 is a valid value, null means unknown. */
  objects: number | null
  lastError: string | null
  stdoutTail: string
  stderrTail: string
  boot?: unknown
  lastUsed?: number
  /**
   * The in-flight start for this name. A retried/concurrent start joins it instead of
   * killing a booting child and racing for the same port (field report 3.2.0-alpha.1).
   */
  starting?: Promise<Record<string, unknown>> | null
}

export interface WorkersCtx {
  metrics: WorkersDeps['metrics']
  preloadChunk: (name: string) => string
  WORKERS: Map<string, WorkerRecord>
  WORKER_PORT: number
}

export function workerKey(n: unknown): string {
  const k = String(n === undefined || n === null || n === '' ? 'default' : n)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 24)
  return k || 'default'
}

export function workerState(ctx: WorkersCtx, name: unknown): WorkerRecord {
  const key = workerKey(name)
  const found = ctx.WORKERS.get(key)
  if (found) return found
  const used = new Set(Array.from(ctx.WORKERS.values()).map((x) => x.port))
  let p = ctx.WORKER_PORT
  while (used.has(p)) p += 1 // 端口顺延，避免两个实例撞车
  const w: WorkerRecord = {
    name: key,
    child: null,
    port: p,
    ready: false,
    startedAt: null,
    gpu: null,
    pid: null,
    file: null,
    objects: null,
    lastError: null,
    stdoutTail: '',
    stderrTail: '',
  }
  ctx.WORKERS.set(key, w)
  return w
}

export function workerAlive(w: WorkerRecord | null | undefined): boolean {
  return !!(w && w.child && w.child.exitCode === null && !w.child.signalCode)
}

export function workerSnapshot(w: WorkerRecord): Record<string, unknown> {
  const alive = workerAlive(w)
  return {
    name: w.name,
    alive: alive,
    ready: w.ready,
    // pid 只在进程活着时有意义：stop 之后任何路径残留的 pid 都会被读成「还在跑」
    //（复测现场：stop 之后立刻 status 出现 alive:false + 旧 pid，读起来像没停干净）。
    pid: alive ? w.pid : null,
    port: w.port,
    file: w.file,
    objects: w.objects,
    uptimeMs: w.startedAt ? Date.now() - w.startedAt : null,
    idleMs: w.lastUsed ? Date.now() - w.lastUsed : null,
    gpu: w.gpu,
    boot: w.boot || null,
    lastError: w.lastError,
    stdoutTail: w.stdoutTail ? w.stdoutTail.slice(-1200) : null,
  }
}

export function workerList(ctx: WorkersCtx): Array<Record<string, unknown>> {
  return Array.from(ctx.WORKERS.values()).map((w) => workerSnapshot(w))
}

/** 与 worker 的单次请求-应答（每次新建短连接，避免残留状态） */
export function workerCall(
  w: WorkerRecord,
  req: Record<string, unknown>,
  timeoutMs = 120000,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const s = net.connect({ host: '127.0.0.1', port: w.port })
    let buf = ''
    let settled = false
    const done = (v: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      try {
        s.destroy()
      } catch (e) {
        /* ignore */
      }
      resolve(v)
    }
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      try {
        s.destroy()
      } catch (e2) {
        /* ignore */
      }
      reject(e)
    }
    const t = setTimeout(
      () =>
        fail(
          new Error(
            'worker 响应超时 ' + timeoutMs + 'ms（长代码会占住 worker；可 op=status 看状态）',
          ),
        ),
      timeoutMs,
    )
    s.once('connect', () => s.write(JSON.stringify(Object.assign({ id: id }, req)) + '\n'))
    s.once('error', (e) => {
      clearTimeout(t)
      fail(e)
    })
    s.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let obj: Record<string, unknown> | null
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch (e) {
          continue
        }
        if (!obj) continue
        if (obj.id !== undefined && obj.id !== null && obj.id !== id) continue
        clearTimeout(t)
        done(obj)
        return
      }
    })
  })
}

/** Same scene file? Windows paths are case-insensitive and slash-insensitive. */
export function sameWorkerFile(a: unknown, b: unknown): boolean {
  const left = String(a === undefined || a === null ? '' : a).trim()
  const right = String(b === undefined || b === null ? '' : b).trim()
  if (!left || !right) return false
  const windows =
    process.platform === 'win32' ||
    /^[A-Za-z]:[\\/]/.test(left) ||
    /^[A-Za-z]:[\\/]/.test(right) ||
    left.startsWith('\\\\') ||
    right.startsWith('\\\\')
  const norm = (p: string): string =>
    (windows ? path.win32.resolve(p) : path.resolve(p)).replace(/[\\/]+$/, '')
  const x = norm(left)
  const y = norm(right)
  return windows ? x.toLowerCase() === y.toLowerCase() : x === y
}
