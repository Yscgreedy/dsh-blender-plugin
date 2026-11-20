/**
 * 6a 文案：list=0 只说明"未认领"，3.1+ addon 主动拨 39877，**不需要点 Connect**。
 * 这条测试锁的是回执原文（旧文案"在 Blender N 面板点 Connect"已判错）。
 */
import { describe, expect, it } from 'vitest'
import { formatSessionList } from '../../../src/tools/session/presenter.js'

const addon = {
  connected: true,
  ready_instances: 1,
  instanceId: 'db7bf4af4cc158b1802a1e8c477c65f9',
  next_actions: ['blender_session action=attach instance_id=db7bf4af4cc158b1802a1e8c477c65f9'],
}

describe('工单 6 session list copy', () => {
  it('gives a pasteable attach instead of "点 Connect"', () => {
    const text = formatSessionList([], null, addon)
    expect(text).toContain('SESSION list · 0 个会话')
    expect(text).toContain('未认领')
    expect(text).toContain('addon 已连，ready_instances=1')
    expect(text).toContain(
      'blender_session action=attach instance_id=db7bf4af4cc158b1802a1e8c477c65f9',
    )
    expect(text).toContain('list=0 只是未认领，不代表 addon 离线')
    expect(text).toContain('next_actions · ')
    expect(text).not.toContain('点 Connect')
  })

  it('stays honest when the addon table is unavailable', () => {
    const text = formatSessionList([], null, null)
    expect(text).toContain('addon 状态未知')
    expect(text).not.toContain('点 Connect')
  })

  // 工单 6e：会话数与"未认领"措辞必须由 evidence.sessions 驱动，不能按本调用者可见的行数判断。
  it('counts sessions from evidence when another caller already claimed one', () => {
    const text = formatSessionList(
      [],
      {
        sessions: [
          { id: 'sess-owned-elsewhere', kind: 'user-gui', status: 'ready', instanceId: 'abc' },
        ],
        local_processes: [],
        ports: [],
        ports_evidence: {
          conflicts: [],
          source: 'netstat',
          scanned_at: '2026-11-19T13:50:21.417Z',
        },
        false_positives: [],
        fixture: null,
      },
      addon,
    )
    expect(text).toContain('SESSION list · 1 个会话（本调用者可见 0）')
    expect(text).toContain('sess-owned-elsewhere')
    expect(text).toContain('session_in_use')
    expect(text).not.toContain('未认领')
    expect(text).not.toContain('list=0 只是未认领')
  })

  it('keeps the zero-claim copy when evidence confirms zero sessions', () => {
    const text = formatSessionList(
      [],
      {
        sessions: [],
        local_processes: [],
        ports: [],
        ports_evidence: {
          conflicts: [],
          source: 'netstat',
          scanned_at: '2026-11-19T13:50:21.417Z',
        },
        false_positives: [],
        fixture: null,
      },
      addon,
    )
    expect(text).toContain('SESSION list · 0 个会话')
    expect(text).toContain('未认领')
  })

  it('reports the evidence total next to the visible rows when they differ', () => {
    const rows = [{ id: 'sess-mine', kind: 'user-gui', status: 'ready', instanceId: 'abc' }]
    const text = formatSessionList(
      rows,
      {
        sessions: [
          { id: 'sess-mine', kind: 'user-gui', status: 'ready' },
          { id: 'sess-theirs', kind: 'virtual-gui', status: 'ready' },
        ],
        local_processes: [],
        ports: [],
        ports_evidence: {
          conflicts: [],
          source: 'netstat',
          scanned_at: '2026-11-19T13:50:21.417Z',
        },
        false_positives: [],
        fixture: null,
      },
      addon,
    )
    expect(text).toContain('SESSION list · 2 个会话（本调用者可见 1）')
    expect(text).toContain('sess-mine')
  })

  it('prints the evidence blocks when given', () => {
    const text = formatSessionList(
      [],
      {
        local_processes: [
          { pid: 7504, name: 'DeepSeek Harness.exe', role: 'gateway', port: 39877 },
          { pid: 11176, name: 'blender.exe', role: 'addon', port: null },
        ],
        ports: [
          {
            port: 39877,
            listening: true,
            pids: [7504],
            process: 'DeepSeek Harness.exe',
            role: 'gateway',
          },
          { port: 9879, listening: false, pids: [], process: '', role: 'worker' },
          { port: 9877, listening: false, pids: [], process: '', role: 'legacy' },
        ],
        ports_evidence: {
          gateway: { port: 39877, state: 'listening', pid: 7504, matched: true, source: 'netstat' },
          worker: { port: 9879, state: 'closed' },
          legacy: { port: 9877, state: 'closed' },
          conflicts: [],
          reader: 'netstat',
          source: 'netstat',
          scanned_at: '2026-11-19T13:50:21.417Z',
        },
        false_positives: [],
        fixture: null,
      },
      addon,
    )
    expect(text).toContain('local_processes · 2 个')
    expect(text).toContain('ports · ')
    expect(text).toContain('ports_evidence · source=netstat')
    expect(text).toContain('scanned_at=2026-11-19T13:50:21.417Z')
    expect(text).toContain('gateway=39877 listening pid=7504 matched=true')
    expect(text).toContain('false_positives · []')
  })
})
