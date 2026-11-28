// Write authorization: ownership, live instance, covering grant, refusal evidence.
//
// Extracted from registry.ts (registry split, first slice) with no behavior change: the bodies of
// authorizeWrite / writableSession / writeScopeFailure / writeFailureEvidence and the
// missingInstance probe moved here verbatim. The registry keeps the public method and
// delegates, so every call site and every test still sees the same surface.
//
// What this module needs is deliberately narrow — the sessions map, the stale-state
// prune, the caller lookup, and the instance list — so a test can drive the whole
// write decision without building a registry.

import { claimFreeSession } from './attach.js'
import { touchAgent } from './presence.js'
import { authorizeMainWrite, coveringGrant, evaluateWriteGate } from './write-gate.js'
import {
  callerMatchesHolder,
  callerView,
  fail,
  grantView,
  inOwnerFamily,
  isMain,
  ownerMatches,
  sameHost,
} from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'

/** The state and lookups the write decision is allowed to use. */
export interface WriteAuthorityHost {
  /** Sessions by id — the registry's single map (never a copy). */
  sessions: Map<string, SessionRecord>
  /** Drop stale sessions/instances first, exactly like every registry entry point. */
  prune(): void
  findForCaller(c: CallerIdentity): SessionRecord | null
  listInstances(): InstanceRef[]
}

export class WriteAuthority {
  constructor(private readonly host: WriteAuthorityHost) {}

  /**
   * Presence/selection updates need a session this caller may write to.
   *
   * A family/same-host subagent viewer may publish presence; it never takes ownership.
   */
  writableSession(c: CallerIdentity, sessionId: string): SessionResult<{ session: SessionRecord }> {
    this.host.prune()
    const session = this.host.sessions.get(String(sessionId))
    if (!session)
      return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {})
    if (session.owner && !ownerMatches(session.owner, c)) {
      // A family/same-host subagent viewer may publish presence; it never takes ownership.
      if (inOwnerFamily(session.owner, c) || sameHost(session.owner, c)) {
        touchAgent(session, c)
        return { ok: true, session }
      }
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'wait for the owner to release it',
        {},
      )
    }
    claimFreeSession(session, c)
    return { ok: true, session }
  }

  /**
   * Authorize one write call. Returns the owning session or a structured failure.
   *
   * 反馈 1: the grant check used to sit *after* the ownership check, so a
   * subagent with a covering grant still got session_in_use (or session_required
   * before that). Order is now: state checks → owner/main → covering grant.
   * 反馈 3: a caller that owns nothing gets an explicit "not yours" receipt with
   * the owner and the missing scope, never a silent write into someone's scene.
   */
  authorizeWrite(
    c: CallerIdentity,
    sessionId: string | undefined,
    scopes: unknown,
    opts: { py?: boolean; waitMs?: number; scopeDeclared?: boolean } = {},
  ): SessionResult<{ sessionId: string; mode: 'main' | 'grant'; grantId?: string }> {
    this.host.prune()
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session) {
      return fail(
        'session_unavailable',
        'session',
        'no GUI session is attached for this caller',
        'attach a ready Blender session first (blender_session action=attach)',
        { is_mine: false, caller: callerView(c) },
      )
    }
    // 会话背后的 Blender 已经掉了：这次写不能放行。多实例下 addon.send 会退化成
    // "唯一的 ready 实例"，于是别人的 Blender 被当成本会话的目标 —— 隔离直接失效。
    const missing = this.missingInstance(session.instanceId)
    if (missing)
      return fail(
        'session_unavailable',
        'session',
        'the Blender behind this session is not connected (instance ' + missing.instanceId + ')',
        'blender_session action=attach instance_id=… to take the live instance, then retry',
        { instanceId: missing.instanceId, ready: missing.ready },
      )
    const gate = evaluateWriteGate(session, c, scopes, opts)
    if (!('effective' in gate)) return gate
    const { effective } = gate
    const owned = !session.owner || ownerMatches(session.owner, c)
    if (owned) {
      // 无主（归属已过期）的会话在第一次写调用时认领，写门才知道谁是 main。
      claimFreeSession(session, c)
      if (isMain(session, c)) {
        const main = authorizeMainWrite(session, c, effective)
        if (!main.ok) return main
        return { ok: true, sessionId: session.id, mode: 'main' }
      }
    }
    // Anyone else — a subagent with a different dshSessionId, or another DSH
    // session on the same host — needs a covering grant. This is the branch that
    // used to be unreachable because ownership was rejected first.
    const grant = coveringGrant(session, c, effective)
    if (grant) {
      // Active use renews the grant: a multi-step subagent round should not lose
      // its write scope 10 minutes after the parent issued it.
      const ttl = Math.max(1_000, grant.expiresAt - grant.createdAt)
      grant.heartbeatAt = Date.now()
      grant.expiresAt = grant.heartbeatAt + ttl
      return { ok: true, sessionId: session.id, mode: 'grant', grantId: grant.id }
    }
    return this.writeScopeFailure(session, c, effective, opts)
  }

  /**
   * The session's instance is gone from a non-empty instance list: null when the
   * session still has its Blender, when the list itself is empty (no evidence
   * either way, e.g. a registry without a live Gateway), or when no instance was
   * recorded.
   */
  private missingInstance(
    instanceId: string | null,
  ): { instanceId: string; ready: string[] } | null {
    if (!instanceId) return null
    const instances = this.host.listInstances()
    if (!instances.length) return null
    if (instances.some((x) => x.instanceId === instanceId && x.ready)) return null
    return {
      instanceId: String(instanceId),
      ready: instances.filter((x) => x.ready).map((x) => x.instanceId),
    }
  }

  /**
   * 「没有覆盖 grant」的拒绝回执。py + 未声明 scope 单独说清：viewer 收到的
   * "another DSH session owns this" 听起来像整条通道被占，实际只差一个 write_scope
   * （py 是唯一没有静态 scope 的写通道；读用 blender_see / blender_inspect）。
   */
  private writeScopeFailure(
    session: SessionRecord,
    c: CallerIdentity,
    effective: unknown,
    opts: { py?: boolean; scopeDeclared?: boolean },
  ): SessionResult<{ sessionId: string; mode: 'main' | 'grant'; grantId?: string }> {
    const otherSession = !!session.owner && !ownerMatches(session.owner, c)
    // 只有 HTTP 门明确说"没有声明 scope"（scopeDeclared=false）才改口径；
    // 直接调 registry 的调用方（测试/内部）传了 scopes 就算已声明。
    const pyNeedsScope = opts.py === true && opts.scopeDeclared === false
    const code = pyNeedsScope
      ? 'scope_required'
      : otherSession
        ? 'session_in_use'
        : 'scope_required'
    const rootCause = pyNeedsScope
      ? 'Python writes are authorized by a declared write_scope; this call declared none (is_mine=' +
        String(!otherSession) +
        ')'
      : otherSession
        ? 'another DSH session owns this GUI session (is_mine=false)'
        : 'the write scope was not granted to this agent'
    const fix = pyNeedsScope
      ? 'declare write_scope=collection:COL / prefix:P_ (matching a grant) for a Python write; ' +
        'for reads use blender_see / blender_inspect, or ask the owner for a grant'
      : otherSession
        ? "writes into someone else's scene are refused: ask the owner for " +
          "blender_session action=grant scopes=['collection:…'] (targetAgentId=…) and declare the same " +
          'write_scope on this call; read-only ops are allowed and carry owner/is_mine=false'
        : 'ask the main agent to grant the declared scope'
    return fail(code, 'session', rootCause, fix, this.writeFailureEvidence(session, c, effective))
  }

  /** Field retest: a refusal names caller / owner / every grant holder, not just a code. */
  private writeFailureEvidence(
    session: SessionRecord,
    c: CallerIdentity,
    effective: unknown,
  ): Record<string, unknown> {
    // 附加②：写失败证据曾用 otherSession 推 is_mine，对 owner 家族的子代理会与
    // status/list 的 is_mine 相反（那边按 owner 家族判）。两处用同一判据。
    const mine = !session.owner || ownerMatches(session.owner, c)
    return {
      sessionId: session.id,
      owner: session.owner,
      is_mine: mine,
      borrowed: !mine && sameHost(session.owner, c),
      requested: effective,
      required_scope: effective,
      caller: callerView(c),
      owner_agent: session.owner ? String(session.owner.agentId || '') : null,
      callers_agent: String(c.agentId || ''),
      grant_holders: [...session.grants.values()].map((g) => ({
        agentId: String(g.holder.agentId || ''),
        parentAgentId: g.holder.parentAgentId || null,
        dshSessionId: String(g.holder.dshSessionId || ''),
        scopes: g.scopes,
        expiresInMs: Math.max(0, g.expiresAt - Date.now()),
      })),
      held: [...session.grants.values()]
        .filter((g) => callerMatchesHolder(g.holder, c))
        .map(grantView),
    }
  }
}
