// External-path readiness: glTF-Validator (node) and Open3D (venv python).
//
// 现场缺口：ext.gltf_validate / ext.ext_mesh_check 在依赖没装时只回一条 ok:false +
// 安装命令，调用方无法一眼看出"两条通路各自缺什么"。这里把探测集中到一个纯函数：
//   * 不启动 Blender、不占 lease；
//   * 只读文件系统 + venv python 的 import 探测（最多 5 s）；
//   * 结果同时给到 ext 失败回执与 scripts/setup-ext.mjs --check。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PY_ROOT } from '../../paths.js'

export type ExtToolId = 'gltf-validator' | 'open3d'

export interface ExtToolReadiness {
  id: ExtToolId
  ok: boolean
  detail: string
  version: string | null
  install: string
}

export interface ExtReadiness {
  ok: boolean
  ext_dir: string
  tools: ExtToolReadiness[]
  install_all: string
  note: string
}

/** Injection seam: unit tests replace fs / child_process without touching the machine. */
export interface ExtProbe {
  extDir?: string
  platform?: string
  exists?: (file: string) => boolean
  readFile?: (file: string) => string
  spawn?: SpawnSyncLike
}

export interface SpawnResultLike {
  status?: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: { message?: string } | null
}

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide: boolean },
) => SpawnResultLike

const defaultSpawn: SpawnSyncLike = (command, args, options) =>
  spawnSync(command, args, options) as SpawnResultLike

export function defaultExtDir(): string {
  return path.join(path.dirname(PY_ROOT), 'runtime', 'ext')
}

function quotedCd(dir: string, platform: string): string {
  return platform === 'win32' ? 'cd /d "' + dir + '"' : 'cd "' + dir + '"'
}

export function extInstallCommand(id: ExtToolId, extDir: string, platform: string): string {
  const cd = quotedCd(extDir, platform)
  if (id === 'gltf-validator') return cd + ' && npm i gltf-validator'
  return platform === 'win32'
    ? cd + ' && python -m venv venv && venv\\Scripts\\pip install open3d'
    : cd + ' && python3 -m venv venv && venv/bin/pip install open3d'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value instanceof Buffer ? value.toString('utf8') : ''
}

function probeGltf(
  extDir: string,
  platform: string,
  read: (f: string) => string,
  exists: (f: string) => boolean,
): ExtToolReadiness {
  const pkg = path.join(extDir, 'node_modules', 'gltf-validator', 'package.json')
  const install = extInstallCommand('gltf-validator', extDir, platform)
  if (!exists(pkg)) {
    return {
      id: 'gltf-validator',
      ok: false,
      detail: '未安装：runtime/ext/node_modules/gltf-validator 不存在',
      version: null,
      install,
    }
  }
  let version: string | null
  try {
    const parsed = JSON.parse(read(pkg)) as { version?: unknown }
    version = typeof parsed.version === 'string' ? parsed.version : null
  } catch (e) {
    return {
      id: 'gltf-validator',
      ok: false,
      detail: 'package.json 读不出来：' + String(e).slice(0, 120),
      version: null,
      install,
    }
  }
  return {
    id: 'gltf-validator',
    ok: true,
    detail: '已安装（runtime/ext/node_modules）',
    version,
    install,
  }
}

function venvCandidates(extDir: string, platform: string): string[] {
  const win = path.join(extDir, 'venv', 'Scripts', 'python.exe')
  const posix = path.join(extDir, 'venv', 'bin', 'python')
  return platform === 'win32' ? [win, posix] : [posix, win]
}

function probeOpen3d(
  extDir: string,
  platform: string,
  exists: (f: string) => boolean,
  spawn: SpawnSyncLike,
): ExtToolReadiness {
  const install = extInstallCommand('open3d', extDir, platform)
  const python = venvCandidates(extDir, platform).find((p) => exists(p))
  if (!python) {
    return {
      id: 'open3d',
      ok: false,
      detail: '未安装：runtime/ext/venv 不存在（ext 只用这个 venv，不借系统 python）',
      version: null,
      install,
    }
  }
  try {
    const r = spawn(python, ['-c', 'import open3d;print(open3d.__version__)'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    const out = text(r.stdout).trim()
    if (r.status === 0 && out) {
      return {
        id: 'open3d',
        ok: true,
        detail: 'venv 可导入 open3d',
        version: out.split(/\s+/).pop() ?? null,
        install,
      }
    }
    const why = text(r.stderr).trim() || (r.error && r.error.message) || 'exit=' + String(r.status)
    return {
      id: 'open3d',
      ok: false,
      detail: 'venv 存在但导入失败：' + why.slice(0, 160),
      version: null,
      install,
    }
  } catch (e) {
    return {
      id: 'open3d',
      ok: false,
      detail: 'venv python 探测失败：' + String(e).slice(0, 160),
      version: null,
      install,
    }
  }
}

/**
 * Probe both external paths. Missing paths are not fatal here — callers decide.
 * `ok` is true only when BOTH tools are ready and importable.
 */
export function extReadiness(probe: ExtProbe = {}): ExtReadiness {
  const platform = probe.platform || process.platform
  const extDir = probe.extDir || defaultExtDir()
  const exists = probe.exists || ((f: string) => fs.existsSync(f))
  const read = probe.readFile || ((f: string) => fs.readFileSync(f, 'utf8'))
  const spawn = probe.spawn || defaultSpawn
  const tools = [
    probeGltf(extDir, platform, read, exists),
    probeOpen3d(extDir, platform, exists, spawn),
  ]
  const root = path.dirname(path.dirname(extDir))
  const installAll = quotedCd(root, platform) + ' && npm run setup:ext'
  const ok = tools.every((t) => t.ok)
  return {
    ok,
    ext_dir: extDir,
    tools,
    install_all: installAll,
    note: ok
      ? '两条外部通路都就绪；ext.gltf_validate / ext.ext_mesh_check 可直接跑'
      : '缺通路时 ext.gltf_validate / ext.ext_mesh_check 会回 ok:false（不是几何失败）；先跑 npm run setup:ext，或按 tools[].install 单装',
  }
}
