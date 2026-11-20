import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { catalogPayload } from '../../../../runtime/engine.js'
import { pkgPath } from '../../../helpers/pkg'

// The bundled SKILL.md is the model's source of truth for "how many tools / families / ops
// exist". Those numbers are hand-written prose, so they drift the moment the catalog changes:
// the assistant then calls ops that no longer exist (or misses new ones). This gate keeps the
// prose pinned to the same truth the catalog and the capability lock report.

const SKILL = fs.readFileSync(pkgPath('skills', 'blender-modeling', 'SKILL.md'), 'utf8')
const LOCK = JSON.parse(
  fs.readFileSync(pkgPath('tests', 'fixtures', 'capability.lock.json'), 'utf8'),
) as { tools_count: number; families_count: number; ops_count: number }
const GATEWAY = JSON.parse(fs.readFileSync(pkgPath('config', 'gateway.json'), 'utf8')) as {
  addon: { protocol: number; version: string }
}

/** The header block that states the surface counts (frontmatter is excluded: it is a summary). */
const HEADER = SKILL.split(/\r?\n/).slice(0, 24).join('\n')

function quoted(pattern: RegExp, label: string): number {
  const match = pattern.exec(HEADER)
  if (!match)
    throw new Error('SKILL.md header no longer states ' + label + ' · pattern ' + String(pattern))
  return Number(match[1])
}

describe('bundled skill surface counts', () => {
  const payload = catalogPayload({ full: true }) as {
    ok: boolean
    families: unknown[]
    ops_count: number
  }

  it('quotes the live tool count', () => {
    expect(quoted(/(\d+)\s*个模型工具/, 'tool count')).toBe(LOCK.tools_count)
  })

  it('quotes the live family count', () => {
    const stated = quoted(/(\d+)\s*个 family/, 'family count')
    expect(stated, 'SKILL.md family count vs capability.lock.json').toBe(LOCK.families_count)
    expect(stated, 'SKILL.md family count vs catalog payload').toBe(payload.families.length)
  })

  it('quotes the live op count', () => {
    const stated = quoted(/(\d+)\s*个 op/, 'op count')
    expect(stated, 'SKILL.md op count vs capability.lock.json').toBe(LOCK.ops_count)
    expect(stated, 'SKILL.md op count vs catalog payload').toBe(payload.ops_count)
  })

  it('quotes the addon version and protocol from config/gateway.json', () => {
    expect(quoted(/(\d+)\s*个模型工具/, 'tool count')).toBeGreaterThan(0)
    expect(HEADER).toContain('protocol ' + String(GATEWAY.addon.protocol))
    expect(HEADER).toContain('addon v' + GATEWAY.addon.version)
  })

  it('keeps the catalog payload consistent with the lock', () => {
    expect(payload.ok).toBe(true)
    expect(payload.ops_count).toBe(LOCK.ops_count)
    expect(payload.families).toHaveLength(LOCK.families_count)
  })
})
