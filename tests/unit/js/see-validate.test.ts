import { describe, expect, it } from 'vitest'
import { validate } from '../../../src/tools/see/validate.js'

describe('blender_see validation (feedback 6)', () => {
  it('accepts camera + aspect: fixed ratio instead of the sensor ratio', () => {
    const plan = validate({ viewpoint: 'camera', aspect: '1:1', max_size: 1024 })
    expect('text' in plan).toBe(false)
    if ('text' in plan || plan.kind !== 'frame') return
    expect(plan.dims).toEqual({ aspect: '1:1', maxSize: 1024, width: 1024, height: 1024 })
  })

  it('accepts custom fit_object without from/look_at', () => {
    const plan = validate({ viewpoint: 'custom', fit: 'object' })
    expect('text' in plan).toBe(false)
    if ('text' in plan || plan.kind !== 'frame') return
    expect(plan.viewpoint).toBe('custom')
    expect(plan.fit).toBe('object')
  })

  it('still requires from/look_at when no fit is given', () => {
    const plan = validate({ viewpoint: 'custom' })
    expect('text' in plan).toBe(true)
  })

  it('treats full=true without area as the whole window (-1 marker) and keeps explicit areas', () => {
    const window = validate({ viewpoint: 'viewport', full: true })
    expect('text' in window).toBe(false)
    if ('text' in window || window.kind !== 'frame') return
    expect(window.area).toBeUndefined()
    const area = validate({ viewpoint: 'viewport', full: true, area: 2 })
    if ('text' in area || area.kind !== 'frame') return
    expect(area.area).toBe(2)
  })

  it('passes clip_start through for custom and camera', () => {
    const custom = validate({
      viewpoint: 'custom',
      from: '1,-1,1',
      look_at: '0,0,0',
      clip_start: 0.001,
    })
    if ('text' in custom || custom.kind !== 'frame') return
    expect(custom.clipStart).toBe(0.001)
    const camera = validate({ viewpoint: 'camera', clip_start: 0.002 })
    if ('text' in camera || camera.kind !== 'frame') return
    expect(camera.clipStart).toBe(0.002)
  })

  it('rejects fit on viewport (custom-only)', () => {
    const plan = validate({ viewpoint: 'viewport', fit: 'object' })
    expect('text' in plan).toBe(true)
  })
})
