// /session 路由：who（拆分）
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteDeps } from '../deps.js'
import { objArg } from '../deps.js'
import { currentCaller } from '../../caller.js'

/**
 * 工单 B（台账 B）：`crew[]` —— 让人和主控看到“谁在改什么”。
 *
 * 现场痛点：`session list` 有 owner / is_mine / grants，却回答不了“这个 agent 在改
 * 什么、最近一次写入、在跑几个作业”。这里把一行会话视图 enrich 成一队 crew 成员：
 * 全部从**已有的行**（owner / agents / grants）与作业队列派生，不新增写路径，
 * 也不改 sessionView 的任何既有字段。
 */

/** 非终态作业才代表“这个 agent 还在干活”。 */
const TERMINAL_JOB_STATES = ['completed', 'failed', 'canceled']
/** 只取这三种状态的作业：历史队列（几百条终态）不参与 crew 计数。 */
const CREW_JOB_STATES = ['queued', 'assigned', 'running']
/** 每种状态最多取多少行：非终态作业本来就被队列容量卡住（pending 64 + GPU 1 + CPU 2）。 */
const CREW_JOB_SCAN_LIMIT = 500

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
  const rec = objArg(scope)
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
 * grantView 现在会带 heartbeatAt（task-7）；老 Gateway 的视图只有 createdAt，
 * 就退回它 —— 那是老视图里唯一的时间证据，比谎报 null 有用。
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
    const grant = objArg(raw)
    const holder = objArg(grant.holder)
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
  const owner = objArg(session.owner)
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
    const agent = objArg(objArg(raw).agent)
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
  const owner = objArg(session.owner)
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
    const rec = objArg(job)
    if (str(objArg(rec.owner).agentId) !== agentId) continue
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
 * 队列是观测数据：取不到就按 0 个作业算，/who 不许因此 500。
 */
function crewJobRows(jobQueue: HttpRouteDeps['jobQueue'] | null | undefined): CrewJobRow[] {
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

/** Additive enrich：每行保留全部既有字段，只多一个 crew[]。 */
function withCrew(
  rows: Record<string, unknown>[],
  jobRows: CrewJobRow[],
): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, crew: crewView(row, jobRows) }))
}

/**
 * 会话行 + 作业队列 → 带 crew[] 的行。
 *
 * `/who`（本文件）与 `/lease action=list`（session/api.ts，模型侧 `blender_session
 * action=list` 的回执）走**同一条** enrich：队列缺失/取不到时只按 0 个作业算。
 */
export function crewRows(
  rows: Record<string, unknown>[],
  jobQueue: HttpRouteDeps['jobQueue'] | null | undefined,
): Record<string, unknown>[] {
  return withCrew(rows, crewJobRows(jobQueue))
}

export function createWhoHandler(E: HttpRouteDeps) {
  const {
    PORT,
    describeConfig,
    engine,
    jobQueue,
    json,
    leaseView,
    reqCounts,
    sessionRegistry,
    stats,
  } = E
  return async function who(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    _p: string,
  ): Promise<void> {
    const caller = currentCaller()
    json(res, 200, {
      ok: true,
      sessions: crewRows(
        !sessionRegistry ? [] : caller ? sessionRegistry.listFor(caller) : sessionRegistry.list(),
        jobQueue,
      ),
      lease: leaseView(),
      metrics: engine.metrics(),
      stats: stats,
      config: describeConfig({ httpPort: PORT }),
      requests: Object.fromEntries(reqCounts),
    })
    return
  }
}
