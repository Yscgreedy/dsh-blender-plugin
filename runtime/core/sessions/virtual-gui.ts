// virtual-gui lifecycle (3.1 tasks 4.4 / 4.9).
//
// A start is only successful once the addon handshake for the exact instance the
// Gateway spawned is visible. Every failure path stops the provider again, so an
// aborted start never leaves a Blender process or a half-registered session.
import { randomUUID } from 'node:crypto'
import { AVAILABILITY_STAGES, availabilityFailure } from '../availability.js'
import type { AvailabilityFailure, AvailabilityStage } from '../availability.js'
import { isRecord } from '../../foundation/json.js'
import { startVirtualGuiGate } from './display-gate.js'
import { fail, ownerMatches, ownerOf, sessionView } from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'
import { admitVirtualGui, VIRTUAL_GUI_JOB_MEMORY_ESTIMATE_BYTES } from '../../display/limits.js'
import type { VirtualGuiAdmission, VirtualGuiLimits } from '../../display/limits.js'
import type { DisplayCapabilities, DisplayInstance, DisplayProvider } from '../../display/types.js'

export const VIRTUAL_GUI_HANDSHAKE_TIMEOUT_MS = 30_000
/**
 * Ownership window for a subagent that starts its own virtual-gui (S-6).
 *
 * attach.ts keeps "a subagent never becomes the owner" for a GUI that already
 * exists, but the starter of this window has to own it: a subagent holds no
 * grant on the session it just created and claimFreeSession refuses subagents,
 * so without ownership it could not write into the Blender it spawned. With the
 * generic 30 s subagent TTL — shorter than blender_run's 120 s default wait —
 * any same-host attach during that wait saw a stale owner, prune cleared it and
 * the newcomer claimed the session. Five minutes covers the longest synchronous
 * tool call; afterwards the record still expires and stays reclaimable.
 */
export const VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS = 300_000
/**
 * How long after "ready" the budget is priced again (S-5b).
 *
 * Long enough for the spawned Blender to have loaded its startup scene (that is
 * where the memory actually goes), short enough to be inside the same tool call
 * the caller is still waiting on. The timer is unref'd and cancelled on
 * stop/release, so it never holds the Gateway open for accounting.
 */
export const VIRTUAL_GUI_BUDGET_RECHECK_MS = 5_000
const HANDSHAKE_POLL_MS = 100

/** Everything the lifecycle needs from the registry it belongs to. */
export interface VirtualGuiHost {
  display(): DisplayCapabilities
  findForCaller(c: CallerIdentity): SessionRecord | null
  getSession(sessionId: string): SessionRecord | null
  virtualGuiCount(): number
  limits(): VirtualGuiLimits
  addSession(session: SessionRecord): void
  removeSession(sessionId: string): void
  releaseSession(session: SessionRecord): void
  waitForInstance(instanceId: string, timeoutMs: number): Promise<boolean>
  /**
   * How many headless/render jobs the queue is running right now (S-5c).
   *
   * Optional: a host that cannot answer (tests, embedders) leaves the memory
   * budget exactly as it was before S-5c.
   */
  jobLoad?: () => number
}

export type ProviderSelector = (capabilities: DisplayCapabilities) => DisplayProvider | null

export interface VirtualGuiStartOptions {
  kind?: string
  consentToken?: string
  /** Manual consent: how long this start waits for the human's decision. */
  waitMs?: number
}

function stageOf(value: unknown): AvailabilityStage {
  const text = String(value || '')
  return (AVAILABILITY_STAGES as readonly string[]).includes(text)
    ? (text as AvailabilityStage)
    : 'spawn'
}

function providerFailure(error: unknown): AvailabilityFailure {
  if (error instanceof Error && 'view' in error && typeof error.view === 'function') {
    const view = (error as unknown as { view: () => unknown }).view()
    if (isRecord(view)) {
      return availabilityFailure({
        stage: stageOf(view.stage),
        code: String(view.code || 'provider_start_failed'),
        rootCause: String(view.root_cause || error.message || 'the display provider failed'),
        fix: String(view.fix || 'inspect the provider error and retry'),
        fallback: {
          kind: 'unavailable',
          summary: 'virtual-gui did not start; no Blender process was left behind',
        },
        evidence: isRecord(view.evidence) ? view.evidence : {},
      })
    }
  }
  return availabilityFailure({
    stage: 'spawn',
    code: 'provider_start_failed',
    rootCause: error instanceof Error ? error.message : String(error),
    fix: 'inspect the Gateway log and the display prerequisites, then retry',
    fallback: {
      kind: 'unavailable',
      summary: 'virtual-gui did not start; no Blender process was left behind',
    },
    evidence: {},
  })
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GiB'
}

/**
 * Memory the running job load reserves right now (S-5c).
 *
 * The queue owns its own Blender processes; free memory does not say how many are
 * alive. Each running job is counted at VIRTUAL_GUI_JOB_MEMORY_ESTIMATE_BYTES so a
 * virtual-gui start does not price itself against memory those jobs hold. A host
 * without jobLoad, a throwing probe, or a non-positive answer all mean "0": the
 * budget then behaves exactly as it did before S-5c.
 */
function jobReservationBytes(host: VirtualGuiHost): number {
  if (!host.jobLoad) return 0
  let running = 0
  try {
    running = Number(host.jobLoad())
  } catch (error) {
    return 0
  }
  if (!Number.isFinite(running) || running <= 0) return 0
  return Math.floor(running) * VIRTUAL_GUI_JOB_MEMORY_ESTIMATE_BYTES
}

/**
 * Refuse an admission (S-5).
 *
 * Both refusals keep the historical `stage=session` / `code=capacity` pair —
 * the caller-visible contract — and differ only in the reason and the numbers
 * behind it. evidence.reason is now the admission verdict (`limit` / `memory`);
 * the limit resolver's own verdict stays under `limit_reason` and
 * `low_resource` keeps its meaning, so old readers still find their fields.
 */
function capacityFailure(
  admission: VirtualGuiAdmission,
  limits: VirtualGuiLimits,
): AvailabilityFailure {
  const overMemory = admission.reason === 'memory'
  const shortBy = Math.max(0, admission.required_bytes - admission.free)
  return availabilityFailure({
    stage: 'session',
    code: 'capacity',
    rootCause: overMemory
      ? 'not enough free memory for another virtual-gui: ' +
        gib(admission.required_bytes) +
        ' needed (' +
        gib(admission.per_instance_bytes) +
        ' per instance + ' +
        gib(admission.reserve_host_bytes) +
        ' host reserve), ' +
        gib(admission.free) +
        ' free' +
        (admission.job_mem_bytes > 0
          ? ' minus ' +
            gib(admission.job_mem_bytes) +
            ' reserved for running jobs (' +
            gib(admission.effective_free) +
            ' effective)'
          : '')
      : 'virtual-gui instance limit reached (' +
        String(admission.used) +
        '/' +
        String(admission.limit) +
        ')',
    fix: overMemory
      ? 'free about ' +
        gib(shortBy) +
        ' (close applications or stop a virtual-gui session), then retry'
      : 'stop an existing virtual-gui session, or raise features.virtualGuiMax ' +
        '(env DSH_BLENDER_VIRTUAL_GUI_MAX) within 1-16',
    fallback: {
      kind: 'degraded',
      summary: 'no extra Blender process was started; reuse or stop an existing session',
    },
    evidence: {
      used: admission.used,
      limit: admission.limit,
      configured: limits.configured,
      low_resource: admission.low_resource,
      reason: admission.reason,
      limit_reason: limits.reason,
      free: admission.free,
      per_instance: admission.per_instance_bytes,
      reserve: admission.reserve_host_bytes,
      required: admission.required_bytes,
      // S-5c: what the running jobs reserved, and the free figure left over.
      job_mem: admission.job_mem_bytes,
      effective_free: admission.effective_free,
    },
  })
}

function handshakeFailure(
  instanceId: string,
  display: DisplayInstance,
  timeoutMs: number,
): AvailabilityFailure {
  return availabilityFailure({
    stage: 'handshake',
    code: 'addon_handshake_timeout',
    rootCause:
      'the spawned Blender did not connect to the Gateway within ' +
      String(timeoutMs) +
      'ms (instance ' +
      instanceId +
      ')',
    fix:
      'check that DSH Blender Bridge 2.0.0 is installed and enabled in the Blender ' +
      'the provider launched, then retry',
    fallback: {
      kind: 'unavailable',
      summary: 'the provider was stopped; no half instance was left behind',
    },
    evidence: {
      instanceId,
      display: display.display,
      pid: display.pid,
      timeoutMs,
    },
  })
}

export class VirtualGuiLifecycle {
  private readonly host: VirtualGuiHost
  private readonly selectProvider: ProviderSelector
  /** Pending post-ready budget rechecks, keyed by session id (S-5b). */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(host: VirtualGuiHost, selectProvider: ProviderSelector = () => null) {
    this.host = host
    this.selectProvider = selectProvider
  }

  async start(
    caller: CallerIdentity,
    opts: VirtualGuiStartOptions = {},
  ): Promise<SessionResult<{ session: Record<string, unknown> }>> {
    const capability = this.host.display()
    const gated = await startVirtualGuiGate({
      caller,
      kind: opts.kind,
      consentToken: opts.consentToken,
      capability,
      existing: this.host.findForCaller(caller),
      waitMs: opts.waitMs,
    })
    if (!gated.ok) return gated
    const limits = this.host.limits()
    // The registry's effective limit is the structural ceiling: it is what every
    // other surface (consent panel, status) advertises, so a deliberately
    // lowered cap is never raised here. Under it, the budget decides with the
    // free memory read right now — not with a value cached at startup (S-5) —
    // after reserving what the running jobs hold (S-5c).
    const admission = admitVirtualGui({
      used: this.host.virtualGuiCount(),
      configured: Math.min(limits.limit, limits.configured),
      freeMemBytes: limits.free_mem_bytes,
      totalMemBytes: limits.total_mem_bytes,
      jobMemBytes: jobReservationBytes(this.host),
    })
    if (!admission.ok) return capacityFailure(admission, limits)
    const provider = this.selectProvider(capability)
    if (!provider)
      return fail(
        'provider_unavailable',
        'config',
        'virtual-gui is ready but this build selected no startable provider',
        capability.fix || 'enable a display provider or use user-gui / headless render',
        { provider: capability.provider, missing: capability.missing },
      )
    const instanceId = 'vgui-' + randomUUID().replace(/-/g, '').slice(0, 24)
    let display: DisplayInstance
    try {
      display = await provider.start({ sessionId: instanceId, instanceId })
    } catch (error) {
      return providerFailure(error)
    }
    const ready = await this.host.waitForInstance(instanceId, VIRTUAL_GUI_HANDSHAKE_TIMEOUT_MS)
    if (!ready) {
      await this.dispose(display, provider)
      return handshakeFailure(instanceId, display, VIRTUAL_GUI_HANDSHAKE_TIMEOUT_MS)
    }
    const session = this.readySession(caller, instanceId, display, provider)
    this.host.addSession(session)
    this.scheduleRecheck(session)
    // consent_source tells the caller why it was allowed (policy / token / human
    // approval) — the field the 3.1 receipt was missing when start was refused.
    // existing_user_gui (S-4b) is the gate's three-way note about a user-gui this
    // start did not have to obey: without it, policy=allow succeeded silently and
    // the caller could not tell "nobody else is here" from "someone else is, and
    // it does not block you".
    return {
      ok: true,
      session: {
        ...sessionView(session),
        consent_source: gated.consent_source,
        ...(gated.existing_user_gui ? { existing_user_gui: gated.existing_user_gui } : {}),
      },
    }
  }

  /**
   * The ready session record for one spawned instance.
   *
   * Ownership: the starter owns the window it spawned (S-6) — a subagent keeps it
   * for a full job wait instead of the generic 30 s, a main agent keeps 30 min.
   * Split out of start() so the pre-spawn / admission / receipt flow stays one
   * readable sequence and this literal keeps its per-field comments.
   */
  private readySession(
    caller: CallerIdentity,
    instanceId: string,
    display: DisplayInstance,
    provider: DisplayProvider,
  ): SessionRecord {
    const now = Date.now()
    return {
      id: 'virtual-gui:' + instanceId,
      kind: 'virtual-gui',
      instanceId,
      status: 'ready',
      owner: ownerOf(
        caller,
        caller.role === 'subagent' ? VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS : undefined,
      ),
      agents: new Map(),
      grants: new Map(),
      paused: false,
      pausedAt: null,
      activePy: null,
      humanEdits: new Map(),
      humanModifiedAt: null,
      display,
      provider,
      createdAt: now,
      lastActivityAt: now,
    }
  }

  async stop(
    caller: CallerIdentity,
    sessionId?: string,
  ): Promise<SessionResult<{ stopped: boolean }>> {
    const session = sessionId
      ? this.host.getSession(String(sessionId))
      : this.host.findForCaller(caller)
    if (!session) return { ok: true, stopped: false }
    if (session.kind !== 'virtual-gui') {
      return fail(
        'invalid_params',
        'session',
        'stop does not control a user-started Blender',
        'close Blender yourself; stop only manages virtual-gui',
        { sessionId: session.id },
      )
    }
    // 归属过期（owner 被 prune 清掉）的会话没有主人：谁都能停，否则只能杀进程。
    if (session.owner && !ownerMatches(session.owner, caller)) {
      return fail(
        'session_in_use',
        'session',
        'only the owning DSH session can stop this virtual-gui session',
        'ask the owner to stop it',
        { sessionId: session.id },
      )
    }
    if (!session.owner) session.owner = ownerOf(caller)
    this.host.removeSession(session.id)
    await this.disposeSession(session)
    return { ok: true, stopped: true }
  }

  /**
   * Stop a virtual-gui session whose owner no longer exists (best effort).
   *
   * This is the single teardown choke point (stop / release / disposeAll /
   * instance-gone all land here), so a pending budget recheck is cancelled first:
   * a timer that outlived its session would price an instance that no longer
   * exists and could mark a stopped record degraded.
   */
  async disposeSession(session: SessionRecord): Promise<void> {
    this.cancelRecheck(session.id)
    if (session.provider && session.display) await this.dispose(session.display, session.provider)
    session.display = null
    session.provider = null
    session.status = 'stopped'
  }

  /** Arm the post-ready budget recheck (S-5b); replaces any pending one. */
  private scheduleRecheck(session: SessionRecord): void {
    this.cancelRecheck(session.id)
    const timer = setTimeout(() => {
      this.rechecks.delete(session.id)
      this.recheckBudget(session)
    }, VIRTUAL_GUI_BUDGET_RECHECK_MS)
    // Accounting must never be a reason for the process to stay alive.
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
    this.rechecks.set(session.id, timer)
  }

  /** Drop a pending recheck (stop / release / dispose). */
  private cancelRecheck(sessionId: string): void {
    const timer = this.rechecks.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.rechecks.delete(sessionId)
  }

  /**
   * Price the instance again once it is real (S-5b).
   *
   * The same budget admitVirtualGui runs before a spawn, with the free memory of
   * *now* and the count that includes this instance: a verdict of "no" means the
   * machine can no longer pay for one more window, which is exactly the pressure
   * this instance added. The verdict is recorded on the session and never stops
   * the process — the caller may be mid-scene, and accounting is not a kill
   * switch; the next start is priced from live numbers again anyway.
   */
  private recheckBudget(session: SessionRecord): void {
    if (session.status !== 'ready') return
    // A session removed without disposeSession (registry restart) must not be
    // resurrected by a stale timer.
    if (this.host.getSession(session.id) !== session) return
    const limits = this.host.limits()
    const admission = admitVirtualGui({
      used: this.host.virtualGuiCount(),
      configured: Math.min(limits.limit, limits.configured),
      freeMemBytes: limits.free_mem_bytes,
      totalMemBytes: limits.total_mem_bytes,
      jobMemBytes: jobReservationBytes(this.host),
    })
    // Only memory pressure is a degradation of this instance; 'limit' means the
    // operator's cap was reached, which is the cap working, not a shortfall.
    if (admission.reason !== 'memory') return
    session.degradation = {
      reason: 'memory',
      at: Date.now(),
      free: admission.free,
      required: admission.required_bytes,
      limit: admission.limit,
    }
  }

  private async dispose(display: DisplayInstance, provider: DisplayProvider): Promise<void> {
    try {
      await provider.stop(display)
    } catch (error) {
      // The failure path must still report the original start error; the stop
      // attempt is recorded by the provider/helper logs instead.
    }
  }
}

/** Poll the Gateway instance list so a caller can inject a cheaper waiter in tests. */
export async function waitForAddonInstance(
  instances: () => InstanceRef[],
  instanceId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (instances().some((x) => x.instanceId === instanceId && x.ready)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_POLL_MS))
  }
}
