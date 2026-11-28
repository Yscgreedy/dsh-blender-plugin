// worker 启动与就绪
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { winToWsl, wslToWin } from '../../config.js'
import { assertBlenderExe, blenderExeSource } from '../exe-guard.js'
import { resolveBlenderExe } from '../../blender-exe.js'
import {
  BLENDER_EXE,
  USER_CONFIG_WIN,
  USER_SCRIPTS_WIN,
  WIN_TMP,
  WORKER_PATH,
} from '../../paths.js'
import { KERNEL_BOOTSTRAP } from '../../foundation/kernel/index.js'
import { errorMessage } from '../../foundation/json.js'
import type { WorkerRecord, WorkersCtx } from './api.js'
import {
  sameWorkerFile,
  workerAlive,
  workerCall,
  workerSnapshot,
  workerState,
  workerKey,
} from './api.js'

// assertBlenderExe 提到 runtime/execution/exe-guard.ts（job 通道共用），这里保持旧导出名兼容。
export { assertBlenderExe } from '../exe-guard.js'

export interface WorkerInfo {
  timedOut?: boolean
  ok?: Record<string, unknown>
  exited?: boolean
  code?: number | null
  signal?: NodeJS.Signals | null
  spawnErr?: Error
}

function prepareBootFile(
  ctx: WorkersCtx,
  w: WorkerRecord,
  opts: Record<string, unknown>,
): string | null {
  // preload —— 把 KERNEL_BOOTSTRAP + 模块源码写成 boot 文件，worker 在 ready 前 exec。
  const preloadRaw = opts.preload === undefined || opts.preload === null ? [] : opts.preload
  const preloadList = (Array.isArray(preloadRaw) ? preloadRaw : String(preloadRaw).split(','))
    .map((x) => String(x).trim().replace(/\.py$/, ''))
    .filter(Boolean)
  if (!preloadList.length) return null
  try {
    const bootWsl = path.join(winToWsl(WIN_TMP), 'worker_boot_' + workerKey(w.name) + '.py')
    fs.mkdirSync(path.dirname(bootWsl), { recursive: true })
    const bootSrc = [KERNEL_BOOTSTRAP]
      .concat(preloadList.map((m) => ctx.preloadChunk(m)))
      .join(String.fromCharCode(10))
    fs.writeFileSync(bootWsl, bootSrc, 'utf8')
    return wslToWin(bootWsl)
  } catch (e) {
    const err: Error & { hint?: string } = new Error(
      'worker preload 前导写盘失败：' + errorMessage(e),
    )
    err.hint = '检查 workDir 是否可写（DSH_BLENDER_WORKDIR）'
    throw err
  }
}

function buildWorkerArgs(
  port: number,
  gpuMode: string,
  engineMode: string,
  bootWin: string | null,
  fileWin?: string | null,
): string[] {
  const args: string[] = ['-b', '--factory-startup']
  // A .blend opened here is the worker's whole scene; --factory-startup only skips
  // the user startup file, it does not bypass the positional file argument.
  if (fileWin) args.push(fileWin)
  args.push(
    '--python',
    wslToWin(WORKER_PATH),
    '--',
    '--port',
    String(port),
    '--gpu',
    gpuMode,
    '--engine',
    engineMode,
    '--frame-dir',
    String(WIN_TMP),
  )
  if (bootWin) args.push('--boot', bootWin)
  return args
}

function buildWorkerEnv(opts: Record<string, unknown>): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    DSH_WORKER_FRAME_DIR: String(WIN_TMP),
  })
  if (opts.useUserConfig) {
    if (USER_CONFIG_WIN) childEnv.BLENDER_USER_CONFIG = USER_CONFIG_WIN
    if (USER_SCRIPTS_WIN) childEnv.BLENDER_USER_SCRIPTS = USER_SCRIPTS_WIN
  }
  return childEnv
}

function waitWorkerReady(
  w: WorkerRecord,
  child: ChildProcess,
  opts: Record<string, unknown>,
): Promise<WorkerInfo> {
  return new Promise<WorkerInfo>((resolve) => {
    let so = '',
      se = ''
    const t = setTimeout(
      () => resolve({ timedOut: true }),
      Math.max(20000, Number(opts.startTimeoutMs) || 90000),
    )
    if (child.stdout)
      child.stdout.on('data', (d: Buffer) => {
        so += d.toString('utf8')
        w.stdoutTail = so.slice(-4000)
        const m = so.match(/DSH_WORKER (\{[\s\S]*?\})\s*(\r?\n|$)/)
        if (m) {
          try {
            clearTimeout(t)
            resolve({ ok: JSON.parse(m[1]) as Record<string, unknown> })
          } catch (e) {
            /* 继续攒 */
          }
        }
      })
    if (child.stderr)
      child.stderr.on('data', (d: Buffer) => {
        se += d.toString('utf8')
        w.stderrTail = se.slice(-4000)
      })
    child.on('close', (code, sig) => {
      clearTimeout(t)
      resolve({ exited: true, code: code, signal: sig })
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ spawnErr: e })
    })
  })
}

function assertWorkerReady(
  w: WorkerRecord,
  child: ChildProcess,
  info: WorkerInfo,
  exe: string | null,
): Record<string, unknown> {
  if (info.spawnErr) {
    const spawnErr = info.spawnErr as NodeJS.ErrnoException
    const exeMissing = String(spawnErr.code || '') === 'ENOENT'
    const e: Error & {
      hint?: string
      code?: string
      stage?: string
      fix?: string
      fallback?: { kind: string; summary: string }
      evidence?: Record<string, unknown>
    } = new Error(
      'worker 起不来（' +
        String(exe) +
        '）：' +
        String((info.spawnErr && info.spawnErr.message) || info.spawnErr),
    )
    e.hint = exeMissing
      ? 'blenderExe 指向的文件不存在；设置 DSH_BLENDER_EXE 或 dsh-blender.config.json 的 blenderExe 为真实 blender.exe，改完重启 DSH，再 blender_run op=start 重试'
      : '检查 blenderExe 配置与 runtime/py/core/worker.py 是否存在'
    if (exeMissing) {
      // 安全 fallback：spawn ENOENT 不是未知后端故障，而是可执行的配置错误。
      e.code = 'blender_exe_missing'
      e.stage = 'config'
      e.fix = e.hint
      e.fallback = {
        kind: 'unavailable',
        summary: '没有可执行的 Blender 时无法启动无头 worker；不会启动可见 GUI 或伪造渲染。',
      }
      e.evidence = {
        blenderExe: String(exe || ''),
        spawnError: String(spawnErr.code || ''),
      }
    }
    throw e
  }
  if (!info.ok) {
    const e: Error & { hint?: string } = new Error(
      'worker 未就绪：' + JSON.stringify(info).slice(0, 200),
    )
    e.hint = 'worker stderr 尾部：' + String(w.stderrTail || '').slice(-500)
    try {
      child.kill('SIGKILL')
    } catch (x) {}
    throw e
  }
  const boot = (info.ok.boot || null) as {
    ok?: boolean
    error?: unknown
    stderr?: unknown
  } | null
  if (boot && boot.ok === false) {
    const e: Error & { hint?: string } = new Error(
      'worker boot/preload 失败：' + String(boot.error || 'unknown'),
    )
    e.hint =
      'boot stderr 尾部：' +
      String(boot.stderr || '').slice(-500) +
      '；检查 preload 模块名（runtime/py/<domain>/<name>.py）'
    try {
      child.kill('SIGKILL')
    } catch (x) {}
    throw e
  }
  return info.ok
}

async function warmupWorker(w: WorkerRecord): Promise<Record<string, unknown>> {
  try {
    const wr = await workerCall(w, { op: 'see', spec: { width: 64, height: 36, aa: '2' } }, 60000)
    return { ok: !!(wr && wr.ok !== false), ms: (wr && wr.ms) || null }
  } catch (err) {
    return {
      ok: false,
      error: String((err as { message?: unknown }).message || err).slice(0, 200),
    }
  }
}

// BLENDER_EXE 为空时 spawn() 会同步抛 Node 的 TypeError，child.on('error')
// 与 assertWorkerReady 的 hint 都走不到。启动前预检（实现在 exe-guard.ts），给出可执行的配置指引。
export async function workerStart(
  ctx: WorkersCtx,
  opts: Record<string, unknown> = {},
  nameArg?: unknown,
): Promise<Record<string, unknown>> {
  const w = workerState(ctx, nameArg !== undefined ? nameArg : opts.name)
  if (workerAlive(w) && w.ready) {
    const wanted = opts.file === undefined || opts.file === null ? '' : String(opts.file).trim()
    if (wanted && w.file && !sameWorkerFile(wanted, w.file)) {
      const e: Error & { code?: string; fix?: string; evidence?: Record<string, unknown> } =
        new Error('worker 已打开另一个文件：' + w.file + '（请求 ' + wanted + '）')
      e.code = 'worker_file_mismatch'
      e.fix = 'op=restart 带 file=<目标 .blend> 换干净进程，或换一个 session 名'
      e.evidence = { current_file: w.file, requested_file: wanted, worker: w.name }
      throw e
    }
    return workerSnapshot(w)
  }
  // 同一个 name 的并发/重试 start 共享一次启动：否则第二个会 SIGKILL 掉正在 boot 的进程，
  // 紧接着再 spawn 一个抢同一个端口（复测现场：反向 FAIL 回执诱导重试 → 端口撞车）。
  const inflight: Promise<Record<string, unknown>> | null | undefined = w.starting
  if (inflight) return Object.assign({}, await inflight, { joined: true })
  const task = launchWorker(ctx, w, opts)
  w.starting = task
  try {
    return await task
  } finally {
    if (w.starting === task) w.starting = null
  }
}

async function launchWorker(
  ctx: WorkersCtx,
  w: WorkerRecord,
  opts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 预检必须在 prepareBootFile 写盘与 spawn 之前：exe 为空时不再触发 Node 原始 TypeError。
  // P2-9：走 resolver —— 缓存路径在磁盘上不存在时（版本被卸载）先重探测一次，不必重启后端。
  const exe = resolveBlenderExe() || (BLENDER_EXE as string | null)
  assertBlenderExe(exe, blenderExeSource())
  if (w.child) {
    try {
      w.child.kill('SIGKILL')
    } catch (e) {}
    w.child = null
  }
  const port = Number(opts.port) || w.port
  const gpuMode = String(opts.gpu === undefined || opts.gpu === null ? 'auto' : opts.gpu)
  const engineMode = String(
    opts.engine === undefined || opts.engine === null ? 'eevee' : opts.engine,
  )
  const bootWin = prepareBootFile(ctx, w, opts)
  const fileWin =
    opts.file === undefined || opts.file === null ? null : String(opts.file).trim() || null
  const args = buildWorkerArgs(port, gpuMode, engineMode, bootWin, fileWin)
  const spawnOpts: SpawnOptions = {
    env: buildWorkerEnv(opts),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }
  const child: ChildProcess = spawn(exe as string, args, spawnOpts)
  w.child = child
  w.port = port
  w.ready = false
  w.startedAt = Date.now()
  w.gpu = null
  w.pid = child.pid ?? null
  w.lastError = null
  w.stdoutTail = ''
  w.stderrTail = ''
  const info = await waitWorkerReady(w, child, opts)
  const okRec = assertWorkerReady(w, child, info, exe as string | null)
  const okPid = typeof okRec.pid === 'number' ? okRec.pid : null
  w.ready = true
  w.gpu = okRec.gpu || null
  w.pid = okPid || child.pid || null
  w.boot = (info.ok && info.ok.boot) || null
  w.file = okRec.file === undefined || okRec.file === null ? fileWin : String(okRec.file)
  w.objects = typeof okRec.objects === 'number' ? okRec.objects : null
  w.lastUsed = Date.now()
  ctx.metrics.workerStarts++
  // 交互式 headless：首帧 Workbench 渲染有 ~1 s 的渲染器初始化（本机实测 first 1003ms / second 13ms）。
  // 在 start 时做一次极小 warmup（64×36），把这一秒付掉；之后每次 see 才是 10–40ms。
  let warm: Record<string, unknown> | null = null
  if (opts.warmup !== false) warm = await warmupWorker(w)
  return Object.assign(workerSnapshot(w), { hello: info.ok, warmup: warm })
}
