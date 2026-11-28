/**
 * blender_run 回执的结构化句柄（并发提交现场）：
 *   * submit 不再只是 text —— jobId / state / slot / queued_ahead + receipt.v2 信封；
 *   * list 给 jobs[] 结构化行（DSH 宿主的 job_list 不含 Blender 队列）；
 *   * catalog format=json 的结构化目录能穿过 blender_op 回到调用方。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as plugin from '../../../src/index'
import { finishPlanResponse, planEnvelope } from '../../../src/tools/op/plan-response.js'
import { createFakeContext, type CapturedTool } from '../../helpers/fake-context'
import { startFakeBackend } from '../../helpers/fake-backend.mjs'

let backend: Awaited<ReturnType<typeof startFakeBackend>>
let fake: ReturnType<typeof createFakeContext>
let tools: CapturedTool[]

const JOB = {
  id: 'job-9',
  kind: 'headless',
  state: 'running',
  slot: 'cpu',
  priority: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  owner: { hostId: 'host-1', dshSessionId: 'ds-1', agentId: 'main' },
  queued_ahead: 2,
}

function tool(name: string): CapturedTool {
  const found = tools.find((x) => x.name === name)
  if (!found) throw new Error('missing tool ' + name)
  return found
}

async function run(name: string, args: Record<string, unknown>): Promise<any> {
  return await (tool(name).execute as any)(args, {})
}

function json(body: unknown) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  }
}

beforeAll(async () => {
  backend = await startFakeBackend()
  fake = createFakeContext()
  plugin.apply(fake.ctx, { autoStart: false, tui: false, port: backend.port })
  tools = fake.tools
})

afterAll(async () => {
  fake.dispose()
  await backend.close()
})

describe('blender_run structured receipts', () => {
  it('submit returns jobId/state/slot/queued_ahead and a receipt.v2 envelope', async () => {
    backend.setHandler('POST /job', () => json({ ok: true, op: 'submit', job: JOB }))
    const out = await run('blender_run', {
      action: 'submit',
      kind: 'headless',
      script: "print('PING')",
    })
    expect(out.jobId).toBe('job-9')
    expect(out.state).toBe('running')
    expect(out.slot).toBe('cpu')
    expect(out.queued_ahead).toBe(2)
    expect(out.envelope).toMatchObject({
      contract: 'receipt.v2',
      op: 'blender_run',
      action: 'submit',
      job_id: 'job-9',
      jobId: 'job-9',
      state: 'running',
      slot: 'cpu',
      queued_ahead: 2,
    })
    expect(out.envelope.next[0]).toEqual({
      op: 'blender_run',
      args: { action: 'wait', id: 'job-9' },
    })
    // 文本仍保留人类可读的 next 行（旧调用方不必立刻改）
    expect(out.text).toContain('next  blender_run action=wait id=job-9')
  })

  it('list returns structured rows and says where the queue is enumerated', async () => {
    backend.setHandler('POST /job', () => json({ ok: true, jobs: [JOB] }))
    const out = await run('blender_run', { action: 'list' })
    expect(out.count).toBe(1)
    expect(out.jobs[0]).toMatchObject({
      jobId: 'job-9',
      state: 'running',
      slot: 'cpu',
      owner: { dshSessionId: 'ds-1', agentId: 'main' },
    })
    expect(out.envelope).toMatchObject({ action: 'list', jobs_count: 1 })
    expect(out.text).toContain('RUN list · 1 个作业')
  })

  it('forwards still_running when a wait times out on a live job', async () => {
    backend.setHandler('POST /job', () =>
      json({
        ok: true,
        op: 'wait',
        job: { ...JOB, state: 'running' },
        waitedMs: 120000,
        waitTimedOut: true,
        still_running: true,
      }),
    )
    const out = await run('blender_run', { action: 'wait', id: 'job-9' })
    // Q-4：超时不是失败 —— 结构化回执要说清作业还在跑。
    expect(out.timed_out).toBe(true)
    expect(out.still_running).toBe(true)
    expect(out.waited_ms).toBe(120000)
    expect(out.state).toBe('running')
    expect(out.envelope).toMatchObject({ action: 'wait', job_id: 'job-9' })
    expect(out.text).toContain('仍在 running')
    backend.setHandler('POST /job')
  })

  it('reports still_running=false once the job reached a terminal state', async () => {
    backend.setHandler('POST /job', () =>
      json({
        ok: true,
        op: 'wait',
        job: { ...JOB, state: 'completed' },
        waitedMs: 1200,
        waitTimedOut: false,
      }),
    )
    const out = await run('blender_run', { action: 'wait', id: 'job-9' })
    expect(out.timed_out).toBe(false)
    expect(out.still_running).toBe(false)
    expect(out.state).toBe('completed')
    backend.setHandler('POST /job')
  })

  it('surfaces script_map on wait/collect with a one-line hint', async () => {
    const mapped = {
      ...JOB,
      state: 'completed',
      result: {
        exitCode: 0,
        signal: null,
        ms: 12,
        provenance: {
          script_map: { temp_path: 'C:/rt/tmp/dsh-job-x/job.py', source_path: 'C:/proj/user.py' },
        },
      },
      logs: { stdout: '', stderr: '' },
    }
    backend.setHandler('POST /job', () =>
      json({ ok: true, op: 'wait', job: mapped, waitedMs: 5, waitTimedOut: false }),
    )
    const wait = await run('blender_run', { action: 'wait', id: 'job-9' })
    expect(wait.script_map).toEqual({
      temp_path: 'C:/rt/tmp/dsh-job-x/job.py',
      source_path: 'C:/proj/user.py',
    })
    expect(wait.text).toContain('script_map')
    expect(wait.text).toContain('traceback')

    backend.setHandler('POST /job', () => json({ ok: true, op: 'collect', job: mapped }))
    const collect = await run('blender_run', { action: 'collect', id: 'job-9' })
    expect(collect.script_map).toEqual({
      temp_path: 'C:/rt/tmp/dsh-job-x/job.py',
      source_path: 'C:/proj/user.py',
    })
    expect(collect.text).toContain('script_map')
    backend.setHandler('POST /job')
  })

  it('omits script_map for a job that never used a temp script', async () => {
    backend.setHandler('POST /job', () =>
      json({ ok: true, op: 'wait', job: JOB, waitedMs: 5, waitTimedOut: false }),
    )
    const wait = await run('blender_run', { action: 'wait', id: 'job-9' })
    expect(wait).not.toHaveProperty('script_map')
    expect(wait.text).not.toContain('script_map')

    backend.setHandler('POST /job', () =>
      json({ ok: true, op: 'collect', job: { ...JOB, logs: { stdout: '', stderr: '' } } }),
    )
    const collect = await run('blender_run', { action: 'collect', id: 'job-9' })
    expect(collect).not.toHaveProperty('script_map')
    backend.setHandler('POST /job')
  })

  it('puts audit source/file_load/cleanup into the receipt envelope', () => {
    const env = planEnvelope('audit_mesh', {
      ok: true,
      verdict: 'pass',
      source: {
        mode: 'file',
        file: 'D:/proj/hats.blend',
        scene: 'Scene',
        scope: 'file',
        session_file: 'D:/proj/compare.blend',
        objects: ['a', 'b'],
      },
      file_load: { ok: true, path: 'D:/proj/hats.blend', loaded: 10, mesh: 9, non_mesh: 1 },
      cleanup: { ok: true, failed: [], removed: { libraries: ['x', 'y'], objects: ['a', 'b'] } },
    })
    expect((env.source as Record<string, unknown>).file).toBe('D:/proj/hats.blend')
    expect((env.source as Record<string, unknown>).session_file).toBe('D:/proj/compare.blend')
    expect((env.file_load as Record<string, unknown>).mesh).toBe(9)
    expect((env.cleanup as Record<string, unknown>).removed).toEqual({ libraries: 2, objects: 2 })
  })

  it('puts source/cleanup in the plan head line before a long body is truncated', async () => {
    const out = await finishPlanResponse(
      {} as never,
      'audit_mesh',
      {
        ok: true,
        verdict: 'pass',
        source: { mode: 'file', file: 'D:/proj/hats.blend', objects: ['a'] },
        cleanup: { ok: true, failed: [], removed: { libraries: ['x', 'y'] } },
      },
      {},
    )
    const head = String(out.text).split(String.fromCharCode(10))[0]
    expect(head).toContain('source=D:/proj/hats.blend')
    expect(head).toContain('cleanup=ok')
  })

  it('passes a structured catalog (format=json) through blender_op', async () => {
    backend.setHandler('POST /plan', () =>
      json({
        ok: true,
        result: {
          ok: true,
          op: 'catalog',
          format: 'json',
          text: 'CATALOG json · 1 families / 1 ops',
          ops_count: 1,
          families: [
            {
              id: 'audit',
              ops: [{ name: 'audit_mesh', needs_gui: false, headless: true, read_only: true }],
            },
          ],
          tools: [],
        },
      }),
    )
    const out = await run('blender_op', {
      action: 'plan',
      op: 'catalog',
      args: { format: 'json' },
    })
    expect(out.text).toContain('CATALOG json')
    expect(out.catalog.families[0].ops[0]).toMatchObject({
      name: 'audit_mesh',
      needs_gui: false,
      headless: true,
    })
    backend.setHandler('POST /plan')
  })
})
