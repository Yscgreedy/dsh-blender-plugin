#!/usr/bin/env node
// scripts/setup-ext.mjs —— 外部两条通路的检查与安装（glTF-Validator / Open3D）。
//
// 用法：
//   node scripts/setup-ext.mjs            # 等价 --check：只探测，不联网
//   node scripts/setup-ext.mjs --check --json
//   node scripts/setup-ext.mjs --install  # 装到 runtime/ext（npm 包 + venv）
//
// 约定：两条通路都只装在 runtime/ext 下，不借系统 node_modules / 系统 python；
// 探测与 blender_op(op="ext.gltf_validate") 失败回执里的 readiness 口径一致。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'runtime', 'ext')
const argv = process.argv.slice(2)
const wantInstall = argv.includes('--install')
const asJson = argv.includes('--json')
const platform = process.platform

const quote = (p) => '"' + p + '"'

/** 挑一个能起 venv 的解释器：环境变量优先，然后按版本回落（不假定 py 启动器存在）。 */
function pythonCommand() {
  const override = process.env.DSH_EXT_PYTHON
  if (override) return override
  const cands =
    platform === 'win32'
      ? ['py -3.12', 'py -3.11', 'py -3', 'python']
      : ['python3.12', 'python3.11', 'python3', 'python']
  for (const c of cands) {
    const r = spawnSync(c + ' -c "import sys; print(sys.version_info[0])"', {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
    })
    if (r.status === 0) return c
  }
  return cands[cands.length - 1]
}

function shell(command, label) {
  if (!asJson) console.log('[setup-ext] ' + label)
  const r = spawnSync(command, { cwd: ROOT, shell: true, stdio: asJson ? 'pipe' : 'inherit' })
  if (r.status !== 0 && !asJson) {
    console.error('[setup-ext] 失败：' + label + '（exit=' + String(r.status) + '）')
  }
  return r.status === 0
}

function venvCandidates() {
  const win = path.join(EXT, 'venv', 'Scripts', 'python.exe')
  const posix = path.join(EXT, 'venv', 'bin', 'python')
  return platform === 'win32' ? [win, posix] : [posix, win]
}

function probeGltf() {
  const pkg = path.join(EXT, 'node_modules', 'gltf-validator', 'package.json')
  const install = 'cd ' + quote(EXT) + ' && npm i gltf-validator'
  if (!fs.existsSync(pkg)) {
    return { id: 'gltf-validator', ok: false, detail: '未安装', version: null, install }
  }
  let version
  try {
    version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null
  } catch (e) {
    return {
      id: 'gltf-validator',
      ok: false,
      detail: 'package.json 读不出来',
      version: null,
      install,
    }
  }
  return { id: 'gltf-validator', ok: true, detail: '已安装', version, install }
}

function probeOpen3d() {
  const install =
    platform === 'win32'
      ? 'cd /d ' + quote(EXT) + ' && python -m venv venv && venv\\Scripts\\pip install open3d'
      : 'cd ' + quote(EXT) + ' && python3 -m venv venv && venv/bin/pip install open3d'
  const python = venvCandidates().find((p) => fs.existsSync(p))
  if (!python) return { id: 'open3d', ok: false, detail: 'venv 不存在', version: null, install }
  const r = spawnSync(python, ['-c', 'import open3d;print(open3d.__version__)'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  const out = String(r.stdout || '').trim()
  if (r.status === 0 && out) {
    return { id: 'open3d', ok: true, detail: 'venv 可导入 open3d', version: out, install }
  }
  const why = String(r.stderr || (r.error && r.error.message) || '').trim()
  return {
    id: 'open3d',
    ok: false,
    detail: '导入失败：' + why.slice(0, 160),
    version: null,
    install,
  }
}

function probe() {
  const tools = [probeGltf(), probeOpen3d()]
  return {
    ok: tools.every((t) => t.ok),
    ext_dir: EXT,
    tools,
    install_all: 'cd ' + quote(ROOT) + ' && npm run setup:ext',
  }
}

function installAll() {
  if (!probeGltf().ok) {
    shell(
      'npm install --prefix ' + quote(EXT) + ' --no-save --no-package-lock gltf-validator',
      '安装 gltf-validator',
    )
  }
  if (!probeOpen3d().ok) {
    const venv = path.join(EXT, 'venv')
    if (!venvCandidates().some((p) => fs.existsSync(p))) {
      shell(pythonCommand() + ' -m venv ' + quote(venv), '创建 runtime/ext/venv')
    }
    const pip =
      platform === 'win32' ? path.join(venv, 'Scripts', 'pip.exe') : path.join(venv, 'bin', 'pip')
    shell(quote(pip) + ' install open3d', '安装 open3d 到 venv')
  }
}

if (wantInstall) installAll()
const out = probe()
if (asJson) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
} else {
  console.log('[setup-ext] ' + (out.ok ? 'READY' : 'NOT READY'))
  for (const t of out.tools) {
    console.log(
      '  - ' +
        t.id +
        ': ' +
        (t.ok ? 'ok' : 'missing') +
        (t.version ? ' v' + t.version : '') +
        ' — ' +
        t.detail,
    )
  }
  if (!out.ok) console.log('  一键安装：npm run setup:ext')
}
process.exit(out.ok ? 0 : 1)
