/**
 * blender_run(action="worker") 回执判据（3.2.0-alpha.1 复测：反向假回执）。
 *
 * 现场：worker start 立刻回 "WORKER start · default · FAIL"，17 s 后 status 却是
 * alive:true / ready:true。根因是回执判据读的是 `result.ok === true`，而 start/stop 的
 * result 是 worker 快照（name/alive/ready/pid/port），永远没有 ok 字段 → 每次成功都写成 FAIL，
 * agent 判定"没起来"就重试，第二次 start 撞同一个端口。对称于 P1a 的"假 ok"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  replies: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))

vi.mock('../../../src/host/http.js', () => ({
  backendPost: vi.fn(async (_port: number, path: string, body: Record<string, unknown>) => {
    h.calls.push({ path, body })
    const next = h.replies.shift()
    if (!next) throw new Error('no scripted reply')
    return next
  }),
  backendJson: vi.fn(),
  jsonPayload: (value: unknown) => value,
}))

import { executeWorker } from '../../../src/tools/run/worker.js'

const ctx = { get: () => undefined }

function reply(body: Record<string, unknown>): void {
  h.replies.push(body)
}

function okStart(result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Object.assign({ ok: true, op: 'start', result }, extra)
}

describe('worker 回执判据（反向假回执）', () => {
  beforeEach(() => {
    h.replies.length = 0
    h.calls.length = 0
  })

  it('start 成功时回 ok —— 快照没有 ok 字段不算 FAIL', async () => {
    reply(okStart({ name: 'default', alive: true, ready: true, pid: 4242, port: 9879 }))
    const out = (await executeWorker(ctx, 1, { op: 'start', session: 'default' })) as {
      text: string
    }
    expect(out.text).toContain('WORKER start · default · ok')
    expect(out.text).not.toContain('FAIL')
    expect(out.text).toContain('pid=4242')
    expect(out.text).toContain('ready=true')
  })

  it('start 还没 ready 时给 pending + next_action，仍然不是 FAIL', async () => {
    reply(okStart({ name: 'default', alive: true, ready: false, pid: 37572, port: 9879 }))
    const out = (await executeWorker(ctx, 1, { op: 'start' })) as { text: string }
    expect(out.text).toContain('WORKER start · default · ok')
    expect(out.text).toContain('pending')
    expect(out.text).toContain('op=status')
  })

  it('stop 写终态：真停掉 / 本来没在跑 / 还没停掉 三种都不是 FAIL', async () => {
    reply({
      ok: true,
      op: 'stop',
      result: { name: 'default', stopped: true, wasAlive: true, alive: false },
    })
    let out = (await executeWorker(ctx, 1, { op: 'stop' })) as { text: string }
    expect(out.text).toContain('WORKER stop · default · ok')
    expect(out.text).toContain('stopped=true')
    expect(out.text).toContain('alive=false')

    reply({
      ok: true,
      op: 'stop',
      result: { name: 'default', stopped: false, wasAlive: false, alive: false },
    })
    out = (await executeWorker(ctx, 1, { op: 'stop' })) as { text: string }
    expect(out.text).toContain('本来就没在跑')
    expect(out.text).not.toContain('FAIL')

    reply({
      ok: true,
      op: 'stop',
      result: { name: 'default', stopped: false, wasAlive: true, alive: true },
    })
    out = (await executeWorker(ctx, 1, { op: 'stop' })) as { text: string }
    expect(out.text).toContain('stopping')
    expect(out.text).toContain('op=status')
  })

  it('stop 回执说明清掉了哪个 pid（避免 status 的旧 pid 被读成没停干净）', async () => {
    reply({
      ok: true,
      op: 'stop',
      result: {
        name: 'default',
        stopped: true,
        wasAlive: true,
        alive: false,
        pid: null,
        port: 9879,
        cleared: { pid: 4242, ready: true },
      },
    })
    const out = (await executeWorker(ctx, 1, { op: 'stop' })) as { text: string }
    expect(out.text).toContain('cleared: pid=4242')
    expect(out.text).toContain('ready=true')
    expect(out.text).not.toContain('FAIL')
  })

  it('信封失败仍然是 worker_error（新判据不吞错）', async () => {
    reply({ ok: false, op: 'start', error: 'worker 起不来（C:/nope/blender.exe）' })
    const out = (await executeWorker(ctx, 1, { op: 'start' })) as {
      text: string
      envelope?: { error?: { code?: string } }
    }
    expect(out.envelope?.error?.code).toBe('worker_error')
    expect(out.text).toContain('worker 起不来')
  })

  it('长启动的心跳只做提示，不改判据', async () => {
    reply(
      okStart(
        { name: 'default', alive: true, ready: true, pid: 1, port: 9879 },
        { __heartbeats: 1 },
      ),
    )
    const out = (await executeWorker(ctx, 1, { op: 'start' })) as { text: string }
    expect(out.text).toContain('WORKER start · default · ok')
    expect(out.text).toContain('心跳')
  })
})
