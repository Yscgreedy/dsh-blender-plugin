import { afterEach, describe, expect, it, vi } from 'vitest'

// item 4: win-spawn.test.ts could only grep spawn.ts source. Here the real
// spawnChild()/childAlive()/killStaleChild()/killChildHandle() run against a
// mocked node:child_process, so issue #51's spawn options and listener order are
// proven behaviorally on every platform (including Windows).
//
// H1 (hot reload, round 2): spawnChild also injects the host layer manifest —
// `env.DSH_BLENDER_HOST_MANIFEST` + a manifest written before the spawn.
//
// 复测第四轮（2026-11-19）：清单改成「**装载那一刻**的扫描结果」写盘（writeLayerManifest 收 scan），
// 文件名带宿主层根指纹（别的安装/仓库副本不会覆盖本安装）。这里钉住接线：扫一次、装载时定型、
// 每次 spawn 复用同一份、路径与 Gateway 收到的 env 一致。

const h = vi.hoisted(() => {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const calls: unknown[][] = []
  const events: string[] = []
  const child: any = {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
    unref: vi.fn(() => events.push('unref')),
    on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => {
      ;(listeners[ev] ||= []).push(fn)
      events.push('on:' + ev)
      return child
    }),
  }
  const spawn = vi.fn((...args: unknown[]) => {
    calls.push(args)
    return child
  })
  const winKillPids = vi.fn((pids: number[]) => pids.map(String))
  const scan = {
    hash: 'abc123def456',
    files: { 'index.js': 'aaaa11112222' },
    fileCount: 1,
    bytes: 42,
  }
  // 清单的真实扫描/落盘在 runtime/core/layers.ts（有独立用例）；这里只要证明
  // ① 扫描发生在**模块求值那一刻**（LOAD_SCAN），② spawn 之前只写一次，③ 元数据齐全。
  let scanCalls = 0
  const scanLayer = vi.fn(() => {
    scanCalls += 1
    return scan
  })
  const sha12 = vi.fn(() => 'feedfacecafe')
  const writeLayerManifest = vi.fn((s: any, root: string, file: string, meta: any) => ({
    schema: 1,
    root,
    loadedAt: '2026-11-19T00:00:00.000Z',
    pluginVersion: meta && meta.pluginVersion,
    hostPid: meta && meta.hostPid,
    pluginRoot: meta && meta.pluginRoot,
    ...s,
  }))
  const diffLayers = vi.fn(() => ({ changed: [], count: 0 }))
  return {
    listeners,
    calls,
    events,
    child,
    spawn,
    winKillPids,
    scan,
    scanLayer,
    scanCalls: () => scanCalls,
    sha12,
    writeLayerManifest,
    diffLayers,
  }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, spawn: h.spawn }
})
vi.mock('../../../src/host/runtime-bridge.js', () => ({
  winKillPids: h.winKillPids,
  scanLayer: h.scanLayer,
  sha12: h.sha12,
  writeLayerManifest: h.writeLayerManifest,
  diffLayers: h.diffLayers,
  HOST_LAYER_SKIP: ['runtime'],
  HOST_MANIFEST_ENV: 'DSH_BLENDER_HOST_MANIFEST',
}))

import { PLUGIN_VERSION } from '../../../src/constants.js'
import {
  childAlive,
  getChild,
  killChildHandle,
  killStaleChild,
  spawnChild,
} from '../../../src/host/backend/spawn.js'
import { hostManifestPath } from '../../../src/host/backend/host-manifest.js'
import { winKillPids } from '../../../src/host/runtime-bridge.js'

function emit(ev: string): void {
  for (const fn of h.listeners[ev] || []) fn(new Error('spawn EPERM'))
}

afterEach(() => {
  // Each test spawns its own child; clear the module handle to isolate them.
  killChildHandle()
  vi.restoreAllMocks()
  h.calls.length = 0
  h.events.length = 0
  for (const k of Object.keys(h.listeners)) delete h.listeners[k]
  h.child.kill.mockClear()
  h.child.unref.mockClear()
  h.child.on.mockClear()
  h.spawn.mockClear()
  h.writeLayerManifest.mockClear()
  h.child.exitCode = null
  h.child.signalCode = null
})

describe('spawnChild spawn options (issue #51)', () => {
  it('spawns process.execPath with gateway argv, the port and the H1 host manifest', () => {
    const out = spawnChild(9877)
    expect(out).toBe('spawned pid=4321')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    const [file, args, opts] = h.spawn.mock.calls[0] as [string, string[], any]
    expect(file).toBe(process.execPath)
    // argv 全长：gateway 入口 + --port + 端口（不许写死成"前两条"，清单注入就藏在这里）
    expect(args).toHaveLength(3)
    expect(args[0]).toMatch(/gateway\.(mjs|js)$/)
    expect(args[1]).toBe('--port')
    expect(args[2]).toBe('9877')
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(opts.env.PATH).toBe(process.env.PATH)
    // H1：清单路径经 env 传给 Gateway；文件名带宿主层根指纹，且就是刚才写出的那个文件
    const manifestPath = String(opts.env.DSH_BLENDER_HOST_MANIFEST || '')
    expect(manifestPath).toMatch(/host-manifest-[0-9a-z]+\.json$/)
    expect(manifestPath).toBe(hostManifestPath())
    expect(h.writeLayerManifest).toHaveBeenCalledTimes(1)
    const [scan, root, wrote, meta] = h.writeLayerManifest.mock.calls[0] as [
      any,
      string,
      string,
      any,
    ]
    expect(scan).toBe(h.scan)
    expect(wrote).toBe(manifestPath)
    expect(String(root).endsWith('lib')).toBe(true)
    expect(meta.pluginVersion).toBe(PLUGIN_VERSION)
    expect(meta.hostPid).toBe(process.pid)
    expect(typeof meta.pluginRoot).toBe('string')
    const manifest = h.writeLayerManifest.mock.results[0].value
    expect(manifest).toMatchObject({
      schema: 1,
      root,
      files: expect.any(Object),
      hash: expect.any(String),
    })
    expect(Array.isArray(opts.stdio)).toBe(true)
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number')
    expect(opts.detached).toBe(false)
    expect(opts.windowsHide).toBe(true)
    expect(getChild()).toBe(h.child)
    expect(childAlive()).toBe(true)
  })

  it('attaches error/exit listeners and keeps the Gateway in the host process group', () => {
    spawnChild(9877)
    expect(h.events.indexOf('on:error')).toBeGreaterThanOrEqual(0)
    expect(h.events.indexOf('on:exit')).toBeGreaterThanOrEqual(0)
    expect(h.child.unref).not.toHaveBeenCalled()
  })

  it('turns an asynchronous spawn error into a degraded handle, not a host crash', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    spawnChild(9877)
    expect(() => emit('error')).not.toThrow()
    expect(getChild()).toBeNull()
    expect(childAlive()).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Gateway 子进程启动失败'))
  })

  it('clears the handle when the child exits', () => {
    spawnChild(9877)
    emit('exit')
    expect(getChild()).toBeNull()
    expect(childAlive()).toBe(false)
  })

  it('reuses the manifest scan taken when this host fiber loaded (no re-scan per spawn)', () => {
    spawnChild(9877)
    spawnChild(9878)
    // H1 的核心：清单是「宿主装载那一刻」的快照。若每次 spawn 都重扫，
    // 只重启 Gateway 就会把旧宿主层洗成 current —— 那正是被验收打回来的洞。
    // 复测第四轮再加一条：被打断的镜像也不能算「已装载」→ 扫描只在模块求值时发生一次。
    // 装载时扫过一次（模块求值），之后每次 spawn 都不再重扫
    expect(h.scanCalls()).toBe(1)
    const manifestPath = String((h.spawn.mock.calls[0] as any)[2].env.DSH_BLENDER_HOST_MANIFEST)
    for (const call of h.spawn.mock.calls) {
      expect(String((call as any)[2].env.DSH_BLENDER_HOST_MANIFEST)).toBe(manifestPath)
    }
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })
})

describe('child handle lifecycle', () => {
  it('killChildHandle reports whether a handle existed and kills it once', () => {
    expect(killChildHandle()).toBe(false)
    spawnChild(9877)
    expect(killChildHandle()).toBe(true)
    if (process.platform === 'win32') {
      // H4：win32 没有优雅信号，句柄清理走 winKillPids 的**进程树** kill
      // （只杀父进程会留下 helper 与隐藏 Blender 的孤儿）。
      expect(vi.mocked(winKillPids)).toHaveBeenCalledWith([4321])
      expect(h.child.kill).not.toHaveBeenCalled()
    } else {
      expect(h.child.kill).toHaveBeenCalledTimes(1)
    }
    expect(getChild()).toBeNull()
    expect(killChildHandle()).toBe(false)
  })

  it('killStaleChild uses the platform cleanup path and returns the pid', () => {
    spawnChild(9877)
    const posixKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const pid = killStaleChild()
    expect(pid).toBe(4321)
    if (process.platform === 'win32') {
      expect(vi.mocked(winKillPids)).toHaveBeenCalledWith([4321])
    } else {
      expect(posixKill).toHaveBeenCalledWith(4321, 'SIGTERM')
    }
    expect(getChild()).toBeNull()
    expect(killStaleChild()).toBeNull()
  })

  it('childAlive treats signal-killed handles as dead', () => {
    spawnChild(9877)
    h.child.signalCode = 'SIGTERM'
    expect(childAlive()).toBe(false)
    h.child.signalCode = null
    h.child.exitCode = 14
    expect(childAlive()).toBe(false)
  })
})
