/**
 * render 通道（render / alpha / mask / ink）的回执与校验。
 *
 * 台账验收（docs/archive/2026-11-20-角色动画与卡通渲染需求.md 第 72-74 行，render channels 条）：
 *   blender_run kind=render 支持 channels:["render","alpha","mask","ink"]，
 *   每通道路径 + foreground_px/coverage/n_components/bbox；缺 ink 对象时 skipped 不 fail。
 *
 * 这个文件钉住四层：
 *   ① 工具层 channels 校验（默认 ["render"]、去重、非法值 invalid_params 带允许列表、headless 拒绝）；
 *   ② 队列渲染命令里 channels 尾段（channels.py 定位 + 收尾 --python-expr，默认不加）；
 *   ③ CHANNELS 标记 → 三态 verdict / 每通道 evidence / repro 命令；
 *   ④ 回执呈现（status/wait/collect 都能读到 verdict 与每通道指标）。
 *
 * http 层整体打桩（与 py-outcome-unknown.test.ts 同一套写法）：这里测工具层判据，
 * 不是传输层；真 Blender 渲染属 E2E，不在单测里跑。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PostBody = Record<string, unknown>

const h = vi.hoisted(() => ({
  replies: [] as unknown[],
  calls: [] as Array<{ path: string; body: Record<string, unknown>; timeoutMs: number }>,
}))

vi.mock('../../../src/host/backend/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, ensureBackend: async () => true }
})

vi.mock('../../../src/host/http.js', () => ({
  backendPost: vi.fn(
    async (_port: number, path: string, body: Record<string, unknown>, timeoutMs = 0) => {
      h.calls.push({ path, body, timeoutMs })
      const next = h.replies.shift()
      if (next === undefined) throw new Error('no scripted reply for ' + path)
      return next as PostBody
    },
  ),
  backendJson: vi.fn(),
  fetchFrame: vi.fn(),
  leasedText: () => undefined,
  jsonPayload: (v: unknown) => v,
}))

import { executeRun } from '../../../src/tools/run/execute.js'
import {
  formatApplied,
  formatCollect,
  formatJob,
  runHelp,
} from '../../../src/tools/run/presenter.js'
import { SpawnJobExecutor } from '../../../runtime/core/queue/spawn-executor.js'
import { buildJobArgs } from '../../../runtime/core/queue/job-args.js'
import type { SpawnExecutorOptions } from '../../../runtime/core/queue/spawn-executor.js'
import {
  CHANNEL_NAMES,
  channelReceiptFrom,
  channelRepro,
} from '../../../runtime/execution/render-channels.js'
import type { JobRecord } from '../../../runtime/core/queue/types.js'
import { PY_ROOT } from '../../../runtime/paths.js'

const fakeCtx = { get: () => undefined } as unknown as Parameters<typeof executeRun>[0]

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function blendFile(): string {
  const file = path.join(tempDir('dsh-channels-'), 'scene.blend')
  fs.writeFileSync(file, 'fake-blend')
  return file
}

function reply(body: PostBody): void {
  h.replies.push(body)
}

function submitted(mark = 0): PostBody {
  const call = h.calls.slice(mark).find((c) => c.path === '/job' && c.body.op === 'submit')
  if (!call) throw new Error('no submit posted')
  return call.body
}

function receiptOf(out: unknown): string {
  return String((out as { text?: unknown } | null)?.text ?? '')
}

function envelopeOf(out: unknown): Record<string, unknown> {
  return ((out as { envelope?: Record<string, unknown> } | null)?.envelope || {}) as PostBody
}

function failCode(out: unknown): unknown {
  return (envelopeOf(out).error as Record<string, unknown> | undefined)?.code
}

function renderJob(params: PostBody, id = 'job-channels'): JobRecord {
  return {
    id,
    kind: 'render',
    params,
    state: 'queued',
    priority: 0,
    slot: 'gpu',
    owner: { hostId: 'h', dshSessionId: 'd', agentId: 'a' },
    createdAt: 1,
    updatedAt: 1,
    assignedAt: null,
    startedAt: null,
    finishedAt: null,
    pid: null,
    decision: null,
    result: null,
    artifacts: [],
    logs: { stdout: '', stderr: '' },
    error: null,
    events: [],
  }
}

const METRICS = { foreground_px: 120, coverage: 0.25, n_components: 2, bbox: [4, 5, 20, 24] }

function marker(payload: PostBody): string {
  return 'CHANNELS ' + JSON.stringify(payload)
}

beforeEach(() => {
  h.replies.length = 0
  h.calls.length = 0
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('工具层 channels 校验', () => {
  it('默认只渲染 render 通道，并把它作为 channels 发给队列', async () => {
    const file = blendFile()
    reply({ ok: true, op: 'submit', job: { id: 'job-1', kind: 'render', state: 'queued' } })
    const out = await executeRun(fakeCtx, 1, { action: 'submit', kind: 'render', file, frames: 1 })
    expect(receiptOf(out)).toContain('RUN job-1')
    expect(submitted().channels).toEqual(['render'])
  })

  it('channels 原样透传（去空白、去重、保序）', async () => {
    const file = blendFile()
    reply({ ok: true, op: 'submit', job: { id: 'job-2', kind: 'render', state: 'queued' } })
    await executeRun(fakeCtx, 1, {
      action: 'submit',
      kind: 'render',
      file,
      channels: ['render', ' alpha ', 'render', 'mask'],
    })
    expect(submitted().channels).toEqual(['render', 'alpha', 'mask'])
  })

  it('未知通道 → invalid_params 带允许列表，一个作业都不提交', async () => {
    const file = blendFile()
    const out = await executeRun(fakeCtx, 1, {
      action: 'submit',
      kind: 'render',
      file,
      channels: ['render', 'depth'],
    })
    expect(failCode(out)).toBe('invalid_params')
    expect(receiptOf(out)).toContain('depth')
    for (const name of CHANNEL_NAMES) expect(receiptOf(out)).toContain(name)
    expect(h.calls).toHaveLength(0)
  })

  it('非字符串项与空数组都按非法值拒绝', async () => {
    const file = blendFile()
    const bad = await executeRun(fakeCtx, 1, {
      action: 'submit',
      kind: 'render',
      file,
      channels: ['render', 3],
    })
    expect(failCode(bad)).toBe('invalid_params')
    const empty = await executeRun(fakeCtx, 1, {
      action: 'submit',
      kind: 'render',
      file,
      channels: [],
    })
    expect(failCode(empty)).toBe('invalid_params')
    expect(h.calls).toHaveLength(0)
  })

  it('headless 不接受 channels（不静默丢弃）', async () => {
    const out = await executeRun(fakeCtx, 1, {
      action: 'submit',
      kind: 'headless',
      script: 'print(1)',
      channels: ['render'],
    })
    expect(failCode(out)).toBe('invalid_params')
    expect(receiptOf(out)).toContain('channels')
    expect(h.calls).toHaveLength(0)
  })
})

describe('渲染作业的 channels 尾段（后端）', () => {
  it('没传 channels 时不追加收尾步骤（旧行为逐字节不变）', () => {
    const file = blendFile()
    const { args } = buildJobArgs(renderJob({ file, frames: [1, 2] }), os.tmpdir())
    expect(args.filter((a) => a === '--python-expr')).toHaveLength(1)
    expect(args.slice(-5)).toEqual(['-s', '1', '-e', '2', '-a'])
  })

  it('传了 channels 时在 -a 之后追加一次通道收尾，并打印 CHANNELS 标记', () => {
    const file = blendFile()
    const { args } = buildJobArgs(
      renderJob({ file, frames: [1, 1], channels: ['render', 'alpha'] }),
      os.tmpdir(),
    )
    expect(args.filter((a) => a === '--python-expr')).toHaveLength(2)
    // 渲染必须还在收尾之前：-a 是最后一个渲染参数
    expect(args.indexOf('-a')).toBeLessThan(args.lastIndexOf('--python-expr'))
    const postlude = args[args.length - 1]
    // 脚本里是 JSON 字面量（Windows 反斜杠成对），所以按同一份 JSON 形态断言路径
    expect(postlude).toContain(
      JSON.stringify(path.join(PY_ROOT, 'py', 'render', 'channels_impl', 'metrics.py')),
    )
    expect(postlude).toContain('CHANNELS ')
    // spec 是"JSON 里的 JSON"：通道名出现为 \"alpha\" 这种转义形态
    expect(postlude).toContain('\\"channels\\":[\\"render\\",\\"alpha\\"]')
  })
})

describe('CHANNELS 标记 → 三态 verdict / evidence / repro', () => {
  const params = { file: 'D:/work/aurora/Aurora.blend', frames: 1, channels: ['render', 'alpha'] }

  it('全部通道 ok → pass，每通道带路径与四项指标', () => {
    const receipt = channelReceiptFrom(
      {
        ok: true,
        frame: 1,
        channels: [
          { name: 'render', status: 'ok', path: 'D:/out/frame_0001.png', metrics: METRICS },
          { name: 'alpha', status: 'ok', path: 'D:/out/channels/alpha.png', metrics: METRICS },
        ],
        ink_objects: [],
      },
      params,
    )
    expect(receipt?.verdict).toBe('pass')
    expect(receipt?.channels.map((c) => c.name)).toEqual(['render', 'alpha'])
    expect(receipt?.channels[0].metrics).toEqual(METRICS)
    expect(receipt?.evidence.skipped).toEqual([])
    expect(receipt?.repro).toContain('blender_run(action="submit", kind="render"')
    expect(receipt?.repro).toContain('channels=["render","alpha"]')
    expect(receipt?.repro).toContain('D:/work/aurora/Aurora.blend')
  })

  it('缺 ink 对象 → 该通道 skipped + verdict=degraded（不是 fail）', () => {
    const receipt = channelReceiptFrom(
      {
        ok: true,
        frame: 1,
        channels: [
          { name: 'render', status: 'ok', path: 'D:/out/frame_0001.png', metrics: METRICS },
          {
            name: 'ink',
            status: 'skipped',
            reason: 'no_ink_object',
          },
        ],
        ink_objects: [],
      },
      { file: 'D:/a.blend', frames: 1, channels: ['render', 'ink'] },
    )
    expect(receipt?.verdict).toBe('degraded')
    const ink = receipt?.channels.find((c) => c.name === 'ink')
    expect(ink?.status).toBe('skipped')
    expect(ink?.reason).toBe('no_ink_object')
    expect(receipt?.evidence.skipped).toEqual(['ink'])
  })

  it('render 通道自身失败 → fail（底图没有，别假装通过）', () => {
    const receipt = channelReceiptFrom(
      {
        ok: true,
        frame: 1,
        channels: [{ name: 'render', status: 'error', reason: 'image_not_found' }],
      },
      { file: 'D:/a.blend', frames: 1, channels: ['render'] },
    )
    expect(receipt?.verdict).toBe('fail')
  })

  it('要求了通道却没有收到标记（作业崩溃/老后端）→ degraded + 证据点名', () => {
    const receipt = channelReceiptFrom(undefined, params)
    expect(receipt?.verdict).toBe('degraded')
    expect(receipt?.channels).toEqual([])
    expect(receipt?.evidence.channels_receipt).toBe('missing')
  })

  it('repro 命令字符串按真实参数拼（帧/分辨率/输出/相机）', () => {
    const repro = channelRepro({
      file: 'D:/work/a.blend',
      frames: [3, 7],
      resolution: [64, 64],
      samples: 4,
      camera: 'Camera',
      output: 'D:/out/frame_',
      channels: ['render', 'mask'],
    })
    expect(repro).toBe(
      'blender_run(action="submit", kind="render", file="D:/work/a.blend", frames=[3,7], ' +
        'resolution=[64,64], samples=4, camera="Camera", output="D:/out/frame_", ' +
        'channels=["render","mask"])',
    )
  })
})

class FakeChild extends EventEmitter {
  pid = 5150
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean {
    return true
  }
}

type SpawnImpl = NonNullable<SpawnExecutorOptions['spawnImpl']>

function fakeSpawn(child: FakeChild): SpawnImpl {
  return ((_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess =>
    child as unknown as ChildProcess) as unknown as SpawnImpl
}

async function settle(child: FakeChild, stdout: string): Promise<void> {
  child.stdout.write(stdout)
  await new Promise((resolve) => setImmediate(resolve))
  child.emit('close', 0, null)
}

describe('作业回执解析（spawn executor）', () => {
  it('渲染 stdout 里的 CHANNELS 标记进 result.parsed，带 verdict/evidence/repro', async () => {
    const file = blendFile()
    const child = new FakeChild()
    const executor = new SpawnJobExecutor({ blenderExe: 'blender', spawnImpl: fakeSpawn(child) })
    const handle = executor.start(
      renderJob({ file, frames: [1, 1], channels: ['render', 'ink'] }, 'job-parse'),
    )
    await settle(
      child,
      marker({
        ok: true,
        frame: 1,
        channels: [
          { name: 'render', status: 'ok', path: 'D:/out/frame_0001.png', metrics: METRICS },
          { name: 'ink', status: 'skipped', reason: 'no_ink_object' },
        ],
        ink_objects: [],
      }) + String.fromCharCode(10),
    )
    const result = await handle.done
    const parsed = result.parsed as PostBody | undefined
    expect(parsed?.verdict).toBe('degraded')
    expect((parsed?.evidence as PostBody).skipped).toEqual(['ink'])
    expect(String(parsed?.repro)).toContain('channels=["render","ink"]')
  })

  it('DSH_RENDER 标记进 result.parsed.applied（设备/采样结论可见）', async () => {
    const file = blendFile()
    const child = new FakeChild()
    const executor = new SpawnJobExecutor({ blenderExe: 'blender', spawnImpl: fakeSpawn(child) })
    const handle = executor.start(renderJob({ file, frames: [1, 1], samples: 128 }, 'job-device'))
    await settle(
      child,
      'DSH_RENDER ' +
        JSON.stringify({
          engine: 'CYCLES',
          samples: 128,
          scene_device: 'GPU',
          compute_device_type: 'OPTIX',
          devices_used: ['NVIDIA GeForce RTX 4060 Laptop GPU'],
          fell_back_to_cpu: false,
          warnings: [],
        }) +
        String.fromCharCode(10),
    )
    const result = await handle.done
    const parsed = result.parsed as PostBody | undefined
    expect((parsed?.applied as PostBody).compute_device_type).toBe('OPTIX')
    expect((parsed?.applied as PostBody).samples).toBe(128)
  })

  it('没有 CHANNELS 标记时 render 的 parsed 保持 undefined（旧作业一样）', async () => {
    const file = blendFile()
    const child = new FakeChild()
    const executor = new SpawnJobExecutor({ blenderExe: 'blender', spawnImpl: fakeSpawn(child) })
    const handle = executor.start(renderJob({ file, frames: [1, 1] }, 'job-legacy'))
    await settle(child, 'Saved: frame_0001.png' + String.fromCharCode(10))
    const result = await handle.done
    expect(result.parsed).toBeUndefined()
  })
})

describe('回执呈现', () => {
  it('applied 行回显实际后端，并在回落 CPU 时给 warning', () => {
    const lines = formatApplied({
      applied: {
        engine: 'CYCLES',
        samples: 128,
        scene_device: 'CPU',
        compute_device_type: 'NONE',
        devices_used: [],
        fell_back_to_cpu: true,
        warnings: ['gpu_unavailable: no GPU backend available'],
      },
    })
    const text = lines.join(String.fromCharCode(10))
    expect(text).toContain('compute_device_type=NONE')
    expect(text).toContain('device=CPU')
    expect(text).toContain('GPU 请求没有生效')
    expect(text).toContain('gpu_unavailable')
  })

  const job = {
    id: 'job-channels',
    kind: 'render',
    state: 'completed',
    slot: 'gpu',
    priority: 0,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    finishedAt: 2,
    pid: null,
    result: {
      exitCode: 0,
      signal: null,
      ms: 1200,
      parsed: {
        verdict: 'degraded',
        channels: [
          {
            name: 'render',
            status: 'ok',
            path: 'D:/out/frame_0001.png',
            metrics: METRICS,
          },
          { name: 'ink', status: 'skipped', reason: 'no_ink_object' },
        ],
        evidence: { requested: ['render', 'ink'], skipped: ['ink'], ink_objects: [] },
        repro:
          'blender_run(action="submit", kind="render", file="D:/a.blend", channels=["render","ink"])',
      },
    },
    artifacts: ['D:/out/frame_0001.png'],
    logs: { stdout: 'ok', stderr: '' },
    error: null,
    events: [],
  }

  it('status 回执给出 verdict、每通道路径与四项指标、skipped 原因与 repro', () => {
    const lines = formatJob(job).join(String.fromCharCode(10))
    expect(lines).toContain('channels  verdict=degraded')
    expect(lines).toContain('render · ok · D:/out/frame_0001.png')
    expect(lines).toContain('foreground_px=120')
    expect(lines).toContain('coverage=0.25')
    expect(lines).toContain('n_components=2')
    expect(lines).toContain('bbox=4,5,20,24')
    expect(lines).toContain('ink · skipped · no_ink_object')
    expect(lines).toContain('repro  blender_run(action="submit"')
  })

  it('collect 同样带 channels 块（日志之外），没有通道时不多打一行', () => {
    const text = formatCollect(job)
    expect(text).toContain('channels  verdict=degraded')
    const plain = formatCollect({ ...job, result: { exitCode: 0, signal: null, ms: 5 } })
    expect(plain).not.toContain('channels  verdict=')
  })

  it('help 写明 channels 参数与允许值', () => {
    const help = runHelp()
    expect(help).toContain('channels')
    for (const name of CHANNEL_NAMES) expect(help).toContain(name)
  })
})
