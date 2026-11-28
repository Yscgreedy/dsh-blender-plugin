// engine API：Python 执行/命令透传
import { ACT_WRAPPER } from '../../paths.js'
import { KERNEL_BOOTSTRAP } from '../../foundation/kernel/index.js'
import { enrichError } from '../../foundation/errors.js'
import { planOpCrossChannelHint } from '../../catalog/index.js'
import type { EngineApiDeps } from './index.js'

/** The wrapper prints exactly one DSH_ACT_OK / DSH_ACT_ERR marker line. */
function parseActMarker(raw: string): {
  p: Record<string, unknown> | null
  errLine: string | null
} {
  const pick = (tag: string): string | null => {
    const ls = raw.split('\n').filter((x: string) => x.indexOf(tag + ' ') === 0)
    return ls.length ? ls[ls.length - 1] : null
  }
  const errLine = pick('DSH_ACT_ERR')
  const okLine = pick('DSH_ACT_OK')
  try {
    const p = JSON.parse(
      (errLine || okLine || '').slice((errLine ? 'DSH_ACT_ERR ' : 'DSH_ACT_OK ').length).trim(),
    ) as Record<string, unknown>
    return { p, errLine }
  } catch {
    return { p: null, errLine }
  }
}

/** Diagnostics → scope failure fields (kept out of actOutcome's budget). */
function scopeOutcome(diag: Record<string, unknown>): {
  attempted: string[]
  rolledBack: string[]
  unrolled: string[]
  purgedMeshes: string[]
  purgedMaterials: string[]
  reason: string | null
} {
  const attempted = Array.isArray(diag.scope_violations) ? diag.scope_violations.map(String) : []
  const rolledBack = Array.isArray(diag.rolled_back) ? diag.rolled_back.map(String) : []
  const unrolled = Array.isArray(diag.unrolled) ? diag.unrolled.map(String) : []
  const purgedMeshes = Array.isArray(diag.purged_meshes) ? diag.purged_meshes.map(String) : []
  const purgedMaterials = Array.isArray(diag.purged_materials)
    ? diag.purged_materials.map(String)
    : []
  const reason = attempted.length
    ? 'scope_violation: ' +
      String(attempted.length) +
      ' 个改动对象不在 grant 声明的写作用域内' +
      (rolledBack.length ? '；已回滚新建对象: ' + rolledBack.slice(0, 8).join(', ') : '') +
      (purgedMeshes.length ? '；已清 datablock: ' + purgedMeshes.slice(0, 8).join(', ') : '') +
      (unrolled.length
        ? '；未回滚（已存在对象被改）: ' +
          unrolled.slice(0, 8).join(', ') +
          ' → 用 session txn restore 或手工清理'
        : '')
    : null
  return { attempted, rolledBack, unrolled, purgedMeshes, purgedMaterials, reason }
}
/**
 * 反馈 4: FINISHED is not success. A bpy.ops call that changed nothing (empty
 * selection bevel) and a CANCELLED op both become ok:false, with the numbers that
 * prove it. Read-only scripts are not flagged: the wrapper only calls it no_effect
 * when the source contains bpy.ops.
 */
/** C-6/C-7/C-16：跨调用指纹、变更归属与产物（与"改没改"分开陈述）。 */
function crossCallFields(
  p: Record<string, unknown>,
  diag: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sceneBefore: p.state_before || null,
    sceneAfter: p.state_after || null,
    artifacts: Array.isArray(p.artifacts) ? p.artifacts : [],
    changedObjectsMine: Array.isArray(diag.changed_objects_mine) ? diag.changed_objects_mine : [],
    changedObjectsOther: Array.isArray(diag.changed_objects_other)
      ? diag.changed_objects_other
      : [],
  }
}

function actOutcome(
  p: Record<string, unknown>,
  errLine: string | null,
  ms: number,
  file: unknown,
): Record<string, unknown> {
  const diag =
    p.diagnostics && typeof p.diagnostics === 'object'
      ? (p.diagnostics as Record<string, unknown>)
      : {}
  const cancelled = Number(diag.cancelled_ops || 0) > 0
  const noEffect = diag.no_effect === true
  const uvFailed = diag.uv_failed === true
  const scope = scopeOutcome(diag)
  const scopeReason = scope.reason
  const reason =
    scopeReason ??
    (cancelled
      ? 'bpy.ops 返回 CANCELLED：算子没有执行，几何未改变（不是成功）'
      : uvFailed
        ? 'uv.unwrap 返回 FINISHED，但 stdout 报 Unwrap failed to solve（UV 没铺开）'
        : noEffect
          ? 'bpy.ops 返回 FINISHED，但场景内容没有变化（空选择/上下文不对）'
          : null)
  return {
    ok: !errLine && reason === null,
    executed: true,
    ms: ms,
    mainThreadMs: ms,
    stdout: p.stdout || '',
    stderr: p.stderr || '',
    error: errLine ? enrichError(String(p.error || 'error'), p.traceback) : reason,
    errorKind: errLine
      ? 'execution'
      : scopeReason
        ? 'scope_violation'
        : reason
          ? cancelled
            ? 'cancelled'
            : noEffect
              ? 'no_effect'
              : 'uv_failed'
          : null,
    traceback: p.traceback || null,
    sceneEpoch: p.epoch || null,
    // C-6：跨调用可比的内容指纹（state_probe 已经算好，以前被丢在这里）
    ...crossCallFields(p, diag),
    changed: typeof p.changed === 'boolean' ? p.changed : null,
    facesBefore: p.faces_before ?? null,
    facesAfter: p.faces_after ?? null,
    facesDelta: p.faces_delta ?? null,
    vertsDelta: p.verts_delta ?? null,
    objectsDelta: p.objects_delta ?? null,
    changedObjects: Array.isArray(p.changed_objects) ? p.changed_objects : [],
    changedObjectCollections:
      p.changed_object_collections && typeof p.changed_object_collections === 'object'
        ? (p.changed_object_collections as Record<string, unknown>)
        : {},
    materialsChanged: Array.isArray(p.materials_changed) ? p.materials_changed : [],
    editMode: Array.isArray(p.edit_mode) ? p.edit_mode : [],
    warnings: Array.isArray(diag.warnings) ? diag.warnings : [],
    noSceneChange: diag.no_scene_change === true,
    hasOps: diag.has_ops === true,
    fileOps: diag.file_ops === true,
    scopeViolations: scope.attempted,
    rolledBack: scope.rolledBack,
    unrolled: scope.unrolled,
    purgedMeshes: scope.purgedMeshes,
    purgedMaterials: scope.purgedMaterials,
    rollbackComplete: diag.rollback_complete !== false,
    file: file || null,
  }
}

export function createActApi(E: EngineApiDeps) {
  const { addon } = E
  return {
    async act(code: unknown, timeoutMs = 120000, file: unknown = null, scope: unknown = null) {
      const src = file
        ? 'K.run(' + JSON.stringify(String(file)) + ')'
        : code === undefined || code === null
          ? ''
          : String(code)
      // The grant scopes travel into the wrapper so it can roll back new objects
      // created outside the covered collection/prefix/object.
      const scopeInit =
        'import json as _dsh_scope_json\n_dsh_write_scope = _dsh_scope_json.loads(' +
        JSON.stringify(JSON.stringify(scope ?? null)) +
        ')\n'
      const wrapped = KERNEL_BOOTSTRAP + '\n' + scopeInit + ACT_WRAPPER(src)
      const t0 = Date.now()
      const res = await addon.send('execute_code', { code: wrapped }, timeoutMs)
      const resRec =
        res !== null && typeof res === 'object' ? (res as Record<string, unknown>) : null
      const raw = resRec && typeof resRec.result === 'string' ? resRec.result : ''
      const ms = Date.now() - t0
      const { p, errLine } = parseActMarker(raw)
      if (p) return actOutcome(p, errLine, ms, file)
      return {
        ok: true,
        executed: true,
        ms: ms,
        mainThreadMs: ms,
        stdout: raw,
        stderr: '',
        error: null,
        traceback: null,
        marker_missing: true,
        file: file || null,
      }
    },
    /** 通用命令透传：任意 addon 命令名 + 参数（MCP 那层不暴露的也能调） */
    async cmd(name: unknown, params: Record<string, unknown> = {}, timeoutMs = 120000) {
      if (!name || typeof name !== 'string') throw new Error('cmd: name required')
      // v0.9.6：把 plan op 当 addon 命令发是实测出现过的弯路（qc_render_catalog），
      // 这里在**本地**就纠正，不再浪费一次 Blender 往返。
      const hint = planOpCrossChannelHint(name)
      if (hint) return { status: 'error', result: 'CMD_HINT ' + hint, hint_shown: true }
      return addon.send(name, params || {}, timeoutMs)
    },
    /** 命令清单：目录 + 当前可用性（受 scene 开关与其 API key 影响） */
  }
}
