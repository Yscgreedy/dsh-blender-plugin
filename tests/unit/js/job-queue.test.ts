import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobQueue, QueueError } from '../../../runtime/core/queue/manager.js'
import { MemoryJobStore, JsonJobStore } from '../../../runtime/core/queue/store.js'
import type { JobExecutor, JobHandle, JobRecord } from '../../../runtime/core/queue/types.js'
import { JobSurface, callerFromHeaders } from '../../../runtime/core/queue/handler.js'
import { SpawnJobExecutor } from '../../../runtime/core/queue/spawn-executor.js'
import { buildJobArgs } from '../../../runtime/core/queue/job-args.js'
import { CFG, resolveQueueSetting } from '../../../runtime/config.js'
import { listRows } from '../../../src/tools/run/presenter.js'
import type { CallerIdentity, SessionRecord } from '../../../runtime/core/sessions/types.js'

const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-1',
  agentId: 'agent-main',
  role: 'main',
  ...over,
})
const sub = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-1',
  agentId: 'agent-sub',
  parentAgentId: 'agent-main',
  role: 'subagent',
  ...over,
})
const other = (): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-2',
  agentId: 'agent-other',
  role: 'main',
})

interface Start {
  job: JobRecord
  resolve: (r: Awaited<JobHandle['done']>) => void
  cancel: ReturnType<typeof vi.fn>
}

class FakeExecutor implements JobExecutor {
  starts: Start[] = []
  start(job: JobRecord): JobHandle {
    let resolve!: Start['resolve']
    const done = new Promise<Awaited<JobHandle['done']>>((r) => {
      resolve = r
    })
    const cancel = vi.fn()
    this.starts.push({ job, resolve, cancel })
    return { pid: 1000 + this.starts.length, done, cancel }
  }
  finish(index = 0, exitCode = 0): void {
    this.starts[index].resolve({ exitCode, signal: null, stdout: 'ok', stderr: '' })
  }
}

function setup(
  over: { capacity?: Record<string, number>; reserved?: number; store?: MemoryJobStore } = {},
) {
  const executor = new FakeExecutor()
  const store = over.store || new MemoryJobStore()
  let id = 0
  const queue = new JobQueue({
    executor,
    store,
    capacity: over.capacity,
    reservedGpu: () => over.reserved || 0,
    id: () => 'job-' + ++id,
    now: () => 1000 + id,
  })
  return { queue, executor, store }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('3.1 job queue', () => {
  it('submit returns one job id immediately and uses it for later operations', () => {
    const { queue, executor } = setup()
    const job = queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    expect(job.id).toMatch(/^job-/)
    expect(['queued', 'assigned', 'running']).toContain(job.state)
    expect(executor.starts).toHaveLength(1)
    expect(queue.status(job.id)?.id).toBe(job.id)
    expect(queue.list().map((j) => j.id)).toEqual([job.id])
  })

  it('rejects a render script and an unknown kind', () => {
    const { queue } = setup()
    expect(() => queue.submit(main(), { kind: 'render', script: 'print(1)' })).toThrow(QueueError)
    expect(() => queue.submit(main(), { kind: 'other' })).toThrow(QueueError)
  })

  it('does not oversell the GPU slot, while headless uses a CPU slot', async () => {
    const { queue, executor } = setup()
    const first = queue.submit(main(), { kind: 'render', file: 'a.blend', frames: '1' })
    const second = queue.submit(main(), { kind: 'render', file: 'b.blend', frames: '1' })
    const cpu = queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    expect(executor.starts).toHaveLength(2)
    expect(queue.status(first.id)?.state).toBe('running')
    expect(queue.status(second.id)?.state).toBe('queued')
    expect(queue.status(cpu.id)?.state).toBe('running')
    executor.finish(0)
    await Promise.resolve()
    expect(queue.status(second.id)?.state).toBe('running')
    expect(queue.perf().slots).toMatchObject({
      gpu: { used: 1, total: 1 },
      cpu: { used: 1, total: 2 },
    })
  })

  it('reports queued_ahead at submission and keeps it out of the persisted record', () => {
    const { queue } = setup()
    const first = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const second = queue.submit(main(), { kind: 'render', file: 'b.blend' })
    const third = queue.submit(main(), { kind: 'render', file: 'c.blend' })
    expect(first.queued_ahead).toBe(0)
    expect(second.queued_ahead).toBe(0)
    expect(third.queued_ahead).toBe(1)
    // 高优先级插队：它前面没有更高/更早的 queued 作业。
    const vip = queue.submit(main(), { kind: 'render', file: 'd.blend', priority: 10 })
    expect(vip.queued_ahead).toBe(0)
    expect(queue.status(third.id)).not.toHaveProperty('queued_ahead')
  })

  it('rejects a full pending queue with QUEUE_FULL instead of waiting', () => {
    const { queue } = setup({ capacity: { pending: 2 } })
    queue.submit(main(), { kind: 'render', file: 'a.blend' })
    queue.submit(main(), { kind: 'render', file: 'b.blend' })
    const t0 = performance.now()
    try {
      queue.submit(main(), { kind: 'render', file: 'c.blend' })
      throw new Error('expected queue full')
    } catch (e) {
      const elapsedMs = performance.now() - t0
      expect(e).toBeInstanceOf(QueueError)
      expect((e as QueueError).failure.code).toBe('queue_full')
      expect((e as QueueError).failure.evidence.limit).toBe(2)
      // 3.6：队列满的决策是立即返回，不等待队列空位（queue 预算 ≤3s，决策 ≤100ms）。
      expect(elapsedMs).toBeLessThan(100)
    }
  })

  it('records every transition and keeps terminal states immutable', async () => {
    const { queue, executor } = setup()
    const job = queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    executor.finish(0)
    await Promise.resolve()
    const done = queue.status(job.id)
    expect(done?.state).toBe('completed')
    expect(done?.events.map((e) => e.to)).toEqual(['queued', 'assigned', 'running', 'completed'])
    executor.starts[0].resolve({ exitCode: 7, signal: null, stdout: '', stderr: '' })
    expect(queue.status(job.id)?.state).toBe('completed')
  })

  it('marks a running job failed after a Gateway restart and never replays it', () => {
    const store = new MemoryJobStore()
    const first = setup({ store })
    const job = first.queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    expect(first.queue.status(job.id)?.state).toBe('running')
    const executor = new FakeExecutor()
    const second = new JobQueue({ executor, store, id: () => 'job-2' })
    const restored = second.status(job.id)
    expect(restored?.state).toBe('failed')
    expect(restored?.error?.code).toBe('gateway_restart')
    expect(restored?.events.map((e) => e.to)).toContain('failed')
    expect(executor.starts).toHaveLength(0)
  })

  it('cancels a running job once and keeps the canceled state', () => {
    const { queue, executor } = setup()
    const job = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const first = queue.cancel(main(), job.id)
    expect(first.canceled).toBe(true)
    expect(queue.status(job.id)?.state).toBe('canceled')
    expect(executor.starts[0].cancel).toHaveBeenCalledTimes(1)
    const again = queue.cancel(main(), job.id)
    expect(again.alreadyFinished).toBe(true)
    expect(queue.status(job.id)?.state).toBe('canceled')
  })

  it('restricts cancel to the owner, its parent, and the main agent', () => {
    const { queue } = setup()
    const job = queue.submit(sub(), { kind: 'render', file: 'a.blend' })
    expect(() => queue.cancel(other(), job.id)).toThrow(QueueError)
    expect(queue.status(job.id)?.state).not.toBe('canceled')
    expect(queue.cancel(main(), job.id).canceled).toBe(true)
  })

  it('explains quota and admits another owner instead of starving', () => {
    const { queue, executor } = setup({ capacity: { ownerQuota: 1 } })
    queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    const blocked = queue.submit(main(), { kind: 'headless', script: 'print(2)' })
    const otherJob = queue.submit(other(), { kind: 'headless', script: 'print(3)' })
    expect(queue.status(blocked.id)?.state).toBe('queued')
    expect(queue.status(blocked.id)?.decision?.reason).toBe('quota')
    expect(executor.starts.map((s) => s.job.id)).toContain(otherJob.id)
  })

  it('admits a higher priority job at the next slot boundary', async () => {
    const { queue, executor } = setup({ capacity: { gpu: 1, ownerQuota: 8 } })
    queue.submit(main(), { kind: 'render', file: 'running.blend' })
    const low = queue.submit(main(), { kind: 'render', file: 'low.blend', priority: 0 })
    const high = queue.submit(main(), { kind: 'render', file: 'high.blend', priority: 10 })
    expect(queue.status(low.id)?.state).toBe('queued')
    expect(queue.status(high.id)?.state).toBe('queued')
    executor.finish(0)
    await Promise.resolve()
    expect(queue.status(high.id)?.state).toBe('running')
    expect(queue.status(high.id)?.decision?.reason).toBe('priority')
    expect(queue.status(low.id)?.state).toBe('queued')
  })

  it('ties resource admission to a virtual-gui GPU reservation', () => {
    const { queue, executor } = setup({ reserved: 1 })
    const job = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    expect(queue.status(job.id)?.state).toBe('queued')
    expect(queue.status(job.id)?.decision?.reason).toBe('virtual_gui')
    expect(executor.starts).toHaveLength(0)
  })

  it('times a bounded wait out without canceling the job', async () => {
    vi.useFakeTimers()
    const { queue } = setup()
    const job = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const pending = queue.wait(main(), job.id, 1000)
    await vi.advanceTimersByTimeAsync(1200)
    const result = await pending
    expect(result.waitTimedOut).toBe(true)
    expect(queue.status(job.id)?.state).toBe('running')
  })
})

describe('3.1 queue capacity is configuration, not a compile-time constant (Q-1/Q-2/Q-3)', () => {
  it('rejects the second job when pending is configured to 1', () => {
    const { queue } = setup({ capacity: { pending: 1 } })
    queue.submit(main(), { kind: 'render', file: 'a.blend' })
    try {
      queue.submit(main(), { kind: 'render', file: 'b.blend' })
      throw new Error('expected queue full')
    } catch (e) {
      expect(e).toBeInstanceOf(QueueError)
      const failure = (e as QueueError).failure
      expect(failure.code).toBe('queue_full')
      expect(failure.evidence.limit).toBe(1)
      expect(failure.evidence.pending).toBe(1)
    }
  })

  it('runs two renders at once when gpu is configured to 2', () => {
    const { queue, executor } = setup({ capacity: { gpu: 2 } })
    const a = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const b = queue.submit(main(), { kind: 'render', file: 'b.blend' })
    expect(executor.starts).toHaveLength(2)
    expect(queue.status(a.id)?.state).toBe('running')
    expect(queue.status(b.id)?.state).toBe('running')
    expect(queue.perf().slots).toMatchObject({ gpu: { used: 2, total: 2 } })
    const third = queue.submit(main(), { kind: 'render', file: 'c.blend' })
    expect(queue.status(third.id)?.state).toBe('queued')
    expect(queue.status(third.id)?.decision?.reason).toBe('capacity')
  })

  it('bounds one owner with ownerQuota while other slots stay free', () => {
    const { queue, executor } = setup({ capacity: { ownerQuota: 2, cpu: 8 } })
    queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    queue.submit(main(), { kind: 'headless', script: 'print(2)' })
    const third = queue.submit(main(), { kind: 'headless', script: 'print(3)' })
    expect(executor.starts).toHaveLength(2)
    expect(queue.status(third.id)?.state).toBe('queued')
    expect(queue.status(third.id)?.decision?.reason).toBe('quota')
    expect(queue.perf().capacity).toMatchObject({ ownerQuota: 2, cpu: 8 })
  })

  it('reserves a GPU slot per live virtual-gui and says virtual_gui', () => {
    const { queue, executor } = setup({ capacity: { gpu: 2 }, reserved: 1 })
    const first = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const second = queue.submit(main(), { kind: 'render', file: 'b.blend' })
    expect(executor.starts).toHaveLength(1)
    expect(queue.status(first.id)?.state).toBe('running')
    expect(queue.status(second.id)?.state).toBe('queued')
    expect(queue.status(second.id)?.decision?.reason).toBe('virtual_gui')
    expect(queue.perf().slots).toMatchObject({ gpu: { used: 1, total: 2, reserved: 1 } })
  })

  it('points the queue_full fix at DSH_BLENDER_QUEUE_PENDING instead of a missing key', () => {
    const { queue } = setup({ capacity: { pending: 1 } })
    queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    let failure: QueueError | null = null
    try {
      queue.submit(main(), { kind: 'headless', script: 'print(2)' })
    } catch (e) {
      failure = e as QueueError
    }
    expect(failure).not.toBeNull()
    expect(failure!.failure.fix).toContain('DSH_BLENDER_QUEUE_PENDING')
    expect(failure!.failure.fix).not.toContain('documented pending limit')
    expect(failure!.failure.evidence).toMatchObject({ pending: 1, limit: 1 })
  })

  it('explains every queued row through explainWaiting, not only the head', () => {
    const { queue } = setup({ capacity: { gpu: 1 } })
    queue.submit(main(), { kind: 'render', file: 'running.blend' })
    const second = queue.submit(main(), { kind: 'render', file: 'second.blend' })
    const third = queue.submit(main(), { kind: 'render', file: 'third.blend' })
    // recordWaiting 只记队首；第三行以前在 status/list 里是 decision=null —— 看不出在等什么。
    const status = queue.status(third.id)
    expect(status?.state).toBe('queued')
    expect(status?.decision).toMatchObject({
      outcome: 'waiting',
      reason: 'capacity',
      detail: 'target slot is busy',
    })
    expect(queue.status(second.id)?.decision?.reason).toBe('capacity')
    const queued = queue.list().filter((job) => job.state === 'queued')
    expect(queued).toHaveLength(2)
    expect(queued.every((job) => job.decision?.detail === 'target slot is busy')).toBe(true)
    // 派生视图只读：不落盘、不改事件链。
    expect(queue.status(third.id)?.events.map((e) => e.to)).toEqual(['queued'])
  })

  it('keeps the documented defaults and lets env win over the config file', () => {
    expect(CFG.features.queue).toEqual({ gpu: 1, cpu: 2, pending: 64, ownerQuota: 8 })
    const envName = 'DSH_BLENDER_QUEUE_GPU'
    expect(resolveQueueSetting({ envName, envValue: '3', fileValue: 9, fallback: 1 })).toEqual({
      value: 3,
      source: 'env:DSH_BLENDER_QUEUE_GPU',
    })
    expect(
      resolveQueueSetting({
        envName,
        envValue: undefined,
        fileValue: 9,
        fallback: 1,
        fileFrom: 'x.json',
      }),
    ).toEqual({ value: 9, source: 'file:x.json' })
    expect(resolveQueueSetting({ envName, envValue: '', fileValue: 9, fallback: 1 })).toEqual({
      value: 9,
      source: 'file:config',
    })
    expect(resolveQueueSetting({ envName, envValue: undefined, fallback: 1 })).toEqual({
      value: 1,
      source: 'default',
    })
  })

  it('falls back to the default for invalid values and says invalid in the source', () => {
    const envName = 'DSH_BLENDER_QUEUE_PENDING'
    expect(resolveQueueSetting({ envName, envValue: 'nope', fallback: 64 })).toEqual({
      value: 64,
      source: 'invalid:env:DSH_BLENDER_QUEUE_PENDING',
    })
    expect(resolveQueueSetting({ envName, envValue: '0', fallback: 64 })).toEqual({
      value: 64,
      source: 'invalid:env:DSH_BLENDER_QUEUE_PENDING',
    })
    expect(
      resolveQueueSetting({
        envName,
        envValue: undefined,
        fileValue: -2,
        fallback: 64,
        fileFrom: 'x.json',
      }),
    ).toEqual({ value: 64, source: 'invalid:file:x.json' })
    // 画面上的整数语义：小数向下取整，避免 2.7 变成 3 个 slot。
    expect(resolveQueueSetting({ envName, envValue: '2.7', fallback: 64 }).value).toBe(2)
  })
})

describe('3.1 gateway wiring reads capacity from configuration (Q-1/Q-2)', () => {
  it('passes features.queue to JobQueue and reserves a GPU slot per virtual-gui', async () => {
    process.env.DSH_BLENDER_QUEUE_GPU = '3'
    vi.resetModules()
    try {
      const { createGatewayApp } = await import('../../../runtime/gateway/app.js')
      const app = createGatewayApp({ port: 0 })
      try {
        // 构造点真的把配置传下去了（不是 DEFAULT_CAPACITY 的巧合：gpu 来自 env=3）。
        // perf() 是 Record<string, unknown>，用 toMatchObject 一次断言四个键，不拿 any 吞边界。
        expect(app.jobQueue.perf()).toMatchObject({
          capacity: { gpu: 3, cpu: 2, pending: 64, ownerQuota: 8 },
        })
        // reservedGpu 接的是 registry 的 virtual-gui 计数：默认实现会恒为 0。
        const virtual: SessionRecord = {
          id: 'virtual-gui:v1',
          kind: 'virtual-gui',
          instanceId: 'v1',
          status: 'ready',
          owner: null,
          agents: new Map(),
          grants: new Map(),
          paused: false,
          pausedAt: null,
          activePy: null,
          humanEdits: new Map(),
          humanModifiedAt: null,
          display: null,
          provider: null,
          createdAt: 1,
          lastActivityAt: 1,
        }
        app.sessionRegistry.addSession(virtual)
        expect(app.jobQueue.perf().slots).toMatchObject({ gpu: { reserved: 1, total: 3 } })
      } finally {
        app.close()
      }
    } finally {
      delete process.env.DSH_BLENDER_QUEUE_GPU
      vi.resetModules()
    }
  })
})

describe('3.1 wait timeout says still_running and list rows carry decision detail (Q-4)', () => {
  it('marks a timed-out wait on a live job with still_running', async () => {
    vi.useFakeTimers()
    const { queue } = setup()
    const job = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const pending = queue.wait(main(), job.id, 1000)
    await vi.advanceTimersByTimeAsync(1200)
    const result = await pending
    expect(result.waitTimedOut).toBe(true)
    expect(result.still_running).toBe(true)
    expect(typeof result.waitedMs).toBe('number')
    expect((result.job as JobRecord).state).toBe('running')
  })

  it('omits still_running when the job already reached a terminal state', async () => {
    const { queue, executor } = setup()
    const job = queue.submit(main(), { kind: 'headless', script: 'print(1)' })
    executor.finish(0)
    await Promise.resolve()
    const result = await queue.wait(main(), job.id, 1000)
    expect(result.waitTimedOut).toBe(false)
    expect(result).not.toHaveProperty('still_running')
    expect((result.job as JobRecord).state).toBe('completed')
  })

  it('keeps still_running true for a job that never started', async () => {
    vi.useFakeTimers()
    const { queue } = setup({ reserved: 1 })
    const job = queue.submit(main(), { kind: 'render', file: 'a.blend' })
    const pending = queue.wait(main(), job.id, 1000)
    await vi.advanceTimersByTimeAsync(1200)
    const result = await pending
    expect(result.waitTimedOut).toBe(true)
    // "还没开始" 也是 still_running：超时不是失败，作业仍在队列里等槽位。
    expect(result.still_running).toBe(true)
    const snapshot = result.job as JobRecord
    expect(snapshot.state).toBe('queued')
    expect(snapshot.decision?.reason).toBe('virtual_gui')
  })

  it('exposes decision.detail in the blender_run list rows', () => {
    const rows = listRows([
      {
        id: 'job-1',
        kind: 'render',
        state: 'queued',
        decision: { outcome: 'waiting', reason: 'capacity', detail: 'target slot is busy' },
      },
      { id: 'job-2', kind: 'render', state: 'running', decision: null },
    ])
    expect(rows[0].decision).toEqual({
      outcome: 'waiting',
      reason: 'capacity',
      detail: 'target slot is busy',
    })
    expect(rows[1].decision).toBeNull()
  })
})

describe('3.1 internal queue surface', () => {
  it('covers render and headless submission through one handler', async () => {
    vi.useFakeTimers()
    const { queue } = setup()
    const surface = new JobSurface(queue)
    const render = await surface.handle(main(), {
      op: 'submit',
      kind: 'render',
      file: 'scene.blend',
    })
    const headless = await surface.handle(main(), {
      op: 'submit',
      kind: 'headless',
      script: 'print(1)',
    })
    expect(render.ok).toBe(true)
    expect(headless.ok).toBe(true)
    const list = await surface.handle(main(), { op: 'list' })
    expect((list.jobs as JobRecord[]).map((j) => j.kind).sort()).toEqual(['headless', 'render'])
    const perf = await surface.handle(main(), { op: 'perf' })
    expect(perf.perf).toMatchObject({ capacity: { gpu: 1, cpu: 2, pending: 64 } })
  })

  it('returns a structured ownership failure instead of throwing', async () => {
    const { queue } = setup()
    const surface = new JobSurface(queue)
    const job = queue.submit(sub(), { kind: 'render', file: 'scene.blend' })
    const denied = await surface.handle(other(), { op: 'cancel', id: job.id })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('job_ownership_denied')
    expect(denied.stage).toBe('queue')
  })

  it('reads caller identity from the DSH headers and rejects an unknown op', async () => {
    const caller = callerFromHeaders({
      'x-dsh-host-id': 'host-a',
      'x-dsh-session-id': 'dsh-1',
      'x-dsh-agent-id': 'agent-main',
      'x-dsh-agent-role': 'main',
    })
    expect(caller).toEqual({
      hostId: 'host-a',
      dshSessionId: 'dsh-1',
      agentId: 'agent-main',
      role: 'main',
    })
    const { queue } = setup()
    const result = await new JobSurface(queue).handle(caller, { op: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('queue_unknown_op')
  })
})

describe('3.1 queue executor command shape', () => {
  const record = (kind: 'render' | 'headless', params: Record<string, unknown>): JobRecord => ({
    id: 'job-x',
    kind,
    params,
    state: 'running',
    priority: 0,
    slot: kind === 'render' ? 'gpu' : 'cpu',
    owner: { hostId: 'h', dshSessionId: 'd', agentId: 'a' },
    createdAt: 1,
    updatedAt: 1,
    assignedAt: 1,
    startedAt: 1,
    finishedAt: null,
    pid: null,
    decision: null,
    result: null,
    artifacts: [],
    logs: { stdout: '', stderr: '' },
    error: null,
    events: [],
  })

  it('render uses the fixed declarative entry and never a caller script', () => {
    // file= 的 .blend 现在起进程前就要存在（痛点2），fixture 必须是真的文件。
    const blend = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-')), 'scene.blend')
    fs.writeFileSync(blend, 'x')
    const { args } = buildJobArgs(
      record('render', { file: blend, resolution: [64, 64], frames: [1, 2] }),
      os.tmpdir(),
    )
    expect(args).toContain('--python-expr')
    expect(args).not.toContain('--python')
    expect(args.join(' ')).toContain('s.render.resolution_x=64')
    expect(args.slice(-5)).toEqual(['-s', '1', '-e', '2', '-a'])
  })

  it('render defines s before engine/output even without resolution and aliases EEVEE_NEXT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-nores-'))
    const blend = path.join(dir, 'scene.blend')
    fs.writeFileSync(blend, 'x')
    const { args } = buildJobArgs(
      record('render', {
        file: blend,
        output: path.join(dir, 'out', 'frame_####.png'),
        engine: 'BLENDER_EEVEE_NEXT',
        samples: 8,
        frames: [1, 1],
      }),
      os.tmpdir(),
    )
    const expr = args[args.indexOf('--python-expr') + 1]
    // 反馈（手册章节探针）：省略 resolution 时 s 未定义 -> NameError，engine/output
    // 都不执行，产物落回 .blend 的 C:/tmp。s 必须先于第一处使用定义。
    const sAt = expr.indexOf('s=bpy.context.scene')
    expect(sAt).toBeGreaterThanOrEqual(0)
    expect(sAt).toBeLessThan(expr.indexOf('_dsh_engine_requested'))
    expect(expr).toContain('_dsh_engine_alias')
    // 5.3 只有 BLENDER_EEVEE；别名回退必须把请求值和实际值都写进回执。
    expect(expr).toContain('"engine_requested_value"')
    expect(expr).toContain('"engine_alias"')
    expect(expr).toContain('s.render.filepath=')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('render with camera + frames previews an animation without a GUI session', () => {
    const blend = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-')), 'scene.blend')
    fs.writeFileSync(blend, 'x')
    const { args } = buildJobArgs(
      record('render', {
        file: blend,
        camera: 'Camera',
        frames: [3, 7],
        resolution: [160, 90],
        samples: 4,
      }),
      os.tmpdir(),
    )
    const expr = args[args.indexOf('--python-expr') + 1]
    expect(expr).toContain('s.camera=bpy.data.objects.get("Camera")')
    expect(args.slice(-5)).toEqual(['-s', '3', '-e', '7', '-a'])
    expect(args).not.toContain('--python')
  })

  it('render without output writes under the writable workDir and collects that outdir', () => {
    const { args, outdir } = buildJobArgs(
      record('render', { resolution: [64, 64], frames: [1, 1] }),
      os.tmpdir(),
    )
    expect(outdir).toBeTruthy()
    expect(outdir!.includes(path.join('renders', 'job-x'))).toBe(true)
    expect(args.join(' ')).toContain('s.render.filepath=')
    expect(fs.existsSync(outdir!)).toBe(true)
    fs.rmSync(outdir!, { recursive: true, force: true })
  })

  it('render resolves the Blender // prefix against the .blend directory', () => {
    const blend = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-slash-')),
      'scene.blend',
    )
    fs.writeFileSync(blend, 'x')
    const { args, outdir } = buildJobArgs(
      record('render', { file: blend, output: '//render/f_####' }),
      os.tmpdir(),
    )
    const expected = path.join(path.dirname(blend), 'render', 'f_####')
    expect(outdir).toBe(path.dirname(expected))
    expect(fs.existsSync(outdir!)).toBe(true)
    const expr = args[args.indexOf('--python-expr') + 1]
    // 反馈 8-1: #### stays a frame template (Blender expands it); no trailing separator.
    expect(expr).toContain('s.render.filepath=' + JSON.stringify(expected))
    fs.rmSync(path.dirname(blend), { recursive: true, force: true })
  })

  it('render rejects // output without a file base with a path-aware message', () => {
    expect(() =>
      buildJobArgs(record('render', { output: '//render/f_####' }), os.tmpdir()),
    ).toThrow(/output 以 \/\/ 开头.*file/)
  })

  it('render injects the device/samples prelude and echoes DSH_RENDER', () => {
    const blend = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-dev-')),
      'scene.blend',
    )
    fs.writeFileSync(blend, 'x')
    const { args } = buildJobArgs(
      record('render', {
        file: blend,
        samples: 128,
        engine: 'CYCLES',
        device: 'gpu',
        compute_device_type: 'optix',
      }),
      os.tmpdir(),
    )
    const expr = args[args.indexOf('--python-expr') + 1]
    expect(expr).toContain('DSH_RENDER')
    expect(expr).toContain('"device": "gpu"')
    expect(expr).toContain('"compute_device_type": "OPTIX"')
    expect(expr).toContain('"samples": 128')
    // 反馈 8-2: the receipt must say where the engine came from (requested vs .blend).
    expect(expr).toContain('"engine_requested": True')
    expect(expr).toContain('_dsh_engine_before')
    // samples 现在由 Python 按实际 engine 落地，不再只在显式 engine 时才写 JS 行
    expect(expr).not.toContain('s.cycles.samples=128')
    const inherit = buildJobArgs(record('render', { file: blend }), os.tmpdir())
    const inheritExpr = inherit.args[inherit.args.indexOf('--python-expr') + 1]
    expect(inheritExpr).toContain('"engine_requested": False')
    fs.rmSync(path.dirname(blend), { recursive: true, force: true })
  })

  it('render with an explicit output collects artifacts from its parent directory', () => {
    const output = path.join(os.tmpdir(), 'dsh-render-out-' + process.pid, 'frame-')
    const { outdir } = buildJobArgs(record('render', { output }), os.tmpdir())
    expect(outdir).toBe(path.dirname(output))
    fs.rmSync(outdir!, { recursive: true, force: true })
  })

  it('headless runs blender -b with a script file and no GUI session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-args-'))
    const { args } = buildJobArgs(record('headless', { script: 'print("HEADLESS {}\\n")' }), dir)
    // 2026-11-17：headless argv 恒定带 '--' 分隔符（args/outdir 之后追加；脚本可靠地用
    // sys.argv.index("--") 取参数尾，与 GUI 的 headless 前导同一口径）。
    expect(args).toEqual(['-b', '--factory-startup', '--python', path.join(dir, 'job.py'), '--'])
    expect(fs.readFileSync(path.join(dir, 'job.py'), 'utf8')).toContain('HEADLESS')
  })

  it('C-10: 用户 args 排在 -- 之后、outdir 之前（不再被目录名占第 0 位）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-argv-'))
    const built = buildJobArgs(
      record('headless', {
        script: 'print(1)',
        args: ['--flag', 'a b'],
        outdir: path.join(dir, 'out'),
      }),
      dir,
    )
    const sep = built.args.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    const tail = built.args.slice(sep + 1)
    expect(tail[0]).toBe('--flag')
    expect(tail[1]).toBe('a b')
    expect(tail[tail.length - 1]).toBe(built.outdir)
  })

  it('C-13: list 支持 limit/offset/sinceMs，且默认不再一次吐全量', () => {
    const { queue } = setup()
    for (let i = 0; i < 5; i++)
      queue.submit(main(), { kind: 'headless', script: 'print(' + i + ')' })
    expect(queue.list({}).length).toBe(5)
    expect(queue.list({ limit: 2 }).length).toBe(2)
    const page2 = queue.list({ limit: 2, offset: 2 })
    expect(page2.length).toBe(2)
    expect(page2[0].id).not.toBe(queue.list({ limit: 1 })[0].id)
    expect(queue.list({ sinceMs: Date.now() + 60_000 })).toEqual([])
    expect(queue.list({ owner: 'dsh-other' })).toEqual([])
  })

  it('C-9: headless 默认带设备前导（device=auto），并接受 device/compute_device_type', () => {
    const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-dev-'))
    buildJobArgs(record('headless', { script: 'print(1)' }), autoDir)
    const autoCode = fs.readFileSync(path.join(autoDir, 'job.py'), 'utf8')
    expect(autoCode).toContain('_dsh_headless_device()')
    expect(autoCode).toContain('"device": "auto"')
    expect(autoCode).toContain('DSH_RENDER')
    expect(autoCode).toContain('prefs.get_devices()')

    const gpuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-dev-'))
    buildJobArgs(
      record('headless', { script: 'print(1)', device: 'gpu', compute_device_type: 'optix' }),
      gpuDir,
    )
    const gpuCode = fs.readFileSync(path.join(gpuDir, 'job.py'), 'utf8')
    expect(gpuCode).toContain('"device": "gpu"')
    expect(gpuCode).toContain('"compute_device_type": "OPTIX"')

    const cpuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-dev-'))
    buildJobArgs(record('headless', { script: 'print(1)', gpu: false }), cpuDir)
    expect(fs.readFileSync(path.join(cpuDir, 'job.py'), 'utf8')).toContain('"device": "cpu"')
  })

  it('attributes a missing Blender executable to stage spawn', async () => {
    const missing = path.join(os.tmpdir(), 'missing-blender-' + process.pid)
    const executor = new SpawnJobExecutor({ blenderExe: missing })
    const handle = executor.start(record('headless', { script: 'print(1)' }))
    const result = await handle.done
    expect(result.error?.code).toBe('blender_exe_missing')
    expect(result.error?.stage).toBe('spawn')
    expect(result.error?.evidence.blenderExe).toBe(missing)
  })
})

describe('3.1 job queue persistence', () => {
  it('quarantines a corrupt state file instead of failing the Gateway', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-'))
    const file = path.join(dir, 'queue.json')
    fs.writeFileSync(file, '{not json')
    const store = new JsonJobStore(file)
    expect(store.load()).toEqual([])
    expect(fs.readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('round-trips jobs and reports a corrupt file without touching it silently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-'))
    const file = path.join(dir, 'queue.json')
    const store = new JsonJobStore(file)
    const job = {
      id: 'job-1',
      kind: 'render',
      params: {},
      state: 'completed',
      priority: 0,
      slot: 'gpu',
      owner: { hostId: 'h', dshSessionId: 'd', agentId: 'a' },
      createdAt: 1,
      updatedAt: 2,
      assignedAt: 1,
      startedAt: 1,
      finishedAt: 2,
      pid: null,
      decision: null,
      result: { exitCode: 0, signal: null, ms: 1 },
      artifacts: ['out.png'],
      logs: { stdout: 'ok', stderr: '' },
      error: null,
      events: [],
    } satisfies JobRecord
    store.save([job])
    expect(store.load()).toHaveLength(1)
    expect(store.load()[0].artifacts).toEqual(['out.png'])
  })
})
