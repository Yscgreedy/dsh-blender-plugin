// Session views: the read-only projections the tools consume.
//
// Extracted from registry.ts (registry split, third slice) with no behavior change:
// list / listFor / readableInstanceFor / sessionInfo / status and the owner-heartbeat
// they perform moved here verbatim. The host interface is only what these reads need,
// so a test can render every view without constructing a registry.

import type { AttachLiveness } from './attach.js'
import { touchAgent } from './presence.js'
import { readableSessions, sessionForInstance, unownedSessions } from './lookup.js'
import {
  callerKey,
  fail,
  inOwnerFamily,
  ownerMatches,
  ownerStale,
  sameHost,
  sessionView,
} from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord, SessionResult } from './types.js'
import { isRecord } from '../../foundation/json.js'

/** What the read-only views take from the registry. */
export interface SessionViewsHost {
  sessions: Map<string, SessionRecord>
  instances(): InstanceRef[]
  prune(now?: number): void
  findForCaller(c: CallerIdentity): SessionRecord | null
  /** The instance this caller attached last, while that memory is still fresh. */
  tombstoneFor(c: CallerIdentity): string | null
  livenessOf(session: SessionRecord): AttachLiveness
}

export class SessionViews {
  constructor(private readonly host: SessionViewsHost) {}

  list(): Record<string, unknown>[] {
    this.host.prune()
    return [...this.host.sessions.values()].map((s) => sessionView(s))
  }

  /** Any authenticated call from the owner counts as a heartbeat (feedback 8). */
  private refreshOwner(c: CallerIdentity): void {
    for (const s of this.host.sessions.values()) {
      if (s.owner && ownerMatches(s.owner, c)) s.owner.heartbeatAt = Date.now()
    }
  }

  listFor(c: CallerIdentity): Record<string, unknown>[] {
    this.host.prune()
    this.refreshOwner(c)
    const rows = new Map<string, Record<string, unknown>>()
    // 实例维度兜底：Blender 还连着、只是归属过期的会话也列出来。否则模型看到 0 个会话，
    // 手里没有 sessionId，attach/claim/stop 全被 session_in_use 挡住。
    for (const s of unownedSessions(this.host.sessions, this.host.instances()))
      rows.set(s.id, sessionView(s, c))
    const own = this.host.findForCaller(c)
    if (own) rows.set(own.id, sessionView(own, c))
    // Read-only visibility (field 反馈 1/3): same-host sessions are listed with
    // owner + is_mine=false so blender_see can use them and audit_* can attribute
    // their results. Writes still fail in authorizeWrite (grant/owner required).
    for (const s of readableSessions(this.host.sessions, c, this.host.instances())) {
      if (rows.has(s.id)) continue
      rows.set(s.id, { ...sessionView(s, c), read_only: true })
    }
    return [...rows.values()]
  }

  /**
   * The instance behind the only same-host session this caller may read but not
   * own. Used for routing: see/read ops need a target, writes still go through
   * authorizeWrite and are refused without a grant.
   */
  readableInstanceFor(c: CallerIdentity): string | null {
    this.host.prune()
    const rows = readableSessions(this.host.sessions, c, this.host.instances()).filter(
      (s) => s.status === 'ready' && !!s.instanceId,
    )
    return rows.length === 1 ? String(rows[0].instanceId) : null
  }

  /** Attribution for a plan/op receipt: the session behind the instance we drove. */
  sessionInfo(c: CallerIdentity, instanceId?: string | null): Record<string, unknown> | null {
    this.host.prune()
    this.refreshOwner(c)
    const session = instanceId
      ? sessionForInstance(this.host.sessions, String(instanceId))
      : this.host.findForCaller(c)
    if (!session) return null
    const mine = ownerMatches(session.owner, c) || inOwnerFamily(session.owner, c)
    return {
      sessionId: session.id,
      instanceId: session.instanceId,
      owner: session.owner
        ? {
            hostId: session.owner.hostId,
            dshSessionId: session.owner.dshSessionId,
            agentId: session.owner.agentId,
            role: session.owner.role || 'main',
            stale: ownerStale(session.owner),
          }
        : null,
      is_mine: mine,
      borrowed: !mine && sameHost(session.owner, c),
      // Additive attribution for op receipts: the instance is over its budget
      // (S-5b) — readable, still alive, and honest about the pressure it adds.
      ...(session.degradation ? { degradation: session.degradation } : {}),
    }
  }

  status(
    c: CallerIdentity,
    sessionId?: string,
  ): SessionResult<{ session: Record<string, unknown> }> {
    this.host.prune()
    this.refreshOwner(c)
    const session = sessionId
      ? this.host.sessions.get(String(sessionId))
      : this.host.findForCaller(c)
    if (!session) {
      // A released record is gone by design; still answer what happened instead of
      // a bare session_not_found, using the last instance this caller attached.
      const instanceId = this.host.tombstoneFor(c)
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
    return {
      ok: true,
      session: { ...sessionView(session, c), live: this.host.livenessOf(session) },
    }
  }
}

// ── crew[]：一行会话视图里的每个 agent 在改什么（纯投影，无 HTTP、无写动作） ──
//
// 台账 B：`/who`、`/lease action=list`（模型侧 `blender_session action=list`）与面板
// （`consent_panel`）共用这一份 enrich。全部从**已有的行**（owner / agents / grants）
// 与作业行派生，不改 sessionView 的任何既有字段；作业队列缺失时只按 0 个作业算。

/** 非终态作业才代表“这个 agent 还在干活”。 */
const TERMINAL_JOB_STATES = ['completed', 'failed', 'canceled']
/** 只取这三种状态的作业：历史队列（几百条终态）不参与 crew 计数。 */
const CREW_JOB_STATES = ['queued', 'assigned', 'running']
/** 每种状态最多取多少行：非终态作业本来就被队列容量卡住（pending 64 + GPU 1 + CPU 2）。 */
const CREW_JOB_SCAN_LIMIT = 500

/**
 * crew 计数需要的队列读接口（`JobQueue` 天然满足）。
 * 结构化声明而不是 import http 的 HttpRouteDeps：core 不得反向依赖 http 层。
 */
export interface CrewJobSource {
  list?: (filter: { state?: string; limit?: number }) => CrewJobRow[]
}

/** crewView 需要的最小作业事实（JobRecord 天然满足）。 */
export interface CrewJobRow {
  state?: string
  owner?: { agentId?: string } | null
}

export type CrewState = 'idle' | 'working' | 'blocked'
export type CrewBlockedReason = 'instance_gone' | 'owner_stale' | null

/** 一个 agent 在某个会话里“在改什么”的一行。 */
export interface CrewMember {
  agentId: string
  role: string
  parentAgentId: string | null
  scopes: string[]
  grant_expires_in_ms: number | null
  last_write_at: number | null
  jobs_running: number
  jobs_queued: number
  state: CrewState
  blocked_reason: CrewBlockedReason
}

interface GrantFacts {
  scopes: string[]
  expiresInMs: number | null
  lastWriteAt: number | null
}

/** 同一个 agent 名下的全部 grant（holder 取自第一条：同一 agent 的身份一致）。 */
interface GrantGroup {
  holder: Record<string, unknown>
  grants: Record<string, unknown>[]
}

interface CrewDraft {
  agentId: string
  role: string
  parentAgentId: string | null
  /** owner 写场景不需要 grant，所以 owner 行永远不带 scope / 过期 / 最近写入。 */
  fromOwner: boolean
}

/** 边界解析：非对象一律当空对象（与旧的 objArg 等价，数组也归零）。 */
function asRec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 有限数字；null / undefined / '' 一律当“没有这份证据”（Number(null) 是 0，不能直接用）。 */
function usNum(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** ScopeSpec → 工具接受的那种 token（"exclusive" / "collection:COL_A"）。 */
function scopeToken(scope: unknown): string {
  const rec = asRec(scope)
  const kind = str(rec.kind)
  if (!kind) return ''
  if (kind === 'exclusive' || rec.value === undefined || rec.value === null) return kind
  return kind + ':' + str(rec.value)
}

/**
 * 一条 grant 的剩余寿命：按 expiresAt 算到今天；老视图只带 expiresInMs 时退回它。
 * 返回 null = 这条记录没给任何过期证据（不猜）。
 */
function grantRemainingMs(grant: Record<string, unknown>, now: number): number | null {
  const expiresAt = usNum(grant.expiresAt)
  if (expiresAt !== null) return Math.max(0, expiresAt - now)
  const expiresInMs = usNum(grant.expiresInMs)
  return expiresInMs === null ? null : Math.max(0, expiresInMs)
}

/**
 * 一条 grant 的“最近写入”证据：grant.heartbeatAt（续期即一次在用的写入）。
 *
 * grantView 现在会带 heartbeatAt；老 Gateway 的视图只有 createdAt，就退回它 ——
 * 那是老视图里唯一的时间证据，比谎报 null 有用。
 */
function grantWriteStamp(grant: Record<string, unknown>): number | null {
  for (const key of ['heartbeatAt', 'createdAt']) {
    const value = usNum(grant[key])
    if (value !== null) return value
  }
  return null
}

/** 同一 holder 可能持有多条 grant：scope 合并，过期取最早的那条，最近写入取最新。 */
function grantFacts(group: GrantGroup | undefined, now: number): GrantFacts {
  const facts: GrantFacts = { scopes: [], expiresInMs: null, lastWriteAt: null }
  for (const grant of group ? group.grants : []) {
    for (const scope of Array.isArray(grant.scopes) ? grant.scopes : []) {
      const token = scopeToken(scope)
      if (token && facts.scopes.indexOf(token) < 0) facts.scopes.push(token)
    }
    const remaining = grantRemainingMs(grant, now)
    const earliest = facts.expiresInMs
    if (remaining !== null)
      facts.expiresInMs = earliest === null ? remaining : Math.min(earliest, remaining)
    const stamp = grantWriteStamp(grant)
    const latest = facts.lastWriteAt
    if (stamp !== null && (latest === null || stamp > latest)) facts.lastWriteAt = stamp
  }
  return facts
}

/** 按 holder.agentId 归并 grants。 */
function grantsByAgent(session: Record<string, unknown>): Map<string, GrantGroup> {
  const out = new Map<string, GrantGroup>()
  for (const raw of Array.isArray(session.grants) ? session.grants : []) {
    const grant = asRec(raw)
    const holder = asRec(grant.holder)
    const agentId = str(holder.agentId)
    if (!agentId) continue
    const group = out.get(agentId)
    if (group) group.grants.push(grant)
    else out.set(agentId, { holder, grants: [grant] })
  }
  return out
}

/** owner 先行，然后已附着的 agent，最后只在 grants 里出现的 holder（按 agentId 去重）。 */
function crewDrafts(session: Record<string, unknown>): CrewDraft[] {
  const drafts: CrewDraft[] = []
  const seen = new Set<string>()
  const owner = asRec(session.owner)
  const ownerAgentId = str(owner.agentId)
  if (ownerAgentId) {
    seen.add(ownerAgentId)
    drafts.push({
      agentId: ownerAgentId,
      role: str(owner.role) || 'main',
      parentAgentId: str(owner.parentAgentId) || null,
      fromOwner: true,
    })
  }
  for (const raw of Array.isArray(session.agents) ? session.agents : []) {
    const agent = asRec(asRec(raw).agent)
    const agentId = str(agent.agentId)
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    drafts.push({
      agentId,
      role: str(agent.role) || 'subagent',
      parentAgentId: str(agent.parentAgentId) || null,
      fromOwner: false,
    })
  }
  for (const [agentId, group] of grantsByAgent(session)) {
    if (seen.has(agentId)) continue
    seen.add(agentId)
    drafts.push({
      agentId,
      role: str(group.holder.role) || 'subagent',
      parentAgentId: str(group.holder.parentAgentId) || null,
      fromOwner: false,
    })
  }
  return drafts
}

/**
 * 全员被同一个原因卡住时，一句话说清（台账 B 的反例：crew.blocked）。
 * instance_gone = 这个会话没有可用的 Blender 实例（未就绪 / 已断开）；
 * owner_stale = 归属需要回收（owner 心跳过期，或 owner 已被清、只剩 presence）。
 */
function blockedReasonOf(session: Record<string, unknown>): CrewBlockedReason {
  const status = str(session.status)
  if (!str(session.instanceId) || (status !== '' && status !== 'ready')) return 'instance_gone'
  const owner = asRec(session.owner)
  const ownerGone = !str(owner.agentId) && session.owner_expired === true
  return ownerGone || owner.stale === true ? 'owner_stale' : null
}

/** 只数非终态作业，按 owner.agentId 归属。 */
function jobCounts(
  jobRows: readonly CrewJobRow[],
  agentId: string,
): { running: number; queued: number } {
  let running = 0
  let queued = 0
  for (const job of jobRows) {
    const rec = asRec(job)
    if (str(asRec(rec.owner).agentId) !== agentId) continue
    const state = str(rec.state)
    if (!state || TERMINAL_JOB_STATES.indexOf(state) >= 0) continue
    if (state === 'queued') queued += 1
    else running += 1
  }
  return { running, queued }
}

/**
 * 一行会话视图 → 它的 crew（纯函数：无 HTTP、无真实队列）。
 *
 * `jobRows` 可以是 undefined / null / 非数组（老 Gateway、单测、队列取不到）：
 * 拿不到作业就按“0 个作业”算，永远不是错误。
 */
export function crewView(
  session: Record<string, unknown>,
  jobRows?: readonly CrewJobRow[] | null,
  now = Date.now(),
): CrewMember[] {
  const jobs: readonly CrewJobRow[] = Array.isArray(jobRows) ? jobRows : []
  const byAgent = grantsByAgent(session)
  const blocked = blockedReasonOf(session)
  return crewDrafts(session).map((draft): CrewMember => {
    const facts: GrantFacts = draft.fromOwner
      ? { scopes: [], expiresInMs: null, lastWriteAt: null }
      : grantFacts(byAgent.get(draft.agentId), now)
    const counts = jobCounts(jobs, draft.agentId)
    const busy = counts.running + counts.queued > 0
    return {
      agentId: draft.agentId,
      role: draft.role,
      parentAgentId: draft.parentAgentId,
      scopes: facts.scopes,
      grant_expires_in_ms: facts.expiresInMs,
      last_write_at: facts.lastWriteAt,
      jobs_running: counts.running,
      jobs_queued: counts.queued,
      state: blocked ? 'blocked' : busy ? 'working' : 'idle',
      blocked_reason: blocked,
    }
  })
}

/**
 * 非终态作业行（按状态逐个取，避免把历史队列整份快照出来）。
 * 队列是观测数据：取不到就按 0 个作业算，调用方（/who、/lease、面板）不许因此 500。
 */
function crewJobRows(jobQueue: CrewJobSource | null | undefined): CrewJobRow[] {
  if (!jobQueue || typeof jobQueue.list !== 'function') return []
  const rows: CrewJobRow[] = []
  for (const state of CREW_JOB_STATES) {
    try {
      rows.push(...jobQueue.list({ state, limit: CREW_JOB_SCAN_LIMIT }))
    } catch {
      /* 观测数据：队列答不上来不影响会话表 */
    }
  }
  return rows
}

/**
 * 会话行 + 作业队列 → 带 crew[] 的行（additive：每行保留全部既有字段）。
 *
 * 纯逻辑住在 core：http 的 `/who` / `/lease action=list` 与 `consent_panel` 面板行
 * 都调这一个函数，各自的队列从路由层传进来（core 不认识 http 的 HttpRouteDeps）。
 */
export function crewRows(
  rows: readonly unknown[],
  jobQueue: CrewJobSource | null | undefined,
): Record<string, unknown>[] {
  const jobRows = crewJobRows(jobQueue)
  return rows.map((row) => {
    const rec = asRec(row)
    return { ...rec, crew: crewView(rec, jobRows) }
  })
}

/**
 * crew[] → 一行紧凑摘要（agent/role/state/scopes/jobs），空 crew 返回空串。
 *
 * 面板（`consent_panel`）用它在**服务端**压好一行文本：客户端只显示一行字，不复制
 * 判据，也不必为了这段格式化去动浏览器 bundle 的行数 ratchet。
 */
export function crewSummaryText(crew: unknown): string {
  const list = Array.isArray(crew) ? crew : []
  const parts: string[] = []
  for (const raw of list) {
    const member = asRec(raw)
    // crew[].scopes 已经是 token 字符串（crewView 的产物），不再二次解析 ScopeSpec。
    const scopes = Array.isArray(member.scopes) ? member.scopes.map(str).filter(Boolean) : []
    const scopeText = scopes.join(',')
    const running = usNum(member.jobs_running) ?? 0
    const queued = usNum(member.jobs_queued) ?? 0
    parts.push(
      (str(member.agentId) || '?') +
        '/' +
        (str(member.role) || '-') +
        ' ' +
        (str(member.state) || 'idle') +
        (scopeText ? ' scopes=' + scopeText : '') +
        (running || queued ? ' jobs=' + String(running) + 'r/' + String(queued) + 'q' : '') +
        (member.blocked_reason ? ' blocked=' + str(member.blocked_reason) : ''),
    )
  }
  return parts.join(' · ')
}
