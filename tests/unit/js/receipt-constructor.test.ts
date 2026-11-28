/**
 * 唯一回执构造器（src/tools/receipt.ts）：三态判定 + 信封 + 证据合并。
 *
 * 6 处手写回执收成 1 处之后，判据与字段顺序都靠这条测试锁住 —— 回执是模型与脚本**唯一**的
 * 验收面，字节变了就等于契约变了。
 */
import { describe, expect, it } from 'vitest'
import {
  RECEIPT_CONTRACT,
  deriveVerdict,
  receiptV2,
  withEvidence,
} from '../../../src/tools/receipt.js'

describe('deriveVerdict：三态判定只有一处', () => {
  it('显式降级优先：作业没建立不是「证据证明失败」', () => {
    expect(deriveVerdict({ ok: false, degraded: true })).toBe('degraded')
  })

  it('有作业句柄就降级：结果在作业里，本回执不下 pass（连空对象也算）', () => {
    expect(deriveVerdict({ ok: true, job: { state: 'queued' } })).toBe('degraded')
    expect(deriveVerdict({ ok: true, job: { state: 'running' } })).toBe('degraded')
    expect(deriveVerdict({ ok: true, job: { state: 'completed' } })).toBe('degraded')
    // 只回了顶层 jobId、没有 job 对象时同样不许当 pass
    expect(deriveVerdict({ ok: true, job: {} })).toBe('degraded')
  })

  it('作业失败/取消/丢失 → fail（这一条有证据）', () => {
    for (const state of ['failed', 'canceled', 'cancelled', 'lost', 'error', 'timeout'])
      expect(deriveVerdict({ ok: true, job: { state } })).toBe('fail')
    expect(deriveVerdict({ job: { status: 'FAILED' } })).toBe('fail')
  })

  it('通道回执照抄：degraded 不是 pass，也不谎报 fail', () => {
    expect(deriveVerdict({ channels: { verdict: 'degraded' } })).toBe('degraded')
    expect(deriveVerdict({ channels: { verdict: 'fail' } })).toBe('fail')
    expect(deriveVerdict({ ok: true, channels: { verdict: 'pass' } })).toBe('pass')
  })

  it('ok 是最后一条判据；什么都没有就说「还没判」（不许默认成功）', () => {
    expect(deriveVerdict({ ok: true })).toBe('pass')
    expect(deriveVerdict({ ok: false })).toBe('fail')
    expect(deriveVerdict({})).toBe(null)
    expect(deriveVerdict()).toBe(null)
  })
})

describe('receiptV2：信封字节由构造器定', () => {
  it('contract 打头、其余按调用方键序（顺序也是契约）', () => {
    const env = receiptV2({ op: 'blender_run', action: 'submit', verdict: null, job_id: 'job-1' })
    expect(Object.keys(env)).toEqual(['contract', 'op', 'action', 'verdict', 'job_id'])
    expect(env.contract).toBe(RECEIPT_CONTRACT)
  })

  it('调用方写的 contract 被忽略（契约名只有一份）', () => {
    const env = receiptV2({ contract: 'legacy.v0', op: 'x' })
    expect(env.contract).toBe(RECEIPT_CONTRACT)
    expect(Object.keys(env)).toEqual(['contract', 'op'])
  })

  it('空信封只有 contract，不会凭空多字段', () => {
    expect(receiptV2()).toEqual({ contract: RECEIPT_CONTRACT })
  })
})

describe('withEvidence：合并而不是覆盖', () => {
  it('继承来的键保留，显式给的同名键赢', () => {
    const base = {
      contract: RECEIPT_CONTRACT,
      error: { code: 'job_submit_failed' },
      evidence: { code: 'job_submit_failed', stage: 'queue' },
    }
    const out = withEvidence(base, { stage: 'config', file: 'a.blend' })
    expect(out.evidence).toEqual({ code: 'job_submit_failed', stage: 'config', file: 'a.blend' })
    expect(out.error).toEqual({ code: 'job_submit_failed' })
  })

  it('没有 evidence 区块时新建一块，原有字段不动', () => {
    expect(withEvidence({ ok: false }, { code: 'y' })).toEqual({
      ok: false,
      evidence: { code: 'y' },
    })
  })
})
