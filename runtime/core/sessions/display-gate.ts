// Pre-spawn gate for virtual-gui sessions. It returns the same availability
// envelope as the rest of the Gateway and never spawns Blender/display helpers.
import { consentFailure, consentPolicy, consumeConsentToken } from './consent.js'
import { ensureConsentRequest, takeApprovedToken } from './consent-requests.js'
import { fail } from './types.js'
import type { CallerIdentity, SessionRecord, SessionResult } from './types.js'
import type { DisplayCapabilities } from '../../display/types.js'

export interface VirtualGuiStartInput {
  caller: CallerIdentity
  kind?: string
  consentToken?: string
  capability: DisplayCapabilities
  existing: SessionRecord | null
}

export function startVirtualGuiGate(
  input: VirtualGuiStartInput,
): SessionResult<{ capability: DisplayCapabilities; consent_source?: string }> {
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
  // Consent resolution, in the order the human would expect:
  //   host policy → one-time token → a request this caller already got approved.
  const policy = consentPolicy()
  if (policy === 'deny')
    return consentFailure<{ capability: DisplayCapabilities }>('policy_denied', { policy })
  if (policy === 'allow') return { ok: true, capability, consent_source: 'policy:' + policy }
  const consent = consumeConsentToken(input.caller, input.consentToken)
  if (consent === 'ok') return { ok: true, capability, consent_source: 'token' }
  if (consent === 'missing' && takeApprovedToken(input.caller))
    return { ok: true, capability, consent_source: 'approved_request' }
  // Nothing to consume: file (or reuse) the request the human can approve, so the
  // failure carries an id instead of a dead end.
  const request = ensureConsentRequest(input.caller)
  return consentFailure<{ capability: DisplayCapabilities }>(consent, {
    policy,
    requestId: request.requestId,
    expiresAt: request.expiresAt,
  })
}
