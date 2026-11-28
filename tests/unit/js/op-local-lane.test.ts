/**
 * 无 GUI 本地车道：blender_op 在「没有 ready 会话 + 显式给 args.file + op 属于
 * 本地可执行白名单」时才把活交给 headless 作业，其余情况保持原样（session 门 / GUI 优先）。
 *
 * 三段：
 *   A. 主机车道（假 Gateway）：提交请求打到哪个 route、回执含 job_id、失败必须 degraded。
 *   B. 作业脚本驱动（纯逻辑，不起 Blender）：op 名 → preload 模块 + Python API 调用。
 *   C. 与生成的 routing 表对拍：白名单里的 op 解析出的 api/模块不允许漂移。
 *   D. 白名单单源：宿主常量 === runtime 常量 === config/local-ops.json（不再有第二份手写表）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as plugin from '../../../src/index'
import { LOCAL_OPS, LOCAL_PREFIXES, isLocalLaneOp } from '../../../src/tools/op/local'
import { buildJobArgs } from '../../../runtime/core/queue/job-args.js'
import type { JobRecord } from '../../../runtime/core/queue/types.js'
import {
  LOCAL_OP_NAMES,
  LOCAL_OP_PREFIXES,
  buildLocalOpJob,
  isLocalOp,
  localOpTarget,
} from '../../../runtime/execution/local-op/index.js'
import { createFakeContext, type CapturedTool } from '../../helpers/fake-context'
import { startFakeBackend } from '../../helpers/fake-backend.mjs'
import { pkgPath } from '../../helpers/pkg'

type Backend = Awaited<ReturnType<typeof startFakeBackend>>

let backend: Backend
let fake: ReturnType<typeof createFakeContext>
let tools: CapturedTool[]
let tmpDir = ''
let blendFile = ''

const NO_SESSION = () => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true, sessions: [] }),
})

function json(body: unknown) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function tool(name: string): CapturedTool {
  const found = tools.find((x) => x.name === name)
  if (!found) throw new Error('missing tool ' + name)
  return found
}

async function run(
  name: string,
  args: Record<string, unknown>,
  exec: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await (tool(name).execute as (...a: never[]) => unknown)(
    args as never,
    exec as never,
  )) as Record<string, unknown>
}

function textOf(out: Record<string, unknown>): string {
  return String(out.text ?? '')
}

function envelopeOf(out: Record<string, unknown>): Record<string, unknown> {
  return (out.envelope ?? {}) as Record<string, unknown>
}

function requestsSince(n: number): Array<Record<string, unknown>> {
  return backend.requests.slice(n) as Array<Record<string, unknown>>
}

function bodyOf(req: Record<string, unknown> | undefined): Record<string, unknown> {
  return (req?.body ?? {}) as Record<string, unknown>
}

function record(kind: 'headless', params: Record<string, unknown>): JobRecord {
  return {
    id: 'job-local-lane',
    kind,
    params,
    state: 'queued',
    priority: 0,
    slot: null,
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

beforeAll(async () => {
  backend = await startFakeBackend()
  fake = createFakeContext()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-lane-'))
  blendFile = path.join(tmpDir, 'scene.blend')
  fs.writeFileSync(blendFile, 'BLENDER-fake-scene')
  fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a blend')
  const attachments = {
    imageLimits: { mediaTypes: ['image/png'] },
    async saveImage({ data, name }: { data: Uint8Array; name: string }) {
      return {
        attachmentId: 'att-' + name,
        mediaType: 'image/png',
        bytes: data.length,
        width: 1,
        height: 1,
        name,
      }
    },
  }
  fake.ctx.get = ((name: string) => (name === 'attachments' ? attachments : undefined)) as never
  plugin.apply(fake.ctx, { autoStart: false, tui: false, port: backend.port })
  tools = fake.tools
})

afterEach(() => {
  backend.setHandler('POST /lease', null)
  backend.setHandler('POST /job', null)
  backend.setHandler('POST /plan', null)
})

afterAll(async () => {
  fake.dispose()
  await backend.close()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─────────────────────────── A. 主机车道 ───────────────────────────
describe('本地车道：无会话 + 白名单 op + file → headless 作业', () => {
  it('提交到作业队列并回 job_id 与取件方式', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    const out = await run('blender_op', {
      action: 'plan',
      op: 'audit_mesh',
      args: { file: blendFile, top: 5 },
    })
    const reqs = requestsSince(before)
    const job = reqs.find((r) => r.path === '/job')
    expect(job, '本地车道必须复用现有作业入口 /job').toBeTruthy()
    expect(bodyOf(job)).toMatchObject({
      surface: 'queue',
      op: 'submit',
      kind: 'headless',
      catalog_op: 'audit_mesh',
      file: blendFile,
    })
    // 车道保留 file= 给队列（先打开这个 .blend），不进 op 的 kwargs
    expect(bodyOf(job).op_args).toMatchObject({ top: 5 })
    expect(bodyOf(job).op_args).not.toHaveProperty('file')
    expect(
      reqs.some((r) => r.path === '/plan'),
      '没有会话就不该再打 /plan',
    ).toBe(false)

    const text = textOf(out)
    expect(text).toContain('job_id')
    expect(text).toContain('job-1')
    expect(text).toContain('blender_run')
    expect(text).toContain('degraded')
    expect(envelopeOf(out).job_id).toBe('job-1')
    expect(envelopeOf(out).verdict).toBe('degraded')
  })

  it('img_ 前缀的 op 同样命中车道', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    await run('blender_op', { action: 'plan', op: 'img_probe', args: { file: blendFile } })
    const job = requestsSince(before).find((r) => r.path === '/job')
    expect(bodyOf(job).catalog_op).toBe('img_probe')
  })

  it('白名单 op 但没有 file → 保持 session_required，不提交作业', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    const out = await run('blender_op', { action: 'plan', op: 'qc_render_views' })
    expect(textOf(out)).toContain('session_required')
    const reqs = requestsSince(before)
    expect(reqs.some((r) => r.path === '/job')).toBe(false)
  })

  it('非白名单 op 就算给了 file 也还是 session_required', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    const out = await run('blender_op', {
      action: 'plan',
      op: 'shape_solve',
      args: { file: blendFile },
    })
    expect(textOf(out)).toContain('session_required')
    expect(requestsSince(before).some((r) => r.path === '/job')).toBe(false)
  })

  it('file 不存在 → invalid_params，且不静默转 headless', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const missing = path.join(tmpDir, 'nope.blend')
    const before = backend.requests.length
    const out = await run('blender_op', {
      action: 'plan',
      op: 'audit_mesh',
      args: { file: missing },
    })
    const text = textOf(out)
    expect(text).toContain('invalid_params')
    expect(text).toContain('nope.blend')
    const reqs = requestsSince(before)
    expect(reqs.some((r) => r.path === '/job')).toBe(false)
    expect(reqs.some((r) => r.path === '/plan')).toBe(false)
  })

  it('file 不是 .blend → invalid_params', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    const out = await run('blender_op', {
      action: 'plan',
      op: 'audit_mesh',
      args: { file: path.join(tmpDir, 'notes.txt') },
    })
    expect(textOf(out)).toContain('invalid_params')
    expect(requestsSince(before).some((r) => r.path === '/job')).toBe(false)
  })

  it('作业提交失败 → verdict=degraded 且回执带 evidence', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    backend.setHandler('POST /job', () =>
      json({
        ok: false,
        op: 'submit',
        code: 'blender_exe_missing',
        stage: 'spawn',
        root_cause: '找不到 Blender 可执行文件',
        fix: '设置 DSH_BLENDER_EXE 或写 dsh-blender.config.json',
        evidence: { blenderExe: null },
      }),
    )
    const out = await run('blender_op', {
      action: 'plan',
      op: 'montage',
      args: { file: blendFile },
    })
    const envelope = envelopeOf(out)
    expect(envelope.verdict).toBe('degraded')
    expect(envelope.evidence).toMatchObject({
      verdict: 'degraded',
      op: 'montage',
      file: blendFile,
      stage: 'spawn',
    })
    const text = textOf(out)
    expect(text).toContain('degraded')
    expect(text).toContain('blender_exe_missing')
    expect(text).not.toContain('ok ·')
  })

  it('有 ready 会话时仍走 GUI（/plan），车道不抢', async () => {
    const before = backend.requests.length
    await run('blender_op', { action: 'plan', op: 'audit_mesh', args: { file: blendFile } })
    const reqs = requestsSince(before)
    expect(reqs.some((r) => r.path === '/plan')).toBe(true)
    expect(reqs.some((r) => r.path === '/job')).toBe(false)
  })

  it('headless=true 时有 ready 会话也强制走无头作业（并发不抢 GUI）', async () => {
    const before = backend.requests.length
    const out = await run('blender_op', {
      action: 'plan',
      op: 'audit_mesh',
      args: { file: blendFile },
      headless: true,
    })
    const reqs = requestsSince(before)
    const job = reqs.find((r) => r.path === '/job')
    expect(job, '显式 headless=true 必须提交作业').toBeTruthy()
    expect(bodyOf(job).catalog_op).toBe('audit_mesh')
    expect(reqs.some((r) => r.path === '/plan')).toBe(false)
    expect(envelopeOf(out).provenance).toMatchObject({ forced: true })
    expect(textOf(out)).toContain('显式 headless=true')
  })

  it('headless=true 但缺 file / 非白名单 op → invalid_params，不提交作业', async () => {
    const before = backend.requests.length
    const noFile = await run('blender_op', { action: 'plan', op: 'audit_mesh', headless: true })
    expect(textOf(noFile)).toContain('headless=true 需要 args.file')
    const notLane = await run('blender_op', {
      action: 'plan',
      op: 'shape_solve',
      args: { file: blendFile },
      headless: true,
    })
    expect(textOf(notLane)).toContain('白名单')
    const reqs = requestsSince(before)
    expect(reqs.some((r) => r.path === '/job')).toBe(false)
  })

  it('args.dry_run=true 不走车道（dry run 不是执行）', async () => {
    backend.setHandler('POST /lease', NO_SESSION)
    const before = backend.requests.length
    await run('blender_op', {
      action: 'plan',
      op: 'audit_mesh',
      args: { file: blendFile, dry_run: true },
    })
    const reqs = requestsSince(before)
    expect(reqs.some((r) => r.path === '/plan')).toBe(true)
    expect(reqs.some((r) => r.path === '/job')).toBe(false)
  })
})

// ─────────────────────── B. 作业脚本驱动 ───────────────────────
describe('本地车道：op 名 → preload 模块 + Python API 调用', () => {
  it('audit_mesh 走 audit 模块的 dispatch("mesh")', () => {
    const built = buildLocalOpJob({
      catalog_op: 'audit_mesh',
      file: blendFile,
      op_args: { top: 5 },
    })
    expect(built.preloads).toEqual(['audit'])
    expect(built.script).toContain('dsh_audit_api')
    expect(built.script).toContain('"mesh"')
    expect(built.script).toContain('HEADLESS ')
    expect(built.script).toContain('"audit_mesh"')
    // file 原文进脚本（JSON 字面量，Windows 反斜杠成对）
    expect(built.script).toContain(JSON.stringify(blendFile))
  })

  it('montage 走显式 API 调用并预载 montage 模块', () => {
    const built = buildLocalOpJob({
      catalog_op: 'montage',
      file: blendFile,
      op_args: { paths: ['a.png'] },
    })
    expect(built.preloads).toEqual(['montage'])
    expect(built.script).toContain('dsh_montage_api')
    expect(built.script).toContain('"montage"')
  })

  it('qc_render_views 走 qc_render 的 render_views 分发', () => {
    const built = buildLocalOpJob({
      catalog_op: 'qc_render_views',
      file: blendFile,
      op_args: { views: 4 },
    })
    expect(built.preloads).toEqual(['qc', 'qc_render'])
    expect(built.script).toContain('dsh_qc_render_api')
    expect(built.script).toContain('"render_views"')
  })

  it('未知 op 明确报错（不静默）', () => {
    expect(() => buildLocalOpJob({ catalog_op: 'nope_not_an_op', file: blendFile })).toThrow(
      /catalog_op|不在本地车道/,
    )
  })

  it('缺 file 明确报错', () => {
    expect(() => buildLocalOpJob({ catalog_op: 'audit_mesh' })).toThrow(/file/)
  })

  it('保留键 file / dry_run 不进 op 的 kwargs', () => {
    const built = buildLocalOpJob({
      catalog_op: 'audit_mesh',
      file: blendFile,
      op_args: { file: 'other.blend', dry_run: true, top: 5 },
    })
    // op_args 内联成 JSON 字面量（引号被转义），这里只钉"该留的留、该剥的剥"
    expect(built.script).toContain('top')
    expect(built.script).not.toContain('other.blend')
    expect(built.script).not.toContain('dry_run')
  })

  it('op_args 不是对象时明确报错', () => {
    expect(() =>
      buildLocalOpJob({ catalog_op: 'audit_mesh', file: blendFile, op_args: 'nope' }),
    ).toThrow(/op_args/)
  })

  it('buildJobArgs 把 catalog_op 展开成 job.py（前导 + preload + 驱动）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-driver-'))
    try {
      const built = buildJobArgs(
        record('headless', {
          file: blendFile,
          catalog_op: 'audit_mesh',
          op_args: { top: 5 },
        }),
        dir,
      )
      const pythons = built.args.filter((a, i) => built.args[i - 1] === '--python')
      expect(pythons).toHaveLength(1)
      const body = fs.readFileSync(pythons[0], 'utf8')
      expect(body).toContain('dsh_rt_kernel')
      expect(body).toContain('preload audit.py')
      expect(body).toContain('dsh_audit_api')
      expect(body).toContain('HEADLESS ')
      expect(built.preloads).toEqual(['audit'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────── C. 与生成的 routing 表对拍 ──────────────────
describe('白名单与 routing 表对拍（漂移即失败）', () => {
  const EXPECTED: Array<[string, string, string]> = [
    ['audit_mesh', 'dsh_audit_api', 'audit'],
    ['img_digest', 'dsh_img_api', 'imgtools'],
    ['img_probe', 'dsh_img_api', 'imgtools'],
    ['img_measure', 'dsh_img_api', 'imgtools'],
    ['img_calib', 'dsh_img_api', 'imgtools'],
    ['visualreport_report', 'dsh_visualreport_api', 'visualreport,qc,imgtools'],
    ['qc_render_views', 'dsh_qc_render_api', 'qc,qc_render'],
    ['montage', 'dsh_montage_api', 'montage'],
  ]

  it.each(EXPECTED)('%s 的 api/preload 与 config/routing.json 生成表一致', (op, api, preload) => {
    expect(LOCAL_OP_NAMES).toContain(op)
    const target = localOpTarget(op)
    expect(target, op).toBeTruthy()
    expect(target?.api).toBe(api)
    expect((target?.preload ?? []).join(',')).toBe(preload)
  })

  it('白名单只认列出的名字与 img_ 前缀', () => {
    expect(isLocalOp('audit_mesh')).toBe(true)
    expect(isLocalOp('img_probe')).toBe(true)
    expect(isLocalOp('shape_solve')).toBe(false)
    expect(isLocalOp('audit_clash_all')).toBe(false)
    expect(isLocalOp('montage')).toBe(true)
  })
})

// ──────────────── D. 白名单单源（config → 两份生成物） ────────────────
describe('白名单单源：config/local-ops.json → runtime + 宿主', () => {
  interface LocalOpsConfig {
    version: number
    ops: string[]
    prefixes: string[]
  }
  const CONFIG = JSON.parse(
    fs.readFileSync(pkgPath('config', 'local-ops.json'), 'utf8'),
  ) as LocalOpsConfig

  it('config 是唯一真源：version 1 + 8 个 op + img_ 前缀', () => {
    expect(CONFIG.version).toBe(1)
    expect(CONFIG.ops).toHaveLength(8)
    expect(CONFIG.prefixes).toEqual(['img_'])
  })

  it('runtime 常量 === 宿主常量 === config（不再比两份手写表）', () => {
    expect([...LOCAL_OP_NAMES]).toEqual(CONFIG.ops)
    expect([...LOCAL_OPS]).toEqual(CONFIG.ops)
    expect([...LOCAL_OPS]).toEqual([...LOCAL_OP_NAMES])
    expect([...LOCAL_OP_PREFIXES]).toEqual(CONFIG.prefixes)
    expect([...LOCAL_PREFIXES]).toEqual(CONFIG.prefixes)
  })

  it('宿主判定与 runtime 判定逐个名字一致', () => {
    const names = [
      ...CONFIG.ops,
      ...CONFIG.prefixes.map((prefix) => prefix + 'anything'),
      'shape_solve',
      '',
      '   ',
      ' audit_mesh ',
    ]
    for (const name of names) expect(isLocalLaneOp(name), name).toBe(isLocalOp(name))
  })
})
