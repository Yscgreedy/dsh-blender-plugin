// doctor 的 virtualGui 段（S-1）：能力 + 「本 caller 现在能不能开 virtual-gui」的只读判定。
//
// 从 doctor.ts 抽出（task-24：那个文件触到了 600 行文件预算）。doctor.ts 只 import
// virtualGuiSection / virtualGuiView；本模块**不**反向 import doctor.ts（import 图无环），
// 也不是再导出 barrel：判据与装配都在这里。
//
// 与 start 同源但只读：归属关系是 display-gate 导出的 userGuiClaim 的结论（S-4：只有
// 「我自己的 ready user-gui」挡 start），能力是 displayCapabilities()，失败 reason 直接
// 沿用 start 的 code。consent 解析、启动、任何写动作都不在这里发生。
import { buildInstallPlans } from '../../display/install.js'
import { displayCapabilities } from '../../display/prerequisites.js'
import type { DisplayCapabilities } from '../../display/types.js'
import type { UserGuiClaim } from '../sessions/display-gate.js'
import type { CallerIdentity } from '../sessions/types.js'

export interface VirtualGuiAvailability {
  available_for_caller: boolean
  reason: string
}

export interface VirtualGuiAvailabilityInput {
  /** DSH 身份；null = 无 caller（curl /doctor、没带身份头）。 */
  caller: CallerIdentity | null
  /** start 的同一个归属判据（display-gate:userGuiClaim）的结论；null = 没有挡住 start 的窗口。 */
  claim?: UserGuiClaim | null
  capability: DisplayCapabilities
}

export function virtualGuiAvailability(input: VirtualGuiAvailabilityInput): VirtualGuiAvailability {
  const { caller, claim, capability } = input
  // 没有身份就没有「本 caller」可言：如实 false，而不是替别人报 ready。
  if (!caller) return { available_for_caller: false, reason: 'caller_identity_required' }
  // S-4：只有自己已经拥有一扇就绪的 user-gui 才会挡住 start。
  if (claim === 'mine') return { available_for_caller: false, reason: 'session_already_available' }
  if (!capability.enabled) return { available_for_caller: false, reason: 'feature_disabled' }
  if (!capability.ready)
    return {
      available_for_caller: false,
      reason:
        String(capability.reason || '').indexOf('prerequisites') === 0
          ? 'prerequisites_missing'
          : 'provider_unavailable',
    }
  return { available_for_caller: true, reason: 'ready' }
}

/** opts.caller → CallerIdentity（HTTP 边界递进来的普通对象；坏形状按「无身份」处理）。 */
function callerOf(opts: Record<string, unknown>): CallerIdentity | null {
  const raw = opts.caller
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const view = raw as Record<string, unknown>
  const hostId = String(view.hostId || '')
  const dshSessionId = String(view.dshSessionId || '')
  const agentId = String(view.agentId || '')
  if (!hostId || !dshSessionId || !agentId) return null
  return { hostId, dshSessionId, agentId, role: view.role === 'main' ? 'main' : 'subagent' }
}

/** opts.claim → start 的归属结论（坏值按「没有挡住 start」处理）。 */
function claimOf(opts: Record<string, unknown>): UserGuiClaim | null {
  const raw = opts.claim
  return raw === 'mine' || raw === 'others' || raw === 'unowned' ? raw : null
}

/**
 * doctor 的 virtualGui 段：能力 + 本 caller 的只读判定（additive）。
 * withInstallPlans 只在原来就带它的分支（forced / gateway-required）保留：正常分支
 * 不多出安装计划，既有形状一个字不动。
 */
export function virtualGuiSection(
  opts: Record<string, unknown>,
  withInstallPlans: boolean,
): Record<string, unknown> {
  const capability = displayCapabilities()
  const availability = virtualGuiAvailability({
    caller: callerOf(opts),
    claim: claimOf(opts),
    capability,
  })
  return {
    ...capability,
    ...(withInstallPlans ? { installPlans: buildInstallPlans(capability) } : {}),
    ...availability,
  }
}

/** Capabilities plus the guided-install plans shared by doctor --fix and the add-on button. */
export function virtualGuiView(): Record<string, unknown> {
  const capabilities = displayCapabilities()
  return { ...capabilities, installPlans: buildInstallPlans(capabilities) }
}
