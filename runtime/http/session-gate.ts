// Write gate for the 3.1 session/ownership model.
//
// Requests from the DSH host carry caller headers. When they do, the registry
// decides whether this caller owns the GUI session and holds a covering scope
// grant. Legacy clients without headers keep the 3.0 lease behaviour until the
// six-tool surface replaces them (slice 7).
//
// The registry is an argument, never module state (audit R1): a module-level
// service locator made the gate depend on assembly order, and a missing wiring
// silently downgraded attributed writes to the LEASE rules. A caller header with
// no registry now fails closed.

import { currentCaller } from './caller.js'
import { availabilityFailure } from '../core/availability.js'
import type { AvailabilityFailure } from '../core/availability.js'
import type { SessionRegistry } from '../core/sessions/registry.js'
import type { CallerIdentity } from '../core/sessions/types.js'

/**
 * The only capability the write gate needs from the session registry.
 *
 * Narrower than `SessionRegistry` on purpose: the gate authorizes a write and
 * nothing else, so a stub can decide in a test without building a registry.
 */
export type WriteAuthoritySource = Pick<SessionRegistry, 'authorizeWrite'>

function scopePayload(payload: Record<string, unknown>): unknown {
  return payload.write_scope ?? payload.write_scopes ?? payload.scope
}

/** Resolve the write scope declared by a route payload. */
export function writeScopesFor(payload: Record<string, unknown>, fallback: unknown): unknown {
  const declared = scopePayload(payload)
  return declared === undefined ? fallback : declared
}

/**
 * No registry while the caller is host-attributed: nothing can authorize this
 * write, so it must not reach the scene.
 *
 * Fail-closed used to be fail-open — the old code returned null here, turning an
 * attributed write into a LEASE-only decision, so a caller that owned no session
 * still wrote whenever nobody held the lease.
 */
function registryUnavailable(
  caller: CallerIdentity,
  body: Record<string, unknown>,
): AvailabilityFailure {
  const declared = scopePayload(body)
  return availabilityFailure({
    code: 'session_unavailable',
    stage: 'session',
    rootCause:
      'this Gateway has no session registry wired, so a host-attributed write cannot be authorized ' +
      '(agent=' +
      caller.agentId +
      ')',
    fix:
      'attach a ready Blender session first (blender_session action=attach) so the write gate has an ' +
      'owner and a scope; reads keep working through blender_see / blender_inspect',
    fallback: {
      kind: 'unavailable',
      summary: 'the write was refused before any Blender call; nothing in the scene changed',
    },
    evidence: {
      registry: null,
      caller: {
        hostId: caller.hostId,
        dshSessionId: caller.dshSessionId,
        agentId: caller.agentId,
        role: caller.role || null,
      },
      session_id: body.sessionId === undefined ? null : String(body.sessionId),
      scope: declared === undefined ? null : declared,
    },
  })
}

/**
 * The single write-authorization entry for host-attributed requests.
 *
 * @param payload  route body (sessionId / write_scope / py)
 * @param registry the Gateway's session registry, passed explicitly
 * @returns null = allowed, otherwise the structured refusal
 */
export function sessionWriteGate(
  payload: Record<string, unknown> | null | undefined,
  registry: WriteAuthoritySource | null | undefined,
  fallbackScope: unknown = 'exclusive',
): AvailabilityFailure | null {
  const caller = currentCaller()
  // No caller header: a 3.0 client. The LEASE compatibility path decides
  // (leaseGate calls this first, then falls through to the lease rules).
  if (!caller) return null
  const body = (payload || {}) as Record<string, unknown>
  // Caller present but nothing can decide: refuse, never downgrade to LEASE.
  if (!registry) return registryUnavailable(caller, body)
  const sessionId = body.sessionId === undefined ? undefined : String(body.sessionId)
  const result = registry.authorizeWrite(caller, sessionId, writeScopesFor(body, fallbackScope), {
    py: body.py === true,
    // A py call with no declared scope is not the same as one that declared
    // exclusive: the refusal says "declare write_scope" instead of "session in use".
    scopeDeclared: scopePayload(body) !== undefined,
  })
  if (result.ok) return null
  return result
}

export function gateResponse(failure: AvailabilityFailure): Record<string, unknown> {
  return {
    ...(failure as unknown as Record<string, unknown>),
    error: failure.code,
    hint: failure.fix,
  }
}

export { availabilityFailure }
