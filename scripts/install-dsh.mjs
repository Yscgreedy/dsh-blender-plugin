#!/usr/bin/env node
/**
 * scripts/install-dsh.mjs —— 一条命令把本 checkout 装/更新进 DSH profile。
 *
 * 为什么需要它（实测 2026-11-21）：
 *   · npm pack 会先跑 prepack=build，一次更新把编译做两遍（+5 s）；
 *   · 用 robocopy /MIR 覆盖安装目录会把 runtime/ext（venv+node_modules，16.8k 文件）
 *     删掉再恢复（+17 s），而且一旦忘了恢复，ext.* 能力就静默消失；
 *   · reload 之后 Gateway 换 pid、session 记录清空，还要人再 attach + 验证。
 *
 * 本脚本的做法：
 *   1) 一次 build（或不 build）；
 *   2) npm pack --dry-run --json --ignore-scripts 拿**发布文件清单**（不产 tarball、不跑 prepack）；
 *   3) 按内容哈希只复制变化的文件；只删除"上一次本脚本装的清单里、这次没了"的文件；
 *      runtime/ext / node_modules / __pycache__ 永远不碰（merge-only，绝不 /MIR）；
 *   4) 写 profile 的 cordis.patch.yml 触发 HMR（复用 lib/host/reload/profile.js 的同一实现）；
 *   5) 轮询 /health 等新 Gateway，再读 /status 与 /plan catalog 做自证。
 *
 * 模式：
 *   --mode pack   默认。按发布清单覆盖安装目录（适合"装成 npm 包的样子"）。
 *   --mode link   把 profile 依赖改成 link:<repo>，之后更新只需 build + reload（最快）。
 *
 * 其它：
 *   --dry-run          只算计划，不复制/不 reload（pack 清单来自 npm pack --dry-run）
 *   --verify-only      不装，只做 /health + /status + /plan 自证
 *   --no-build         复用现有 lib/
 *   --no-reload        只写文件，不触发 HMR
 *   --with-addon       把 extension/dsh_blender_bridge 复制进 Blender 的 user_default 扩展目录
 *   --blender-version  指定 Blender 版本目录（默认取最高版本）
 *   --profile <dir>    指定 profile（默认按 DSH_PROFILE_DIR / DSH_PROFILE / 最新 patch 解析）
 *   --port <n>         Gateway HTTP 端口（默认 DSH_BLENDER_HTTP_PORT 或 39877）
 *   --json             末尾打印一份机器可读报告
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const PLUGIN_NAME = 'dsh-blender-plugin'
export const PATCH_FILE = 'cordis.patch.yml'
export const MANIFEST_FILE = '.dsh-install-manifest.json'
export const PROTECTED_PREFIXES = ['runtime/ext/', 'node_modules/', '.git/', '__pycache__/']
export const DEFAULT_PORT = 39877

export function parseArgs(argv = []) {
  const out = {
    mode: 'pack',
    dryRun: false,
    verifyOnly: false,
    build: true,
    reload: true,
    withAddon: false,
    blenderVersion: '',
    profile: '',
    port: 0,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '')
    const next = () => String(argv[++i] || '')
    if (arg === '--mode') out.mode = next() === 'link' ? 'link' : 'pack'
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--verify-only') out.verifyOnly = true
    else if (arg === '--no-build') out.build = false
    else if (arg === '--no-reload') out.reload = false
    else if (arg === '--with-addon') out.withAddon = true
    else if (arg === '--blender-version') out.blenderVersion = next()
    else if (arg === '--profile') out.profile = next()
    else if (arg === '--port') out.port = Number(next()) || 0
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

export function isProtected(rel, prefixes = PROTECTED_PREFIXES) {
  const p = normalizeRel(rel)
  return prefixes.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix))
}

export function normalizeRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function looksLikeProfile(dir) {
  try {
    return fs.statSync(path.join(String(dir), PATCH_FILE)).isFile()
  } catch {
    return false
  }
}

/** profile 解析：显式 → DSH_PROFILE_DIR → $DSH_HOME/profiles/$DSH_PROFILE → ~/.dsh/profiles 最新。 */
export function resolveProfileDir({ profile = '', env = process.env, home = os.homedir() } = {}) {
  const explicit = String(profile || env.DSH_PROFILE_DIR || '').trim()
  if (explicit && looksLikeProfile(explicit)) return explicit
  const name = String(env.DSH_PROFILE || '').trim()
  const dshHome = String(env.DSH_HOME || '').trim() || path.join(home, '.dsh')
  const roots = [...new Set([path.join(dshHome, 'profiles'), path.join(home, '.dsh', 'profiles')])]
  if (name) {
    for (const root of roots) {
      const candidate = path.join(root, name)
      if (looksLikeProfile(candidate)) return candidate
    }
  }
  let best = null
  for (const root of roots) {
    let entries
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      const dir = path.join(root, entry)
      try {
        const mtime = fs.statSync(path.join(dir, PATCH_FILE)).mtimeMs
        if (!best || mtime > best.mtime) best = { dir, mtime }
      } catch {
        /* not a profile */
      }
    }
  }
  return best ? best.dir : null
}

export function parseDependency(pkg, name = PLUGIN_NAME) {
  const spec = pkg && pkg.dependencies ? pkg.dependencies[name] : undefined
  if (typeof spec !== 'string' || !spec.trim()) return null
  const raw = spec.trim()
  if (raw.startsWith('link:')) return { kind: 'link', spec: raw, target: raw.slice(5) }
  if (raw.startsWith('file:')) return { kind: 'file', spec: raw, target: raw.slice(5) }
  if (raw.startsWith('workspace:')) return { kind: 'workspace', spec: raw, target: null }
  return { kind: 'version', spec: raw, target: null }
}

export function resolveInstalledDir(profileDir, name = PLUGIN_NAME) {
  const link = path.join(String(profileDir), 'node_modules', name)
  try {
    return fs.realpathSync(link)
  } catch {
    return null
  }
}

/** 文件清单 + 内容哈希；用于"只复制变化"，也用于 manifest 对拍。 */
export function hashFiles(root, files) {
  const out = {}
  for (const rel of files) {
    const abs = path.join(root, ...normalizeRel(rel).split('/'))
    try {
      out[normalizeRel(rel)] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(abs))
        .digest('hex')
    } catch {
      /* 清单里有、磁盘上没有：交给调用方报错 */
    }
  }
  return out
}

/**
 * 安装计划：next 里哈希不同的复制；previous 里有、next 里没有的删除（受保护前缀除外）。
 */
export function mergePlan(previousHashes, nextHashes, prefixes = PROTECTED_PREFIXES) {
  const prev = previousHashes && typeof previousHashes === 'object' ? previousHashes : {}
  const next = nextHashes && typeof nextHashes === 'object' ? nextHashes : {}
  const copy = []
  for (const [rel, hash] of Object.entries(next)) {
    if (prev[rel] !== hash) copy.push(rel)
  }
  const remove = []
  const keptProtected = []
  for (const rel of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(next, rel)) continue
    if (isProtected(rel, prefixes)) keptProtected.push(rel)
    else remove.push(rel)
  }
  return { copy: copy.sort(), remove: remove.sort(), keptProtected: keptProtected.sort() }
}

export function walkFiles(root, base = root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(abs, base, out)
    else if (entry.isFile()) out.push(normalizeRel(path.relative(base, abs)))
  }
  return out
}

/** Blender 用户扩展根目录（user_default 的父目录）。 */
export function blenderExtensionsRoots({
  platform = process.platform,
  home = os.homedir(),
  appData = process.env.APPDATA,
} = {}) {
  if (platform === 'win32') {
    const base = String(appData || path.join(home, 'AppData', 'Roaming'))
    return [path.join(base, 'Blender Foundation', 'Blender')]
  }
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Blender')]
  return [path.join(home, '.config', 'blender')]
}

/** 从根目录里挑 Blender 版本目录（默认最高版本；version 可指定 "5.3"）。 */
export function pickBlenderVersionDir(roots, version = '') {
  const wanted = String(version || '').trim()
  const candidates = []
  for (const root of roots) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+\.\d+/.test(entry.name)) continue
      const dir = path.join(root, entry.name)
      if (!fs.existsSync(path.join(dir, 'extensions'))) continue
      candidates.push({ dir, name: entry.name })
    }
  }
  if (!candidates.length) return null
  if (wanted) return candidates.find((c) => c.name === wanted || c.name.startsWith(wanted)) || null
  candidates.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
  return candidates[candidates.length - 1]
}

// ---------------------------------------------------------------- 进程/HTTP

function npmCommand() {
  const execpath = process.env.npm_execpath
  if (execpath && fs.existsSync(execpath)) return { cmd: process.execPath, prefix: [execpath] }
  return process.platform === 'win32'
    ? { cmd: 'npm.cmd', prefix: [], shell: true }
    : { cmd: 'npm', prefix: [] }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '')
      .trim()
      .slice(-1200)
    throw new Error(
      cmd + ' ' + args.join(' ') + ' failed (' + String(result.status) + '): ' + detail,
    )
  }
  return String(result.stdout || '')
}

/**
 * Windows 上 npm/pnpm 是 .cmd，必须经 shell；这里传**单条命令串**（无用户输入），
 * 避免 spawnSync(args + shell) 的 DEP0190 警告与参数拼接风险。
 */
function runShell(command, opts = {}) {
  const result = spawnSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    ...opts,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '')
      .trim()
      .slice(-1200)
    throw new Error(command + ' failed (' + String(result.status) + '): ' + detail)
  }
  return String(result.stdout || '')
}

export function packFileList({ dryRun = true } = {}) {
  const npm = npmCommand()
  const cli = 'pack --ignore-scripts --json' + (dryRun ? ' --dry-run' : '')
  const raw =
    npm.shell === true
      ? runShell('npm ' + cli, { cwd: REPO_ROOT })
      : run(npm.cmd, [...npm.prefix, ...cli.split(' ')], { cwd: REPO_ROOT })
  const parsed = JSON.parse(raw.trim())
  const row = Array.isArray(parsed) ? parsed[0] : parsed
  const files = (row && Array.isArray(row.files) ? row.files : []).map((f) => normalizeRel(f.path))
  if (!files.length) throw new Error('npm pack --json 没有返回文件清单')
  return { name: row.name, version: row.version, files }
}

async function httpJson(port, pathname, init) {
  const res = await fetch('http://127.0.0.1:' + String(port) + pathname, {
    ...init,
    signal: AbortSignal.timeout(8000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function getJson(port, pathname) {
  const r = await httpJson(port, pathname)
  return r.body || {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForGateway(port, pidBefore, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const health = await getJson(port, '/health')
      const pid = Number(health?.backend?.pid) || 0
      const uptime = Number(health?.backend?.uptimeMs) || 0
      if (pid && (pid !== pidBefore || uptime < 15000)) return { pid, uptimeMs: uptime, health }
    } catch {
      /* Gateway 正在换 pid */
    }
    await sleep(500)
  }
  return null
}

export async function verify(port) {
  const report = { port, health: null, status: null, catalog: null, ok: false, problems: [] }
  try {
    const health = await getJson(port, '/health')
    report.health = {
      pid: Number(health?.backend?.pid) || null,
      uptimeMs: Number(health?.backend?.uptimeMs) || null,
      verdict: health?.provenance?.verdict || null,
    }
    if (report.health.verdict !== 'current')
      report.problems.push('health.provenance.verdict=' + String(report.health.verdict))
  } catch (e) {
    report.problems.push('health 不可达：' + (e instanceof Error ? e.message : String(e)))
  }
  try {
    const status = await getJson(port, '/status')
    report.status = {
      pluginVersion: status?.pluginVersion || null,
      verdict: status?.provenance?.verdict || null,
      staleLayer: status?.provenance?.staleLayer || [],
    }
    if (report.status.verdict !== 'current')
      report.problems.push('status.provenance.verdict=' + String(report.status.verdict))
  } catch (e) {
    report.problems.push('/status 不可达：' + (e instanceof Error ? e.message : String(e)))
  }
  try {
    const r = await httpJson(port, '/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'catalog', args: {} }),
    })
    const result = r.body && r.body.result ? r.body.result : {}
    report.catalog = {
      opsCount: Number(result.ops_count) || null,
      families: Array.isArray(result.families) ? result.families.length : null,
    }
    if (!report.catalog.opsCount) report.problems.push('/plan catalog 没给 ops_count')
  } catch (e) {
    report.problems.push('/plan 不可达：' + (e instanceof Error ? e.message : String(e)))
  }
  report.ok = report.problems.length === 0
  return report
}

// ---------------------------------------------------------------- 安装动作

function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.files ? parsed : null
  } catch {
    return null
  }
}

async function loadReloadModule() {
  const file = path.join(REPO_ROOT, 'lib', 'host', 'reload', 'profile.js')
  if (!fs.existsSync(file)) return null
  const mod = await import(pathToFileURL(file).href)
  return typeof mod.triggerProfileHmr === 'function' ? mod : null
}

function build() {
  const npm = npmCommand()
  if (npm.shell === true) return runShell('npm run build', { cwd: REPO_ROOT })
  run(npm.cmd, [...npm.prefix, 'run', 'build'], { cwd: REPO_ROOT })
}

function ensureLinked(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const dep = parseDependency(pkg)
  const want = 'link:' + REPO_ROOT.replace(/\\/g, '/')
  const changed =
    !dep ||
    dep.kind !== 'link' ||
    String(dep.target || '').replace(/\\/g, '/') !== REPO_ROOT.replace(/\\/g, '/')
  if (!changed) return { changed: false, spec: want }
  const backup = pkgPath + '.bak-dsh-link-' + String(Date.now())
  fs.copyFileSync(pkgPath, backup)
  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies[PLUGIN_NAME] = want
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  const pnpm = process.env.DSH_PNPM || ''
  const install = 'install --prefer-offline'
  if (process.platform === 'win32' && !pnpm) runShell('pnpm ' + install, { cwd: profileDir })
  else run(pnpm || 'pnpm', install.split(' '), { cwd: profileDir })
  return { changed: true, spec: want, backup }
}

async function packMode(opts, profileDir, installedDir) {
  // dry-run 只算计划：不编译、不落盘。
  if (opts.build && !opts.dryRun) build()
  const listing = packFileList({ dryRun: true })
  const nextHashes = hashFiles(REPO_ROOT, listing.files)
  const missing = listing.files.filter((f) => !nextHashes[normalizeRel(f)])
  if (missing.length)
    throw new Error('发布清单里有文件在磁盘上读不到：' + missing.slice(0, 5).join(', '))
  const target = installedDir || depTarget(profileDir)
  if (!target)
    throw new Error('找不到安装目录（profile/node_modules/' + PLUGIN_NAME + ' 与依赖目标都不存在）')
  const previous = readManifest(target)
  const plan = mergePlan(previous ? previous.files : {}, nextHashes)
  const report = {
    mode: 'pack',
    version: listing.version,
    target,
    files: listing.files.length,
    copy: plan.copy.length,
    remove: plan.remove.length,
    keptProtected: plan.keptProtected.length,
    dryRun: opts.dryRun,
    backupManifest: previous ? true : false,
  }
  if (opts.dryRun) return report
  for (const rel of plan.copy) {
    const src = path.join(REPO_ROOT, ...rel.split('/'))
    const dst = path.join(target, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  for (const rel of plan.remove) {
    try {
      fs.rmSync(path.join(target, ...rel.split('/')), { force: true })
    } catch {
      /* 删不掉就留着，不影响运行 */
    }
  }
  const manifest = {
    name: listing.name,
    version: listing.version,
    installedAt: new Date().toISOString(),
    source: 'scripts/install-dsh.mjs --mode pack',
    files: nextHashes,
  }
  fs.writeFileSync(
    path.join(target, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
  return report
}

function depTarget(profileDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  const dep = parseDependency(pkg)
  if (!dep || !dep.target) return null
  const abs = path.normalize(
    path.isAbsolute(dep.target) ? dep.target : path.join(profileDir, dep.target),
  )
  try {
    return fs.statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

function withAddon(opts) {
  const roots = blenderExtensionsRoots()
  const picked = pickBlenderVersionDir(roots, opts.blenderVersion)
  if (!picked)
    return { ok: false, reason: '找不到 Blender 用户扩展目录（可用 --blender-version 指定）' }
  const dest = path.join(picked.dir, 'extensions', 'user_default', 'dsh_blender_bridge')
  if (opts.dryRun) return { ok: true, dryRun: true, dest }
  const src = path.join(REPO_ROOT, 'extension', 'dsh_blender_bridge')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (p) => !p.includes('__pycache__') && !p.endsWith('.pyc'),
  })
  return { ok: true, dest, blender: picked.name }
}

function printReport(report, opts) {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const lines = []
  lines.push(
    'DSH 插件安装 · ' + String(report.mode || 'verify') + (report.dryRun ? ' · dry-run' : ''),
  )
  if (report.profile) lines.push('profile  ' + report.profile)
  if (report.target) lines.push('target   ' + report.target)
  if (report.version) lines.push('version  ' + report.version)
  if (report.files)
    lines.push(
      'files    ' +
        String(report.files) +
        '（复制 ' +
        String(report.copy) +
        ' · 删除 ' +
        String(report.remove) +
        '）',
    )
  if (report.addon)
    lines.push(
      'addon    ' +
        (report.addon.ok ? String(report.addon.dest) : '未安装：' + String(report.addon.reason)),
    )
  if (report.reload)
    lines.push(
      'reload   ' +
        (report.reload.ok ? '已写 profile 触发 HMR' : '失败：' + String(report.reload.note)),
    )
  if (report.verify) {
    const v = report.verify
    lines.push(
      'verify   ' +
        (v.ok ? 'ok' : 'FAIL') +
        ' · plugin=' +
        String(v.status?.pluginVersion || '-') +
        ' · provenance=' +
        String(v.health?.verdict || '-') +
        '/' +
        String(v.status?.verdict || '-') +
        ' · catalog=' +
        String(v.catalog?.opsCount || '-') +
        ' ops / ' +
        String(v.catalog?.families || '-') +
        ' families' +
        ' · gateway pid=' +
        String(v.health?.pid || '-'),
    )
    if (!v.ok) for (const p of v.problems) lines.push('  ! ' + p)
  }
  lines.push('下一步   ' + report.next)
  console.log(lines.join('\n'))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }
  const port = opts.port || Number(process.env.DSH_BLENDER_HTTP_PORT) || DEFAULT_PORT
  const profileDir = resolveProfileDir({ profile: opts.profile })
  if (!profileDir) throw new Error('找不到 DSH profile（用 --profile 指定，或设 DSH_PROFILE_DIR）')
  const report = {
    profile: profileDir,
    port,
    mode: opts.verifyOnly ? 'verify' : opts.mode,
    dryRun: opts.dryRun,
  }

  if (opts.verifyOnly) {
    report.verify = await verify(port)
    report.next = report.verify.ok ? '无需操作' : '看上面的 ! 行；Gateway/插件没起来时先重启 DSH'
    printReport(report, opts)
    process.exitCode = report.verify.ok ? 0 : 1
    return
  }

  const installedDir = resolveInstalledDir(profileDir)
  if (opts.mode === 'link') {
    if (!opts.dryRun) {
      const linked = ensureLinked(profileDir)
      report.link = linked
      if (opts.build) build()
    } else {
      report.link = { dryRun: true, spec: 'link:' + REPO_ROOT }
    }
    report.target = REPO_ROOT
    report.mode = 'link'
  } else {
    const packed = await packMode({ ...opts }, profileDir, installedDir)
    Object.assign(report, packed)
  }

  const addon = opts.withAddon ? withAddon(opts) : null
  if (addon) report.addon = addon

  if (!opts.dryRun && opts.reload) {
    const pidBefore = await getJson(port, '/health')
      .then((h) => Number(h?.backend?.pid) || 0)
      .catch(() => 0)
    const reloadMod = await loadReloadModule()
    if (!reloadMod) {
      report.reload = {
        ok: false,
        note: 'lib/host/reload/profile.js 不存在（先 build，或去掉 --no-build）',
      }
    } else {
      const receipt = reloadMod.triggerProfileHmr({
        dir: profileDir,
        reason: 'install-dsh ' + String(report.version || report.mode),
      })
      report.reload = receipt
      if (receipt.ok) {
        const waited = await waitForGateway(port, pidBefore)
        report.reloadGateway = waited
          ? { pid: waited.pid, uptimeMs: waited.uptimeMs }
          : { pid: null, note: '45s 内没等到新 Gateway（可手动看 /health）' }
      }
    }
  }

  if (!opts.dryRun) report.verify = await verify(port)
  report.next = buildNextActions(report, opts)
  printReport(report, opts)
  process.exitCode = report.verify && !report.verify.ok ? 1 : 0
}

export function buildNextActions(report, opts = {}) {
  const actions = []
  if (opts.dryRun) actions.push('去掉 --dry-run 真正执行')
  else {
    const v = report.verify || {}
    if (v.status && v.status.pluginVersion) {
      actions.push('刷新 DSH 页面（新工具描述/面板）')
    }
    if (report.reloadGateway && report.reloadGateway.pid)
      actions.push('Gateway 已换代：若 blender_session 显示 0 会话，跑 action=attach 重新认领')
    if (opts.withAddon)
      actions.push('Blender 里 Scripting ▸ Reload Scripts（或重启）让扩展代码生效')
    if (!opts.withAddon)
      actions.push(
        'Blender 侧代码有变时：npm run dsh:install -- --with-addon，或在 Blender 里 Install from Disk',
      )
  }
  return actions.join('；')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error('install-dsh: ' + (e instanceof Error ? e.message : String(e)))
    process.exit(1)
  })
}
