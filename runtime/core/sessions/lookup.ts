// Session-map maintenance extracted from the registry so the class stays inside
// its module budget: pruning expired owners/grants and instance disconnects.
import { callerKey, OWNER_TTL_MS } from './types.js'
import type { CallerIdentity, InstanceRef, SessionRecord } from './types.js'

export function pruneSessions(
  sessions: Map<string, SessionRecord>,
  listInstances: () => InstanceRef[],
  now = Date.now(),
): InstanceRef[] {
  const instances = listInstances()
  for (const s of sessions.values()) {
    if (s.owner && now - s.owner.heartbeatAt > OWNER_TTL_MS) {
      s.owner = null
      s.activePy = null
      s.grants.clear()
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
    if (s.owner && s.owner.hostId === c.hostId && s.owner.dshSessionId === c.dshSessionId) return s
    if (s.agents.has(callerKey(c))) return s
  }
  return null
}
