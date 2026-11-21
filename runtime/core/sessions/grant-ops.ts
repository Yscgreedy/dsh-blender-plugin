// Scope-grant operations extracted from the session registry (module budget).
import { resolveGrantContext } from './grants.js'
import { anyOverlap } from './scopes.js'
import {
  GRANT_TTL_MAX_MS,
  GRANT_TTL_MS,
  callerMatchesHolder,
  fail,
  grantView,
  inOwnerFamily,
  isMain,
  sameHost,
  ownerMatches,
} from './types.js'
import type { CallerIdentity, GrantRecord, SessionRecord, SessionResult } from './types.js'

export interface GrantOpsHost {
  sessions: Map<string, SessionRecord>
  prune(): void
  findForCaller(c: CallerIdentity): SessionRecord | null
}

export function grantTo(
  host: GrantOpsHost,
  c: CallerIdentity,
  sessionId: string,
  scopes: unknown,
  target?: CallerIdentity,
  ttlMs?: number,
  force = false,
): SessionResult<{ grant: Record<string, unknown> }> {
  host.prune()
  const session = host.sessions.get(String(sessionId))
  if (!session)
    return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {})
  const ctx = resolveGrantContext(session, c, scopes, target, force)
  if (!('holder' in ctx)) return ctx
  const { parsed, holder } = ctx
  const now = Date.now()
  const requestedTtl = Number(ttlMs)
  // The old cap was GRANT_TTL_MS (30 s), so every request was silently cut to
  // 30 s and the receipt's expiresInMs exposed it. The cap is now one hour and
  // the default is ten minutes; expiresInMs is derived from expiresAt.
  const ttl =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(GRANT_TTL_MAX_MS, requestedTtl)
      : GRANT_TTL_MS
  if (force) {
    // Explicit replacement: drop overlapping grants held by other agents before
    // issuing the new one (use when the old target id was a display name).
    for (const [id, existing] of [...session.grants]) {
      if (callerMatchesHolder(existing.holder, holder)) continue
      if (!anyOverlap(existing.scopes, parsed)) continue
      session.grants.delete(id)
    }
  }
  const grant: GrantRecord = {
    id: 'grant_' + Math.random().toString(16).slice(2, 10),
    sessionId: session.id,
    holder,
    grantedBy: { ...c },
    scopes: parsed,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + ttl,
  }
  for (const [existingId, existing] of session.grants) {
    if (callerMatchesHolder(existing.holder, holder)) session.grants.delete(existingId)
  }
  session.grants.set(grant.id, grant)
  session.lastActivityAt = now
  return { ok: true, grant: grantView(grant) }
}

export function revokeFrom(
  host: GrantOpsHost,
  c: CallerIdentity,
  sessionId: string,
  grantId?: string,
): SessionResult<{ revoked: string[] }> {
  host.prune()
  const session = host.sessions.get(String(sessionId))
  if (!session)
    return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {})
  if (!isMain(session, c))
    return fail(
      'scope_forbidden',
      'session',
      'only the main agent may revoke scopes',
      'ask the main agent to revoke',
      {},
    )
  const revoked: string[] = []
  for (const [id, g] of session.grants) {
    if (grantId && id !== String(grantId)) continue
    if (!grantId && callerMatchesHolder(g.holder, c)) continue
    session.grants.delete(id)
    revoked.push(id)
  }
  return { ok: true, revoked }
}

export function listGrants(
  host: GrantOpsHost,
  c: CallerIdentity,
  sessionId?: string,
): SessionResult<{
  grants: Record<string, unknown>[]
  owner_expired?: boolean
  note?: string
}> {
  host.prune()
  const session = sessionId ? host.sessions.get(String(sessionId)) : host.findForCaller(c)
  if (!session) return { ok: true, grants: [] }
  // owner=null (expired heartbeat) is not "someone else owns it": the grants have
  // their own TTL and the caller is still attached (field retest: status said
  // owner=- while grants answered session_in_use).
  if (
    session.owner &&
    !ownerMatches(session.owner, c) &&
    !inOwnerFamily(session.owner, c) &&
    !sameHost(session.owner, c)
  )
    return fail(
      'session_in_use',
      'session',
      'another DSH session owns this GUI session',
      'wait for the owner to release it',
      {
        sessionId: session.id,
        owner: session.owner,
        caller: {
          hostId: c.hostId,
          dshSessionId: c.dshSessionId,
          agentId: c.agentId,
          role: c.role || 'subagent',
        },
        owner_agent: session.owner ? String(session.owner.agentId || '') : null,
        callers_agent: String(c.agentId || ''),
        grant_holders: [...session.grants.values()].map((g) => ({
          agentId: String(g.holder.agentId || ''),
          parentAgentId: g.holder.parentAgentId || null,
        })),
      },
    )
  const all = [...session.grants.values()]
  const visible = isMain(session, c)
    ? all
    : all.filter((g) => callerMatchesHolder(g.holder, c) || callerMatchesHolder(g.grantedBy, c))
  return {
    ok: true,
    grants: visible.map(grantView),
    // owner=null with agents present means "the lease expired"; say so instead of
    // letting status (owner=-) and grants (session_in_use) disagree.
    ...(!session.owner && session.agents.size
      ? {
          owner_expired: true,
          note: 'owner heartbeat expired: attach again to reclaim; existing grants stay valid until their own TTL',
        }
      : {}),
  }
}
