// Job ownership rules shared by the queue and the six-tool surface.
//
// Queue jobs are created by an agent call, so cancellation and collection are
// restricted to that agent, its parent agent, and the main agent of the same
// DSH session. The rule is pure so section 6 can apply it to persisted jobs
// without importing queue state here.

import type { CallerIdentity } from './types.js'

export interface JobOwner {
  hostId: string
  dshSessionId: string
  agentId: string
  parentAgentId?: string
}

export type JobManageAction = 'collect' | 'cancel' | 'status'

export interface JobManageDecision {
  allowed: boolean
  reason: 'owner' | 'parent' | 'main' | 'other_session' | 'not_owner'
}

export function jobOwnerFromCaller(c: CallerIdentity): JobOwner {
  return {
    hostId: String(c.hostId || ''),
    dshSessionId: String(c.dshSessionId || ''),
    agentId: String(c.agentId || ''),
    ...(c.parentAgentId ? { parentAgentId: String(c.parentAgentId) } : {}),
  }
}

export function canManageJob(c: CallerIdentity, owner: JobOwner): JobManageDecision {
  // C-8：DSH 给每个子代理独立的 dshSessionId，所以"sessionId 不等就拒绝"会把
  // 父 agent / main 读子代理作业的两条分支变成死代码（父的 sessionId 一定不同）。
  // 判定顺序改成：跨 host → 本人 → 父 agent 关系 → 同会话的 main → 最后才按会话区分。
  if (owner.hostId !== c.hostId) return { allowed: false, reason: 'other_session' }
  if (owner.agentId === c.agentId) return { allowed: true, reason: 'owner' }
  if (owner.parentAgentId && owner.parentAgentId === c.agentId)
    return { allowed: true, reason: 'parent' }
  if (c.role === 'main' && owner.dshSessionId === c.dshSessionId)
    return { allowed: true, reason: 'main' }
  return {
    allowed: false,
    reason: owner.dshSessionId === c.dshSessionId ? 'not_owner' : 'other_session',
  }
}

export function jobPermissionFailure(decision: JobManageDecision, action: JobManageAction): string {
  if (decision.allowed) return ''
  if (decision.reason === 'other_session')
    return (
      action +
      ' is limited to the agent that submitted the job, its parent agent, and its session main agent ' +
      '(a subagent has its own DSH session id, so the parent relation — not session equality — decides)'
    )
  return action + ' is limited to the owning agent, its parent agent, or the main agent'
}
