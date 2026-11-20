/**
 * 工单 7：worker digest 的**结构化字段**与"永不自动回滚"锁。
 *
 * 判据（工单 6/工单 7）：
 *   · exec digest=true → digest_before / digest_after / changed / digest_scope /
 *     restore_applied / kit_source / elapsed_ms 全在信封 evidence 里；
 *   · auto_restore 恒 false（改了就是改了），changed 只看内容哈希（before !== after）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  digestBaselineEvidence,
  digestEvidence,
  executeWorker,
} from '../../../src/tools/run/worker.js'
import { pkgPath } from '../../helpers/pkg'

describe('工单 7 worker digest evidence', () => {
  it('computes changed by content hash and never auto-restores', () => {
    const same = digestEvidence(
      {
        digest_before: 'aaaaaaaaaaaa',
        digest_after: 'aaaaaaaaaaaa',
        digest_scope: ['objects', 'mesh'],
        kit_source: 'boot',
        elapsed_ms: 42,
        auto_restore: true,
        restore_applied: true,
      },
      { session: 'probe-p7', file: 'D:/a.blend' },
    )
    expect(same.changed).toBe(false)
    expect(same.auto_restore).toBe(false)
    expect(same.restore_applied).toBe(false)
    expect(same.digest_scope).toEqual(['objects', 'mesh'])
    expect(same.elapsed_ms).toBe(42)
    expect(same.worker).toEqual({ session: 'probe-p7', file: 'D:/a.blend' })

    const diff = digestEvidence({ digest_before: 'aaaaaaaaaaaa', digest_after: 'bbbbbbbbbbbb' })
    expect(diff.changed).toBe(true)
    expect(diff.auto_restore).toBe(false)
  })

  it('keeps the exact field set required by the work order', () => {
    const ev = digestEvidence({ digest_before: 'a', digest_after: 'b', kit_source: 'bootstrap' })
    expect(Object.keys(ev).sort()).toEqual(
      [
        'auto_restore',
        'changed',
        'digest_after',
        'digest_before',
        'digest_scope',
        'elapsed_ms',
        'kit_source',
        'restore_applied',
        'worker',
      ].sort(),
    )
    expect(ev.kit_source).toBe('bootstrap')
  })

  it('locks auto_restore=false on the digest baseline too', () => {
    const ev = digestBaselineEvidence({
      digest: 'cccccccccccc',
      digest_scope: 'scene',
      kit_source: 'boot',
    })
    expect(ev.digest).toBe('cccccccccccc')
    expect(ev.auto_restore).toBe(false)
    expect(ev.restore_applied).toBe(false)
  })

  it('documents digest in help and schema (op + digest param)', async () => {
    const out = (await executeWorker({}, 0, { op: 'help' })) as { text: string }
    expect(out.text).toContain('op             exec | digest')
    expect(out.text).toContain('exec.digest=true')
    expect(out.text).toContain('auto_restore / restore_applied 恒 false')
    expect(out.text).toContain('digest_before: string')
    expect(out.text).toContain('"digest_before":{"type":"string"}')
    const schema = fs.readFileSync(pkgPath('src', 'tools', 'run', 'index.ts'), 'utf8')
    expect(schema).toContain('exec | digest | see')
    expect(schema).toContain('auto_restore=false')
  })
})
