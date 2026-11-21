import { touchAgent } from './presence.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'
import { fail, inOwnerFamily, ownerMatches, ownerOf, ownerStale, sameHost } from './types.js'

/**
 * Take ownership of a session that has none, or refresh the heartbeat when the
 * caller already owns it. An expired owner (no heartbeat for OWNER_TTL_MS) is
 * cleared by prune() and is therefore free: without this path a session whose
 * owner went away stays blocked forever ("another DSH session owns this"), which
 * only a process kill could clear.
 */
export function claimFreeSession(session: SessionRecord, c: CallerIdentity): void {
  if (!session.owner) {
    // A subagent never becomes the owner. The host may omit the parent header,
    // but role=subagent is enough: it can attach as a viewer and write only
    // through a grant. Only a main agent claims an unowned session.
    if (c.role !== 'subagent') session.owner = ownerOf(c)
  } else {
    session.owner.heartbeatAt = Date.now()
  }
  touchAgent(session, c)
}

/**
 * Liveness evidence for a session record. The registry keeps a record after its
 * Blender went away (a user-gui record is never deleted, only marked stopped), so
 * "the record exists" is not evidence that the addon still answers. attach used
 * to revive any record it found, which produced an ok/ready receipt for a dead
 * instance and a session_required failure on the next real call.
 */
export interface AttachLiveness {
  /** The instance this record points at is in the Gateway's live ready list. */
  instanceReady: boolean
  /** How many ready instances the Gateway knows right now. */
  readyInstances: number
}

export function claimExisting(
  session: SessionRecord,
  c: CallerIdentity,
  live: AttachLiveness = { instanceReady: true, readyInstances: 1 },
): SessionResult<{ session: SessionRecord; viewer?: boolean }> {
  if (!live.instanceReady) {
    // Do not revive a dead record: report the disconnect instead of ok/ready.
    // Ownership/agents stay so status can still answer "your Blender went away"
    // (prune clears them after OWNER_TTL_MS); grants are meaningless without it.
    const statusBefore = session.status
    session.status = 'stopped'
    session.grants.clear()
    session.activePy = null
    return fail(
      'addon_disconnected',
      'session',
      'the Blender instance behind this session is no longer connected (' +
        String(session.instanceId || 'unknown') +
        '); ready_instances=' +
        String(live.readyInstances),
      're-enable DSH Blender Bridge in that Blender and press Connect in the N panel, then ' +
        'blender_session action=attach again; a window reset (wm.read_factory_settings / ' +
        'read_homefile) disables the addon, so the session cannot come back on its own',
      {
        sessionId: session.id,
        instanceId: session.instanceId,
        ready_instances: live.readyInstances,
        status_before: statusBefore,
      },
    )
  }
  if (session.owner && !ownerMatches(session.owner, c)) {
    // A dead subagent owner is not a wall: its heartbeat has stopped, so the next
    // caller (or the same-host main agent) may claim the GUI again (field 反馈 2).
    if (!ownerStale(session.owner)) {
      // Field retest: role/parent headers are unreliable; any same-host non-owner may
      // attach as a read-only viewer. Writes still need a covering grant.
      if (inOwnerFamily(session.owner, c) || sameHost(session.owner, c)) {
        // Subagent of the owner: attach as a viewer. Presence becomes visible to
        // the main agent, but ownership never moves (writes still need a grant).
        touchAgent(session, c)
        session.status = 'ready'
        return { ok: true, session, viewer: true }
      }
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'reads are allowed on the same host (blender_see / audit_* return owner + is_mine=false); ' +
          'writes need blender_session action=grant from the owner, or the owner releases it',
        {
          sessionId: session.id,
          owner: session.owner,
          caller: {
            hostId: c.hostId,
            dshSessionId: c.dshSessionId,
            agentId: c.agentId,
            parentAgentId: c.parentAgentId || null,
            role: c.role || 'subagent',
          },
          owner_agent: String(session.owner.agentId || ''),
          callers_agent: String(c.agentId || ''),
          is_mine: false,
          fix_kind: 'grant_or_release',
        },
      )
    }
    session.owner = null
  }
  claimFreeSession(session, c)
  session.status = 'ready'
  return { ok: true, session }
}

export function pickInstance(
  instances: InstanceRef[],
  opts: { instanceId?: string },
): SessionResult<{ instance: InstanceRef }> {
  const ready = instances.filter((x) => x.ready)
  if (!ready.length) {
    return fail(
      'session_unavailable',
      'session',
      'no ready GUI session is attached to the Gateway',
      'start Blender with DSH Blender Bridge 2.0.0, or start a virtual-gui session after approval',
      { ready_instances: 0 },
    )
  }
  if (!opts.instanceId && ready.length > 1) {
    return fail(
      'session_ambiguity',
      'session',
      'multiple Blender instances are connected',
      'pass instanceId to choose one; omitting it is allowed only with exactly one ready instance',
      { instances: ready.map((x) => x.instanceId) },
    )
  }
  const instance = opts.instanceId ? ready.find((x) => x.instanceId === opts.instanceId) : ready[0]
  if (!instance) {
    return fail(
      'session_not_found',
      'session',
      'the requested Blender instance is not connected',
      'call blender_session list and attach an instanceId that is ready',
      { instanceId: opts.instanceId, ready: ready.map((x) => x.instanceId) },
    )
  }
  return { ok: true, instance }
}

export function createSession(instance: InstanceRef, c: CallerIdentity): SessionRecord {
  const now = Date.now()
  return {
    id: 'user-gui:' + instance.instanceId,
    kind: 'user-gui',
    instanceId: instance.instanceId,
    status: 'ready',
    // A subagent may be the first caller, but it never owns the GUI session.
    owner: c.role === 'subagent' ? null : ownerOf(c),
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
