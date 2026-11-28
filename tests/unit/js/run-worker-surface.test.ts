import { describe, expect, it } from 'vitest'
import { executeWorker, workerSeeFitLines } from '../../../src/tools/run/worker.js'

describe('blender_run worker surface', () => {
  it('returns a worker-level help table without touching the backend', async () => {
    const out: any = await executeWorker({}, 0, { op: 'help' })
    expect(out.text).toContain('checkpoint / revert / checkpoints')
    expect(out.text).toContain('see / watch 的 spec 字段')
    expect(out.text).toContain('worker_file_mismatch')
  })

  it('lists fit / fit_margin in the see/watch spec surface', async () => {
    const out: any = await executeWorker({}, 0, { op: 'help' })
    // 字段名进 spec 行：模型面要能从 help 直接发现 T-4 的自动取景。
    expect(out.text).toContain('fit,fit_margin')
    expect(out.text).toContain('fit：object | scene | <对象名>')
    // 语义 bullet：显式机位优先 + 失败仍出图但带 note/错误。
    expect(out.text).toContain('显式 from/look_at 优先')
    expect(out.text).toContain('note + fit.error')
  })

  it('renders fit applied fields and the note in the see receipt text', () => {
    // 真机反馈：图对了，但工具文本只有尺寸/coverage，模型判断不了 fit 是否生效。
    expect(
      workerSeeFitLines({
        fit: {
          kind: 'object',
          applied: ['from', 'look_at'],
          bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        },
      }),
    ).toEqual(['fit=object · applied=from,look_at'])
    const failed = workerSeeFitLines({
      fit: { kind: 'NOPE', applied: [], error: 'ValueError: bpy.data.objects 里没有 NOPE' },
      note: 'fit=NOPE 未生效（ValueError）；已退回默认机位',
    })
    expect(failed[0]).toBe('fit=NOPE · fit.error=ValueError: bpy.data.objects 里没有 NOPE')
    expect(failed[1]).toBe('note: fit=NOPE 未生效（ValueError）；已退回默认机位')
    // 显式 from/look_at 盖住 fit 时 applied 为空，仍要说明 fit 没改动任何字段。
    expect(workerSeeFitLines({ fit: { kind: 'scene', applied: [] } })).toEqual([
      'fit=scene · applied=-',
    ])
  })

  it('adds no extra line when the response carries no fit or note', () => {
    expect(workerSeeFitLines({ width: 560, height: 315, coverage_estimate: 0.42 })).toEqual([])
    expect(workerSeeFitLines({})).toEqual([])
    expect(workerSeeFitLines({ note: 'watch: fit 未生效' })).toEqual(['note: watch: fit 未生效'])
  })

  it('rejects script= for worker exec and names the code field', async () => {
    const out: any = await executeWorker({}, 0, { op: 'exec', script: 'print(1)' })
    expect(out.envelope.error.code).toBe('invalid_params')
    expect(out.text).toContain('需要 code')
    expect(out.envelope.error.next_action).toContain('script')
  })
})
