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
import { admitVirtualGui } from '../../display/limits.js'
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
        ' free'
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
    // free memory read right now — not with a value cached at startup (S-5).
    const admission = admitVirtualGui({
      used: this.host.virtualGuiCount(),
      configured: Math.min(limits.limit, limits.configured),
      freeMemBytes: limits.free_mem_bytes,
      totalMemBytes: limits.total_mem_bytes,
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
    const now = Date.now()
    const session: SessionRecord = {
      id: 'virtual-gui:' + instanceId,
      kind: 'virtual-gui',
      instanceId,
      status: 'ready',
      // The starter owns the window it spawned (S-6): a subagent keeps it for a
      // full job wait instead of the generic 30 s, a main agent keeps 30 min.
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
    this.host.addSession(session)
    // consent_source tells the caller why it was allowed (policy / token / human
    // approval) — the field the 3.1 receipt was missing when start was refused.
    return { ok: true, session: { ...sessionView(session), consent_source: gated.consent_source } }
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

  /** Stop a virtual-gui session whose owner no longer exists (best effort). */
  async disposeSession(session: SessionRecord): Promise<void> {
    if (session.provider && session.display) await this.dispose(session.display, session.provider)
    session.display = null
    session.provider = null
    session.status = 'stopped'
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
