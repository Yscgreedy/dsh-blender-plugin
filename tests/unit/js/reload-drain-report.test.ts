import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// H5（作业跨 reload）：上一轮实测的痛点 —— reload 把在跑的作业置了 canceled，
// 回执里却**没有** jobsDropped（字段恒空），用户以为作业还在跑。
// 这里证明两条路径（宿主层 hmr / 运行时层 gateway-restart）都先把 drainGateway() 的回执
// 并进 ReloadReport，note 点名列 id 并说明"重跑请重新 submit"，两份状态文件里也查得到。

const h = vi.hoisted(() => ({
  post: vi.fn(),
  json: vi.fn(),
  order: [] as string[],
}))
vi.mock('../../../src/host/http.js', () => ({ backendPost: h.post, backendJson: h.json }))

import { hostReload, reloadOnce } from '../../../src/host/reload/index.js'

/** Gateway 的只诊断回执（POST /lease{action:"reload",apply:false} 的 body）。 */
function diag(mode: string, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    mode,
    changed: { host: [], runtime: [], other: [] },
    changedCount: { host: 0, runtime: 0, other: 0 },
    pidBefore: 4242,
    pidAfter: 4242,
    verdict: 'stale',
    staleLayer: [],
    needsRestart: [],
    hotReload: { supported: [], needsRestart: [] },
    layers: {},
    jobsDropped: [],
    pending: true,
    receipt: null,
    ms: 0,
    note: '',
    ...over,
  }
}

/** drainGateway() 的回执（POST /lease{action:"shutdown"} 的 body）。 */
function drained(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    stopped: [],
    failed: [],
    jobsDropped: [],
    exitScheduled: true,
    ms: 9,
    error: null,
    ...over,
  }
}

const TRIGGER_OK = {
  ok: true,
  profileDir: 'D:/profiles/web',
  patchPath: 'D:/profiles/web/cordis.patch.yml',
  comment: '# dsh-blender reload 2026-11-16T13:45:00.000Z reason=test',
  bytes: 40,
  note: 'written',
  needsRestart: [],
}

function readState() {
  return JSON.parse(
    readFileSync(
      path.join(process.env.DSH_BLENDER_WORKDIR || '', 'state', 'last-reload.json'),
      'utf8',
    ),
  )
}

let workdir = ''

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-reload-h5-'))
  process.env.DSH_BLENDER_WORKDIR = workdir
})

afterEach(() => {
  delete process.env.DSH_BLENDER_WORKDIR
  h.post.mockReset()
  h.json.mockReset()
  h.order.length = 0
  rmSync(workdir, { recursive: true, force: true })
})

describe('reload 回执要带 drain 回执（H5）', () => {
  it('hmr：先 drain 再触发重组合，作业 id 进回执、note 与 last-reload.json', async () => {
    h.post.mockResolvedValue(
      diag('hmr', {
        changedCount: { host: 2, runtime: 0, other: 0 },
        changed: { host: ['tools/session/reload.js'], runtime: [], other: [] },
      }),
    )
    const drain = vi.fn(async () => {
      h.order.push('drain')
      return drained({ stopped: ['virtual-gui:inst-7'], jobsDropped: ['job-9cb7691a'] })
    })
    const trigger = vi.fn(() => {
      h.order.push('trigger')
      return TRIGGER_OK
    })

    const out = await hostReload({ port: 4599, gatewayPid: async () => 4242, drain, trigger })

    // 顺序是语义的一部分：先 drain（作业置 canceled）再触发重组合（dispose 会杀进程树）
    expect(h.order).toEqual(['drain', 'trigger'])
    expect(out.mode).toBe('hmr')
    expect(out.ok).toBe(true)
    expect(out.jobsDropped).toEqual(['job-9cb7691a'])
    expect(out.stopped).toEqual(['virtual-gui:inst-7'])
    expect(out.note).toContain('本次取消 1 个在跑作业')
    expect(out.note).toContain('job-9cb7691a')
    expect(out.note).toContain('重跑请重新 submit')
    // 整份 drain 回执留在 layers 里（failed / exitScheduled / ms 都在）
    expect(out.layers.drain).toMatchObject({
      jobsDropped: ['job-9cb7691a'],
      exitScheduled: true,
      ms: 9,
    })
    expect(readState().jobsDropped).toEqual(['job-9cb7691a'])
    expect(readState().pending).toBe(true)
  })

  it('hmr：没有在跑作业时 note 说"drain 干净"，jobsDropped 仍是空数组', async () => {
    h.post.mockResolvedValue(diag('hmr', { changedCount: { host: 1, runtime: 0, other: 0 } }))
    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      drain: async () => drained({ ms: 3 }),
      trigger: () => TRIGGER_OK,
    })
    expect(out.jobsDropped).toEqual([])
    expect(out.stopped).toEqual([])
    expect(out.note).toContain('drain 干净')
    expect(out.note).not.toContain('本次取消')
  })

  it('hmr：drain 成功但 patch 写不进去 → 立刻补偿重拉，作业证据不丢', async () => {
    h.post.mockResolvedValue(diag('hmr', { changedCount: { host: 1, runtime: 0, other: 0 } }))
    const recover = vi.fn(async () => true)
    const out = await hostReload({
      port: 4599,
      gatewayPid: async () => 4242,
      drain: async () => drained({ jobsDropped: ['job-1'] }),
      trigger: () => ({
        ok: false,
        profileDir: null,
        patchPath: null,
        comment: null,
        bytes: null,
        note: '找不到 profile 目录',
        needsRestart: ['设 DSH_PROFILE_DIR'],
      }),
      recover,
    })
    expect(out.ok).toBe(false)
    expect(recover).toHaveBeenCalledWith(4599)
    expect(out.jobsDropped).toEqual(['job-1'])
    expect(out.note).toContain('找不到 profile 目录')
    expect(out.note).toContain('本次取消 1 个在跑作业')
    expect(out.note).toContain('HMR 未触发')
  })

  it('dry-run 既不 drain 也不触发（只诊断）', async () => {
    h.post.mockResolvedValue(diag('hmr', { changedCount: { host: 1, runtime: 0, other: 0 } }))
    const drain = vi.fn(async () => drained())
    const trigger = vi.fn(() => TRIGGER_OK)
    const out = await hostReload({
      port: 4599,
      apply: false,
      gatewayPid: async () => 4242,
      drain,
      trigger,
    })
    expect(drain).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
    expect(out.jobsDropped).toEqual([])
    expect(out.note).toContain('dry-run')
  })

  it('gateway-restart：drain 回执同样进 ReloadReport，且先 drain 后换代', async () => {
    h.post.mockResolvedValue(
      diag('gateway-restart', {
        changedCount: { host: 0, runtime: 3, other: 0 },
        changed: { host: [], runtime: ['lib/runtime/gateway.js'], other: [] },
      }),
    )
    const drain = vi.fn(async () => {
      h.order.push('drain')
      return drained({ jobsDropped: ['job-render-1', 'job-render-2'], ms: 21 })
    })
    const restart = vi.fn(async () => {
      h.order.push('restart')
      return false
    })

    const out = await hostReload({ port: 4599, gatewayPid: async () => 4242, drain, restart })

    expect(h.order).toEqual(['drain', 'restart'])
    expect(out.ok).toBe(false)
    expect(out.pending).toBe(true)
    expect(out.jobsDropped).toEqual(['job-render-1', 'job-render-2'])
    expect(out.note).toContain('本次取消 2 个在跑作业')
    expect(out.note).toContain('重跑请重新 submit')
    expect(readState().jobsDropped).toEqual(['job-render-1', 'job-render-2'])
  })
})
// R5（reload state seams）：reload 状态**只该有一个写入口**。旧实现里旧 fiber 写完、新 fiber 再 settle，
// 两个写函数各自被调；这里把「提交 → 等待 → 收尾」全封进 reloadOnce，并锁住幂等：
// 同一代里收尾两次、或第二代 fiber 再收尾一次，都不许再改那份记录。
describe('reloadOnce：两代收尾幂等（R5 去两代写）', () => {
  function jsonByPath() {
    return async (_port: number, p: string) => {
      if (p === '/health') return { ok: true, backend: { pid: 7777 } }
      return { ok: true, provenance: { verdict: 'current' } }
    }
  }

  it('旧 fiber 触发（写 pending）→ 新 fiber reloadOnce(settle) 收尾一次；再收尾是 no-op', async () => {
    h.post.mockResolvedValue(diag('hmr', { changedCount: { host: 1, runtime: 0, other: 0 } }))
    const oldFiber = await reloadOnce({
      port: 4599,
      gatewayPid: async () => 4242,
      drain: async () => drained({ jobsDropped: ['job-1a2b3c4d'] }),
      trigger: () => TRIGGER_OK,
    })
    expect(oldFiber.settled).toBe(false)
    expect(oldFiber.report?.pending).toBe(true)
    expect(readState()).toMatchObject({ mode: 'hmr', pending: true, pidAfter: null })

    h.json.mockImplementation(jsonByPath() as never)
    const first = await reloadOnce({ port: 4599, settle: true })
    expect(first).toEqual({ settled: true, report: null })
    const settled = readState()
    expect(settled).toMatchObject({ pending: false, pidAfter: 7777, verdict: 'current' })
    // 收尾不能把上一代的作业证据洗掉（H5：我的作业去哪了要查得到）
    expect(settled.jobsDropped).toEqual(['job-1a2b3c4d'])

    // 第二代 fiber 再收尾一次：没有 pending 可收 → 不重写 finishedAt / pidAfter
    const second = await reloadOnce({ port: 4599, settle: true })
    expect(second).toEqual({ settled: false, report: null })
    const again = readState()
    expect(again.finishedAt).toBe(settled.finishedAt)
    expect(again.pidAfter).toBe(settled.pidAfter)
    expect(again.jobsDropped).toEqual(['job-1a2b3c4d'])
  })

  it('没有 pending 记录时 settle 不写盘（新装机器上不会凭空生出一份 lastReload）', async () => {
    h.json.mockImplementation(jsonByPath() as never)
    const out = await reloadOnce({ port: 4599, settle: true })
    expect(out).toEqual({ settled: false, report: null })
    expect(() => readState()).toThrow()
  })
})
