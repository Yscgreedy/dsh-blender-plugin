// H-4（优先级 1）：宿主 API 解析路径的**冻结基线** —— 只警告不阻断。
//
// 台账 H-4：解析链依赖全局安装的绝对路径，没有基线；换安装位置只能人工确认。
// 本模块只做三件事，**不改 HOST_API 字符串、不改载入行为**：
//   ① resolveHostApi()：把 import.meta.resolve('@deepseek-ai/dsh-tools') 的结构化结果拿出来
//      （成功 / 没有 import.meta.resolve / resolve 抛错，三态，永不抛出）；
//   ② 路径指纹：normalizeHostApiPath（win32 小写 + 去 \\?\ 长路径前缀）、
//      hostApiPathSuffix（相对布局，不含用户目录）、hostApiPathHash（包根目录的短 hash）；
//   ③ compareHostApiBaseline()：双轴比对 —— 版本不同但路径命中 = current + version_matches=false；
//      路径（suffix 或 hash）全不命中才 drift。
//
// config/host-api-baseline.json 由 scripts/refresh-host-api-baseline.mjs 生成，不要手写。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asRecord, errorMessage } from './contracts/dynamic.js'

/** 宿主 API 的包名（解析链唯一目标）。 */
export const HOST_API_PACKAGE = '@deepseek-ai/dsh-tools'

/**
 * 基线文件的默认位置：包根下的 config/。
 * dev（HERE=src）与打包（HERE=lib）都是上一层，不需要知道用户目录。
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const HOST_API_BASELINE_FILE = path.join(
  MODULE_DIR,
  '..',
  'config',
  'host-api-baseline.json',
)

export type Resolver = (specifier: string) => string

/** resolve 的三种结局；`error` 只在这两种非 ok 时非空。 */
export type HostApiResolveReason = 'ok' | 'resolve_unavailable' | 'resolve_failed'

export interface HostApiResolved {
  ok: boolean
  reason: HostApiResolveReason
  package: string
  version: string | null
  path: string | null
  error: string | null
}

/** 默认解析器：拿得到的 import.meta.resolve；拿不到返回 null（Node < 20.6）。 */
function defaultResolver(): Resolver | null {
  const meta = import.meta as ImportMeta & { resolve?: Resolver }
  const resolveFn = meta.resolve
  if (typeof resolveFn !== 'function') return null
  return (specifier: string) => String(resolveFn.call(import.meta, specifier) || '')
}

/** 从解析到的入口文件上两层读 package.json 的 version；读不到返回 null（不算错）。 */
function readPackageVersion(entry: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(path.dirname(path.dirname(entry)), 'package.json'), 'utf8'),
    )
    const version = asRecord(parsed).version
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}

/**
 * 结构化解析宿主 API。
 *
 * `resolve === undefined` 用当前的 import.meta.resolve；显式传 `null` 表示"这台/这版没有它"
 * （测试与老 Node 的同一入口）。任何失败都变成`{ok:false, reason, error}`，不抛。
 */
export function resolveHostApi(resolve?: Resolver | null): HostApiResolved {
  const base = { package: HOST_API_PACKAGE }
  const resolver = resolve === undefined ? defaultResolver() : resolve
  if (!resolver)
    return {
      ...base,
      ok: false,
      reason: 'resolve_unavailable',
      version: null,
      path: null,
      error: 'import.meta.resolve 不可用（node < 20.6?）',
    }
  // 无初值：try 里赋值，catch 里直接 return（下面 if (!entry) 只看解析结果）。
  let entry: string
  try {
    const url = String(resolver(HOST_API_PACKAGE) || '')
    entry = url.startsWith('file://') ? fileURLToPath(url) : url
  } catch (error: unknown) {
    return {
      ...base,
      ok: false,
      reason: 'resolve_failed',
      version: null,
      path: null,
      error: errorMessage(error),
    }
  }
  if (!entry)
    return {
      ...base,
      ok: false,
      reason: 'resolve_failed',
      version: null,
      path: null,
      error: '解析结果为空（resolve 返回空串）',
    }
  return {
    ...base,
    ok: true,
    reason: 'ok',
    version: readPackageVersion(entry),
    path: entry,
    error: null,
  }
}

/**
 * 路径归一化：反斜杠 → 正斜杠、去 Windows 长路径前缀 `\\\\?\\`、posix 规范化；
 * win32 再整体小写（Windows 文件系统不区分大小写）。**不含任何用户目录假设**。
 */
export function normalizeHostApiPath(entry: string, platform: string = process.platform): string {
  let p = String(entry || '')
    .trim()
    .replace(/\\/g, '/')
  if (p.startsWith('//?/')) p = p.slice(4)
  p = path.posix.normalize(p)
  if (platform === 'win32') p = p.toLowerCase()
  return p === '.' ? '' : p
}

/** 相对布局（从 node_modules/<pkg>/ 起）；布局不像安装树时返回 null。 */
export function hostApiPathSuffix(
  entry: string,
  platform: string = process.platform,
): string | null {
  const normalized = normalizeHostApiPath(entry, platform)
  const marker = '/node_modules/' + HOST_API_PACKAGE + '/'
  const at = normalized.indexOf(marker)
  if (at < 0) return null
  return normalized.slice(at + 1)
}

/** 包根目录的短 hash：同机同位置稳定，大小写/分隔符不影响；换安装根才变。 */
export function hostApiPathHash(entry: string, platform: string = process.platform): string | null {
  const normalized = normalizeHostApiPath(entry, platform)
  if (!normalized) return null
  // 入口文件（…/lib/index.js）上两层才是包根：文件名变了不算"换位置"。
  const root = path.posix.dirname(path.posix.dirname(normalized))
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

export type HostApiBaselineStatus = 'current' | 'drift' | 'unknown'

export type HostApiBaselineReason =
  | 'ok'
  | 'version_changed'
  | 'path_changed'
  | 'baseline_missing'
  | 'baseline_invalid'
  | 'resolve_failed'

export interface HostApiBaselineVerdict {
  status: HostApiBaselineStatus
  /** 版本轴：基线 package+hostApiVersion 与当前一致。null = 无法判（unknown）。 */
  version_matches: boolean | null
  /** 路径轴：suffix 或 hash 任一命中。null = 无法判。 */
  path_matches: boolean | null
  suffix_matches: boolean | null
  hash_matches: boolean | null
  expected: Record<string, unknown> | null
  actual: Record<string, unknown> | null
  reason: HostApiBaselineReason
}

/** 基线文件形状（scripts/refresh-host-api-baseline.mjs 生成）。 */
export interface HostApiBaselineSnapshot {
  version: 1
  package: string
  hostApiVersion: string
  pluginVersion: string | null
  pathSuffix: string | null
  pathHash: string | null
  platform: string
  generatedAt: string
}

/** 当前解析结果的观测视图（回执里给人看的 actual）。 */
function actualView(api: HostApiResolved, platform: string): Record<string, unknown> {
  const entry = String(api.path || '')
  return {
    package: api.package,
    version: api.version,
    path: entry,
    pathSuffix: hostApiPathSuffix(entry, platform),
    pathHash: hostApiPathHash(entry, platform),
  }
}

/** 基线是否可用：version=1、package 是字符串、suffix/hash 至少给了一个。 */
function readBaseline(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw)
  if (rec.version !== 1) return null
  if (typeof rec.package !== 'string' || !rec.package) return null
  const hasSuffix = typeof rec.pathSuffix === 'string' && rec.pathSuffix.length > 0
  const hasHash = typeof rec.pathHash === 'string' && rec.pathHash.length > 0
  return hasSuffix || hasHash ? rec : null
}

/**
 * 双轴比对：版本轴只产生警告（`version_matches=false`），路径轴决定 current / drift。
 *
 * 无基线 → `unknown/baseline_missing`；基线不合法 → `unknown/baseline_invalid`；
 * 解析失败 → `unknown/resolve_failed`。三者都不抛、不阻断。
 */
export function compareHostApiBaseline(
  actual: HostApiResolved,
  baseline: unknown,
  platform: string = process.platform,
): HostApiBaselineVerdict {
  const unknown = (
    reason: HostApiBaselineReason,
    actualFields: Record<string, unknown> | null,
  ) => ({
    status: 'unknown' as const,
    version_matches: null,
    path_matches: null,
    suffix_matches: null,
    hash_matches: null,
    expected: null,
    actual: actualFields,
    reason,
  })
  if (!actual.ok || !actual.path) return unknown('resolve_failed', null)
  const fields = actualView(actual, platform)
  const expected = readBaseline(baseline)
  if (!expected) return unknown(baseline == null ? 'baseline_missing' : 'baseline_invalid', fields)
  const expectedSuffix = typeof expected.pathSuffix === 'string' ? expected.pathSuffix : null
  const expectedHash = typeof expected.pathHash === 'string' ? expected.pathHash : null
  const expectedVersion =
    typeof expected.hostApiVersion === 'string' && expected.hostApiVersion
      ? expected.hostApiVersion
      : null
  const suffix_matches = expectedSuffix !== null && fields.pathSuffix === expectedSuffix
  const hash_matches = expectedHash !== null && fields.pathHash === expectedHash
  const path_matches = suffix_matches || hash_matches
  const version_matches =
    expected.package === actual.package &&
    expectedVersion !== null &&
    expectedVersion === actual.version
  return {
    status: path_matches ? 'current' : 'drift',
    version_matches,
    path_matches,
    suffix_matches,
    hash_matches,
    expected: {
      package: expected.package,
      version: expectedVersion,
      pathSuffix: expectedSuffix,
      pathHash: expectedHash,
    },
    actual: fields,
    reason: path_matches ? (version_matches ? 'ok' : 'version_changed') : 'path_changed',
  }
}

export interface HostApiBaselineViewOptions {
  /** 基线文件路径（测试用；默认 config/host-api-baseline.json）。 */
  baselinePath?: string
  /** 解析器注入：undefined = 用 import.meta.resolve；null = 当作不可用。 */
  resolve?: Resolver | null
  platform?: string
}

/** 读一个 JSON 文件；缺失/坏 JSON 一律返回 null（调用方按 `unknown` 处理，从不抛）。 */
function readBaselineFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读基线 + 比对；文件缺失/坏 JSON 都按 `unknown` 返回，**从不抛**。 */
export function hostApiBaselineView(
  options: HostApiBaselineViewOptions = {},
): HostApiBaselineVerdict {
  const platform = options.platform || process.platform
  const api = resolveHostApi(options.resolve)
  const baseline = readBaselineFile(options.baselinePath || HOST_API_BASELINE_FILE)
  return compareHostApiBaseline(api, baseline, platform)
}

export interface HostApiBaselineSnapshotOptions {
  resolve?: Resolver | null
  platform?: string
  pluginVersion?: string | null
  now?: Date
}

/** 生成要写进基线文件的内容；解析失败返回 null（刷新脚本据此报错退出）。 */
export function hostApiBaselineSnapshot(
  options: HostApiBaselineSnapshotOptions = {},
): HostApiBaselineSnapshot | null {
  const platform = options.platform || process.platform
  const api = resolveHostApi(options.resolve)
  if (!api.ok || !api.path) return null
  return {
    version: 1,
    package: api.package,
    hostApiVersion: String(api.version || '?'),
    pluginVersion: options.pluginVersion ?? null,
    pathSuffix: hostApiPathSuffix(api.path, platform),
    pathHash: hostApiPathHash(api.path, platform),
    platform,
    generatedAt: (options.now || new Date()).toISOString(),
  }
}
