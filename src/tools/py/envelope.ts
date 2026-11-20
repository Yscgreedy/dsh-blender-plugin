/** blender_py 的回执装配（ACT 通道）。 */
import { text } from '../../contracts/dynamic.js'
import { redactSecrets } from '../errors.js'

const LF = String.fromCharCode(10)

/**
 * 成功回执的锚点：谁跑的这一趟、执行前退到哪。
 *
 * request_id 是 host 侧生成的（crypto.randomUUID），客户端等待结束时连同一个
 * outcome=unknown 回执一起交给模型 —— 事后把"这次编辑"与 txn 快照对上号靠它。
 */
export interface PyOutcomeMeta {
  requestId: string
  /** 执行前文件级快照的 label；null = 没留成回退点 */
  checkpoint: string | null
  /** off = 调用方明确要求不留；auto = 试过（失败时看 checkpointWarning） */
  checkpointMode: 'auto' | 'off'
  /** 快照失败原因：照常执行，只是没有回退点 */
  checkpointWarning?: string | null
}

function checkpointText(meta: PyOutcomeMeta): string {
  if (meta.checkpoint) return meta.checkpoint
  return meta.checkpointMode === 'off' ? 'off' : 'none'
}

export function formatActText(r: Record<string, unknown>, meta?: PyOutcomeMeta): string[] {
  const parts: string[] = []
  parts.push('PY ok · ' + text(r.ms) + 'ms')
  if (meta) {
    parts.push(
      'outcome=complete · request_id=' + meta.requestId + ' · checkpoint=' + checkpointText(meta),
    )
    if (meta.checkpointWarning)
      parts.push('⚠️ checkpoint 没建成（照常执行，只是没有回退点）：' + meta.checkpointWarning)
  }
  if (Number(r.mainThreadMs) > 1000)
    parts.push(
      '⚠️ 本次占用 Blender 主线程约 ' +
        text(r.mainThreadMs) +
        'ms —— 超过 ~1s 的重活改走 blender_run(kind=headless)（不卡 GUI）',
    )
  if (r.stderr && String(r.stderr).trim())
    parts.push('stderr: ' + redactSecrets(r.stderr).slice(0, 1200))
  if (r.traceback) parts.push('--- traceback ---' + LF + redactSecrets(r.traceback).slice(0, 2000))
  if (r.stdout) parts.push('stdout: ' + redactSecrets(r.stdout).slice(0, 3000))
  return parts
}
