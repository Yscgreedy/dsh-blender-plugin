import { claimExisting, claimFreeSession, createSession, pickInstance } from './attach.js'
import type { AttachLiveness } from './attach.js'
import { consentPolicy, issueConsentToken } from './consent.js'
import {
  approveConsentRequest,
  consentRequestView,
  consentRequestsFor,
  denyConsentRequest,
  ensureConsentRequest,
} from './consent-requests.js'
import { CFG } from '../../config.js'
import { selectDisplayProvider } from '../../display/provider.js'
import { systemVirtualGuiLimits } from '../../display/limits.js'
import type { VirtualGuiLimits } from '../../display/limits.js'
import { applyHumanPause } from './human.js'
import { applyHumanEditsToSessions, markHumanRead } from './human-edits.js'
import type { HumanEditInput } from './human-edits.js'
import { presenceRows, setSelection, setView, touchAgent } from './presence.js'
import { pyTimeoutFailure, waitForPyLock } from './py-lock.js'
import { grantTo, listGrants, revokeFrom } from './grant-ops.js'
import type { GrantOpsHost } from './grant-ops.js'
import { displayCapabilities } from '../../display/prerequisites.js'
import type { DisplayCapabilities, DisplayProvider } from '../../display/types.js'
import { authorizeMainWrite, coveringGrant, evaluateWriteGate } from './write-gate.js'
import {
  callerKey,
  callerView,
  fail,
  grantView,
  isMain,
  ownerMatches,
  sessionView,
} from './types.js'
import { findCallerSession, pruneSessions, unownedSessions } from './lookup.js'
import { VirtualGuiLifecycle, waitForAddonInstance } from './virtual-gui.js'
import type { ProviderSelector } from './virtual-gui.js'
import type {
  CallerIdentity,
  InstanceRef,
  SessionKind,
  SessionRecord,
  SessionResult,
  ViewPose,
} from './types.js'

export interface SessionRegistryOptions {
  display?: () => DisplayCapabilities
  selectProvider?: ProviderSelector
  waitForInstance?: (instanceId: string, timeoutMs: number) => Promise<boolean>
  limits?: () => VirtualGuiLimits
  /**
   * Live liveness probe for one addon instance (the transport-level ping).
   * attachChecked uses it so an attach never reports ready for a socket that
   * still looks listed but no longer answers.
   */
  verify?: (instanceId: string) => Promise<boolean>
}

function defaultProviderSelector(capabilities: DisplayCapabilities): DisplayProvider | null {
  return selectDisplayProvider({ capabilities }).provider
}

export class SessionRegistry {
  private sessions = new Map<string, SessionRecord>()
  private instances: InstanceRef[] = []
  /**
   * 实例表是否曾经"有内容"。空表本身不是"实例已掉线"的证据 —— 测试里没有真实
   * Gateway 的 registry 恒为空表，把它们当成掉线会把活着的 virtual-gui 拆掉。
   */
  private sawInstances = false
  private humanPaused = new Map<string, boolean>()
  /**
   * Last instance each caller attached. prune() releases a user-gui record the
   * moment its socket drops (3.1 semantics: a reconnect claims fresh), so after a
   * window reset attach used to answer "no ready instance" — which reads as "there
   * is no session" when the truth is "your Blender just went away". The tombstone
   * keeps the honest answer without keeping the ownership.
   */
  private lastInstance = new Map<string, { instanceId: string; at: number }>()

  constructor(
    instances: () => InstanceRef[],
    options: (() => DisplayCapabilities) | SessionRegistryOptions = {},
  ) {
    const opts = typeof options === 'function' ? { display: options } : options
    this.listInstances = instances
    // 构造时已有的实例也算"实例表可用"的证据（registry 通常在所有 addon 之前建）。
    if (instances().length) this.sawInstances = true
    this.displayFn = opts.display || displayCapabilities
    this.limitsFn = opts.limits || (() => systemVirtualGuiLimits(CFG.features.virtualGuiMax))
    this.waitForInstanceFn =
      opts.waitForInstance ||
      ((instanceId, timeoutMs) =>
        waitForAddonInstance(() => this.listInstances(), instanceId, timeoutMs))
    this.verifyFn = opts.verify || null
    this.lifecycle = new VirtualGuiLifecycle(this, opts.selectProvider || defaultProviderSelector)
  }
  private readonly verifyFn: ((instanceId: string) => Promise<boolean>) | null
  private listInstances: () => InstanceRef[]
  private readonly displayFn: () => DisplayCapabilities
  private readonly limitsFn: () => VirtualGuiLimits
  private readonly waitForInstanceFn: (instanceId: string, timeoutMs: number) => Promise<boolean>
  private readonly lifecycle: VirtualGuiLifecycle

  display(): DisplayCapabilities {
    return this.displayFn()
  }

  refreshInstances(next: InstanceRef[]): void {
    this.instances = next
    if (next.length) this.sawInstances = true
  }

  /** Ready instances the Gateway currently knows — routing evidence for the host layer. */
  readyInstanceIds(): string[] {
    this.prune()
    return this.instances.filter((x) => x.ready).map((x) => x.instanceId)
  }

  private prune(now = Date.now()): void {
    this.instances = pruneSessions(this.sessions, this.listInstances, now)
    if (this.instances.length) this.sawInstances = true
    this.reapLostInstances()
  }

  /**
   * A virtual-gui session cannot outlive the Blender it started. The instance_gone
   * event normally disposes it, but a missed event used to leave a session record
   * with a live provider handle and no way to stop it; this is the same teardown,
   * driven from the instance list instead of the event stream.
   */
  private reapLostInstances(): void {
    if (!this.sawInstances) return
    const known = new Set(this.instances.map((x) => x.instanceId))
    for (const s of [...this.sessions.values()]) {
      if (s.kind !== 'virtual-gui' || !s.instanceId || known.has(s.instanceId)) continue
      this.sessions.delete(s.id)
      void this.lifecycle.disposeSession(s)
    }
  }

  findForCaller(c: CallerIdentity): SessionRecord | null {
    const own = findCallerSession(this.sessions, c)
    if (own) return own
    // 归属过期（OWNER_TTL_MS 内没心跳）但 Blender 还连着：唯一一个就算这个调用方的。
    // 否则 list 报 0 个会话、attach/claim/stop 全落回"另有人拥有"，只能杀进程。
    const free = unownedSessions(this.sessions, this.listInstances())
    return free.length === 1 ? (free[0] as SessionRecord) : null
  }

  /** Is the instance behind this record in the live ready list right now? */
  private livenessOf(session: SessionRecord): AttachLiveness {
    const ready = this.instances.filter((x) => x.ready)
    const own = ready.some((x) => x.instanceId === session.instanceId)
    return { instanceReady: own, readyInstances: ready.length }
  }

  private ensureAttached(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): SessionResult<{ session: SessionRecord }> {
    this.prune()
    const requested = opts.instanceId ? 'user-gui:' + String(opts.instanceId) : ''
    const existing = requested ? (this.sessions.get(requested) ?? null) : this.findForCaller(c)
    if (existing) return this.adopt(claimExisting(existing, c, this.livenessOf(existing)), c)
    const picked = pickInstance(this.listInstances(), opts)
    if (!('instance' in picked)) {
      // No live instance: prefer "your Blender disconnected" over "no session".
      if (picked.code === 'session_unavailable') {
        const gone = this.disconnectedFailure(c)
        if (gone) return gone
      }
      return picked
    }
    const knownVirtual = this.sessions.get('virtual-gui:' + picked.instance.instanceId)
    if (knownVirtual) {
      if (knownVirtual.status !== 'ready')
        return fail(
          'session_unavailable',
          'session',
          'the virtual-gui session is not ready yet',
          'wait for the addon handshake, or check blender_session status',
          { sessionId: knownVirtual.id },
        )
      // 只有"确实另有主人"才算 in_use；owner 过期被 prune 清掉的会话可以重新认领。
      if (knownVirtual.owner && !ownerMatches(knownVirtual.owner, c))
        return fail(
          'session_in_use',
          'session',
          'another DSH session owns this virtual-gui session',
          'ask the owner to release it',
          { sessionId: knownVirtual.id },
        )
      return this.adopt(claimExisting(knownVirtual, c, this.livenessOf(knownVirtual)), c)
    }
    const known = this.sessions.get('user-gui:' + picked.instance.instanceId)
    if (known) return this.adopt(claimExisting(known, c, this.livenessOf(known)), c)
    const created = createSession(picked.instance, c)
    created.paused = this.humanPaused.get(picked.instance.instanceId) === true
    if (created.paused) created.pausedAt = Date.now()
    this.sessions.set(created.id, created)
    touchAgent(created, c)
    return this.adopt({ ok: true, session: created }, c)
  }

  private adopt(
    result: SessionResult<{ session: SessionRecord }>,
    c: CallerIdentity,
  ): SessionResult<{ session: SessionRecord }> {
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
  private tombstoneFor(c: CallerIdentity): string | null {
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

  list(): Record<string, unknown>[] {
    this.prune()
    return [...this.sessions.values()].map(sessionView)
  }

  listFor(c: CallerIdentity): Record<string, unknown>[] {
    this.prune()
    const rows = new Map<string, Record<string, unknown>>()
    // 实例维度兜底：Blender 还连着、只是归属过期的会话也列出来。否则模型看到 0 个会话，
    // 手里没有 sessionId，attach/claim/stop 全被 session_in_use 挡住。
    for (const s of unownedSessions(this.sessions, this.instances)) rows.set(s.id, sessionView(s))
    const own = this.findForCaller(c)
    if (own) rows.set(own.id, sessionView(own))
    return [...rows.values()]
  }

  status(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown> }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session) {
      // A released record is gone by design; still answer what happened instead of
      // a bare session_not_found, using the last instance this caller attached.
      const instanceId = this.tombstoneFor(c)
      if (instanceId && !sessionId)
        return {
          ok: true,
          session: {
            id: 'user-gui:' + instanceId,
            kind: 'user-gui',
            instanceId,
            status: 'stopped',
            owner: null,
            agents: [],
            grants: [],
            paused: false,
            activePy: null,
            humanModified: null,
            display: null,
            createdAt: null,
            lastActivityAt: null,
            live: { instanceReady: false, readyInstances: 0 },
            reason: 'addon_disconnected_after_release',
          },
        }
      return fail(
        'session_not_found',
        'session',
        'the session does not exist',
        'call blender_session list to see live sessions',
        { sessionId: sessionId || null },
      )
    }
    if (ownerMatches(session.owner, c) || session.agents.has(callerKey(c))) touchAgent(session, c)
    // live=false is the honest answer for "the record exists but its Blender is
    // gone"; attach refuses to revive it, so status must not imply otherwise.
    return { ok: true, session: { ...sessionView(session), live: this.livenessOf(session) } }
  }

  attach(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): SessionResult<{ session: Record<string, unknown> }> {
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
    return { ok: true, session: sessionView(r.session) }
  }

  claim(
    c: CallerIdentity,
    opts: { instanceId?: string } = {},
  ): SessionResult<{ session: Record<string, unknown> }> {
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
    if (!this.verifyFn || !instanceId) return attached
    const alive = await this.verifyFn(instanceId).catch(() => false)
    if (alive) return attached
    const record = this.sessions.get(String(attached.session.id || ''))
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
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session) return { ok: true, released: false }
    if (session.owner && ownerMatches(session.owner, c) && isMain(session, c)) {
      this.releaseSession(session)
      return { ok: true, released: true }
    }
    session.agents.delete(callerKey(c))
    return { ok: true, released: false }
  }

  release(c: CallerIdentity, sessionId?: string): SessionResult<{ released: boolean }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session) return { ok: true, released: false }
    if (!session.owner) return { ok: true, released: false }
    if (!ownerMatches(session.owner, c)) {
      return fail(
        'session_in_use',
        'session',
        'only the owning DSH session can release this GUI session',
        'ask the owner to release it',
        { sessionId: session.id, owner: session.owner },
      )
    }
    this.releaseSession(session)
    return { ok: true, released: true }
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
      this.sessions.delete(s.id)
      void this.lifecycle.disposeSession(s)
    }
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(String(sessionId)) ?? null
  }

  virtualGuiCount(): number {
    let count = 0
    for (const s of this.sessions.values()) {
      if (s.kind === 'virtual-gui' && (s.status === 'starting' || s.status === 'ready')) count++
    }
    return count
  }

  addSession(session: SessionRecord): void {
    this.sessions.set(session.id, session)
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** The addon socket dropped: a virtual-gui session for it cannot outlive it. */
  handleInstanceGone(instanceId: string): void {
    const session = this.sessions.get('virtual-gui:' + String(instanceId))
    if (!session) return
    session.status = 'stopped'
    this.sessions.delete(session.id)
    void this.lifecycle.disposeSession(session)
  }

  limits(): VirtualGuiLimits {
    return this.limitsFn()
  }

  waitForInstance(instanceId: string, timeoutMs: number): Promise<boolean> {
    return this.waitForInstanceFn(instanceId, timeoutMs)
  }

  heartbeat(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown> }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session)
      return fail(
        'session_not_found',
        'session',
        'the session does not exist',
        're-attach the GUI session',
        {},
      )
    if (session.owner && !ownerMatches(session.owner, c)) {
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'wait for the owner to release it',
        { sessionId: session.id },
      )
    }
    claimFreeSession(session, c)
    return { ok: true, session: sessionView(session) }
  }

  doctor(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{
    readiness: Record<string, unknown>
    session: Record<string, unknown> | null
  }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    const ready = this.listInstances().filter((x) => x.ready)
    return {
      ok: true,
      readiness: {
        ready:
          !!session &&
          session.status === 'ready' &&
          !!session.owner &&
          ownerMatches(session.owner, c),
        session_ready: !!session && session.status === 'ready',
        instances: ready.length,
        sessionId: session ? session.id : null,
        owner: session ? session.owner : null,
        paused: session ? session.paused : false,
        activePy: session && session.activePy ? callerView(session.activePy.caller) : null,
      },
      session: session ? sessionView(session) : null,
    }
  }

  async start(
    c: CallerIdentity,
    opts: { kind?: SessionKind; consentToken?: string } = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    this.prune()
    return this.lifecycle.start(c, opts)
  }
  issueConsent(c: CallerIdentity): SessionResult<{ consentToken: string; expiresAt: number }> {
    return { ok: true, ...issueConsentToken(c) }
  }

  /** File (or reuse) the pending virtual-gui consent request for this caller. */
  requestConsent(c: CallerIdentity): SessionResult<Record<string, unknown>> {
    const filed = ensureConsentRequest(c)
    return {
      ok: true,
      request: consentRequestView(filed.requestId),
      reused: filed.reused,
      policy: consentPolicy(),
    }
  }

  /** Record the human's approval for a filed request (no caller identity needed). */
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
    return { ok: true, policy: consentPolicy(), requests: consentRequestsFor(c) }
  }
  async stop(c: CallerIdentity, sessionId?: string): Promise<SessionResult<{ stopped: boolean }>> {
    this.prune()
    return this.lifecycle.stop(c, sessionId)
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
    for (const session of Array.from(this.sessions.values())) {
      if (session.kind !== 'virtual-gui') continue
      try {
        this.sessions.delete(session.id)
        await this.lifecycle.disposeSession(session)
        stopped.push(session.id)
      } catch (e) {
        failed.push(session.id + ': ' + String((e as Error).message || e))
      }
    }
    return { stopped, failed }
  }

  grant(
    c: CallerIdentity,
    sessionId: string,
    scopes: unknown,
    target?: CallerIdentity,
    ttlMs?: number,
  ): SessionResult<{ grant: Record<string, unknown> }> {
    return grantTo(this.grantHost(), c, sessionId, scopes, target, ttlMs)
  }

  revoke(
    c: CallerIdentity,
    sessionId: string,
    grantId?: string,
  ): SessionResult<{ revoked: string[] }> {
    return revokeFrom(this.grantHost(), c, sessionId, grantId)
  }

  grants(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ grants: Record<string, unknown>[] }> {
    return listGrants(this.grantHost(), c, sessionId)
  }

  private grantHost(): GrantOpsHost {
    return {
      sessions: this.sessions,
      prune: () => this.prune(),
      findForCaller: (caller) => this.findForCaller(caller),
    }
  }

  pause(c: CallerIdentity, _sessionId?: string): SessionResult<{ paused: boolean }> {
    return fail(
      'human_action_required',
      'session',
      'agent calls cannot pause Blender writes',
      'ask the human to pause AI operations in the Blender N-panel',
      { caller: callerView(c) },
    )
  }

  resume(c: CallerIdentity, _sessionId?: string): SessionResult<{ paused: boolean }> {
    return fail(
      'human_action_required',
      'session',
      'only the human can resume agent writes in Blender',
      'resume AI operations in the Blender N-panel',
      { caller: callerView(c) },
    )
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
    const instances = this.listInstances()
    if (!instances.length) return null
    if (instances.some((x) => x.instanceId === instanceId && x.ready)) return null
    return {
      instanceId: String(instanceId),
      ready: instances.filter((x) => x.ready).map((x) => x.instanceId),
    }
  }

  private mustOwn(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: SessionRecord }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session)
      return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {})
    if (session.owner && !ownerMatches(session.owner, c))
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'wait for the owner to release it',
        {},
      )
    claimFreeSession(session, c)
    return { ok: true, session }
  }

  presence(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ presence: Record<string, unknown>[] }> {
    const r = this.status(c, sessionId)
    if (!('session' in r)) return r
    const session = this.sessions.get(String(r.session.id))
    return { ok: true, presence: session ? presenceRows(session) : [] }
  }

  updateView(
    c: CallerIdentity,
    sessionId: string,
    view: Omit<ViewPose, 'updatedAt'>,
  ): SessionResult<{ presence: Record<string, unknown>[] }> {
    const r = this.writableSession(c, sessionId)
    if (!('session' in r)) return r
    return { ok: true, presence: setView(r.session, c, view) }
  }

  updateSelection(
    c: CallerIdentity,
    sessionId: string,
    selected: string[],
    activity?: string,
  ): SessionResult<{ presence: Record<string, unknown>[] }> {
    this.prune()
    const r = this.writableSession(c, sessionId)
    if (!('session' in r)) return r
    return { ok: true, presence: setSelection(r.session, c, selected, activity) }
  }

  private writableSession(
    c: CallerIdentity,
    sessionId: string,
  ): SessionResult<{ session: SessionRecord }> {
    this.prune()
    const session = this.sessions.get(String(sessionId))
    if (!session)
      return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {})
    if (session.owner && !ownerMatches(session.owner, c))
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'wait for the owner to release it',
        {},
      )
    claimFreeSession(session, c)
    return { ok: true, session }
  }

  /** Authorize one write call. Returns the owning session or a structured failure. */
  authorizeWrite(
    c: CallerIdentity,
    sessionId: string | undefined,
    scopes: unknown,
    opts: { py?: boolean; waitMs?: number } = {},
  ): SessionResult<{ sessionId: string; mode: 'main' | 'grant'; grantId?: string }> {
    this.prune()
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session) {
      return fail(
        'session_unavailable',
        'session',
        'no GUI session is attached for this caller',
        'attach a ready Blender session first',
        {},
      )
    }
    if (session.owner && !ownerMatches(session.owner, c)) {
      return fail(
        'session_in_use',
        'session',
        'another DSH session owns this GUI session',
        'wait for the owner to release it',
        { sessionId: session.id, owner: session.owner },
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
    // 无主（归属已过期）的会话在第一次写调用时认领，写门才知道谁是 main。
    claimFreeSession(session, c)
    const gate = evaluateWriteGate(session, c, scopes, opts)
    if (!('effective' in gate)) return gate
    const { effective } = gate
    if (isMain(session, c)) {
      const main = authorizeMainWrite(session, c, effective)
      if (!main.ok) return main
      return { ok: true, sessionId: session.id, mode: 'main' }
    }
    const grant = coveringGrant(session, c, effective)
    if (grant) return { ok: true, sessionId: session.id, mode: 'grant', grantId: grant.id }
    return fail(
      'scope_required',
      'session',
      'the write scope was not granted to this agent',
      'ask the main agent to grant the declared scope',
      {
        requested: effective,
        held: [...session.grants.values()]
          .filter((g) => callerKey(g.holder) === callerKey(c))
          .map(grantView),
      },
    )
  }

  async beginPy(
    c: CallerIdentity,
    sessionId?: string,
    waitMs = 0,
  ): Promise<SessionResult<{ sessionId: string }>> {
    const r = await waitForPyLock(
      () => this.authorizeWrite(c, sessionId, [{ kind: 'exclusive' }], { py: true }),
      waitMs,
    )
    if (!('sessionId' in r)) return r
    const session = this.sessions.get(r.sessionId)
    if (!session)
      return fail('session_not_found', 'session', 'the session disappeared', 're-attach', {})
    session.activePy = { caller: { ...c }, startedAt: Date.now() }
    return { ok: true, sessionId: session.id }
  }

  /** Report a timed-out Python call without releasing the lock. */
  timeoutPy(c: CallerIdentity, sessionId?: string): SessionResult<{ running: boolean }> {
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    return session ? pyTimeoutFailure(session, c) : { ok: true, running: false }
  }

  applyHumanEdits(instanceId: string | undefined, edits: HumanEditInput[]): number {
    return applyHumanEditsToSessions(this.sessions, instanceId, edits)
  }
  markRead(
    c: CallerIdentity,
    sessionId: string | undefined,
    scopes: unknown,
  ): SessionResult<{ cleared: number }> {
    this.prune()
    return markHumanRead(this.sessions, c, sessionId, scopes)
  }

  applyHumanPause(instanceId: string | undefined, paused: boolean): number {
    const id = String(instanceId || '')
    if (id) this.humanPaused.set(id, paused)
    return applyHumanPause(this.sessions, instanceId, paused)
  }

  endPy(c: CallerIdentity, sessionId?: string): SessionResult<{ released: boolean }> {
    const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c)
    if (!session || !session.activePy) return { ok: true, released: false }
    if (callerKey(session.activePy.caller) !== callerKey(c) && !isMain(session, c)) {
      return fail(
        'scope_forbidden',
        'session',
        'only the holder or the main agent can end Python execution',
        'ask the holder to finish',
        {},
      )
    }
    session.activePy = null
    return { ok: true, released: true }
  }
}
