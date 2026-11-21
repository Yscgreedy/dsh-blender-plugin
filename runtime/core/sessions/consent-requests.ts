// Human-consent requests for virtual-gui (3.2, panel-aware since 3.3.1).
//
// Why this file exists: in 3.1 the model could not mint consent and the host had
// no surface that asked the human, so action=start kind=virtual-gui failed with a
// bare consent_required, nothing was recorded, and the human saw no prompt at
// all. A request is now a first-class, persisted object:
//
//   1. the agent's start files a request (id + expiry) and — since 3.3.1 — waits
//      (wait_ms) for the human's decision, so the *same* call can complete;
//   2. the human approves it in the Blender session panel of the conversation
//      (GET /lease?action=consent_approve&handle=…) or from any terminal (request
//      id) or pre-approves the host with DSH_BLENDER_VIRTUAL_GUI_CONSENT=allow;
//   3. approval notifies the waiting start, which mints the one-time token.
//
// The model never sees a path that mints its own approval: approve needs the
// request id (or the panel handle), and the id only exists because a start asked
// for it. Requests are persisted so a Gateway restart (HMR) does not lose the
// panel's state.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { callerKey } from './types.js'
import { consentDir } from './consent-policy.js'
import { issueConsentToken } from './consent.js'
import type { CallerIdentity } from './types.js'

export const CONSENT_REQUEST_TTL_MS = 15 * 60_000
/** Approved requests stay usable for one start, then are consumed. */
const MAX_REQUESTS = 50
/** How often the persisted request directory is re-read (HMR survival). */
const HYDRATE_MS = 500

export type ConsentState = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'

export interface ConsentRequest {
  id: string
  /** Panel-facing capability: the human's buttons carry this, not the id. */
  handle: string
  state: ConsentState
  callerKey: string
  caller: CallerIdentity
  createdAt: number
  expiresAt: number
  decidedAt: number | null
  source: string | null
  reason: string | null
}

const requests = new Map<string, ConsentRequest>()
const waiters = new Map<string, Set<(state: ConsentState) => void>>()
let hydratedAt = 0

/** Folder that makes a request visible when the transcript was missed. */
export function consentRequestDir(env: NodeJS.ProcessEnv = process.env): string {
  return consentDir(env)
}

function newHandle(): string {
  return 'h-' + randomUUID().replace(/-/g, '').slice(0, 24)
}

function requestView(r: ConsentRequest): Record<string, unknown> {
  return {
    request_id: r.id,
    handle: r.handle,
    state: r.state,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    expires_in_ms: Math.max(0, r.expiresAt - Date.now()),
    decided_at: r.decidedAt,
    source: r.source,
    reason: r.reason,
    caller: r.caller,
  }
}

/** Best-effort persistence: a request that only lives in memory cannot be audited. */
function persist(r: ConsentRequest): void {
  try {
    const dir = consentRequestDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, r.id + '.json'), JSON.stringify(requestView(r), null, 2))
  } catch {
    /* consent still works in memory; the receipt carries the id */
  }
}

function recordFromFile(raw: unknown): ConsentRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = String(row.request_id || '')
  const caller =
    row.caller && typeof row.caller === 'object' ? (row.caller as Record<string, unknown>) : {}
  const expiresAt = Number(row.expires_at)
  if (!id || !Number.isFinite(expiresAt)) return null
  const state = String(row.state || 'pending') as ConsentState
  const identity: CallerIdentity = {
    hostId: String(caller.hostId || ''),
    dshSessionId: String(caller.dshSessionId || ''),
    agentId: String(caller.agentId || ''),
    parentAgentId: caller.parentAgentId ? String(caller.parentAgentId) : undefined,
    role: caller.role === 'main' ? 'main' : 'subagent',
  }
  return {
    id,
    handle: String(row.handle || newHandle()),
    state,
    callerKey: callerKey(identity),
    caller: identity,
    createdAt: Number(row.created_at) || 0,
    expiresAt,
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    source: row.source == null ? null : String(row.source),
    reason: row.reason == null ? null : String(row.reason),
  }
}

/**
 * Re-read persisted requests. A Gateway restart (HMR) recreates the process, so
 * the panel's pending cards must come back from disk instead of vanishing.
 */
function hydrate(now = Date.now()): void {
  if (now - hydratedAt < HYDRATE_MS) return
  hydratedAt = now
  let names: string[]
  try {
    names = fs.readdirSync(consentRequestDir()).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names.slice(-MAX_REQUESTS)) {
    const id = name.slice(0, -'.json'.length)
    if (requests.has(id)) continue
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(consentRequestDir(), name), 'utf8'),
      )
      const request = recordFromFile(parsed)
      if (request) requests.set(request.id, request)
    } catch {
      /* unreadable file: ignore, the in-memory record (if any) still works */
    }
  }
}

function stateOf(r: ConsentRequest, now: number): ConsentState {
  if (r.state === 'pending' && now > r.expiresAt) {
    r.state = 'expired'
    persist(r)
  }
  return r.state
}

function notify(r: ConsentRequest): void {
  const listeners = waiters.get(r.id)
  if (!listeners) return
  for (const listener of listeners) {
    try {
      listener(r.state)
    } catch {
      /* a broken waiter must not affect the decision */
    }
  }
  waiters.delete(r.id)
}

function trim(now: number): void {
  const live = [...requests.values()]
  for (const r of live) stateOf(r, now)
  if (requests.size <= MAX_REQUESTS) return
  const drop = live
    .filter((r) => r.state !== 'pending' && r.state !== 'approved')
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const r of drop.slice(0, requests.size - MAX_REQUESTS)) requests.delete(r.id)
}

export interface ConsentRequestView {
  requestId: string
  expiresAt: number
  reused: boolean
}

/** File (or reuse) the pending request for this caller. */
export function ensureConsentRequest(
  c: CallerIdentity,
  now = Date.now(),
  reason = 'start_virtual_gui',
): ConsentRequestView {
  hydrate(now)
  trim(now)
  const key = callerKey(c)
  const pending = [...requests.values()]
    .filter((r) => r.callerKey === key && stateOf(r, now) === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (pending) return { requestId: pending.id, expiresAt: pending.expiresAt, reused: true }
  const request: ConsentRequest = {
    id: randomUUID(),
    handle: newHandle(),
    state: 'pending',
    callerKey: key,
    caller: {
      hostId: c.hostId,
      dshSessionId: c.dshSessionId,
      agentId: c.agentId,
      ...(c.parentAgentId ? { parentAgentId: c.parentAgentId } : {}),
      role: c.role,
    },
    createdAt: now,
    expiresAt: now + CONSENT_REQUEST_TTL_MS,
    decidedAt: null,
    source: null,
    reason,
  }
  requests.set(request.id, request)
  persist(request)
  return { requestId: request.id, expiresAt: request.expiresAt, reused: false }
}

export type ConsentDecision = 'ok' | 'missing' | 'expired' | 'already' | 'denied' | 'consumed'

/** Accept either the real request id or the panel's handle. */
export function resolveRequestRef(ref: unknown, now = Date.now()): string | null {
  hydrate(now)
  const raw = String(ref || '').trim()
  if (!raw) return null
  if (requests.has(raw)) return raw
  for (const r of requests.values()) if (r.handle === raw) return r.id
  return null
}

export function approveConsentRequest(
  requestId: unknown,
  source = 'human',
  now = Date.now(),
): { ok: true; request: Record<string, unknown> } | { ok: false; reason: ConsentDecision } {
  const id = resolveRequestRef(requestId, now)
  const r = id ? requests.get(id) : undefined
  if (!r) return { ok: false, reason: 'missing' }
  const state = stateOf(r, now)
  if (state === 'expired') return { ok: false, reason: 'expired' }
  if (state === 'approved') return { ok: false, reason: 'already' }
  if (state === 'denied') return { ok: false, reason: 'denied' }
  // A consumed approval must never be re-armed: it already started one window.
  if (state === 'consumed') return { ok: false, reason: 'consumed' }
  r.state = 'approved'
  r.decidedAt = now
  r.source = source
  persist(r)
  notify(r)
  return { ok: true, request: requestView(r) }
}

export function denyConsentRequest(
  requestId: unknown,
  reason = 'human denied the request',
  now = Date.now(),
): { ok: true; request: Record<string, unknown> } | { ok: false; reason: ConsentDecision } {
  const id = resolveRequestRef(requestId, now)
  const r = id ? requests.get(id) : undefined
  if (!r) return { ok: false, reason: 'missing' }
  const state = stateOf(r, now)
  if (state === 'consumed' || state === 'expired') return { ok: false, reason: 'expired' }
  r.state = 'denied'
  r.decidedAt = now
  r.source = 'human'
  r.reason = reason
  persist(r)
  notify(r)
  return { ok: true, request: requestView(r) }
}

export function consentRequestView(requestId: unknown): Record<string, unknown> | null {
  const id = resolveRequestRef(requestId)
  const r = id ? requests.get(id) : null
  return r ? requestView(r) : null
}

/** Requests filed by this caller, newest first (so status can show what is waiting). */
export function consentRequestsFor(c: CallerIdentity): Record<string, unknown>[] {
  hydrate()
  const key = callerKey(c)
  const now = Date.now()
  return [...requests.values()]
    .filter((r) => r.callerKey === key)
    .map((r) => {
      stateOf(r, now)
      return requestView(r)
    })
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
}

/**
 * Every request the panel should show (all callers: multiple agents share one
 * machine, and "who is asking" is part of the card). Decided requests stay for
 * the TTL so the card can say what happened instead of silently disappearing.
 */
export function consentRequestsAll(now = Date.now()): Record<string, unknown>[] {
  hydrate(now)
  return [...requests.values()]
    .filter((r) => now - r.createdAt <= CONSENT_REQUEST_TTL_MS + 60_000)
    .map((r) => {
      stateOf(r, now)
      return requestView(r)
    })
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
}

export { requestView as consentRequestRow }

/**
 * Wait for the human's decision on one request. Resolves as soon as approve/deny
 * lands (listener), and on the poll tick for an expiry. Never rejects: the
 * caller re-reads the state and decides what its receipt says.
 */
export function waitForConsentDecision(
  requestId: string,
  timeoutMs: number,
  pollMs = 100,
): Promise<ConsentState> {
  const id = String(requestId || '')
  const r = requests.get(id)
  if (!r) return Promise.resolve('expired')
  const deadline = Date.now() + Math.max(0, timeoutMs)
  return new Promise<ConsentState>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (state: ConsentState): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      const listeners = waiters.get(id)
      if (listeners) {
        listeners.delete(settle)
        if (!listeners.size) waiters.delete(id)
      }
      resolve(state)
    }
    const tick = (): void => {
      if (done) return
      const state = stateOf(r, Date.now())
      if (state !== 'pending') {
        settle(state)
        return
      }
      if (Date.now() >= deadline) {
        settle('pending')
        return
      }
      timer = setTimeout(tick, pollMs)
    }
    const listeners = waiters.get(id) || new Set<(state: ConsentState) => void>()
    listeners.add(settle)
    waiters.set(id, listeners)
    tick()
  })
}

/**
 * Mint the one-time token for an approved request this caller filed. Returns
 * null when nothing is approved, so the gate can report the original reason.
 */
export function takeApprovedToken(c: CallerIdentity, now = Date.now()): string | null {
  const key = callerKey(c)
  const approved = [...requests.values()]
    .filter((r) => r.callerKey === key && stateOf(r, now) === 'approved')
    .sort((a, b) => Number(b.decidedAt || 0) - Number(a.decidedAt || 0))[0]
  if (!approved) return null
  const token = issueConsentToken(c, now).consentToken
  approved.state = 'consumed'
  persist(approved)
  notify(approved)
  return token
}

/**
 * The line the human has to run. Query-string form on purpose: it needs no JSON
 * quoting, so it is copy-paste-safe in both PowerShell and bash.
 */
export function consentApproveCommand(
  base: string,
  requestId: string,
  action = 'consent_approve',
): string {
  return 'curl.exe -s "' + base + '/lease?action=' + action + '&requestId=' + requestId + '"'
}

/** Test helper: forget every request (and every waiter). */
export function resetConsentRequests(): void {
  requests.clear()
  waiters.clear()
  hydratedAt = 0
}
