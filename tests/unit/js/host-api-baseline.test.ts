/**
 * H-4（优先级 1）：宿主 API 解析路径的冻结基线 —— 只警告不阻断。
 *
 * 台账 H-4：解析链依赖全局安装的绝对路径、没有基线，换安装位置只能人工确认。
 * 这里把 dsh-tools 的 {package, version, 相对布局, 绝对路径 hash} 冻结进
 * config/host-api-baseline.json，再把**当前**解析结果与它做**双轴**比对：
 *   · 版本不同但路径命中 → status=current + version_matches=false（警告档，不报 drift）
 *   · 路径（suffix 或 hash）全不命中 → drift
 *   · 没有基线 / 解析失败 → unknown（不抛、不阻断）
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compareHostApiBaseline,
  hostApiBaselineView,
  hostApiPathHash,
  hostApiPathSuffix,
  normalizeHostApiPath,
  resolveHostApi,
} from '../../../src/host-api-baseline.js'
import type { HostApiResolved } from '../../../src/host-api-baseline.js'
import { HOST_API } from '../../../src/constants.js'
import { formatDoctor, formatStatus } from '../../../src/tools/session/presenter.js'

const PKG = '@deepseek-ai/dsh-tools'
const WIN_ENTRY =
  'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'
const POSIX_ENTRY = '/usr/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const OTHER_ENTRY = '/opt/vendor/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

function resolved(entry: string, version: string | null = '0.1.7-alpha.2'): HostApiResolved {
  return { ok: true, reason: 'ok', package: PKG, version, path: entry, error: null }
}

/** 一份"确认过"的基线；字段与 config/host-api-baseline.json 同形。 */
function baselineOf(entry: string, version = '0.1.7-alpha.2'): Record<string, unknown> {
  return {
    version: 1,
    package: PKG,
    hostApiVersion: version,
    pluginVersion: '3.3.1',
    pathSuffix: hostApiPathSuffix(entry),
    pathHash: hostApiPathHash(entry),
    platform: 'win32',
    generatedAt: '2026-11-28T00:00:00.000Z',
  }
}

/** 一个临时"全局安装"布局：…/node_modules/@deepseek-ai/dsh-tools/{package.json,lib/index.js}。 */
function fakeInstall(version = '0.1.7-alpha.2'): {
  entry: string
  dispose: () => void
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-host-api-'))
  const pkgDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version }), 'utf8')
  writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'export default {}\n', 'utf8')
  return {
    entry: path.join(pkgDir, 'lib', 'index.js'),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不算错 */
      }
    },
  }
}

describe('H-4 路径归一化（不硬编码用户目录）', () => {
  it('normalizes a Windows entry path to lowercase forward slashes', () => {
    expect(normalizeHostApiPath(WIN_ENTRY, 'win32')).toBe(
      'c:/users/dev/appdata/roaming/npm/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    )
  })

  it('strips the Windows long-path prefix and keeps POSIX case on linux', () => {
    expect(normalizeHostApiPath('\\\\?\\C:\\DSH\\lib\\index.js', 'win32')).toBe(
      'c:/dsh/lib/index.js',
    )
    expect(normalizeHostApiPath(POSIX_ENTRY, 'linux')).toBe(POSIX_ENTRY)
  })

  it('derives the relative layout from node_modules and falls back to null', () => {
    expect(hostApiPathSuffix(WIN_ENTRY, 'win32')).toBe(
      'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    )
    expect(hostApiPathSuffix(POSIX_ENTRY, 'linux')).toBe(
      'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    )
    expect(hostApiPathSuffix('/tmp/standalone/index.js', 'linux')).toBeNull()
  })

  it('hashes the normalized package root (stable across case variants, distinct per root)', () => {
    const hash = hostApiPathHash(WIN_ENTRY, 'win32')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hostApiPathHash(WIN_ENTRY.toUpperCase(), 'win32')).toBe(hash)
    expect(hostApiPathHash(OTHER_ENTRY, 'linux')).not.toBe(hash)
  })
})

describe('H-4 双轴比对：版本变化只是警告，路径变了才是 drift', () => {
  it('reports current with both axes matching', () => {
    const verdict = compareHostApiBaseline(resolved(POSIX_ENTRY), baselineOf(POSIX_ENTRY))
    expect(verdict).toMatchObject({
      status: 'current',
      version_matches: true,
      path_matches: true,
      suffix_matches: true,
      hash_matches: true,
      reason: 'ok',
    })
  })

  it('keeps status=current when the host upgraded but the path still matches', () => {
    const verdict = compareHostApiBaseline(
      resolved(POSIX_ENTRY, '0.1.8'),
      baselineOf(POSIX_ENTRY, '0.1.7-alpha.2'),
    )
    expect(verdict).toMatchObject({
      status: 'current',
      version_matches: false,
      path_matches: true,
      reason: 'version_changed',
    })
    expect(verdict.expected).toMatchObject({ version: '0.1.7-alpha.2' })
    expect(verdict.actual).toMatchObject({ version: '0.1.8' })
  })

  it('accepts a same-layout install at another absolute root (suffix hit, hash miss)', () => {
    const verdict = compareHostApiBaseline(
      resolved(OTHER_ENTRY),
      baselineOf('/usr/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    )
    expect(verdict).toMatchObject({
      status: 'current',
      suffix_matches: true,
      hash_matches: false,
      path_matches: true,
    })
  })

  it('reports drift when neither the layout nor the root matches', () => {
    const verdict = compareHostApiBaseline(
      resolved('/opt/vendor/dsh-tools/lib/index.js'),
      baselineOf(POSIX_ENTRY),
    )
    expect(verdict).toMatchObject({ status: 'drift', path_matches: false, reason: 'path_changed' })
    expect(verdict.actual).toMatchObject({ pathSuffix: null })
  })

  it('reports unknown without a baseline and never throws', () => {
    expect(compareHostApiBaseline(resolved(POSIX_ENTRY), null)).toMatchObject({
      status: 'unknown',
      version_matches: null,
      path_matches: null,
      reason: 'baseline_missing',
    })
    expect(compareHostApiBaseline(resolved(POSIX_ENTRY), { version: 2 })).toMatchObject({
      status: 'unknown',
      reason: 'baseline_invalid',
    })
    expect(
      compareHostApiBaseline(resolved(POSIX_ENTRY), { version: 1, package: PKG }),
    ).toMatchObject({ status: 'unknown', reason: 'baseline_invalid' })
  })

  it('reports unknown when the resolve itself failed', () => {
    const failed: HostApiResolved = {
      ok: false,
      reason: 'resolve_failed',
      package: PKG,
      version: null,
      path: null,
      error: 'ERR_MODULE_NOT_FOUND',
    }
    expect(compareHostApiBaseline(failed, baselineOf(POSIX_ENTRY))).toMatchObject({
      status: 'unknown',
      reason: 'resolve_failed',
    })
  })
})

describe('H-4 解析与基线视图', () => {
  it('resolves the package version from the resolved entry (injected resolver)', () => {
    const fake = fakeInstall('0.1.7-alpha.2')
    try {
      const api = resolveHostApi(() => pathToFileURL(fake.entry).href)
      expect(api).toMatchObject({ ok: true, reason: 'ok', version: '0.1.7-alpha.2' })
      expect(api.path).toBe(fake.entry)
      expect(hostApiPathSuffix(String(api.path))).toBe(
        'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
      )
    } finally {
      fake.dispose()
    }
  })

  it('answers resolve_failed / resolve_unavailable instead of throwing', () => {
    const thrown = resolveHostApi(() => {
      throw new Error('Cannot find module @deepseek-ai/dsh-tools')
    })
    expect(thrown.ok).toBe(false)
    expect(thrown.reason).toBe('resolve_failed')
    expect(String(thrown.error)).toContain('Cannot find module')
    const unavailable = resolveHostApi(null)
    expect(unavailable).toMatchObject({ ok: false, reason: 'resolve_unavailable' })
  })

  it('returns unknown for a missing baseline file and current for a written one', () => {
    const fake = fakeInstall()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-host-api-baseline-'))
    const file = path.join(dir, 'host-api-baseline.json')
    try {
      const missing = hostApiBaselineView({
        baselinePath: file,
        resolve: () => pathToFileURL(fake.entry).href,
      })
      expect(missing).toMatchObject({ status: 'unknown', reason: 'baseline_missing' })
      expect(missing.actual).toMatchObject({ package: PKG, version: '0.1.7-alpha.2' })

      writeFileSync(file, JSON.stringify(baselineOf(fake.entry)), 'utf8')
      const current = hostApiBaselineView({
        baselinePath: file,
        resolve: () => pathToFileURL(fake.entry).href,
      })
      expect(current).toMatchObject({ status: 'current', path_matches: true })
    } finally {
      fake.dispose()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不算错 */
      }
    }
  })
})

describe('H-4 回执文本（additive，一行）', () => {
  const api = 'dsh-tools@0.1.7-alpha.2 @ /usr/lib/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

  it('prints the api line plus a current verdict', () => {
    const text = formatDoctor({
      ok: true,
      hostApi: {
        api,
        baseline: { status: 'current', version_matches: true, path_matches: true, reason: 'ok' },
      },
    })
    expect(text).toContain('宿主 API：' + api)
    expect(text).toContain('baseline current')
    expect(text).not.toContain('⚠ 宿主 API baseline')
  })

  it('warns about a version change without calling it drift', () => {
    const text = formatDoctor({
      ok: true,
      hostApi: {
        api,
        baseline: {
          status: 'current',
          version_matches: false,
          path_matches: true,
          reason: 'version_changed',
          expected: { version: '0.1.7-alpha.2' },
          actual: { version: '0.1.8' },
        },
      },
    })
    expect(text).toContain('version_matches=false')
    expect(text).toContain('refresh-host-api-baseline')
    expect(text).not.toContain('drift')
  })

  it('names drift with the executable refresh command', () => {
    const text = formatDoctor({
      ok: true,
      hostApi: {
        api,
        baseline: {
          status: 'drift',
          version_matches: true,
          path_matches: false,
          reason: 'path_changed',
          expected: { pathSuffix: 'node_modules/@deepseek-ai/dsh-tools/lib/index.js' },
          actual: { pathSuffix: null },
        },
      },
    })
    expect(text).toContain('⚠ 宿主 API baseline drift')
    expect(text).toContain('path_changed')
    expect(text).toContain('node scripts/refresh-host-api-baseline.mjs')
  })

  it('says unknown (never a silent ready) when the baseline is missing', () => {
    const text = formatDoctor({
      ok: true,
      hostApi: { api, baseline: { status: 'unknown', reason: 'baseline_missing' } },
    })
    expect(text).toContain('baseline unknown')
    expect(text).toContain('baseline_missing')
  })

  it('keeps receipts without a hostApi section byte-identical (old gateway)', () => {
    const text = formatDoctor({ ok: true })
    expect(text).not.toContain('宿主 API')
  })

  it('adds the same line to status', () => {
    const text = formatStatus(
      {
        ok: true,
        hostApi: {
          api,
          baseline: { status: 'current', version_matches: true, path_matches: true, reason: 'ok' },
        },
      },
      [],
      null,
    )
    expect(text).toContain('宿主 API：' + api)
  })
})

describe('H-4 HOST_API 字符串保持不变', () => {
  it('still renders "dsh-tools@<ver> @ <path>" (or the documented failure wording)', () => {
    expect(typeof HOST_API).toBe('string')
    expect(HOST_API.length).toBeGreaterThan(0)
    expect(HOST_API).not.toContain('undefined')
    if (HOST_API.startsWith('dsh-tools@')) expect(HOST_API).toMatch(/^dsh-tools@\S+ @ \S/)
    else expect(HOST_API).toContain('dsh-tools')
  })
})
