/**
 * lossless 返回通道：任何出口值都必须过得了宿主的 lossless-JSON 门。
 *
 * v0.9.4 起这里验的是「本插件自己的回执构造器」；断言对象是**生产**那两个构造点：
 * src/tools/receipt.ts（成功面：receiptV2 / withEvidence / deriveVerdict）
 * 与 src/tools/errors.ts（失败面：toolError）。
 * 保证不变：本插件任何一个回执都过得了 snapshotJsonValue。
 */
import { describe, expect, it } from 'vitest'
import * as plugin from '../../../../src/index'
import { asRecord } from '../../../../src/contracts/dynamic'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import {
  RECEIPT_CONTRACT,
  deriveVerdict,
  receiptV2,
  withEvidence,
} from '../../../../src/tools/receipt.js'
import { toolError } from '../../../../src/tools/errors.js'

const { losslessSanitize } = plugin.__internals

function hasUndefined(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((v) => hasUndefined(v, seen))
  return Object.values(value as Record<string, unknown>).some((v) => hasUndefined(v, seen))
}

describe('lossless return channel', () => {
  it('removes or normalizes every non-lossless JSON value', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const { value, fixes } = losslessSanitize({
      undef: undefined,
      nan: NaN,
      inf: Infinity,
      list: [1, undefined, 2],
      big: 1n,
      fn: () => 1,
      circular,
    })
    expect(fixes.length).toBeGreaterThan(0)
    expect(hasUndefined(value)).toBe(false)
    expect(() => snapshotJsonValue(value)).not.toThrow()
    expect(JSON.stringify(value)).not.toContain('undefined')
  })

  it('keeps the production receipt envelope free of undefined keys', () => {
    const envelope = receiptV2({
      ok: true,
      status: 'done',
      resultJson: { a: undefined, b: 1 },
      ms: undefined,
      evidence: { code: 'inherited', stage: 'run', keep: 'yes' },
    })
    const merged = withEvidence(envelope, { code: 'explicit', job_id: 'job-1' })

    // 契约名由构造器固定，而且必须是第一个键（字段顺序也是契约）
    expect(Object.keys(merged)[0]).toBe('contract')
    expect(merged.contract).toBe(RECEIPT_CONTRACT)
    expect(RECEIPT_CONTRACT).toBe('receipt.v2')
    // 显式 evidence 覆盖继承的同名键，继承来的其它键保留
    expect(merged.evidence).toEqual({
      code: 'explicit',
      stage: 'run',
      keep: 'yes',
      job_id: 'job-1',
    })
    // 纯构造器产物（入参不含 undefined）本身就已 lossless
    expect(hasUndefined(receiptV2({ ok: true, notes: [] }))).toBe(false)

    // 含 undefined 的入参：出口消毒器是唯一放行门
    expect(hasUndefined(merged)).toBe(true)
    const clean = asRecord(losslessSanitize(merged).value)
    const resultJson = asRecord(clean.resultJson)
    expect(clean.contract).toBe(RECEIPT_CONTRACT)
    expect(asRecord(clean.evidence).code).toBe('explicit')
    expect(hasUndefined(clean)).toBe(false)
    expect(() => snapshotJsonValue(clean)).not.toThrow()
    expect(resultJson.b).toBe(1)
    expect(resultJson.a).toBeUndefined()
  })

  it('keeps a failed tool receipt lossless, with verdict and evidence', () => {
    const failure = toolError(
      'job_submit_failed',
      'HEADLESS 转作业层失败 · gateway closed',
      'blender_session action=doctor 检查 Gateway，或 blender_run action=list 看作业是否已建',
    )
    // 生产失败回执的形状：toolError 的 envelope → receiptV2 补 verdict → withEvidence 并车道证据
    const envelope = withEvidence(
      receiptV2({ ...failure.envelope, verdict: deriveVerdict({ ok: false, degraded: true }) }),
      { file: 'a.blend', stage: 'queue', error: 'gateway closed' },
    )

    expect(hasUndefined(failure)).toBe(false)
    expect(hasUndefined(envelope)).toBe(false)
    expect(() => snapshotJsonValue(failure)).not.toThrow()
    expect(() => snapshotJsonValue(envelope)).not.toThrow()

    expect(envelope.contract).toBe(RECEIPT_CONTRACT)
    expect(envelope.verdict).toBe('degraded')
    expect(String(envelope.code)).toBe('job_submit_failed')
    const evidence = asRecord(envelope.evidence)
    expect(evidence.code).toBe('job_submit_failed')
    expect(evidence.file).toBe('a.blend')
    expect(evidence.stage).toBe('queue')

    const clean = asRecord(losslessSanitize(envelope).value)
    expect(asRecord(clean.evidence).file).toBe('a.blend')
    expect(() => snapshotJsonValue(clean)).not.toThrow()
  })

  it('derives the three-state verdict from what was actually observed', () => {
    // 作业已提交、结果没取回 —— 结果在作业里，本回执不是 pass
    expect(deriveVerdict({ ok: true, job: { status: 'queued' } })).toBe('degraded')
    expect(deriveVerdict({ ok: true, job: { status: 'running' } })).toBe('degraded')
    // 作业失败态是有证据的失败
    expect(deriveVerdict({ ok: true, job: { status: 'failed' } })).toBe('fail')
    expect(deriveVerdict({ job: { state: 'canceled' } })).toBe('fail')
    expect(deriveVerdict({ ok: false })).toBe('fail')
    expect(deriveVerdict({ ok: true })).toBe('pass')
    // 没观察到任何事实时不许默认成功
    expect(deriveVerdict({})).toBe(null)
  })
})
