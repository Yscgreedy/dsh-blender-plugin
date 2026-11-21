import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { catalogPayload, planOpNames } from '../../../../runtime/engine.js'
import { pkgPath } from '../../../helpers/pkg'

const lock = JSON.parse(
  fs.readFileSync(pkgPath('tests', 'fixtures', 'capability.lock.json'), 'utf8'),
)

describe('catalog contract', () => {
  const payload = catalogPayload({ full: true }) as any

  it('reports the frozen catalog surface', () => {
    expect(payload.ok).toBe(true)
    expect(payload.families).toHaveLength(lock.families_count)
    expect(payload.ops_count).toBe(lock.ops_count)
    expect(planOpNames()).toHaveLength(lock.ops_count)
    expect(payload.detail).toHaveLength(lock.families_count)
    expect(payload.detail.reduce((n: number, f: any) => n + f.ops.length, 0)).toBe(lock.ops_count)
  })

  it('keeps per-family op counts identical to the capability lock', () => {
    const actual = new Map(payload.detail.map((f: any) => [f.family, f.ops.length]))
    for (const f of lock.families) expect(actual.get(f.f), f.f).toBe(f.ops)
    expect([...actual.keys()].sort()).toEqual(lock.families.map((f: any) => f.f).sort())
  })

  it('exposes family and tool detail views', () => {
    const family = catalogPayload({ family: 'surface' })
    expect(family.ok).toBe(true)
    expect(family.text).toContain('fit')
    expect(family.text).toContain('M3')
    const tool = catalogPayload({ tool: 'op' })
    expect(tool.ok).toBe(true)
    expect(typeof tool.text).toBe('string')
    expect(tool.text).toContain('blender_op')
    expect(catalogPayload({ family: '__nope__' }).ok).toBe(false)
  })

  it('exposes machine-readable needs_gui / headless flags (format=json)', () => {
    const structured = catalogPayload({ format: 'json' }) as any
    expect(structured.ok).toBe(true)
    expect(structured.format).toBe('json')
    expect(structured.families).toHaveLength(lock.families_count)
    expect(structured.ops_count).toBe(lock.ops_count)
    const rows = new Map<string, any>()
    let count = 0
    for (const f of structured.families)
      for (const o of f.ops) {
        count++
        rows.set(o.name, o)
      }
    expect(count).toBe(lock.ops_count)
    expect(rows.get('audit_mesh')).toMatchObject({
      needs_gui: false,
      headless: true,
      read_only: true,
    })
    expect(rows.get('shapesolve_solve')).toMatchObject({ needs_gui: true, headless: false })
    expect(rows.get('audit_scene')).toMatchObject({ needs_gui: false, read_only: true })
    expect(rows.get('img_digest')).toMatchObject({ needs_gui: false, headless: true })
    expect(rows.get('gui_frame')).toMatchObject({ needs_gui: true, read_only: true })
    expect((catalogPayload({ format: 'yaml' }) as any).ok).toBe(false)
  })

  it('rejects duplicate family members', () => {
    const names = payload.families
    expect(new Set(names).size).toBe(names.length)
    for (const f of payload.detail) expect(new Set(f.ops).size).toBe(f.ops.length)
  })
})
