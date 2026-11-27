// Job argument construction for the default queue executor.
//
// This module turns declarative job parameters into Blender CLI arguments: the fixed
// render entry, the headless kernel prelude, `args`/`env` pass-through, path preflight
// and the `//` output resolution. Spawn/cancel/timeout stay in spawn-executor.ts.
import fs from 'node:fs'
import path from 'node:path'
import { CFG, IS_WIN, wslToWin } from '../../config.js'
import { KERNEL_BOOTSTRAP } from '../../foundation/kernel/bootstrap.js'
import { preloadChunk } from '../../foundation/kernel/api.js'
import { envPrelude, scriptFileBlock, workdirBlock } from '../../foundation/scripts.js'
import { inputPathBaseList, resolveExistingInput } from '../../execution/input-paths.js'
import { buildLocalOpJob } from '../../execution/local-op/index.js'
import { channelsPostlude } from '../../execution/render-channels.js'
import { headlessDevicePrelude, renderDevicePrelude } from '../../execution/render-device.js'
import type { JobRecord } from './types.js'

/** The Gateway workDir is probed writable at startup; never rely on %TEMP% for job files. */
export function workRoot(): string {
  return IS_WIN ? CFG.workDirWin : CFG.workDirWsl
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

// Relative job inputs: explicit workdir → caller session workspace → workspace env →
// Gateway cwd. `workspace` is sent by the tool layer because the three env vars are
// unset in the Gateway process on a default install (field report 3.2.0-alpha.1 P2).
function jobPathBases(params: Record<string, unknown>) {
  return inputPathBaseList(params.workdir, process.env, params.workspace)
}

export interface Prepared {
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
  // C-9：headless 以前不初始化 Cycles 设备，--factory-startup 下只会绑 CPU。
  // 每次 headless 都跑一遍设备前导（device=auto），回执里能看到 devices_used。
  parts.push(headlessDevicePrelude(params))
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

/**
 * 本地车道：把车道自带的 preload 模块并进调用方声明的清单（去重，pi 序不变）。
 * headlessPrelude 只认一个 preload 串，这里先合并 —— 未知名字仍在那边报错。
 */
function withPreloads(
  params: Record<string, unknown>,
  extra: readonly string[],
): Record<string, unknown> {
  const raw = params.preload
  const own = (Array.isArray(raw) ? raw.map(asString) : raw ? String(raw).split(',') : [])
    .map((m) => m.trim().replace(/\.py$/, ''))
    .filter(Boolean)
  for (const name of extra) if (!own.includes(name)) own.push(name)
  return { ...params, preload: own.join(',') }
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
  const lines = [
    'import bpy, json, os',
    // 无条件定义 s：旧实现只在 resolution 分支里定义，省略 resolution 时
    // 第一处 s.render.* 就抛 NameError，后续 engine/output 全部不执行
    // （实测落回 C:/tmp/0001.png）。这是 output 被静默忽略的一个根因。
    's=bpy.context.scene',
    '_dsh_engine_before = str(bpy.context.scene.render.engine)',
  ]
  const res = params.resolution
  if (Array.isArray(res) && res.length === 2)
    lines.push(
      's=bpy.context.scene',
      's.render.resolution_x=' + Number(res[0]),
      's.render.resolution_y=' + Number(res[1]),
      's.render.resolution_percentage=100',
    )
  if (params.engine) {
    // 实现来源：BlenderProject 探针 09:55–10:00 的临时 patch（非本仓库原有 WIP），
    // 本仓库在 Blender 5.3 上复测后接管。release 3.2.0-alpha.1 把 engine 赋值放在
    // output 之前：5.3 对 BLENDER_EEVEE_NEXT 抛 TypeError，整段 --python-expr 中断，
    // 后面的 s.render.filepath 也不执行，于是产物落回 C:/tmp/0001.png、作业仍 pass。
    // 这里做显式别名解析，并把 requested / applied / alias 三件事交给 DSH_RENDER。
    const engine = JSON.stringify(asString(params.engine))
    lines.push(
      '_dsh_engine_alias = None',
      '_dsh_engine_requested = ' + engine,
      'try:',
      '    s.render.engine = _dsh_engine_requested',
      'except TypeError:',
      '    _dsh_engine_alias = {"BLENDER_EEVEE_NEXT": "BLENDER_EEVEE", "BLENDER_EEVEE": "BLENDER_EEVEE_NEXT"}.get(_dsh_engine_requested)',
      '    if _dsh_engine_alias is None:',
      '        raise',
      '    s.render.engine = _dsh_engine_alias',
    )
  }
  // device / compute_device_type / samples：按**实际 engine** 落地（engine 省略时也能设 samples），
  // 并把实际后端打印成 DSH_RENDER，回执可见（P1：不再静默回落 CPU）。
  lines.push(renderDevicePrelude(params))
  if (params.format)
    lines.push('s.render.image_settings.file_format=' + JSON.stringify(asString(params.format)))
  if (params.output) {
    const out = asString(params.output)
    // 反馈 8-1: #### is Blender's frame placeholder. Appending a separator turned
    // it into a literal directory named "cyc_auto_####". Keep the template intact.
    const target =
      out.includes('#') || out.endsWith('/') || out.endsWith('\\') ? out : out + path.sep
    lines.push('s.render.filepath=' + JSON.stringify(target))
  }
  if (params.camera !== undefined) {
    const camera = params.camera
    if (camera === true) lines.push('pass')
    else lines.push('s.camera=bpy.data.objects.get(' + JSON.stringify(asString(camera)) + ')')
  }
  return lines.join('\n')
}

/**
 * Blender 的 `//` 是"相对当前 .blend 目录"的规范写法。Node 的 path.dirname('//x') 会得到 '//'，
 * ensureDir('//') 在 Windows 上会去 mkdir 'C:\\' 并报 EPERM（现场 P2，错误完全不含路径语义）。
 * 这里把它解析成绝对路径；没有 file 作基准时给出可读错误（host 层也会提前拒）。
 */
function resolveRenderOutput(output: string, file: string): string {
  if (!output.startsWith('//')) return output
  if (!file)
    throw new Error(
      'output 以 // 开头（Blender 相对 .blend 目录），但本次没有 file 可作基准；' +
        '请给绝对路径或同时给 file=<.blend>（本次没有启动 Blender）',
    )
  const rel = output.slice(2)
  const joined = path.join(path.dirname(file), rel)
  return output.endsWith('/') || output.endsWith('\\') ? joined + path.sep : joined
}

/** 输出目录创建失败时带上 output 原文：EPERM/mkdir 本身不含路径语义。 */
function ensureRenderDir(dir: string, output: string): void {
  try {
    ensureDir(dir)
  } catch (e) {
    throw new Error(
      'render 输出目录不可创建：' +
        dir +
        '（output=' +
        JSON.stringify(output) +
        '）：' +
        (e instanceof Error ? e.message : String(e)),
      { cause: e },
    )
  }
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
    // P2：// 是 Blender 的相对 .blend 目录语义，先解析成绝对路径再算 outdir / mkdir。
    let output = resolveRenderOutput(asString(params.output), file)
    // A render without an explicit output still needs a persistent, writable place:
    // Blender's own fallback (C:/tmp on Windows) is not writable in every install.
    if (!output) {
      outdir = outdir || path.join(workRoot(), 'renders', job.id)
      ensureRenderDir(outdir, output)
      output = outdir.endsWith('/') || outdir.endsWith('\\') ? outdir : outdir + path.sep
    } else if (!outdir) {
      // A frame template (".../cyc_auto_####") writes into the directory before the
      // first placeholder; path.dirname() on the template itself would name the
      // literal "####" directory and the artifact scan would find nothing.
      const trimmed = output.replace(/[\\/]+$/, '')
      const hashAt = trimmed.indexOf('#')
      const base = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed
      const dir = path.dirname(base.endsWith('/') || base.endsWith('\\') ? base.slice(0, -1) : base)
      outdir = dir === '.' || dir === '' ? workRoot() : dir
      ensureRenderDir(outdir, output)
    }
    const renderParams = { ...params, output }
    args.push('-b', '--factory-startup', '--python-expr', renderPrelude(renderParams))
    const frames = frameRange(params)
    if (frames) args.push('-s', String(frames.start), '-e', String(frames.end), '-a')
    // render channels：-a 之后追加一次 numpy 收尾（没传 channels 时一个参数都不加）
    args.push(...channelsPostlude(renderParams, outdir))
    if (output && !output.endsWith('/') && !output.endsWith('\\'))
      ensureRenderDir(path.dirname(output), output)
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
  // 无 GUI 本地车道：catalog_op 由 runtime/execution/local-op 生成脚本 + preload 清单
  const localOp = params.catalog_op ? buildLocalOpJob(params) : null
  const script = localOp ? localOp.script : asString(params.script)
  const rawScriptFile = asString(params.script_file)
  // 脚本路径同样先解析再写进 job.py（_dsh_target 与 prelude 用同一个绝对路径）
  const scriptFile = rawScriptFile
    ? resolveExistingInput(rawScriptFile, jobPathBases(params), 'script_file')
    : rawScriptFile
  const prelude = headlessPrelude(
    localOp === null ? params : withPreloads(params, localOp.preloads),
    env,
  )
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
  // C-10：调用方的 args 先占位（文档说的就是"进 -- 之后"），outdir 放最后 ——
  // 以前 outdir 是第 0 位，脚本按 isdigit 取参数会先吃到目录名。
  args.push('--')
  args.push(...argsTail)
  if (outdir) args.push(outdir)
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
