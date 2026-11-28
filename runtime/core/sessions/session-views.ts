// Session views: the read-only projections the tools consume.
//
// Extracted from registry.ts (registry split, third slice) with no behavior change:
// list / listFor / readableInstanceFor / sessionInfo / status and the owner-heartbeat
// they perform moved here verbatim. The host interface is only what these reads need,
// so a test can render every view without constructing a registry.

import type { AttachLiveness } from './attach.js'
import { touchAgent } from './presence.js'
import { readableSessions, sessionForInstance, unownedSessions } from './lookup.js'
import {
  callerKey,
  fail,
  inOwnerFamily,
  ownerMatches,
  ownerStale,
  sameHost,
  sessionView,
} from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'

/** What the read-only views take from the registry. */
export interface SessionViewsHost {
  sessions: Map<string, SessionRecord>
  instances(): InstanceRef[]
  prune(now?: number): void
  findForCaller(c: CallerIdentity): SessionRecord | null
  /** The instance this caller attached last, while that memory is still fresh. */
  tombstoneFor(c: CallerIdentity): string | null
  livenessOf(session: SessionRecord): AttachLiveness
}

export class SessionViews {
  constructor(private readonly host: SessionViewsHost) {}

  list(): Record<string, unknown>[] {
    this.host.prune()
    return [...this.host.sessions.values()].map((s) => sessionView(s))
  }

  /** Any authenticated call from the owner counts as a heartbeat (feedback 8). */
  private refreshOwner(c: CallerIdentity): void {
    for (const s of this.host.sessions.values()) {
      if (s.owner && ownerMatches(s.owner, c)) s.owner.heartbeatAt = Date.now()
    }
  }

  listFor(c: CallerIdentity): Record<string, unknown>[] {
    this.host.prune()
    this.refreshOwner(c)
    const rows = new Map<string, Record<string, unknown>>()
    // 实例维度兜底：Blender 还连着、只是归属过期的会话也列出来。否则模型看到 0 个会话，
    // 手里没有 sessionId，attach/claim/stop 全被 session_in_use 挡住。
    for (const s of unownedSessions(this.host.sessions, this.host.instances()))
      rows.set(s.id, sessionView(s, c))
    const own = this.host.findForCaller(c)
    if (own) rows.set(own.id, sessionView(own, c))
    // Read-only visibility (field 反馈 1/3): same-host sessions are listed with
    // owner + is_mine=false so blender_see can use them and audit_* can attribute
    // their results. Writes still fail in authorizeWrite (grant/owner required).
    for (const s of readableSessions(this.host.sessions, c, this.host.instances())) {
      if (rows.has(s.id)) continue
      rows.set(s.id, { ...sessionView(s, c), read_only: true })
    }
    return [...rows.values()]
  }

  /**
   * The instance behind the only same-host session this caller may read but not
   * own. Used for routing: see/read ops need a target, writes still go through
   * authorizeWrite and are refused without a grant.
   */
  readableInstanceFor(c: CallerIdentity): string | null {
    this.host.prune()
    const rows = readableSessions(this.host.sessions, c, this.host.instances()).filter(
      (s) => s.status === 'ready' && !!s.instanceId,
    )
    return rows.length === 1 ? String(rows[0].instanceId) : null
  }

  /** Attribution for a plan/op receipt: the session behind the instance we drove. */
  sessionInfo(c: CallerIdentity, instanceId?: string | null): Record<string, unknown> | null {
    this.host.prune()
    this.refreshOwner(c)
    const session = instanceId
      ? sessionForInstance(this.host.sessions, String(instanceId))
      : this.host.findForCaller(c)
    if (!session) return null
    const mine = ownerMatches(session.owner, c) || inOwnerFamily(session.owner, c)
    return {
      sessionId: session.id,
      instanceId: session.instanceId,
      owner: session.owner
        ? {
            hostId: session.owner.hostId,
            dshSessionId: session.owner.dshSessionId,
            agentId: session.owner.agentId,
            role: session.owner.role || 'main',
            stale: ownerStale(session.owner),
          }
        : null,
      is_mine: mine,
      borrowed: !mine && sameHost(session.owner, c),
      // Additive attribution for op receipts: the instance is over its budget
      // (S-5b) — readable, still alive, and honest about the pressure it adds.
      ...(session.degradation ? { degradation: session.degradation } : {}),
    }
  }

  status(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown> }> {
    this.host.prune()
    this.refreshOwner(c)
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session) {
      // A released record is gone by design; still answer what happened instead of
      // a bare session_not_found, using the last instance this caller attached.
      const instanceId = this.host.tombstoneFor(c)
      if (instanceId && !sessionId)
        return {
          ok: true,
          session: {
            id: 'user-gui:' + instanceId,
            kind: 'user-gui',
            instanceId,
            status: 'stopped',
            owner: null,
            agents: [],
            grants: [],
            paused: false,
            activePy: null,
            humanModified: null,
            display: null,
            createdAt: null,
            lastActivityAt: null,
            live: { instanceReady: false, readyInstances: 0 },
            reason: 'addon_disconnected_after_release',
          },
        }
      return fail(
        'session_not_found',
        'session',
        'the session does not exist',
        'call blender_session list to see live sessions',
        { sessionId: sessionId || null },
      )
    }
    if (ownerMatches(session.owner, c) || session.agents.has(callerKey(c))) touchAgent(session, c)
    // live=false is the honest answer for "the record exists but its Blender is
    // gone"; attach refuses to revive it, so status must not imply otherwise.
    return {
      ok: true,
      session: { ...sessionView(session, c), live: this.host.livenessOf(session) },
    }
  }
}
