import { CFG } from '../../config.js'
import { selectDisplayProvider } from '../../display/provider.js'
import { systemVirtualGuiLimits } from '../../display/limits.js'
import type { VirtualGuiLimits } from '../../display/limits.js'
import { applyHumanPause } from './human.js'
import { applyHumanEditsToSessions, markHumanRead } from './human-edits.js'
import type { HumanEditInput } from './human-edits.js'
import { presenceRows, setSelection, setView } from './presence.js'
import { pyTimeoutFailure, waitForPyLock } from './py-lock.js'
import { grantTo, listGrants, revokeFrom } from './grant-ops.js'
import type { GrantOpsHost } from './grant-ops.js'
import { displayCapabilities } from '../../display/prerequisites.js'
import type { DisplayCapabilities, DisplayProvider } from '../../display/types.js'
import { ConsentBook } from './consent-book.js'
import { InstanceBook } from './instance-book.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { SessionViews } from './session-views.js'
import { WriteAuthority } from './write-authority.js'
import { callerKey, callerView, fail, isMain, ownerMatches, sessionView } from './types.js'
import { findCallerSession, unownedSessions } from './lookup.js'
import { VirtualGuiLifecycle, waitForAddonInstance } from './virtual-gui.js'
import type { ProviderSelector } from './virtual-gui.js'
import type {
  CallerIdentity,
  InstanceRef,
  Owner,
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
  /**
   * Running headless/render job count for the virtual-gui memory budget (S-5c).
   *
   * Injected by the assembly (app.ts reads it from the job queue), because the
   * registry is built before the queue exists. Absent = the budget never counts
   * job memory, which is the pre-S-5c behaviour.
   */
  jobLoad?: () => number
}

function defaultProviderSelector(capabilities: DisplayCapabilities): DisplayProvider | null {
  return selectDisplayProvider({ capabilities }).provider
}

export class SessionRegistry {
  private sessions = new Map<string, SessionRecord>()
  /** Live instances + the prune they drive (registry 拆分第四刀). */
  private readonly instanceBook: InstanceBook
  /** attach/claim/release/heartbeat + virtual-gui start/stop (registry 拆分第五刀). */
  private readonly sessionLifecycle: SessionLifecycle
  private humanPaused = new Map<string, boolean>()

  constructor(
    instances: () => InstanceRef[],
    options: (() => DisplayCapabilities) | SessionRegistryOptions = {},
  ) {
    const opts = typeof options === 'function' ? { display: options } : options
    this.listInstances = instances
    this.displayFn = opts.display || displayCapabilities
    this.limitsFn = opts.limits || (() => systemVirtualGuiLimits(CFG.features.virtualGuiMax))
    this.waitForInstanceFn =
      opts.waitForInstance ||
      ((instanceId, timeoutMs) =>
        waitForAddonInstance(() => this.listInstances(), instanceId, timeoutMs))
    this.verifyFn = opts.verify || null
    if (opts.jobLoad) this.jobLoad = opts.jobLoad
    this.lifecycle = new VirtualGuiLifecycle(this, opts.selectProvider || defaultProviderSelector)
    this.writes = new WriteAuthority({
      sessions: this.sessions,
      prune: () => this.prune(),
      findForCaller: (c) => this.findForCaller(c),
      listInstances: () => this.listInstances(),
    })
    this.instanceBook = new InstanceBook({
      sessions: this.sessions,
      listInstances: () => this.listInstances(),
      dispose: (session) => this.lifecycle.disposeSession(session),
      limits: () => this.limitsFn(),
      waitForInstance: (instanceId, timeoutMs) => this.waitForInstanceFn(instanceId, timeoutMs),
    })
    this.sessionLifecycle = new SessionLifecycle({
      sessions: this.sessions,
      prune: (now) => this.prune(now),
      findForCaller: (c) => this.findForCaller(c),
      liveness: (session) => this.instanceBook.liveness(session),
      listInstances: () => this.listInstances(),
      verify: this.verifyFn,
      pausedFor: (instanceId) => this.humanPaused.get(instanceId) === true,
      startVirtual: (c, opts) => this.lifecycle.start(c, opts),
      stopVirtual: (c, sessionId) => this.lifecycle.stop(c, sessionId),
      disposeVirtual: (session) => this.lifecycle.disposeSession(session),
    })
    this.views = new SessionViews({
      sessions: this.sessions,
      instances: () => this.instanceBook.list(),
      prune: (now) => this.prune(now),
      findForCaller: (c) => this.findForCaller(c),
      tombstoneFor: (c) => this.sessionLifecycle.tombstoneFor(c),
      livenessOf: (session) => this.instanceBook.liveness(session),
    })
    this.consent = new ConsentBook({
      sessions: this.sessions,
      prune: (now) => this.prune(now),
      instances: () => this.instanceBook.list(),
      virtualGuiCount: () => this.virtualGuiCount(),
      limits: () => this.limitsFn(),
    })
  }
  private readonly verifyFn: ((instanceId: string) => Promise<boolean>) | null
  /** Running job count for the virtual-gui budget (S-5c); injected, never guessed. */
  readonly jobLoad?: () => number
  private listInstances: () => InstanceRef[]
  private readonly displayFn: () => DisplayCapabilities
  private readonly limitsFn: () => VirtualGuiLimits
  private readonly waitForInstanceFn: (instanceId: string, timeoutMs: number) => Promise<boolean>
  private readonly lifecycle: VirtualGuiLifecycle
  /** Ownership/grant/write decision (registry 拆分第一刀); the registry keeps the public entry. */
  private readonly writes: WriteAuthority
  /** Consent filing/decision/panel projection (registry 拆分第二刀). */
  private readonly consent: ConsentBook
  /** Read-only projections: list/listFor/sessionInfo/status (registry 拆分第三刀). */
  private readonly views: SessionViews

  display(): DisplayCapabilities {
    return this.displayFn()
  }

  refreshInstances(next: InstanceRef[]): void {
    this.instanceBook.refresh(next)
  }

  /** Ready instances the Gateway currently knows — routing evidence for the host layer. */
  readyInstanceIds(): string[] {
    return this.instanceBook.ready()
  }

  private prune(now = Date.now()): void {
    this.instanceBook.prune(now)
  }

  findForCaller(c: CallerIdentity): SessionRecord | null {
    const own = findCallerSession(this.sessions, c)
    if (own) return own
    // 归属过期（OWNER_TTL_MS 内没心跳）但 Blender 还连着：唯一一个就算这个调用方的。
    // 否则 list 报 0 个会话、attach/claim/stop 全落回"另有人拥有"，只能杀进程。
    const free = unownedSessions(this.sessions, this.listInstances())
    return free.length === 1 ? (free[0] as SessionRecord) : null
  }

  list(): Record<string, unknown>[] {
    return this.views.list()
  }

  listFor(c: CallerIdentity): Record<string, unknown>[] {
    return this.views.listFor(c)
  }

  /**
   * The instance behind the only same-host session this caller may read but not
   * own. Used for routing: see/read ops need a target, writes still go through
   * authorizeWrite and are refused without a grant.
   */
  readableInstanceFor(c: CallerIdentity): string | null {
    return this.views.readableInstanceFor(c)
  }

  /** Attribution for a plan/op receipt: the session behind the instance we drove. */
  sessionInfo(c: CallerIdentity, instanceId?: string | null): Record<string, unknown> | null {
    return this.views.sessionInfo(c, instanceId)
  }

  status(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown> }> {
    return this.views.status(c, sessionId)
  }

  attach(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean; note?: string }> {
    return this.sessionLifecycle.attach(c, opts)
  }

  claim(
    c: CallerIdentity,
    opts: { instanceId?: string } = {},
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean; note?: string }> {
    return this.sessionLifecycle.claim(c, opts)
  }

  async attachChecked(
    c: CallerIdentity,
    opts: { instanceId?: string; kind?: SessionKind } = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    return this.sessionLifecycle.attachChecked(c, opts)
  }

  detach(c: CallerIdentity, sessionId?: string): SessionResult<{ released: boolean }> {
    return this.sessionLifecycle.detach(c, sessionId)
  }

  release(
    c: CallerIdentity,
    sessionId?: string,
    opts: { force?: boolean } = {},
  ): SessionResult<{ released: boolean; reason: string; previous_owner?: Owner }> {
    return this.sessionLifecycle.release(c, sessionId, opts)
  }

  releaseSession(s: SessionRecord): void {
    this.sessionLifecycle.releaseSession(s)
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(String(sessionId)) ?? null
  }

  virtualGuiCount(): number {
    return this.instanceBook.count()
  }

  addSession(session: SessionRecord): void {
    this.sessions.set(session.id, session)
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** The addon socket dropped: a virtual-gui session for it cannot outlive it. */
  handleInstanceGone(instanceId: string): void {
    this.instanceBook.gone(instanceId)
  }

  limits(): VirtualGuiLimits {
    return this.instanceBook.limits()
  }

  waitForInstance(instanceId: string, timeoutMs: number): Promise<boolean> {
    return this.instanceBook.wait(instanceId, timeoutMs)
  }

  heartbeat(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown>; viewer?: boolean }> {
    return this.sessionLifecycle.heartbeat(c, sessionId)
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
    opts: { kind?: SessionKind; consentToken?: string; waitMs?: number } = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    return this.sessionLifecycle.start(c, opts)
  }

  issueConsent(c: CallerIdentity): SessionResult<{ consentToken: string; expiresAt: number }> {
    return this.consent.issueConsent(c)
  }

  /** File (or reuse) the pending virtual-gui consent request for this caller. */
  requestConsent(c: CallerIdentity): SessionResult<Record<string, unknown>> {
    return this.consent.requestConsent(c)
  }

  /**
   * Record the human's approval for a filed request.
   *
   * Human channel only: the agent surface refuses consent_approve / consent_deny
   * (consent_human_only). The decision logic lives in ConsentBook.
   */
  approveConsent(requestId: unknown, source = 'human'): SessionResult<Record<string, unknown>> {
    return this.consent.approveConsent(requestId, source)
  }

  /** Human-only, same rule as approveConsent. */
  denyConsent(requestId: unknown, reason = 'human denied'): SessionResult<Record<string, unknown>> {
    return this.consent.denyConsent(requestId, reason)
  }

  /** What this caller still has waiting on a human. */
  consentStatus(c: CallerIdentity): SessionResult<Record<string, unknown>> {
    return this.consent.consentStatus(c)
  }

  /**
   * Read-only data for the Blender session panel (no DSH identity: the panel is not
   * the agent and must not become a write path).
   */
  consentPanel(dshSessionId: string, now = Date.now()): Record<string, unknown> {
    return this.consent.consentPanel(dshSessionId, now)
  }

  async stop(c: CallerIdentity, sessionId?: string): Promise<SessionResult<{ stopped: boolean }>> {
    return this.sessionLifecycle.stop(c, sessionId)
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
    return this.sessionLifecycle.disposeAll()
  }

  grant(
    c: CallerIdentity,
    sessionId: string,
    scopes: unknown,
    target?: CallerIdentity,
    ttlMs?: number,
    force = false,
  ): SessionResult<{ grant: Record<string, unknown> }> {
    return grantTo(this.grantHost(), c, sessionId, scopes, target, ttlMs, force)
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
  ): SessionResult<{
    grants: Record<string, unknown>[]
    owner_expired?: boolean
    note?: string
  }> {
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
    return this.writes.writableSession(c, sessionId)
  }

  /**
   * Authorize one write call. Returns the owning session or a structured failure.
   *
   * The decision (ownership, live instance, covering grant, refusal evidence) lives in
   * WriteAuthority; this method is the registry-facing entry and remains the single door
   * that sessionWriteGate calls.
   */
  authorizeWrite(
    c: CallerIdentity,
    sessionId: string | undefined,
    scopes: unknown,
    opts: { py?: boolean; waitMs?: number; scopeDeclared?: boolean } = {},
  ): SessionResult<{ sessionId: string; mode: 'main' | 'grant'; grantId?: string }> {
    return this.writes.authorizeWrite(c, sessionId, scopes, opts)
  }

  async beginPy(
    c: CallerIdentity,
    sessionId?: string,
    waitMs = 0,
    scopes: unknown = [{ kind: 'exclusive' }],
  ): Promise<SessionResult<{ sessionId: string; mode?: 'main' | 'grant'; grantId?: string }>> {
    const r = await waitForPyLock(
      () => this.authorizeWrite(c, sessionId, scopes, { py: true }),
      waitMs,
    )
    if (!('sessionId' in r)) return r
    const session = this.sessions.get(r.sessionId)
    if (!session)
      return fail('session_not_found', 'session', 'the session disappeared', 're-attach', {})
    session.activePy = { caller: { ...c }, startedAt: Date.now() }
    return {
      ok: true,
      sessionId: session.id,
      ...('mode' in r ? { mode: r.mode } : {}),
      ...('grantId' in r && r.grantId ? { grantId: r.grantId } : {}),
    }
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
/**
 * One row of the panel's claim table.
 *
 * `is_mine` answers "does the conversation that renders this panel own that
 * window?" — the same question `blender_session status` answers for the agent of
 * that conversation. The panel has no DSH identity headers, so the owner's host id
 * is borrowed: ownership in 3.1 is host + DSH session, and the session half is the
 * one the panel actually knows.
 */
