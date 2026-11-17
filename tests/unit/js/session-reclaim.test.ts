/**
 * 3.1 session recovery: a session whose owner stopped heartbeating must come back.
 *
 * Field report (§13.3 ③): `blender_session list` showed 0 sessions while doctor
 * still reported a connected instance, and attach / claim / stop were all refused
 * with `session_in_use` — the record existed, its owner had expired, and only a
 * process kill could clear it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import { OWNER_TTL_MS } from '../../../runtime/core/sessions/types.js'
import type {
  CallerIdentity,
  InstanceRef,
  SessionRecord,
} from '../../../runtime/core/sessions/types.js'

const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-1',
  agentId: 'agent-main',
  role: 'main',
  ...over,
})
const otherSession = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
  hostId: 'host-a',
  dshSessionId: 'dsh-2',
  agentId: 'agent-other',
  role: 'main',
  ...over,
})

function setup(instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]) {
  const state = { instances }
  const registry = new SessionRegistry(() => state.instances)
  return { registry, state }
}

function virtualGuiRecord(instanceId: string): SessionRecord {
  const now = Date.now()
  return {
    id: 'virtual-gui:' + instanceId,
    kind: 'virtual-gui',
    instanceId,
    status: 'ready',
    owner: null,
    agents: new Map(),
    grants: new Map(),
    paused: false,
    pausedAt: null,
    activePy: null,
    humanEdits: new Map(),
    humanModifiedAt: null,
    display: null,
    provider: null,
    createdAt: now,
    lastActivityAt: now,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('3.1 session recovery after the owner went away', () => {
  it('keeps an owner-expired session visible instead of listing nothing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)

    vi.advanceTimersByTime(OWNER_TTL_MS + 10_000)

    const rows = registry.listFor(otherSession())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('user-gui:inst-1')
    expect(rows[0]?.owner).toBeNull()
  })

  it('lets the next caller attach instead of answering session_in_use', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)

    vi.advanceTimersByTime(OWNER_TTL_MS + 10_000)

    const reclaimed = registry.attach(otherSession())
    expect(reclaimed.ok).toBe(true)
    if (!reclaimed.ok) return
    expect((reclaimed.session.owner as Record<string, unknown>).dshSessionId).toBe('dsh-2')
  })

  it('lets a write claim the session whose owner expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
    const { registry } = setup()
    expect(registry.attach(main()).ok).toBe(true)

    vi.advanceTimersByTime(OWNER_TTL_MS + 10_000)

    const write = registry.authorizeWrite(otherSession(), undefined, ['exclusive'])
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.mode).toBe('main')
  })

  it('stops a virtual-gui session whose owner expired', async () => {
    const { registry } = setup([{ instanceId: 'vgui-1', ready: true }])
    registry.addSession(virtualGuiRecord('vgui-1'))

    const stopped = await registry.stop(otherSession(), 'virtual-gui:vgui-1')

    expect(stopped.ok).toBe(true)
    if (!stopped.ok) return
    expect(stopped.stopped).toBe(true)
    expect(registry.getSession('virtual-gui:vgui-1')).toBeNull()
  })

  it('still refuses a session that really has another live owner', async () => {
    const { registry } = setup([{ instanceId: 'vgui-1', ready: true }])
    registry.addSession(virtualGuiRecord('vgui-1'))
    expect((await registry.stop(main(), 'virtual-gui:vgui-1')).ok).toBe(true)

    const second = virtualGuiRecord('vgui-1')
    second.owner = {
      hostId: 'host-a',
      dshSessionId: 'dsh-1',
      agentId: 'agent-main',
      claimedAt: Date.now(),
      heartbeatAt: Date.now(),
    }
    registry.addSession(second)
    const denied = await registry.stop(otherSession(), 'virtual-gui:vgui-1')
    expect(denied.ok).toBe(false)
  })

  it('tears down a virtual-gui session whose instance is gone', () => {
    const { registry, state } = setup([{ instanceId: 'vgui-gone', ready: true }])
    registry.addSession(virtualGuiRecord('vgui-gone'))
    expect(registry.getSession('virtual-gui:vgui-gone')).not.toBeNull()

    state.instances = []

    expect(registry.list()).toEqual([])
    expect(registry.getSession('virtual-gui:vgui-gone')).toBeNull()
  })
})
