import { describe, expect, it } from 'vitest'
import { ACT_WRAPPER } from '../../../runtime/embedded/act-wrapper.js'

/**
 * 包装层的回执契约（C-6 / C-7 / C-16 / C-11）。
 *
 * 这一层是**生成的 Python**：真正的行为由 Blender 侧 E2E 覆盖，这里钉住"生成结果里
 * 必须出现的字段/函数"，避免一次重构把某个 marker 静默删掉（生成的脚本另外跑 py_compile）。
 */
describe('act wrapper contract', () => {
  const code = ACT_WRAPPER('print(1)')

  it('回执带跨调用指纹（state_before / state_after）', () => {
    expect(code).toContain('def _dsh_report():')
    expect(code).toContain('"state_before": _dsh_delta.get("state_before")')
    expect(code).toContain('"state_after": _dsh_delta.get("state_after")')
  })

  it('变更归属分桶：mine / other，且 owner 全算 mine', () => {
    expect(code).toContain('_exclusive = (not _scope) or any(')
    expect(code).toContain('"changed_objects_mine": _mine[:50]')
    expect(code).toContain('"changed_objects_other": _outside[:50]')
  })

  it('产物（.blend / Render Result）单独上报，不当成场景变更', () => {
    expect(code).toContain('def _dsh_artifacts():')
    expect(code).toContain('"artifacts": _dsh_artifacts()')
    expect(code).toContain('_b.data.images.get("Render Result")')
  })

  it('异常通道仍回传 stdout/stderr/traceback（C-11 的底座）', () => {
    expect(code).toContain('except BaseException as _dsh_exc:')
    expect(code).toContain('"traceback": _dsh_tb.format_exc()[-6000:]')
    expect(code).toContain('"stdout": _dsh_o.getvalue()[-16000:]')
  })
})
