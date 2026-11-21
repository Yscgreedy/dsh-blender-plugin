// One-time virtual-gui consent tokens for 3.1.
//
// The model can never mint consent: the DSH host asks the human, then calls the
// internal session action to issue a short-lived token bound to the caller.
//
// 3.3.1: the policy (auto / manual / deny) lives in consent-policy.ts and is read
// per call, so the human can change it in the profile config and the panel shows
// the change immediately. 'allow' means pre-approved, 'ask' means a request must
// be approved by the human, 'deny' refuses.
import { randomUUID } from 'node:crypto'
import { fail } from './types.js'
import { CONSENT_POLICY_ENV, resolveConsentPolicy } from './consent-policy.js'
import type { ConsentMode, ConsentPolicy } from './consent-policy.js'
import type { CallerIdentity, SessionResult } from './types.js'

export const CONSENT_TTL_MS = 30_000

export { CONSENT_POLICY_ENV }
export type { ConsentMode, ConsentPolicy }

export function consentPolicy(env: NodeJS.ProcessEnv = process.env): ConsentPolicy {
  return resolveConsentPolicy(env).policy
}

interface ConsentToken {
  callerKey: string
  expiresAt: number
  used: boolean
}

const tokens = new Map<string, ConsentToken>()

export function issueConsentToken(
  c: CallerIdentity,
  now = Date.now(),
): { consentToken: string; expiresAt: number } {
  for (const [id, record] of tokens) if (now > record.expiresAt) tokens.delete(id)
  const token = randomUUID()
  const expiresAt = now + CONSENT_TTL_MS
  tokens.set(token, {
    callerKey: [c.hostId, c.dshSessionId, c.agentId].join('|'),
    expiresAt,
    used: false,
  })
  return { consentToken: token, expiresAt }
}

export type ConsentReason = 'missing' | 'invalid' | 'expired' | 'used'

export function consumeConsentToken(
  c: CallerIdentity,
  token: unknown,
  now = Date.now(),
): ConsentReason | 'ok' {
  if (!token) return 'missing'
  const record = tokens.get(String(token))
  if (!record) return 'invalid'
  if (record.callerKey !== [c.hostId, c.dshSessionId, c.agentId].join('|')) return 'invalid'
  if (record.used) return 'used'
  if (now > record.expiresAt) {
    tokens.delete(String(token))
    return 'expired'
  }
  record.used = true
  return 'ok'
}

export interface ConsentFailureExtra {
  /** The filed request the human can approve. */
  requestId?: string
  expiresAt?: number
  policy?: ConsentPolicy
  /** auto | manual | deny (what the human panel shows). */
  mode?: ConsentMode
  /** Where that policy came from (env / file / default). */
  policySource?: string
  /** True when a manual request is filed and the start waited long enough to give up. */
  pending?: boolean
  /** How long this start waited for a human decision. */
  waitMs?: number
}

export function consentFailure<T = Record<string, unknown>>(
  reason: ConsentReason | 'policy_denied' | 'request_denied',
  extra: ConsentFailureExtra = {},
): SessionResult<T> {
  const resolved = resolveConsentPolicy()
  const policy = extra.policy || resolved.policy
  const mode = extra.mode || resolved.mode
  const pending = extra.pending === true
  return fail(
    'consent_required',
    'session',
    'virtual-gui requires explicit human consent (' + reason + ')',
    pending
      ? 'a request is waiting in the Blender session panel of this conversation: approve it there and ' +
          'the same start completes; if it already returned, call action=start again (an approval is ' +
          'consumed once)'
      : 'ask the human to approve the request in the Blender session panel (or run the approve command ' +
          'from this receipt); ' +
          CONSENT_POLICY_ENV +
          '=allow on the Gateway host pre-approves every start',
    {
      reason,
      policy,
      mode,
      policy_source: extra.policySource || resolved.source,
      request_id: extra.requestId || null,
      request_expires_at: extra.expiresAt || null,
      state: pending ? 'pending' : null,
      wait_ms: extra.waitMs ?? null,
      options: [
        { action: 'attach', label: 'attach the running Blender window (no consent needed)' },
        { action: 'start', label: 'start a virtual Blender window after human approval' },
      ],
      ttl_ms: CONSENT_TTL_MS,
    },
  ) as SessionResult<T>
}
