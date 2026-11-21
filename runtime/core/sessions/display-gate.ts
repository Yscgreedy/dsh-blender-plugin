// Pre-spawn gate for virtual-gui sessions. It returns the same availability
// envelope as the rest of the Gateway and never spawns Blender/display helpers.
//
// 3.3.1: a manual start no longer dead-ends. It files a request, then waits up to
// wait_ms for the human's decision. Approving in the session panel resolves that
// same call (consent_source=approved_request) instead of asking the agent to call
// start a second time.
import { consentFailure, consumeConsentToken } from './consent.js'
import { resolveConsentPolicy } from './consent-policy.js'
import {
  ensureConsentRequest,
  takeApprovedToken,
  waitForConsentDecision,
} from './consent-requests.js'
import { fail } from './types.js'
import type { CallerIdentity, SessionRecord, SessionResult } from './types.js'
import type { DisplayCapabilities } from '../../display/types.js'

/** How long a manual start waits for the human before it answers state=pending. */
export const CONSENT_WAIT_DEFAULT_MS = 20_000
export const CONSENT_WAIT_MAX_MS = 120_000

export function consentWaitMs(requested?: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = Number(env.DSH_BLENDER_VIRTUAL_GUI_WAIT_MS)
  const base = Number.isFinite(fallback) && fallback >= 0 ? fallback : CONSENT_WAIT_DEFAULT_MS
  const raw = Number(requested)
  const value = Number.isFinite(raw) && raw >= 0 ? raw : base
  return Math.max(0, Math.min(CONSENT_WAIT_MAX_MS, Math.round(value)))
}

export interface VirtualGuiStartInput {
  caller: CallerIdentity
  kind?: string
  consentToken?: string
  capability: DisplayCapabilities
  existing: SessionRecord | null
  /** How long a manual start waits for the human's decision (default 20 s). */
  waitMs?: number
}

/**
 * Kind / ownership / capability checks, in the order the old inline block ran
 * them. Returns null when the gate may continue to the consent step.
 */
function capabilityGate(input: VirtualGuiStartInput): SessionResult<never> | null {
  const { capability, existing } = input
  if ((input.kind || 'virtual-gui') !== 'virtual-gui')
    return fail(
      'invalid_params',
      'session',
      'start only applies to virtual-gui',
      'use attach for a user-started Blender',
      { kind: input.kind },
    )
  if (existing && existing.kind === 'user-gui' && existing.status === 'ready')
    return fail(
      'session_already_available',
      'session',
      'a ready user-gui session already exists for this caller',
      'attach the running Blender window instead of starting a virtual one',
      { sessionId: existing.id, kind: existing.kind },
    )
  const evidence = {
    feature: 'virtualGui',
    provider: capability.provider,
    provider_implemented: capability.provider_implemented,
    enabled: capability.enabled,
    preview: capability.preview,
    ready: capability.ready,
    reason: capability.reason,
    missing: capability.missing,
    prerequisites: capability.prerequisites,
    feature_source: capability.feature_source,
  }
  if (!capability.enabled)
    return fail(
      'feature_disabled',
      'config',
      'virtual-gui is not enabled (features.virtualGui=' + capability.feature + ')',
      capability.fix,
      evidence,
    )
  if (!capability.ready)
    return fail(
      capability.reason && capability.reason.indexOf('prerequisites') === 0
        ? 'prerequisites_missing'
        : 'provider_unavailable',
      'config',
      'virtual-gui is not ready: ' +
        (capability.reason || 'unknown') +
        (capability.missing.length ? ' (missing: ' + capability.missing.join(', ') + ')' : ''),
      capability.fix,
      evidence,
    )
  return null
}

export async function startVirtualGuiGate(
  input: VirtualGuiStartInput,
): Promise<SessionResult<{ capability: DisplayCapabilities; consent_source?: string }>> {
  const { capability } = input
  const gated = capabilityGate(input)
  if (gated) return gated
  // Consent resolution, in the order the human would expect:
  //   host policy → one-time token → a request this caller already got approved.
  const resolved = resolveConsentPolicy()
  const policy = resolved.policy
  const base = {
    policy,
    mode: resolved.mode,
    policySource: resolved.source,
  }
  if (policy === 'deny')
    return consentFailure<{ capability: DisplayCapabilities }>('policy_denied', base)
  if (policy === 'allow') return { ok: true, capability, consent_source: 'policy:' + policy }
  const consent = consumeConsentToken(input.caller, input.consentToken)
  if (consent === 'ok') return { ok: true, capability, consent_source: 'token' }
  if (consent === 'missing' && takeApprovedToken(input.caller))
    return { ok: true, capability, consent_source: 'approved_request' }
  // Nothing to consume: file (or reuse) the request the human approves, then wait
  // for them — the panel's button completes *this* call, not a later one.
  const request = ensureConsentRequest(input.caller)
  // Only a first start (no token at all) waits for the human. A token that was
  // replayed or expired is the caller's own mistake: answer immediately so the
  // receipt still names 'used' / 'invalid' instead of parking a stale call.
  const waitMs = consent === 'missing' ? consentWaitMs(input.waitMs) : 0
  if (waitMs > 0) {
    const decided = await waitForConsentDecision(request.requestId, waitMs)
    if (decided === 'approved' || decided === 'consumed') {
      if (takeApprovedToken(input.caller))
        return { ok: true, capability, consent_source: 'approved_request' }
    }
    if (decided === 'denied')
      return consentFailure<{ capability: DisplayCapabilities }>('request_denied', {
        ...base,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        waitMs,
      })
    if (decided === 'expired')
      return consentFailure<{ capability: DisplayCapabilities }>('expired', {
        ...base,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        waitMs,
      })
  }
  return consentFailure<{ capability: DisplayCapabilities }>(consent, {
    ...base,
    requestId: request.requestId,
    expiresAt: request.expiresAt,
    pending: true,
    waitMs,
  })
}
