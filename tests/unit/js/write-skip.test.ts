import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { READ_ONLY_OPS } from '../../../runtime/http/lease.js'
import { runWithCaller } from '../../../runtime/http/caller.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'
import { SKIP_RULE_PATHS, shouldGateWrite } from '../../../runtime/http/write-skip.js'
import { pkgPath } from '../../helpers/pkg'

// 写门跳过判据的唯一出处（R2）。
//
// 原来 8 个写路由各自拼 `isReadOnly(...) ? null : leaseGate(...)`，/worker 与 /act 还各带一条
// 只有自己知道的例外；改一条跳过语义要横扫八个文件，而且没有任何地方能回答"哪些请求不过写门"。
// 这里锁三件事：
//   1. 默认是"过门"：未知路径/未知 op/缺规则都落到写门（跳过必须是显式例外）；
//   2. 两条例外（/act 的 py+caller、/worker 的 isolated）行为不变；
//   3. 路由文件里不再出现 isReadOnly(...)：判据只允许在 runtime/http/write-skip.ts 里解释。

const CALLER: CallerIdentity = {
  hostId: 'host-1',
  dshSessionId: 'sess-1',
  agentId: 'agent-1',
  role: 'main',
}

describe('write gate skip rules', () => {
  it('gates every write op and lets the read-only table through', () => {
    for (const [route, ops] of Object.entries(READ_ONLY_OPS)) {
      for (const op of ops) {
        expect(shouldGateWrite(route, { op }), route + ' ' + op).toBe(false)
      }
      expect(shouldGateWrite(route, { op: 'definitely_a_write' }), route).toBe(true)
    }
  })

  it('gates unknown paths and unknown ops (default is to gate)', () => {
    expect(shouldGateWrite('/nope', { op: 'list' })).toBe(true)
    expect(shouldGateWrite('/job', {})).toBe(true)
    expect(shouldGateWrite('/job', undefined)).toBe(true)
    expect(shouldGateWrite('/job', null)).toBe(true)
  })

  it('skips isolated worker calls and only those', () => {
    expect(shouldGateWrite('/worker', { op: 'exec', isolated: true })).toBe(false)
    expect(shouldGateWrite('/worker', { op: 'exec', isolated: false })).toBe(true)
    expect(shouldGateWrite('/worker', { op: 'exec' })).toBe(true)
    // isolated 只对 /worker 有意义：别处带这个字段不该被当成跳过理由
    expect(shouldGateWrite('/job', { op: 'submit', isolated: true })).toBe(true)
  })

  it('skips py calls that carry a caller, keeping the legacy lease path', () => {
    const withCaller = runWithCaller(CALLER, () => shouldGateWrite('/act', { py: true }))
    expect(withCaller).toBe(false)
    expect(runWithCaller(null, () => shouldGateWrite('/act', { py: true }))).toBe(true)
    expect(runWithCaller(CALLER, () => shouldGateWrite('/act', { py: false }))).toBe(true)
    expect(runWithCaller(CALLER, () => shouldGateWrite('/act', {}))).toBe(true)
  })

  it('declares exactly the two routes that skip for non-read-only reasons', () => {
    expect(SKIP_RULE_PATHS).toEqual(['/act', '/worker'])
  })

  it('keeps the decision out of the route files', () => {
    const dir = pkgPath('runtime/http/routes')
    const offenders: string[] = []
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue
      const rel = 'runtime/http/routes/' + entry
      if (/\bisReadOnly\s*\(/.test(fs.readFileSync(path.join(dir, entry), 'utf8')))
        offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
