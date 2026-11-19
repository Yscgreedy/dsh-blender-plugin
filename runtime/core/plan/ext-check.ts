import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PY_ROOT } from '../../paths.js'
import {
  extCandidates,
  extInstallHint,
  runExtCandidates,
  toWslPath,
} from './ext-check-candidates.js'
import { gltfResult, open3dResult } from './ext-check-result.js'
import { extReadiness } from './ext-readiness.js'

const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE_ROOT = path.dirname(PY_ROOT)

export interface ExtPaths {
  extDir: string
  gltfRunner: string
  open3dRunner: string
  gltfRunnerExists: boolean
  open3dRunnerExists: boolean
}

/** Resolve both source and built layouts without hard-coding .mjs / lib paths. */
export function resolveExtPaths(): ExtPaths {
  const extDir = path.join(PACKAGE_ROOT, 'runtime', 'ext')
  const builtRunner = path.join(RUNTIME_DIR, 'ext', 'gltf_validate_runner.js')
  const sourceRunner = path.join(extDir, 'gltf_validate_runner.ts')
  const gltfRunner = fs.existsSync(builtRunner) ? builtRunner : sourceRunner
  const open3dRunner = path.join(PY_ROOT, 'py', 'export', 'open3d_check.py')
  return {
    extDir,
    gltfRunner,
    open3dRunner,
    gltfRunnerExists: fs.existsSync(gltfRunner),
    open3dRunnerExists: fs.existsSync(open3dRunner),
  }
}

const DEPENDENCY_MISSING =
  /Cannot find module|MODULE_NOT_FOUND|No module named|ModuleNotFoundError|validator 加载失败|import open3d/i

/** Missing dependency is not a geometry failure: attach both paths' readiness + one-command fix. */
function readinessHint(
  op: string,
  extDir: string,
  winPath: string,
  isWin: boolean,
  tried: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const readiness = extReadiness()
  return {
    ...extInstallHint({ op, extDir, winPath, isWin, tried }),
    readiness,
    readiness_ok: readiness.ok,
    fix: readiness.install_all,
    ...extra,
  }
}

/** External validators (glTF-Validator / open3d) run locally and never take a Blender round-trip. */
export async function extCheckOp(op: string, payload?: unknown): Promise<unknown> {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const cp = await import('node:child_process')
  const { extDir, gltfRunner, open3dRunner } = resolveExtPaths()
  const winPath = String(p.path || '')
  const wslPath = toWslPath(winPath)
  // open3d_check.py 已随导出域移入 runtime/py/export/；ext/ 只留 venv 与 gltf_validate_runner.mjs。
  const runner = op === 'gltf_validate' ? gltfRunner : open3dRunner
  const isWin = process.platform === 'win32'
  const cands = extCandidates({ op, extDir, runner, winPath, wslPath, isWin })
  const run = runExtCandidates(cp, cands)
  if (!run.raw) {
    // 缺依赖时把"两条通路各自缺什么"一并回出去：安装命令不再是唯一线索。
    return readinessHint(op, extDir, winPath, isWin, run.tried)
  }
  let parsed: Record<string, unknown> | null
  try {
    parsed = JSON.parse(run.raw) as Record<string, unknown>
  } catch (e) {
    parsed = { parse_error: String(e).slice(0, 120), raw: run.raw.slice(0, 400) }
  }
  if (parsed && parsed.error && DEPENDENCY_MISSING.test(String(parsed.error))) {
    return readinessHint(op, extDir, winPath, isWin, run.tried, {
      tool: op === 'gltf_validate' ? 'gltf-validator' : 'open3d',
      dependency_error: String(parsed.error).slice(0, 300),
      used: run.used,
    })
  }
  if (op === 'gltf_validate') return gltfResult(parsed, winPath, run)
  return open3dResult(parsed, run)
}
