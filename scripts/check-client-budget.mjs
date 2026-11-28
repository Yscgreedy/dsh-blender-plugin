#!/usr/bin/env node
// @ts-check
/**
 * scripts/check-client-budget.mjs —— 客户端 bundle 源文件的行 ratchet 门。
 *
 * `src/client/index.js` 是浏览器 bundle 的唯一源文件，按设计保持单文件
 * （scripts/build-client.mjs 原样写到 lib/client.js，不引入打包器），所以它天然不在
 * scripts/check-structure.mjs 的行预算范围内（那条门只扫 src 与 runtime 下的 .ts）。
 * 这条门给它一条只能降不能升的 ratchet：当前行数就是天花板，加行必须显式抬高
 * CLIENT_LINE_CEILING 并写清理由，而不是让文件继续无声膨胀。
 *
 * 口径与 check-structure.mjs 的行预算一致（`split(/\r?\n/).length`）：文件末尾的换行
 * 会形成一个空段，因此比 tests/helpers/docs.ts 的 lineCount（去掉末尾单个空行）多 1。
 * 这里沿用门口径，让天花板、输出与 docs/architecture.md 引用的 3058 是同一个数。
 *
 * 用法：
 *   node scripts/check-client-budget.mjs
 *     → PASS：打印与实际行数比，退出码 0
 *   DSH_CLIENT_LINE_CEILING=10 node scripts/check-client-budget.mjs
 *     → 超限：打印实际值/上限/差值，退出码 1（测试用它断言超限会红）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const REL = 'src/client/index.js'
const CLIENT = path.join(ROOT, 'src', 'client', 'index.js')

/**
 * ratchet：只能降。升必须在本行写理由，并同步 docs/architecture.md §9。
 * 2026-11-27 基线 3058 行：单文件产物是有意设计（无打包器），拆分尚未做。
 */
const CLIENT_LINE_CEILING = 3058

function die(message, code) {
  console.error(message)
  process.exit(code)
}

if (!fs.existsSync(CLIENT)) {
  die('check-client-budget: 找不到 ' + REL + '（cwd=' + ROOT + '）', 2)
}

// 行数口径见文件头：与 check-structure.mjs 的行预算一致。
const lines = fs.readFileSync(CLIENT, 'utf8').split(/\r?\n/).length

let ceiling = CLIENT_LINE_CEILING
const override = process.env.DSH_CLIENT_LINE_CEILING
if (override !== undefined && override !== '') {
  const parsed = Number(override)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    die('check-client-budget: DSH_CLIENT_LINE_CEILING 必须是正整数，收到 ' + override, 2)
  }
  ceiling = parsed
}

if (lines > ceiling) {
  const over = lines - ceiling
  die(
    'check-client-budget: FAIL — ' +
      REL +
      ' ' +
      lines +
      '/' +
      ceiling +
      ' 行（超出 ' +
      over +
      ' 行，ratchet 只许降）\n' +
      '  降回来或改天花板并说明理由：抬高 scripts/check-client-budget.mjs 的 CLIENT_LINE_CEILING，' +
      '并同步 docs/architecture.md §9。',
    1,
  )
}

console.log('check-client-budget: PASS — ' + REL + ' ' + lines + '/' + ceiling + ' 行（ratchet）')
