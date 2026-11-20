/**
 * blender_py 的执行前回退点（checkpoint=auto 的落点）。
 *
 * 走的是 session 工具那条现成的 txn 通道：POST /txn {op:"snapshot", args:{label,note}}
 * 由 runtime/py/core/txn.py 的 t_snapshot 执行（save_as_mainfile(copy=True)，不动当前
 * filepath），没有新路由，也没有新 addon 命令；回滚就是 blender_session 的
 * action=txn op=list / op=restore（同一个快照清单）。
 *
 * 为什么不直接调 session/txn.ts 的 executeTxn()：它的客户端等待写死 300 s，而且只回
 * 渲染好的文本。执行前回退点必须**有界**（快照本身可能很慢，但不能吃掉 /act 的 180 s
 * 预算），并且需要后端回声的 label 才能写进成功回执。payload 与回执口径和 txn.ts 一致。
 */
import { randomUUID } from 'node:crypto'
import { asRecord, text } from '../../contracts/dynamic.js'
import { backendPost, leasedText } from '../../host/http.js'
import { errorLine } from '../errors.js'
import { hostCancelled } from './cancel.js'

/**
 * 快照窗口：大场景的 save_as_mainfile(copy=True) 是秒级到十几秒级。这里给 20 s ——
 * 超时只是"这次没有回退点"（照常执行 + 告警），不是拦下用户的编辑；
 * 而 180 s 的 /act 预算不能被它吃掉。
 */
const SNAPSHOT_TIMEOUT_MS = 20000

export type CheckpointMode = 'auto' | 'off'

export interface PreExecCheckpoint {
  mode: CheckpointMode
  /** host 侧生成的锚点：成功回执与"结果未知"回执都用它 */
  requestId: string
  /** 后端回声的快照 label；null = 这次没有可用的回退点 */
  label: string | null
  /** label 为 null 时的原因（一行，进回执当告警） */
  note: string
}

/** checkpoint 入参收敛：缺省（空）= auto；认不出来的值返回 null，由调用方报 invalid_params。 */
export function checkpointMode(value: unknown): CheckpointMode | null {
  const raw = text(value).trim().toLowerCase()
  if (!raw) return 'auto'
  if (raw === 'auto' || raw === 'off') return raw
  return null
}

/** 取执行前回退点。任何失败都只降级成告警（note），绝不拦下这次编辑。 */
export async function takePreExecCheckpoint(
  port: number,
  mode: CheckpointMode,
): Promise<PreExecCheckpoint> {
  const requestId = randomUUID()
  if (mode === 'off') return { mode, requestId, label: null, note: '' }
  const label = 'py-' + requestId.slice(0, 8)
  try {
    const r = await backendPost(
      port,
      '/txn',
      { op: 'snapshot', args: { label, note: 'blender_py request_id=' + requestId } },
      SNAPSHOT_TIMEOUT_MS,
    )
    const leased = leasedText(r)
    if (leased) return { mode, requestId, label: null, note: firstLine(leased) }
    if (!r || r.ok !== true)
      return {
        mode,
        requestId,
        label: null,
        note:
          'TXN snapshot 失败 · ' + text(r.error || asRecord(r.result).error || r.raw || 'unknown'),
      }
    return {
      mode,
      requestId,
      label: text(asRecord(asRecord(r.result).snapshot).label) || label,
      note: '',
    }
  } catch (e) {
    if (hostCancelled()) throw e
    return { mode, requestId, label: null, note: 'TXN snapshot 没回执 · ' + errorLine(e) }
  }
}

function firstLine(value: string): string {
  return value.split(String.fromCharCode(10))[0].slice(0, 200)
}
