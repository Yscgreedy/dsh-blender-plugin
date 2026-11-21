/**
 * blender_py 的 outcome_unknown 与执行前回退点（3.2.0-alpha.1）。
 *
 * 现场：/act 的客户端等待是 180 s。超时或 addon 掉线时脚本**还在 Blender 里跑**，
 * 宿主只回一句通用错误，模型重试 → 场景里多出重复材质/节点，而 audit_mesh 不报
 * （那不是 mesh 缺陷）。这个文件钉住四件事：
 *   ① 超时/断连回 outcome_unknown，带 host 侧 request_id 与 checkpoint，不谎称"失败"；
 *   ② checkpoint=auto（默认）在执行前先走 session txn 的 /txn snapshot，off 时一个快照请求都不发；
 *   ③ 快照失败不挡用户这次编辑：照常 /act，回执里告警并写 checkpoint=none；
 *   ④ 成功回执写 outcome=complete + request_id + checkpoint，给事后追查留锚点。
 *
 * http 层整体打桩（和 worker-receipt.test.ts 同一套写法）：这里测的是工具层判据，
 * 不是传输层；超时/断连用"抛错"模拟，不真的等 180 s。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXEC_CTX } from '../../../src/host/exec-context.js'

type PostBody = Record<string, unknown>
type Reply = PostBody | Error | ((body: PostBody) => PostBody)

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
      if (next instanceof Error) throw next
      if (typeof next === 'function') return (next as (b: PostBody) => PostBody)(body)
      return next as PostBody
    },
  ),
  backendJson: vi.fn(),
  fetchFrame: vi.fn(async () => ({ png: new Uint8Array([0]), ms: 2, hash: 'deadbeef' })),
  leasedText: (r: unknown) =>
    (r as PostBody | null)?.error === 'leased'
      ? '写通道被别的会话占用（holder=sess-9，剩余 30s）。'
      : undefined,
  jsonPayload: (v: unknown) => v,
}))

vi.mock('../../../src/utils/image.js', () => ({
  toAttachment: async () => ({ ref: { attachmentId: 'att-py-1' }, why: '' }),
}))

import { executePy } from '../../../src/tools/py/execute.js'

const fakeCtx = { get: () => undefined } as unknown as Parameters<typeof executePy>[0]
const SESSION = { id: 'sess-1' }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

function reply(...items: Reply[]): void {
  h.replies.push(...items)
}

/** 后端 /txn snapshot 的真实回执形状（label 由调用方给，后端回声）。 */
function snapshotReply(body: PostBody): PostBody {
  const args = (body.args || {}) as PostBody
  const label = String(args.label || '')
  return {
    ok: true,
    op: 'snapshot',
    result: {
      ok: true,
      snapshot: { label, path: '/tmp/snap/' + label + '.blend', bytes: 2048, ms: 21, objects: 7 },
      total: 1,
    },
  }
}

function actOk(extra: PostBody = {}): PostBody {
  return { ok: true, ms: 12, mainThreadMs: 3, stdout: 'done', ...extra }
}

function receipt(out: unknown): string {
  return String((out as { text?: unknown } | null)?.text ?? '')
}

function envelopeOf(out: unknown): Record<string, unknown> {
  return ((out as { envelope?: Record<string, unknown> } | null)?.envelope || {}) as Record<
    string,
    unknown
  >
}

function failCode(out: unknown): unknown {
  return (envelopeOf(out).error as Record<string, unknown> | undefined)?.code
}

function sentLabel(index: number): string {
  const args = (h.calls[index].body.args || {}) as PostBody
  return String(args.label || '')
}

function sentNote(index: number): string {
  const args = (h.calls[index].body.args || {}) as PostBody
  return String(args.note || '')
}

beforeEach(() => {
  h.replies.length = 0
  h.calls.length = 0
})

describe('outcome_unknown：客户端等待结束 ≠ 脚本失败', () => {
  it('超时：回 outcome_unknown + request_id + checkpoint，并说清"结果未知"', async () => {
    reply(snapshotReply, new Error('This operation was aborted'))
    const out = await executePy(fakeCtx, 1, { code: 'add_cube()', see: false }, SESSION)
    const text = receipt(out)

    // 判据：机器可读的 code 是 outcome_unknown（不是 py_error）
    expect(failCode(out)).toBe('outcome_unknown')
    expect(text).toContain('code: outcome_unknown')
    expect(text).not.toContain('PY 执行失败')

    // 锚点：host 侧生成的 request_id + 本次执行前回退点
    const label = sentLabel(0)
    expect(label).toMatch(/^py-[0-9a-f]{8}$/)
    expect(text).toMatch(UUID)
    expect(text).toContain('request_id=')
    expect(text).toContain('checkpoint=' + label)
    expect(envelopeOf(out).evidence).toMatchObject({ request_id: expect.stringMatching(UUID) })
    // 回执里的 request_id 与 envelope 里的是同一个
    const inText = String(text.split('request_id=')[1].split('\n')[0].trim())
    expect((envelopeOf(out).evidence as Record<string, unknown>).request_id).toBe(inText)

    // 可执行的下一步：先看现场、能退回一步、别直接重跑
    expect(text).toContain('blender_inspect command=get_scene_info')
    expect(text).toContain('action=txn op=restore label=' + label)
    expect(text).toContain('next_action:')

    // 顺序是语义：先留回退点，再执行；/act 的等待窗口仍是 180 s
    expect(h.calls.map((c) => c.path)).toEqual(['/txn', '/act'])
    expect(h.calls[0].body).toMatchObject({ op: 'snapshot' })
    expect(sentNote(0)).toContain('request_id=')
    expect(h.calls[1].timeoutMs).toBe(180000)
    expect(h.calls[1].body).toMatchObject({ code: 'add_cube()', py: true, sessionId: 'sess-1' })
  })

  it('断连（非超时的网络错误）：同样按结果未知回报，不写成 py_error', async () => {
    reply(snapshotReply, new Error('socket hang up'))
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    expect(failCode(out)).toBe('outcome_unknown')
    expect(receipt(out)).toContain('socket hang up')
    expect(receipt(out)).toContain('checkpoint=' + sentLabel(0))
  })

  it('没有回退点（checkpoint=off）时回执说 checkpoint=off，而不是假装有', async () => {
    reply(new Error('This operation was aborted'))
    const out = await executePy(
      fakeCtx,
      1,
      { code: 'x = 1', see: false, checkpoint: 'off' },
      SESSION,
    )
    expect(h.calls.map((c) => c.path)).toEqual(['/act'])
    expect(receipt(out)).toContain('checkpoint=off')
    expect(receipt(out)).not.toContain('action=txn op=restore')
  })

  it('宿主取消仍然上抛：取消不是"结果未知"，不能写成工具结果', async () => {
    const ac = new AbortController()
    ac.abort()
    reply(new Error('宿主取消了本次等待（exec.signal abort）'))
    await expect(
      EXEC_CTX.run({ signal: ac.signal }, () =>
        executePy(fakeCtx, 1, { code: 'x = 1', see: false, checkpoint: 'off' }, SESSION),
      ),
    ).rejects.toThrow(/宿主取消/)
    expect(failCode(undefined)).toBeUndefined()
  })
})

describe('执行前回退点：checkpoint=auto / off', () => {
  it('默认 auto：先 snapshot 再 /act，成功回执带 outcome=complete + request_id + label', async () => {
    reply(snapshotReply, actOk())
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    const text = receipt(out)
    const label = sentLabel(0)

    expect(text.split(String.fromCharCode(10))[0]).toBe('PY ok · 12ms')
    expect(text).toContain('outcome=complete')
    expect(text).toMatch(/request_id=[0-9a-f-]{36}/)
    expect(text).toContain('checkpoint=' + label)
    expect(text).not.toContain('code:')
    expect(text).not.toContain('⚠️ checkpoint')

    expect(h.calls.map((c) => c.path)).toEqual(['/txn', '/act'])
    expect(h.calls[0].body).toMatchObject({ op: 'snapshot' })
    expect(h.calls[0].timeoutMs).toBeLessThan(180000) // 快照有自己的有界窗口，不吃 /act 的预算
    // 同一次调用里 request_id 与 label 同源
    expect(sentNote(0)).toContain('request_id=' + text.split('request_id=')[1].split(' ·')[0])
  })

  it('checkpoint=off：一个 /txn 都不发，回执写 checkpoint=off', async () => {
    reply(actOk())
    const out = await executePy(
      fakeCtx,
      1,
      { code: 'x = 1', see: false, checkpoint: 'off' },
      SESSION,
    )
    expect(h.calls.map((c) => c.path)).toEqual(['/act'])
    expect(receipt(out)).toContain('outcome=complete')
    expect(receipt(out)).toContain('checkpoint=off')
  })

  it('快照失败（前端 ok:false）不挡这次编辑：照常 /act，回执告警 + checkpoint=none', async () => {
    reply({ ok: false, op: 'snapshot', error: 'OSError: 快照目录不可写' }, actOk())
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    const text = receipt(out)
    expect(h.calls.map((c) => c.path)).toEqual(['/txn', '/act'])
    expect(text).toContain('outcome=complete')
    expect(text).toContain('checkpoint=none')
    expect(text).toContain('⚠️ checkpoint 没建成')
    expect(text).toContain('快照目录不可写')
    expect(text).not.toContain('code:')
  })

  it('快照自己超时也不挡：照常执行，只告警', async () => {
    reply(new Error('This operation was aborted'), actOk())
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    expect(h.calls.map((c) => c.path)).toEqual(['/txn', '/act'])
    expect(receipt(out)).toContain('checkpoint=none')
    expect(receipt(out)).toContain('⚠️ checkpoint 没建成')
    expect(receipt(out)).toContain('outcome=complete')
  })

  it('写通道被占用（leased）只是告警：脚本照跑', async () => {
    reply({ ok: false, error: 'leased', holder: 'sess-9', expiresInMs: 30000 }, actOk())
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    expect(h.calls.map((c) => c.path)).toEqual(['/txn', '/act'])
    expect(receipt(out)).toContain('checkpoint=none')
    expect(receipt(out)).toContain('写通道被别的会话占用')
  })
})

describe('既有行为不回退', () => {
  it('脚本报错仍是 py_error（不被 outcome_unknown 吞掉）', async () => {
    reply(snapshotReply, {
      ok: false,
      error: 'Traceback (most recent call last):\n  File "x.py", line 1',
      traceback: 'Traceback (most recent call last):\n  File "x.py", line 1',
    })
    const out = await executePy(fakeCtx, 1, { code: 'boom()', see: false }, SESSION)
    expect(failCode(out)).toBe('py_error')
    expect(receipt(out)).toContain('PY 执行失败')
    expect(receipt(out)).not.toContain('outcome_unknown')
  })

  it('/act 回 409 leased 时保持原来的文案（不改成 outcome_unknown）', async () => {
    reply(snapshotReply, { ok: false, error: 'leased', holder: 'sess-9', expiresInMs: 30000 })
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', see: false }, SESSION)
    expect(receipt(out)).toContain('写通道被别的会话占用')
    expect(failCode(out)).toBeUndefined()
  })

  it('see 默认仍然回帧，并在回执里带 outcome=complete', async () => {
    reply(snapshotReply, actOk())
    const out = await executePy(fakeCtx, 1, { code: 'x = 1' }, SESSION)
    expect((out as { image?: { attachmentId?: string } }).image?.attachmentId).toBe('att-py-1')
    expect(receipt(out)).toContain('SEE 560px')
    expect(receipt(out)).toContain('outcome=complete')
  })

  it('wait_ms 原样进 /act（py 锁的等待语义不变）', async () => {
    reply(snapshotReply, actOk())
    await executePy(fakeCtx, 1, { code: 'x = 1', see: false, wait_ms: 2500 }, SESSION)
    expect(h.calls[1].body).toMatchObject({ waitMs: 2500 })
  })

  it('非法 checkpoint 值：invalid_params，一个网络请求都不发', async () => {
    const out = await executePy(fakeCtx, 1, { code: 'x = 1', checkpoint: 'sometimes' }, SESSION)
    expect(failCode(out)).toBe('invalid_params')
    expect(receipt(out)).toContain('checkpoint')
    expect(h.calls.length).toBe(0)
  })
})

describe('gate receipts：session 门禁不压成 py_error', () => {
  it('keeps session_in_use + caller/owner/grant ids when /act is refused', async () => {
    reply(snapshotReply, {
      ok: false,
      code: 'session_in_use',
      root_cause: 'another DSH session owns this GUI session (is_mine=false)',
      fix: 'ask the owner for a grant',
      evidence: {
        caller: { agentId: 'verify-agent-2', dshSessionId: 'dsh-child' },
        sessionId: 'user-gui:inst-1',
        owner_agent: 'session-b6c62cb2',
        required_scope: [{ kind: 'collection', value: '_probe_grant' }],
        grant_holders: [{ agentId: 'verify-agent-2' }],
      },
    })
    const out = await executePy(
      fakeCtx,
      1,
      { code: 'print(1)', checkpoint: 'auto', see: false },
      SESSION,
    )
    expect(failCode(out)).toBe('session_in_use')
    const text = receipt(out)
    expect(text).toContain('PY 未执行')
    expect(text).toContain('code: session_in_use')
    expect(text).not.toContain('PY 执行失败 · unknown')
    expect(JSON.stringify(envelopeOf(out))).toContain('verify-agent-2')
    expect(JSON.stringify(envelopeOf(out))).toContain('session-b6c62cb2')
    // 反馈 5：detail 会被截断；完整身份必须在顶层。
    const top = out as Record<string, unknown>
    expect(top.caller_agent_id).toBe('verify-agent-2')
    expect((top.caller as Record<string, unknown>).dshSessionId).toBe('dsh-child')
    expect(top.owner_agent).toBe('session-b6c62cb2')
    expect(top.session_id).toBe('user-gui:inst-1')
    expect(top.required_scope).toEqual([{ kind: 'collection', value: '_probe_grant' }])
    expect(Array.isArray(top.grant_holders)).toBe(true)
    const env = envelopeOf(out) as Record<string, unknown>
    expect((env.evidence as Record<string, unknown>).caller_agent_id).toBe('verify-agent-2')
    expect(String((env.error as Record<string, unknown>).detail)).toContain('verify-agent-2')
  })
})

describe('scope failure receipt', () => {
  it('promotes changed / scope_violations / rollback fields to the top level', async () => {
    reply(snapshotReply, {
      ok: false,
      errorKind: 'scope_violation',
      error:
        'scope_violation: 1 个改动对象不在 grant 声明的写作用域内：_outside；已回滚新建对象: _outside',
      changed: true,
      faces_delta: 0,
      scope_violations: ['_outside'],
      rolled_back: ['_outside'],
      unrolled: [],
      purged_meshes: ['_outside_mesh'],
      purged_materials: [],
      rollback_complete: true,
    })
    const out = (await executePy(
      fakeCtx,
      1,
      { code: 'mk()', checkpoint: 'auto', see: false },
      SESSION,
    )) as Record<string, unknown>
    expect((out.envelope as Record<string, unknown>).error).toMatchObject({
      code: 'scope_violation',
    })
    expect(out.scope_violations).toEqual(['_outside'])
    expect(out.rolled_back).toEqual(['_outside'])
    expect(out.unrolled).toEqual([])
    expect(out.purged_meshes).toEqual(['_outside_mesh'])
    const env = envelopeOf(out) as Record<string, unknown>
    expect((env.evidence as Record<string, unknown>).scope_violations).toEqual(['_outside'])
    expect(String((env.error as Record<string, unknown>).detail)).toContain('_outside')
    expect(out.rollback_complete).toBe(true)
    expect(out.changed).toBe(true)
  })
})
