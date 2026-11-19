// Input-path preflight for headless runs and jobs （痛点2）.
//
// Field report: blender_run(kind=headless, script_file="out/x/step1.py") was
// resolved against the Gateway process cwd (the DSH profile directory), so a
// correct workspace-relative path died as FileNotFoundError — and file= (.blend)
// was not checked at all, so Blender started first and only then refused the
// missing file. Both are now resolved and checked here, before any process is
// spawned, and the failure lists every base that was tried.
//
// Second field report (3.2.0-alpha.1 复测): the workspace *env* tier was empty on
// this host (DSH_BLENDER_WORKSPACE / DSH_WORKSPACE / DSH_PROJECT_DIR are unset in
// the Gateway process), so every relative input silently landed in the profile
// directory. The caller-owned root is now passed in explicitly as `workspace`
// (the tool layer takes it from the calling session), and each candidate keeps the
// tier that produced it so a receipt can say which root was used.
import fs from 'node:fs'
import path from 'node:path'
import { winToWsl } from '../config.js'

/** Env vars that may carry the workspace root, in priority order. */
const WORKSPACE_ENV = ['DSH_BLENDER_WORKSPACE', 'DSH_WORKSPACE', 'DSH_PROJECT_DIR']

/** One root a relative input may hang off, plus the tier that produced it. */
export interface InputPathBase {
  /** Absolute host path (WSL form when the host is WSL). */
  path: string
  /** workdir | session-workspace | env:NAME | gateway-cwd */
  source: string
}

/** Absolute on either platform (Windows drive, UNC, or POSIX root). */
export function isAbsoluteInput(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\' || p.startsWith('/')
}

/**
 * Host-side absolute bases a relative input may hang off, in priority order:
 * explicit workdir → caller session workspace → workspace env → Gateway cwd.
 * Entries keep their tier so receipts and `input_missing` evidence can name it.
 */
export function inputPathBaseList(
  workdir?: unknown,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: unknown,
): InputPathBase[] {
  const out: InputPathBase[] = []
  const push = (value: unknown, source: string): void => {
    const s = String(value == null ? '' : value).trim()
    if (!s || !isAbsoluteInput(s)) return
    const host = winToWsl(s)
    if (!host || out.some((b) => b.path === host)) return
    out.push({ path: host, source })
  }
  push(workdir, 'workdir')
  push(workspace, 'session-workspace')
  for (const key of WORKSPACE_ENV) push(env[key], 'env:' + key)
  push(process.cwd(), 'gateway-cwd')
  return out
}

/** The same list as plain paths (older call sites and tests). */
export function inputPathBases(
  workdir?: unknown,
  env: NodeJS.ProcessEnv = process.env,
  workspace?: unknown,
): string[] {
  return inputPathBaseList(workdir, env, workspace).map((b) => b.path)
}

export interface InputPathMissing extends Error {
  code: 'input_missing'
  stage: 'config'
  fix: string
  evidence: Record<string, unknown>
}

function isLabelled(b: string | InputPathBase): b is InputPathBase {
  return typeof b !== 'string'
}

function missing(
  given: string,
  bases: Array<string | InputPathBase>,
  what: string,
  candidates?: string[],
): InputPathMissing {
  const tried =
    candidates && candidates.length ? candidates : bases.map((b) => (isLabelled(b) ? b.path : b))
  const labelled = bases.filter(isLabelled).map((b) => ({ path: b.path, source: b.source }))
  const e = new Error(
    what +
      ' 不存在：' +
      given +
      '（相对路径已按 workdir → 会话工作区 → 工作区 env → Gateway cwd 依次尝试）',
  ) as unknown as InputPathMissing
  e.code = 'input_missing'
  e.stage = 'config'
  e.fix =
    '给绝对路径（D:\\work\\x\\s.py），或先传 workdir=<工作区根> 再给相对路径；' +
    '本次没有启动 Blender 进程。'
  e.evidence = { what, given, tried, bases: labelled }
  return e
}

/**
 * Resolve an input that must already exist. Relative paths are tried against
 * every base; nothing is spawned when this throws.
 */
export function resolveExistingInput(
  given: string,
  bases: Array<string | InputPathBase>,
  what: string,
): string {
  const raw = String(given == null ? '' : given).trim()
  if (!raw) throw missing(raw, bases, what)
  if (isAbsoluteInput(raw)) {
    const host = winToWsl(raw)
    if (!fs.existsSync(host)) throw missing(raw, [host], what)
    return raw
  }
  const tried: string[] = []
  for (const base of bases) {
    const root = isLabelled(base) ? base.path : base
    if (!root) continue
    const candidate = path.join(root, raw)
    tried.push(candidate)
    if (fs.existsSync(candidate)) return candidate
  }
  throw missing(raw, bases, what, tried)
}
