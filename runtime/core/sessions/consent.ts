// One-time virtual-gui consent tokens for 3.1.
//
// The model can never mint consent: the DSH host asks the human, then calls the
// internal session action to issue a short-lived token bound to the caller.
import { randomUUID } from 'node:crypto'
import { fail } from './types.js'
import type { CallerIdentity, SessionResult } from './types.js'

export const CONSENT_TTL_MS = 30_000

/**
 * Policy switch for the human-consent step. The model can never mint consent,
 * and 3.1 offered the human no surface that could either: a subagent's
 * action=start simply failed with consent_required and nothing was recorded.
 * 'ask' keeps the gate and files a visible request; 'allow' is the human
 * pre-approving every virtual-gui start for this host; 'deny' refuses.
 */
export const CONSENT_POLICY_ENV = 'DSH_BLENDER_VIRTUAL_GUI_CONSENT'
export type ConsentPolicy = 'allow' | 'deny' | 'ask'

export function consentPolicy(env: NodeJS.ProcessEnv = process.env): ConsentPolicy {
  const raw = String(env[CONSENT_POLICY_ENV] || '')
    .trim()
    .toLowerCase()
  if (['allow', 'allowed', 'on', 'yes', 'true', '1'].includes(raw)) return 'allow'
  if (['deny', 'denied', 'off', 'no', 'false', '0'].includes(raw)) return 'deny'
  return 'ask'
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
}

export function consentFailure<T = Record<string, unknown>>(
  reason: ConsentReason | 'policy_denied' | 'request_denied',
  extra: ConsentFailureExtra = {},
): SessionResult<T> {
  return fail(
    'consent_required',
    'session',
    'virtual-gui requires explicit human consent (' + reason + ')',
    'a virtual Blender window is a visible process on the human desktop: ask them to run the ' +
      'approve command from this receipt (or set ' +
      CONSENT_POLICY_ENV +
      '=allow on the Gateway host), then call action=start again',
    {
      reason,
      policy: extra.policy || consentPolicy(),
      request_id: extra.requestId || null,
      request_expires_at: extra.expiresAt || null,
      options: [
        { action: 'attach', label: 'attach the running Blender window (no consent needed)' },
        { action: 'start', label: 'start a virtual Blender window after human approval' },
      ],
      ttl_ms: CONSENT_TTL_MS,
    },
  ) as SessionResult<T>
}
