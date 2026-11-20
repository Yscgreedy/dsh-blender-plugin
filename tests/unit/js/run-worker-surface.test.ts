import { describe, expect, it } from 'vitest'
import { executeWorker } from '../../../src/tools/run/worker.js'

describe('blender_run worker surface', () => {
  it('returns a worker-level help table without touching the backend', async () => {
    const out: any = await executeWorker({}, 0, { op: 'help' })
    expect(out.text).toContain('checkpoint / revert / checkpoints')
    expect(out.text).toContain('see / watch 的 spec 字段')
    expect(out.text).toContain('worker_file_mismatch')
  })

  it('rejects script= for worker exec and names the code field', async () => {
    const out: any = await executeWorker({}, 0, { op: 'exec', script: 'print(1)' })
    expect(out.envelope.error.code).toBe('invalid_params')
    expect(out.text).toContain('需要 code')
    expect(out.envelope.error.next_action).toContain('script')
  })
})
