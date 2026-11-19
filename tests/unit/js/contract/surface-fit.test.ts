import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { catalogPayload } from '../../../../runtime/engine.js'
import { pkgPath } from '../../../helpers/pkg'

const surfaceImplDir = pkgPath('runtime', 'py', 'geometry', 'surface_impl')
const surfacePy = [
  fs.readFileSync(pkgPath('runtime', 'py', 'geometry', 'surface.py'), 'utf8'),
  ...fs
    .readdirSync(surfaceImplDir)
    .filter((name) => name.endsWith('.py'))
    .sort()
    .map((name) =>
      fs.readFileSync(pkgPath('runtime', 'py', 'geometry', 'surface_impl', name), 'utf8'),
    ),
].join('\n')
const lock = JSON.parse(
  fs.readFileSync(pkgPath('tests', 'fixtures', 'capability.lock.json'), 'utf8'),
)

describe('surface fit/offset/blend contract', () => {
  it('declares fit in the catalog and capability lock', () => {
    const family = (catalogPayload({ full: true }) as any).detail.find(
      (f: any) => f.family === 'surface',
    )
    expect(family.ops).toContain('fit')
    const locked = lock.families.find((f: any) => f.f === 'surface')
    expect(locked.ops).toBe(family.ops.length)
  })

  it('registers real handlers instead of dropping or refusing the ops', () => {
    expect(surfacePy).toContain('def surface_fit(')
    expect(surfacePy).toContain('def surface_blend(')
    expect(surfacePy).toContain('def surface_offset(')
    expect(surfacePy).toMatch(/"fit":\s*surface_fit/)
    expect(surfacePy).not.toContain('M3_NOT_IMPLEMENTED')
    expect(surfacePy).not.toContain('not implemented in pure-python')
    expect(surfacePy).not.toContain('_OCCT_MSG')
  })

  it('labels the approximations and keeps the residual in the receipt', () => {
    expect(surfacePy).toContain('sliced_ring_fit')
    expect(surfacePy).toContain('smoothstep_bridge')
    expect(surfacePy).toContain('vertex_normal')
    expect(surfacePy).toContain('residual_mm')
    expect(surfacePy).toContain('"fit": {')
    expect(surfacePy).toContain('quality": "approximate"')
  })
})
