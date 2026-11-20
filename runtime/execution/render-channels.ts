/**
 * render channels：render / alpha / mask / ink 的通道尾段与三态回执。
 *
 * 台账验收（docs/archive/2026-11-20-角色动画与卡通渲染需求.md 第 72-74 行）：`blender_run kind=render`
 * 支持 `channels:["render","alpha","mask","ink"]`，每通道给路径 + foreground_px /
 * coverage / n_components / bbox；缺 ink 对象时该通道 skipped，整体 verdict=degraded 而不是 fail。
 *
 * 分工：
 *   - 这里只做**参数/回执**（纯函数）：命令尾段、CHANNELS 标记解析、verdict 合成、repro；
 *   - 指标本身由 runtime/py/render/channels_impl/metrics.py 在渲染进程内用 numpy 算（无 cv2）；
 *   - 三态判据放在 JS：Python 侧只报每通道 status/metrics/reason，判定集中一处。
 */
import path from 'node:path'
import { isArray, isRecord } from '../core/json.js'
import { PY_ROOT } from '../paths.js'

/** 允许的通道名（模型面 invalid_params 的允许列表就取这一份）。 */
export const CHANNEL_NAMES = ['render', 'alpha', 'mask', 'ink'] as const
export type ChannelName = (typeof CHANNEL_NAMES)[number]
export type ChannelStatus = 'ok' | 'skipped' | 'error'
export type ChannelVerdict = 'pass' | 'degraded' | 'fail'

export interface ChannelMetrics {
  foreground_px: number
  coverage: number
  n_components: number
  bbox: number[] | null
}

export interface ChannelEntry {
  name: string
  status: ChannelStatus
  path: string | null
  metrics: ChannelMetrics | null
  reason: string | null
}

export interface ChannelEvidence extends Record<string, unknown> {
  requested: string[]
  channels: ChannelEntry[]
  skipped: string[]
  missing: string[]
  ink_objects: string[]
  frame: number | null
  channels_receipt: 'present' | 'missing' | 'malformed'
}

export interface ChannelReceipt extends Record<string, unknown> {
  verdict: ChannelVerdict
  channels: ChannelEntry[]
  evidence: ChannelEvidence
  repro: string
}

/** 请求的通道（去空白、去重、保序）；没有就给空数组（旧行为：不加尾段）。 */
export function requestedChannels(params: Record<string, unknown>): string[] {
  const raw = params.channels
  if (!isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const name = String(item ?? '').trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** 从 stdout 里取最后一条 `CHANNELS {json}` 标记（渲染进程的唯一结构化出口）。 */
export function parseChannelMarker(stdout: string): unknown {
  const matches = String(stdout || '').match(/^CHANNELS (\{.*\})\r?$/gm)
  if (!matches || matches.length === 0) return undefined
  const last = matches[matches.length - 1].slice('CHANNELS '.length)
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

/**
 * channels_impl/metrics.py 在渲染进程内的收尾片段：按 __file__ 定位 exec（不登记 modules.json），
 * 算完打印一条 CHANNELS 标记。异常也要打印标记，否则"作业过了却没有任何证据"。
 */
export function channelsPostlude(params: Record<string, unknown>, outdir: string | null): string[] {
  const channels = requestedChannels(params)
  if (channels.length === 0) return []
  const spec = { channels, outdir, file: params.file ?? null }
  const script = [
    'import json as _dsh_cjson',
    '_dsh_channels_py = ' +
      JSON.stringify(path.join(PY_ROOT, 'py', 'render', 'channels_impl', 'metrics.py')),
    '_dsh_channels_spec = _dsh_cjson.loads(' + JSON.stringify(JSON.stringify(spec)) + ')',
    'try:',
    '    _dsh_cns = {"__name__": "dsh_render_channels", "__file__": _dsh_channels_py}',
    '    with open(_dsh_channels_py, encoding="utf-8") as _dsh_cfh:',
    '        exec(compile(_dsh_cfh.read(), _dsh_channels_py, "exec"), _dsh_cns)',
    '    _dsh_cres = _dsh_cns["run_channels"](_dsh_channels_spec)',
    'except Exception as _dsh_ce:',
    '    _dsh_cres = {"ok": False, "channels": [],',
    '                 "error": "%s: %s" % (type(_dsh_ce).__name__, str(_dsh_ce)[:300])}',
    'print("CHANNELS " + _dsh_cjson.dumps(_dsh_cres, ensure_ascii=False, default=str), flush=True)',
  ].join(String.fromCharCode(10))
  return ['--python-expr', script]
}

function jsonLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isArray(value)) return '[' + value.map(jsonLiteral).join(',') + ']'
  if (isRecord(value)) return JSON.stringify(value)
  return JSON.stringify(String(value))
}

/** 复现命令：同一组参数再 submit 一次（台账要求回执里能直接抄）。 */
export function channelRepro(params: Record<string, unknown>): string {
  const order = [
    'file',
    'frames',
    'resolution',
    'samples',
    'engine',
    'format',
    'camera',
    'output',
    'outdir',
    'channels',
  ]
  const parts = ['action="submit"', 'kind="render"']
  for (const key of order) {
    const value = params[key]
    if (value === undefined || value === null || String(value).trim() === '') continue
    parts.push(key + '=' + jsonLiteral(value))
  }
  if (!parts.some((p) => p.startsWith('channels='))) parts.push('channels=["render"]')
  return 'blender_run(' + parts.join(', ') + ')'
}

function asMetrics(raw: unknown): ChannelMetrics | null {
  if (!isRecord(raw)) return null
  const px = Number(raw.foreground_px)
  const coverage = Number(raw.coverage)
  const components = Number(raw.n_components)
  const bbox = isArray(raw.bbox) ? raw.bbox.map(Number).filter((n) => Number.isFinite(n)) : null
  return {
    foreground_px: Number.isFinite(px) ? px : 0,
    coverage: Number.isFinite(coverage) ? coverage : 0,
    n_components: Number.isFinite(components) ? components : 0,
    bbox: bbox && bbox.length === 4 ? bbox : null,
  }
}

function asEntry(raw: unknown): ChannelEntry | null {
  if (!isRecord(raw)) return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const status =
    raw.status === 'ok' || raw.status === 'skipped' || raw.status === 'error' ? raw.status : 'error'
  const reason = raw.reason === undefined || raw.reason === null ? null : String(raw.reason)
  return {
    name,
    status,
    path: raw.path === undefined || raw.path === null ? null : String(raw.path),
    metrics: asMetrics(raw.metrics),
    reason,
  }
}

function stringList(raw: unknown): string[] {
  return isArray(raw) ? raw.map((v) => String(v)).filter(Boolean) : []
}

/**
 * 三态判定：render 底图没了才是 fail；缺通道（skipped/error/没回）一律 degraded。
 * degraded ≠ 通过（AGENTS 硬规则），所以 skipped 的 ink 不会把作业写成完成态通过。
 */
function verdictOf(entries: ChannelEntry[], requested: string[]): ChannelVerdict {
  const render = entries.find((e) => e.name === 'render')
  if (requested.includes('render') && (!render || render.status !== 'ok')) return 'fail'
  if (entries.some((e) => e.status !== 'ok')) return 'degraded'
  const missing = requested.filter((name) => !entries.some((e) => e.name === name))
  return missing.length > 0 ? 'degraded' : 'pass'
}

/** 作业 stdout → 回执：先取 CHANNELS 标记再折成回执；没请求通道时返回 null（旧作业不变）。 */
export function channelReceiptFor(
  params: Record<string, unknown>,
  stdout: string,
): ChannelReceipt | null {
  return channelReceiptFrom(parseChannelMarker(stdout), params)
}

/** CHANNELS 标记 → 回执（verdict / 每通道 evidence / repro）。没有请求通道时返回 null。 */
export function channelReceiptFrom(
  payload: unknown,
  params: Record<string, unknown>,
): ChannelReceipt | null {
  const requested = requestedChannels(params)
  if (requested.length === 0) return null
  const repro = channelRepro(params)
  const missingReceipt: ChannelEvidence = {
    requested,
    channels: [],
    skipped: [],
    missing: requested,
    ink_objects: [],
    frame: null,
    channels_receipt: 'missing',
  }
  if (!isRecord(payload)) {
    return { verdict: 'degraded', channels: [], evidence: missingReceipt, repro }
  }
  const entries = (isArray(payload.channels) ? payload.channels : [])
    .map(asEntry)
    .filter((e): e is ChannelEntry => e !== null)
  const missing = requested.filter((name) => !entries.some((e) => e.name === name))
  const receiptState = payload.ok === false ? 'malformed' : 'present'
  const evidence: ChannelEvidence = {
    requested,
    channels: entries,
    skipped: entries.filter((e) => e.status === 'skipped').map((e) => e.name),
    missing,
    ink_objects: stringList(payload.ink_objects),
    frame: Number.isFinite(Number(payload.frame)) ? Number(payload.frame) : null,
    channels_receipt: receiptState,
    ...(payload.error === undefined ? {} : { error: String(payload.error) }),
  }
  return { verdict: verdictOf(entries, requested), channels: entries, evidence, repro }
}
