import { beforeEach, describe, expect, it, vi } from 'vitest'
import { availabilityFailure } from '../../../runtime/core/availability.js'
import { runWithCaller } from '../../../runtime/http/caller.js'
import { LEASE, leaseGate, leaseView } from '../../../runtime/http/lease.js'
import { gateResponse, sessionWriteGate } from '../../../runtime/http/session-gate.js'
import type { WriteAuthoritySource } from '../../../runtime/http/session-gate.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'

// write authority: one gate, and its registry arrives as an argument.
//
// Audit task-2 §3.3 R1 found two authorities — the process-wide LEASE singleton
// and the session registry — joined only by call order, with a module-level
// REGISTRY (a settable service locator) in between. This file pins the first
// cut: the gate takes the registry explicitly, a host-attributed request with no
// registry fails closed, and headerless 3.0 clients still get the LEASE path.

const CALLER: CallerIdentity = {
  hostId: 'host-unit',
  dshSessionId: 'dsh-unit',
  agentId: 'agent-unit',
  role: 'main',
}

/** Run fn as if the Gateway had parsed caller headers into the request context. */
function attributed<T>(fn: () => T): T {
  return runWithCaller(CALLER, fn)
}

function refusal(): ReturnType<typeof availabilityFailure> {
  return availabilityFailure({
    code: 'session_unavailable',
    stage: 'session',
    rootCause: 'no GUI session is attached for this caller',
    fix: 'attach a ready Blender session first',
    fallback: 'operation unavailable',
    evidence: { stub: true },
  })
}

function resetLease(): void {
  LEASE.holder = null
  LEASE.token = null
  LEASE.acquiredAt = null
  LEASE.expiresAt = null
  LEASE.renewals = 0
  LEASE.scope = null
}

beforeEach(resetLease)

describe('write authority: explicit registry, fail closed', () => {
  it('refuses an attributed write when no registry is wired', () => {
    const failure = attributed(() => sessionWriteGate({ sessionId: 's-1' }, null))
    expect(failure).toMatchObject({ ok: false, code: 'session_unavailable', stage: 'session' })
    expect(failure && failure.root_cause).toContain('session registry')
    expect(failure && failure.fix).toContain('blender_session action=attach')
    expect(failure && failure.evidence).toMatchObject({
      registry: null,
      caller: { hostId: CALLER.hostId, dshSessionId: CALLER.dshSessionId, agentId: CALLER.agentId },
      session_id: 's-1',
      scope: null,
    })
    // The route envelope keeps the error/hint aliases every failure carries.
    expect(gateResponse(failure!)).toMatchObject({
      ok: false,
      error: 'session_unavailable',
      hint: failure!.fix,
    })
  })

  it('does not fall back to the LEASE rules for an attributed write', () => {
    // Fail-open used to look like this: no registry → null → the free lease is
    // handed to the holder in the payload, so a caller owning no session writes.
    const gate = attributed(() => leaseGate({ holder: 'plugin-unit' }, null))
    expect(gate).toMatchObject({
      ok: false,
      error: 'session_unavailable',
      code: 'session_unavailable',
    })
    expect(leaseView()).toMatchObject({ active: false, holder: null })
  })

  it('keeps the legacy path for clients without caller headers', () => {
    const registry: WriteAuthoritySource = { authorizeWrite: () => refusal() }
    // No caller header: the registry is not consulted at all (it would 503 a
    // 3.0 client that never claimed a session), and an idle lease lets through.
    expect(sessionWriteGate({ holder: 'plugin-unit' }, null)).toBeNull()
    expect(sessionWriteGate({ holder: 'plugin-unit' }, registry)).toBeNull()
    expect(leaseGate({ holder: 'plugin-unit' }, null)).toBeNull()
    expect(leaseGate({ holder: 'plugin-unit' }, registry)).toBeNull()
  })

  it('passes the registry allowance through as "allowed"', () => {
    const spy = vi.fn(() => ({ ok: true as const, sessionId: 's-1', mode: 'main' as const }))
    const registry: WriteAuthoritySource = { authorizeWrite: spy }
    expect(attributed(() => sessionWriteGate({ sessionId: 's-1' }, registry))).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(CALLER, 's-1', 'exclusive', {
      py: false,
      scopeDeclared: false,
    })
  })

  it('passes the registry refusal through unchanged', () => {
    const verdict = refusal()
    const registry: WriteAuthoritySource = { authorizeWrite: () => verdict }
    // Identity, not a rebuild: the registry's receipt (codes, evidence, fix) is
    // exactly what the route returns, minus the envelope aliases.
    expect(attributed(() => sessionWriteGate({ sessionId: 's-1' }, registry))).toBe(verdict)
    expect(attributed(() => leaseGate({ holder: 'plugin-unit' }, registry))).toMatchObject({
      ok: false,
      code: 'session_unavailable',
      error: 'session_unavailable',
      hint: verdict.fix,
    })
    expect(leaseView()).toMatchObject({ active: false, holder: null })
  })

  it('declares the payload scope instead of the default when asked', () => {
    const spy = vi.fn(() => ({ ok: true as const, sessionId: 's-2', mode: 'grant' as const }))
    const registry: WriteAuthoritySource = { authorizeWrite: spy }
    attributed(() =>
      sessionWriteGate({ sessionId: 's-2', write_scope: 'prefix:LGT-', py: true }, registry),
    )
    expect(spy).toHaveBeenCalledWith(CALLER, 's-2', 'prefix:LGT-', {
      py: true,
      scopeDeclared: true,
    })
  })
})
