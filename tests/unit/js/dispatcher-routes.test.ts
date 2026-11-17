import { describe, expect, it, vi } from 'vitest'
import { createPlanCallInner, type PlanCallDeps } from '../../../runtime/core/dispatcher/index.js'
import {
  prepareEvidencePayload,
  routeMainPlanOps,
} from '../../../runtime/core/dispatcher/plan-call.js'
import { routeExtRouting } from '../../../runtime/core/dispatcher/ext-routing.js'

const ensureNames = [
  'ensureAssembly',
  'ensureAudit',
  'ensureBlockout',
  'ensureCalib',
  'ensureClearance',
  'ensureContract',
  'ensureDeliver',
  'ensureEvalharness',
  'ensureFace',
  'ensureFix',
  'ensureGate',
  'ensureGenerator',
  'ensureGeo',
  'ensureHuman',
  'ensureImg',
  'ensureMaterial',
  'ensureMontage',
  'ensureMotion',
  'ensurePipeline',
  'ensurePlanner',
  'ensurePrint',
  'ensureQc',
  'ensureQcRender',
  'ensureSculpt',
  'ensureShape',
  'ensureShapesolve',
  'ensureSurface',
  'ensureSweep',
  'ensureUv',
  'ensureVehicle',
  'ensureView',
  'ensureVisualReport',
] as const

function makeDeps() {
  const sends: Array<{ op: unknown; payload: unknown; timeout: unknown }> = []
  const send = vi.fn(async (op: unknown, payload: unknown, timeout: unknown) => {
    sends.push({ op, payload, timeout })
    return { result: 'LOOP {"ok":true}' }
  })
  const ensures = Object.fromEntries(
    ensureNames.map((name) => [name, vi.fn(async () => undefined)]),
  ) as Record<(typeof ensureNames)[number], ReturnType<typeof vi.fn>>
  const deps = {
    SESSION_NAME: 'unit-test',
    addon: { send } as unknown as PlanCallDeps['addon'],
    ...ensures,
    jobStart: vi.fn(() => ({ id: 'j1' })),
    readModuleSource: vi.fn(() => ''),
    preloadChunk: vi.fn((name: string) => '# preload ' + name),
  } as unknown as PlanCallDeps
  return { deps, send, sends, ensures }
}

describe('dispatcher regression guards', () => {
  it('routes montage through the direct montage API, not generic dispatch', async () => {
    const { deps, sends, ensures } = makeDeps()
    const decision = await routeMainPlanOps(deps, 'montage_create', { label: 'x' })
    expect(decision.matched).toBe(true)
    await (decision as { result: Promise<unknown> }).result
    expect(ensures.ensureMontage).toHaveBeenCalledTimes(1)
    expect(sends).toHaveLength(1)
    const code = String((sends[0].payload as Record<string, unknown>).code)
    expect(code).toContain('A = K.dsh_montage_api')
    expect(code).toContain('A[N](**P)')
    expect(code).not.toContain('K.dsh_montage_api["dispatch"]')
  })

  // P1-7 回归：montage()/montage_help() 返回的是 **dict**，而旧的
  // `print("LOOP " + K.dsh_montage_api["montage"](...))` 直接把它和 str 相加 ⇒
  // TypeError: can only concatenate str (not "dict") to str（整族必死）。判据：生成代码必须 dumps。
  it('dumps the montage result instead of concatenating the dict into "LOOP "', async () => {
    const { deps, sends } = makeDeps()
    const decision = await routeMainPlanOps(deps, 'montage', { paths: ['a.png'] })
    await (decision as { result: Promise<unknown> }).result
    const code = String((sends[0].payload as Record<string, unknown>).code)
    expect(code).toContain('_json.dumps(R, ensure_ascii=False, default=str)')
    expect(code).not.toMatch(/print\("LOOP " \+ K\./)
    expect(code).toContain('N = "montage"')
  })

  it('routes montage_help to the help entry (strip only the first montage_ prefix)', async () => {
    const { deps, sends } = makeDeps()
    const decision = await routeMainPlanOps(deps, 'montage_help', {})
    await (decision as { result: Promise<unknown> }).result
    const code = String((sends[0].payload as Record<string, unknown>).code)
    expect(code).toContain('N = "help"')
  })

  it('routes geo_* to dsh_geo_api with the geo_ prefix stripped', async () => {
    const { deps, sends, ensures } = makeDeps()
    // geo_* 走 EXT_ROUTES（ext-geo，routing.json hostSideFamilies）—— 不是 MAIN 表
    const decision = await routeExtRouting(deps, 'geo_box', {
      name: 'B',
      xr: [-60, 60],
      yr: [-60, 60],
      zr: [0, 40],
    })
    await (decision as { result: Promise<unknown> }).result
    expect(ensures.ensureGeo).toHaveBeenCalledTimes(1)
    const code = String((sends[0].payload as Record<string, unknown>).code)
    expect(code).toContain('dsh_geo_api["dispatch"]("box"')
  })

  it('ensures view before preparing the evidence payload', async () => {
    const { deps, ensures } = makeDeps()
    const prepared = (await prepareEvidencePayload(deps, 'evidence', {})) as Record<string, unknown>
    expect(ensures.ensureView).toHaveBeenCalledTimes(1)
    expect((prepared.view as Record<string, unknown>).path).toContain('dsh_evidence_unit-test')
  })

  it('ensures view before the evidence contract route sends code', async () => {
    const { deps, ensures, sends } = makeDeps()
    const out = await createPlanCallInner(deps).planCallInner('evidence', {})
    expect(ensures.ensureView).toHaveBeenCalledTimes(1)
    expect(sends).toHaveLength(1)
    const code = String((sends[0].payload as Record<string, unknown>).code)
    expect(code).toContain('dsh_contract_api["dispatch"]')
    expect(out).toMatchObject({ ok: true })
  })

  it('preloads qc modules for the asJob qc_render path', async () => {
    const { deps } = makeDeps()
    const decision = await routeMainPlanOps(deps, 'qc_render_views', { asJob: true })
    await (decision as { result: Promise<unknown> }).result
    const preloadChunk = deps.preloadChunk as unknown as ReturnType<typeof vi.fn>
    expect(preloadChunk.mock.calls.map((call) => call[0])).toEqual(['qc', 'qc_render'])
    const jobStart = deps.jobStart as unknown as ReturnType<typeof vi.fn>
    const opts = jobStart.mock.calls[0]?.[0] as Record<string, unknown>
    expect(String(opts.script)).toContain('# preload qc')
    expect(String(opts.script)).toContain('# preload qc_render')
  })
})
