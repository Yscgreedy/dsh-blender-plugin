import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import type { CallerIdentity, InstanceRef } from '../../../runtime/core/sessions/types.js'

const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-main',
  agentId: 'lead',
  role: 'main',
  ...over,
})
const child = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-child',
  agentId: 'probe',
  parentAgentId: 'lead',
  role: 'subagent',
  ...over,
})
const foreign = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-foreign',
  agentId: 'other',
  role: 'main',
  ...over,
})

function setup(instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]) {
  const state = { instances }
  const registry = new SessionRegistry(() => state.instances)
  return { registry, state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('3.2 subagent sessions with their own dshSessionId (field report 1/2/3)', () => {
  it('attaches a subagent of the owner as a viewer instead of session_in_use', () => {
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    const r = registry.attach(child())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.viewer).toBe(true)
    expect((r.session.owner as Record<string, unknown>).agentId).toBe('lead')
    expect((r.session.agents as unknown[]).length).toBe(2)
  })

  it('lists a same-host foreign session read-only with owner attribution', () => {
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    const rows = registry.listFor(foreign())
    const row = rows.find((x) => x.id === 'user-gui:inst-1')
    expect(row).toBeTruthy()
    expect(row?.is_mine).toBe(false)
    expect(row?.borrowed).toBe(true)
    expect(row?.read_only).toBe(true)
    expect((row?.owner as Record<string, unknown>).agentId).toBe('lead')
    expect((row?.owner as Record<string, unknown>).heartbeat_age_ms).toBeTypeOf('number')
    // Read-only routing: see/read ops need a target even without an owned session.
    expect(registry.readableInstanceFor(foreign())).toBe('inst-1')
  })

  it('authorizes a subagent write through a covering grant despite a different dshSessionId', () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    expect(registry.attach(child()).ok).toBe(true)
    const before = registry.authorizeWrite(child(), sessionId, ['collection:COL_A'])
    expect(before.ok).toBe(false)
    if (before.ok) return
    expect(before.code).toBe('session_in_use')
    expect((before.evidence as Record<string, unknown>).is_mine).toBe(false)
    expect(registry.grant(main(), sessionId, ['collection:COL_A'], child()).ok).toBe(true)
    // A JSON-string scope (type:"json" parameter) means the same as an array.
    const allowed = registry.authorizeWrite(child(), sessionId, '["collection:COL_A"]')
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.mode).toBe('grant')
    // A viewer can publish presence and read back its own grant.
    expect(
      registry.updateView(child(), sessionId, { viewpoint: 'custom', from: [1, 2, 3] }).ok,
    ).toBe(true)
    const listed = registry.grants(child(), sessionId)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.grants.length).toBe(1)
  })

  it('matches a grant issued with only target_agent_id (no child session id)', () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    // The parent only knows the child's agentId; the holder is recorded with the
    // parent's dshSessionId while the child calls with its own.
    const target = { ...child(), dshSessionId: 'dsh-main' }
    expect(registry.grant(main(), sessionId, ['collection:COL_B'], target).ok).toBe(true)
    const allowed = registry.authorizeWrite(child(), sessionId, ['collection:COL_B'])
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.mode).toBe('grant')
  })

  it('records the granting agent as parent when the host sends no parent header', () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    const target = {
      hostId: 'host-a',
      dshSessionId: 'dsh-main',
      agentId: 'probe',
      role: 'subagent' as const,
    }
    const g = registry.grant(main(), sessionId, ['collection:COL_D'], target)
    expect(g.ok).toBe(true)
    if (!g.ok) return
    const holder = (g.grant as Record<string, unknown>).holder as Record<string, unknown>
    expect(holder.parentAgentId).toBe('lead')
    const noParent = child({ parentAgentId: undefined })
    const allowed = registry.authorizeWrite(noParent, sessionId, ['collection:COL_D'])
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.mode).toBe('grant')
  })

  it('force=true replaces an overlapping grant held by another agent', () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    expect(registry.grant(main(), sessionId, ['collection:COL_A'], child()).ok).toBe(true)
    const sub2 = child({ agentId: 'probe-2' })
    expect(registry.grant(main(), sessionId, ['collection:COL_A'], sub2).ok).toBe(false)
    const forced = registry.grant(main(), sessionId, ['collection:COL_A'], sub2, 600_000, true)
    expect(forced.ok).toBe(true)
    expect(registry.authorizeWrite(sub2, sessionId, ['collection:COL_A']).ok).toBe(true)
    const old = registry.authorizeWrite(child(), sessionId, ['collection:COL_A'])
    expect(old.ok).toBe(false)
  })

  it('lets a granted subagent run scoped Python but refuses an undeclared exclusive scope', async () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    expect(registry.grant(main(), sessionId, ['collection:COL_PROBE'], child()).ok).toBe(true)
    const scoped = await registry.beginPy(child(), sessionId, 0, ['collection:COL_PROBE'])
    expect(scoped.ok).toBe(true)
    if (scoped.ok) expect(scoped.mode).toBe('grant')
    expect(registry.endPy(child(), sessionId).ok).toBe(true)
    const exclusive = await registry.beginPy(child(), sessionId, 0, ['exclusive'])
    expect(exclusive.ok).toBe(false)
    if (exclusive.ok) return
    expect(exclusive.code).toBe('session_in_use')
    expect((exclusive.evidence as Record<string, unknown>).fix_kind).toBeUndefined()
    expect((exclusive.evidence as Record<string, unknown>).requested).toEqual([
      { kind: 'exclusive' },
    ])
  })

  it('attaches a same-host subagent as a viewer even when the host omits the parent header', () => {
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    const noParent = child({ parentAgentId: undefined, agentId: 'verify-agent-2' })
    const r = registry.attach(noParent)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.viewer).toBe(true)
    expect((r.session.owner as Record<string, unknown>).agentId).toBe('lead')
    // A host subagent is a viewer, not the owner: attribution must say so.
    expect(r.session.is_mine).toBe(false)
    expect(r.session.borrowed).toBe(true)
    // A main agent of another DSH session gets a read-only viewer, not ownership.
    const foreignView = registry.attach(foreign())
    expect(foreignView.ok).toBe(true)
    if (!foreignView.ok) return
    expect(foreignView.viewer).toBe(true)
    expect(foreignView.session.is_mine).toBe(false)
  })

  it('honors a 10/15-minute grant TTL and caps at one hour', () => {
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    const ten = registry.grant(main(), sessionId, ['collection:COL_A'], child(), 600_000)
    expect(ten.ok).toBe(true)
    if (!ten.ok) return
    const tenGrant = ten.grant as Record<string, unknown>
    expect(Number(tenGrant.expiresInMs)).toBeGreaterThan(590_000)
    expect(Number(tenGrant.expiresInMs)).toBeLessThanOrEqual(600_000)
    // A longer request is honored up to the one-hour cap, and expiresInMs is the
    // real value (field retest: 600000/900000 were both cut to 30000).
    const long = registry.grant(main(), sessionId, ['collection:COL_B'], child(), 900_000)
    expect(long.ok).toBe(true)
    if (!long.ok) return
    expect(Number((long.grant as Record<string, unknown>).expiresInMs)).toBeGreaterThan(890_000)
    const capped = registry.grant(main(), sessionId, ['collection:COL_C'], child(), 7_200_000)
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(Number((capped.grant as Record<string, unknown>).expiresInMs)).toBeLessThanOrEqual(
      3_600_000,
    )
  })

  it('keeps grants after the owner heartbeat expires and reports them to the owner', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
    const { registry } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    // One-hour grant survives the 30 min owner TTL; grants live on their own clock.
    expect(registry.grant(main(), sessionId, ['collection:COL_A'], child(), 3_600_000).ok).toBe(
      true,
    )
    vi.advanceTimersByTime(1_800_001)
    const status = registry.status(main(), sessionId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.session.owner).toBeNull()
    // The old behavior cleared grants with the owner and then answered
    // session_in_use; grants now live on their own TTL.
    const grants = registry.grants(main(), sessionId)
    expect(grants.ok).toBe(true)
    if (!grants.ok) return
    expect(grants.grants.length).toBe(1)
    expect(grants.owner_expired).toBe(true)
    expect(String(grants.note)).toContain('attach again')
    const re = registry.attach(main())
    expect(re.ok).toBe(true)
    if (!re.ok) return
    expect((re.session.grants as unknown[]).length).toBe(1)
  })

  it('C-2: owner TTL 过期后主控仍能 grant（无主时先认领，而不是永远 scope_forbidden）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
    const { registry, state } = setup()
    const attached = registry.attach(main())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const sessionId = String(attached.session.id)
    vi.advanceTimersByTime(1_800_001)
    const status = registry.status(main(), sessionId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.session.owner).toBeNull()

    const granted = registry.grant(main(), sessionId, ['collection:COL_Z'], child(), 600_000)
    expect(granted.ok).toBe(true)
    // 认领发生在这条 grant 里：之后 status 应当重新显示 is_mine=true
    const after = registry.status(main(), sessionId)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.session.owner).not.toBeNull()
    expect(after.session.is_mine).toBe(true)
    expect(state.instances.length).toBe(1)
  })

  it('never lets a subagent claim an unowned session as its own', () => {
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    expect(registry.release(main()).ok).toBe(true)
    const r = registry.attach(child({ parentAgentId: undefined }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.session.owner).toBeNull()
    const write = registry.authorizeWrite(child(), String(r.session.id), ['exclusive'])
    expect(write.ok).toBe(false)
    if (write.ok) return
    expect(write.code).toBe('scope_required')
  })

  it('force-releases a crashed foreign-session lease from a same-host main agent', () => {
    const { registry } = setup()
    // A crashed main agent of another DSH session owns the GUI. A subagent can no
    // longer own it (it would be a viewer), so the foreign main is the real case.
    expect(registry.attach(foreign()).ok).toBe(true)
    const denied = registry.release(main(), 'user-gui:inst-1')
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.code).toBe('session_in_use')
    const forced = registry.release(main(), 'user-gui:inst-1', { force: true })
    expect(forced.ok).toBe(true)
    if (!forced.ok) return
    expect(forced.reason).toBe('forced_by_host_main')
    expect(registry.attach(main()).ok).toBe(true)
  })

  it('reclaims a stale subagent owner after 30 s without a heartbeat', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
    const { registry } = setup()
    expect(registry.attach(child()).ok).toBe(true)
    vi.advanceTimersByTime(31_000)
    const r = registry.attach(main())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.session.owner as Record<string, unknown>).agentId).toBe('lead')
  })

  it('does not reclaim a live main owner at 31 s (the 120 s TTL still applies)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)
    vi.advanceTimersByTime(31_000)
    const r = registry.attach(foreign())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.viewer).toBe(true)
    expect(r.session.is_mine).toBe(false)
    const write = registry.authorizeWrite(foreign(), String(r.session.id), ['exclusive'])
    expect(write.ok).toBe(false)
    const stale = registry.sessionInfo(foreign(), 'inst-1')
    expect(stale?.is_mine).toBe(false)
    expect(stale?.borrowed).toBe(true)
  })
})
