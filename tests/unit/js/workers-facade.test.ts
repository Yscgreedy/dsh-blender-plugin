/**
 * workers 门面（runtime/execution/workers/index.ts）的委派逻辑单测。
 *
 * 为什么单独测：该文件在 config/coverage-thresholds.json 里是 execution module（lines >= 80），
 * 而真实启停/协议由 execution-jobs-workers.test.ts 的假 socket 覆盖，digest / aux / 文件核对
 * 与错误落账这几条路径平时碰不到。这里用 mock 的 api / worker-start / lifecycle 钉住：
 *   · exec / digest / see / watch / aux / reset / status 的 op、timeout 与启动参数；
 *   · assertWorkerFile 的三态（已知、从 status 补、核对失败）；
 *   · 失败时 lastError 落下并原样抛出；
 *   · createWorkersApi 暴露的委派（stop/restart/list/snapshot/state/reaper）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const ctxState: { w: Record<string, unknown> | null } = { w: null }
  return {
    ctxState,
    alive: vi.fn((w: Record<string, unknown> | null) => Boolean(w && w.ready)),
    call: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})),
    stateFn: vi.fn(() => ctxState.w),
    snapshot: vi.fn((w: Record<string, unknown>) => ({
      name: w.name,
      file: w.file ?? null,
      objects: w.objects ?? 0,
    })),
    list: vi.fn(() => []),
    sameFile: vi.fn((a: unknown, b: unknown) => String(a) === String(b)),
    start: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})),
    stop: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
      stopped: true,
    })),
    restart: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
      alive: true,
    })),
    clearReaper: vi.fn(),
    kill: vi.fn(),
  }
})

vi.mock('../../../runtime/execution/workers/api.js', () => ({
  workerAlive: h.alive,
  workerCall: h.call,
  workerState: h.stateFn,
  workerSnapshot: h.snapshot,
  workerList: h.list,
  sameWorkerFile: h.sameFile,
}))

vi.mock('../../../runtime/execution/workers/worker-start.js', () => ({
  workerStart: h.start,
}))

vi.mock('../../../runtime/execution/workers/lifecycle.js', () => ({
  workerStop: h.stop,
  workerRestart: h.restart,
  createWorkerReaper: () => ({ clearWorkerReaper: h.clearReaper, killWorkers: h.kill }),
}))

import { createWorkersApi } from '../../../runtime/execution/workers/index.js'

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'default',
    file: null,
    objects: 0,
    ready: false,
    lastError: null,
    lastUsed: 0,
    ...over,
  }
}

function make(): { api: any; metrics: { workerStarts: number; workerExecs: number } } {
  const metrics = { workerStarts: 0, workerExecs: 0 }
  const api = createWorkersApi({ metrics, preloadChunk: (name: string) => '# ' + name } as any)
  return { api, metrics }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.ctxState.w = record()
  h.call.mockResolvedValue({})
  h.start.mockImplementation(async () => {
    const w = h.ctxState.w as Record<string, unknown>
    w.ready = true
    return {}
  })
})

describe('workers facade delegation', () => {
  it('exec starts a worker with the file, passes op/purge/timeout and tracks the result', async () => {
    const { api, metrics } = make()
    h.ctxState.w = record({ file: 'C:/scene/a.blend' })
    h.call.mockResolvedValueOnce({ objects: 9, file: 'C:/scene/a.blend' })
    const out = await api.workerExec('print(1)', 1234, 'geo', 'default', 'C:/scene/a.blend')
    expect(h.start).toHaveBeenCalledWith(expect.anything(), { file: 'C:/scene/a.blend' }, 'default')
    expect(h.call).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'C:/scene/a.blend' }),
      { op: 'exec', code: 'print(1)', purgePrefixes: 'geo', digest: undefined },
      1234,
    )
    expect(out.objects).toBe(9)
    expect(h.ctxState.w?.objects).toBe(9)
    expect(metrics.workerExecs).toBe(1)
  })

  it('digest starts on demand, checks the file and calls op=digest', async () => {
    const { api, metrics } = make()
    h.start.mockImplementation(async () => {
      const w = h.ctxState.w as Record<string, unknown>
      w.ready = true
      w.file = 'C:/scene/a.blend'
      return {}
    })
    h.call.mockResolvedValueOnce({ digest: 'abc123' })
    const out = await api.workerDigest('default', 'C:/scene/a.blend')
    expect(h.call).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'C:/scene/a.blend' }),
      { op: 'digest' },
      120000,
    )
    expect(out.digest).toBe('abc123')
    expect(metrics.workerExecs).toBe(1)
  })

  it('fills the worker file from status and rejects an unverifiable file', async () => {
    const { api } = make()
    h.ctxState.w = record({ ready: true, file: null })
    h.call.mockResolvedValueOnce({ status: { file: null, objects: 2 } })
    await expect(api.workerExec('x', 1000, null, 'default', 'C:/a.blend')).rejects.toMatchObject({
      code: 'worker_file_unverified',
      evidence: { requested_file: 'C:/a.blend', worker: 'default' },
    })
  })

  it('reads a file from status and refuses a different scene', async () => {
    const { api } = make()
    h.ctxState.w = record({ ready: true, file: null })
    h.call.mockResolvedValueOnce({ status: { file: 'C:/other.blend', objects: 4 } })
    await expect(api.workerExec('x', 1000, null, 'default', 'C:/a.blend')).rejects.toMatchObject({
      code: 'worker_file_mismatch',
      evidence: { current_file: 'C:/other.blend' },
    })
    expect(h.ctxState.w?.file).toBe('C:/other.blend')
    expect(h.ctxState.w?.objects).toBe(4)
  })

  it('status merges the live snapshot and records status errors', async () => {
    const { api } = make()
    h.ctxState.w = record({ ready: true })
    h.call.mockResolvedValueOnce({ status: { objects: 3 } })
    const live: any = await api.workerStatus('default')
    expect(live.status).toEqual({ objects: 3 })
    h.call.mockRejectedValueOnce(new Error('boom'))
    const broken: any = await api.workerStatus('default')
    expect(broken.statusError).toBe('boom')
    expect(h.ctxState.w?.lastError).toBe('boom')
  })

  it('status of an idle worker is a snapshot without a call', async () => {
    const { api } = make()
    const idle: any = await api.workerStatus('ghost')
    expect(h.call).not.toHaveBeenCalled()
    expect(idle.name).toBe('default')
  })

  it('see / watch / aux / reset pass their op and timeout', async () => {
    const { api, metrics } = make()
    h.ctxState.w = record({ ready: true })
    await api.workerSee({ width: 64 }, 'default')
    expect(h.call).toHaveBeenLastCalledWith(
      expect.anything(),
      { op: 'see', spec: { width: 64 } },
      60000,
    )
    await api.workerWatch({ frame: 2 }, 'default')
    expect(h.call).toHaveBeenLastCalledWith(
      expect.anything(),
      { op: 'watch', spec: { frame: 2 } },
      180000,
    )
    await api.workerAux('checkpoint', { label: 'a' }, 'default')
    expect(h.call).toHaveBeenLastCalledWith(
      expect.anything(),
      { op: 'checkpoint', spec: { label: 'a' } },
      120000,
    )
    await api.workerReset('default')
    expect(h.call).toHaveBeenLastCalledWith(expect.anything(), { op: 'reset' }, 60000)
    // reset 只是复用进程，不计入 workerExecs（见 workerResetOf）
    expect(metrics.workerExecs).toBe(3)
  })

  it('watch boots a workbench worker with warmup when idle', async () => {
    const { api } = make()
    h.ctxState.w = record({ ready: true })
    h.ctxState.w = record({ ready: false })
    h.start.mockImplementation(async () => {
      const w = h.ctxState.w as Record<string, unknown>
      w.ready = true
      return {}
    })
    await api.workerWatch({ frame: 1 }, 'default')
    expect(h.start).toHaveBeenCalledWith(
      expect.anything(),
      { engine: 'workbench', warmup: true },
      'default',
    )
  })

  it('records lastError and rethrows when an op fails', async () => {
    const { api } = make()
    h.ctxState.w = record({ ready: true })
    h.call.mockRejectedValueOnce(new Error('see-fail'))
    await expect(api.workerSee({}, 'default')).rejects.toThrow('see-fail')
    expect(h.ctxState.w?.lastError).toBe('see-fail')
    h.call.mockRejectedValueOnce(new Error('watch-fail'))
    await expect(api.workerWatch({}, 'default')).rejects.toThrow('watch-fail')
    h.call.mockRejectedValueOnce(new Error('aux-fail'))
    await expect(api.workerAux('revert', {}, 'default')).rejects.toThrow('aux-fail')
    h.call.mockRejectedValueOnce(new Error('reset-fail'))
    await expect(api.workerReset('default')).rejects.toThrow('reset-fail')
    h.call.mockRejectedValueOnce(new Error('digest-fail'))
    await expect(api.workerDigest('default')).rejects.toThrow('digest-fail')
  })

  it('exposes list / snapshot / state / stop / restart / reaper', async () => {
    const { api } = make()
    const w = record()
    h.ctxState.w = w
    expect(api.workerList()).toEqual([])
    expect(api.workerSnapshot(w)).toMatchObject({ name: 'default' })
    expect(api.workerState('x')).toBe(w)
    await expect(api.workerStop('n')).resolves.toMatchObject({ stopped: true })
    await api.workerRestart('n', { warmup: false })
    expect(h.stop).toHaveBeenCalledWith(expect.anything(), 'n')
    expect(h.restart).toHaveBeenCalledWith(expect.anything(), 'n', { warmup: false })
    api.clearWorkerReaper()
    api.killWorkers()
    expect(h.clearReaper).toHaveBeenCalledTimes(1)
    expect(h.kill).toHaveBeenCalledTimes(1)
  })
})
