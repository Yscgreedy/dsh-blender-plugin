import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CONTRACT_ROUTES } from '../../../../runtime/http/routes/index.js'
import { pkgPath } from '../../../helpers/pkg'

// 路由字面量消费者门（route literal consumers）。
//
// CONTRACT_ROUTES（runtime/http/routes/index.ts）是 29 条对外路由的唯一真源，但消费者是手写字符串：
//   · src/tools/**/*.ts 的 backendPost / backendGet / backendJson 第二个实参；
//   · src/client/index.js 的 fetch 端点（浏览器 bundle 直接拼 backend() + '/lease'）。
// 把 '/job' 写成 '/jobs' 编译不报错、夹具测试也未必覆盖，所以这里把两处字面量拉回来对表：
// 去掉 query（split('?')[0]）后必须 ∈ CONTRACT_ROUTES ∪ {'/host'}（前缀路由），
// 动态拼接只允许落在下面 PREFIX_RULES 声明的路由树下面。
//
// 断言失败信息统一是 `文件:行: 路径`，便于直接定位。

interface PathLiteral {
  /** 相对仓库根的正斜杠路径 */
  file: string
  line: number
  literal: string
}

/**
 * 前缀规则：一条规则一行，动态拼接的路径只能落在契约已声明的路由树下面。
 * 例：client 的 '/host/jobs?limit=' + n、'/host/jobs/log?id=' + id、'/host/scene-items?q=' + q。
 */
const PREFIX_RULES = [
  '/host/jobs', // src/client/index.js opsUrlJobs(): '/host/jobs?limit=' + n
  '/host/jobs/log', // src/client/index.js opsUrlJobLog(): '/host/jobs/log?id=' + ... + '&tail=' + ...
  '/host/scene-items', // src/client/index.js: '/host/scene-items?q=' + encodeURIComponent(q)
]

/** Gateway 用同一个 handler 覆盖 '/host' 下面未单独注册的子路径。 */
const HOST_PREFIX = '/host'

/**
 * 非字面量调用点白名单（当前为空）：backend* 的路径写成变量时静态门看不进去。
 * 保持路径字面量是首选；确实要传变量时在这里按 '文件:行' 登记（行号变了也要改这里）。
 */
const NON_LITERAL_CALLS: string[] = []

/** 不是端点、只是路径分隔符的字面量（'/' + x、lastIndexOf('/')）。 */
const NON_ENDPOINT_LITERALS = new Set(['/'])

/** 消费端扫描根：工具、宿主生命周期。 */
const BACKEND_SCAN_ROOTS = ['src/tools', 'src/host']

/** src/host/http.ts 是 backend* 的实现本身（路径参数是变量），不是消费端。 */
const BACKEND_SCAN_SKIP = new Set(['src/host/http.ts'])

const CONTRACT = new Set(CONTRACT_ROUTES)

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/** backend* 调用开口（含多行写法：路径实参可以落在下一行）。 */
const BACKEND_CALL = /\bbackend(?:Post|Get|Json)\s*\(/g
/** 紧跟在调用开口后的 "端口, '路径'" —— 端口是 port / input.port 这类简单表达式。 */
const BACKEND_PATH_ARG = /^\s*[^,()]+?\s*,\s*(['"])(\/[^'"\n]*)\1/

const CLIENT_LITERAL = /(['"])(\/[^'"\n]*)\1/g

interface BackendScan {
  literals: PathLiteral[]
  /** 路径不是字面量的调用点（'文件:行'） */
  nonLiteral: string[]
}

function scanBackendCalls(): BackendScan {
  const literals: PathLiteral[] = []
  const nonLiteral: string[] = []
  const files = BACKEND_SCAN_ROOTS.flatMap((root) => walkTs(pkgPath(root)))
  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8')
    const file = toPosix(path.relative(pkgPath(), abs))
    if (BACKEND_SCAN_SKIP.has(file)) continue
    BACKEND_CALL.lastIndex = 0
    let call: RegExpExecArray | null
    while ((call = BACKEND_CALL.exec(text)) !== null) {
      const line = lineOf(text, call.index)
      const window = text.slice(call.index + call[0].length, call.index + call[0].length + 400)
      const arg = window.match(BACKEND_PATH_ARG)
      if (arg) literals.push({ file, line, literal: arg[2] })
      else nonLiteral.push(file + ':' + line)
    }
  }
  return { literals, nonLiteral }
}

/**
 * 客户端 bundle 里以 '/' 开头的单/双引号字符串。
 * 只取真实 JS 字符串字面量：这个文件里的反引号串都在注释/模板里，不是端点。
 */
function scanClientLiterals(): PathLiteral[] {
  const file = 'src/client/index.js'
  const text = fs.readFileSync(pkgPath(file), 'utf8')
  const out: PathLiteral[] = []
  CLIENT_LITERAL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CLIENT_LITERAL.exec(text)) !== null) {
    if (NON_ENDPOINT_LITERALS.has(match[2])) continue
    out.push({ file, line: lineOf(text, match.index), literal: match[2] })
  }
  return out
}

/** 去掉 query 后：契约成员、'/host' 前缀路由、或 PREFIX_RULES 下面的子路径。 */
function isContractPath(literal: string): boolean {
  const bare = literal.split('?')[0]
  if (bare === HOST_PREFIX) return true
  if (CONTRACT.has(bare)) return true
  return PREFIX_RULES.some((rule) => bare === rule || bare.startsWith(rule + '/'))
}

function offenders(literals: PathLiteral[]): string[] {
  return literals
    .filter((item) => !isContractPath(item.literal))
    .map((item) => item.file + ':' + item.line + ': ' + item.literal)
}

describe('route literal consumers', () => {
  it('keeps every backend* path literal inside the contract routes', () => {
    const scan = scanBackendCalls()
    expect(
      scan.nonLiteral,
      'backend* 的路径必须是字面量，否则静态门看不进去；确需传变量请登记 NON_LITERAL_CALLS：' +
        scan.nonLiteral.join(', '),
    ).toEqual(NON_LITERAL_CALLS)
    // 防真空：正则会随调用形态变化失真，扫到 0 条不是"通过"。
    expect(
      scan.literals.length,
      '消费端没扫到 backend* 路径字面量，提取规则已失真',
      // 删掉 src/headless/receipts/** 后是 24（少了 /headless ×1、/job ×3）：
      // 低于它说明扫描根或 backend* 提取规则又失真了。
    ).toBeGreaterThanOrEqual(24)
    const bad = offenders(scan.literals)
    expect(bad, '路由字面量不在 CONTRACT_ROUTES 里（改路径或改契约）：\n' + bad.join('\n')).toEqual(
      [],
    )
  })

  it('keeps every client endpoint literal inside the contract routes', () => {
    const literals = scanClientLiterals()
    expect(
      literals.length,
      'src/client/index.js 没扫到端点字面量，提取规则已失真',
    ).toBeGreaterThanOrEqual(12)
    const bad = offenders(literals)
    expect(bad, '客户端端点不在 CONTRACT_ROUTES 里（改路径或改契约）：\n' + bad.join('\n')).toEqual(
      [],
    )
  })

  it('only extends routes the contract already advertises', () => {
    for (const rule of PREFIX_RULES) expect(CONTRACT.has(rule), rule + ' 不是契约路由').toBe(true)
  })

  it('accepts declared paths and rejects unknown ones', () => {
    expect(isContractPath('/job')).toBe(true)
    expect(isContractPath('/status?evidence=1')).toBe(true)
    expect(isContractPath('/host')).toBe(true)
    expect(isContractPath('/host/jobs?limit=6')).toBe(true)
    expect(isContractPath('/host/jobs/abc123')).toBe(true) // 前缀路由下的子路径
    expect(isContractPath('/jobs')).toBe(false) // 契约里是 /job
    expect(isContractPath('/host/jobsX')).toBe(false) // 前缀必须有边界
    expect(isContractPath('/nope')).toBe(false)
  })
})
