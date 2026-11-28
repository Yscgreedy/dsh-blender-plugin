// Session lifecycle: attach/claim/release/heartbeat plus the virtual-gui start/stop edge.
//
// Extracted from registry.ts (registry split, fifth slice) with no behavior change: the
// bodies of ensureAttached / adopt / tombstoneFor / disconnectedFailure / attach / claim /
// attachChecked / detach / release / releaseSession / heartbeat / start / stop / disposeAll
// moved here verbatim, and so did the lastInstance map they own.
//
// Order in the file follows the original so a reviewer can diff block by block.

import { claimExisting, claimFreeSession, createSession, pickInstance } from './attach.js'
import type { AttachLiveness } from './attach.js'
import { touchAgent } from './presence.js'
import {
  callerKey,
  fail,
  inOwnerFamily,
  isMain,
  ownerMatches,
  ownerStale,
  sameHost,
  sessionView,
} from './types.js'
import type {
  CallerIdentity,
  InstanceRef,
  Owner,
  SessionKind,
  SessionRecord,
  SessionResult,
} from './types.js'

/** What the lifecycle needs from the registry. */
export interface SessionLifecycleHost {
  sessions: Map<string, SessionRecord>
  prune(now?: number): void
  findForCaller(c: CallerIdentity): SessionRecord | null
  liveness(session: SessionRecord): AttachLiveness
  listInstances(): InstanceRef[]
  /** Live ping used by attachChecked (null = no probe configured). */
  verify: ((instanceId: string) => Promise<boolean>) | null
  /** Persisted human pause flag for an instance (survives the session record). */
  pausedFor(instanceId: string): boolean
  startVirtual(
    c: CallerIdentity,
    opts: { kind?: SessionKind; consentToken?: string; waitMs?: number },
  ): Promise<SessionResult<{ session: Record<string, unknown> }>>
  stopVirtual(c: CallerIdentity, sessionId?: string): Promise<SessionResult<{ stopped: boolean }>>
  disposeVirtual(session: SessionRecord): Promise<unknown> | void
}

export class SessionLifecycle {
  /**
   * Last instance each caller attached. prune() releases a user-gui record the
   * moment its socket drops (3.1 semantics: a reconnect claims fresh), so after a
   * window reset attach used to answer "no ready instance" — which reads as "there
   * is no session" when the truth is "your Blender just went away". The tombstone
   * keeps the honest answer without keeping the ownership.
   */
  private lastInstance = new Map<string, { instanceId: string; at: number }>()

  constructor(private readonly host: SessionLifecycleHost) {}

  private ensureAttached(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): SessionResult<{ session: SessionRecord; viewer?: boolean }> {
    this.host.prune()
    const requested = opts.instanceId ? 'user-gui:' + String(opts.instanceId) : ''
    const existing = requested
      ? (this.host.sessions.get(requested) ?? null)
      : this.host.findForCaller(c)
    if (existing) return this.adopt(claimExisting(existing, c, this.host.liveness(existing)), c)
    const picked = pickInstance(this.host.listInstances(), opts)
    if (!('instance' in picked)) {
      // No live instance: prefer "your Blender disconnected" over "no session".
      if (picked.code === 'session_unavailable') {
        const gone = this.disconnectedFailure(c)
        if (gone) return gone
      }
      return picked
    }
    const knownVirtual = this.host.sessions.get('virtual-gui:' + picked.instance.instanceId)
    if (knownVirtual) {
      if (knownVirtual.status !== 'ready')
        return fail(
          'session_unavailable',
          'session',
          'the virtual-gui session is not ready yet',
          'wait for the addon handshake, or check blender_session status',
          { sessionId: knownVirtual.id },
        )
      // claimExisting owns the owner/viewer decision (same-host viewers are allowed,
      // writes still need a grant); owner 过期被 prune 清掉的会话可以重新认领.
      return this.adopt(claimExisting(knownVirtual, c, this.host.liveness(knownVirtual)), c)
    }
    const known = this.host.sessions.get('user-gui:' + picked.instance.instanceId)
    if (known) return this.adopt(claimExisting(known, c, this.host.liveness(known)), c)
    const created = createSession(picked.instance, c)
    created.paused = this.host.pausedFor(picked.instance.instanceId) === true
    if (created.paused) created.pausedAt = Date.now()
    this.host.sessions.set(created.id, created)
    touchAgent(created, c)
    return this.adopt({ ok: true, session: created }, c)
  }

  private adopt(
    result: SessionResult<{ session: SessionRecord; viewer?: boolean }>,
    c: CallerIdentity,
  ): SessionResult<{ session: SessionRecord; viewer?: boolean }> {
    if (result.ok) {
      touchAgent(result.session, c)
      if (result.session.instanceId)
        this.lastInstance.set(callerKey(c), {
          instanceId: result.session.instanceId,
          at: Date.now(),
        })
    }
    return result
  }

  /** The instance this caller attached last, while that memory is still fresh. */
  tombstoneFor(c: CallerIdentity): string | null {
    const last = this.lastInstance.get(callerKey(c))
    return last && Date.now() - last.at < 30 * 60_000 ? last.instanceId : null
  }

  private disconnectedFailure(c: CallerIdentity): SessionResult<never> | null {
    const instanceId = this.tombstoneFor(c)
    if (!instanceId) return null
    return fail(
      'addon_disconnected',
      'session',
      'the Blender instance you were attached to is no longer connected (' + instanceId + ')',
      're-enable DSH Blender Bridge 2.0.0 in that Blender and press Connect in the N panel, then ' +
        'blender_session action=attach; a window reset (wm.read_factory_settings / read_homefile) ' +
        'disables the addon, so the session cannot come back on its own',
      { instanceId: instanceId, ready_instances: 0, tombstone: true },
    ) as SessionResult<never>
  }

  attach(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean; note?: string }> {
    if (opts.kind && opts.kind !== 'user-gui') {
      return fail(
        'invalid_params',
        'session',
        'attach only applies to user-gui; virtual-gui sessions are started by the Gateway',
        'use blender_session start kind=virtual-gui',
        { kind: opts.kind },
      )
    }
    const r = this.ensureAttached(c, opts)
    if (!('session' in r)) return r
    return {
      ok: true,
      session: sessionView(r.session, c),
      ...(r.viewer === true
        ? { viewer: true, note: 'subagent of the owner: read-only viewer (writes need a grant)' }
        : {}),
    }
  }

  claim(
    c: CallerIdentity,
    opts: { instanceId?: string } = {},
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean; note?: string }> {
    return this.attach(c, opts)
  }

  /**
   * attach + a live ping. The static receipt answers "is there a session record
   * that matches you"; this answers "does the Blender behind it still talk".
   * A silent socket is reported as addon_unresponsive and the record is dropped
   * to stopped so the next attach is a fresh claim instead of a stale one.
   */
  async attachChecked(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    const attached = this.attach(c, opts)
    if (!attached.ok) return attached
    const instanceId = String(attached.session.instanceId || '')
    if (!this.host.verify || !instanceId) return attached
    const alive = await this.host.verify(instanceId).catch(() => false)
    if (alive) return attached
    const record = this.host.sessions.get(String(attached.session.id || ''))
    if (record) {
      record.status = 'stopped'
      record.owner = null
      record.agents.clear()
      record.grants.clear()
      record.activePy = null
    }
    return fail(
      'addon_unresponsive',
      'session',
      'the Blender instance behind this session is listed but did not answer a live ping (' +
        instanceId +
        ')',
      'the addon is not running inside that Blender: re-enable DSH Blender Bridge 2.0.0 and ' +
        'press Connect in the N panel, then blender_session action=attach again',
      { instanceId: instanceId, probe: 'ping', sessionId: attached.session.id || null },
    )
  }

  detach(c: CallerIdentity, sessionId?: string): SessionResult<{ released: boolean }> {
    this.host.prune()
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session) return { ok: true, released: false }
    if (session.owner && ownerMatches(session.owner, c) && isMain(session, c)) {
      this.releaseSession(session)
      return { ok: true, released: true }
    }
    session.agents.delete(callerKey(c))
    return { ok: true, released: false }
  }

  release(
    c: CallerIdentity,
    sessionId?: string,
    opts: { force?: boolean } = {},
  ): SessionResult<{ released: boolean; reason: string; previous_owner?: Owner }> {
    this.host.prune()
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session) {
      // 静默 ok 是现场踩过的坑：调用方以为会话已经放掉，实际什么都没发生。
      return fail(
        'session_not_found',
        'session',
        'the session does not exist (nothing was released)',
        'call blender_session action=list to see live sessions',
        { sessionId: sessionId || null, released: false, reason: 'not_found' },
      )
    }
    if (session.owner && !ownerMatches(session.owner, c)) {
      // 反馈 2: a crashed subagent must not lock the GUI forever. Two escape
      // hatches, both explicit in the receipt:
      //   1) force=true from a main agent on the same host (the human's agent);
      //   2) the owner's heartbeat is stale (subagent 30 s / main 30 min).
      const forceHostMain = opts.force === true && c.role === 'main' && sameHost(session.owner, c)
      if (forceHostMain || ownerStale(session.owner)) {
        const reason = forceHostMain ? 'forced_by_host_main' : 'stale_owner'
        const previous = session.owner
        this.releaseSession(session)
        return { ok: true, released: true, reason, previous_owner: previous ?? undefined }
      }
      return fail(
        'session_in_use',
        'session',
        'only the owning DSH session (or a same-host main agent with force=true) can release this GUI session',
        c.role === 'main' && sameHost(session.owner, c)
          ? 'retry with force=true (same-host main agent), or wait for the owner heartbeat to go stale'
          : 'ask the owner to release it; a stale owner heartbeat is reclaimed automatically',
        {
          sessionId: session.id,
          owner: session.owner,
          released: false,
          reason: 'owner_mismatch',
          stale: ownerStale(session.owner),
          force_allowed: c.role === 'main' && sameHost(session.owner, c),
        },
      )
    }
    // owner 心跳过期（主 30 min / 子 agent 30 s）后 prune 只清 owner、保留 agents：此时仍挂在这个会话上的
    // agent 必须能释放它，否则 release 会回 released:false 而会话照旧 ready（现场误判源）。
    const mine = session.agents.has(callerKey(c))
    if (!session.owner && !mine) {
      return fail(
        'session_unowned',
        'session',
        'the session has no owner (owner heartbeat expired) and this caller is not attached to it',
        'attach it first (blender_session action=attach) and then release; or let the main agent release it',
        {
          sessionId: session.id,
          released: false,
          reason: 'owner_expired',
          agents: [...session.agents.keys()],
        },
      )
    }
    const reason = session.owner ? 'owner' : 'owner_expired'
    this.releaseSession(session)
    return { ok: true, released: true, reason }
  }

  releaseSession(s: SessionRecord): void {
    s.owner = null
    s.agents.clear()
    s.grants.clear()
    s.activePy = null
    s.paused = false
    s.pausedAt = null
    s.humanEdits.clear()
    s.humanModifiedAt = null
    s.status = 'stopped'
    if (s.kind === 'virtual-gui') {
      // Releasing the owner tears the provider down too; stop() awaits the same
      // dispose path, while detach/release can stay synchronous at the API edge.
      this.host.sessions.delete(s.id)
      void this.host.disposeVirtual(s)
    }
  }

  heartbeat(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean }> {
    this.host.prune()
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session)
      return fail(
        'session_not_found',
        'session',
        'the session does not exist',
        're-attach the GUI session',
        {},
      )
    if (session.owner && !ownerMatches(session.owner, c)) {
      if (inOwnerFamily(session.owner, c) || sameHost(session.owner, c)) {
        touchAgent(session, c)
        return { ok: true, session: sessionView(session, c), viewer: true }
      }
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'reads are allowed on the same host; writes need a grant from the owner',
        { sessionId: session.id, owner: session.owner, is_mine: false },
      )
    }
    claimFreeSession(session, c)
    return { ok: true, session: sessionView(session, c) }
  }

  async start(
    c: CallerIdentity,
    opts: { kind?: SessionKind; consentToken?: string; waitMs?: number } = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    this.host.prune()
    return this.host.startVirtual(c, opts)
  }

  async stop(c: CallerIdentity, sessionId?: string): Promise<SessionResult<{ stopped: boolean }>> {
    this.host.prune()
    return this.host.stopVirtual(c, sessionId)
  }

  /**
   * H4：Gateway 关停（插件 dispose / 热更重启）时把**所有 virtual-gui** 收干净。
   *
   * 现场事故：helper exe（dsh-blender-hidden-desktop）与它拉起的隐藏 Blender 是
   * Gateway 的孙进程，Gateway 一死就成孤儿，下次安装/替换目录时被占用 → "目录替换半残"。
   * 这里按会话 ledger 逐个 disposeSession（provider.stop 会杀 helper 与隐藏 Blender），
   * 不依赖任何调用者身份 —— 关停不是权限动作。
   */
  async disposeAll(): Promise<{ stopped: string[]; failed: string[] }> {
    const stopped: string[] = []
    const failed: string[] = []
    for (const session of Array.from(this.host.sessions.values())) {
      if (session.kind !== 'virtual-gui') continue
      try {
        this.host.sessions.delete(session.id)
        await this.host.disposeVirtual(session)
        stopped.push(session.id)
      } catch (e) {
        failed.push(session.id + ': ' + String((e as Error).message || e))
      }
    }
    return { stopped, failed }
  }
}
