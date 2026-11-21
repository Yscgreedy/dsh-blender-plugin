// Gateway-facing session API used by the host's blender_session family.
//
// The existing /lease endpoint doubles as the action dispatcher so the 3.1
// route table keeps its frozen 29 entries; section 7 can expose the family
// without inventing a parallel transport.

import type { ServerResponse } from 'node:http'
import { currentCaller } from '../../caller.js'
import type { AvailabilityFailure } from '../../../core/availability.js'
import type { SessionRegistry } from '../../../core/sessions/registry.js'
import type { CallerIdentity, SessionResult, ViewPose } from '../../../core/sessions/types.js'
import { callerView } from '../../../core/sessions/types.js'
import {
  approveConsentRequest,
  consentApproveCommand,
  denyConsentRequest,
} from '../../../core/sessions/consent-requests.js'
import {
  policyLock,
  resolveConsentPolicy,
  setConsentPolicy,
} from '../../../core/sessions/consent-policy.js'

function statusFor(result: AvailabilityFailure): number {
  if (result.code === 'invalid_params') return 400
  if (result.code === 'session_unavailable') return 503
  if (result.code === 'feature_disabled') return 503
  if (result.code === 'session_not_found') return 404
  return 409
}

function targetCaller(payload: Record<string, unknown>, base: CallerIdentity): CallerIdentity {
  const hostId = String(payload.targetHostId || base.hostId)
  const dshSessionId = String(payload.targetDshSessionId || base.dshSessionId)
  const agentId = String(payload.targetAgentId || payload.agentId || base.agentId)
  const parentAgentId = String(payload.targetParentAgentId || '')
  return { hostId, dshSessionId, agentId, parentAgentId, role: 'subagent' }
}

export interface SessionApiResult {
  status: number
  body: Record<string, unknown>
  /**
   * True when the response answers a browser (the session panel): the lease
   * route then adds the host CORS headers so the page can read it.
   */
  cors?: boolean
}

/**
 * Loopback origins the session panel may be served from. A browser page on any
 * other origin gets no data and no decision: the panel's handle is not a public
 * capability. Requests without an Origin (the human's curl, an agent call) are
 * not browsers and keep the pre-panel behaviour.
 */
const PANEL_ORIGIN_RE = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|dsh-app:\/\/app)$/

export function panelOriginAllowed(origin: unknown): boolean {
  const raw = String(origin || '').trim()
  if (!raw) return true
  return PANEL_ORIGIN_RE.test(raw)
}

/** Gateway 控制面（reload / shutdown）：由 /lease 路由注入，不属于会话注册表。 */
export interface SessionControl {
  /** 回执自带 ok/code 字段（与 SessionResult 同构），直接当 body 透给调用方。 */
  reload: (payload: Record<string, unknown>) => Record<string, unknown>
  shutdown: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Base URL of this Gateway (for the human consent command in a receipt). */
  httpBase?: string
}

/** Add the exact human approve/deny commands to a consent_required receipt. */
function withHumanAction(
  body: Record<string, unknown>,
  control?: SessionControl,
): Record<string, unknown> {
  if (String(body.code || '') !== 'consent_required') return body
  const evidence = (body.evidence || {}) as Record<string, unknown>
  const requestId = String(evidence.request_id || '')
  const base = control && control.httpBase ? control.httpBase : ''
  if (!requestId || !base) return body
  return {
    ...body,
    request_id: requestId,
    human_action: {
      panel:
        'the Blender session panel in this conversation shows the request; approving there completes the start that is waiting',
      approve: consentApproveCommand(base, requestId),
      deny: consentApproveCommand(base, requestId, 'consent_deny'),
      form: 'or run it in any terminal on the Gateway host (PowerShell or bash)',
      then: 'if the waiting start already returned state=pending, call action=start again; the approved request is consumed once',
      preapprove_env: 'DSH_BLENDER_VIRTUAL_GUI_CONSENT=allow on the Gateway host skips this step',
    },
  }
}

/**
 * Switch the policy from the panel: the only write path besides approve/deny.
 *
 * The gate is the same door as a decision (loopback or no Origin, and never a
 * DSH-attributed call), plus the env lock: an environment variable that pins the
 * mode makes a write a lie, so it is refused instead of silently overridden.
 * Only `virtualGuiConsent` is written; the file gets a .bak first.
 */
function policySetAction(payload: Record<string, unknown>, origin: unknown): SessionApiResult {
  if (!panelOriginAllowed(origin)) return forbiddenOrigin('a policy change', origin)
  const lock = policyLock()
  if (lock.locked)
    return {
      status: 409,
      cors: true,
      body: {
        ok: false,
        code: 'policy_locked',
        root_cause:
          lock.env + '=' + String(lock.value) + ' pins the virtual-gui policy for this Gateway',
        fix: 'unset ' + lock.env + ' on the Gateway host, then switch the mode in the panel',
        evidence: { env: lock.env, value: lock.value },
      },
    }
  const written = setConsentPolicy(payload.mode)
  const policy = resolveConsentPolicy()
  return {
    status: written.ok ? 200 : 500,
    cors: true,
    body: {
      ok: written.ok,
      policy: {
        mode: policy.mode,
        policy: policy.policy,
        auto: policy.auto,
        source: policy.source,
        file: written.file,
      },
      effective: written.ok ? 'immediate' : null,
      audit: { at: Date.now(), origin: origin === undefined ? null : String(origin || '') },
      ...(written.ok
        ? { backup: written.backup, previous: written.previous, created: written.created }
        : { code: 'policy_write_failed', root_cause: written.error }),
    },
  }
}

/**
 * The human side of the consent gate. A terminal has no DSH identity headers, so
 * approve/deny are the only actions allowed without a caller — and they need the
 * unguessable request id that a start just showed to the human.
 */
function humanConsentAction(
  registry: SessionRegistry,
  action: string,
  payload: Record<string, unknown>,
  origin: unknown,
): SessionApiResult | null {
  if (action === 'consent_panel') {
    if (!panelOriginAllowed(origin)) return forbiddenOrigin('a session panel read', origin)
    return {
      status: 200,
      cors: true,
      body: registry.consentPanel(String(payload.dshSessionId || payload.sessionId || '')),
    }
  }
  if (action === 'consent_policy_set') return policySetAction(payload, origin)
  if (action !== 'consent_approve' && action !== 'consent_deny') return null
  if (!panelOriginAllowed(origin)) return forbiddenOrigin('a consent decision', origin)
  const ref = payload.requestId ?? payload.handle
  const decided =
    action === 'consent_approve'
      ? approveConsentRequest(ref, String(payload.source || 'human'))
      : denyConsentRequest(ref, String(payload.reason || 'human denied'))
  if (!decided.ok)
    return {
      status: decided.reason === 'missing' ? 404 : 409,
      body: {
        ok: false,
        code: 'consent_' + decided.reason,
        root_cause: 'consent request ' + String(payload.requestId || '') + ' is ' + decided.reason,
        fix:
          decided.reason === 'missing'
            ? 'use the request_id from the blender_session action=start receipt'
            : 'ask the agent to call action=start again to file a fresh request',
        evidence: { requestId: payload.requestId || null, reason: decided.reason },
      },
    }
  return {
    status: 200,
    cors: true,
    body: {
      ok: true,
      decided: action === 'consent_approve' ? 'approved' : 'denied',
      request: decided.request,
      then:
        action === 'consent_approve'
          ? 'the waiting start completes with consent_source=approved_request; if it already returned, one more start consumes the approval'
          : 'the waiting start returns reason=request_denied; no Blender process is started',
    },
  }
}

/** Agent-facing consent actions (identity present). */
function agentConsentAction(
  registry: SessionRegistry,
  action: string,
  _payload: Record<string, unknown>,
): SessionResult<Record<string, unknown>> | null {
  if (action === 'consent_request')
    return registry.requestConsent(currentCaller() as CallerIdentity)
  if (action === 'consent_status') return registry.consentStatus(currentCaller() as CallerIdentity)
  return null
}

/**
 * Decisions are human-only.
 *
 * 3.3.2 field review: `consent_approve` used to be callable by the agent that
 * filed the request, so the whole gate was decorative — start → read the id →
 * approve → spawn. A consent surface the model can drive is the same as no
 * consent surface, so a DSH-attributed call is refused here, not just dropped
 * from the tool schema (a raw HTTP call with identity headers ends up in the
 * same place). The human channel is the one without an identity: the session
 * panel / terminal command. Unattended hosts use the policy (`auto`), which is
 * a human-written file, not a tool call.
 */
const HUMAN_ONLY_ACTIONS = new Set([
  'consent_approve',
  'consent_deny',
  // The panel may switch the policy; an agent that could switch it to auto has
  // no gate at all. Same 403 as a self-approval.
  'consent_policy_set',
])

function humanOnlyRefusal(action: string, payload: Record<string, unknown>): SessionApiResult {
  return {
    status: 403,
    body: {
      ok: false,
      code: 'consent_human_only',
      stage: 'session',
      root_cause:
        'an agent cannot decide a virtual-gui consent request (action=' +
        action +
        ' carries a DSH identity)',
      fix:
        'the human decides in the Blender session panel (or the terminal command from the start receipt); ' +
        'unattended hosts set virtualGuiConsent=auto in the profile / config file',
      fallback: { kind: 'unavailable', summary: 'no consent was granted or revoked' },
      evidence: {
        action,
        request_id: payload.requestId || payload.handle || null,
        caller: callerView(currentCaller() as CallerIdentity),
      },
    },
  }
}

/** One refusal shape for every panel action reached from a foreign origin. */
function forbiddenOrigin(what: string, origin?: unknown): SessionApiResult {
  return {
    status: 403,
    cors: true,
    body: {
      ok: false,
      code: 'origin_not_allowed',
      root_cause: what + ' from this origin is not accepted',
      fix: 'use the session panel of the DSH conversation (loopback origin), or the terminal command from the receipt',
      evidence: { origin: origin === undefined ? null : String(origin || '') },
    },
  }
}

export async function dispatchSessionAction(
  registry: SessionRegistry,
  action: string,
  payload: Record<string, unknown>,
  control?: SessionControl,
  origin?: unknown,
): Promise<SessionApiResult> {
  const caller = currentCaller()
  if (!caller) {
    const human = humanConsentAction(registry, action, payload, origin)
    if (human) return human
    return {
      status: 400,
      body: {
        ok: false,
        code: 'caller_identity_required',
        error: 'session actions require X-DSH-Host-Id / X-DSH-Session-Id / X-DSH-Agent-Id',
      },
    }
  }
  if (HUMAN_ONLY_ACTIONS.has(action)) return humanOnlyRefusal(action, payload)
  const consent = agentConsentAction(registry, action, payload)
  const result = consent || (await runSessionAction(registry, caller, action, payload, control))
  if (!result.ok)
    return {
      status: statusFor(result),
      body: withHumanAction(result as unknown as Record<string, unknown>, control),
    }
  return { status: 200, body: result as unknown as Record<string, unknown> }
}

/**
 * start：手动同意策略下这次调用会等人类在面板里点批准（waitMs），所以参数在这里
 * 归一化，runSessionAction 只留一行。
 */
function startAction(
  registry: SessionRegistry,
  caller: CallerIdentity,
  payload: Record<string, unknown>,
): Promise<SessionResult<Record<string, unknown>>> {
  const requested = payload.waitMs ?? payload.wait_ms
  return registry.start(caller, {
    kind: payload.kind === undefined ? undefined : (String(payload.kind) as 'virtual-gui'),
    consentToken: payload.consentToken === undefined ? undefined : String(payload.consentToken),
    waitMs: requested === undefined || requested === null ? undefined : Number(requested),
  })
}

/** reload / shutdown：只有宿主接上了控制面才可用，否则如实说没接。 */
async function controlAction(
  control: SessionControl | undefined,
  action: string,
  payload: Record<string, unknown>,
): Promise<SessionResult<Record<string, unknown>>> {
  if (!control)
    return {
      ok: false,
      code: 'feature_disabled',
      stage: 'config',
      root_cause: action + ' control is not wired in this Gateway build',
      fix:
        action === 'reload'
          ? 'rebuild the Gateway (npm run build) or use blender_session action=reload'
          : 'rebuild the Gateway (npm run build)',
      fallback: { kind: 'unavailable', summary: action + ' unavailable' },
      evidence: { action },
    }
  if (action === 'reload')
    return control.reload(payload) as unknown as SessionResult<Record<string, unknown>>
  return (await control.shutdown(payload)) as unknown as SessionResult<Record<string, unknown>>
}

async function runSessionAction(
  registry: SessionRegistry,
  caller: CallerIdentity,
  action: string,
  payload: Record<string, unknown>,
  control?: SessionControl,
): Promise<SessionResult<Record<string, unknown>>> {
  const sessionId = payload.sessionId === undefined ? undefined : String(payload.sessionId)
  switch (action) {
    // H2：一步式热更（HTTP 面）。宿主面同构，见 src/tools/session/reload.ts。
    case 'reload':
      return await controlAction(control, 'reload', payload)
    // H4：插件 dispose / 热更重启前的收尾（virtual-gui + 作业 + 进程）
    case 'shutdown':
      return await controlAction(control, 'shutdown', payload)
    case 'whoami':
      return { ok: true, caller: callerView(caller), ...callerView(caller) }
    case 'list':
      return { ok: true, sessions: registry.listFor(caller) }
    case 'attach':
    case 'claim':
      return registry.attachChecked(caller, {
        instanceId: payload.instanceId === undefined ? undefined : String(payload.instanceId),
        kind: payload.kind === undefined ? undefined : (String(payload.kind) as 'user-gui'),
      })
    case 'detach':
      return registry.detach(caller, sessionId)
    case 'release':
      return registry.release(caller, sessionId, {
        force: payload.force === true || payload.force === 'true',
      })
    case 'status':
      return registry.status(caller, sessionId)
    case 'doctor':
      return registry.doctor(caller, sessionId)
    case 'consent':
      return registry.issueConsent(caller)
    case 'start':
      return await startAction(registry, caller, payload)
    case 'stop':
      return await registry.stop(caller, sessionId)
    case 'grant':
      return registry.grant(
        caller,
        String(sessionId || ''),
        payload.scopes === undefined ? payload.scope : payload.scopes,
        targetCaller(payload, caller),
        Number(payload.ttlMs),
        payload.force === true || payload.force === 'true',
      )
    case 'revoke':
      return registry.revoke(
        caller,
        String(sessionId || ''),
        payload.grantId === undefined ? undefined : String(payload.grantId),
      )
    case 'grants':
      return registry.grants(caller, sessionId)
    case 'pause':
      return registry.pause(caller, sessionId)
    case 'resume':
      return registry.resume(caller, sessionId)
    case 'mark_read':
      return registry.markRead(
        caller,
        sessionId,
        payload.scopes === undefined ? payload.scope : payload.scopes,
      )
    case 'update_view':
      return registry.updateView(
        caller,
        String(sessionId || ''),
        (payload.view || {}) as unknown as Omit<ViewPose, 'updatedAt'>,
      )
    case 'update_selection':
      return registry.updateSelection(
        caller,
        String(sessionId || ''),
        Array.isArray(payload.selected) ? payload.selected.map(String) : [],
        payload.activity === undefined ? undefined : String(payload.activity),
      )
    case 'presence':
      return registry.presence(caller, sessionId)
    case 'heartbeat':
      return registry.heartbeat(caller, sessionId)
    default:
      return {
        ok: false,
        code: 'invalid_params',
        stage: 'config',
        root_cause: 'unknown session action: ' + action,
        fix: 'use whoami, list, attach, claim, detach, release, status, doctor, consent, consent_request, consent_status, start, stop, grant, revoke, grants, pause, resume, mark_read, presence, update_view, update_selection, heartbeat, reload, shutdown (consent_approve / consent_deny are human-only: session panel or terminal)',
        fallback: { kind: 'unavailable', summary: 'the session action was not executed' },
        evidence: { action },
      }
  }
}

export async function sessionAction(
  res: ServerResponse,
  registry: SessionRegistry,
  payload: Record<string, unknown>,
): Promise<SessionApiResult> {
  return dispatchSessionAction(registry, String(payload.action || ''), payload)
}
