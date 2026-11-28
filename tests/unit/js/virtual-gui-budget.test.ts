/**
 * S-5: virtual-gui admission is a budget, not a startup snapshot.
 *
 * The pure function carries the model; the registry cases prove the gate runs
 * before any provider start and that the receipt carries the numbers behind
 * the decision (limit / used / free / per_instance / reserve).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isolateConsentDir } from '../../helpers/consent-dir'
import { buildDisplayCapabilities } from '../../../runtime/display/prerequisites.js'
import {
  admitVirtualGui,
  VIRTUAL_GUI_DEFAULT_MAX,
  VIRTUAL_GUI_HOST_RESERVE_BYTES,
  VIRTUAL_GUI_LOW_RESOURCE_MAX,
  VIRTUAL_GUI_PER_INSTANCE_BYTES,
} from '../../../runtime/display/limits.js'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import { VIRTUAL_GUI_BUDGET_RECHECK_MS } from '../../../runtime/core/sessions/virtual-gui.js'
import type { VirtualGuiLimits } from '../../../runtime/display/limits.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'
import type {
  DisplayHealth,
  DisplayInstance,
  DisplayProvider,
  DisplayStartRequest,
} from '../../../runtime/display/types.js'

const GIB = 1024 ** 3
const FULL = 32 * GIB
const THREE_HALF = 3.5 * GIB
const SIX_HALF = 6.5 * GIB

const WIN_CHECKS = { 'win-hidden-desktop-helper': true, blender: true }
const MAIN = { hostId: 'h', dshSessionId: 's1', agentId: 'a1', role: 'main' as const }
const OTHER = { hostId: 'h', dshSessionId: 's2', agentId: 'a2', role: 'main' as const }
const THIRD = { hostId: 'h', dshSessionId: 's3', agentId: 'a3', role: 'main' as const }

function readyCap() {
  return buildDisplayCapabilities({
    platform: 'win32',
    configured: 'on',
    checks: WIN_CHECKS,
    providerImplemented: true,
  })
}

/**
 * A live limits fixture: `limits()` is called per start, so the free figure can
 * move between starts the way a real machine's does when a Blender boots.
 */
function liveBudget(input: { limit?: number; configured?: number; total?: number; free?: number }) {
  const configured = input.configured ?? 4
  const state = {
    limit: input.limit ?? configured,
    configured,
    total: input.total ?? FULL,
    free: input.free ?? FULL,
  }
  const snapshot = (): VirtualGuiLimits => {
    const low = state.limit < state.configured
    return {
      limit: state.limit,
      configured: state.configured,
      low_resource: low,
      reason: low ? 'low_memory' : 'configured',
      total_mem_bytes: state.total,
      free_mem_bytes: state.free,
    }
  }
  return { state, snapshot }
}

function makeRegistry(budget: ReturnType<typeof liveBudget>, jobLoad?: () => number) {
  const started: DisplayStartRequest[] = []
  const stopped: DisplayInstance[] = []
  const provider: DisplayProvider = {
    kind: 'fake',
    capabilities: readyCap,
    async start(request) {
      started.push(request)
      const display: DisplayInstance = {
        id: 'display_' + String(started.length),
        display: 'dsh-vgui-budget',
        pid: 4300 + started.length,
        provider: 'fake',
      }
      return display
    },
    async stop(instance) {
      stopped.push(instance)
    },
    async health(): Promise<DisplayHealth> {
      return { ok: true, detail: 'fake' }
    },
  }
  const reg = new SessionRegistry(() => [], {
    display: readyCap,
    selectProvider: () => provider,
    waitForInstance: async () => true,
    limits: budget.snapshot,
    ...(jobLoad ? { jobLoad } : {}),
  })
  return { reg, started, stopped }
}

async function startAs(reg: SessionRegistry, caller: CallerIdentity) {
  const consent = reg.issueConsent(caller)
  if (!consent.ok) throw new Error('consent failed: ' + String(consent.code))
  return reg.start(caller, { consentToken: consent.consentToken })
}

/** Consent requests are persisted: keep them out of the operator's workDir. */
let consentSandbox: ReturnType<typeof isolateConsentDir> | null = null
beforeAll(() => {
  consentSandbox = isolateConsentDir('dsh-consent-budget-')
})
afterAll(() => {
  consentSandbox?.dispose()
  consentSandbox = null
})

describe('virtual-gui memory budget (pure)', () => {
  it('admits while the next instance fits the budget', () => {
    const admission = admitVirtualGui({
      used: 0,
      configured: 4,
      totalMemBytes: 16 * GIB,
      freeMemBytes: FULL,
    })
    expect(admission).toMatchObject({
      ok: true,
      reason: 'ok',
      limit: 4,
      used: 0,
      free: FULL,
      per_instance_bytes: VIRTUAL_GUI_PER_INSTANCE_BYTES,
      reserve_host_bytes: VIRTUAL_GUI_HOST_RESERVE_BYTES,
      required_bytes: THREE_HALF,
      low_resource: false,
    })
  })

  it('refuses the third instance at free=4.5 GiB with reason=memory', () => {
    const admission = admitVirtualGui({
      used: 2,
      configured: 4,
      totalMemBytes: 16 * GIB,
      freeMemBytes: 4.5 * GIB,
    })
    // 16 GiB total is not "below 16 GiB", so the structural limit stays 4:
    // the third start is refused by the budget alone, not by the ceiling.
    expect(admission).toMatchObject({
      ok: false,
      reason: 'memory',
      limit: 4,
      used: 2,
      free: 4.5 * GIB,
      required_bytes: SIX_HALF,
      low_resource: false,
    })
    expect(admission.required_bytes).toBeGreaterThan(admission.free)
  })

  it('reports reason=limit when used already reached the limit', () => {
    const admission = admitVirtualGui({
      used: 2,
      configured: 2,
      totalMemBytes: 16 * GIB,
      freeMemBytes: FULL,
    })
    expect(admission).toMatchObject({ ok: false, reason: 'limit', limit: 2, used: 2 })
    // The structural limit is decided first: a machine with plenty of free
    // memory still refuses, and the memory gate never overrides it.
    const tight = admitVirtualGui({
      used: 2,
      configured: 2,
      totalMemBytes: 16 * GIB,
      freeMemBytes: 1 * GIB,
    })
    expect(tight.reason).toBe('limit')
  })

  it('falls back to the documented defaults when parameters are missing or illegal', () => {
    const missing = admitVirtualGui({
      used: 0,
      configured: 4,
      totalMemBytes: FULL,
      freeMemBytes: THREE_HALF,
    })
    // Equality is admission: exactly one instance plus the host reserve fits.
    expect(missing).toMatchObject({
      ok: true,
      reason: 'ok',
      per_instance_bytes: 1.5 * GIB,
      reserve_host_bytes: 2 * GIB,
      required_bytes: THREE_HALF,
    })
    const illegal = admitVirtualGui({
      used: 0,
      configured: 4,
      totalMemBytes: FULL,
      freeMemBytes: 3.4 * GIB,
      perInstanceBytes: Number.NaN,
      reserveHostBytes: -1,
    })
    expect(illegal).toMatchObject({
      ok: false,
      reason: 'memory',
      per_instance_bytes: 1.5 * GIB,
      reserve_host_bytes: 2 * GIB,
    })
    const zero = admitVirtualGui({
      used: 0,
      configured: 4,
      freeMemBytes: 3.4 * GIB,
      perInstanceBytes: 0,
      reserveHostBytes: Number.NaN,
    })
    expect(zero.per_instance_bytes).toBe(1.5 * GIB)
    expect(zero.reserve_host_bytes).toBe(2 * GIB)
    const empty = admitVirtualGui({})
    expect(empty).toMatchObject({ ok: true, reason: 'ok', used: 0, limit: VIRTUAL_GUI_DEFAULT_MAX })
  })

  it('keeps the low-resource ceiling of min(configured, 2)', () => {
    const admission = admitVirtualGui({
      used: 2,
      configured: 6,
      totalMemBytes: 8 * GIB,
      freeMemBytes: FULL,
    })
    expect(admission).toMatchObject({
      ok: false,
      reason: 'limit',
      limit: VIRTUAL_GUI_LOW_RESOURCE_MAX,
      configured: 6,
      low_resource: true,
    })
    const roomy = admitVirtualGui({
      used: 1,
      configured: 6,
      totalMemBytes: 8 * GIB,
      freeMemBytes: FULL,
    })
    expect(roomy).toMatchObject({ ok: true, reason: 'ok', limit: 2 })
  })

  it('treats an unknown free-memory figure as "no memory gate"', () => {
    for (const freeMemBytes of [0, -1, Number.NaN]) {
      const admission = admitVirtualGui({
        used: 1,
        configured: 4,
        totalMemBytes: 0,
        freeMemBytes,
      })
      expect(admission).toMatchObject({ ok: true, reason: 'ok', free: 0 })
    }
  })
})

describe('virtual-gui memory budget (registry start)', () => {
  it('refuses the third instance when free memory cannot pay for it', async () => {
    // Ledger S-5: a 16 GiB machine admits two, then the two resident Blenders
    // drain it to ~4.5 GiB free — the third start must be refused for memory,
    // even though the count limit (4) still has room.
    const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
    const { reg, started } = makeRegistry(budget)
    expect((await startAs(reg, MAIN)).ok).toBe(true)
    expect((await startAs(reg, OTHER)).ok).toBe(true)
    budget.state.free = 4.5 * GIB
    const refused = await startAs(reg, THIRD)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.stage).toBe('session')
    expect(refused.code).toBe('capacity')
    expect(refused.evidence).toMatchObject({
      used: 2,
      limit: 4,
      reason: 'memory',
      free: 4.5 * GIB,
      per_instance: 1.5 * GIB,
      reserve: 2 * GIB,
      configured: 4,
      low_resource: false,
    })
    // No provider start happened for the refused attempt.
    expect(started).toHaveLength(2)
    expect(reg.virtualGuiCount()).toBe(2)
  })

  it('admits the third instance when free memory is enough', async () => {
    const { reg, started } = makeRegistry(liveBudget({ free: 8 * GIB, total: 16 * GIB }))
    expect((await startAs(reg, MAIN)).ok).toBe(true)
    expect((await startAs(reg, OTHER)).ok).toBe(true)
    expect((await startAs(reg, THIRD)).ok).toBe(true)
    expect(started).toHaveLength(3)
    expect(reg.virtualGuiCount()).toBe(3)
  })

  it('reports reason=limit through the registry receipt', async () => {
    const budget = liveBudget({ limit: 2, configured: 2, free: 8 * GIB })
    const { reg, started } = makeRegistry(budget)
    expect((await startAs(reg, MAIN)).ok).toBe(true)
    expect((await startAs(reg, OTHER)).ok).toBe(true)
    // Even with memory gone, the structural cap is what refuses: limit first.
    budget.state.free = 1 * GIB
    const refused = await startAs(reg, THIRD)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('capacity')
    expect(refused.evidence.reason).toBe('limit')
    expect(refused.evidence.free).toBe(1 * GIB)
    expect(started).toHaveLength(2)
  })
})

/**
 * S-5b: admission is a prediction, so price the instance again after it is real.
 *
 * Five seconds after ready the same budget runs with the free memory of that
 * moment and the instance count that now includes the newcomer. A verdict is
 * recorded on the session; the process is never stopped for accounting.
 */
describe('virtual-gui post-ready budget recheck (S-5b)', () => {
  it('records a memory degradation after 5 s without killing the instance', async () => {
    vi.useFakeTimers()
    try {
      const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
      const { reg, stopped } = makeRegistry(budget)
      const started = await startAs(reg, MAIN)
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const id = String(started.session.id)
      // Healthy at admission: no verdict on the start receipt.
      expect(started.session.degradation).toBeUndefined()

      // The spawned Blender ate more than its reservation.
      budget.state.free = 4.5 * GIB
      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS)

      const status = reg.status(MAIN, id)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      const degradation = status.session.degradation as Record<string, unknown>
      expect(degradation.reason).toBe('memory')
      expect(degradation.free).toBe(4.5 * GIB)
      // It is resident now, so the budget prices used=1: 2 * 1.5 GiB + 2 GiB.
      expect(degradation.required).toBe(5 * GIB)
      expect(degradation.limit).toBe(4)
      expect(typeof degradation.at).toBe('number')
      expect(Number(degradation.at)).toBeGreaterThan(0)

      // The list projection says the same thing as status (one view, one source).
      const row = reg.listFor(MAIN).find((entry) => entry.id === id)
      expect(row?.degradation).toMatchObject({ reason: 'memory', free: 4.5 * GIB })

      // The accounting never kills the process.
      expect(stopped).toHaveLength(0)
      expect(reg.virtualGuiCount()).toBe(1)
      expect(reg.getSession(id)?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a healthy instance without a degradation block', async () => {
    vi.useFakeTimers()
    try {
      const budget = liveBudget({ free: 16 * GIB, total: 32 * GIB })
      const { reg, stopped } = makeRegistry(budget)
      const started = await startAs(reg, MAIN)
      if (!started.ok) return
      const id = String(started.session.id)

      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS)

      const status = reg.status(MAIN, id)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.session.degradation).toBeUndefined()
      expect(stopped).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not brand a session degraded when only the structural cap is reached', async () => {
    vi.useFakeTimers()
    try {
      const budget = liveBudget({ limit: 1, configured: 1, free: 8 * GIB, total: 32 * GIB })
      const { reg } = makeRegistry(budget)
      const started = await startAs(reg, MAIN)
      if (!started.ok) return
      const id = String(started.session.id)

      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS)

      const status = reg.status(MAIN, id)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      // used=1 >= limit=1 is the operator's cap working, not a shortfall: a
      // degradation badge here would brand every session at virtualGuiMax=1.
      expect(status.session.degradation).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the recheck when the session is stopped', async () => {
    vi.useFakeTimers()
    try {
      const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
      const { reg } = makeRegistry(budget)
      const started = await startAs(reg, MAIN)
      if (!started.ok) return
      const id = String(started.session.id)

      // The recheck is armed on the way in, and dropping the session is what
      // disarms it — both halves matter, so the count is asserted on both sides.
      expect(vi.getTimerCount()).toBe(1)
      const stopped = await reg.stop(MAIN, id)
      expect(stopped.ok).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      budget.state.free = 1 * GIB
      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS * 2)
      expect(reg.getSession(id)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the recheck when the owner releases the session', async () => {
    vi.useFakeTimers()
    try {
      const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
      const { reg } = makeRegistry(budget)
      const started = await startAs(reg, MAIN)
      if (!started.ok) return
      const id = String(started.session.id)

      expect(vi.getTimerCount()).toBe(1)
      const released = reg.release(MAIN, id)
      expect(released.ok).toBe(true)
      expect(reg.getSession(id)).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * S-5c: the queue runs Blender processes of its own, and free memory alone does
 * not say how many. Each running headless/render job is reserved at the estimate
 * constant, so a virtual-gui start does not eat the memory a running job is using.
 * An absent jobLoad (tests, older hosts) reproduces the previous behaviour.
 */
describe('virtual-gui job load reservation (S-5c)', () => {
  it('reserves per running job and reports the effective free figure', () => {
    const admission = admitVirtualGui({
      used: 1,
      configured: 4,
      totalMemBytes: 16 * GIB,
      freeMemBytes: 6 * GIB,
      jobMemBytes: 2 * GIB,
    })
    // required (5 GiB) + jobs (2 GiB) > free (6 GiB): the jobs are why it fails.
    expect(admission).toMatchObject({
      ok: false,
      reason: 'memory',
      used: 1,
      free: 6 * GIB,
      required_bytes: 5 * GIB,
      job_mem_bytes: 2 * GIB,
      effective_free: 4 * GIB,
    })
    // Unknown / zero job memory keeps the old arithmetic exactly.
    const legacy = admitVirtualGui({ used: 1, configured: 4, freeMemBytes: 6 * GIB })
    expect(legacy).toMatchObject({ ok: true, job_mem_bytes: 0, free: 6 * GIB })
    expect(legacy.effective_free).toBe(legacy.free)
    const unknown = admitVirtualGui({ used: 0, freeMemBytes: 0, jobMemBytes: 2 * GIB })
    expect(unknown).toMatchObject({ ok: true, free: 0, job_mem_bytes: 2 * GIB })
    expect(unknown.effective_free).toBe(0)
  })

  it('refuses the start when running jobs use up the free memory', async () => {
    const jobs = { running: 0 }
    const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
    const { reg, started } = makeRegistry(budget, () => jobs.running)
    expect((await startAs(reg, MAIN)).ok).toBe(true)

    jobs.running = 2
    budget.state.free = 6 * GIB
    const refused = await startAs(reg, OTHER)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('capacity')
    expect(refused.evidence).toMatchObject({
      used: 1,
      limit: 4,
      reason: 'memory',
      free: 6 * GIB,
      required: 5 * GIB,
      job_mem: 2 * GIB,
      effective_free: 4 * GIB,
    })
    expect(started).toHaveLength(1)
  })

  it('admits the same start when no job is running', async () => {
    const jobs = { running: 0 }
    const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
    const { reg, started } = makeRegistry(budget, () => jobs.running)
    expect((await startAs(reg, MAIN)).ok).toBe(true)
    budget.state.free = 6 * GIB
    expect((await startAs(reg, OTHER)).ok).toBe(true)
    expect(started).toHaveLength(2)
  })

  it('keeps the legacy receipt when the host injects no jobLoad', async () => {
    const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
    const { reg } = makeRegistry(budget)
    expect((await startAs(reg, MAIN)).ok).toBe(true)
    expect((await startAs(reg, OTHER)).ok).toBe(true)
    budget.state.free = 4.5 * GIB
    const refused = await startAs(reg, THIRD)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.evidence).toMatchObject({
      reason: 'memory',
      free: 4.5 * GIB,
      job_mem: 0,
      effective_free: 4.5 * GIB,
    })
  })

  it('counts the job load in the post-ready recheck too', async () => {
    vi.useFakeTimers()
    try {
      const jobs = { running: 0 }
      const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
      const { reg, stopped } = makeRegistry(budget, () => jobs.running)
      const started = await startAs(reg, MAIN)
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const id = String(started.session.id)

      // Free memory alone would still admit: 5 GiB required <= 6 GiB free. The
      // two running jobs are what push it over.
      budget.state.free = 6 * GIB
      jobs.running = 2
      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS)

      const status = reg.status(MAIN, id)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.session.degradation).toMatchObject({
        reason: 'memory',
        free: 6 * GIB,
        required: 5 * GIB,
      })
      expect(stopped).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the instance healthy when the jobs finish before the recheck', async () => {
    vi.useFakeTimers()
    try {
      const jobs = { running: 2 }
      const budget = liveBudget({ free: 8 * GIB, total: 16 * GIB })
      const { reg } = makeRegistry(budget, () => jobs.running)
      const started = await startAs(reg, MAIN)
      if (!started.ok) return
      const id = String(started.session.id)

      jobs.running = 0
      budget.state.free = 6 * GIB
      vi.advanceTimersByTime(VIRTUAL_GUI_BUDGET_RECHECK_MS)

      const status = reg.status(MAIN, id)
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.session.degradation).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
