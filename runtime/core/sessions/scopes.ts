// Scope declarations for 3.1 GUI sessions.
//
// A write declares what it mutates: the whole scene (exclusive), a Blender
// collection, an object-name prefix, one stable object identity, an aspect of the
// lighting/camera setup (aspect:), or a frame range (frames:). Grants are checked
// against those declarations; readers never need one.
//
// aspect:/frames: 是给**静态 op** 用的声明式写作用域：建模（prefix）、打光/机位
// （aspect）、动画（frames）因此能并行写入，而不必都退回 exclusive。

export type ScopeKind = 'exclusive' | 'collection' | 'prefix' | 'object' | 'aspect' | 'frames'

export interface ScopeSpec {
  kind: ScopeKind
  value?: string
}

const KINDS: ScopeKind[] = ['exclusive', 'collection', 'prefix', 'object', 'aspect', 'frames']

/** A parsed frame range: both bounds are integers and start <= end. */
interface FrameRange {
  start: number
  end: number
}

/** Parse "START-END" (integers, START<=END); anything else is unparseable, not guessed. */
function parseFrameRange(text: string): FrameRange | null {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(text.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
  return { start, end }
}

/** Normalize a kind's value; null means "this token is not a valid scope". */
function scopedValue(kind: ScopeKind, text: string): ScopeSpec | null {
  const raw = text.trim()
  if (!raw) return null
  if (kind === 'frames') {
    const range = parseFrameRange(raw)
    // Normalized so " 1 - 10 " and "1-10" are the same declaration everywhere
    // (receipts echo the parsed spec, so the spelling has to be stable).
    return range ? { kind, value: range.start + '-' + range.end } : null
  }
  return { kind, value: raw }
}

/**
 * Parse one scope token ("exclusive", "collection:COL_Lights", "prefix:LGT-",
 * "object:<uid>", "aspect:world", "frames:1-48").
 */
export function parseScope(value: unknown): ScopeSpec | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>
    const kind = String(rec.kind || '')
    if ((KINDS as string[]).includes(kind)) {
      const text = rec.value === undefined || rec.value === null ? '' : String(rec.value)
      if (kind === 'exclusive') return { kind: 'exclusive' }
      return scopedValue(kind as ScopeKind, text)
    }
    return null
  }
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!raw) return null
  const at = raw.indexOf(':')
  if (at > 0) {
    const kind = raw.slice(0, at)
    const rest = raw.slice(at + 1)
    if (kind === 'exclusive') return { kind: 'exclusive' }
    if ((KINDS as string[]).includes(kind)) return scopedValue(kind as ScopeKind, rest)
    return null
  }
  if (raw === 'exclusive') return { kind: 'exclusive' }
  // A bare name is treated as a collection, matching the legacy lease spelling.
  return { kind: 'collection', value: raw }
}

export function parseScopes(value: unknown): ScopeSpec[] {
  // A JSON array or a comma-separated string is what tools receive from a
  // type:"json" parameter; both must mean the same list as a real array.
  let list: unknown[] = Array.isArray(value) ? value : [value]
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) list = parsed
      } catch {
        /* not JSON: keep it as one token */
      }
    } else if (raw.includes(',')) list = raw.split(',')
  }
  const out: ScopeSpec[] = []
  for (const item of list) {
    const parsed = parseScope(item)
    if (parsed) out.push(parsed)
  }
  return out
}

/** True when two scope declarations may touch the same scene state. */
export function scopesOverlap(left: ScopeSpec, right: ScopeSpec): boolean {
  if (left.kind === 'exclusive' || right.kind === 'exclusive') return true
  if (left.kind !== right.kind) {
    // collection/object/prefix/aspect/frames target different identity spaces;
    // only an exact textual match is treated as overlap across kinds.
    return !!left.value && left.value === right.value
  }
  const a = String(left.value || '')
  const b = String(right.value || '')
  if (left.kind === 'prefix') return a.startsWith(b) || b.startsWith(a)
  if (left.kind === 'frames') {
    // Parallel animation work: two ranges collide only where the intervals really
    // intersect (frames:1-48 and frames:49-96 are separate jobs).
    const x = parseFrameRange(a)
    const y = parseFrameRange(b)
    if (!x || !y) return a === b
    return x.start <= y.end && y.start <= x.end
  }
  // exclusive is handled above; aspect/collection/object compare by name.
  return a === b
}

export function anyOverlap(left: ScopeSpec[], right: ScopeSpec[]): boolean {
  for (const a of left) for (const b of right) if (scopesOverlap(a, b)) return true
  return false
}

/** True when a grant scope covers a write scope (an exclusive grant covers everything). */
export function scopeCovers(grant: ScopeSpec, write: ScopeSpec): boolean {
  if (grant.kind === 'exclusive') return true
  if (write.kind === 'exclusive') return false
  if (grant.kind !== write.kind) return false
  const a = String(grant.value || '')
  const b = String(write.value || '')
  if (grant.kind === 'prefix') return b.startsWith(a)
  if (grant.kind === 'frames') {
    // Only a contained range is covered; a wider write needs a wider grant.
    const g = parseFrameRange(a)
    const w = parseFrameRange(b)
    if (!g || !w) return a === b
    return g.start <= w.start && w.end <= g.end
  }
  // exclusive/collection/object/aspect: the same identity covers itself.
  return a === b
}

export function scopesCover(granted: ScopeSpec[], writes: ScopeSpec[]): boolean {
  return writes.every((w) => granted.some((g) => scopeCovers(g, w)))
}

/**
 * Does a grant scope cover one changed object? Used after blender_py to report
 * writes that landed outside the declared scope (field 反馈 1: "py can only write
 * _probe_x"). Collections come from the addon's state delta, so a collection
 * grant is checked against real membership, not against the script's claim.
 *
 * aspect:/frames: 只用于静态 op 的声明式写作用域，py 的写后对象校验不适用：
 * 一次 bpy 调用改的是具名对象，而 aspect 是"世界/渲染/机位/灯组"这类非对象身份、
 * frames 是帧区间，都没有可比对的对象名。因此这两个 kind 在这里一律 false ——
 * py 必须声明 object/collection/prefix，否则它改动的每个对象都会被报成
 * scope_violation。
 */
export function scopeCoversObject(
  scope: ScopeSpec,
  name: string,
  collections: string[] = [],
): boolean {
  if (scope.kind === 'exclusive') return true
  if (scope.kind === 'aspect' || scope.kind === 'frames') return false
  const value = String(scope.value || '')
  if (!value) return false
  if (scope.kind === 'object') return name === value
  if (scope.kind === 'prefix') return name.startsWith(value)
  return collections.indexOf(value) >= 0
}
