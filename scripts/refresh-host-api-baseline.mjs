#!/usr/bin/env node
// @ts-check
/**
 * scripts/refresh-host-api-baseline.mjs —— H-4：刷新 / 校验宿主 API 的冻结基线。
 *
 * 台账 H-4：解析链依赖全局安装的绝对路径，没有基线时"换安装位置"只能人工确认。
 * 基线记的是 **{package, version, 相对布局, 包根 hash}**（不含用户目录），比对逻辑在
 * src/host-api-baseline.ts（这里只负责写文件 / 打一行人读结论）。
 *
 * 用法：
 *   node scripts/refresh-host-api-baseline.mjs               # 写 config/host-api-baseline.json
 *   node scripts/refresh-host-api-baseline.mjs --check       # 只比对：drift 退出 1，其余 0
 *   node scripts/refresh-host-api-baseline.mjs --out <path>  # 写到别处（CI / 排障）
 *
 * 退出码：0 = 已写 / current（含 version_matches=false 的警告档）；1 = drift 或解析失败；2 = 参数错误。
 * 依赖 lib/ 构建产物：先走 scripts/ensure-build.mjs（与 check/test 同一把锁）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureBuild } from './ensure-build.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(ROOT, 'config', 'host-api-baseline.json')
const argv = process.argv.slice(2)
const CHECK_ONLY = argv.includes('--check')
const outIndex = argv.indexOf('--out')
const outArg = outIndex >= 0 ? argv[outIndex + 1] : null

if (outIndex >= 0 && (!outArg || outArg.startsWith('--'))) {
  console.error('refresh-host-api-baseline: --out 需要一个路径参数')
  process.exit(2)
}

const OUT = outArg ? path.resolve(ROOT, outArg) : DEFAULT_OUT

if (!ensureBuild()) {
  console.error('refresh-host-api-baseline: lib/ 构建失败，无法解析宿主 API')
  process.exit(1)
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'host-api-baseline.js')).href)

function pluginVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

if (CHECK_ONLY) {
  const verdict = mod.hostApiBaselineView({ baselinePath: OUT })
  const expected = verdict.expected || {}
  const actual = verdict.actual || {}
  console.log(
    'host-api baseline: status=' +
      verdict.status +
      ' reason=' +
      verdict.reason +
      ' version_matches=' +
      String(verdict.version_matches) +
      ' expected=' +
      String(expected.version || '-') +
      ' actual=' +
      String(actual.version || '-'),
  )
  if (verdict.status === 'drift') {
    console.error(
      '  expected ' +
        String(expected.pathSuffix || expected.pathHash || '-') +
        ' / actual ' +
        String(actual.pathSuffix || actual.pathHash || '-'),
    )
    console.error('  确认新安装位置后：node scripts/refresh-host-api-baseline.mjs')
    process.exit(1)
  }
  process.exit(0)
}

const snapshot = mod.hostApiBaselineSnapshot({ pluginVersion: pluginVersion() })
if (!snapshot) {
  console.error('host-api baseline: 解析失败（@deepseek-ai/dsh-tools 解析不到），未写基线')
  process.exit(1)
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
console.log(
  'host-api baseline: wrote ' +
    path.relative(ROOT, OUT) +
    ' (' +
    snapshot.package +
    '@' +
    snapshot.hostApiVersion +
    ' · ' +
    String(snapshot.pathSuffix || snapshot.pathHash) +
    ')',
)
