/**
 * 工单 11：bpy_api_lookup 的**无头探针**（GUI 在线也能走；force_headless 显式强制）。
 *
 * 为什么需要：addon 的 bpy_api_lookup 只能在 GUI 会话里跑；没有 Blender 或用户不想开 GUI 时，
 * 模型只能猜 API。这里用 **同一个热 worker 进程**（session=bpy-api-probe）在 blender -b 里直接
 * 复用 addon 的同一份查表实现（extension/.../commands/core/{describe,bpy_lookup}.py），
 * 连发 N 次只起 1 个进程，结果按 query 做短缓存。
 *
 * evidence（结构化，进工具信封）：
 *   source: "headless" · blender_version · cache_age（秒）· hits[] · degraded
 *   probe: {blender_exe, elapsed_ms, reused, worker_pid}
 *   drift: {expected, actual, level:"warn", message} | null
 *
 * version_fixture 只在测试注入时覆盖"用于比较的实测版本"，不进产品默认路径。
 */
import path from 'node:path'
import { PKG_ROOT } from '../config.js'
import { blenderExeInfo } from '../blender-exe.js'

export const HEADLESS_WORKER = 'bpy-api-probe'
const CACHE_TTL_MS = 5 * 60 * 1000

export interface Drift {
  expected: string
  actual: string
  level: 'warn'
  /** 实测版本来源：exe=真实探针；fixture=测试注入。 */
  source: 'fixture' | 'exe'
  message: string
}

export interface ProbeEvidence {
  ok: boolean
  source: 'headless'
  query: string
  blender_version: string | null
  cache_age: number
  hits: unknown[]
  degraded: boolean
  error: string | null
  drift: Drift | null
  version_source: 'observed' | 'fixture'
  probe: {
    blender_exe: string | null
    elapsed_ms: number
    reused: boolean
    worker_pid: number | null
    /** 该 probe session 累计起进程次数（工单 11c 判据：连发 N 次只起 1 个进程）。 */
    start_count: number
  }
}

/** 版本前缀比较：5.3 / 5.3.0 视为同一版本。 */
function sameVersion(a: string, b: string): boolean {
  const na = a.trim()
  const nb = b.trim()
  if (!na || !nb) return false
  if (na === nb) return true
  return na.startsWith(nb + '.') || nb.startsWith(na + '.')
}

/** 版本漂移（纯函数，可单测）：message 必须同时含两个版本号。 */
export function driftOf(
  expected: unknown,
  actual: unknown,
  source: 'fixture' | 'exe' = 'exe',
): Drift | null {
  const e = String(expected ?? '').trim()
  const a = String(actual ?? '').trim()
  if (!e || !a || sameVersion(e, a)) return null
  return {
    expected: e,
    actual: a,
    level: 'warn',
    source: source,
    message: '版本漂移：期望 ' + e + '，实测 ' + a + '（headless 探针）',
  }
}

interface CacheRow {
  at: number
  version: string | null
  hits: unknown[]
}

const CACHE = new Map<string, CacheRow>()

/** 测试/运维重置探针缓存。 */
export function resetProbeCache(): void {
  CACHE.clear()
  START_COUNT = 0
}

/** 该 probe session 累计起进程次数（工单 11c 判据）。 */
let START_COUNT = 0
export function probeStartCount(): number {
  return START_COUNT
}

/** 把 addon 的查表结果规整成 hits 行：{kind, name, doc, params, ...原始字段}。 */
export function normalizeHit(hit: unknown): Record<string, unknown> {
  const o =
    hit && typeof hit === 'object' && !Array.isArray(hit)
      ? (hit as Record<string, unknown>)
      : { value: hit }
  const name = String(o.identifier ?? o.bl_idname ?? o.idname ?? o.name ?? '')
  const doc = String(o.description ?? o.doc ?? '')
  const params = o.parameters ?? o.properties ?? []
  return { ...o, kind: String(o.kind ?? 'unknown'), name, doc, params }
}

/** 探针脚本要加载的 addon 查表目录（与 GUI 命令同一份实现）。 */
export function probeDirOf(pkgRoot: string = PKG_ROOT): string {
  return path.join(pkgRoot, 'extension', 'dsh_blender_bridge', 'commands', 'core')
}

/**
 * worker 里执行的探针：把 addon 的 describe.py / bpy_lookup.py 当合成包加载，
 * 调用同一个 BpyApiLookupCommands.bpy_api_lookup(query)，输出一行 HEADLESS {json}。
 */
export function probeCode(query: string, dir: string = probeDirOf()): string {
  const root = JSON.stringify(dir)
  const q = JSON.stringify(String(query || ''))
  return [
    'import json, sys, types, pathlib, bpy',
    'root = pathlib.Path(' + root + ')',
    'pkg = types.ModuleType("dsh_bpy_probe")',
    'pkg.__path__ = [str(root)]',
    'sys.modules["dsh_bpy_probe"] = pkg',
    'd = types.ModuleType("dsh_bpy_probe.describe")',
    'd.__package__ = "dsh_bpy_probe"',
    'exec(compile((root / "describe.py").read_text(encoding="utf-8"), "describe.py", "exec"), d.__dict__)',
    'sys.modules["dsh_bpy_probe.describe"] = d',
    'm = types.ModuleType("dsh_bpy_probe.bpy_lookup")',
    'm.__package__ = "dsh_bpy_probe"',
    'exec(compile((root / "bpy_lookup.py").read_text(encoding="utf-8"), "bpy_lookup.py", "exec"), m.__dict__)',
    'obj = m.BpyApiLookupCommands.__new__(m.BpyApiLookupCommands)',
    'res = obj.bpy_api_lookup(' + q + ')',
    'print("HEADLESS " + json.dumps({"ok": True, "blender_version": bpy.app.version_string, "result": res}, default=str))',
  ].join('\n')
}

interface WorkerLike {
  list: () => Array<Record<string, unknown>>
  exec: (
    code: string,
    timeoutMs?: number,
    purge?: unknown,
    name?: unknown,
  ) => Promise<Record<string, unknown>>
}

export interface LookupInput {
  query: string
  expectVersion?: string | null
  versionFixture?: string | null
}

/** 组装 evidence（纯函数部分可单测）。 */
export function buildProbeEvidence(input: {
  query: string
  observedVersion: string | null
  hits: unknown[]
  cacheAge: number
  degraded: boolean
  error: string | null
  expectVersion?: string | null
  versionFixture?: string | null
  elapsedMs: number
  reused: boolean
  workerPid: number | null
  startCount?: number
  blenderExe: string | null
}): ProbeEvidence {
  const fixture = String(input.versionFixture || '').trim()
  const effective = fixture || String(input.observedVersion || '').trim() || null
  return {
    ok: !input.degraded,
    source: 'headless',
    query: input.query,
    blender_version: input.observedVersion,
    cache_age: Math.max(0, Math.round(input.cacheAge)),
    hits: input.hits,
    degraded: input.degraded,
    error: input.error,
    drift: driftOf(input.expectVersion, effective, fixture ? 'fixture' : 'exe'),
    version_source: fixture ? 'fixture' : 'observed',
    probe: {
      blender_exe: input.blenderExe,
      elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
      reused: input.reused,
      worker_pid: input.workerPid,
      start_count: Math.max(0, Math.round(input.startCount ?? START_COUNT)),
    },
  }
}

function degradedEvidence(input: LookupInput, error: string, elapsedMs: number): ProbeEvidence {
  return buildProbeEvidence({
    query: input.query,
    observedVersion: null,
    hits: [],
    cacheAge: 0,
    degraded: true,
    error,
    expectVersion: input.expectVersion,
    versionFixture: input.versionFixture,
    elapsedMs,
    reused: false,
    workerPid: null,
    blenderExe: blenderExeInfo().exe || null,
  })
}

/** 无头查表：先缓存，再复用/启动同一个 worker 进程。 */
export async function lookupHeadless(
  worker: WorkerLike,
  input: LookupInput,
): Promise<ProbeEvidence> {
  const query = String(input.query || '').trim()
  if (!query) return degradedEvidence(input, 'Empty query', 0)
  const t0 = Date.now()
  const before = worker.list().find((w) => String(w.name) === HEADLESS_WORKER) || null
  const reused = before ? before.alive === true : false
  const workerPid = before && before.alive === true ? Number(before.pid) || null : null
  // 工单 11c 判据：只有真正要起进程时才 +1（缓存命中不算新进程）。
  const willStart = !reused
  const cached = CACHE.get(query)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // 缓存只存命中的**事实**（版本/hits）；drift 与 version_fixture 每次按入参重建。
    return buildProbeEvidence({
      query,
      observedVersion: cached.version,
      hits: cached.hits,
      cacheAge: (Date.now() - cached.at) / 1000,
      degraded: false,
      error: null,
      expectVersion: input.expectVersion,
      versionFixture: input.versionFixture,
      elapsedMs: 0,
      reused,
      workerPid,
      startCount: START_COUNT,
      blenderExe: blenderExeInfo().exe || null,
    })
  }
  if (willStart) START_COUNT += 1
  try {
    const r = await worker.exec(probeCode(query), 120000, null, HEADLESS_WORKER)
    const payload = (
      r && typeof r.result === 'object' && r.result !== null ? r.result : {}
    ) as Record<string, unknown>
    if (r.ok !== true || payload.ok !== true) {
      const why =
        String(payload.error || r.error || 'headless probe failed').slice(0, 300) ||
        'headless probe failed'
      return degradedEvidence(input, why, Date.now() - t0)
    }
    const rawHits = Array.isArray(payload.result) ? payload.result : [payload.result]
    const hits = rawHits.map(normalizeHit)
    const evidence = buildProbeEvidence({
      query,
      observedVersion: payload.blender_version == null ? null : String(payload.blender_version),
      hits,
      cacheAge: 0,
      degraded: false,
      error: null,
      expectVersion: input.expectVersion,
      versionFixture: input.versionFixture,
      elapsedMs: Date.now() - t0,
      reused,
      workerPid,
      startCount: START_COUNT,
      blenderExe: blenderExeInfo().exe || null,
    })
    CACHE.set(query, {
      at: Date.now(),
      version: payload.blender_version == null ? null : String(payload.blender_version),
      hits,
    })
    return evidence
  } catch (e) {
    return degradedEvidence(
      input,
      e instanceof Error ? e.message.slice(0, 300) : String(e),
      Date.now() - t0,
    )
  }
}
