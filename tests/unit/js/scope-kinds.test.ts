/**
 * Scope vocabulary: `aspect:` and `frames:` (task-5).
 *
 * 建模（prefix）+ 打光/机位（aspect）+ 动画（frames）必须能并行写入，而不是都退回
 * exclusive。本文件钉住两件事：
 *  1) 新 kind 的解析（含坏输入 → null）与 overlap / covers / coversObject 语义；
 *  2) 既有 grants 冲突判决不变 —— 新 kind 只在同名/区间相交时才是冲突，
 *     exclusive 仍然与一切重叠。
 *
 * 不变式：aspect/frames 是**静态 op 的声明式写作用域**；写后对象校验
 * （scopeCoversObject）对它们一律返回 false，py 必须声明 object/collection/prefix。
 *
 * task-8 收口：human-edits 不再按对象名把 aspect/frames 当 prefix 比对；py 声明这两个
 * kind 直接 fail-closed（invalid_params），静态 op 照旧放行。
 */
import { describe, expect, it } from 'vitest'
import {
  anyOverlap,
  parseScope,
  parseScopes,
  scopeCovers,
  scopeCoversObject,
  scopesCover,
  scopesOverlap,
} from '../../../runtime/core/sessions/scopes.js'
import {
  clearHumanEdits,
  conflictingHumanEdits,
  recordHumanEdits,
} from '../../../runtime/core/sessions/human-edits.js'
import { SessionRegistry } from '../../../runtime/core/sessions/registry.js'
import type {
  CallerIdentity,
  InstanceRef,
  SessionRecord,
} from '../../../runtime/core/sessions/types.js'

const aspect = (value: string) => ({ kind: 'aspect' as const, value })
const frames = (value: string) => ({ kind: 'frames' as const, value })

describe('parseScope / parseScopes: aspect and frames', () => {
  it('parses the four documented aspect presets', () => {
    for (const value of ['world', 'render', 'camera', 'lights']) {
      expect(parseScope('aspect:' + value)).toEqual({ kind: 'aspect', value })
    }
  })

  it('parses any other non-empty aspect value (only the same name overlaps)', () => {
    expect(parseScope('aspect:  background  ')).toEqual({ kind: 'aspect', value: 'background' })
    expect(parseScope('aspect:World')).toEqual({ kind: 'aspect', value: 'World' })
    // case-sensitive, like collection/object values
    expect(parseScope('aspect:World')).not.toEqual(parseScope('aspect:world'))
  })

  it('rejects an aspect with no value', () => {
    expect(parseScope('aspect:')).toBeNull()
    expect(parseScope('aspect:   ')).toBeNull()
    expect(parseScope({ kind: 'aspect' })).toBeNull()
    expect(parseScope({ kind: 'aspect', value: '  ' })).toBeNull()
  })

  it('parses a frames range and normalizes both bounds', () => {
    expect(parseScope('frames:1-10')).toEqual({ kind: 'frames', value: '1-10' })
    expect(parseScope('frames: 1 - 10 ')).toEqual({ kind: 'frames', value: '1-10' })
    expect(parseScope('frames:007-010')).toEqual({ kind: 'frames', value: '7-10' })
    expect(parseScope('frames:5-5')).toEqual({ kind: 'frames', value: '5-5' })
    expect(parseScope({ kind: 'frames', value: '1-48' })).toEqual({ kind: 'frames', value: '1-48' })
    expect(parseScope({ kind: 'frames', value: ' 12- 20 ' })).toEqual({
      kind: 'frames',
      value: '12-20',
    })
  })

  it('rejects every malformed frames range instead of guessing', () => {
    for (const bad of [
      'frames:',
      'frames:1',
      'frames:1-',
      'frames:-5',
      'frames:10-1', // START > END
      'frames:1.5-3',
      'frames:a-b',
      'frames:1-2-3',
      'frames:-1-5',
      'frames:1..10',
      'frames:1 - ',
    ]) {
      expect(parseScope(bad), bad).toBeNull()
    }
    expect(parseScope({ kind: 'frames' })).toBeNull()
    expect(parseScope({ kind: 'frames', value: '10-1' })).toBeNull()
    expect(parseScope({ kind: 'frames', value: 'one-two' })).toBeNull()
  })

  it('keeps the existing spellings unchanged', () => {
    expect(parseScope('exclusive')).toEqual({ kind: 'exclusive' })
    expect(parseScope('exclusive:ignored')).toEqual({ kind: 'exclusive' })
    expect(parseScope('collection:COL_Lights')).toEqual({
      kind: 'collection',
      value: 'COL_Lights',
    })
    expect(parseScope('prefix:LGT-')).toEqual({ kind: 'prefix', value: 'LGT-' })
    expect(parseScope('object:Cube')).toEqual({ kind: 'object', value: 'Cube' })
    // A bare name is still the legacy collection spelling (no new bare kinds).
    expect(parseScope('aspect')).toEqual({ kind: 'collection', value: 'aspect' })
    expect(parseScope('frames')).toEqual({ kind: 'collection', value: 'frames' })
    expect(parseScope('')).toBeNull()
    expect(parseScope(null)).toBeNull()
    // An unknown kind is still refused rather than downgraded to a collection.
    expect(parseScope('vertex:Cube')).toBeNull()
    expect(parseScope({ kind: 'vertex', value: 'Cube' })).toBeNull()
  })

  it('parses the comma-separated and JSON-array forms a type:"json" parameter arrives as', () => {
    expect(parseScopes('prefix:LGT-, aspect:lights, frames:1-48')).toEqual([
      { kind: 'prefix', value: 'LGT-' },
      { kind: 'aspect', value: 'lights' },
      { kind: 'frames', value: '1-48' },
    ])
    expect(parseScopes('["aspect:world","frames:7-12"]')).toEqual([
      { kind: 'aspect', value: 'world' },
      { kind: 'frames', value: '7-12' },
    ])
    expect(parseScopes(['object:Cube', { kind: 'frames', value: '1-48' }])).toEqual([
      { kind: 'object', value: 'Cube' },
      { kind: 'frames', value: '1-48' },
    ])
    // A bad token inside a list is dropped, the good ones survive.
    expect(parseScopes(['aspect:world', 'frames:9-3', 'frames:9-12'])).toEqual([
      { kind: 'aspect', value: 'world' },
      { kind: 'frames', value: '9-12' },
    ])
    expect(parseScopes([])).toEqual([])
    expect(parseScopes('')).toEqual([])
    expect(parseScopes(undefined)).toEqual([])
  })
})

describe('scopesOverlap: aspect and frames stay parallel unless they really collide', () => {
  it('aspect overlaps only the same aspect name', () => {
    expect(scopesOverlap(aspect('world'), aspect('world'))).toBe(true)
    expect(scopesOverlap(aspect('world'), aspect('lights'))).toBe(false)
    expect(scopesOverlap(aspect('render'), aspect('camera'))).toBe(false)
    expect(scopesOverlap(aspect('World'), aspect('world'))).toBe(false)
  })

  it('frames overlaps only where the two ranges intersect', () => {
    expect(scopesOverlap(frames('1-48'), frames('1-48'))).toBe(true)
    expect(scopesOverlap(frames('1-48'), frames('7-12'))).toBe(true) // contained
    expect(scopesOverlap(frames('1-10'), frames('10-20'))).toBe(true) // shared endpoint
    expect(scopesOverlap(frames('1-10'), frames('11-20'))).toBe(false) // adjacent, disjoint
    expect(scopesOverlap(frames('7-12'), frames('1-48'))).toBe(true) // either order
    expect(scopesOverlap(frames('40-60'), frames('1-48'))).toBe(true)
    expect(scopesOverlap(frames('49-96'), frames('1-48'))).toBe(false)
  })

  it('keeps the cross-kind rule: only an exact textual match overlaps', () => {
    // Documented existing rule; a real collision would be hidden otherwise.
    expect(scopesOverlap(aspect('world'), { kind: 'collection', value: 'world' })).toBe(true)
    expect(scopesOverlap(frames('1-10'), { kind: 'collection', value: '1-10' })).toBe(true)
    expect(scopesOverlap(aspect('world'), { kind: 'prefix', value: 'w' })).toBe(false)
    expect(scopesOverlap(frames('1-10'), { kind: 'object', value: 'Cube' })).toBe(false)
    expect(scopesOverlap(frames('1-10'), { kind: 'frames', value: '1-10' })).toBe(true)
    expect(scopesOverlap(frames('1-10'), { kind: 'aspect', value: '1-10' })).toBe(true)
  })

  it('keeps exclusive overlapping everything', () => {
    const exclusive = { kind: 'exclusive' as const }
    expect(scopesOverlap(exclusive, aspect('world'))).toBe(true)
    expect(scopesOverlap(aspect('world'), exclusive)).toBe(true)
    expect(scopesOverlap(exclusive, frames('1-48'))).toBe(true)
    expect(scopesOverlap(frames('1-48'), exclusive)).toBe(true)
    expect(scopesOverlap(exclusive, exclusive)).toBe(true)
  })

  it('keeps prefix/collection/object semantics untouched', () => {
    expect(
      scopesOverlap({ kind: 'prefix', value: 'LGT-' }, { kind: 'prefix', value: 'LGT-A' }),
    ).toBe(true)
    expect(
      scopesOverlap({ kind: 'collection', value: 'A' }, { kind: 'collection', value: 'B' }),
    ).toBe(false)
    expect(
      scopesOverlap({ kind: 'object', value: 'Cube' }, { kind: 'object', value: 'Cube' }),
    ).toBe(true)
  })

  it('anyOverlap covers a three-way split (prefix + aspect + frames) as parallel work', () => {
    const modelling = parseScopes('prefix:LGT-')
    const lighting = parseScopes('aspect:lights')
    const animation = parseScopes('frames:1-48')
    const sameAnimation = parseScopes('frames:24-96')
    const otherLighting = parseScopes('aspect:world')
    expect(anyOverlap(modelling, lighting)).toBe(false)
    expect(anyOverlap(modelling, animation)).toBe(false)
    expect(anyOverlap(lighting, animation)).toBe(false)
    expect(anyOverlap(lighting, otherLighting)).toBe(false)
    expect(anyOverlap(animation, sameAnimation)).toBe(true)
    expect(anyOverlap(lighting, parseScopes('exclusive'))).toBe(true)
  })
})

describe('scopeCovers: a grant covers the write it names', () => {
  it('covers the same aspect name only', () => {
    expect(scopeCovers(aspect('world'), aspect('world'))).toBe(true)
    expect(scopeCovers(aspect('world'), aspect('lights'))).toBe(false)
    expect(scopeCovers(aspect('lights'), aspect('world'))).toBe(false)
  })

  it('covers a frames range that is contained, never a wider one', () => {
    expect(scopeCovers(frames('1-48'), frames('10-20'))).toBe(true)
    expect(scopeCovers(frames('1-48'), frames('1-48'))).toBe(true)
    expect(scopeCovers(frames('1-48'), frames('40-96'))).toBe(false)
    expect(scopeCovers(frames('10-20'), frames('1-48'))).toBe(false)
    expect(scopeCovers(frames('1-10'), frames('10-20'))).toBe(false)
  })

  it('keeps exclusive as "covers everything" and cross-kind as false', () => {
    expect(scopeCovers({ kind: 'exclusive' }, aspect('world'))).toBe(true)
    expect(scopeCovers({ kind: 'exclusive' }, frames('1-48'))).toBe(true)
    expect(scopeCovers(aspect('world'), { kind: 'exclusive' })).toBe(false)
    expect(scopeCovers({ kind: 'collection', value: 'world' }, aspect('world'))).toBe(false)
    expect(scopeCovers(aspect('world'), { kind: 'collection', value: 'world' })).toBe(false)
    expect(scopeCovers(frames('1-48'), { kind: 'collection', value: '1-48' })).toBe(false)
  })

  it('keeps prefix/collection/object semantics untouched', () => {
    expect(scopeCovers({ kind: 'prefix', value: 'LGT-' }, { kind: 'prefix', value: 'LGT-A' })).toBe(
      true,
    )
    expect(scopeCovers({ kind: 'prefix', value: 'LGT-A' }, { kind: 'prefix', value: 'LGT-' })).toBe(
      false,
    )
    expect(scopeCovers({ kind: 'object', value: 'Cube' }, { kind: 'object', value: 'Cube' })).toBe(
      true,
    )
  })

  it('scopesCover accepts a grant list that names each write', () => {
    const granted = parseScopes('aspect:world, frames:1-48')
    expect(scopesCover(granted, parseScopes('aspect:world'))).toBe(true)
    expect(scopesCover(granted, parseScopes('frames:12-24'))).toBe(true)
    expect(scopesCover(granted, parseScopes('aspect:lights'))).toBe(false)
    expect(scopesCover(granted, parseScopes('frames:1-96'))).toBe(false)
    expect(scopesCover(parseScopes('exclusive'), parseScopes('aspect:world, frames:1-48'))).toBe(
      true,
    )
  })
})

describe('scopeCoversObject: declarative ops only, never the py object check', () => {
  it('never covers a changed object for aspect or frames', () => {
    expect(scopeCoversObject(aspect('world'), 'Sun')).toBe(false)
    // Even the exact name is not an object identity for these kinds.
    expect(scopeCoversObject(aspect('world'), 'world')).toBe(false)
    expect(scopeCoversObject(frames('1-10'), '1-10_mesh')).toBe(false)
    expect(scopeCoversObject(frames('1-10'), 'Cube', ['COL_A'])).toBe(false)
  })

  it('keeps exclusive/object/prefix/collection behavior', () => {
    expect(scopeCoversObject({ kind: 'exclusive' }, 'Anything')).toBe(true)
    expect(scopeCoversObject({ kind: 'object', value: 'Cube' }, 'Cube')).toBe(true)
    expect(scopeCoversObject({ kind: 'object', value: 'Cube' }, 'Cube.001')).toBe(false)
    expect(scopeCoversObject({ kind: 'prefix', value: 'LGT-' }, 'LGT-Key')).toBe(true)
    expect(scopeCoversObject({ kind: 'prefix', value: 'LGT-' }, 'Sun')).toBe(false)
    expect(scopeCoversObject({ kind: 'collection', value: 'COL_A' }, 'Cube', ['COL_A'])).toBe(true)
    expect(scopeCoversObject({ kind: 'collection', value: 'COL_A' }, 'Cube', ['COL_B'])).toBe(false)
  })
})

describe('grant conflicts: the new kinds are parallel, the old ones unchanged', () => {
  const main = (over: Partial<CallerIdentity> = {}): CallerIdentity => ({
    hostId: 'host-a',
    dshSessionId: 'dsh-main',
    agentId: 'lead',
    role: 'main',
    ...over,
  })
  const child = (agentId: string): CallerIdentity => ({
    hostId: 'host-a',
    dshSessionId: 'dsh-child',
    agentId,
    parentAgentId: 'lead',
    role: 'subagent',
  })

  function setup(instances: InstanceRef[] = [{ instanceId: 'inst-1', ready: true }]) {
    const state = { instances }
    return { registry: new SessionRegistry(() => state.instances), state }
  }

  function attached() {
    const { registry } = setup()
    const ok = registry.attach(main())
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error('attach failed')
    return { registry, sessionId: String(ok.session.id) }
  }

  it('lets three agents hold prefix / aspect / frames at the same time', () => {
    const { registry, sessionId } = attached()
    expect(registry.grant(main(), sessionId, 'prefix:LGT-', child('modeller')).ok).toBe(true)
    expect(registry.grant(main(), sessionId, 'aspect:lights', child('lighter')).ok).toBe(true)
    expect(registry.grant(main(), sessionId, 'frames:1-48', child('animator')).ok).toBe(true)
    const listed = registry.grants(main(), sessionId)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.grants.length).toBe(3)
    for (const holder of ['modeller', 'lighter', 'animator']) {
      const who = child(holder)
      const mine = listed.grants.find(
        (g) => (g.holder as Record<string, unknown>).agentId === holder,
      )
      expect(mine, holder).toBeTruthy()
      const allow = registry.authorizeWrite(
        who,
        sessionId,
        (mine as Record<string, unknown>).scopes,
      )
      expect(allow.ok, holder).toBe(true)
      if (allow.ok) expect(allow.mode).toBe('grant')
    }
  })

  it('still refuses a same-aspect grant to a second agent', () => {
    const { registry, sessionId } = attached()
    expect(registry.grant(main(), sessionId, 'aspect:world', child('a1')).ok).toBe(true)
    const clash = registry.grant(main(), sessionId, 'aspect:world', child('a2'))
    expect(clash.ok).toBe(false)
    if (clash.ok) return
    expect(clash.code).toBe('scope_conflict')
    expect((clash.evidence as Record<string, unknown>).requested).toEqual([
      { kind: 'aspect', value: 'world' },
    ])
    // A different aspect is a different write surface.
    expect(registry.grant(main(), sessionId, 'aspect:lights', child('a3')).ok).toBe(true)
  })

  it('still refuses intersecting frame ranges and allows disjoint ones', () => {
    const { registry, sessionId } = attached()
    expect(registry.grant(main(), sessionId, 'frames:1-48', child('b1')).ok).toBe(true)
    expect(registry.grant(main(), sessionId, 'frames:24-96', child('b2')).ok).toBe(false)
    expect(registry.grant(main(), sessionId, 'frames:49-96', child('b3')).ok).toBe(true)
  })

  it('keeps exclusive and collection conflicts exactly as before', () => {
    const { registry, sessionId } = attached()
    expect(registry.grant(main(), sessionId, 'exclusive', child('c1')).ok).toBe(true)
    const clash = registry.grant(main(), sessionId, 'frames:1-48', child('c2'))
    expect(clash.ok).toBe(false)
    const owned = attached()
    expect(owned.registry.grant(main(), owned.sessionId, 'collection:COL_A', child('d1')).ok).toBe(
      true,
    )
    expect(owned.registry.grant(main(), owned.sessionId, 'collection:COL_A', child('d2')).ok).toBe(
      false,
    )
    expect(owned.registry.grant(main(), owned.sessionId, 'collection:COL_B', child('d3')).ok).toBe(
      true,
    )
  })

  it('does not widen a grant: aspect:lights covers aspect:lights only', () => {
    const { registry, sessionId } = attached()
    expect(registry.grant(main(), sessionId, 'aspect:lights', child('e1')).ok).toBe(true)
    const ok = registry.authorizeWrite(child('e1'), sessionId, 'aspect:lights')
    expect(ok.ok).toBe(true)
    const denied = registry.authorizeWrite(child('e1'), sessionId, 'aspect:world')
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect((denied.evidence as Record<string, unknown>).requested).toEqual([
      { kind: 'aspect', value: 'world' },
    ])
  })
})

describe('human edits: aspect/frames never match by object name (task-8)', () => {
  function editsSession(): SessionRecord {
    const session = { humanEdits: new Map(), humanModifiedAt: null } as unknown as SessionRecord
    recordHumanEdits(session, [
      { kind: 'object', name: 'world_backdrop' },
      { kind: 'object', name: '1-10_px' },
      { kind: 'collection', name: 'COL_Lights' },
    ])
    return session
  }

  it('reports no conflict and clears nothing for aspect or frames scopes', () => {
    const session = editsSession()
    // 回归：兜底分支把 aspect/frames 的值当对象名前缀，'world_backdrop' / '1-10_px'
    // 会命中 → 打光/机位写被无关人类改动误判成 human_modified。
    expect(conflictingHumanEdits(session, parseScopes('aspect:world'))).toEqual([])
    expect(conflictingHumanEdits(session, parseScopes('frames:1-10'))).toEqual([])
    expect(clearHumanEdits(session, parseScopes('aspect:world'))).toBe(0)
    expect(clearHumanEdits(session, parseScopes('frames:1-10'))).toBe(0)
    expect(session.humanEdits.size).toBe(3)
  })

  it('keeps object/collection/prefix/exclusive matching unchanged', () => {
    const session = editsSession()
    expect(
      conflictingHumanEdits(session, parseScopes('collection:COL_Lights')).map((e) => e.name),
    ).toEqual(['COL_Lights'])
    expect(conflictingHumanEdits(session, parseScopes('prefix:world')).map((e) => e.name)).toEqual([
      'world_backdrop',
    ])
    expect(
      conflictingHumanEdits(session, parseScopes('object:1-10_px')).map((e) => e.name),
    ).toEqual(['1-10_px'])
    expect(conflictingHumanEdits(session, parseScopes('prefix:LGT-'))).toEqual([])
    expect(conflictingHumanEdits(session, parseScopes('exclusive')).length).toBe(3)
    expect(clearHumanEdits(session, parseScopes('collection:COL_Lights'))).toBe(1)
    expect(session.humanEdits.size).toBe(2)
    // An aspect-only mark_read must not wipe the remaining object edits.
    expect(clearHumanEdits(session, parseScopes('aspect:world'))).toBe(0)
    expect(session.humanEdits.size).toBe(2)
  })
})

describe('py fail-closed: aspect/frames are static-op scopes only (task-8)', () => {
  const main = (): CallerIdentity => ({
    hostId: 'host-a',
    dshSessionId: 'dsh-main',
    agentId: 'lead',
    role: 'main',
  })

  function owned() {
    const registry = new SessionRegistry(() => [{ instanceId: 'inst-1', ready: true }])
    const ok = registry.attach(main())
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error('attach failed')
    return { registry, sessionId: String(ok.session.id) }
  }

  it('refuses a py write declared as aspect/frames with invalid_params', async () => {
    const { registry, sessionId } = owned()
    for (const declared of ['aspect:world', 'frames:1-48', ['frames:7-12']]) {
      const denied = registry.authorizeWrite(main(), sessionId, declared, { py: true })
      expect(denied.ok, JSON.stringify(declared)).toBe(false)
      if (denied.ok) return
      expect(denied.code).toBe('invalid_params')
      expect(denied.fix).toContain('object/collection/prefix')
      expect(denied.fix).toContain('static-op')
    }
    // The evidence names what was refused, and the whole declaration stays visible.
    const mixed = registry.authorizeWrite(main(), sessionId, 'collection:COL_A, aspect:world', {
      py: true,
    })
    expect(mixed.ok).toBe(false)
    if (mixed.ok) return
    expect(mixed.code).toBe('invalid_params')
    const evidence = mixed.evidence as Record<string, unknown>
    expect(evidence.py).toBe(true)
    expect(evidence.requested).toEqual([
      { kind: 'collection', value: 'COL_A' },
      { kind: 'aspect', value: 'world' },
    ])
    expect(evidence.offending).toEqual([{ kind: 'aspect', value: 'world' }])

    // beginPy goes through the same gate and never takes the py lock.
    const begun = await registry.beginPy(main(), sessionId, 0, ['aspect:world'])
    expect(begun.ok).toBe(false)
    if (!begun.ok) expect(begun.code).toBe('invalid_params')
    expect(registry.endPy(main(), sessionId).ok).toBe(true)
  })

  it('keeps static ops and ordinary py scopes allowed', () => {
    const { registry, sessionId } = owned()
    // Static ops are the declared audience of aspect/frames.
    expect(registry.authorizeWrite(main(), sessionId, 'aspect:world').ok).toBe(true)
    expect(registry.authorizeWrite(main(), sessionId, 'frames:1-48').ok).toBe(true)
    expect(registry.authorizeWrite(main(), sessionId, 'aspect:lights, frames:1-48').ok).toBe(true)
    // py keeps working with a real object identity.
    expect(registry.authorizeWrite(main(), sessionId, 'object:Cube', { py: true }).ok).toBe(true)
    expect(
      registry.authorizeWrite(main(), sessionId, 'collection:COL_A, prefix:LGT-', { py: true }).ok,
    ).toBe(true)
  })
})
