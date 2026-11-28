import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isolateConsentDir } from '../../helpers/consent-dir'
import { buildDisplayCapabilities } from '../../../runtime/display/prerequisites.js'
import {
  clampVirtualGuiLimit,
  resolveVirtualGuiLimits,
  VIRTUAL_GUI_DEFAULT_MAX,
} from '../../../runtime/display/limits.js'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import { startVirtualGuiGate, userGuiClaim } from '../../../runtime/core/sessions/display-gate.js'
import type {
  DisplayHealth,
  DisplayInstance,
  DisplayProvider,
  DisplayStartRequest,
} from '../../../runtime/display/types.js'
import type { VirtualGuiLimits } from '../../../runtime/display/limits.js'
import type { CallerIdentity } from '../../../runtime/core/sessions/types.js'

const WIN_CHECKS = { 'win-hidden-desktop-helper': true, blender: true }
const MAIN = { hostId: 'h', dshSessionId: 's', agentId: 'a', role: 'main' as const }
const OTHER = { hostId: 'h', dshSessionId: 's2', agentId: 'a2', role: 'main' as const }

function readyCap() {
  return buildDisplayCapabilities({
    platform: 'win32',
    configured: 'on',
    checks: WIN_CHECKS,
    providerImplemented: true,
  })
}

function fakeProvider() {
  const started: DisplayStartRequest[] = []
  const stopped: DisplayInstance[] = []
  let display: DisplayInstance | null = null
  const provider: DisplayProvider = {
    kind: 'fake',
    capabilities: readyCap,
    async start(request) {
      started.push(request)
      display = { id: 'display_1', display: 'dsh-vgui-test', pid: 4242, provider: 'fake' }
      return display
    },
    async stop(instance) {
      stopped.push(instance)
    },
    async health(): Promise<DisplayHealth> {
      return { ok: true, detail: 'fake' }
    },
  }
  return { provider, started, stopped }
}

function limits(limit: number): VirtualGuiLimits {
  return {
    limit,
    configured: limit,
    low_resource: false,
    reason: 'configured',
    total_mem_bytes: 0,
    free_mem_bytes: 0,
  }
}

function makeRegistry(opts: {
  provider?: DisplayProvider | null
  wait?: (instanceId: string, timeoutMs: number) => Promise<boolean>
  max?: number
  instances?: { instanceId: string; ready: boolean }[]
}) {
  return new SessionRegistry(() => opts.instances || [], {
    display: readyCap,
    selectProvider: () => (opts.provider === undefined ? null : opts.provider),
    waitForInstance: opts.wait || (async () => true),
    limits: () => limits(opts.max ?? 4),
  })
}

async function startWithConsent(reg: SessionRegistry, caller: CallerIdentity = MAIN) {
  const consent = reg.issueConsent(caller)
  if (!consent.ok) throw new Error('consent failed')
  return reg.start(caller, { consentToken: consent.consentToken })
}

/** 隔离 consent 目录：start 会落请求，不能写进操作者的真实 workDir。 */
let consentSandbox: ReturnType<typeof isolateConsentDir> | null = null
beforeAll(() => {
  consentSandbox = isolateConsentDir('dsh-consent-lifecycle-')
})
afterAll(() => {
  consentSandbox?.dispose()
  consentSandbox = null
})

describe('virtual-gui lifecycle', () => {
  it('registers a ready session only after the addon handshake', async () => {
    const { provider, started } = fakeProvider()
    const gate: { release?: (value: boolean) => void } = {}
    const wait = () =>
      new Promise<boolean>((resolve) => {
        gate.release = resolve
      })
    const reg = makeRegistry({ provider, wait })
    const pending = startWithConsent(reg)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reg.listFor(MAIN)).toEqual([])
    expect(started).toHaveLength(1)
    expect(started[0].instanceId).toMatch(/^vgui-/)
    gate.release?.(true)
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.status).toBe('ready')
    expect(result.session.kind).toBe('virtual-gui')
    expect(result.session.instanceId).toBe(started[0].instanceId)
    expect(result.session.display).toMatchObject({ provider: 'fake', pid: 4242 })
    expect(reg.getSession(String(result.session.id))?.provider).toBe(provider)
  })

  it('stops the provider and leaves no session when the handshake never arrives', async () => {
    const { provider, stopped } = fakeProvider()
    const reg = makeRegistry({ provider, wait: async () => false })
    const result = await startWithConsent(reg)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('addon_handshake_timeout')
    expect(result.stage).toBe('handshake')
    expect(stopped).toHaveLength(1)
    expect(reg.listFor(MAIN)).toEqual([])
  })

  it('passes a structured provider error through without leaving a session', async () => {
    const provider = {
      kind: 'fake',
      capabilities: readyCap,
      async start(): Promise<DisplayInstance> {
        const error = new Error('helper missing') as Error & { view: () => unknown }
        error.view = () => ({
          ok: false,
          stage: 'config',
          code: 'helper_missing',
          root_cause: 'hidden-desktop helper not found',
          fix: 'install a 3.1 build',
          evidence: { checked: ['vendor'] },
        })
        throw error
      },
      async stop(): Promise<void> {},
      async health(): Promise<DisplayHealth> {
        return { ok: true, detail: 'fake' }
      },
    } satisfies DisplayProvider
    const reg = makeRegistry({ provider })
    const result = await startWithConsent(reg)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('config')
    expect(result.code).toBe('helper_missing')
    expect(result.evidence.checked).toEqual(['vendor'])
    expect(reg.listFor(MAIN)).toEqual([])
  })

  it('rejects a start above the instance limit before spawning anything', async () => {
    const { provider, started } = fakeProvider()
    const reg = makeRegistry({ provider, max: 1 })
    const first = await startWithConsent(reg, MAIN)
    expect(first.ok).toBe(true)
    const second = await startWithConsent(reg, OTHER)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.stage).toBe('session')
    expect(second.code).toBe('capacity')
    expect(second.evidence.used).toBe(1)
    expect(second.evidence.limit).toBe(1)
    expect(started).toHaveLength(1)
    expect(reg.virtualGuiCount()).toBe(1)
  })

  it('stop disposes the provider and is idempotent', async () => {
    const { provider, stopped } = fakeProvider()
    const reg = makeRegistry({ provider })
    const started = await startWithConsent(reg)
    if (!started.ok) throw new Error('start failed')
    const id = String(started.session.id)
    const stoppedOk = await reg.stop(MAIN, id)
    expect(stoppedOk).toMatchObject({ ok: true, stopped: true })
    expect(stopped).toHaveLength(1)
    expect(reg.getSession(id)).toBeNull()
    const again = await reg.stop(MAIN, id)
    expect(again).toEqual({ ok: true, stopped: false })
  })

  it('attaches another DSH session as a read-only viewer on a virtual instance', async () => {
    const { provider } = fakeProvider()
    const instances = [{ instanceId: '', ready: true }]
    const reg = makeRegistry({ provider, instances })
    const result = await startWithConsent(reg)
    if (!result.ok) throw new Error('start failed')
    instances[0].instanceId = String(result.session.instanceId)
    const other = reg.attach(OTHER)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(other.viewer).toBe(true)
    expect(other.session.is_mine).toBe(false)
    const owner = reg.attach(MAIN)
    expect(owner.ok).toBe(true)
    if (!owner.ok) return
    expect(owner.session.id).toBe(result.session.id)
  })
})

describe('virtual-gui limits', () => {
  it('uses the configured value by default and clamps it to 1-16', () => {
    expect(resolveVirtualGuiLimits({ configured: 6 }).limit).toBe(6)
    expect(resolveVirtualGuiLimits({}).limit).toBe(VIRTUAL_GUI_DEFAULT_MAX)
    expect(clampVirtualGuiLimit(0, 4)).toBe(4)
    expect(clampVirtualGuiLimit(99, 4)).toBe(16)
    expect(clampVirtualGuiLimit('3', 4)).toBe(3)
  })

  it('honours the environment override', () => {
    expect(
      resolveVirtualGuiLimits({ configured: 4, env: { DSH_BLENDER_VIRTUAL_GUI_MAX: '8' } }).limit,
    ).toBe(8)
    expect(
      resolveVirtualGuiLimits({ configured: 4, env: { DSH_BLENDER_VIRTUAL_GUI_MAX: 'nope' } })
        .limit,
    ).toBe(4)
  })

  it('caps the limit at two under memory pressure', () => {
    const low = resolveVirtualGuiLimits({
      configured: 6,
      totalMemBytes: 8 * 1024 ** 3,
      freeMemBytes: 2 * 1024 ** 3,
    })
    expect(low.limit).toBe(2)
    expect(low.low_resource).toBe(true)
    expect(low.reason).toBe('low_memory')
    const normal = resolveVirtualGuiLimits({
      configured: 6,
      totalMemBytes: 64 * 1024 ** 3,
      freeMemBytes: 32 * 1024 ** 3,
    })
    expect(normal.limit).toBe(6)
    expect(normal.low_resource).toBe(false)
  })
})

/**
 * S-4: a ready user-gui is only in the way of the caller that already owns it.
 *
 * The gate used to ask "can I read this session" (readableBy = same host), so any
 * same-host DSH session — and the main agent's own subagent — was answered
 * session_already_available while a user-gui was attached. Visibility is not
 * occupancy: only ownership (ownerMatches) may refuse a start.
 */
describe('S-4 user-gui no longer blocks a same-host virtual-gui', () => {
  const CHILD = {
    hostId: 'h',
    dshSessionId: 's-child',
    agentId: 'a-child',
    parentAgentId: 'a',
    role: 'subagent' as const,
  }

  function withUserGui() {
    const instances = [{ instanceId: 'inst-1', ready: true }]
    const { provider, started } = fakeProvider()
    const reg = makeRegistry({ provider, instances })
    const attached = reg.attach(MAIN)
    expect(attached.ok).toBe(true)
    const record = reg.getSession('user-gui:inst-1')
    if (!record) throw new Error('the user-gui record was not created')
    return { reg, instances, started, record }
  }

  it('lets another same-host DSH session start while the main holds a user-gui', async () => {
    const { reg, instances } = withUserGui()
    const started = await startWithConsent(reg, OTHER)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.session.kind).toBe('virtual-gui')
    expect((started.session.owner as Record<string, unknown>).agentId).toBe('a2')
    // Borrowing is not taking over: the user-gui keeps its owner.
    expect(reg.getSession('user-gui:inst-1')?.owner?.agentId).toBe('a')
    instances.push({ instanceId: String(started.session.instanceId), ready: true })
    const borrowed = reg.listFor(OTHER).find((row) => row.id === 'user-gui:inst-1')
    expect(borrowed).toBeTruthy()
    expect(borrowed?.is_mine).toBe(false)
  })

  it('lets a subagent of the owner start without taking the user-gui', async () => {
    const { reg } = withUserGui()
    const started = await startWithConsent(reg, CHILD)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.session.kind).toBe('virtual-gui')
    expect(reg.getSession('user-gui:inst-1')?.owner?.agentId).toBe('a')
    expect(reg.getSession(String(started.session.id))?.owner?.agentId).toBe('a-child')
  })

  it('still refuses a second window for the caller that already owns the user-gui', async () => {
    const { reg, started } = withUserGui()
    const consent = reg.issueConsent(MAIN)
    if (!consent.ok) throw new Error('consent failed')
    const refused = await reg.start(MAIN, { consentToken: consent.consentToken })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('session_already_available')
    expect(refused.evidence.is_mine).toBe(true)
    expect(refused.evidence.sessionId).toBe('user-gui:inst-1')
    // S-2: the refusal hands over at least two mechanically executable steps.
    const options = refused.evidence.fix_options as string[]
    expect(Array.isArray(options)).toBe(true)
    expect(options.length).toBeGreaterThanOrEqual(2)
    expect(options.join(' ')).toContain('action=attach')
    expect(options.join(' ')).toContain('action=release')
    expect(String(refused.fix)).toContain('1)')
    expect(String(refused.fix)).toContain('2)')
    // A second window was never spawned.
    expect(started).toHaveLength(0)
  })

  it('classifies mine / others / unowned, and only mine blocks', () => {
    const { record } = withUserGui()
    expect(userGuiClaim(record, MAIN)).toBe('mine')
    expect(userGuiClaim(record, OTHER)).toBe('others')
    expect(userGuiClaim({ ...record, owner: null }, MAIN)).toBe('unowned')
  })

  it('passes existing_user_gui through the start receipt when policy=allow (S-4b)', async () => {
    const { reg } = withUserGui()
    const previous = process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
    // allow = pre-approved: the start succeeds without a token, so the receipt is
    // the only place the caller can learn that someone else's window exists.
    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'allow'
    try {
      const started = await reg.start(OTHER, {})
      expect(started.ok).toBe(true)
      if (!started.ok) return
      expect(started.session.consent_source).toBe('policy:allow')
      const note = started.session.existing_user_gui as Record<string, unknown>
      expect(note.claim).toBe('others')
      expect(note.blocking).toBe(false)
      expect(note.owner_agent).toBe('a')
      expect((note.options as string[]).length).toBeGreaterThanOrEqual(2)
      // The user-gui keeps its owner; the new window is the caller's own.
      expect(reg.getSession('user-gui:inst-1')?.owner?.agentId).toBe('a')
    } finally {
      if (previous === undefined) delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
      else process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = previous
    }
  })

  it('omits existing_user_gui when no user-gui was in the way (S-4b)', async () => {
    const list = [{ instanceId: 'inst-1', ready: true }]
    const { provider } = fakeProvider()
    const reg = makeRegistry({ provider, instances: list })
    const previous = process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
    process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = 'allow'
    try {
      const started = await reg.start(MAIN, {})
      expect(started.ok).toBe(true)
      if (!started.ok) return
      expect(started.session.existing_user_gui).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT
      else process.env.DSH_BLENDER_VIRTUAL_GUI_CONSENT = previous
    }
  })

  it('carries the non-blocking wording for others / unowned instead of refusing', async () => {
    const { record } = withUserGui()
    expect(record.owner?.agentId).toBe('a')
    const others = await startVirtualGuiGate({
      caller: OTHER,
      capability: readyCap(),
      existing: record,
      waitMs: 0,
    })
    expect(others.ok).toBe(false)
    if (others.ok) return
    expect(others.code).not.toBe('session_already_available')
    const note = others.evidence.existing_user_gui as Record<string, unknown>
    expect(note.claim).toBe('others')
    expect(note.blocking).toBe(false)
    expect(note.read_only).toBe(true)
    expect(note.owner_agent).toBe('a')
    expect((note.options as string[]).length).toBeGreaterThanOrEqual(2)
    expect(String(note.note)).toContain('does not block')

    const unowned = await startVirtualGuiGate({
      caller: OTHER,
      capability: readyCap(),
      existing: { ...record, owner: null },
      waitMs: 0,
    })
    expect(unowned.ok).toBe(false)
    if (unowned.ok) return
    const free = unowned.evidence.existing_user_gui as Record<string, unknown>
    expect(free.claim).toBe('unowned')
    expect(free.blocking).toBe(false)
    expect((free.options as string[]).length).toBeGreaterThanOrEqual(2)
  })
})
