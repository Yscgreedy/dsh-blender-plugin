/**
 * S-1（优先级 1）：doctor 的 virtualGui 段必须回答「本 caller 现在能不能开 virtual-gui」，
 * 且判据与 start **同源**（start 用 registry.findForCaller(caller) 判「已经有一扇
 * 就绪的 user-gui」，再用 displayCapabilities() 判能力），只是这里全程只读。
 *
 * 现场反例（台账 S-1）：doctor 只报 capability.ready=true，start 却以
 * session_already_available / feature_disabled 拒绝 —— 两个结论互相矛盾。
 *
 * 本文件只测纯函数 + doctor 回执的 additive 形状；不碰 HTTP、不落 consent 请求。
 */
import { describe, expect, it } from 'vitest'
import { createDoctorApi, virtualGuiAvailability } from '../../../runtime/core/engine-api/doctor.js'
import type { EngineApiDeps } from '../../../runtime/core/engine-api/index.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'
import { buildDisplayCapabilities } from '../../../runtime/display/prerequisites.js'
import type { DisplayCapabilities } from '../../../runtime/display/types.js'

const WIN_CHECKS = { 'win-hidden-desktop-helper': true, blender: true }

function main(over: Partial<CallerIdentity> = {}): CallerIdentity {
  return { hostId: 'host-a', dshSessionId: 'dsh-1', agentId: 'agent-main', role: 'main', ...over }
}

function readyCapability(): DisplayCapabilities {
  return buildDisplayCapabilities({
    platform: 'win32',
    configured: 'on',
    checks: WIN_CHECKS,
    providerImplemented: true,
  })
}

function fakeEngine(): EngineApiDeps {
  return {
    metrics: { lastCmdAt: null, views: 0 },
    jobs: new Map(),
    runs: new Map(),
  } as unknown as EngineApiDeps
}

describe('virtualGuiAvailability：与 start 同源的只读判定', () => {
  it('answers ready for a caller with no session while the capability is ready', () => {
    const verdict = virtualGuiAvailability({
      caller: main(),
      claim: null,
      capability: readyCapability(),
    })
    expect(verdict).toEqual({ available_for_caller: true, reason: 'ready' })
  })

  it('refuses when the caller already owns a ready user-gui session (start: session_already_available)', () => {
    const verdict = virtualGuiAvailability({
      caller: main(),
      claim: 'mine',
      capability: readyCapability(),
    })
    expect(verdict).toEqual({ available_for_caller: false, reason: 'session_already_available' })
  })

  it('does not refuse on another caller’s window: visible is not occupied (S-4)', () => {
    const verdict = virtualGuiAvailability({
      caller: main({ dshSessionId: 'dsh-2', agentId: 'agent-other' }),
      claim: 'others',
      capability: readyCapability(),
    })
    expect(verdict).toEqual({ available_for_caller: true, reason: 'ready' })
  })

  it('does not refuse on an unowned ready window either: it is claimable', () => {
    expect(
      virtualGuiAvailability({ caller: main(), claim: 'unowned', capability: readyCapability() }),
    ).toEqual({ available_for_caller: true, reason: 'ready' })
  })

  it('is honest without a caller identity (curl /doctor) instead of pretending ready', () => {
    const verdict = virtualGuiAvailability({
      caller: null,
      claim: null,
      capability: readyCapability(),
    })
    expect(verdict).toEqual({ available_for_caller: false, reason: 'caller_identity_required' })
  })

  it('reports feature_disabled when virtual-gui is switched off', () => {
    const off = buildDisplayCapabilities({
      platform: 'win32',
      configured: 'off',
      checks: WIN_CHECKS,
      providerImplemented: true,
    })
    expect(virtualGuiAvailability({ caller: main(), claim: null, capability: off })).toEqual({
      available_for_caller: false,
      reason: 'feature_disabled',
    })
  })

  it('mirrors the start codes for an enabled capability that is not ready', () => {
    const missing = buildDisplayCapabilities({
      platform: 'win32',
      configured: 'on',
      checks: { 'win-hidden-desktop-helper': false, blender: true },
      providerImplemented: true,
    })
    expect(
      virtualGuiAvailability({ caller: main(), claim: null, capability: missing }).reason,
    ).toBe('prerequisites_missing')
    const noProvider = buildDisplayCapabilities({
      platform: 'darwin',
      configured: 'on',
      providerImplemented: false,
    })
    expect(virtualGuiAvailability({ caller: main(), claim: null, capability: noProvider })).toEqual(
      { available_for_caller: false, reason: 'provider_unavailable' },
    )
  })

  it('keeps the capability branch for a duplicate/unknown claim value', () => {
    for (const claim of [null, undefined, 'weird'] as unknown[]) {
      const verdict = virtualGuiAvailability({
        caller: main(),
        claim: claim as never,
        capability: readyCapability(),
      })
      expect(verdict.available_for_caller).toBe(true)
    }
  })

  it('keeps the ownership refusal ahead of the capability: a disabled feature still names the window', () => {
    const off = buildDisplayCapabilities({
      platform: 'win32',
      configured: 'off',
      checks: WIN_CHECKS,
      providerImplemented: true,
    })
    expect(virtualGuiAvailability({ caller: main(), claim: 'mine', capability: off })).toEqual({
      available_for_caller: false,
      reason: 'session_already_available',
    })
  })
})

describe('doctor 的 virtualGui 段（additive）', () => {
  it('adds available_for_caller + reason without dropping the capability fields', async () => {
    const body = await createDoctorApi(fakeEngine()).doctor({
      forceNoAddon: true,
      caller: main(),
      claim: 'mine',
    })
    const virtualGui = body.virtualGui as Record<string, unknown>
    expect(virtualGui.available_for_caller).toBe(false)
    expect(virtualGui.reason).toBe('session_already_available')
    // 既有能力字段一个不少
    for (const key of ['enabled', 'ready', 'prerequisites', 'missing', 'fix', 'installPlans'])
      expect(virtualGui).toHaveProperty(key)
  })

  it('answers false + caller_identity_required when the route passes no caller', async () => {
    const body = await createDoctorApi(fakeEngine()).doctor({ forceNoAddon: true })
    const virtualGui = body.virtualGui as Record<string, unknown>
    expect(virtualGui.available_for_caller).toBe(false)
    expect(virtualGui.reason).toBe('caller_identity_required')
  })

  it('carries the two fields through the gateway-required branch too', async () => {
    const body = await createDoctorApi(fakeEngine()).doctor({ caller: main() })
    expect(body.addon).toMatchObject({ kind: 'gateway-required' })
    const virtualGui = body.virtualGui as Record<string, unknown>
    expect(typeof virtualGui.available_for_caller).toBe('boolean')
    expect(typeof virtualGui.reason).toBe('string')
    expect(virtualGui).toHaveProperty('enabled')
  })
})
