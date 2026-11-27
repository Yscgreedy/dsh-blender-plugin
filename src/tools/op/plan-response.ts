/** blender_op action=plan 的回执收尾：receipt 信封（构造器见 tools/receipt.ts）+ 产物附图。 */
import type { HostContext } from '../../host/context.js'
import { attachPaths, planImagePaths } from '../../utils/image.js'
import { asRecord, isRecord, text } from '../../contracts/dynamic.js'
import { receiptV2 } from '../receipt.js'

/** 结构化目录（catalog format=json）从结果里摘出来：文本只是摘要，判据在 catalog 字段。 */
function structuredCatalog(res: unknown): Record<string, unknown> | null {
  if (!isRecord(res) || res.format !== 'json') return null
  return {
    format: 'json',
    ops_count: res.ops_count ?? null,
    families: Array.isArray(res.families) ? res.families : [],
    tools: Array.isArray(res.tools) ? res.tools : [],
  }
}

/** 正文：结构化目录只回它的一行摘要（全量在 catalog 字段，避免 12k 截断把结构切坏）。 */
function planResponseText(res: unknown): string {
  if (typeof res === 'string') return res
  if (isRecord(res) && res.format === 'json' && typeof res.text === 'string') return res.text
  return String(JSON.stringify(res, null, 1) ?? '')
}

/** Receipt head: source attribution + verdict + summary (one place, one order). */
function planHeadText(
  op: string,
  env: Record<string, unknown>,
  chars: number,
  attachNote: string,
): string {
  const facts: string[] = []
  const source = asRecord(env.source)
  if (text(source.file)) facts.push('source=' + text(source.file))
  else if (text(source.mode)) facts.push('source=' + text(source.mode))
  if (source.is_mine === false)
    facts.push(
      'is_mine=false · owner=' +
        text(asRecord(source.owner).agentId || '-') +
        (source.borrowed === true ? ' · borrowed(read-only)' : ''),
    )
  const cleanup = asRecord(env.cleanup)
  if (Object.keys(cleanup).length) facts.push('cleanup=' + (cleanup.ok === true ? 'ok' : 'fail'))
  return (
    'OP ' +
    op +
    ' ok · ' +
    String(chars) +
    ' chars · ' +
    (facts.length ? facts.join(' · ') + ' · ' : '') +
    'verdict=' +
    text(env.verdict) +
    (env.summary ? ' · ' + text(env.summary) : '') +
    attachNote +
    String.fromCharCode(10)
  )
}
/** plan 回执统一收尾：信封 + 附图（调用方已经拿到 op 结果）。 */
export async function finishPlanResponse(
  ctx: HostContext,
  op: string,
  res: unknown,
  argsIn: unknown,
): Promise<Record<string, unknown>> {
  const txt = planResponseText(res)
  const catalog = structuredCatalog(res)
  const CAP = 12000
  const env = planEnvelope(op, res)
  const args = asRecord(argsIn)
  const attachWanted =
    args.attach_images !== undefined
      ? !!args.attach_images
      : [
          'img_digest',
          'qc_compare',
          'visualreport_report',
          'qc_visual_report',
          'shapesolve_solve',
        ].indexOf(op) >= 0
  let images: unknown[] = []
  let attachNote = ''
  if (attachWanted) {
    const att = await attachPaths(
      ctx,
      planImagePaths(res),
      'plan-' + op.replace(/[^a-z0-9_]+/gi, '_'),
      2,
    )
    images = att.images
    if (att.used.length)
      attachNote =
        String.fromCharCode(10) +
        '附图：' +
        String(att.used.length) +
        ' 张（' +
        att.used.join(' · ') +
        '）'
    if (att.failed.length)
      attachNote += String.fromCharCode(10) + '⚠ 部分图未附：' + att.failed.slice(0, 2).join(' · ')
  }
  const head = planHeadText(op, env, txt.length, attachNote)
  return {
    text:
      head +
      (txt.length > CAP
        ? txt.slice(0, CAP) +
          String.fromCharCode(10) +
          '…[已截断，共 ' +
          String(txt.length) +
          ' 字符；结构化全量见后端 results/ 目录或用 blender_run(kind=headless, out_json=…) 落盘]'
        : txt),
    envelope: env,
    ...(images.length ? { images: images } : {}),
    // 结构化目录（catalog format=json）：文本只是摘要，判据在这里（不进 12k 截断）。
    ...(catalog ? { catalog } : {}),
  }
}

/** 结构化来源块（audit_mesh / audit_scene）：截到 40 个对象，别把信封撑爆。 */
function compactSource(raw: unknown): Record<string, unknown> | null {
  const s = asRecord(raw)
  if (!text(s.file) && !text(s.mode) && s.is_mine === undefined) return null
  const objects = Array.isArray(s.objects) ? s.objects.map((x) => text(x)) : []
  return {
    mode: text(s.mode) || null,
    file: text(s.file) || null,
    scene: text(s.scene) || null,
    scope: text(s.scope) || null,
    session_file: text(s.session_file) || null,
    objects: objects.slice(0, 40),
    objects_count: objects.length,
    ...(objects.length > 40 ? { objects_truncated: true } : {}),
    ...(Array.isArray(s.requested) ? { requested: s.requested.slice(0, 40) } : {}),
    // 反馈 3: attribution survives the compact envelope too.
    owner: isRecord(s.owner) ? s.owner : null,
    is_mine: s.is_mine === true,
    borrowed: s.borrowed === true,
    sessionId: text(s.sessionId) || null,
  }
}

/** file= 加载摘要：只留判据字段（路径/计数/临时集合），不搬整个 file_load。 */
function compactLoad(raw: unknown): Record<string, unknown> | null {
  const l = asRecord(raw)
  if (!Object.keys(l).length) return null
  return {
    ok: l.ok === true,
    path: text(l.path) || null,
    loaded: l.loaded ?? null,
    mesh: l.mesh ?? null,
    non_mesh: l.non_mesh ?? null,
    missing: Array.isArray(l.missing) ? l.missing.slice(0, 20) : [],
    tmp_collection: text(l.tmp_collection) || null,
  }
}

/** cleanup 摘要：removed 只留每类数量（名字在正文里，信封只负责“删没删干净”）。 */
function compactCleanup(raw: unknown): Record<string, unknown> | null {
  const c = asRecord(raw)
  if (!Object.keys(c).length) return null
  const removed = asRecord(c.removed)
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(removed)) {
    if (Array.isArray(value)) counts[key] = value.length
  }
  return {
    ok: c.ok === true,
    failed: Array.isArray(c.failed) ? c.failed.slice(0, 5) : [],
    removed: counts,
    note: text(c.note).slice(0, 120),
  }
}

/** 长回执：把 source/file_load/cleanup 的紧凑副本塞进信封（正文截断后仍可见）。 */
function attachAuditEvidence(env: Record<string, unknown>, r: Record<string, unknown>): void {
  const source = compactSource(r.source)
  const load = compactLoad(r.file_load)
  const cleanup = compactCleanup(r.cleanup)
  if (source) env.source = source
  if (load) env.file_load = load
  if (cleanup) env.cleanup = cleanup
}

/** 弱模型契约 v2：verdict-first 信封（单行、≤2k）——plan 与 headless 共用口径 */
export function planEnvelope(op: string, res: unknown): Record<string, unknown> {
  const r = isRecord(res) ? res : { value: res }
  const verdict =
    r.verdict ||
    r.state ||
    (r.ok === false ? 'fail' : r.ok === true ? (r.clean === false ? 'degraded' : 'pass') : null)
  let defects: unknown[] = []
  for (const k of ['top_defects', 'offenders', 'defects', 'failures', 'errors']) {
    if (Array.isArray(r[k])) {
      defects = r[k] as unknown[]
      break
    }
  }
  const limit = (t: unknown, n: number) => text(t).slice(0, n)
  const top = defects.slice(0, 5).map((d, i) => {
    if (!isRecord(d)) return { id: 'D' + String(i + 1), code: limit(d, 80) }
    return {
      id: d.id || 'D' + String(i + 1),
      code: limit(d.code || d.kind || d.class || d.error || 'issue', 60),
      severity: d.severity || null,
      object: d.object || d.a || d.name || null,
      measured:
        d.measured ||
        (d.volume_mm3 !== undefined
          ? { volume_mm3: d.volume_mm3 }
          : d.depth_mm !== undefined
            ? { depth_mm: d.depth_mm }
            : null),
      fix_hint: d.fix_hint || d.repair || null,
    }
  })
  const next = (Array.isArray(r.next) ? r.next : Array.isArray(r.repairs) ? r.repairs : [])
    .slice(0, 3)
    .map((x: unknown) =>
      typeof x === 'string'
        ? { op: limit(x, 120) }
        : {
            op: limit(asRecord(x).op || asRecord(x).name || 'next', 80),
            args: asRecord(x).args || null,
            why: limit(asRecord(x).why || '', 120),
          },
    )
  const env: Record<string, unknown> = receiptV2({
    op: op,
    verdict: verdict,
    summary: limit(r.summary || r.note || r.error || r.hint || '', 160),
    top_defects: top,
    next: next,
    images: planImagePaths(r).slice(0, 2),
    provenance: { ms: typeof r.ms === 'number' ? r.ms : null },
  })
  // 长回执：source / file_load / cleanup 是"从哪个文件来、清理了什么"的唯一判据。
  attachAuditEvidence(env, r)
  const counts = r.counts || (r.totals ? r.totals : null)
  if (isRecord(counts)) env.counts = counts
  if (isRecord(r.detail))
    env.detail = {
      path: r.detail.path || null,
      bytes: r.detail.bytes || null,
      id: r.detail.id || null,
    }
  // 信封硬预算：超过 2k 就只保留最有用的三块（verdict / top3 / next2）
  try {
    if (JSON.stringify(env).length > 2000) {
      env.top_defects = top.slice(0, 3)
      env.next = next.slice(0, 2)
      delete env.counts
      const detail = asRecord(env.detail)
      if (detail.bytes && Number(detail.bytes) > 0) {
        /* keep path only */
      } else delete env.detail
    }
  } catch {
    /* ignore */
  }
  return env
}
