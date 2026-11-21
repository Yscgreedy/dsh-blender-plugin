// Session-map maintenance extracted from the registry so the class stays inside
// its module budget: pruning expired owners/grants and instance disconnects.
import { callerKey, inOwnerFamily, ownerStale, readableBy } from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord } from './types.js'

export function pruneSessions(
  sessions: Map<string, SessionRecord>,
  listInstances: () => InstanceRef[],
  now = Date.now(),
): InstanceRef[] {
  const instances = listInstances()
  for (const s of sessions.values()) {
    // Subagent owners expire after 30 s (field 反馈 2); a live blender_py holds the
    // session until it ends, exactly like the grant TTL rule below.
    if (s.owner && ownerStale(s.owner, now) && !s.activePy) {
      s.owner = null
      s.activePy = null
      // Grants have their own TTL. They used to be cleared together with the
      // owner, so a main agent that went idle lost every authorization; a
      // re-attach then showed grants=[]. Keep them until expiresAt.
    }
    for (const [id, g] of s.grants) {
      if (g.expiresAt > now) continue
      // An active blender_py holds its exclusive grant for the whole call;
      // the 30s grant TTL must not expire under a long-running script.
      if (s.activePy && callerKey(g.holder) === callerKey(s.activePy.caller)) continue
      s.grants.delete(id)
    }
    if (s.kind === 'user-gui' && s.instanceId) {
      const inst = instances.find((x) => x.instanceId === s.instanceId)
      if (!inst || !inst.ready) {
        // A disconnected user-gui instance releases ownership immediately; a
        // reconnect claims fresh rather than inheriting a stale writer.
        s.owner = null
        s.agents.clear()
        s.grants.clear()
        s.activePy = null
        s.paused = false
        s.status = inst ? 'starting' : 'stopped'
      }
    }
  }
  return instances
}

/**
 * Sessions nobody owns any more (the owner stopped heartbeating and prune()
 * cleared the record) whose Blender is still connected. They stay visible and
 * claimable instead of becoming a wall that only a process kill can clear.
 */
export function unownedSessions(
  sessions: Map<string, SessionRecord>,
  instances: InstanceRef[],
): SessionRecord[] {
  const ready = new Set(instances.filter((x) => x.ready).map((x) => x.instanceId))
  const out: SessionRecord[] = []
  for (const s of sessions.values()) {
    if (s.owner) continue
    if (!s.instanceId || !ready.has(s.instanceId)) continue
    out.push(s)
  }
  return out
}

export function findCallerSession(
  sessions: Map<string, SessionRecord>,
  c: CallerIdentity,
): SessionRecord | null {
  for (const s of sessions.values()) {
    // Same-host callers find the session so attach can return a viewer; is_mine
    // (strict family) stays false in the receipt.
    if (s.owner && (inOwnerFamily(s.owner, c) || readableBy(s.owner, c))) return s
    if (s.agents.has(callerKey(c))) return s
  }
  return null
}

/**
 * Sessions this caller may *read* but not own: same host, someone else's owner.
 * The field report needs a read-only bypass for blender_see and audit_* ops, with
 * the owner spelled out in the receipt. Writes never use this list.
 */
export function readableSessions(
  sessions: Map<string, SessionRecord>,
  c: CallerIdentity,
  instances: InstanceRef[],
): SessionRecord[] {
  const ready = new Set(instances.filter((x) => x.ready).map((x) => x.instanceId))
  const out: SessionRecord[] = []
  for (const s of sessions.values()) {
    if (!s.owner || inOwnerFamily(s.owner, c)) continue
    if (!readableBy(s.owner, c)) continue
    if (!s.instanceId || !ready.has(s.instanceId)) continue
    out.push(s)
  }
  return out
}

/** The session behind one addon instance (attribution for a plan/op receipt). */
export function sessionForInstance(
  sessions: Map<string, SessionRecord>,
  instanceId: string,
): SessionRecord | null {
  if (!instanceId) return null
  return sessions.get('user-gui:' + String(instanceId)) ?? null
}
