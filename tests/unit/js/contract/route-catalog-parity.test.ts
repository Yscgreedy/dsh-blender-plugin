import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GuiRoute } from '../../../../runtime/contracts/routes.generated.js'
import { PLAN_READ_ONLY_OPS, planOpNames } from '../../../../runtime/engine.js'
import { pkgPath } from '../../../helpers/pkg'

// routing ↔ catalog 双向 ratchet。
//
// config/routing.json 可以命名一个 catalog 根本不认识的 op（shape_solve），catalog 也可以长出
// 没人路由得到的 op（除空前缀 catch-all 外没人接）。这两种漂移今天只在运行时才暴露，所以这里把
// 两份清单拉回来对表：
//   ① 每个 match:"exact" 的 op 必须是已知 op 名（catalog 家族 op + 独立 plan op），或者在
//      ROUTING_ONLY_OPS 里逐条登记（每条带理由与它落到的 catalog op）；
//   ② 空前缀的 prefix 路由只允许 ext-contract 一条，而且必须是 routes 最后一条 ——
//      catch-all 在表中间会把后面所有路由变成死行；
//   ③ catalog op 名的重复项必须恰好是 ['help']（montage 家族与 ext 空前缀家族的 help 撞名；
//      再多一个重复，同名 op 在 routing 里必然有一条被另一条抢先）。
// 另外两条小门：登记表里的名字不能同时又进了 catalog；登记表本身不许写空/写重。
// 失败信息统一是 config/routing.json:<行>（route <id>）：<op>，直接可定位。

const ROUTING_FILE = 'config/routing.json'
const ROUTING_TEXT = fs.readFileSync(pkgPath('config', 'routing.json'), 'utf8')
const ROUTING = JSON.parse(ROUTING_TEXT) as { routes: GuiRoute[] }
const ROUTES = ROUTING.routes

/** 空前缀 catch-all 的唯一允许 id（ext 族的契约兜底路由）。 */
const CATCH_ALL_ID = 'ext-contract'

/** catalog 允许的唯一重复 op 名：montage.help 与 ext（空前缀）家族的 help。 */
const ALLOWED_DUPLICATES = ['help']

/**
 * routing-only 的 exact op 声明表：catalog 里没有同名 op，但 routing 明确要用。
 * 每一条都要写清理由（它落到哪个 catalog op 上）。新增 exact 路由却忘了在 catalog 落名，
 * ① 会失败并点名 route id 与行号；反过来，这些名字进了 catalog 就该把条目删掉。
 */
interface RoutingOnlyOp {
  op: string
  reason: string
}

const ROUTING_ONLY_OPS: readonly RoutingOnlyOp[] = [
  {
    op: 'audit_clash_all',
    reason:
      'Python asm_scan 的公开别名（assembly_impl/dispatch.py: _ALIASES["audit_clash_all"] = "scan"）；catalog 名是 asm_scan',
  },
  {
    op: 'fix_clash',
    reason:
      'Python asm_repair 的公开别名（assembly_impl/dispatch.py: _ALIASES["fix_clash"] = "repair"）；catalog 名是 asm_repair',
  },
  {
    op: 'shape_solve',
    reason: 'shapesolve 族的旧入口名；exact 路由直挂 sub=solve（catalog 名是 shapesolve_solve）',
  },
  {
    op: 'model_deliver',
    reason: 'gate 投递门的旧入口名；exact 路由直挂 sub=deliver（catalog 名是 gate_deliver）',
  },
]

/** catalog 认的名字：家族 op（planOpNames）+ 独立 plan op（PLAN_READ_ONLY_OPS）。 */
const CATALOG_OPS = new Set<string>([...planOpNames(), ...PLAN_READ_ONLY_OPS])

/** exact 路由允许出现的全部名字：catalog 名 + 声明表。 */
const KNOWN_OPS = new Set<string>([...CATALOG_OPS, ...ROUTING_ONLY_OPS.map((entry) => entry.op)])

/** routing.json 里某条路由 id 所在行（id 唯一，文件是 prettier 格式化过的）。 */
function lineOfRoute(text: string, id: string): number {
  const index = text.indexOf('"id": ' + JSON.stringify(id))
  if (index < 0) return 0
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/** 统一的定位前缀：文件:行（route id）。 */
function at(text: string, route: GuiRoute): string {
  return ROUTING_FILE + ':' + lineOfRoute(text, route.id) + '（route ' + route.id + '）'
}

/** ① exact 路由的 op 必须在已知名单里。 */
function exactOpFailures(routes: GuiRoute[], known: Set<string>, text: string): string[] {
  const failures: string[] = []
  for (const route of routes) {
    if (route.match !== 'exact') continue
    const op = String(route.op === null || route.op === undefined ? '' : route.op)
    if (!op) {
      failures.push(at(text, route) + '：exact 路由缺少 op')
      continue
    }
    if (!known.has(op))
      failures.push(
        at(text, route) +
          '：exact op "' +
          op +
          '" 不在 catalog op 名里，也没在 ROUTING_ONLY_OPS 登记',
      )
  }
  return failures
}

/** ② 空前缀 prefix 路由只能有一条 ext-contract，且必须在表尾。 */
function catchAllFailures(routes: GuiRoute[], text: string): string[] {
  const failures: string[] = []
  const empty = routes.filter((route) => route.match === 'prefix' && route.prefix === '')
  if (empty.length === 0)
    return ['config/routing.json：没有空前缀 catch-all 路由（应为 ' + CATCH_ALL_ID + '）']
  if (empty.length > 1)
    failures.push(
      'config/routing.json：空前缀 prefix 路由只能有一条，实际 ' +
        empty.length +
        ' 条（' +
        empty.map((route) => route.id).join(', ') +
        '）',
    )
  for (const route of empty) {
    if (route.id !== CATCH_ALL_ID)
      failures.push(at(text, route) + '：空前缀 prefix 路由只允许 ' + CATCH_ALL_ID)
    if (routes[routes.length - 1] !== route)
      failures.push(at(text, route) + '：catch-all 必须在 routes 表尾（后面还有路由）')
  }
  const last = routes[routes.length - 1]
  if (last && last.id !== CATCH_ALL_ID)
    failures.push('config/routing.json：routes 表尾必须是 ' + CATCH_ALL_ID + '，实际是 ' + last.id)
  return failures
}

/** ③ catalog op 名的重复项必须恰好是 ALLOWED_DUPLICATES。 */
function duplicateFailures(names: string[], allowed: string[]): string[] {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
  if (duplicates.join(',') === allowed.join(',')) return []
  return [
    'catalog op 名重复项变了：允许 ' +
      JSON.stringify(allowed) +
      '，实际 ' +
      JSON.stringify(duplicates) +
      '（同名 op 在 routing 表里一定有一条被抢先）',
  ]
}

describe('routing ↔ catalog ratchet', () => {
  it('each exact route op is a catalog op name or a declared routing-only alias', () => {
    const failures = exactOpFailures(ROUTES, KNOWN_OPS, ROUTING_TEXT)
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('keeps the empty-prefix catch-all unique and last', () => {
    const failures = catchAllFailures(ROUTES, ROUTING_TEXT)
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('keeps catalog op-name duplicates exactly [help]', () => {
    const failures = duplicateFailures(planOpNames(), ALLOWED_DUPLICATES)
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('keeps declared routing-only ops out of the catalog', () => {
    const stale = ROUTING_ONLY_OPS.filter((entry) => CATALOG_OPS.has(entry.op)).map((e) => e.op)
    expect(
      stale,
      '这些名字已经在 catalog 里了，请从 ROUTING_ONLY_OPS 删掉：' + stale.join(', '),
    ).toEqual([])
  })

  it('declares every routing-only op once, with a reason', () => {
    const ops = ROUTING_ONLY_OPS.map((entry) => entry.op)
    expect(new Set(ops).size, 'ROUTING_ONLY_OPS 里有重复条目：' + ops.join(', ')).toBe(ops.length)
    for (const entry of ROUTING_ONLY_OPS) {
      expect(entry.op.trim().length, 'ROUTING_ONLY_OPS 条目缺 op').toBeGreaterThan(0)
      expect(entry.reason.trim().length, entry.op + ' 没写 reason').toBeGreaterThan(0)
    }
  })
})

// 失败信息自检：新加一条 catalog 里没有的 exact op，必须同时报出 op 名、route id 与行号。
describe('routing ↔ catalog ratchet failure messages', () => {
  const TEXT = [
    '{',
    '  "routes": [',
    '    { "id": "nope-route", "match": "exact", "op": "nope_op" }',
    '  ]',
    '}',
  ].join('\n')
  const ROUTE = [{ id: 'nope-route', match: 'exact', op: 'nope_op', prefix: '' } as GuiRoute]

  it('names the op, the route id and the line for an unknown exact op', () => {
    const failures = exactOpFailures(ROUTE, KNOWN_OPS, TEXT)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('nope_op')
    expect(failures[0]).toContain('nope-route')
    expect(failures[0]).toContain(ROUTING_FILE + ':3')
  })

  it('names the route when the catch-all is not last', () => {
    const rows = [
      { id: 'ext-contract', match: 'prefix', op: null, prefix: '' } as GuiRoute,
      { id: 'later', match: 'prefix', op: null, prefix: 'later_' } as GuiRoute,
    ]
    const failures = catchAllFailures(rows, TEXT)
    expect(failures.join('\n')).toContain('ext-contract')
    expect(failures.join('\n')).toContain(ROUTING_FILE + ':0（route ext-contract）')
  })

  it('reports a new duplicate catalog op name', () => {
    const failures = duplicateFailures(['help', 'help', 'montage', 'montage'], ALLOWED_DUPLICATES)
    expect(failures.join('\n')).toContain('["help","montage"]')
  })
})
