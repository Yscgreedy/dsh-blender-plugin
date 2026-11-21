import type { CallerIdentity, SessionRecord, SessionResult } from './types.js'
import { callerMatchesHolder, fail, grantView, isMain } from './types.js'
import { anyOverlap, parseScopes } from './scopes.js'
import type { ScopeSpec } from './scopes.js'

/** Validate one grant request against the owning session and live grants. */
export function resolveGrantContext(
  session: SessionRecord,
  c: CallerIdentity,
  scopes: unknown,
  target?: CallerIdentity,
  force = false,
): SessionResult<{ parsed: ScopeSpec[]; holder: CallerIdentity }> {
  if (!isMain(session, c)) {
    return fail(
      'scope_forbidden',
      'session',
      'only the main agent recorded at owner claim may grant scopes',
      'ask the main agent to grant the scope',
      { sessionId: session.id },
    )
  }
  const parsed = parseScopes(scopes)
  if (!parsed.length) {
    return fail(
      'invalid_params',
      'session',
      'grant requires at least one scope',
      'pass scopes such as exclusive or collection:COL_Lights',
      {},
    )
  }
  const holder = grantHolder(c, target)
  if (!holder.agentId) {
    return fail(
      'invalid_params',
      'session',
      'grant target must name an agentId',
      'pass target agentId',
      {},
    )
  }
  // 反馈 1: DSH gives a subagent its own dshSessionId, so the old equality check
  // made every grant to a subagent impossible ("grant 不穿透"). A subagent whose
  // parent is the granting agent (same host) is inside the same ownership family;
  // an unrelated DSH session still cannot receive a grant.
  const sameSession = holder.dshSessionId === String(c.dshSessionId)
  const family =
    String(holder.hostId || '') === String(c.hostId || '') &&
    !!holder.parentAgentId &&
    holder.parentAgentId === String(c.agentId || '')
  if (!sameSession && !family) {
    return fail(
      'scope_forbidden',
      'session',
      'a grant cannot cross DSH sessions',
      'grant only to your own agents (same DSH session, or a subagent whose parentAgentId is you)',
      {
        holder: { dshSessionId: holder.dshSessionId, parentAgentId: holder.parentAgentId || null },
        caller: { dshSessionId: c.dshSessionId, agentId: c.agentId },
      },
    )
  }
  const conflict = force ? null : grantConflict(session, holder, parsed)
  if (conflict) return conflict
  return { ok: true, parsed, holder }
}

function grantHolder(c: CallerIdentity, target?: CallerIdentity): CallerIdentity {
  if (!target) return { ...c }
  const agentId = String(target.agentId || '')
  // When the host does not send a parent header, a grant issued by the main agent
  // to another agent id is by construction a grant to its subagent. Recording that
  // relationship makes the receipt readable (field retest asked for it) and keeps
  // the holder identity stable even when the child's dshSessionId differs.
  const parent =
    String(target.parentAgentId || '') ||
    (agentId && agentId !== String(c.agentId || '') ? String(c.agentId || '') : '')
  return {
    hostId: String(target.hostId || c.hostId),
    dshSessionId: String(target.dshSessionId || c.dshSessionId),
    agentId,
    parentAgentId: parent,
    role: 'subagent',
  }
}

function grantConflict(
  session: SessionRecord,
  holder: CallerIdentity,
  parsed: ScopeSpec[],
): SessionResult<{ parsed: ScopeSpec[]; holder: CallerIdentity }> | null {
  for (const existing of session.grants.values()) {
    if (callerMatchesHolder(existing.holder, holder)) continue
    if (!anyOverlap(existing.scopes, parsed)) continue
    return fail(
      'scope_conflict',
      'session',
      'the scope overlaps a live grant held by another agent',
      'wait for the holder to release it, or grant a non-overlapping scope',
      { grant: grantView(existing), requested: parsed },
    )
  }
  return null
}
