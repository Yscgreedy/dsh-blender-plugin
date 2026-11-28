// virtual-gui instance limits (3.1 task 4.9).
import os from 'node:os'

//
// The limit is configurable; the low-resource ceiling is a placeholder that the
// V0 report (5.10) will confirm. Nothing here spawns or waits: the session
// registry checks the limit before it asks a provider to start, so an over-limit
// start never leaves a process behind.
//
// S-5: the count limit alone is not an admission rule — a machine can pass the
// count check and still have no memory for the next Blender. admitVirtualGui
// prices the next instance (per-instance budget + host reserve) against the
// free memory read at the moment of the start, so the decision follows live
// pressure instead of whatever the first snapshot saw.

export const VIRTUAL_GUI_DEFAULT_MAX = 4
export const VIRTUAL_GUI_LOW_RESOURCE_MAX = 2
export const VIRTUAL_GUI_MAX_CEILING = 16

/** Below either threshold the Gateway admits at most the low-resource ceiling. */
export const LOW_RESOURCE_TOTAL_MEM_BYTES = 16 * 1024 ** 3
export const LOW_RESOURCE_FREE_MEM_BYTES = 4 * 1024 ** 3

export interface VirtualGuiLimitsInput {
  configured?: number
  env?: NodeJS.ProcessEnv
  totalMemBytes?: number
  freeMemBytes?: number
}

export interface VirtualGuiLimits {
  limit: number
  configured: number
  low_resource: boolean
  reason: 'configured' | 'low_memory'
  total_mem_bytes: number
  free_mem_bytes: number
}

export function clampVirtualGuiLimit(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(VIRTUAL_GUI_MAX_CEILING, Math.max(1, Math.floor(n)))
}

/** Resolve the effective limit; an explicit env value wins over the config file. */
export function resolveVirtualGuiLimits(input: VirtualGuiLimitsInput = {}): VirtualGuiLimits {
  const configured = clampVirtualGuiLimit(
    input.env?.DSH_BLENDER_VIRTUAL_GUI_MAX,
    clampVirtualGuiLimit(input.configured, VIRTUAL_GUI_DEFAULT_MAX),
  )
  const total = Number(input.totalMemBytes ?? 0) || 0
  const free = Number(input.freeMemBytes ?? 0) || 0
  const lowMemory =
    (total > 0 && total < LOW_RESOURCE_TOTAL_MEM_BYTES) ||
    (free > 0 && free < LOW_RESOURCE_FREE_MEM_BYTES)
  return {
    limit: lowMemory ? Math.min(configured, VIRTUAL_GUI_LOW_RESOURCE_MAX) : configured,
    configured,
    low_resource: lowMemory,
    reason: lowMemory ? 'low_memory' : 'configured',
    total_mem_bytes: total,
    free_mem_bytes: free,
  }
}
/** Limits for this machine: configured value plus live memory pressure. */
export function systemVirtualGuiLimits(
  configured?: number,
  env: NodeJS.ProcessEnv = process.env,
): VirtualGuiLimits {
  return resolveVirtualGuiLimits({
    configured,
    env,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
  })
}

/**
 * Memory one virtual-gui Blender is budgeted (S-5).
 *
 * A budget, not a measurement: the Gateway cannot know what a spawn will use,
 * so admission reserves this slice per resident instance. It is deliberately
 * smaller than a loaded scene needs — the point is to stop "the count says yes,
 * the machine says no", not to size a render farm.
 */
export const VIRTUAL_GUI_PER_INSTANCE_BYTES = 1.5 * 1024 ** 3
/** The host keeps this much free no matter how many instances it admits. */
export const VIRTUAL_GUI_HOST_RESERVE_BYTES = 2 * 1024 ** 3

export interface VirtualGuiAdmissionInput {
  used?: number
  configured?: number
  freeMemBytes?: number
  totalMemBytes?: number
  perInstanceBytes?: number
  reserveHostBytes?: number
}

export interface VirtualGuiAdmission {
  ok: boolean
  limit: number
  used: number
  free: number
  reason: 'ok' | 'memory' | 'limit'
  configured: number
  per_instance_bytes: number
  reserve_host_bytes: number
  /** Budget the next instance needs: (used + 1) * per-instance + host reserve. */
  required_bytes: number
  low_resource: boolean
}

function countOf(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function byteBudget(value: unknown, fallback: number, allowZero: boolean): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (allowZero ? n < 0 : n <= 0) return fallback
  return n
}

/**
 * Decide whether one more virtual-gui may start (S-5).
 *
 * The structural ceiling still wins: `used >= limit` is refused before any
 * memory arithmetic, and the low-resource ceiling (min(configured, 2)) is
 * recomputed from the memory figures passed here, so a caller that reads them
 * per start gets a live decision instead of a startup snapshot. A free figure
 * of 0 / negative / non-finite means "unknown" (the platform did not report
 * it), which leaves the memory gate out of the decision rather than blocking
 * every start.
 */
export function admitVirtualGui(input: VirtualGuiAdmissionInput = {}): VirtualGuiAdmission {
  const configured = clampVirtualGuiLimit(input.configured, VIRTUAL_GUI_DEFAULT_MAX)
  const used = countOf(input.used)
  const total = byteBudget(input.totalMemBytes, 0, true)
  const free = byteBudget(input.freeMemBytes, 0, true)
  const perInstance = byteBudget(input.perInstanceBytes, VIRTUAL_GUI_PER_INSTANCE_BYTES, false)
  const reserve = byteBudget(input.reserveHostBytes, VIRTUAL_GUI_HOST_RESERVE_BYTES, true)
  const budget = resolveVirtualGuiLimits({
    configured,
    totalMemBytes: total,
    freeMemBytes: free,
  })
  const limit = budget.limit
  const required = (used + 1) * perInstance + reserve
  const fits = free > 0 ? required <= free : true
  const reason: VirtualGuiAdmission['reason'] = used >= limit ? 'limit' : fits ? 'ok' : 'memory'
  return {
    ok: reason === 'ok',
    limit,
    used,
    free,
    reason,
    configured,
    per_instance_bytes: perInstance,
    reserve_host_bytes: reserve,
    required_bytes: required,
    low_resource: budget.low_resource,
  }
}
