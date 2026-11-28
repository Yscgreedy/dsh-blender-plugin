/**
 * S-6: a subagent's own virtual-gui session must not be stolen while it works.
 *
 * attach.ts keeps "a subagent never becomes the owner" (claimFreeSession only
 * promotes a main agent), but start(kind=virtual-gui) has to record the caller
 * that spawned the window: without it the starter has no grant and
 * claimFreeSession refuses it, so the starter could not write into its own GUI.
 *
 * The owner it recorded used the generic subagent TTL — 30 s — which is shorter
 * than blender_run's 120 s default wait. During that window any same-host caller
 * attached, prune() cleared the "stale" owner, and claimFreeSession handed the
 * session to the newcomer (owner=null -> claim). The fix is a per-owner stale
 * override (Owner.staleMs, honoured by ownerStaleMs so prune and every receipt
 * agree): 5 min for a subagent that starts its own virtual-gui. Defaults stay
 * 30 min for a main owner and 30 s for a subagent attach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isolateConsentDir } from '../../helpers/consent-dir'
import { buildDisplayCapabilities } from '../../../runtime/display/prerequisites.js'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import {
  OWNER_STALE_SUBAGENT_MS,
  OWNER_TTL_MS,
  ownerOf,
  ownerStale,
  ownerStaleMs,
} from '../../../runtime/core/sessions/types.js'
import { VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS } from '../../../runtime/core/sessions/virtual-gui.js'
import type {
  CallerIdentity,
  InstanceRef,
  SessionRecord,
} from '../../../runtime/core/sessions/types.js'
import type { VirtualGuiLimits } from '../../../runtime/display/limits.js'
import type {
  DisplayHealth,
  DisplayInstance,
  DisplayProvider,
  DisplayStartRequest,
} from '../../../runtime/display/types.js'

const MAIN: CallerIdentity = {
  hostId: 'host-a',
  dshSessionId: 'dsh-main',
  agentId: 'lead',
  role: 'main',
}
const CHILD: CallerIdentity = {
  hostId: 'host-a',
  dshSessionId: 'dsh-child',
  agentId: 's6-child',
  parentAgentId: 'lead',
  role: 'subagent',
}
const OTHER_MAIN: CallerIdentity = {
  hostId: 'host-a',
  dshSessionId: 'dsh-other',
  agentId: 'other-main',
  role: 'main',
}

const WIN_CHECKS = { 'win-hidden-desktop-helper': true, blender: true }

function readyCap() {
  return buildDisplayCapabilities({
    platform: 'win32',
    configured: 'on',
    checks: WIN_CHECKS,
    providerImplemented: true,
  })
}

function fakeProvider() {
  const started: DisplayStartRequest[] = []
  const provider: DisplayProvider = {
    kind: 'fake',
    capabilities: readyCap,
    async start(request) {
      started.push(request)
      const display: DisplayInstance = {
        id: 'display_1',
        display: 'dsh-vgui-stale-test',
        pid: 4242,
        provider: 'fake',
      }
      return display
    },
    async stop() {},
    async health(): Promise<DisplayHealth> {
      return { ok: true, detail: 'fake' }
    },
  }
  return { provider, started }
}

function limits(limit = 4): VirtualGuiLimits {
  return {
    limit,
    configured: limit,
    low_resource: false,
    reason: 'configured',
    total_mem_bytes: 0,
    free_mem_bytes: 0,
  }
}

interface Harness {
  reg: SessionRegistry
  instances: InstanceRef[]
}

function harness(): Harness {
  // The spawned instance id only exists after start(); the placeholder keeps the
  // book's "the instance list is real" evidence without faking a ready socket.
  const instances: InstanceRef[] = [{ instanceId: '', ready: true }]
  const { provider } = fakeProvider()
  const reg = new SessionRegistry(() => instances, {
    display: readyCap,
    selectProvider: () => provider,
    waitForInstance: async () => true,
    limits: () => limits(),
  })
  return { reg, instances }
}

async function startVirtual(
  reg: SessionRegistry,
  caller: CallerIdentity,
  instances: InstanceRef[],
): Promise<Record<string, unknown>> {
  const consent = reg.issueConsent(caller)
  if (!consent.ok) throw new Error('consent failed: ' + consent.code)
  const started = await reg.start(caller, { consentToken: consent.consentToken })
  if (!started.ok) throw new Error('start failed: ' + started.code)
  instances[0]!.instanceId = String(started.session.instanceId)
  return started.session
}

/** Age the owner heartbeat without mocking timers (prune compares two timestamps). */
function ageOwnership(reg: SessionRegistry, sessionId: string, ms: number): void {
  const session: SessionRecord | null = reg.getSession(sessionId)
  if (!session || !session.owner) throw new Error('no owner to age')
  session.owner.heartbeatAt = Date.now() - ms
  session.owner.claimedAt = Date.now() - ms
}

/** 隔离 consent 目录：start 会落请求，不能写进操作者的真实 workDir。 */
let consentSandbox: ReturnType<typeof isolateConsentDir> | null = null
beforeAll(() => {
  consentSandbox = isolateConsentDir('dsh-consent-owner-stale-')
})
afterAll(() => {
  consentSandbox?.dispose()
  consentSandbox = null
})

describe('S-6 subagent-started virtual-gui ownership', () => {
  it('does not hand the session to another caller after 60 s without a heartbeat', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, CHILD, instances)
    const id = String(started.id)
    expect(reg.getSession(id)?.owner?.agentId).toBe('s6-child')

    ageOwnership(reg, id, 60_000)

    const other = reg.attach(OTHER_MAIN)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    // Same-host attach is allowed, but only as a viewer: ownership never moves.
    expect(other.viewer).toBe(true)
    expect(other.session.is_mine).toBe(false)
    expect(reg.getSession(id)?.owner?.agentId).toBe('s6-child')
  })

  it('keeps the starting subagent able to write after 60 s (no grant needed)', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, CHILD, instances)
    const id = String(started.id)

    ageOwnership(reg, id, 60_000)

    const write = reg.authorizeWrite(CHILD, id, ['exclusive'])
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.mode).toBe('main')
  })

  it('keeps the same-host main force-release escape hatch during the window', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, CHILD, instances)
    const id = String(started.id)
    ageOwnership(reg, id, 60_000)

    // A crashed starter must not lock the GUI for five minutes: the human's own
    // main agent may still take it back explicitly.
    const released = reg.release(OTHER_MAIN, id, { force: true })
    expect(released.ok).toBe(true)
    if (!released.ok) return
    expect(released.released).toBe(true)
    expect(released.reason).toBe('forced_by_host_main')
    expect(reg.getSession(id)).toBeNull()
  })

  it('still lets the session be reclaimed once the 5 min override expires', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, CHILD, instances)
    const id = String(started.id)

    ageOwnership(reg, id, VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS + 1_000)

    const other = reg.attach(OTHER_MAIN)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(other.viewer ?? false).toBe(false)
    expect(other.session.is_mine).toBe(true)
    expect(reg.getSession(id)?.owner?.agentId).toBe('other-main')
  })
})

describe('S-6 owner stale defaults stay unchanged', () => {
  it('keeps 30 min for a main owner and 30 s for a subagent owner', () => {
    const mainOwner = ownerOf(MAIN)
    const childOwner = ownerOf(CHILD)
    expect(mainOwner.staleMs).toBeUndefined()
    expect(childOwner.staleMs).toBeUndefined()
    expect(ownerStaleMs(mainOwner)).toBe(OWNER_TTL_MS)
    expect(ownerStaleMs(childOwner)).toBe(OWNER_STALE_SUBAGENT_MS)
    expect(OWNER_TTL_MS).toBe(1_800_000)
    expect(OWNER_STALE_SUBAGENT_MS).toBe(30_000)
    // No override means "from the role", including a missing owner record.
    expect(ownerStaleMs(null)).toBe(OWNER_TTL_MS)
  })

  it('expires a subagent owner at 30 s and a main owner at 30 min', () => {
    // Age is measured from the record's own heartbeatAt: prune compares exactly
    // those two numbers, so the assertion never depends on when the test ran.
    const childOwner = ownerOf(CHILD)
    expect(ownerStale(childOwner, childOwner.heartbeatAt + OWNER_STALE_SUBAGENT_MS)).toBe(false)
    expect(ownerStale(childOwner, childOwner.heartbeatAt + OWNER_STALE_SUBAGENT_MS + 1)).toBe(true)

    const mainOwner = ownerOf(MAIN)
    expect(ownerStale(mainOwner, mainOwner.heartbeatAt + OWNER_TTL_MS)).toBe(false)
    expect(ownerStale(mainOwner, mainOwner.heartbeatAt + OWNER_TTL_MS + 1)).toBe(true)
  })

  it('leaves a main-started virtual-gui on the 30 min default', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, MAIN, instances)
    const owner = started.owner as Record<string, unknown>
    expect(owner.role).toBe('main')
    expect(owner.stale_after_ms).toBe(OWNER_TTL_MS)
    expect(reg.getSession(String(started.id))?.owner?.staleMs).toBeUndefined()
  })
})

describe('S-6 the override is visible in the receipts', () => {
  it('pins the virtual-gui subagent override to five minutes', () => {
    expect(VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS).toBe(300_000)
  })

  it('reports the override as stale_after_ms in start, status and list', async () => {
    const { reg, instances } = harness()
    const started = await startVirtual(reg, CHILD, instances)
    const id = String(started.id)

    const startOwner = started.owner as Record<string, unknown>
    expect(startOwner.role).toBe('subagent')
    expect(startOwner.stale_after_ms).toBe(VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS)
    expect(startOwner.stale).toBe(false)
    expect(reg.getSession(id)?.owner?.staleMs).toBe(VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS)

    const status = reg.status(CHILD, id)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    const statusOwner = status.session.owner as Record<string, unknown>
    expect(statusOwner.stale_after_ms).toBe(VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS)

    const row = reg.listFor(CHILD).find((x) => x.id === id)
    expect(row).toBeTruthy()
    expect((row?.owner as Record<string, unknown>).stale_after_ms).toBe(
      VIRTUAL_GUI_SUBAGENT_OWNER_STALE_MS,
    )
  })
})
