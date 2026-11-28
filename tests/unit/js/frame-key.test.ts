import { describe, expect, it } from 'vitest'
import { EXEC_CTX, type CallerInfo } from '../../../src/host/exec-context'
import { callerScope, frameKey } from '../../../src/tools/shared/frame-key'

// 取帧去重键：键必须带调用方。
//
// 去重命中时回执只说"与上一张完全相同、未重复附图"。键里没有调用方时，A 看过的画面会让
// B 收到同一句话 —— 而 B 从没拿到过那张图，去重就变成了信息被吞。
// blender_py 的 see 原来手工拼 caller，blender_see 的三条通道共用固定键；现在都走 frameKey。

function caller(agentId: string, dshSessionId = 'sess-' + agentId): CallerInfo {
  return { hostId: 'host-1', dshSessionId, agentId, role: 'main' }
}

function as<T>(who: CallerInfo, fn: () => T): T {
  return EXEC_CTX.run({ caller: who }, fn)
}

describe('frame dedupe keys', () => {
  it('marks calls without a caller explicitly', () => {
    expect(callerScope()).toBe('no-caller')
    expect(frameKey('see', 'camera')).toBe('see:no-caller:camera')
  })

  it('separates callers on the same channel and arguments', () => {
    const a = as(caller('agent-a'), () => frameKey('see', 'camera'))
    const b = as(caller('agent-b'), () => frameKey('see', 'camera'))
    expect(a).not.toBe(b)
    expect(a).toBe('see:agent-a:camera')
    expect(b).toBe('see:agent-b:camera')
  })

  it('is stable for the same caller', () => {
    const once = as(caller('agent-a'), () => frameKey('see', 'current', '1024x576'))
    const twice = as(caller('agent-a'), () => frameKey('see', 'current', '1024x576'))
    expect(once).toBe(twice)
  })

  it('keeps channels and arguments apart', () => {
    expect(as(caller('a'), () => frameKey('py-see', 560))).not.toBe(
      as(caller('a'), () => frameKey('see', 560)),
    )
    expect(as(caller('a'), () => frameKey('see', 'full', -1))).not.toBe(
      as(caller('a'), () => frameKey('see', 'full', 3)),
    )
  })

  it('falls back to the session id when the agent id is empty', () => {
    expect(as(caller('', 'sess-7'), () => callerScope())).toBe('sess-7')
  })
})
