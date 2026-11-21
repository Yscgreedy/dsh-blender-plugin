import { describe, expect, it } from 'vitest'
import {
  headlessDevicePrelude,
  parseRenderDeviceMarker,
} from '../../../runtime/execution/render-device.js'

/**
 * C-9：headless 的设备前导与回执解析。
 *
 * 现场：queue 的 headless 分支完全不初始化 Cycles 设备，--factory-startup 下
 * compute_device_type=NONE，脚本自己切 Cycles 也只绑 CPU（42.7–45.5 s/帧 vs 12.2–14.8）。
 */
describe('headless device prelude (C-9)', () => {
  it('默认 device=auto，并打印 DSH_RENDER 供回执解析', () => {
    const code = headlessDevicePrelude({})
    expect(code).toContain('_dsh_headless_request = {')
    expect(code).toContain('"device": "auto"')
    expect(code).toContain('_dsh_headless_device()')
    expect(code).toContain('prefs.get_devices()')
    expect(code).toContain('DSH_RENDER')
    expect(code).toContain('devices_used')
  })

  it('gpu=false → device=cpu；gpu=true → device=gpu', () => {
    expect(headlessDevicePrelude({ gpu: false })).toContain('"device": "cpu"')
    expect(headlessDevicePrelude({ gpu: 'off' })).toContain('"device": "cpu"')
    expect(headlessDevicePrelude({ gpu: true })).toContain('"device": "gpu"')
    expect(headlessDevicePrelude({ gpu: 'required' })).toContain('"device": "gpu"')
  })

  it('显式 device / compute_device_type：规范化后进请求', () => {
    const code = headlessDevicePrelude({ device: 'GPU', compute_device_type: 'optix' })
    expect(code).toContain('"device": "gpu"')
    expect(code).toContain('"compute_device_type": "OPTIX"')
    expect(headlessDevicePrelude({ device: 'sometimes' })).toContain('"device": "auto"')
    expect(headlessDevicePrelude({ compute_device_type: 'bogus' })).toContain(
      '"compute_device_type": ""',
    )
  })

  it('engine=cycles 让前导先切引擎（脚本之后直接渲染也能用上 GPU）', () => {
    const code = headlessDevicePrelude({ engine: 'cycles' })
    expect(code).toContain('"engine": "cycles"')
    expect(code).toContain('"engine_requested": True')
    expect(code).toContain('sc.render.engine = "CYCLES"')
    const eevee = headlessDevicePrelude({ engine: 'eevee' })
    expect(eevee).toContain('"engine": "eevee"')
    expect(eevee).toContain('engine_eevee_headless')
    expect(headlessDevicePrelude({})).toContain('"engine_requested": False')
  })

  it('parseRenderDeviceMarker：取最后一条合法回执，坏行返回 null', () => {
    const stdout = [
      'noise',
      'DSH_RENDER {"devices_used": ["RTX 4060"], "compute_device_type": "OPTIX"}',
      'DSH_RENDER {"devices_used": [], "fell_back_to_cpu": true}',
      'tail',
    ].join('\n')
    const parsed = parseRenderDeviceMarker(stdout)
    expect(parsed).toMatchObject({ fell_back_to_cpu: true })
    expect(Array.isArray(parsed?.devices_used)).toBe(true)
    expect(parseRenderDeviceMarker('DSH_RENDER {not json}')).toBe(null)
    expect(parseRenderDeviceMarker('nothing here')).toBe(null)
  })
})
