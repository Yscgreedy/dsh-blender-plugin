// Human-consent requests for virtual-gui (3.2).
//
// Why this file exists: in 3.1 the model could not mint consent and the host had
// no surface that asked the human, so action=start kind=virtual-gui failed with a
// bare consent_required, nothing was recorded, and the human saw no prompt at
// all. A request is now a first-class, persisted object:
//
//   1. the agent's start files a request (id + expiry) and gets the approve
//      command back inside the tool receipt, which is what the human reads;
//   2. the human approves it from any terminal (POST /lease action=consent_approve)
//      or pre-approves the host with DSH_BLENDER_VIRTUAL_GUI_CONSENT=allow;
//   3. the next start consumes the approved request and mints the one-time token.
//
// The model never sees a path that mints its own approval: approve needs the
// request id, and the id only exists because a start asked for it.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CFG } from '../../config.js'
import { callerKey } from './types.js'
import { issueConsentToken } from './consent.js'
import type { CallerIdentity } from './types.js'

export const CONSENT_REQUEST_TTL_MS = 15 * 60_000
/** Approved requests stay usable for one start, then are consumed. */
const MAX_REQUESTS = 50

export type ConsentState = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'

export interface ConsentRequest {
  id: string
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

/** Host-side directory that makes a request visible when the transcript was missed. */
export function consentRequestDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.DSH_BLENDER_CONSENT_DIR || '').trim()
  return override || path.join(CFG.workDirWsl, 'consent')
}

function requestView(r: ConsentRequest): Record<string, unknown> {
  return {
    request_id: r.id,
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

function stateOf(r: ConsentRequest, now: number): ConsentState {
  if (r.state === 'pending' && now > r.expiresAt) {
    r.state = 'expired'
    persist(r)
  }
  return r.state
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
  trim(now)
  const key = callerKey(c)
  const pending = [...requests.values()]
    .filter((r) => r.callerKey === key && stateOf(r, now) === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (pending) return { requestId: pending.id, expiresAt: pending.expiresAt, reused: true }
  const request: ConsentRequest = {
    id: randomUUID(),
    state: 'pending',
    callerKey: key,
    caller: {
      hostId: c.hostId,
      dshSessionId: c.dshSessionId,
      agentId: c.agentId,
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

export function approveConsentRequest(
  requestId: unknown,
  source = 'human',
  now = Date.now(),
): { ok: true; request: Record<string, unknown> } | { ok: false; reason: ConsentDecision } {
  const r = requests.get(String(requestId || ''))
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
  return { ok: true, request: requestView(r) }
}

export function denyConsentRequest(
  requestId: unknown,
  reason = 'human denied the request',
  now = Date.now(),
): { ok: true; request: Record<string, unknown> } | { ok: false; reason: ConsentDecision } {
  const r = requests.get(String(requestId || ''))
  if (!r) return { ok: false, reason: 'missing' }
  if (r.state === 'consumed' || r.state === 'expired') return { ok: false, reason: 'expired' }
  r.state = 'denied'
  r.decidedAt = now
  r.source = 'human'
  r.reason = reason
  persist(r)
  return { ok: true, request: requestView(r) }
}

export function consentRequestView(requestId: unknown): Record<string, unknown> | null {
  const r = requests.get(String(requestId || ''))
  return r ? requestView(r) : null
}

/** Requests filed by this caller, newest first (so status can show what is waiting). */
export function consentRequestsFor(c: CallerIdentity): Record<string, unknown>[] {
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

/** Test helper: forget every request. */
export function resetConsentRequests(): void {
  requests.clear()
}
