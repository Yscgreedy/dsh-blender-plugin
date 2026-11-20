/**
 * 宿主取消（exec.signal）必须继续上抛：它是"用户打断/上游截止"，不是工具结果。
 *
 * 客户端自己的等待窗口（/act 180 s、快照 20 s）到点也会抛 AbortError，两种异常在
 * JS 里长得一样 —— 只有看宿主 signal 才分得清。分错的代价是可观测的：
 *   · 把宿主取消当结果 → 用户打断了却收到"脚本可能还在跑"；
 *   · 把自己的超时当取消 → 脚本还在 Blender 里跑，模型却以为没发出去，重试叠出重复材质。
 */
import { execSignal } from '../../host/exec-context.js'

export function hostCancelled(): boolean {
  const signal = execSignal()
  return !!signal && signal.aborted
}
