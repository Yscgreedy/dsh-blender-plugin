/**
 * 唯一回执构造器：三态判定（deriveVerdict）+ 信封（receiptV2）+ 证据合并（withEvidence）。
 *
 * 为什么必须只有一个：同一个契约原来散在 6 处手写（op/local 两处、run/presenter 三处、
 * op/plan-response 一处），任何一处改了字段名或顺序，按旧键解析的下游脚本就静默失效 ——
 * 而回执是模型与脚本**唯一**的验收面。字段顺序也是契约，所以构造器只固定 contract 打头，
 * 其余按调用方给的键序（字节兼容靠这一条）。
 *
 * 本文件是**唯一**回执构造器：成功回执由调用点用 receiptV2 起头、withEvidence 并证据；
 * 失败回执先用 src/tools/errors.ts 的 toolError 拿 envelope，再并进同一个 receipt.v2 形状。
 * 它也不经过 plugin.ts 的 __internals —— 测试直接 import 本模块。
 */
import { asRecord } from '../contracts/dynamic.js'

/** 信封契约名（唯一定义点；调用方不再手写）。 */
export const RECEIPT_CONTRACT = 'receipt.v2'

/** 三态判定：degraded 不是 pass，也不冒充 fail。 */
export type ReceiptVerdict = 'pass' | 'fail' | 'degraded'

/** 判定输入：只放**已经观察到的事实**，不要放「希望它是 pass」。 */
export interface VerdictInput {
  /** 业务成功位：false = 明确失败；true / 省略 = 还没失败 */
  ok?: unknown
  /** 调用方已经知道的降级事实（作业没建立、结果没取回、证据不全…） */
  degraded?: unknown
  /** 通道回执（render channels）：verdict=fail/degraded 直接带过来 */
  channels?: unknown
  /** 作业记录：有句柄就说明结果在作业里，本回执不是判据 */
  job?: unknown
}

/** 作业终态里的失败面（合并 canceled / cancelled 两种写法）。 */
const FAILED_JOB_STATES = ['failed', 'canceled', 'cancelled', 'lost', 'error', 'timeout']

function jobState(job: Record<string, unknown>): string {
  return String(job.state || job.status || '')
    .trim()
    .toLowerCase()
}

/**
 * 三态判定的唯一出处。规则顺序就是语义（改顺序 = 改判定）：
 *
 *   1. 显式降级 → degraded：**没拿到证据 ≠ 证据证明失败**（作业提交得进、结果取不回不是 pass）；
 *   2. 作业已失败/取消/丢失 → fail（这一条有证据）；
 *   3. 给了作业句柄（哪怕只是个空对象）→ degraded：结果在作业里，本回执不下 pass；
 *   4. 通道回执说 fail / degraded → 照抄（通道是证据，不是排版）；
 *   5. ok=false → fail；ok=true → pass；都没有 → null（还没判，不许默认成功）。
 */
export function deriveVerdict(input: VerdictInput = {}): ReceiptVerdict | null {
  if (input.degraded === true) return 'degraded'
  if (input.job !== undefined && input.job !== null) {
    const state = jobState(asRecord(input.job))
    if (FAILED_JOB_STATES.includes(state)) return 'fail'
    return 'degraded'
  }
  const channels = asRecord(input.channels).verdict
  if (channels === 'fail') return 'fail'
  if (channels === 'degraded') return 'degraded'
  if (input.ok === false) return 'fail'
  if (input.ok === true) return 'pass'
  return null
}

/**
 * 回执信封的唯一构造点：contract 打头，其余字段按调用方给的键序逐个落。
 *
 * 调用方不用再写 contract（写了也以这里为准）：契约名只有一份，字段顺序由调用点显式决定 ——
 * 所以「同一个回执多一个键」不会因为对象字面量被重排而改变字节。
 */
export function receiptV2(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { contract: RECEIPT_CONTRACT }
  for (const key of Object.keys(fields)) {
    if (key === 'contract') continue
    out[key] = fields[key]
  }
  return out
}

/**
 * 证据区块合并：显式给的值覆盖继承来的同名键，继承来的其它键保留。
 *
 * 为什么要合并而不是覆盖整块：失败回执的信封来自 toolError（自带 code/stage 证据），
 * 车道自己的 file/stage/error 必须**并进**那一块，否则模型只看到半份证据。
 */
export function withEvidence(
  envelope: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return { ...envelope, evidence: { ...asRecord(envelope.evidence), ...evidence } }
}
