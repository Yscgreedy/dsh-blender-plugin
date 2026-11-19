/**
 * Session workspace roots for path absolutization.
 *
 * Field report 3.2.0-alpha.1（P2）：blender_run 的相对 script_file / file 被按
 * **宿主进程 cwd** 绝对化，而宿主进程 cwd 是 DSH profile（C:\Users\…\.dsh\profiles\desktop），
 * 不是调用方的会话工作区；DSH_BLENDER_WORKSPACE / DSH_WORKSPACE / DSH_PROJECT_DIR 在这台机器上
 * 一个都没设，所以"工作区环境变量"那一档等于不存在，相对路径静默落到 profile 目录。
 *
 * 权威来源在调用现场（tool execute 的 exec.agent.session）：
 *   ① workingDirectory 服务（用户 cd 之后跟着变）—— 有就用它；
 *   ② Session header 的 cwd（会话创建时的工作区）—— 服务没挂载时的兜底；
 *   ③ 工作区 env（旧档位，保留兼容）；
 *   ④ 宿主进程 cwd —— 最后一档，回执里必须**点名**这是回落。
 */
import fs from 'node:fs'
import path from 'node:path'
import { asRecord, text } from '../contracts/dynamic.js'

/** Where one root came from; the receipt quotes this instead of guessing. */
export type WorkspaceSource =
  | 'working-directory'
  | 'session-cwd'
  | 'env:DSH_BLENDER_WORKSPACE'
  | 'env:DSH_WORKSPACE'
  | 'env:DSH_PROJECT_DIR'
  | 'host-cwd'

export interface WorkspaceRoot {
  path: string
  source: WorkspaceSource
}

export interface WorkspaceView {
  roots: WorkspaceRoot[]
  /** True when a caller-owned root (session service / header / env) was found. */
  detected: boolean
}

interface WorkingDirectoryLike {
  get: (session: unknown) => unknown
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\' || p.startsWith('/')
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The session a tool call runs for: exec.agent.session (nested exec also carries it). */
export function callerSession(exec: unknown): unknown {
  const e = asRecord(exec)
  const agent = asRecord(e.agent)
  return agent.session !== undefined ? agent.session : e.session
}

/**
 * The host working-directory service, when the profile mounts it.
 *
 * The property read itself is guarded: a Cordis context is a proxy whose service
 * getters may throw when the service was not injected into this plugin.
 */
function workingDirectoryService(ctx: unknown): WorkingDirectoryLike | null {
  if (ctx === undefined || ctx === null || typeof ctx !== 'object') return null
  let candidate: unknown
  try {
    candidate = (ctx as Record<string, unknown>).workingDirectory
  } catch {
    return null
  }
  if (!candidate || typeof candidate !== 'object') return null
  const get = (candidate as { get?: unknown }).get
  return typeof get === 'function' ? (candidate as unknown as WorkingDirectoryLike) : null
}

function serviceDirectory(ctx: unknown, session: unknown): string {
  const service = workingDirectoryService(ctx)
  if (!service || session === undefined || session === null) return ''
  try {
    return text(service.get(session)).trim()
  } catch {
    return ''
  }
}

function headerDirectory(session: unknown): string {
  const s = asRecord(session)
  const header = asRecord(s.header)
  return text(header.cwd || s.cwd).trim()
}

/**
 * Absolute roots a relative input may hang off, highest priority first.
 * Nonexistent directories are dropped (a stale header must not hide the real root).
 */
export function workspaceRoots(
  exec: unknown,
  ctx?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceView {
  const session = callerSession(exec)
  const roots: WorkspaceRoot[] = []
  const push = (value: unknown, source: WorkspaceSource): void => {
    const raw = text(value).trim()
    if (!raw || !isAbsolutePath(raw)) return
    const resolved = path.resolve(raw)
    if (roots.some((r) => r.path === resolved)) return
    if (!isDirectory(resolved)) return
    roots.push({ path: resolved, source })
  }
  push(serviceDirectory(ctx, session), 'working-directory')
  push(headerDirectory(session), 'session-cwd')
  push(env.DSH_BLENDER_WORKSPACE, 'env:DSH_BLENDER_WORKSPACE')
  push(env.DSH_WORKSPACE, 'env:DSH_WORKSPACE')
  push(env.DSH_PROJECT_DIR, 'env:DSH_PROJECT_DIR')
  const callerOwned = roots.length > 0
  push(process.cwd(), 'host-cwd')
  return { roots, detected: callerOwned }
}

/** The root the backend should use for its own relative resolution, if caller-owned. */
export function workspacePayload(view: WorkspaceView): string | null {
  const first = view.roots[0]
  if (!first || first.source === 'host-cwd') return null
  return first.path
}

/**
 * One receipt line naming the base actually used — and saying so out loud when the
 * only root was the host cwd, because that is exactly the trap being fixed.
 */
export function workspaceNote(view: WorkspaceView, usedBase?: string | null): string {
  const first = view.roots[0]
  if (!first) {
    return 'path_base: 无（也没有可用的宿主 cwd）—— 相对路径必须配 workdir=<工作区根>'
  }
  if (first.source === 'host-cwd') {
    return (
      'path_base: ' +
      first.path +
      '（**回落**：未检测到会话工作区根 —— workingDirectory 服务不可用、Session 无 cwd、' +
      'DSH_BLENDER_WORKSPACE/DSH_WORKSPACE/DSH_PROJECT_DIR 也都没设；这是宿主进程 cwd，通常是 DSH profile 目录）' +
      '；相对输入请显式传 workdir=<工作区根>'
    )
  }
  const base = usedBase || first.path
  return 'path_base: ' + base + '（来源 ' + first.source + '）'
}
