import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 复测第四轮（BlenderProject，2026-11-19）：假 noop。
// 现象：hot_update -Build 在「镜像完成、touch cordis.patch.yml 之前」被中断；再跑时增量 diff
// 为空 → noop；reload dry_run 也说 current —— 而磁盘是新代码、宿主 fiber 是旧代码，src 层修复
// 永远装不上。
//
// 这里的判据是「宿主自己知道装载的是哪一代」：装载时指纹（装载那一刻抓的，不重扫）vs 磁盘现在。
// 只要它 stale / 判不了，reload 必须升级成 hmr —— 不许把 Gateway 的增量 diff 当成「已是最新」。

const h = vi.hoisted(() => ({ post: vi.fn(), json: vi.fn(), order: [] as string[] }))
vi.mock('../../../src/host/http.js', () => ({ backendPost: h.post, backendJson: h.json }))

import { hostReload } from '../../../src/host/reload/index.js'
import type { HostSelfProvenance } from '../../../src/host/backend/host-manifest.js'

function diag(mode: string, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    mode,
    changed: { host: [], runtime: [], other: [] },
    changedCount: { host: 0, runtime: 0, other: 0 },
    pidBefore: 4242,
    pidAfter: 4242,
    verdict: mode === 'noop' ? 'current' : 'stale',
    staleLayer: [],
    needsRestart: [],
    hotReload: { supported: [], needsRestart: [] },
    layers: {},
    jobsDropped: [],
    pending: false,
    receipt: null,
    ms: 0,
    note: '',
    ...over,
  }
}

function self(over: Partial<HostSelfProvenance> = {}): HostSelfProvenance {
  return {
    available: true,
    root: 'C:/pkg/lib',
    loadedAt: '2026-11-19T05:14:51.000Z',
    loadedHash: 'aaaaaaaaaaaa',
    currentHash: 'aaaaaaaaaaaa',
    fileCount: 81,
    currentFileCount: 81,
    changedFiles: [],
    changedCount: 0,
    verdict: 'current',
    note: '宿主层装载时 = 磁盘',
    ...over,
  }
}

const stale = self({
  loadedHash: 'aaaaaaaaaaaa',
  currentHash: 'bbbbbbbbbbbb',
  changedFiles: ['tools/see/index.js', 'tools/see/validate.js'],
  changedCount: 2,
  verdict: 'stale',
  note: '宿主层磁盘已变 2 个文件',
})

const TRIGGER_OK = {
  ok: true,
  profileDir: 'D:/profiles/web',
  patchPath: 'D:/profiles/web/cordis.patch.yml',
  comment: '# dsh-blender reload 2026-11-19T06:00:00.000Z reason=test',
  bytes: 60,
  note: 'written',
  needsRestart: [],
}

const drained = () => ({
  ok: true,
  stopped: [],
  failed: [],
  jobsDropped: [],
  exitScheduled: true,
  ms: 4,
  error: null,
})

let workdir = ''

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-reload-self-'))
  process.env.DSH_BLENDER_WORKDIR = workdir
})

afterEach(() => {
  delete process.env.DSH_BLENDER_WORKDIR
  h.post.mockReset()
  h.json.mockReset()
  h.order.length = 0
  rmSync(workdir, { recursive: true, force: true })
})

function readState() {
  return JSON.parse(
    readFileSync(path.join(process.env.DSH_BLENDER_WORKDIR || '', 'state', 'last-reload.json'), 'utf8'),
  )
}

describe('reload 的 current 判据：装载时指纹 vs 磁盘（不是增量 diff）', () => {
  it('Gateway 说 noop，但宿主层装载时指纹≠磁盘 → 升级成 hmr 并重组合', async () => {
    h.post.mockResolvedValue(diag('noop'))
    const trigger = vi.fn(() => {
      h.order.push('trigger')
      return TRIGGER_OK
    })
    const drain = async () => drained()

    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      hostSelf: () => stale,
      drain,
      trigger,
    })

    expect(out.mode).toBe('hmr')
    expect(out.ok).toBe(true)
    expect(out.pending).toBe(true)
    expect(out.pidAfter).toBeNull()
    expect(out.changedCount.host).toBe(2)
    expect(out.changed.host).toEqual(['lib/tools/see/index.js', 'lib/tools/see/validate.js'])
    expect(out.staleLayer).toContain('host')
    expect(out.layers.hostSelf).toMatchObject({ verdict: 'stale', changedCount: 2 })
    expect(out.note).toContain('装载时指纹')
    expect(trigger).toHaveBeenCalledTimes(1)
    // 状态文件也按 hmr 写（新一代 fiber 靠它收尾）
    expect(readState().mode).toBe('hmr')
    expect(readState().pending).toBe(true)
  })

  it('Gateway 说 noop、宿主层也 current → 真 noop：不动 pid、不写 profile', async () => {
    h.post.mockResolvedValue(diag('noop'))
    const trigger = vi.fn(() => TRIGGER_OK)
    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      hostSelf: () => self(),
      drain: async () => drained(),
      trigger,
    })
    expect(out.mode).toBe('noop')
    expect(out.verdict).toBe('current')
    expect(out.pidAfter).toBe(4242)
    expect(trigger).not.toHaveBeenCalled()
    expect(out.note).toContain('noop')
  })

  it('force=true：判据都说 current 也强制重组合一次（中断态的唯一恢复手段）', async () => {
    h.post.mockResolvedValue(diag('noop'))
    const trigger = vi.fn(() => TRIGGER_OK)
    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      hostSelf: () => self(),
      force: true,
      drain: async () => drained(),
      trigger,
    })
    expect(out.mode).toBe('hmr')
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(out.note).toContain('force=true')
  })

  it('dry-run + 宿主层 stale：报 hmr 但不 drain、不写 profile', async () => {
    h.post.mockResolvedValue(diag('noop'))
    const trigger = vi.fn(() => TRIGGER_OK)
    const drain = vi.fn(async () => drained())
    const out = await hostReload({
      port: 4599,
      apply: false,
      gatewayPid: async () => 4242,
      hostSelf: () => stale,
      drain,
      trigger,
    })
    expect(out.mode).toBe('hmr')
    expect(out.pending).toBe(false)
    expect(out.note).toContain('dry-run')
    expect(drain).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
  })

  it('Gateway 说 gateway-restart、宿主层 stale → 先按 hmr（重组合连 Gateway 一起换）', async () => {
    h.post.mockResolvedValue(
      diag('gateway-restart', {
        changedCount: { host: 0, runtime: 3, other: 0 },
        changed: { host: [], runtime: ['lib/runtime/gateway.js'], other: [] },
      }),
    )
    const trigger = vi.fn(() => TRIGGER_OK)
    const restart = vi.fn(async () => true)
    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      hostSelf: () => stale,
      drain: async () => drained(),
      trigger,
      restart,
    })
    expect(out.mode).toBe('hmr')
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(restart).not.toHaveBeenCalled()
  })
})
