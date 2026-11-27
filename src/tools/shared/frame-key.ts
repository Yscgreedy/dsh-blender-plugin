/**
 * 取帧去重键的唯一构造器：**通道 + 调用方 + 参数**。
 *
 * 为什么必须带调用方：去重命中时回执只说"与上一张完全相同、未重复附图"。键里没有调用方时，
 * A 看过的画面会让 B 收到同一句话 —— 而 B 从没拿到过那张图，去重就变成了信息被吞（C-5）。
 * blender_py 的 see 已按调用方分键；blender_see 的视口/全窗/自定义三条通道原来共用固定键，
 * 现在一律走这里，判据在同一个地方。
 */
import { execCaller } from '../../host/exec-context.js'

/**
 * 调用方作用域：agent 优先，其次 DSH 会话。
 * 没有调用方时给出显式的 no-caller —— 它不是一个"共享键"，而是"这条调用没有身份"的标记。
 */
export function callerScope(): string {
  const caller = execCaller()
  if (!caller) return 'no-caller'
  return String(caller.agentId || caller.dshSessionId || 'unknown')
}

/** 去重键：channel:caller:parts…（同一调用方、同通道、同参数才互相影响）。 */
export function frameKey(channel: string, ...parts: Array<string | number>): string {
  return [channel, callerScope(), ...parts.map((part) => String(part))].join(':')
}
