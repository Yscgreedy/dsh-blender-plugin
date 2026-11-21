/**
 * blender_run action=worker 的 digest / exec 回执（从 worker.ts 拆出，保持单文件行预算）。
 *
 * 工单 7 的口径不变：auto_restore / restore_applied 恒为 false —— 本插件从不自动回滚；
 * changed 只看内容哈希（digest_before !== digest_after），不看 mtime。
 */
import { asRecord, text } from '../../contracts/dynamic.js'

const LF = String.fromCharCode(10)

/**
 * 工单 7：exec digest=true 的**结构化**字段（信封 evidence）。
 *
 * `auto_restore` / `restore_applied` 恒为 false —— 本插件从不自动回滚：改了就是改了。
 * `changed` 只看内容哈希（digest_before !== digest_after），不看 mtime。
 */
export function digestEvidence(
  r: Record<string, unknown>,
  worker: { session?: string; file?: string | null } = {},
): Record<string, unknown> {
  const before = r.digest_before == null ? null : text(r.digest_before) || null
  const after = r.digest_after == null ? null : text(r.digest_after) || null
  const scope = Array.isArray(r.digest_scope)
    ? r.digest_scope.map(text).filter(Boolean)
    : [text(r.digest_scope) || 'objects']
  return {
    digest_before: before,
    digest_after: after,
    changed: before !== null && after !== null ? before !== after : r.changed === true,
    faces_before: Number(r.faces_before ?? 0) || 0,
    faces_after: Number(r.faces_after ?? 0) || 0,
    faces_delta: Number(r.faces_delta ?? 0) || 0,
    eval_faces_before: Number(r.eval_faces_before ?? 0) || 0,
    eval_faces_after: Number(r.eval_faces_after ?? 0) || 0,
    eval_faces_delta: Number(r.eval_faces_delta ?? 0) || 0,
    eval_verts_before: Number(r.eval_verts_before ?? 0) || 0,
    eval_verts_after: Number(r.eval_verts_after ?? 0) || 0,
    frame_before: r.frame_before == null ? null : Number(r.frame_before),
    frame_after: r.frame_after == null ? null : Number(r.frame_after),
    modifiers_after: Array.isArray(r.modifiers_after) ? r.modifiers_after : [],
    digest_ms: Number(r.digest_ms ?? r.elapsed_ms ?? 0) || 0,
    digest_limited: r.digest_limited === true || r.digest_truncated === true,
    verts_delta: Number(r.verts_delta ?? 0) || 0,
    objects_delta: Number(r.objects_delta ?? 0) || 0,
    filepath_before: r.filepath_before == null ? null : text(r.filepath_before) || null,
    filepath_after: r.filepath_after == null ? null : text(r.filepath_after) || null,
    filepath_changed: r.filepath_changed === true,
    digest_scope: scope,
    restore_applied: false,
    auto_restore: false,
    kit_source: text(r.kit_source) || 'unknown',
    elapsed_ms: Number(r.elapsed_ms ?? r.ms ?? 0) || 0,
    // 会话/文件自证：确认 worker 开的是调用方给的那个 .blend，而不是静默回到出厂场景。
    worker: {
      session: text(worker.session ?? r.session ?? ''),
      file: worker.file == null ? null : text(worker.file) || null,
    },
  }
}

/** 工单 7：op=digest 的基线证据（同样显式 auto_restore=false）。 */
export function digestBaselineEvidence(
  r: Record<string, unknown>,
  worker: { session?: string; file?: string | null } = {},
): Record<string, unknown> {
  const scope = Array.isArray(r.digest_scope)
    ? r.digest_scope.map(text).filter(Boolean)
    : [text(r.digest_scope) || 'objects']
  return {
    digest: r.digest == null ? null : text(r.digest) || null,
    digest_scope: scope,
    restore_applied: false,
    auto_restore: false,
    kit_source: text(r.kit_source) || 'unknown',
    elapsed_ms: Number(r.elapsed_ms ?? 0) || 0,
    objects: Number(r.objects ?? 0) || 0,
    meshes: Number(r.meshes ?? 0) || 0,
    verts: Number(r.verts ?? 0) || 0,
    faces: Number(r.faces ?? 0) || 0,
    materials: Number(r.materials ?? 0) || 0,
    truncated: r.truncated === true,
    digest_ms: Number(r.digest_ms ?? r.elapsed_ms ?? 0) || 0,
    digest_limited: r.limited === true || r.digest_limited === true || r.truncated === true,
    worker: {
      session: text(worker.session ?? r.session ?? ''),
      file: worker.file == null ? null : text(worker.file) || null,
    },
  }
}

function digestLine(ev: Record<string, unknown>): string {
  return (
    'digest: before=' +
    text(ev.digest_before ?? '-') +
    ' · after=' +
    text(ev.digest_after ?? '-') +
    ' · changed=' +
    String(ev.changed === true) +
    (ev.faces_delta
      ? ' · faces ' +
        String(ev.faces_before) +
        '→' +
        String(ev.faces_after) +
        ' (' +
        String(Number(ev.faces_delta) > 0 ? '+' : '') +
        String(ev.faces_delta) +
        ')'
      : '') +
    (ev.eval_faces_delta
      ? ' · eval_faces ' +
        String(ev.eval_faces_before) +
        '→' +
        String(ev.eval_faces_after) +
        ' (' +
        String(Number(ev.eval_faces_delta) > 0 ? '+' : '') +
        String(ev.eval_faces_delta) +
        ')'
      : '') +
    (ev.frame_before !== null && ev.frame_after !== null && ev.frame_before !== ev.frame_after
      ? ' · frame ' + String(ev.frame_before) + '→' + String(ev.frame_after) + '（不计入 changed）'
      : '') +
    (ev.filepath_changed === true ? ' · filepath_changed=true（内容未变，只换了路径）' : '') +
    ' · scope=' +
    (Array.isArray(ev.digest_scope) ? (ev.digest_scope as unknown[]).map(text).join(',') : '-') +
    ' · auto_restore=' +
    String(ev.auto_restore === true) +
    ' · restore_applied=' +
    String(ev.restore_applied === true) +
    ' · kit_source=' +
    text(ev.kit_source || '-') +
    ' · elapsed_ms=' +
    String(ev.elapsed_ms ?? 0) +
    ' · digest_ms=' +
    String(ev.digest_ms ?? 0) +
    ' · digest_limited=' +
    String(ev.digest_limited === true) +
    '\nworker: session=' +
    text(asRecord(ev.worker).session || '-') +
    ' · file=' +
    text(asRecord(ev.worker).file || '(factory startup)')
  )
}

function digestText(name: string, ev: Record<string, unknown>, ok: boolean): string {
  return [
    'WORKER digest · ' + name + ' · ' + (ok ? 'ok' : 'FAIL'),
    'digest: ' +
      text(ev.digest ?? '-') +
      ' · scope=' +
      (Array.isArray(ev.digest_scope) ? (ev.digest_scope as unknown[]).map(text).join(',') : '-') +
      ' · objects=' +
      String(ev.objects) +
      ' · meshes=' +
      String(ev.meshes) +
      ' · verts=' +
      String(ev.verts) +
      ' · faces=' +
      String(ev.faces ?? 0) +
      ' · truncated=' +
      String(ev.truncated === true),
    'kit_source: ' + text(ev.kit_source) + ' · auto_restore=' + String(ev.auto_restore),
    'worker: session=' +
      text(asRecord(ev.worker).session || '-') +
      ' · file=' +
      text(asRecord(ev.worker).file || '(factory startup)'),
  ].join(LF)
}

/** exec 的最终回执：带 digest 时补一行 + structured evidence（工单 7）。 */
export function execOutcome(
  name: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const out = execText(name, result)
  if (result.digest_before === undefined && result.digest_after === undefined) return { text: out }
  const evidence = digestEvidence(result, {
    session: name,
    file: typeof result.file === 'string' ? result.file : null,
  })
  return { text: out + LF + digestLine(evidence), evidence: evidence }
}

/** op=digest 的最终回执。 */
export function digestOutcome(
  name: string,
  result: Record<string, unknown>,
  ok: boolean,
): Record<string, unknown> {
  const evidence = digestBaselineEvidence(result, {
    session: name,
    file: typeof result.file === 'string' ? result.file : null,
  })
  return { text: digestText(name, evidence, ok), evidence }
}

function execText(name: string, r: Record<string, unknown>): string {
  const out = asRecord(r.result)
  const lines = [
    'WORKER exec · ' +
      name +
      ' · ' +
      (r.ok === true ? 'ok' : 'FAIL') +
      ' · ' +
      String(r.ms ?? '?') +
      'ms',
  ]
  if (r.error) lines.push('error: ' + text(r.error))
  if (typeof r.changed === 'boolean') {
    lines.push(
      'changed=' +
        String(r.changed) +
        (typeof r.faces_delta === 'number' && r.faces_delta !== 0
          ? ' · faces ' +
            String(r.faces_before ?? '?') +
            '→' +
            String(r.faces_after ?? '?') +
            ' (' +
            String(r.faces_delta > 0 ? '+' : '') +
            String(r.faces_delta) +
            ')'
          : '') +
        (r.filepath_changed === true ? ' · filepath_changed=true' : ''),
    )
  }
  if (r.file !== undefined)
    lines.push(
      'loaded_file: ' +
        (text(r.file) || '(空场景/未保存)') +
        ' · objects=' +
        String(r.objects ?? '?'),
    )
  if (out && Object.keys(out).length) lines.push('result: ' + JSON.stringify(out).slice(0, 4000))
  const so = text(r.stdout || '').trim()
  if (so) lines.push('stdout:', so.slice(-4000))
  const tb = text(r.traceback || '').trim()
  if (tb) lines.push('traceback:', tb.slice(-2000))
  return lines.filter(Boolean).join(LF)
}
