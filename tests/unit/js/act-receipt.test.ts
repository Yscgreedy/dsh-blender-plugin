import { describe, expect, it } from 'vitest'
import { createActApi } from '../../../runtime/core/engine-api/act.js'

function apiWith(marker: Record<string, unknown>, err = false) {
  const line = (err ? 'DSH_ACT_ERR ' : 'DSH_ACT_OK ') + JSON.stringify(marker)
  const api = createActApi({
    addon: { send: async () => ({ result: 'noise\n' + line + '\n' }) },
  } as never)
  return api.act('print(1)')
}

const base = {
  stdout: '',
  stderr: '',
  epoch: { objects: 1 },
}

describe('blender_py receipt truth (feedback 4)', () => {
  it('downgrades CANCELLED to ok:false with the numbers', async () => {
    const r = await apiWith({
      ...base,
      changed: true,
      faces_before: 6,
      faces_after: 6,
      faces_delta: 0,
      diagnostics: { cancelled_ops: 1, no_effect: false, has_ops: true },
    })
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('cancelled')
    expect(String(r.error)).toContain('CANCELLED')
    expect(r.facesDelta).toBe(0)
  })

  it('downgrades FINISHED-with-no-change to ok:false (empty selection ops)', async () => {
    const r = await apiWith({
      ...base,
      changed: false,
      faces_delta: 0,
      diagnostics: { cancelled_ops: 0, no_effect: true, has_ops: true },
    })
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('no_effect')
    expect(r.changed).toBe(false)
  })

  it('keeps a non-scene ops call (bake/bind/select) ok:true with a no_scene_change note', async () => {
    const r = await apiWith({
      ...base,
      changed: false,
      faces_delta: 0,
      diagnostics: {
        cancelled_ops: 0,
        no_effect: false,
        no_scene_change: true,
        has_ops: true,
        mutating_ops: false,
      },
    })
    expect(r.ok).toBe(true)
    expect(r.errorKind).toBeNull()
    expect(r.noSceneChange).toBe(true)
    expect(r.changed).toBe(false)
  })

  it('reports no_scene_change for a pure read script too (has_ops distinguishes it)', async () => {
    const r = await apiWith({
      ...base,
      changed: false,
      faces_delta: 0,
      diagnostics: { cancelled_ops: 0, no_effect: false, has_ops: false, no_scene_change: true },
    })
    expect(r.ok).toBe(true)
    expect(r.noSceneChange).toBe(true)
    expect(r.hasOps).toBe(false)
  })

  it('keeps a real geometry change ok:true with faces_delta', async () => {
    const r = await apiWith({
      ...base,
      changed: true,
      faces_before: 6,
      faces_after: 54,
      faces_delta: 48,
      diagnostics: { cancelled_ops: 0, no_effect: false, has_ops: true },
    })
    expect(r.ok).toBe(true)
    expect(r.facesDelta).toBe(48)
    expect(r.errorKind).toBeNull()
  })

  it('fails a scope violation and reports what was rolled back', async () => {
    const r = await apiWith({
      ...base,
      changed: true,
      faces_delta: 0,
      diagnostics: {
        cancelled_ops: 0,
        no_effect: false,
        scope_violations: ['_outside'],
        rolled_back: ['_outside'],
        unrolled: [],
        purged_meshes: ['_outside_mesh'],
        purged_materials: [],
        rollback_complete: true,
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('scope_violation')
    expect(String(r.error)).toContain('_outside')
    expect(String(r.error)).toContain('已回滚')
    expect(r.scopeViolations).toEqual(['_outside'])
    expect(r.rolledBack).toEqual(['_outside'])
    expect(r.purgedMeshes).toEqual(['_outside_mesh'])
  })

  it('keeps an execution error as ok:false / execution', async () => {
    const r = await apiWith({ ...base, error: 'RuntimeError: boom', traceback: 'tb' }, true)
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('execution')
    expect(String(r.error)).toContain('boom')
  })

  it('C-6/C-7/C-16: carries the cross-call fingerprint, mine/other split and artifacts', async () => {
    const r = await apiWith({
      ...base,
      changed: true,
      state_before: 'aaaabbbbcccc',
      state_after: 'ddddeeeeffff',
      faces_before: 6,
      faces_after: 10,
      faces_delta: 4,
      artifacts: [{ kind: 'blend', path: 'C:/tmp/x.blend', bytes: 2048 }],
      diagnostics: {
        cancelled_ops: 0,
        no_effect: false,
        has_ops: true,
        changed_objects_mine: ['Cube'],
        changed_objects_other: ['_outside'],
      },
    })
    expect(r.sceneBefore).toBe('aaaabbbbcccc')
    expect(r.sceneAfter).toBe('ddddeeeeffff')
    expect(r.changedObjectsMine).toEqual(['Cube'])
    expect(r.changedObjectsOther).toEqual(['_outside'])
    expect((r.artifacts as Record<string, unknown>[])[0]).toMatchObject({ kind: 'blend' })
  })

  it('flags a failed unwrap even when the operator returned FINISHED', async () => {
    const r = await apiWith({
      ...base,
      changed: true,
      faces_delta: 0,
      diagnostics: {
        cancelled_ops: 0,
        no_effect: false,
        uv_failed: true,
        has_ops: true,
        warnings: ['Warning: Unwrap failed to solve 1 of 1 island(s)'],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('uv_failed')
    expect((r.warnings as string[])[0]).toContain('Unwrap failed')
  })
})
