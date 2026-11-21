import { describe, expect, it } from 'vitest'
import { withSessionSource } from '../../../runtime/http/routes/plan.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'

const caller: CallerIdentity = {
  hostId: 'host-a',
  dshSessionId: 'dsh-child',
  agentId: 'probe',
  parentAgentId: 'lead',
  role: 'subagent',
}
const registry = {
  sessionInfo: () => ({
    sessionId: 'user-gui:inst-1',
    owner: { hostId: 'host-a', dshSessionId: 'dsh-main', agentId: 'lead' },
    is_mine: false,
    borrowed: true,
  }),
}

describe('op source attribution (feedback 3)', () => {
  it('adds owner/is_mine/borrowed/sessionId to a read op result', () => {
    const out = withSessionSource(
      { ok: true, source: { mode: 'session', file: 'D:/a.blend', objects: ['A'] } },
      registry as never,
      caller,
      'audit_scene',
    ) as Record<string, unknown>
    const source = out.source as Record<string, unknown>
    expect(source.file).toBe('D:/a.blend')
    expect(source.is_mine).toBe(false)
    expect(source.borrowed).toBe(true)
    expect(source.sessionId).toBe('user-gui:inst-1')
    expect((source.owner as Record<string, unknown>).agentId).toBe('lead')
    expect(out.is_mine).toBe(false)
  })

  it('wraps a string result instead of hiding attribution', () => {
    const out = withSessionSource('raw text', registry as never, caller, 'audit_scene') as Record<
      string,
      unknown
    >
    expect(out.result).toBe('raw text')
    expect((out.source as Record<string, unknown>).is_mine).toBe(false)
  })

  it('leaves the result untouched without a session or registry', () => {
    const out = { ok: true, source: { file: 'D:/a.blend' } }
    expect(withSessionSource(out, null, caller, 'audit_scene')).toBe(out)
    expect(withSessionSource(out, registry as never, null, 'audit_scene')).toBe(out)
  })
})
