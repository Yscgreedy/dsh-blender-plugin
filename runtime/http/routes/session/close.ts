// /session 路由：lease / release（拆分）
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from '../deps.js'
import { currentCaller } from '../../caller.js'
import { dispatchSessionAction } from './api.js'
import type { SessionControl } from './api.js'
import { buildReloadReport, drainGateway } from './control.js'
import { hostCorsHeaders } from '../../response.js'
import { panelOriginAllowed } from './api.js'

/**
 * One action through the session API. Browser-facing answers (the session panel)
 * need the host CORS allowlist; everything else keeps the plain JSON response it
 * always had, so nothing about the existing transport changes.
 */
async function answerAction(
  E: HttpRouteDeps,
  control: SessionControl,
  req: IncomingMessage,
  res: ServerResponse,
  payload: Record<string, unknown>,
): Promise<void> {
  const result = await dispatchSessionAction(
    E.sessionRegistry,
    String(payload.action || ''),
    payload,
    control,
    req.headers.origin,
  )
  const origin = req.headers.origin
  if (result.cors) E.hostJson(res, result.status, result.body, origin)
  else E.json(res, result.status, result.body)
}

/** The only /lease actions a browser or a terminal may drive with GET. */
const CONSENT_HTTP_ACTIONS = new Set([
  'consent_panel',
  'consent_approve',
  'consent_deny',
  'consent_status',
])

/**
 * CORS preflight for the panel's one write (POST consent_policy_set). Only the
 * loopback origins the pages are served from get an answer; anything else is a
 * plain 404, the same as an unknown method used to be.
 */
function answerPreflight(E: HttpRouteDeps, req: IncomingMessage, res: ServerResponse): void {
  if (!panelOriginAllowed(req.headers.origin)) {
    E.json(res, 404, { ok: false, error: 'not_found' })
    return
  }
  res.writeHead(204, hostCorsHeaders(req.headers.origin))
  res.end()
}

/** Payload = JSON body, then query-string values for keys the body did not set. */
async function leasePayload(
  E: HttpRouteDeps,
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await E.readBody(req)
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    payload = {}
  }
  // Query-string form: the human consent command must be copy-pasteable in
  // PowerShell and bash without JSON quoting, so action/requestId may arrive
  // as URL parameters (?action=consent_approve&requestId=…).
  try {
    const qs = new URL(req.url || '/', 'http://127.0.0.1')
    for (const [k, v] of qs.searchParams) if (payload[k] === undefined) payload[k] = v
  } catch {
    /* malformed URL: fall back to the body */
  }
  return payload
}

/**
 * GET is the human's copy-paste channel (query-string, no JSON quoting) and must
 * not be able to drive the lease/actions that mutate state.
 *
 * Answered with 404 — the same status the POST-only route table returned for a
 * GET before consent had a GET channel — so nothing about the old contract moves;
 * the body says what GET is for.
 */
function refuseGet(
  E: HttpRouteDeps,
  res: ServerResponse,
  payload: Record<string, unknown>,
): boolean {
  E.json(res, 404, {
    ok: false,
    error: 'not_found',
    hint:
      'GET /lease only serves consent_panel / consent_approve / consent_deny / consent_status; ' +
      'use POST for every other action',
    action: payload.action || null,
  })
  return true
}

/** renewOnly 心跳：只有本来就持有租约时才续期，不在空闲时抢占。 */
function renewLease(
  E: HttpRouteDeps,
  res: ServerResponse,
  payload: Record<string, unknown>,
  holder: string,
): void {
  const v = E.leaseView()
  if (v.active && v.holder === holder) {
    const rr = E.leaseAcquire(holder, payload.ttlMs, false, payload.scope)
    E.json(res, 200, { ok: true, lease: 'lease' in rr ? rr.lease : null, renewed: true })
  } else {
    E.json(res, 200, { ok: true, lease: v, renewed: false })
  }
}

/** Take (or refuse) the write lease: 409 names the holder and how to take it over. */
function acquireLease(
  E: HttpRouteDeps,
  res: ServerResponse,
  payload: Record<string, unknown>,
  holder: string,
): void {
  const r = E.leaseAcquire(holder, payload.ttlMs, !!payload.force, payload.scope)
  if ('denied' in r) {
    E.json(res, 409, {
      ok: false,
      error: 'leased',
      holder: r.holder,
      expiresInMs: r.expiresInMs,
      holderScope: E.leaseView().scope || null,
      hint:
        '另一个会话持有写权限租约；force:true 可抢占，或等 ' +
        Math.round(r.expiresInMs / 1000) +
        's 后重试',
    })
    return
  }
  E.json(res, 200, { ok: true, lease: 'lease' in r ? r.lease : null, renewed: !!payload.renewOnly })
}

export function createLeaseHandler(E: HttpRouteDeps) {
  // H2/H4：reload / shutdown 走同一条动作通道（路由表 29 条不变）
  const control: SessionControl = {
    reload: (payload) => buildReloadReport(E, payload) as unknown as Record<string, unknown>,
    shutdown: (payload) => drainGateway(E, payload),
    httpBase: 'http://' + String(E.HOST || '127.0.0.1') + ':' + String(E.PORT),
    // 台账 B：action=list 的 crew[] 要数在跑作业 —— 队列从 E 透传，缺了也不影响 list。
    jobQueue: E.jobQueue,
  }
  return async function lease(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    _p: string,
  ): Promise<void> {
    if (req.method === 'OPTIONS') {
      answerPreflight(E, req, res)
      return
    }
    const get = req.method === 'GET' || req.method === 'HEAD'
    const payload = await leasePayload(E, req)
    const action = typeof payload.action === 'string' ? payload.action : ''
    if (action) {
      if (get && !CONSENT_HTTP_ACTIONS.has(action)) return void refuseGet(E, res, payload)
      await answerAction(E, control, req, res, payload)
      return
    }
    if (get) return void refuseGet(E, res, payload)
    const holder = String(payload.holder || 'anonymous')
    E.releaseStaleLease('op=lease 到达时探活发现持有者进程不存在') // v0.9.4
    if (payload.renewOnly) return renewLease(E, res, payload, holder)
    acquireLease(E, res, payload, holder)
  }
}

export function createReleaseHandler(E: HttpRouteDeps) {
  const { LEASE, json, leaseView, readBody, sessionRegistry } = E
  return async function release(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    _p: string,
  ): Promise<void> {
    const raw = await readBody(req)
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw)
    } catch (e) {
      payload = {}
    }
    const caller = currentCaller()
    if (caller) {
      const result = sessionRegistry.release(
        caller,
        payload.sessionId === undefined ? undefined : String(payload.sessionId),
      )
      json(res, result.ok ? 200 : 409, result as unknown as Record<string, unknown>)
      return
    }
    const want = String(payload.holder || '')
    let released: string | null = null
    if (LEASE.holder && (!want || LEASE.holder === want)) {
      released = LEASE.holder
      LEASE.holder = null
      LEASE.token = null
      LEASE.expiresAt = null
      LEASE.acquiredAt = null
    }
    json(res, 200, { ok: true, released: released, lease: leaseView() })
    return
  }
}
