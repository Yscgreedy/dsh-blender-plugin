// selftest evidence 归一（R6.2 / 消费方需求 2026-11-17）
//
// 现场：各族 selftest 的 evidence 形状不一致 —— geo 是平坦 bool 表，faceeval/surface/calib
// 是嵌套对象/数组。下游想机器判"哪族红"只能按 raw 读、每族写一套解析。
//
// 做法：**加性**归一，不改原 evidence（向后兼容），额外给：
//   evidence_flat     {path: bool}        —— 只收布尔叶子，路径用 . 与 [i]
//   evidence_nonbool  {path: value}       —— 非布尔标量/对象整体（保留上下文）
//   evidence_failed   [path]              —— 为 false 的叶子
//   evidence_ok       bool                —— 没有 false 叶子
//   evidence_shape    flat-bool|nested|list|missing
// 只对 *selftest* op 生效（dispatch 结果在 routeTable 统一过一遍）。
import { isArray, isRecord } from './json.js'

export interface SelftestEvidence {
  evidence_flat: Record<string, boolean>
  evidence_nonbool: Record<string, unknown>
  evidence_failed: string[]
  evidence_ok: boolean
  evidence_shape: 'flat-bool' | 'nested' | 'list' | 'missing'
}

function joinPath(prefix: string, key: string | number): string {
  if (typeof key === 'number') return prefix + '[' + String(key) + ']'
  return prefix ? prefix + '.' + key : key
}

function walk(
  value: unknown,
  path: string,
  out: { flat: Record<string, boolean>; other: Record<string, unknown>; failed: string[] },
  depth: number,
): void {
  if (depth > 8) return
  if (typeof value === 'boolean') {
    out.flat[path] = value
    if (!value) out.failed.push(path)
    return
  }
  if (isArray(value)) {
    value.forEach((item, index) => walk(item, joinPath(path, index), out, depth + 1))
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) walk(item, joinPath(path, key), out, depth + 1)
    return
  }
  if (value !== undefined && value !== null) out.other[path || 'value'] = value
}

export function normalizeEvidence(evidence: unknown): SelftestEvidence {
  const flat: Record<string, boolean> = {}
  const other: Record<string, unknown> = {}
  const failed: string[] = []
  if (isArray(evidence)) {
    evidence.forEach((item, index) =>
      walk(item, '[' + String(index) + ']', { flat, other, failed }, 0),
    )
  } else if (isRecord(evidence)) {
    for (const [key, item] of Object.entries(evidence)) walk(item, key, { flat, other, failed }, 0)
  } else if (typeof evidence === 'boolean') {
    walk(evidence, 'value', { flat, other, failed }, 0)
  }
  const top = isRecord(evidence) ? Object.values(evidence) : []
  const shape: SelftestEvidence['evidence_shape'] =
    evidence === undefined || evidence === null
      ? 'missing'
      : isArray(evidence)
        ? 'list'
        : isRecord(evidence) && top.length > 0 && top.every((v) => typeof v === 'boolean')
          ? 'flat-bool'
          : 'nested'
  return {
    evidence_flat: flat,
    evidence_nonbool: other,
    evidence_failed: failed,
    evidence_ok: failed.length === 0,
    evidence_shape: shape,
  }
}

export function isSelftestOp(op: string): boolean {
  return /(^|_)selftest($|_)/.test(op)
}

/** 只对 selftest op 且回执带 evidence 的对象做加性归一；其它原样返回。 */
export function normalizeSelftestReceipt(op: string, result: unknown): unknown {
  if (!isSelftestOp(op) || !isRecord(result) || !('evidence' in result)) return result
  return { ...result, ...normalizeEvidence(result.evidence) }
}
