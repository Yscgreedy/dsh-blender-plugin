// Instance bookkeeping: the live addon instances, the stale-record prune they drive,
// and the resource counts the panel and the gateway read.
//
// Extracted from registry.ts (registry split, fourth slice) with no behavior change:
// refreshInstances / readyInstanceIds / prune / reapLostInstances / livenessOf /
// virtualGuiCount / handleInstanceGone / limits / waitForInstance moved here verbatim.
//
// The host interface is exactly what this book touches: the sessions map, the gateway's
// instance list, the virtual-gui teardown, and the limits/wait knobs. Keeping them explicit
// means the prune can be exercised without a registry.

import { pruneSessions } from './lookup.js'
import type { AttachLiveness } from './attach.js'
import type { InstanceRef, SessionRecord } from './types.js'
import type { VirtualGuiLimits } from '../../display/limits.js'

/** What instance bookkeeping takes from the registry. */
export interface InstanceBookHost {
  sessions: Map<string, SessionRecord>
  /** The gateway's live instance list (the registry's constructor argument). */
  listInstances(): InstanceRef[]
  /** Tear a virtual-gui session down (provider.stop kills helper + hidden Blender). */
  dispose(session: SessionRecord): Promise<unknown> | void
  limits(): VirtualGuiLimits
  waitForInstance(instanceId: string, timeoutMs: number): Promise<boolean>
}

export class InstanceBook {
  private instances: InstanceRef[] = []
  /**
   * 实例表是否曾经"有内容"。空表本身不是"实例已掉线"的证据 —— 测试里没有真实
   * Gateway 的 registry 恒为空表，把它们当成掉线会把活着的 virtual-gui 拆掉。
   */
  private sawInstances = false

  constructor(private readonly host: InstanceBookHost) {
    // 构造时已有的实例也算"实例表可用"的证据（registry 通常在所有 addon 之前建）。
    if (host.listInstances().length) this.sawInstances = true
  }

  /** The instance list this book pruned last (read-only views drain it). */
  list(): InstanceRef[] {
    return this.instances
  }

  refresh(next: InstanceRef[]): void {
    this.instances = next
    if (next.length) this.sawInstances = true
  }

  /** Ready instances the Gateway currently knows — routing evidence for the host layer. */
  ready(): string[] {
    this.prune()
    return this.instances.filter((x) => x.ready).map((x) => x.instanceId)
  }

  prune(now = Date.now()): void {
    this.instances = pruneSessions(this.host.sessions, this.host.listInstances, now)
    if (this.instances.length) this.sawInstances = true
    this.reapLost()
  }

  /**
   * A virtual-gui session cannot outlive the Blender it started. The instance_gone
   * event normally disposes it, but a missed event used to leave a session record
   * with a live provider handle and no way to stop it; this is the same teardown,
   * driven from the instance list instead of the event stream.
   */
  private reapLost(): void {
    if (!this.sawInstances) return
    const known = new Set(this.instances.map((x) => x.instanceId))
    for (const s of [...this.host.sessions.values()]) {
      if (s.kind !== 'virtual-gui' || !s.instanceId || known.has(s.instanceId)) continue
      this.host.sessions.delete(s.id)
      void this.host.dispose(s)
    }
  }

  /** Is the instance behind this record in the live ready list right now? */
  liveness(session: SessionRecord): AttachLiveness {
    const ready = this.instances.filter((x) => x.ready)
    const own = ready.some((x) => x.instanceId === session.instanceId)
    return { instanceReady: own, readyInstances: ready.length }
  }

  /** virtual-gui sessions that are starting or ready (the panel's resource count). */
  count(): number {
    let count = 0
    for (const s of this.host.sessions.values()) {
      if (s.kind === 'virtual-gui' && (s.status === 'starting' || s.status === 'ready')) count++
    }
    return count
  }

  /** The addon socket dropped: a virtual-gui session for it cannot outlive it. */
  gone(instanceId: string): void {
    const session = this.host.sessions.get('virtual-gui:' + String(instanceId))
    if (!session) return
    session.status = 'stopped'
    this.host.sessions.delete(session.id)
    void this.host.dispose(session)
  }

  limits(): VirtualGuiLimits {
    return this.host.limits()
  }

  wait(instanceId: string, timeoutMs: number): Promise<boolean> {
    return this.host.waitForInstance(instanceId, timeoutMs)
  }
}
