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
import { fail, ownerMatches } from './types.js'
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

/** Mechanically executable calls an agent can just run (S-2: never a single hint). */
const START_VIRTUAL = 'blender_session action=start kind=virtual-gui'

function attachCall(sessionId: string): string {
  return 'blender_session action=attach session_id=' + sessionId
}

function releaseCall(sessionId: string): string {
  return 'blender_session action=release session_id=' + sessionId
}

/** Which ready user-gui a start found (台账 S-4). */
export type UserGuiClaim = 'mine' | 'others' | 'unowned'

/**
 * Who holds the ready user-gui this start found.
 *
 * Only ownership may refuse a start (S-4). The gate used to ask "may I read this
 * session" (readableBy = sameHost), which turned "I can see it" into "the whole
 * machine is busy": a second DSH session — or the main agent's own subagent —
 * was answered session_already_available while someone's user-gui was attached.
 */
export function userGuiClaim(session: SessionRecord, caller: CallerIdentity): UserGuiClaim {
  if (!session.owner) return 'unowned'
  return ownerMatches(session.owner, caller) ? 'mine' : 'others'
}

/** The three-way wording a start carries about an existing ready user-gui (S-4 ③). */
export interface ExistingUserGui {
  claim: UserGuiClaim
  sessionId: string
  /** Only 'mine' blocks: the one case the gate still refuses. */
  blocking: boolean
  is_mine: boolean
  /** Someone else's window is read-only visible to this caller (is_mine=false). */
  read_only: boolean
  owner_agent: string | null
  /** One line: why this window is (or is not) in the way of this start. */
  note: string
  /** At least two mechanically executable next steps (S-2). */
  options: string[]
}

/**
 * Receipt for one existing ready user-gui — the three cases of S-4 ③, each with
 * its own real exit: the owner attaches or releases its window, a bystander keeps
 * reading it and starts its own, and an unowned window can be claimed.
 */
export function existingUserGui(session: SessionRecord, claim: UserGuiClaim): ExistingUserGui {
  const ownerAgent = session.owner ? String(session.owner.agentId || '') || null : null
  const facts = {
    claim,
    sessionId: session.id,
    blocking: claim === 'mine',
    is_mine: claim === 'mine',
    read_only: claim !== 'mine',
    owner_agent: ownerAgent,
  }
  if (claim === 'mine')
    return {
      ...facts,
      note: 'you already own it (' + session.id + '); a virtual-gui would be a second window',
      options: [
        attachCall(session.id) + ' — refresh the heartbeat of the window you already have',
        releaseCall(session.id) + ' — release it first, then start a virtual-gui',
      ],
    }
  if (claim === 'others')
    return {
      ...facts,
      note:
        'another DSH caller (' +
        (ownerAgent || 'unknown') +
        ') holds ' +
        session.id +
        '; you can read it read-only and it does not block your own virtual-gui',
      options: [
        START_VIRTUAL + ' — this call continues; you get your own Blender process',
        attachCall(session.id) + ' — read-only viewer (owner/is_mine=false, writes need a grant)',
        releaseCall(session.id) + ' — ask the owner, or force=true from a same-host main agent',
      ],
    }
  return {
    ...facts,
    note:
      session.id +
      ' is ready but has no owner (heartbeat expired); it does not block your own virtual-gui',
    options: [
      attachCall(session.id) + ' — claim the ready window instead of starting one',
      START_VIRTUAL + ' — this call continues; you get your own Blender process',
    ],
  }
}

/** A refusal that ends the call, or a non-blocking note carried into the receipt. */
interface GateStep {
  refusal?: SessionResult<never>
  existing?: ExistingUserGui
}

/**
 * Kind / ownership / capability checks, in the order the old inline block ran
 * them. Returns null when the gate may continue to the consent step.
 *
 * S-4: only "this caller already owns a ready user-gui" refuses. A user-gui held
 * by another caller (or by nobody) is returned as `existing` and the start goes on:
 * user-gui and virtual-gui coexist, bounded by features.virtualGuiMax and the
 * memory gate (limits.ts), never by "someone else can read the window".
 */
function capabilityGate(input: VirtualGuiStartInput): GateStep | null {
  const { capability, existing } = input
  if ((input.kind || 'virtual-gui') !== 'virtual-gui')
    return {
      refusal: fail(
        'invalid_params',
        'session',
        'start only applies to virtual-gui',
        'use attach for a user-started Blender',
        { kind: input.kind },
      ),
    }
  const readyUserGui =
    existing && existing.kind === 'user-gui' && existing.status === 'ready' ? existing : null
  if (readyUserGui) {
    const claim = userGuiClaim(readyUserGui, input.caller)
    const note = existingUserGui(readyUserGui, claim)
    if (claim === 'mine')
      return {
        refusal: fail(
          'session_already_available',
          'session',
          'this caller already owns a ready user-gui session (' + readyUserGui.id + ')',
          'you already own it (' +
            readyUserGui.id +
            '): 1) ' +
            note.options[0] +
            '; 2) ' +
            note.options[1] +
            '; a virtual-gui is only for work that needs its own Blender process',
          {
            sessionId: readyUserGui.id,
            kind: readyUserGui.kind,
            is_mine: true,
            viewer: false,
            read_only: false,
            claim,
            blocking: true,
            owner: readyUserGui.owner,
            owner_agent: note.owner_agent,
            note: note.note,
            fix_options: note.options,
          },
        ),
      }
    // Visible is not occupied: another caller's window is read-only here, and a
    // window nobody owns is claimable — neither one may stop this start.
    return { existing: note }
  }
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
    return {
      refusal: fail(
        'feature_disabled',
        'config',
        'virtual-gui is not enabled (features.virtualGui=' + capability.feature + ')',
        capability.fix,
        evidence,
      ),
    }
  if (!capability.ready)
    return {
      refusal: fail(
        capability.reason && capability.reason.indexOf('prerequisites') === 0
          ? 'prerequisites_missing'
          : 'provider_unavailable',
        'config',
        'virtual-gui is not ready: ' +
          (capability.reason || 'unknown') +
          (capability.missing.length ? ' (missing: ' + capability.missing.join(', ') + ')' : ''),
        capability.fix,
        evidence,
      ),
    }
  return null
}

/** A gate success, plus the S-4 note about a user-gui this start did not have to obey. */
export interface VirtualGuiGateSuccess {
  capability: DisplayCapabilities
  consent_source?: string
  existing_user_gui?: ExistingUserGui
}

export async function startVirtualGuiGate(
  input: VirtualGuiStartInput,
): Promise<SessionResult<VirtualGuiGateSuccess>> {
  const { capability } = input
  const gated = capabilityGate(input)
  if (gated && gated.refusal) return gated.refusal
  const existing = gated ? gated.existing : undefined
  // The non-blocking note rides on whichever receipt this call ends with: a caller
  // that sees someone else's user-gui must not have to guess why it did not stop
  // the start (S-4 ③). Failures keep their envelope; only evidence grows.
  const carried = <T>(result: SessionResult<T>): SessionResult<T> => {
    if (!existing || result.ok) return result
    return { ...result, evidence: { ...result.evidence, existing_user_gui: existing } }
  }
  const allowed = (consentSource: string): SessionResult<VirtualGuiGateSuccess> =>
    existing
      ? { ok: true, capability, consent_source: consentSource, existing_user_gui: existing }
      : { ok: true, capability, consent_source: consentSource }
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
    return carried(consentFailure<VirtualGuiGateSuccess>('policy_denied', base))
  if (policy === 'allow') return allowed('policy:' + policy)
  const consent = consumeConsentToken(input.caller, input.consentToken)
  if (consent === 'ok') return allowed('token')
  if (consent === 'missing' && takeApprovedToken(input.caller)) return allowed('approved_request')
  // Nothing to consume: file (or reuse) the request the human approves, then wait
  // for them — the panel's button completes *this* call, not a later one.
  const request = ensureConsentRequest(input.caller)
  if (request.rateLimited)
    return carried(
      consentFailure<VirtualGuiGateSuccess>('rate_limited', {
        ...base,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        pending: true,
        waitMs: 0,
        retryAfterMs: request.retryAfterMs,
      }),
    )
  // Only a first start (no token at all) waits for the human. A token that was
  // replayed or expired is the caller's own mistake: answer immediately so the
  // receipt still names 'used' / 'invalid' instead of parking a stale call.
  const waitMs = consent === 'missing' ? consentWaitMs(input.waitMs) : 0
  if (waitMs > 0) {
    const decided = await waitForConsentDecision(request.requestId, waitMs)
    if (decided === 'approved' || decided === 'consumed') {
      if (takeApprovedToken(input.caller)) return allowed('approved_request')
    }
    if (decided === 'denied')
      return carried(
        consentFailure<VirtualGuiGateSuccess>('request_denied', {
          ...base,
          requestId: request.requestId,
          expiresAt: request.expiresAt,
          waitMs,
        }),
      )
    if (decided === 'expired')
      return carried(
        consentFailure<VirtualGuiGateSuccess>('expired', {
          ...base,
          requestId: request.requestId,
          expiresAt: request.expiresAt,
          waitMs,
        }),
      )
  }
  return carried(
    consentFailure<VirtualGuiGateSuccess>(consent, {
      ...base,
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      pending: true,
      waitMs,
    }),
  )
}
