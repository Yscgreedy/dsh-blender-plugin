import { describe, expect, it } from 'vitest'
import { executeWorker } from '../../../src/tools/run/worker.js'

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

  it('rejects script= for worker exec and names the code field', async () => {
    const out: any = await executeWorker({}, 0, { op: 'exec', script: 'print(1)' })
    expect(out.envelope.error.code).toBe('invalid_params')
    expect(out.text).toContain('需要 code')
    expect(out.envelope.error.next_action).toContain('script')
  })
})
