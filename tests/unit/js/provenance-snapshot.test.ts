/**
 * 分层证据显式化（evidence snapshot seams）—— 构造的 LayerSnapshot 就能判 current / stale / unknown。
 *
 * 这条测试**不建清单文件、不依赖 env 指向的路径**：宿主层快照由调用方（HTTP 边界）拿好再传，
 * foundation 只对拍它。R3 的病根是「verdict 的输入被 reload 自己改写」，所以判据必须能
 * 离开磁盘与 env 单独构造 —— 否则 unknown 分支永远只能靠现场复现。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { hostProvenance } from '../../../runtime/foundation/evidence-host.js'
import { engineProvenance } from '../../../runtime/foundation/evidence.js'
import { HOST_MANIFEST_ENV, hostLayerSnapshot } from '../../../runtime/foundation/layers.js'
import type { LayerSnapshot } from '../../../runtime/foundation/layers.js'

/** 构造一份「已装载 = 磁盘」的宿主层快照（available=true → current）。 */
function snapshot(over: Partial<LayerSnapshot> = {}): LayerSnapshot {
  return {
    layer: 'host',
    available: true,
    root: 'C:/pkg/lib',
    loadedHash: 'aaaaaaaaaaaa',
    currentHash: 'aaaaaaaaaaaa',
    fileCount: 2,
    currentFileCount: 2,
    changedFiles: [],
    changedCount: 0,
    truncated: false,
    verdict: 'current',
    loadedAt: '2026-11-27T00:00:00.000Z',
    note: '',
    ...over,
  }
}

const STALE = snapshot({
  currentHash: 'bbbbbbbbbbbb',
  changedFiles: ['tools/op/local.js'],
  changedCount: 1,
  verdict: 'stale',
})

const UNKNOWN = snapshot({
  available: false,
  loadedHash: null,
  currentHash: null,
  fileCount: null,
  currentFileCount: null,
  verdict: 'unknown',
  note: '宿主层清单读不到或 schema 不匹配（C:/nope/host-manifest.json）→ 只看运行时层',
})

afterEach(() => {
  delete process.env[HOST_MANIFEST_ENV]
})

describe('hostProvenance(fresh, snapshot)：只对拍调用方给的快照', () => {
  it('current：已装载 = 磁盘时不冒充、也不降级', () => {
    const host = hostProvenance(true, snapshot())
    expect(host).toMatchObject({
      source: 'manifest',
      verdict: 'current',
      loadedFileCount: 2,
      fileCount: 2,
      changedCount: 0,
      truncated: false,
    })
    expect(host.loadedHash).toBe(host.currentHash)
    expect(host.note).toContain('一致')
  })

  it('stale：逐文件差异进快照，note 说清「只重启 Gateway 换不掉宿主层」', () => {
    const host = hostProvenance(true, STALE)
    expect(host).toMatchObject({ source: 'manifest', verdict: 'stale', changedCount: 1 })
    expect(host.changedFiles).toEqual(['tools/op/local.js'])
    expect(host.note).toContain('旧一代')
    expect(host.note).toContain('只重启 Gateway 不会换掉宿主层')
  })

  it('unknown：没有可信的已装载清单 → 判不了，且不退回扫盘（source=none）', () => {
    // env 指向一份根本不存在的清单：给了快照就不该去读它
    process.env[HOST_MANIFEST_ENV] = 'C:/nope/host-manifest.json'
    const host = hostProvenance(true, UNKNOWN)
    expect(host).toMatchObject({ source: 'none', verdict: 'unknown', changedCount: 0 })
    expect(host.note).toContain('宿主层判不了')
    expect(host.note).toContain('C:/nope/host-manifest.json')
    expect(host.note).not.toContain('降级')
  })
})

describe('engineProvenance({ layers: { host } })：显式快照透传', () => {
  it('stale 快照让顶层判定 stale 并归因到 host 层', () => {
    const pr = engineProvenance({ fresh: true, layers: { host: STALE } })
    expect(pr.host).toMatchObject({ verdict: 'stale', changedCount: 1, source: 'manifest' })
    expect(pr.staleLayer).toContain('host')
    expect(pr.verdict).toBe('stale')
    expect(pr.stale).toBe(true)
    expect(String(pr.staleReason)).toContain('只重启 Gateway 不会换掉宿主层')
  })

  it('current 快照保持宿主的 current 与计数（顶层由运行时层合成）', () => {
    const pr = engineProvenance({ fresh: true, layers: { host: snapshot() } })
    expect(pr.host).toMatchObject({ verdict: 'current', loadedFileCount: 2, fileCount: 2 })
    expect(pr.staleLayer).not.toContain('host')
  })

  it('unknown 快照不被当成 current（staleLayer 里也不出现 host）', () => {
    const pr = engineProvenance({ fresh: true, layers: { host: UNKNOWN } })
    expect(pr.host.verdict).toBe('unknown')
    expect(pr.staleLayer).not.toContain('host')
    // 判不了 ≠ 陈旧：缺证据不该把顶层硬推成 stale（否则脚本会被 unknown 噎住）
    expect(pr.verdict).not.toBe('stale')
  })

  it('opts 形状向后兼容：没有 layers 时仍走 foundation 自己的发现路径', () => {
    delete process.env[HOST_MANIFEST_ENV]
    const pr = engineProvenance({ fresh: true })
    expect(pr.host.source).not.toBe('manifest')
    expect(pr.host.verdict).toBe('unknown')
    expect(String(pr.host.note)).toContain('降级')
  })
})

describe('hostLayerSnapshot：manifest / manifestPath 显式优先，env 只在两者都缺省时兜底', () => {
  it('显式空 manifestPath 不读 env（回执文本与「缺 env」一致，逐字节不变）', () => {
    process.env[HOST_MANIFEST_ENV] = 'C:/nope/host-manifest.json'
    const explicit = hostLayerSnapshot({ root: 'C:/pkg/lib', manifestPath: '' })
    expect(explicit.available).toBe(false)
    expect(explicit.note).toContain('缺 ' + HOST_MANIFEST_ENV)
    expect(explicit.note).not.toContain('C:/nope')
  })

  it('env 兜底仍然可用：两者都缺省时按 env 里的路径读（读不到 → unknown 并点名该路径）', () => {
    process.env[HOST_MANIFEST_ENV] = 'C:/nope/host-manifest.json'
    const fallback = hostLayerSnapshot({ root: 'C:/pkg/lib' })
    expect(fallback.available).toBe(false)
    expect(fallback.note).toContain('C:/nope/host-manifest.json')
  })

  it('显式 manifest:null 表示「已知没有清单」：不读 env、不读文件', () => {
    process.env[HOST_MANIFEST_ENV] = 'C:/nope/host-manifest.json'
    const none = hostLayerSnapshot({ root: 'C:/pkg/lib', manifest: null })
    expect(none.available).toBe(false)
    expect(none.note).toContain('缺 ' + HOST_MANIFEST_ENV)
    expect(none.note).not.toContain('C:/nope')
  })
})
