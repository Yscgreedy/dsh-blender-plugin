/**
 * blender.exe 的**运行时**解析（P2-9）。
 *
 * 为什么要单独一层：config.ts 里 CFG.blenderExe 是模块加载时**一次算好**的常量。本机曾同时装了
 * Blender 5.2 与 5.3，5.2 被卸载后后端仍拿缓存路径 spawn → `spawn ...Blender 5.2\blender.exe ENOENT`，
 * 而 GUI 里跑的却是 5.3.0；两条通道不是同一个 Blender，且这个差异完全静默。
 *
 * 这里补三件事：
 *   ① 每次需要 spawn 时调用 resolveBlenderExe()：缓存路径**不在磁盘上**就立刻重探测（不必重启后端）；
 *   ② blenderExeInfo() 给 /status 与 doctor 用：实际 exe + 从哪来 + 版本 + 是否 stale；
 *   ③ 版本优先从安装目录名解析（Blender 5.3 → 5.3），解析不到才试探一次 `--version`（带缓存）。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { CFG, detectBlenderNow } from './config.js'

export interface BlenderExeInfo {
  exe: string | null
  from: string
  version: string | null
  versionFrom: 'path' | 'probe' | null
  exists: boolean
  stale: boolean
  previous: string | null
  changedAt: number | null
  note: string
}

interface State {
  exe: string | null
  from: string
  version: string | null
  versionFrom: 'path' | 'probe' | null
  previous: string | null
  changedAt: number | null
}

function existsSafe(p: string | null | undefined): boolean {
  if (!p) return false
  try {
    return fs.existsSync(p)
  } catch (e) {
    return false
  }
}

/** 从路径里取版本：`.../Blender 5.3/blender.exe` → 5.3；`/Applications/Blender.app` → null。 */
export function versionFromPath(exe: string | null): string | null {
  if (!exe) return null
  const s = String(exe).replace(/\\/g, '/')
  const segs = s.split('/').filter(Boolean)
  for (const seg of segs.reverse()) {
    if (!/blender/i.test(seg)) continue
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(seg)
    if (m) return [m[1], m[2], m[3]].filter((x) => x !== undefined).join('.')
  }
  return null
}

const probeMemo = new Map<string, string | null>()

/** 探测版（只在路径里没有版本号时才跑，结果按 exe 缓存；失败记 null 不重试）。 */
export function probeBlenderVersion(exe: string | null): string | null {
  if (!exe) return null
  if (probeMemo.has(exe)) return probeMemo.get(exe) as string | null
  let v: string | null = null
  try {
    const out = execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/i.exec(String(out))
    v = m ? m[1] : null
  } catch {
    // 保持 null：try 与 catch 都赋值会让 exe 上方的初始化变成死赋值（no-useless-assignment）
  }
  probeMemo.set(exe, v)
  return v
}

function makeState(exe: string | null, from: string, previous: string | null): State {
  const vp = versionFromPath(exe)
  return {
    exe: exe,
    from: from,
    version: vp || probeBlenderVersion(exe),
    versionFrom: vp ? 'path' : vp === null && probeBlenderVersion(exe) ? 'probe' : null,
    previous: previous,
    changedAt: previous !== exe ? Date.now() : null,
  }
}

let state: State = makeState(CFG.blenderExe ?? null, CFG.source?.blenderExe ?? 'unknown', null)

/** 强制重探测一次（本机安装变了 / spawn ENOENT 后）。 */
export function refreshBlenderExe(reason = 'manual'): BlenderExeInfo {
  const prev = state.exe
  const d = detectBlenderNow()
  if (d.exe) {
    state = makeState(d.exe, d.from + (reason === 'manual' ? '' : ':' + reason), prev)
  } else {
    // 一个都没探测到：保留旧值（行为与修复前一致），但把 stale 标出来，别假装没事
    state = Object.assign({}, state, { previous: prev })
  }
  return blenderExeInfo()
}

/**
 * 取当前可用的 blender.exe：
 *   · 缓存路径存在 → 直接返回；
 *   · 缓存路径**不在**（版本被卸载/盘符变了）→ 重探测一次再返回（无需重启后端）。
 */
export function resolveBlenderExe(): string | null {
  if (existsSafe(state.exe)) return state.exe
  if (!state.exe) {
    const d = detectBlenderNow()
    if (d.exe) state = makeState(d.exe, d.from, null)
    return state.exe
  }
  const r = refreshBlenderExe('missing')
  return r.exe
}

/** 给 /status、doctor 用：实际用的 exe + 来源 + 版本 + 是否 stale。 */
export function blenderExeInfo(): BlenderExeInfo {
  const exe = state.exe
  const exists = existsSafe(exe)
  const vp = versionFromPath(exe)
  if (vp && vp !== state.version) {
    state.version = vp
    state.versionFrom = 'path'
  }
  return {
    exe: exe,
    from: state.from,
    version: state.version,
    versionFrom: state.versionFrom,
    exists: exists,
    stale: !exists,
    previous: state.previous,
    changedAt: state.changedAt,
    note: !exists
      ? '缓存的 blender.exe 不在磁盘上：下次 spawn 会自动重探测（或设 DSH_BLENDER_EXE）'
      : '这是真正被 spawn 的可执行文件；与 GUI Blender 版本不一致时先看这里',
  }
}
