// Virtual-gui consent: filing, human approval/denial, status, and the panel projection.
//
// Extracted from registry.ts (registry split, second slice) with no behavior change: the
// bodies of issueConsent / requestConsent / approveConsent / denyConsent / consentStatus /
// consentPanel moved here verbatim, and so did the panel row projection they use.
//
// The host interface is deliberate: consent needs the session map (the panel lists every
// session), the limits, the ready-instance list and the prune that drops stale records —
// nothing else. Approval and denial stay in-process for the human channel only; the agent
// surface cannot reach them (see dispatchSessionAction).

import {
  approveConsentRequest,
  consentRequestsAll,
  consentRequestView,
  consentRequestsFor,
  denyConsentRequest,
  ensureConsentRequest,
} from './consent-requests.js'
import { issueConsentToken } from './consent.js'
import { policyLock, policyWriteTarget, resolveConsentPolicy } from './consent-policy.js'
import { fail, sessionView } from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'
import type { VirtualGuiLimits } from '../../display/limits.js'

/** What the consent surface reads from the registry. */
export interface ConsentBookHost {
  sessions: Map<string, SessionRecord>
  prune(now?: number): void
  instances(): InstanceRef[]
  virtualGuiCount(): number
  limits(): VirtualGuiLimits
}

/** One row of the panel's session list: the session view plus "is this the panel's session". */
function panelSessionRow(s: SessionRecord, dshSessionId: string): Record<string, unknown> {
  const owner = s.owner
  const mine = !!owner && !!dshSessionId && String(owner.dshSessionId || '') === dshSessionId
  const caller: CallerIdentity | null = dshSessionId
    ? {
        hostId: owner ? String(owner.hostId || '') : '',
        dshSessionId,
        agentId: mine ? String(owner?.agentId || '') : '',
        role: 'main',
      }
    : null
  const view = sessionView(s, caller || undefined)
  const viewer =
    !!dshSessionId &&
    [...s.agents.values()].some((a) => String(a.caller.dshSessionId || '') === dshSessionId)
  return {
    ...view,
    panel_is_mine: dshSessionId ? mine : null,
    viewer,
  }
}

export class ConsentBook {
  constructor(private readonly host: ConsentBookHost) {}

  issueConsent(c: CallerIdentity): SessionResult<{ consentToken: string; expiresAt: number }> {
    return { ok: true, ...issueConsentToken(c) }
  }

  /** File (or reuse) the pending virtual-gui consent request for this caller. */
  requestConsent(c: CallerIdentity): SessionResult<Record<string, unknown>> {
    const filed = ensureConsentRequest(c)
    if (filed.rateLimited)
      return fail(
        'consent_rate_limited',
        'session',
        'this caller filed a consent request less than a minute ago (' + filed.requestId + ')',
        'approve the waiting request in the session panel, wait ' +
          String(Math.ceil(Number(filed.retryAfterMs || 0) / 1000)) +
          's, or switch the policy to auto/deny in the panel',
        {
          reason: 'rate_limited',
          request_id: filed.requestId,
          retry_after_ms: filed.retryAfterMs ?? null,
        },
      )
    return {
      ok: true,
      request: consentRequestView(filed.requestId),
      reused: filed.reused,
      ...(() => {
        const policy = resolveConsentPolicy()
        return {
          policy: policy.policy,
          mode: policy.mode,
          auto: policy.auto,
          policy_source: policy.source,
        }
      })(),
    }
  }

  /**
   * Record the human's approval for a filed request.
   *
   * NOT reachable from an agent: `dispatchSessionAction` refuses
   * `consent_approve` / `consent_deny` for any call that carries a DSH identity
   * (`consent_human_only`), and the model tool schema no longer offers them.
   * The decision comes from the identity-free human channel (session panel /
   * terminal command). This method stays in-process for that channel and for
   * tests; it is not a caller-facing authorization.
   */
  approveConsent(requestId: unknown, source = 'human'): SessionResult<Record<string, unknown>> {
    const decided = approveConsentRequest(requestId, source)
    if (!decided.ok)
      return fail(
        'consent_' + decided.reason,
        'session',
        'consent request ' + String(requestId || '') + ' is ' + decided.reason,
        decided.reason === 'missing'
          ? 'use the request_id from the blender_session action=start receipt'
          : 'call action=start again to file a fresh request',
        { requestId: requestId || null, reason: decided.reason },
      )
    return { ok: true, request: decided.request }
  }

  /** Human-only, same rule as approveConsent (see the note there). */
  denyConsent(requestId: unknown, reason = 'human denied'): SessionResult<Record<string, unknown>> {
    const decided = denyConsentRequest(requestId, reason)
    if (!decided.ok)
      return fail(
        'consent_' + decided.reason,
        'session',
        'consent request ' + String(requestId || '') + ' is ' + decided.reason,
        'call action=start again to file a fresh request',
        { requestId: requestId || null, reason: decided.reason },
      )
    return { ok: true, request: decided.request }
  }

  /** What this caller still has waiting on a human. */
  consentStatus(c: CallerIdentity): SessionResult<Record<string, unknown>> {
    const policy = resolveConsentPolicy()
    return {
      ok: true,
      policy: policy.policy,
      mode: policy.mode,
      auto: policy.auto,
      policy_source: policy.source,
      requests: consentRequestsFor(c),
    }
  }

  /**
   * Read-only data for the Blender session panel inside the conversation view.
   *
   * It takes no DSH identity on purpose: the browser that renders the panel is
   * not the agent, and the panel must not become a write path. Everything here is
   * a projection of state the Gateway already owns; the two actions the panel
   * offers (approve / deny) go through the human consent channel, which can only
   * release a request the agent itself filed.
   */
  consentPanel(dshSessionId: string, now = Date.now()): Record<string, unknown> {
    this.host.prune(now)
    const sid = String(dshSessionId || '')
    const policy = resolveConsentPolicy(process.env, now)
    const limits = this.host.limits()
    const ready = this.host.instances().filter((x) => x.ready)
    const sessions = [...this.host.sessions.values()].map((s) => panelSessionRow(s, sid))
    return {
      ok: true,
      ts: now,
      panel_session: sid || null,
      policy: {
        mode: policy.mode,
        policy: policy.policy,
        auto: policy.auto,
        source: policy.source,
        file: policy.file,
        note: policy.note,
        // The panel may switch the mode — unless a human pinned it with the env
        // var, in which case the controls are disabled and a POST is refused.
        ...(() => {
          const lock = policyLock()
          const target = policyWriteTarget()
          return {
            locked: lock.locked,
            lock_env: lock.locked ? lock.env : null,
            lock_value: lock.value,
            writable: !lock.locked,
            write_target: target.file,
            write_target_exists: target.exists,
          }
        })(),
      },
      resources: {
        instances: this.host.virtualGuiCount(),
        limit: limits.limit,
        configured: limits.configured,
        low_resource: limits.low_resource,
        limit_reason: limits.reason,
        ready_instances: ready.length,
        connected: ready.length > 0,
      },
      requests: consentRequestsAll(now).map((r) => ({ ...r })),
      sessions,
    }
  }
}
