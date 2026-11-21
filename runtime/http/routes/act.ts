import type { IncomingMessage, ServerResponse } from 'node:http'
import { objArg } from './deps.js'
import type { HttpRouteDeps } from './deps.js'
import { errorMessage, errorField } from '../../core/json.js'
import { currentCaller } from '../caller.js'
import { gateResponse } from '../session-gate.js'
import { scopeCoversObject } from '../../core/sessions/scopes.js'
import type { AvailabilityFailure } from '../../core/availability.js'
import type { SessionRegistry } from '../../core/sessions/registry.js'
import type { CallerIdentity } from '../../core/sessions/types.js'
// HTTP 路由 /act：Python 执行
/** Changed objects that fall outside the grant that authorized this Python call. */
function pyScopeViolations(
  E: HttpRouteDeps,
  grant: { sessionId: string; grantId: string } | null,
  out: Record<string, unknown>,
): string[] {
  if (!grant) return []
  const session = E.sessionRegistry ? E.sessionRegistry.getSession(grant.sessionId) : null
  const record = session ? session.grants.get(grant.grantId) : null
  if (!record) return []
  const names = Array.isArray(out.changedObjects) ? out.changedObjects.map(String) : []
  const rawCols =
    out.changedObjectCollections && typeof out.changedObjectCollections === 'object'
      ? (out.changedObjectCollections as Record<string, unknown>)
      : {}
  const violations: string[] = []
  for (const name of names) {
    const cols = Array.isArray(rawCols[name]) ? (rawCols[name] as unknown[]).map(String) : []
    if (!record.scopes.some((scope) => scopeCoversObject(scope, name, cols))) violations.push(name)
  }
  return violations
}
/** /act receipt body: one place for the 反馈 1/4 fields. */
function actResponseBody(
  o: Record<string, unknown>,
  scopeViolations: string[],
  fallbackMs: number,
): Record<string, unknown> {
  return {
    ok: o.ok !== false && scopeViolations.length === 0,
    ms: o.ms != null ? o.ms : fallbackMs,
    mainThreadMs: o.mainThreadMs != null ? o.mainThreadMs : null,
    executed: !!o.executed,
    stdout: String(o.stdout || ''),
    stderr: String(o.stderr || ''),
    error: o.error || null,
    traceback: o.traceback || null,
    file: o.file || null,
    marker_missing: !!o.marker_missing,
    sceneEpoch: o.sceneEpoch || null,
    scene_before: o.sceneBefore || null,
    scene_after: o.sceneAfter || null,
    artifacts: Array.isArray(o.artifacts) ? o.artifacts : [],
    changed_objects_mine: Array.isArray(o.changedObjectsMine) ? o.changedObjectsMine : [],
    changed_objects_other: Array.isArray(o.changedObjectsOther) ? o.changedObjectsOther : [],
    errorKind: o.errorKind || (o.error ? 'execution' : null),
    // 反馈 4: one receipt for 'did it change': content delta + counts.
    changed: typeof o.changed === 'boolean' ? o.changed : null,
    faces_before: o.facesBefore ?? null,
    faces_after: o.facesAfter ?? null,
    faces_delta: o.facesDelta ?? null,
    verts_delta: o.vertsDelta ?? null,
    objects_delta: o.objectsDelta ?? null,
    changed_objects: Array.isArray(o.changedObjects) ? o.changedObjects : [],
    changed_object_collections:
      o.changedObjectCollections && typeof o.changedObjectCollections === 'object'
        ? o.changedObjectCollections
        : {},
    materials_changed: Array.isArray(o.materialsChanged) ? o.materialsChanged : [],
    edit_mode: Array.isArray(o.editMode) ? o.editMode : [],
    warnings: Array.isArray(o.warnings) ? o.warnings : [],
    no_scene_change: o.noSceneChange === true,
    has_ops: o.hasOps === true,
    file_ops: o.fileOps === true,
    // 反馈 1: outside the grant = visible refusal, not a silent write.
    scope_violations: scopeViolations,
    rolled_back: Array.isArray(o.rolledBack) ? o.rolledBack : [],
    unrolled: Array.isArray(o.unrolled) ? o.unrolled : [],
    purged_meshes: Array.isArray(o.purgedMeshes) ? o.purgedMeshes : [],
    purged_materials: Array.isArray(o.purgedMaterials) ? o.purgedMaterials : [],
    rollback_complete: o.rollbackComplete !== false,
    ...(scopeViolations.length
      ? {
          error:
            'scope_violation: ' +
            String(scopeViolations.length) +
            ' 个改动对象不在本次 grant 声明的写作用域内：' +
            scopeViolations.slice(0, 8).join(', ') +
            (Array.isArray(o.rolledBack) && o.rolledBack.length
              ? '；已回滚新建对象: ' + o.rolledBack.slice(0, 8).join(', ')
              : '') +
            (Array.isArray(o.purgedMeshes) && o.purgedMeshes.length
              ? '；已清 datablock: ' + o.purgedMeshes.slice(0, 8).join(', ')
              : '') +
            (Array.isArray(o.unrolled) && o.unrolled.length
              ? '；未回滚（已存在对象被改）: ' + o.unrolled.slice(0, 8).join(', ')
              : ''),
          errorKind: 'scope_violation',
        }
      : {}),
  }
}

type PyGrant = { sessionId: string; grantId: string; scopes: unknown }

/** Begin the Python lock and capture the covering grant's scopes. */
async function acquirePyGrant(
  registry: SessionRegistry,
  caller: CallerIdentity,
  payload: Record<string, unknown>,
): Promise<{ held: boolean; grant: PyGrant | null; failure: AvailabilityFailure | null }> {
  const begin = await registry.beginPy(
    caller,
    payload.sessionId === undefined ? undefined : String(payload.sessionId),
    Number(payload.waitMs) || 0,
    payload.write_scope ?? payload.write_scopes ?? payload.scope,
  )
  if (!begin.ok) return { held: false, grant: null, failure: begin }
  if (begin.mode !== 'grant' || !begin.grantId) return { held: true, grant: null, failure: null }
  const grant = registry.getSession(begin.sessionId)?.grants.get(begin.grantId)
  return {
    held: true,
    grant: {
      sessionId: begin.sessionId,
      grantId: begin.grantId,
      scopes: grant ? grant.scopes : null,
    },
    failure: null,
  }
}
export function createActRoutes(E: HttpRouteDeps) {
  const { engine, json, leaseGate, pushRtt, readBody, stats } = E
  return {
    async act(req: IncomingMessage, res: ServerResponse, _url: URL, _p: string): Promise<void> {
      const raw = await readBody(req)
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw)
      } catch (e) {
        payload = { code: raw }
      }
      // C-4: py 的授权与排队必须**一次**在 beginPy 里完成（它带 waitForPyLock）。
      // 若先过 leaseGate，evaluateWriteGate 会在等待之前就回 py_busy（或被
      // scope 检查抢先回 scope_required），wait_ms 永远失效（实测 6–12 ms 返回）。
      // 没有调用方身份的老客户端仍走 leaseGate 的 legacy 路径。
      const isPy = payload.py === true
      const caller = isPy ? currentCaller() : null
      const gate = isPy && caller ? null : leaseGate(payload)
      if (gate) {
        json(res, 409, gate)
        return
      }
      const registry = caller ? E.sessionRegistry : null
      let pyHeld = false
      // 反馈 1: a grant-holder runs Python under its declared scope; the objects
      // it actually changed are compared with that grant after execution.
      let pyGrant: PyGrant | null = null
      if (caller && registry) {
        const acquired = await acquirePyGrant(registry, caller, payload)
        if (acquired.failure) {
          json(res, 409, gateResponse(acquired.failure))
          return
        }
        pyHeld = acquired.held
        pyGrant = acquired.grant
      }
      const t0 = Date.now()
      try {
        const out = objArg(
          await engine.act(
            payload.code || '',
            Number(payload.timeoutMs) || 120000,
            payload.file || null,
            pyGrant ? pyGrant.scopes : null,
          ),
        )
        stats.acts++
        stats.lastActMs = Date.now() - t0
        pushRtt('act', stats.lastActMs)
        stats.lastError = null
        const o = out || {}
        const attempted = Array.isArray(o.scopeViolations) ? o.scopeViolations.map(String) : []
        const scopeViolations = [...new Set([...attempted, ...pyScopeViolations(E, pyGrant, o)])]
        json(res, 200, actResponseBody(o, scopeViolations, Date.now() - t0))
      } catch (e) {
        stats.acts++
        stats.lastError = errorMessage(e)
        json(res, 200, {
          ok: false,
          ms: Date.now() - t0,
          error: stats.lastError,
          errorKind: errorField(e, 'kind') || null,
          diagnosis: errorField(e, 'diagnosis') || null,
        })
      } finally {
        if (pyHeld && caller && registry) {
          registry.endPy(
            caller,
            payload.sessionId === undefined ? undefined : String(payload.sessionId),
          )
        }
      }
      return
    },
  }
}
