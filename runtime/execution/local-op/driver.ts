// 本地车道：op 名 + 参数 → headless 作业脚本（K 内核由队列执行器注入）。
//
// 作业里真正碰 bpy 的是这几行调用；回执语义（ok/verdict/evidence）全部落在
// runtime/py/core/local_op/driver.py —— 那份源码在这里内联，避免给 modules.json
// 增加一个公开模块（布局契约按目录对拍）。
import fs from 'node:fs'
import path from 'node:path'
import { PY_ROOT } from '../../paths.js'
import { localOpTarget } from './table.js'
import type { LocalOpTarget } from './table.js'

const DRIVER_FILE = path.join(PY_ROOT, 'py', 'core', 'local_op', 'driver.py')
/** 驱动在作业命名空间里的私有名字：不把 parse_result / receipt 撒进 globals。 */
const DRIVER_NS = '__dsh_local_op'
const NL = String.fromCharCode(10)

export interface LocalOpJob {
  op: string
  mode: LocalOpTarget['mode']
  api: string
  sub: string
  preloads: string[]
  script: string
}

/** 驱动源码（缺文件时给一句能照着修的错，而不是让作业跑到一半 NameError）。 */
export function driverSource(): string {
  try {
    return fs.readFileSync(DRIVER_FILE, 'utf8')
  } catch (e) {
    throw new Error(
      '本地车道驱动缺失：' +
        DRIVER_FILE +
        '（' +
        (e instanceof Error ? e.message : String(e)) +
        '）—— 作业未提交',
      { cause: e },
    )
  }
}

/** 把驱动源码 exec 进私有命名空间（与 preload 模块同一套注入手法）。 */
function driverPrelude(source: string): string[] {
  return [
    '# ---- 本地无 GUI 车道驱动（runtime/py/core/local_op/driver.py）----',
    DRIVER_NS +
      ' = {"__name__": "local_op.driver", "__file__": ' +
      JSON.stringify(DRIVER_FILE) +
      '}',
    'exec(compile(' + JSON.stringify(source) + ', "driver.py", "exec"), ' + DRIVER_NS + ')',
  ]
}

/** 车道保留键：file= 先打开哪个 .blend / dry_run= 本地校验，二者都不该进 op 的 kwargs。 */
const RESERVED_KEYS = ['file', 'dry_run']

function opArgsOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('catalog_op 的 op_args 只认 JSON 对象（收到 ' + typeof value + '）')
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const key of RESERVED_KEYS) delete out[key]
  return out
}

/** 目标 op 的调用语句（dispatch 走 dispatch(sub, json)；montage 走显式函数）。 */
function callLines(target: LocalOpTarget): string[] {
  const api = '_dsh_lo_api'
  if (target.mode === 'montage')
    return [
      '    if isinstance(_dsh_lo_args, dict) and isinstance(_dsh_lo_args.get("args"), dict):',
      '        _dsh_lo_args = _dsh_lo_args["args"]',
      '    _dsh_lo_res = ' + api + '[' + JSON.stringify(target.sub) + '](**_dsh_lo_args)',
    ]
  return [
    '    _dsh_lo_res = ' +
      api +
      '["dispatch"](' +
      JSON.stringify(target.sub) +
      ', _dsh_lo_json.dumps(_dsh_lo_args))',
  ]
}

/**
 * 把一次车道提交展开成作业脚本。
 *
 * 参数是队列作业的 params（catalog_op / catalog_file / op_args）；file 由调用方
 * 预检过存在性，这里只校验它不为空 —— 路径解析与存在性检查是队列执行器的事。
 */
export function buildLocalOpJob(params: Record<string, unknown>): LocalOpJob {
  const op = String(params.catalog_op || '').trim()
  if (!op) throw new Error('catalog_op 不能为空（本地车道需要一个 op 名）')
  if (params.script !== undefined || params.script_file !== undefined)
    throw new Error('catalog_op 与 script/script_file 互斥：车道自己生成脚本')
  const target = localOpTarget(op)
  if (!target)
    throw new Error(
      'op ' +
        op +
        ' 不在本地车道白名单里（可用：' +
        ['audit_mesh', 'img_*', 'visualreport_report', 'qc_render_views', 'montage'].join(' / ') +
        '）',
    )
  const file = String(params.file || '').trim()
  if (!file) throw new Error('本地车道需要 file（存在的 .blend 路径），收到空值')
  const opArgs = opArgsOf(params.op_args)
  const lines = [
    ...driverPrelude(driverSource()),
    'import json as _dsh_lo_json',
    '_dsh_lo_op = ' + JSON.stringify(target.op),
    '_dsh_lo_file = ' + JSON.stringify(file),
    '_dsh_lo_args = _dsh_lo_json.loads(' + JSON.stringify(JSON.stringify(opArgs)) + ')',
    'try:',
    '    _dsh_lo_api = getattr(K, ' + JSON.stringify(target.api) + ')',
    ...callLines(target),
    'except BaseException as _dsh_lo_err:',
    '    import traceback as _dsh_lo_tb',
    '    print("HEADLESS " + ' +
      DRIVER_NS +
      '["dumps"](' +
      DRIVER_NS +
      '["failure_receipt"](_dsh_lo_op, _dsh_lo_file, _dsh_lo_err, _dsh_lo_tb.format_exc())), flush=True)',
    '    raise SystemExit(3)',
    'print("HEADLESS " + ' +
      DRIVER_NS +
      '["dumps"](' +
      DRIVER_NS +
      '["receipt"](_dsh_lo_op, _dsh_lo_file, _dsh_lo_res)), flush=True)',
  ]
  return {
    op: target.op,
    mode: target.mode,
    api: target.api,
    sub: target.sub,
    preloads: [...target.preload],
    script: lines.join(NL) + NL,
  }
}

export { DRIVER_FILE, DRIVER_NS }
