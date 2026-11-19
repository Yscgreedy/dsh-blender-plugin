// Default queue executor: spawn one fresh Blender process per job.
//
// The queue never executes job work in the Gateway process. This module only
// turns declarative parameters into Blender CLI arguments, captures the logs,
// and terminates the exact process tree on cancel or timeout.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CFG, IS_WIN, wslToWin } from '../../config.js'
import { BLENDER_EXE } from '../../paths.js'
import { KERNEL_BOOTSTRAP } from '../kernel/bootstrap.js'
import { preloadChunk } from '../kernel/api.js'
import { envPrelude, scriptFileBlock, workdirBlock } from '../scripts.js'
import { isRecord } from '../json.js'
import { inputPathBaseList, resolveExistingInput } from '../../execution/input-paths.js'
import type { JobExecutionResult, JobExecutor, JobHandle, JobRecord } from './types.js'

export interface SpawnExecutorOptions {
  blenderExe?: string
  now?: () => number
  tempRoot?: string
  spawnImpl?: typeof spawn
}

const MAX_LOG = 262144
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** The Gateway workDir is probed writable at startup; never rely on %TEMP% for job files. */
function workRoot(): string {
  return IS_WIN ? CFG.workDirWin : CFG.workDirWsl
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

// Relative job inputs: explicit workdir → caller session workspace → workspace env →
// Gateway cwd. `workspace` is sent by the tool layer because the three env vars are
// unset in the Gateway process on a default install (field report 3.2.0-alpha.1 P2).
function jobPathBases(params: Record<string, unknown>) {
  return inputPathBaseList(params.workdir, process.env, params.workspace)
}

interface Prepared {
  args: string[]
  tempDir: string | null
  outdir: string | null
  env: Record<string, string>
  argsTail: string[]
  envKeys: string[]
  preloads: string[]
  bootstrap: boolean
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * args 透传（R4 / 2026-11-17 消费方需求）：schema 收 string | string[]，两条路都真的到 sys.argv。
 *
 * 现场：schema 声明 string、实现只认 Array.isArray ⇒ 字符串 100% 静默丢失（ARGV_TAIL []）。
 * 这里做 POSIX 风格分词（空白分隔 + 单/双引号 + 双引号内反斜杠转义），空串丢弃。
 */
export function splitArgs(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        cur += raw[++i]
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        out.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started || cur) out.push(cur)
  return out
}

export function normalizeArgs(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(asString)
  if (typeof value === 'string') return splitArgs(value)
  throw new Error('args 只认 string | string[]（收到 ' + typeof value + '）')
}

export function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'env 只认对象 {KEY:"VALUE"}（收到 ' + (Array.isArray(value) ? 'array' : typeof value) + '）',
    )
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue
    out[String(key)] = String(raw)
  }
  return out
}

/**
 * headless 前导（R3 / 2026-11-17 消费方需求）：与 GUI 同源的内核 K。
 *
 * 现场：blender_run(kind=headless, preload="geo", bootstrap=true) 跑出来 K_like=[]，
 * K.dsh_geo_api 直接 NameError —— 队列执行器只拼了 -b --python，从没注入 KERNEL_BOOTSTRAP。
 * 这里按 GUI 的同一份源码注入：bootstrap（默认开）+ preload 模块（各自命名空间）+ workdir。
 * preload 名不存在时立刻抛错（job_prepare_failed），不让脚本跑到一半才 NameError。
 */
function headlessPrelude(
  params: Record<string, unknown>,
  envPairs: Record<string, string>,
): { code: string; preloads: string[]; bootstrap: boolean } {
  const parts: string[] = [envPrelude(envPairs)]
  const bootstrap = params.bootstrap !== false
  if (bootstrap) parts.push(KERNEL_BOOTSTRAP)
  const raw = params.preload
  const mods = (Array.isArray(raw) ? raw.map(asString) : raw ? String(raw).split(',') : [])
    .map((m) => m.trim().replace(/\.py$/, ''))
    .filter(Boolean)
  for (const name of mods) {
    try {
      parts.push(preloadChunk(name))
    } catch (e) {
      throw new Error(
        'preload 模块不可用：' +
          name +
          '（' +
          (e instanceof Error ? e.message : String(e)) +
          '）—— 用 runtime/py/modules.json 里的模块名，例如 preload="geo,audit"',
        { cause: e },
      )
    }
  }
  if (params.workdir) parts.push(workdirBlock(String(params.workdir)))
  if (params.script_file)
    parts.push(
      scriptFileBlock(
        resolveExistingInput(String(params.script_file), jobPathBases(params), 'script_file'),
      ),
    )
  return { code: parts.filter(Boolean).join('\n'), preloads: mods, bootstrap }
}

function frameRange(params: Record<string, unknown>): { start: number; end: number } | null {
  const raw = params.frames
  if (Array.isArray(raw) && raw.length === 2) return { start: Number(raw[0]), end: Number(raw[1]) }
  if (typeof raw === 'string' && raw.includes('-')) {
    const [a, b] = raw.split('-')
    if (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))
      return { start: Number(a), end: Number(b) }
  }
  if (raw !== undefined && raw !== null) {
    const n = Number(raw)
    if (Number.isFinite(n)) return { start: n, end: n }
  }
  return null
}

/** A fixed internal Python entry for render parameters: no caller script is ever accepted. */
function renderPrelude(params: Record<string, unknown>): string {
  const lines = ['import bpy, json, os']
  const res = params.resolution
  if (Array.isArray(res) && res.length === 2)
    lines.push(
      's=bpy.context.scene',
      's.render.resolution_x=' + Number(res[0]),
      's.render.resolution_y=' + Number(res[1]),
      's.render.resolution_percentage=100',
    )
  if (params.engine) lines.push('s.render.engine=' + JSON.stringify(asString(params.engine)))
  if (params.samples !== undefined) {
    const samples = Math.max(1, Number(params.samples) || 1)
    const engine = asString(params.engine)
    if (engine === 'CYCLES') lines.push('s.cycles.samples=' + samples)
    else if (engine === 'BLENDER_EEVEE_NEXT' || engine === 'BLENDER_EEVEE')
      lines.push('s.eevee.taa_render_samples=' + samples)
  }
  if (params.format)
    lines.push('s.render.image_settings.file_format=' + JSON.stringify(asString(params.format)))
  if (params.output) {
    const out = asString(params.output)
    const target = out.endsWith('/') || out.endsWith('\\') ? out : out + path.sep
    lines.push('s.render.filepath=' + JSON.stringify(target))
  }
  if (params.camera !== undefined) {
    const camera = params.camera
    if (camera === true) lines.push('pass')
    else lines.push('s.camera=bpy.data.objects.get(' + JSON.stringify(asString(camera)) + ')')
  }
  return lines.join('\n')
}

/** Exported for contract tests: render and headless use one fixed internal entry. */
export interface BuiltJobArgs {
  args: string[]
  outdir: string | null
  env: Record<string, string>
  argsTail: string[]
  envKeys: string[]
  preloads: string[]
  bootstrap: boolean
}

export function buildJobArgs(job: JobRecord, tempDir: string): BuiltJobArgs {
  const params = job.params
  let outdir = asString(params.outdir) || null
  if (outdir) ensureDir(outdir)
  const argsTail = job.kind === 'headless' ? normalizeArgs(params.args) : []
  const customEnv = job.kind === 'headless' ? normalizeEnv(params.env) : {}
  const env: Record<string, string> = {
    ...customEnv,
    DSH_ARGS: JSON.stringify(argsTail),
    DSH_ENV_KEYS: JSON.stringify(Object.keys(customEnv)),
  }
  if (job.kind === 'render') {
    const rawFile = asString(params.file)
    const file = rawFile ? resolveExistingInput(rawFile, jobPathBases(params), 'file') : rawFile
    const args: string[] = []
    if (file) args.push(wslToWin(file))
    let output = asString(params.output)
    // A render without an explicit output still needs a persistent, writable place:
    // Blender's own fallback (C:/tmp on Windows) is not writable in every install.
    if (!output) {
      outdir = outdir || path.join(workRoot(), 'renders', job.id)
      ensureDir(outdir)
      output = outdir.endsWith('/') || outdir.endsWith('\\') ? outdir : outdir + path.sep
    } else if (!outdir) {
      const trimmed = output.replace(/[\\/]+$/, '')
      outdir = path.dirname(trimmed)
      ensureDir(outdir)
    }
    const renderParams = { ...params, output }
    args.push('-b', '--factory-startup', '--python-expr', renderPrelude(renderParams))
    const frames = frameRange(params)
    if (frames) args.push('-s', String(frames.start), '-e', String(frames.end), '-a')
    if (output && !output.endsWith('/') && !output.endsWith('\\')) ensureDir(path.dirname(output))
    return {
      args,
      outdir,
      env,
      argsTail,
      envKeys: Object.keys(customEnv),
      preloads: [],
      bootstrap: false,
    }
  }
  // 痛点2：.blend 也必须在起进程之前存在。旧行为是把相对路径原样交给 Blender，
  // 等它报 "Cannot read file" —— 一次 1.3 s 的进程白烧，而且回执只说 Blender exit 1。
  const rawFile = asString(params.file)
  const file = rawFile ? resolveExistingInput(rawFile, jobPathBases(params), 'file') : rawFile
  const args: string[] = []
  if (file) args.push(wslToWin(file))
  args.push('-b')
  if (params.factory_startup !== false) args.push('--factory-startup')
  const script = asString(params.script)
  const rawScriptFile = asString(params.script_file)
  // 脚本路径同样先解析再写进 job.py（_dsh_target 与 prelude 用同一个绝对路径）
  const scriptFile = rawScriptFile
    ? resolveExistingInput(rawScriptFile, jobPathBases(params), 'script_file')
    : rawScriptFile
  const prelude = headlessPrelude(params, env)
  if (script) {
    const scriptPath = path.join(tempDir, 'job.py')
    const body = prelude.code ? prelude.code + '\n' + script : script
    fs.writeFileSync(scriptPath, body, 'utf8')
    args.push('--python', scriptPath)
  } else if (scriptFile) {
    // 实测：Blender 的每个 --python 文件各跑各的命名空间 —— 用两个 --python 时
    // 第二个脚本里看不到 prelude 注入的 K（USER_FILE_PRESENT False）。
    // 所以把 prelude + exec(用户脚本) 合成一个 job.py：K 在 globals() 里，__file__ 仍是用户的文件。
    const scriptPath = path.join(tempDir, 'job.py')
    const lines = [
      prelude.code,
      'import os as _dsh_os, sys as _dsh_sys',
      '_dsh_target = ' + JSON.stringify(scriptFile),
      'try:',
      '    _dsh_target = K.win_path(_dsh_target)',
      'except Exception:',
      '    pass',
      '__file__ = _dsh_target',
      '_dsh_dir = _dsh_os.path.dirname(_dsh_target)',
      'if _dsh_dir and _dsh_dir not in _dsh_sys.path:',
      '    _dsh_sys.path.insert(0, _dsh_dir)',
      'with open(_dsh_target, encoding="utf-8") as _dsh_fh:',
      '    _dsh_src = _dsh_fh.read()',
      'exec(compile(_dsh_src, _dsh_target, "exec"), globals())',
    ].filter(Boolean)
    fs.writeFileSync(scriptPath, lines.join('\n') + '\n', 'utf8')
    args.push('--python', scriptPath)
  }
  args.push('--')
  if (outdir) args.push(outdir)
  args.push(...argsTail)
  return {
    args,
    outdir,
    env,
    argsTail,
    envKeys: Object.keys(customEnv),
    preloads: prelude.preloads,
    bootstrap: prelude.bootstrap,
  }
}

function prepare(job: JobRecord, spawnOptions: SpawnExecutorOptions): Prepared {
  const tempRoot = spawnOptions.tempRoot || path.join(workRoot(), 'tmp')
  ensureDir(tempRoot)
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'dsh-job-'))
  const built = buildJobArgs(job, tempDir)
  return { ...built, tempDir }
}

function prepareFailure(
  e: unknown,
  blenderExe: string | null,
  code: 'blender_exe_missing' | 'job_prepare_failed' = 'blender_exe_missing',
): JobExecutionResult {
  const reason = e instanceof Error ? e.message : String(e)
  // input_missing 的 tried / bases 是"到底按哪些根找过"的唯一证据，不能在这里丢掉。
  const rawEvidence = (e as { evidence?: unknown } | null | undefined)?.evidence
  const detail = isRecord(rawEvidence) ? rawEvidence : {}
  const evidence = Object.keys(detail).length ? { blenderExe, ...detail } : { blenderExe }
  if (code === 'job_prepare_failed')
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: reason,
      error: {
        ok: false,
        code,
        stage: 'spawn',
        root_cause: 'Could not prepare the Blender job: ' + reason,
        fix: 'Fix the reported cause (preload module name, args/env type), then resubmit.',
        fallback: { kind: 'unavailable', summary: 'fix the job parameters and resubmit' },
        evidence,
      },
    }
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: reason,
    error: {
      ok: false,
      code,
      stage: 'spawn',
      root_cause: 'Could not start Blender: ' + reason,
      fix: 'Set DSH_BLENDER_EXE or write dsh-blender.config.json with blenderExe.',
      fallback: { kind: 'unavailable', summary: 'install Blender or set DSH_BLENDER_EXE' },
      evidence: { blenderExe },
    },
  }
}

function artifactsIn(outdir: string | null, since: number): string[] {
  if (!outdir) return []
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length >= 100) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 100) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else {
        try {
          if (fs.statSync(full).mtimeMs >= since) found.push(full)
        } catch {
          /* a file may disappear while collecting */
        }
      }
    }
  }
  walk(outdir, 0)
  return found
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (IS_WIN) {
    try {
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already exited */
    }
  }
}

function spawnBlender(opts: SpawnExecutorOptions, prepared: Prepared, jobId: string): ChildProcess {
  return (opts.spawnImpl || spawn)(opts.blenderExe || (BLENDER_EXE as string), prepared.args, {
    env: { ...process.env, ...prepared.env, DSH_JOB_ID: jobId },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !IS_WIN,
  })
}

function captureLogs(child: ChildProcess): { stdout: string; stderr: string } {
  const logs = { stdout: '', stderr: '' }
  child.stdout?.on('data', (buf: Buffer) => {
    logs.stdout = (logs.stdout + buf.toString('utf8')).slice(-MAX_LOG)
  })
  child.stderr?.on('data', (buf: Buffer) => {
    logs.stderr = (logs.stderr + buf.toString('utf8')).slice(-MAX_LOG)
  })
  return logs
}

function armTimeout(child: ChildProcess, timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
  const timer = setTimeout(
    () => {
      onTimeout()
      killTree(child)
    },
    Math.max(1000, timeoutMs),
  )
  timer.unref?.()
  return timer
}

function parseHeadless(text: string): unknown {
  const matches = text.match(/^HEADLESS (\{.*\})$/gm)
  if (!matches || matches.length === 0) return undefined
  const last = matches[matches.length - 1].slice('HEADLESS '.length)
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

export class SpawnJobExecutor implements JobExecutor {
  private readonly opts: SpawnExecutorOptions
  constructor(opts: SpawnExecutorOptions = {}) {
    this.opts = opts
  }

  start(job: JobRecord): JobHandle {
    let prepared: Prepared
    try {
      prepared = prepare(job, this.opts)
    } catch (e) {
      return {
        pid: null,
        cancel: () => {},
        done: Promise.resolve(
          prepareFailure(e, this.opts.blenderExe || BLENDER_EXE, 'job_prepare_failed'),
        ),
      }
    }
    let child: ChildProcess
    try {
      child = spawnBlender(this.opts, prepared, job.id)
    } catch (e) {
      return {
        pid: null,
        cancel: () => {},
        done: Promise.resolve(prepareFailure(e, this.opts.blenderExe || BLENDER_EXE)),
      }
    }
    const started = (this.opts.now || Date.now)()
    const logs = captureLogs(child)
    let timedOut = false
    const timeoutMs = Number(job.params.timeout_ms) || DEFAULT_TIMEOUT_MS
    const timer = armTimeout(child, timeoutMs, () => {
      timedOut = true
    })
    const done = new Promise<JobExecutionResult>((resolve) => {
      let settled = false
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (prepared.tempDir) {
          try {
            fs.rmSync(prepared.tempDir, { recursive: true, force: true })
          } catch {
            /* temp cleanup is best effort */
          }
        }
        const parsed = job.kind === 'headless' ? parseHeadless(logs.stdout) : undefined
        resolve({
          exitCode,
          signal,
          stdout: logs.stdout,
          stderr: logs.stderr,
          artifacts: artifactsIn(prepared.outdir, started),
          ...(parsed === undefined ? {} : { parsed }),
          provenance: {
            args: prepared.argsTail,
            env: Object.keys(prepared.env).sort(),
            env_keys: prepared.envKeys,
            preloads: prepared.preloads,
            bootstrap: prepared.bootstrap,
          },
          ...(timedOut
            ? {
                error: {
                  ok: false,
                  code: 'job_timeout',
                  stage: 'render' as const,
                  root_cause: 'The job exceeded its timeout.',
                  fix: 'Raise timeout_ms or reduce the workload, then resubmit.',
                  fallback: {
                    kind: 'unavailable' as const,
                    summary: 'resubmit with a larger timeout',
                  },
                  evidence: { timeoutMs },
                },
              }
            : {}),
        })
      }
      child.once('error', (e) => {
        clearTimeout(timer)
        settled = true
        resolve(prepareFailure(e, this.opts.blenderExe || BLENDER_EXE))
      })
      child.once('close', (code, signal) => finish(code, signal ? String(signal) : null))
    })
    return { pid: child.pid ?? null, cancel: () => killTree(child), done }
  }
}
