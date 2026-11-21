/** blender_py 的回执装配（ACT 通道）。 */
import { text } from '../../contracts/dynamic.js'
import { redactDiagnostic, redactSecrets } from '../errors.js'

const LF = String.fromCharCode(10)

/**
 * 成功回执的锚点：谁跑的这一趟、执行前退到哪。
 *
 * request_id 是 host 侧生成的（crypto.randomUUID），客户端等待结束时连同一个
 * outcome=unknown 回执一起交给模型 —— 事后把"这次编辑"与 txn 快照对上号靠它。
 */
export interface PyOutcomeMeta {
  requestId: string
  /** 执行前文件级快照的 label；null = 没留成回退点 */
  checkpoint: string | null
  /** off = 调用方明确要求不留；auto = 试过（失败时看 checkpointWarning） */
  checkpointMode: 'auto' | 'off'
  /** 快照失败原因：照常执行，只是没有回退点 */
  checkpointWarning?: string | null
}

/** 反馈 4: the one structured 'did it change' block every py receipt carries. */
export function actDeltaEvidence(r: Record<string, unknown>): Record<string, unknown> {
  const changed = typeof r.changed === 'boolean' ? r.changed : null
  return {
    changed,
    faces_before: r.faces_before ?? null,
    faces_after: r.faces_after ?? null,
    faces_delta: r.faces_delta ?? null,
    verts_delta: r.verts_delta ?? null,
    objects_delta: r.objects_delta ?? null,
    changed_objects: Array.isArray(r.changed_objects) ? r.changed_objects : [],
    /** C-6：跨调用可比的内容指纹（before/after 是同一调用的窗口，drift 才跨调用） */
    scene_fingerprint: {
      before: typeof r.scene_before === 'string' ? r.scene_before : null,
      after: typeof r.scene_after === 'string' ? r.scene_after : null,
    },
    /** C-7：按本次 grant 分桶（other = 不在我作用域内，已回滚的新建对象列在 rolled_back） */
    changed_objects_mine: Array.isArray(r.changed_objects_mine) ? r.changed_objects_mine : [],
    changed_objects_other: Array.isArray(r.changed_objects_other) ? r.changed_objects_other : [],
    /** C-16：产物（.blend / Render Result），与"场景变没变"分开说 */
    artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
    materials_changed: Array.isArray(r.materials_changed) ? r.materials_changed : [],
    edit_mode: Array.isArray(r.edit_mode) ? r.edit_mode : [],
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    no_scene_change: r.no_scene_change === true,
    has_ops: r.has_ops === true,
    /** 产物型算子（render / save / export）：场景不变是预期，不是"没生效" */
    file_ops: r.file_ops === true,
    scope_violations: Array.isArray(r.scope_violations) ? r.scope_violations : [],
    rolled_back: Array.isArray(r.rolled_back) ? r.rolled_back : [],
    unrolled: Array.isArray(r.unrolled) ? r.unrolled : [],
    purged_meshes: Array.isArray(r.purged_meshes) ? r.purged_meshes : [],
    purged_materials: Array.isArray(r.purged_materials) ? r.purged_materials : [],
    rollback_complete: r.rollback_complete !== false,
  }
}
function checkpointText(meta: PyOutcomeMeta): string {
  if (meta.checkpoint) return meta.checkpoint
  return meta.checkpointMode === 'off' ? 'off' : 'none'
}

/** C-16：产物一行（.blend / Render Result），没有产物时返回 null。 */
function artifactsLine(delta: Record<string, unknown>): string | null {
  const artifacts = Array.isArray(delta.artifacts) ? delta.artifacts : []
  if (!artifacts.length) return null
  return (
    '产物：' +
    artifacts
      .slice(0, 3)
      .map((raw) => {
        const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        const file = text(item.path) || '?'
        const bytes = typeof item.bytes === 'number' ? ' (' + String(item.bytes) + 'B)' : ''
        return file + bytes
      })
      .join(' | ')
  )
}

/** changed + faces_delta 一行（回执的自证）；没有 changed 字段时返回 null。 */
function changeLine(r: Record<string, unknown>): string | null {
  const changed = typeof r.changed === 'boolean' ? r.changed : null
  if (changed === null) return null
  const faces =
    typeof r.faces_before === 'number' && typeof r.faces_after === 'number'
      ? ' · faces ' + String(r.faces_before) + '→' + String(r.faces_after)
      : ''
  const fd =
    typeof r.faces_delta === 'number' && r.faces_delta !== 0
      ? ' (' + String(r.faces_delta > 0 ? '+' : '') + String(r.faces_delta) + ')'
      : ''
  const verts =
    typeof r.verts_delta === 'number' && r.verts_delta !== 0
      ? ' · verts ' + String(r.verts_delta > 0 ? '+' : '') + String(r.verts_delta)
      : ''
  return (
    'changed=' +
    String(changed) +
    faces +
    fd +
    verts +
    (changed === false ? ' · 回执自证：场景内容没有变化' : '')
  )
}

export function formatActText(r: Record<string, unknown>, meta?: PyOutcomeMeta): string[] {
  const parts: string[] = []
  parts.push('PY ok · ' + text(r.ms) + 'ms')
  if (meta) {
    parts.push(
      'outcome=complete · request_id=' + meta.requestId + ' · checkpoint=' + checkpointText(meta),
    )
    if (meta.checkpointWarning)
      parts.push('⚠️ checkpoint 没建成（照常执行，只是没有回退点）：' + meta.checkpointWarning)
  }
  const fileOps = r.file_ops === true
  if (Number(r.mainThreadMs) > 1000)
    parts.push(
      (fileOps ? '主线程占用约 ' : '⚠️ 本次占用 Blender 主线程约 ') +
        text(r.mainThreadMs) +
        'ms —— ' +
        (fileOps
          ? '产物型执行（渲染/存盘/导出）本来就会占这么久；更长的活改走 blender_run(kind=headless)'
          : '超过 ~1s 的重活改走 blender_run(kind=headless)（不卡 GUI）'),
    )
  // 反馈 4: changed + faces_delta is the receipt's own proof; CANCELLED is never ok.
  const delta = actDeltaEvidence(r)
  const change = changeLine(r)
  if (change) parts.push(change)
  const editMode = Array.isArray(delta.edit_mode) ? delta.edit_mode : []
  if (editMode.length)
    parts.push(
      '⚠ 编辑模式：' +
        editMode.slice(0, 4).join(', ') +
        ' —— 在 EDIT 模式里读 len(mesh.polygons) 是旧值（bmesh.from_edit_mesh 才是当前值）；要在 OBJECT 模式复核计数',
    )
  const warnings = Array.isArray(delta.warnings) ? delta.warnings.map(String) : []
  if (warnings.length) parts.push('warnings: ' + warnings.slice(0, 4).join(' | '))
  const violations = Array.isArray(delta.scope_violations) ? delta.scope_violations.map(String) : []
  if (violations.length) {
    const rolled = Array.isArray(delta.rolled_back) ? delta.rolled_back.map(String) : []
    const unrolled = Array.isArray(delta.unrolled) ? delta.unrolled.map(String) : []
    parts.push(
      '⚠ scope_violation：' +
        String(violations.length) +
        ' 个改动对象不在 grant 作用域内：' +
        violations.slice(0, 8).join(', ') +
        (rolled.length ? ' · 已回滚新建: ' + rolled.slice(0, 8).join(', ') : '') +
        (Array.isArray(delta.purged_meshes) && delta.purged_meshes.length
          ? ' · 已清 datablock: ' + (delta.purged_meshes as string[]).slice(0, 8).join(', ')
          : '') +
        (unrolled.length
          ? ' · 未回滚（已存在对象）: ' +
            unrolled.slice(0, 8).join(', ') +
            ' → 用 session txn restore 或手工清理'
          : ''),
    )
  }
  if (fileOps)
    parts.push(
      '产物型执行（render / save / export）：**场景内容不变是预期**，不是"没生效"；产物看脚本里的 filepath（长任务建议 blender_run(kind=headless)）',
    )
  else if (delta.no_scene_change === true && delta.has_ops === true && violations.length === 0)
    parts.push(
      '⚠ no_scene_change：脚本调了 bpy.ops 但最终场景内容没变（bake/export/bind 这类不写场景的操作不算失败；ok 仍为 true）',
    )
  // stdout/stderr 保持既有口径：行级过滤掉 stack 帧（模型读长文时噪声太大），
  // 只放宽长度；traceback 是专用字段，用 redactDiagnostic 保留 File 行。
  const artifacts = artifactsLine(delta)
  if (artifacts) parts.push(artifacts)
  if (r.stderr && String(r.stderr).trim()) parts.push('stderr: ' + redactSecrets(r.stderr, 3000))
  if (r.traceback) parts.push('--- traceback ---' + LF + redactDiagnostic(r.traceback, 3000))
  if (r.stdout) parts.push('stdout: ' + redactSecrets(r.stdout, 6000))
  return parts
}
