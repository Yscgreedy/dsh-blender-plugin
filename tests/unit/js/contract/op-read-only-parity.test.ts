import { describe, expect, it } from 'vitest'
import { READ_ONLY, READ_ONLY_OPS } from '../../../../src/tools/op/read-only'
import { PLAN_READ_ONLY_OPS } from '../../../../runtime/catalog/index'

// The host copy must never drift from the catalog: /plan skips the lease gate
// for these ops, and blender_op makes the same decision before asking for a
// session. A catalog-only op would be advertised as read-only and then rejected
// with session_required (2026-11-27: six ops were in exactly that state).
describe('read-only op parity (host copy <-> catalog)', () => {
  it('host list equals the catalog source of truth', () => {
    expect([...READ_ONLY_OPS].sort()).toEqual([...PLAN_READ_ONLY_OPS].sort())
  })

  it('has no duplicates and the Set covers every entry', () => {
    expect(new Set(READ_ONLY_OPS).size).toBe(READ_ONLY_OPS.length)
    for (const op of READ_ONLY_OPS) expect(READ_ONLY.has(op)).toBe(true)
  })

  it('keeps the six ops that used to be catalog-only', () => {
    const onceMissing = [
      'fingerprint',
      'asset_search',
      'asset_help',
      'anim_rig_report',
      'anim_deform_audit',
      'toon_outline_audit',
    ]
    for (const op of onceMissing) expect(READ_ONLY.has(op)).toBe(true)
  })
})
