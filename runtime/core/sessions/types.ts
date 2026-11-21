// 3.1 GUI session registry: ownership, scope grants, presence, and the
// session-level guard used by every Gateway write route.
//
// This is intentionally in-memory: the Gateway owns the live process/session
// state, and a Gateway restart recreates it from addon handshakes. No scene data
// is stored here; presence only keeps caller-visible view poses and labels.

import { availabilityFailure } from '../availability.js'
import type { AvailabilityFailure } from '../availability.js'
import type { ScopeSpec } from './scopes.js'
import type { DisplayInstance, DisplayProvider } from '../../display/types.js'

/**
 * Main-agent ownership TTL. Field retest: a main agent that attaches and then
 * waits ~10 minutes for a subagent lost ownership at 120 s — status showed
 * owner=null while grants still said session_in_use. A main session may sit idle
 * for a whole subagent round, so the TTL is 30 min; subagents keep their 30 s
 * stale window, and a same-host main can always force-release a dead one.
 */
export const OWNER_TTL_MS = 1_800_000
export const OWNER_HEARTBEAT_MS = 30_000
/**
 * A subagent owner is reclaimed much faster than a main agent.
 *
 * field report 3.2.0-alpha.1（问题 2）: a subagent crashed mid-probe and its lease stayed
 * on the GUI session; every later attach/release (even force=true) answered
 * session_in_use until DSH was restarted. A subagent is short-lived and calls its
 * tools continuously, so 30 s without a call is evidence it is gone. A main agent
 * may legitimately sit idle for a whole subagent round, so it keeps 30 min.
 */
export const OWNER_STALE_SUBAGENT_MS = 30_000
/** Default grant lifetime (10 min) and the hard cap a caller may request. */
export const GRANT_TTL_MS = 600_000
export const GRANT_HEARTBEAT_MS = 60_000
export const GRANT_TTL_MAX_MS = 3_600_000
export const PY_WAIT_MAX_MS = 5_000

export type SessionKind = 'user-gui' | 'virtual-gui'
export type SessionStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface CallerIdentity {
  hostId: string
  dshSessionId: string
  agentId: string
  parentAgentId?: string
  role?: 'main' | 'subagent'
  callId?: string
  turnId?: string
  displayName?: string
  color?: string
}

export interface InstanceRef {
  instanceId: string
  kind?: string
  ready: boolean
  project?: string
}

export interface ViewPose {
  viewpoint: 'viewport' | 'camera' | 'custom'
  from?: [number, number, number]
  lookAt?: [number, number, number]
  lens?: number
  ortho?: boolean
  orthoScale?: number
  camera?: string
  frame?: number
  viewMatrix?: number[]
  followUser?: boolean
  updatedAt: number
}

export interface AgentPresence {
  caller: CallerIdentity
  attachedAt: number
  lastSeen: number
  view: ViewPose | null
  selected: string[]
  activity: string
  color: string
  displayName: string
}

/** One object/collection the human changed since the last mark_read. */
export interface HumanEdit {
  kind: 'object' | 'collection'
  name: string
  revision: number
  at: number
}

export interface GrantRecord {
  id: string
  sessionId: string
  holder: CallerIdentity
  grantedBy: CallerIdentity
  scopes: ScopeSpec[]
  createdAt: number
  heartbeatAt: number
  expiresAt: number
}

export interface Owner {
  hostId: string
  dshSessionId: string
  agentId: string
  claimedAt: number
  heartbeatAt: number
  /** Who claimed it: a subagent owner is reclaimed after 30 s without a call. */
  role?: 'main' | 'subagent'
  parentAgentId?: string
}

export interface SessionRecord {
  id: string
  kind: SessionKind
  instanceId: string | null
  status: SessionStatus
  owner: Owner | null
  agents: Map<string, AgentPresence>
  grants: Map<string, GrantRecord>
  paused: boolean
  pausedAt: number | null
  activePy: { caller: CallerIdentity; startedAt: number } | null
  humanEdits: Map<string, HumanEdit>
  humanModifiedAt: number | null
  /** Set for virtual-gui: the provider handle and the provider that owns it. */
  display: DisplayInstance | null
  provider: DisplayProvider | null
  createdAt: number
  lastActivityAt: number
}

export type SessionResult<T> = ({ ok: true } & T) | AvailabilityFailure

export const COLORS = ['#4C8DFF', '#FF6B6B', '#2FBF71', '#F5A623', '#9B59B6', '#20B2AA']

export function fail(
  code: string,
  stage: 'config' | 'session' | 'queue',
  rootCause: string,
  fix: string,
  evidence: Record<string, unknown> = {},
): AvailabilityFailure {
  return availabilityFailure({
    stage,
    code,
    rootCause,
    fix,
    fallback: { kind: 'unavailable', summary: 'operation unavailable' },
    evidence,
  })
}

export function callerKey(c: CallerIdentity): string {
  return [c.hostId, c.dshSessionId, c.agentId].map((x) => String(x || '')).join('|')
}

/**
 * A grant holder may have been recorded with the parent's dshSessionId when the
 * grant named only target_agent_id (DSH gives the subagent its own session id).
 * Host + agentId is the stable identity for that case; an exact callerKey still
 * wins for every other caller.
 */
export function callerMatchesHolder(holder: CallerIdentity, c: CallerIdentity): boolean {
  if (callerKey(holder) === callerKey(c)) return true
  return (
    String(holder.hostId || '') === String(c.hostId || '') &&
    !!holder.agentId &&
    String(holder.agentId) === String(c.agentId || '')
  )
}

export function ownerOf(c: CallerIdentity): Owner {
  return {
    hostId: String(c.hostId || ''),
    dshSessionId: String(c.dshSessionId || ''),
    agentId: String(c.agentId || ''),
    claimedAt: Date.now(),
    heartbeatAt: Date.now(),
    role: c.role === 'main' ? 'main' : 'subagent',
    ...(c.parentAgentId ? { parentAgentId: c.parentAgentId } : {}),
  }
}

export function ownerMatches(owner: Owner | null, c: CallerIdentity): boolean {
  return !!owner && owner.hostId === c.hostId && owner.dshSessionId === c.dshSessionId
}

/** Same machine + same DSH session is the strict match (the main agent and its direct agents). */
export function sameHost(owner: Owner | null, c: CallerIdentity): boolean {
  return !!owner && String(owner.hostId || '') === String(c.hostId || '')
}

/**
 * Family = the owner's own DSH session, or a subagent whose parent is that owner.
 *
 * DSH gives a subagent its own dshSessionId (field report 问题 1), so ownerMatches()
 * alone locks every subagent out. The parent link is the honest evidence that this
 * caller works for the same user in the same workspace; it grants read + viewer
 * presence, never a write.
 */
export function inOwnerFamily(owner: Owner | null, c: CallerIdentity): boolean {
  if (!owner || !sameHost(owner, c)) return false
  if (ownerMatches(owner, c)) return true
  // A main agent of another DSH session is not family, even on the same host.
  if (c.role !== 'subagent') return false
  if (c.parentAgentId) return String(c.parentAgentId) === String(owner.agentId || '')
  return false
}

/** Reads are cross-visible on the same machine (attributed with owner/is_mine). */
export function readableBy(owner: Owner | null, c: CallerIdentity): boolean {
  return sameHost(owner, c)
}

export function ownerStaleMs(owner: Owner | null): number {
  return owner && owner.role === 'subagent' ? OWNER_STALE_SUBAGENT_MS : OWNER_TTL_MS
}

/** True when the owner heartbeat is old enough to be considered gone. */
export function ownerStale(owner: Owner | null, now = Date.now()): boolean {
  if (!owner) return false
  return now - Number(owner.heartbeatAt || 0) > ownerStaleMs(owner)
}

export function isMain(session: SessionRecord, c: CallerIdentity): boolean {
  return !!session.owner && session.owner.agentId === c.agentId && ownerMatches(session.owner, c)
}

export function colourFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length] as string
}

export function callerView(c: CallerIdentity): Record<string, unknown> {
  return {
    hostId: c.hostId,
    dshSessionId: c.dshSessionId,
    agentId: c.agentId,
    parentAgentId: c.parentAgentId || null,
    role: c.role || 'subagent',
  }
}

export function grantView(g: GrantRecord): Record<string, unknown> {
  return {
    id: g.id,
    holder: callerView(g.holder),
    grantedBy: callerView(g.grantedBy),
    scopes: g.scopes,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    expiresInMs: Math.max(0, g.expiresAt - Date.now()),
  }
}

/**
 * 反馈 2（修正）: the complaint was not "no reclaim at all" but "15-20
 * minutes with no visible contract". Age + threshold make the countdown mechanical.
 */
function ownerViewOf(s: SessionRecord): Record<string, unknown> | null {
  if (!s.owner) return null
  return {
    hostId: s.owner.hostId,
    dshSessionId: s.owner.dshSessionId,
    agentId: s.owner.agentId,
    parentAgentId: s.owner.parentAgentId || null,
    role: s.owner.role || 'main',
    claimedAt: s.owner.claimedAt,
    heartbeatAt: s.owner.heartbeatAt,
    heartbeat_age_ms: Math.max(0, Date.now() - Number(s.owner.heartbeatAt || 0)),
    stale_after_ms: ownerStaleMs(s.owner),
    stale: ownerStale(s.owner),
    expiresInMs: Math.max(0, s.owner.heartbeatAt + ownerStaleMs(s.owner) - Date.now()),
  }
}

export function sessionView(s: SessionRecord, caller?: CallerIdentity): Record<string, unknown> {
  const ownerView = ownerViewOf(s)
  const isMine = !!caller && (ownerMatches(s.owner, caller) || inOwnerFamily(s.owner, caller))
  const hasGrant =
    !!caller &&
    !!s.owner &&
    [...s.grants.values()].some((g) => callerMatchesHolder(g.holder, caller))
  return {
    id: s.id,
    kind: s.kind,
    instanceId: s.instanceId,
    status: s.status,
    /** Ownership attribution: never let a caller mistake someone else's scene for its own. */
    is_mine: caller ? isMine : null,
    readable: caller ? readableBy(s.owner, caller) : null,
    borrowed: caller ? readableBy(s.owner, caller) && !isMine : null,
    read_only: caller ? readableBy(s.owner, caller) && !isMine : null,
    has_grant: caller ? hasGrant : null,
    owner: ownerView,
    ...(!s.owner && s.agents.size
      ? {
          owner_expired: true,
          note: 'owner heartbeat expired: call blender_session action=attach to reclaim; grants keep their own TTL',
        }
      : {}),
    ...(s.owner && ownerStale(s.owner)
      ? {
          reclaim:
            'owner heartbeat is stale (age ' +
            String(Math.max(0, Date.now() - Number(s.owner.heartbeatAt || 0))) +
            ' ms > ' +
            String(ownerStaleMs(s.owner)) +
            ' ms): a same-host main agent can call blender_session action=release session_id=' +
            s.id +
            ' force=true',
        }
      : {}),
    paused: s.paused,
    agents: [...s.agents.values()].map((a) => ({
      agent: callerView(a.caller),
      displayName: a.displayName,
      color: a.color,
      attachedAt: a.attachedAt,
      lastSeen: a.lastSeen,
      view: a.view,
      selected: a.selected,
      activity: a.activity,
    })),
    grants: [...s.grants.values()].map(grantView),
    activePy: s.activePy
      ? { holder: callerView(s.activePy.caller), startedAt: s.activePy.startedAt }
      : null,
    display: s.display
      ? {
          id: s.display.id,
          provider: s.display.provider,
          display: s.display.display,
          pid: s.display.pid,
        }
      : null,
    humanModified: s.humanEdits.size
      ? {
          at: s.humanModifiedAt,
          objects: [...s.humanEdits.values()]
            .filter((edit) => edit.kind === 'object')
            .map((edit) => ({ name: edit.name, revision: edit.revision })),
          collections: [...s.humanEdits.values()]
            .filter((edit) => edit.kind === 'collection')
            .map((edit) => ({ name: edit.name, revision: edit.revision })),
        }
      : null,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
  }
}
