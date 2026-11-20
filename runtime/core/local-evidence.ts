/**
 * 本地进程 / 端口证据（"list 0 会话"与"doctor no-addon"也要能看见环境）。
 *
 * 为什么放进 Gateway：39877 的监听 pid 必须是**本进程**（process.pid），只有 Gateway 自己知道；
 * 宿主侧只能从 /health 猜。宿主拿到的是一份事实投影。
 *
 * 稳定契约（验收口径，文档见 docs/操作教程.md）：
 *   GET /status?evidence=1&evidenceOnly=1 →
 *     local_evidence.sessions          []（未认领时长度 0）
 *     local_evidence.local_processes   [{pid, name, role: gateway|worker|addon|win_proxy|other, port}]
 *     local_evidence.ports             [{port, listening, pids[], process, role}]
 *     local_evidence.ports_evidence    {source: netstat|fixture, scanned_at: ISO8601, ...}
 *     local_evidence.degraded          bool（空数组必须 true + error）
 *
 * 三条纪律（9877 误报那次现场的 3.0.x 历史教训）：
 *   ① 端口 → 进程必须互相印证：监听行给 pid，进程表必须能给出同名条目；对不上的一律不认。
 *   ② 9877 是 3.0.x 旧后端，**不是判据**：expected=false / counts_as_gateway=false。
 *   ③ 探不到就 degraded + error，端口 listening=false（不是"关着"），不拿空数组冒充正常。
 *      每次扫描带超时与输出上限（netstat/tasklist 是子进程，输出可能很大）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { CFG } from '../config.js'

export const GATEWAY_PORT_DEFAULT = 39877
export const WORKER_PORT_DEFAULT = 9879
export const LEGACY_PORT_DEFAULT = 9877
export const EVIDENCE_FIXTURE_SCHEMA = 1
/** 单次扫描的输出上限（字符）：连接多的机器 netstat 能到几百 KB，超过就截断并标 degraded。 */
export const MAX_SCAN_CHARS = 512 * 1024
export const MAX_ROWS = 500
const IS_WIN = process.platform === 'win32'

export type PortRole = 'gateway' | 'worker' | 'legacy'
export type PortState = 'listening' | 'closed' | 'unknown'
export type ProcessRole = 'gateway' | 'worker' | 'addon' | 'win_proxy' | 'other'

export interface ListenerRow {
  port: number
  pid: number
  address: string
  process: string | null
  decoy: boolean
}

export interface ProcInput {
  pid: number
  name: string
  decoy: boolean
}

export interface ProcessRow extends ProcInput {
  role: ProcessRole
  port: number | null
}

/** 契约投影：内部判定标记（decoy）不外泄。 */
export interface ProcessBrief {
  pid: number
  name: string
  role: ProcessRole
  port: number | null
}

export interface PortBrief {
  port: number
  listening: boolean
  /** 认定 pid（只含通过归属判据的监听者）；诱饵永远不进来。 */
  pids: number[]
  /** 原始监听行 pid（含诱饵），诊断用；不参与判定。 */
  pids_raw: number[]
  process: string
  role: PortRole
  /** 证据来源模式：fixture 回放 / live 扫描。 */
  mode: 'fixture' | 'live'
}

export interface PortRow {
  port: number
  role: PortRole
  state: PortState
  pid: number | null
  /** 原始监听 pid（含诱饵）。 */
  pids: number[]
  /** 通过归属判据的 pid（认定值）。 */
  accepted_pids: number[]
  process: string | null
  expected: boolean
  matched: boolean
  counts_as_gateway: boolean
  source: string
  reader: string
  note: string
}

export interface PortsEvidence {
  gateway: PortRow
  worker: PortRow
  legacy: PortRow
  matched_gateway_pid: number | null
  conflicts: string[]
  source: string
  /** 与 list 同源的读取器（6b 判据：doctor 的 reader 必须等于 list 的 reader）。 */
  reader: string
  /** 本次扫描时刻（ISO8601）：端口证据的时效凭据。 */
  scanned_at: string
}

export interface FalsePositive {
  port: number
  pid: number | null
  reason: string
}

export interface FixtureMeta {
  path: string
  name: string
  decoys: number
}

export interface LocalEvidence {
  ok: boolean
  degraded: boolean
  error: string | null
  sessions: unknown[]
  local_processes: ProcessBrief[]
  ports: PortBrief[]
  ports_evidence: PortsEvidence
  false_positives: FalsePositive[]
  fixture: FixtureMeta | null
  scanned_at: string
  platform: string
  source: string
  note: string
}

function isBlenderName(name: string): boolean {
  return /blender/i.test(name) && !/hidden-desktop|dsh-blender-hidden/i.test(name)
}

function isProxyName(name: string): boolean {
  return /hidden-desktop|dsh-blender-hidden|win-proxy|win_proxy/i.test(name)
}

/** Gateway 可执行体可接受的名字（Electron run-as-node 也是同一枚 exe）。 */
function isGatewayName(name: string): boolean {
  return /deepseek|harness|dsh|node|electron/i.test(name)
}

function nameOf(processes: readonly ProcessRow[], pid: number | null): string {
  if (pid === null) return ''
  const hit = processes.find((p) => p.pid === pid)
  return hit ? hit.name : ''
}

/* ────────────────────────────── 解析器（纯函数，单测可直接喂） ────────────────────────────── */

/** `netstat -ano -p TCP` → LISTENING 行（端口精确匹配，ESTABLISHED 不算）。 */
export function parseNetstatListening(text: string | null | undefined): ListenerRow[] {
  const rows: ListenerRow[] = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5) continue
    if (!/^TCP$/i.test(cols[0])) continue
    if (!/^LISTENING$/i.test(cols[3])) continue
    const m = /:(\d+)$/.exec(cols[1])
    const pid = Number(cols[4])
    if (!m || !Number.isInteger(pid) || pid <= 0) continue
    rows.push({ port: Number(m[1]), pid, address: cols[1], process: null, decoy: false })
    if (rows.length >= MAX_ROWS) break
  }
  return rows
}

/** `tasklist /FO CSV /NH` → {pid, name}。 */
export function parseTasklistAll(
  text: string | null | undefined,
): Array<{ pid: number; name: string }> {
  const out: Array<{ pid: number; name: string }> = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(raw.trim())
    if (!m) continue
    const pid = Number(m[2])
    if (Number.isInteger(pid) && pid > 0) out.push({ pid, name: m[1] })
    if (out.length >= MAX_ROWS) break
  }
  return out
}

/** `ps -axo pid=,comm=` → {pid, name}（POSIX 没有 tasklist 时的进程表）。 */
export function parsePsTable(
  text: string | null | undefined,
): Array<{ pid: number; name: string }> {
  const out: Array<{ pid: number; name: string }> = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(raw)
    if (!m) continue
    out.push({ pid: Number(m[1]), name: m[2].trim() })
    if (out.length >= MAX_ROWS) break
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → 监听行（p=pid、c=command、n=地址:端口）。 */
export function parseLsofListening(text: string | null | undefined): ListenerRow[] {
  const rows: ListenerRow[] = []
  let pid = 0
  let name = ''
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0
    else if (line[0] === 'c') name = line.slice(1)
    else if (line[0] === 'n') {
      const m = /:(\d+)$/.exec(line.slice(1))
      if (m && pid > 0)
        rows.push({
          port: Number(m[1]),
          pid,
          address: line.slice(1),
          process: name || null,
          decoy: false,
        })
      if (rows.length >= MAX_ROWS) break
    }
  }
  return rows
}

/** `ss -ltnp` → 监听行（用户态进程可能看不到 pid，此时 pid=0，按"无法印证"处理）。 */
export function parseSsListening(text: string | null | undefined): ListenerRow[] {
  const rows: ListenerRow[] = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 4 || !/^LISTEN/i.test(cols[0])) continue
    const m = /:(\d+)$/.exec(cols[3])
    if (!m) continue
    const pidMatch = /pid=(\d+)/.exec(raw)
    rows.push({
      port: Number(m[1]),
      pid: pidMatch ? Number(pidMatch[1]) : 0,
      address: cols[3],
      process: null,
      decoy: false,
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows
}

interface RunResult {
  ok: boolean
  text: string
  error: string | null
}

/** 子进程统一口径：超时、windowsHide、输出上限（截断也算 degraded）。 */
function run(cmd: string, args: string[], timeoutMs: number): RunResult {
  try {
    const raw = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_SCAN_CHARS * 2,
    })
    const text = String(raw)
    if (text.length > MAX_SCAN_CHARS) {
      return {
        ok: false,
        text: text.slice(0, MAX_SCAN_CHARS),
        error: 'output truncated at ' + String(MAX_SCAN_CHARS) + ' chars',
      }
    }
    return { ok: true, text, error: null }
  } catch (e) {
    return {
      ok: false,
      text: '',
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    }
  }
}

export interface ScanResult<T> {
  ok: boolean
  source: string
  rows: T[]
  error: string | null
}

/** 端口监听表：Windows netstat；macOS lsof；Linux ss（拿不到就 ok=false，不猜）。 */
export function scanListeners(timeoutMs = 3000): ScanResult<ListenerRow> {
  if (IS_WIN) {
    const out = run('netstat.exe', ['-ano', '-p', 'TCP'], timeoutMs)
    return {
      ok: out.ok,
      source: 'netstat',
      rows: parseNetstatListening(out.text),
      error: out.error,
    }
  }
  const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], timeoutMs)
  if (lsof.ok || lsof.text) {
    return {
      ok: lsof.ok,
      source: 'lsof',
      rows: parseLsofListening(lsof.text),
      error: lsof.error,
    }
  }
  const ss = run('ss', ['-ltnp'], timeoutMs)
  if (ss.text) return { ok: ss.ok, source: 'ss', rows: parseSsListening(ss.text), error: ss.error }
  return { ok: false, source: 'unavailable', rows: [], error: ss.error || lsof.error }
}

/** 进程表：Windows tasklist；POSIX ps。 */
export function scanProcesses(timeoutMs = 3000): ScanResult<{ pid: number; name: string }> {
  if (IS_WIN) {
    const out = run('tasklist.exe', ['/FO', 'CSV', '/NH'], timeoutMs)
    return { ok: out.ok, source: 'tasklist', rows: parseTasklistAll(out.text), error: out.error }
  }
  const out = run('ps', ['-axo', 'pid=,comm='], timeoutMs)
  return { ok: out.ok, source: 'ps', rows: parsePsTable(out.text), error: out.error }
}

/* ────────────────────────────── 分类（live 与 fixture 同一套） ────────────────────────────── */

export interface FixtureDoc {
  schema?: number
  name?: string
  gatewayPid?: number
  listeners?: Array<{ port?: unknown; pid?: unknown; process?: unknown; decoy?: unknown }>
  processes?: Array<{ pid?: unknown; name?: unknown; decoy?: unknown }>
}

export interface LocalsInput {
  listeners: ListenerRow[]
  processes: ProcInput[]
  /** worker 注册表里活着的 pid（比"谁在 9879 上听"可靠）。 */
  workerPids?: number[]
  /** 当前是否有 ready 的 GUI addon（用来把唯一的 blender 进程认成 addon）。 */
  addonConnected?: boolean
  /** 有可见主窗口的 blender pid（Windows；用于把用户 GUI 与隐藏实例区分开）。 */
  guiPids?: number[]
  gatewayPid: number
  gatewayPort: number
  workerPort: number
  legacyPort: number
  source: string
  scanOk: boolean
  degraded?: boolean
  error?: string | null
  fixture: FixtureMeta | null
}

export function decodeFixture(raw: unknown): FixtureDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  if (Number(doc.schema) !== EVIDENCE_FIXTURE_SCHEMA) return null
  return doc as FixtureDoc
}

export function fixtureRows(doc: FixtureDoc): {
  listeners: ListenerRow[]
  processes: ProcInput[]
  decoys: number
} {
  const inProc = Array.isArray(doc.processes) ? doc.processes.slice(0, MAX_ROWS) : []
  const processes: ProcInput[] = []
  let decoys = 0
  for (const row of inProc) {
    const pid = Number(row.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const decoy = row.decoy === true
    if (decoy) decoys += 1
    processes.push({ pid, name: String(row.name || '').slice(0, 120), decoy })
  }
  const inListen = Array.isArray(doc.listeners) ? doc.listeners.slice(0, MAX_ROWS) : []
  const listeners: ListenerRow[] = []
  for (const row of inListen) {
    const port = Number(row.port)
    const pid = Number(row.pid)
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue
    const decoy = row.decoy === true
    if (decoy) decoys += 1
    listeners.push({
      port,
      pid,
      address: 'fixture',
      process: row.process == null ? null : String(row.process),
      decoy,
    })
  }
  return { listeners, processes, decoys }
}

let GUI_PID_CACHE: { at: number; pids: number[] } | null = null

/** 有可见主窗口的 blender pid（Windows）。10s 缓存；拿不到回 []，由唯一性规则兜底。 */
export function scanGuiPids(timeoutMs = 4000): number[] {
  if (!IS_WIN) return []
  if (GUI_PID_CACHE && Date.now() - GUI_PID_CACHE.at < 10000) return GUI_PID_CACHE.pids
  const script =
    'Get-Process blender -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [string]$_.Id }'
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
  const pids = r.ok
    ? String(r.text)
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : []
  GUI_PID_CACHE = { at: Date.now(), pids }
  return pids
}

function roleFor(
  proc: ProcInput,
  gatewayPid: number,
  workerPids: Set<number>,
  addonPids: Set<number>,
): ProcessRole {
  if (proc.pid === gatewayPid) return 'gateway'
  if (isProxyName(proc.name)) return 'win_proxy'
  if (workerPids.has(proc.pid)) return 'worker'
  if (addonPids.has(proc.pid)) return 'addon'
  return 'other'
}

/** 唯一一个"没被 worker/gateway/proxy 认领"的 blender 且 addon 在线 → addon；多于一个 → 都算 other。 */
function addonPidsOf(
  inputs: ProcInput[],
  gatewayPid: number,
  workerPids: Set<number>,
  addonConnected: boolean,
  guiPids: number[] = [],
): Set<number> {
  if (!addonConnected) return new Set()
  const candidates = inputs.filter(
    (p) =>
      isBlenderName(p.name) &&
      p.pid !== gatewayPid &&
      !workerPids.has(p.pid) &&
      !isProxyName(p.name),
  )
  // 有可见主窗口的 blender 才是用户 GUI；没有窗口的隐藏实例不抢 addon。
  const gui = candidates.filter((p) => guiPids.includes(p.pid))
  if (gui.length) return new Set(gui.map((p) => p.pid))
  return candidates.length === 1 ? new Set([candidates[0].pid]) : new Set()
}

function portRow(
  role: PortRole,
  port: number,
  rows: ListenerRow[],
  processes: ProcessRow[],
  accept: (row: ListenerRow) => boolean,
  source: string,
  expected: boolean,
  note: string,
): PortRow {
  const listening = rows.filter((r) => r.port === port)
  const acceptedRows = listening.filter(accept)
  const accepted = acceptedRows[0] || null
  const pid = accepted ? accepted.pid : listening.length ? listening[0].pid : null
  const process =
    nameOf(processes, pid) || (accepted ? accepted.process : listening[0]?.process) || null
  const state: PortState = listening.length ? 'listening' : 'closed'
  return {
    port,
    role,
    state,
    pid,
    pids: [...new Set(listening.map((r) => r.pid))].sort((a, b) => a - b),
    accepted_pids: [...new Set(acceptedRows.map((r) => r.pid))].sort((a, b) => a - b),
    process,
    expected,
    matched: !!accepted,
    counts_as_gateway: role === 'gateway' && !!accepted,
    source,
    reader: source,
    note,
  }
}

function gatewayConflicts(
  listeners: ListenerRow[],
  processes: ProcessRow[],
  gatewayPort: number,
  gatewayPid: number,
): string[] {
  const out: string[] = []
  for (const row of listeners) {
    if (row.port !== gatewayPort || row.pid === gatewayPid) continue
    const name = nameOf(processes, row.pid) || row.process || '?'
    out.push(
      'gateway port ' +
        String(gatewayPort) +
        ' 另有监听者 pid=' +
        String(row.pid) +
        ' (' +
        name +
        ')',
    )
    if (out.length >= 5) break
  }
  return out
}

function decoyPositives(
  listeners: ListenerRow[],
  processes: ProcessRow[],
  gatewayPort: number,
  workerPort: number,
  gatewayPid: number,
): FalsePositive[] {
  const out: FalsePositive[] = []
  for (const row of listeners) {
    if (!row.decoy) continue
    const name = nameOf(processes, row.pid) || row.process || ''
    const asGateway = row.port === gatewayPort && row.pid === gatewayPid && isGatewayName(name)
    const asWorker = row.port === workerPort && isBlenderName(name)
    if (!asGateway && !asWorker) continue
    out.push({
      port: row.port,
      pid: row.pid,
      reason: 'decoy accepted as ' + (asGateway ? 'gateway' : 'worker'),
    })
  }
  return out
}

/** 进程行：role 由"是不是 gateway / 是不是 9879 的 listening blender / 其它"决定。 */
function buildProcessRows(
  inputs: ProcInput[],
  listeners: ListenerRow[],
  gatewayPid: number,
  gatewayPort: number,
  workerPort: number,
  workerPidsArg: number[] = [],
  addonConnected = false,
  guiPids: number[] = [],
): ProcessRow[] {
  const workerPids = new Set([
    ...workerPidsArg.filter((pid) => Number.isInteger(pid) && pid > 0),
    ...listeners
      .filter((r) => r.port === workerPort && isBlenderName(r.process || ''))
      .map((r) => r.pid),
  ])
  // 唯一未认领的 blender 才算 addon；worker 注册表 pid 永远先认成 worker。
  const addonPids = addonPidsOf(inputs, gatewayPid, workerPids, addonConnected, guiPids)
  const rows: ProcessRow[] = inputs.map((p) => {
    const role = roleFor(p, gatewayPid, workerPids, addonPids)
    return {
      ...p,
      role,
      port: role === 'gateway' ? gatewayPort : role === 'worker' ? workerPort : null,
    }
  })
  for (const row of listeners) {
    // fixture 里只写了监听行的进程名：补一条进程记录，保证端口↔进程互相印证。
    if (!row.process || rows.some((p) => p.pid === row.pid)) continue
    const role = roleFor(
      { pid: row.pid, name: row.process, decoy: false },
      gatewayPid,
      workerPids,
      addonPids,
    )
    rows.push({ pid: row.pid, name: row.process, decoy: false, role, port: null })
  }
  return rows
}

/** 端口列表的契约投影：{port, listening, pids, process, role}。 */
/** 可见进程 + 降级判定（空数组必须 degraded=true + error）。 */
function visibilityOf(
  input: LocalsInput,
  processes: ProcessRow[],
): { visible: ProcessRow[]; degraded: boolean; error: string | null } {
  const visible = processes.filter((p) => p.role !== 'other').slice(0, 40)
  return {
    visible,
    degraded: input.degraded === true || visible.length === 0,
    error:
      input.error || (visible.length === 0 ? 'local_processes 为空（扫描失败或无相关进程）' : null),
  }
}

/** 端口列表的契约投影：{port, listening, pids, process, role}。 */
function portsBrief(details: PortRow[], mode: 'fixture' | 'live'): PortBrief[] {
  return details.map((row) => ({
    port: row.port,
    listening: row.state === 'listening',
    // 认定 pid：只含通过归属判据的监听者；原始行留在 pids_raw（诱饵只出现在那里）。
    pids: row.accepted_pids,
    pids_raw: row.pids,
    process: row.process || '',
    role: row.role,
    mode,
  }))
}

/** 扫描不可用时端口状态写 unknown（不是 closed），并留一句可读的原因。 */
function degradeUnscanned(details: PortRow[], source: string): void {
  for (const row of details) {
    if (row.state !== 'listening') row.state = 'unknown'
    row.note += ' · 扫描不可用（source=' + source + '），端口状态未知'
  }
}

/** 同一套分类规则：live 扫描与 fixture 回放都走这里（判据不能两套）。 */
export function classifyLocals(input: LocalsInput): LocalEvidence {
  const { listeners, gatewayPid, gatewayPort, workerPort, legacyPort, source, scanOk, fixture } =
    input
  const scannedAt = new Date().toISOString()
  const processes = buildProcessRows(
    input.processes,
    listeners,
    gatewayPid,
    gatewayPort,
    workerPort,
    input.workerPids || [],
    input.addonConnected === true,
    input.guiPids || [],
  )
  const gateway = portRow(
    'gateway',
    gatewayPort,
    listeners,
    processes,
    (r) => r.pid === gatewayPid && isGatewayName(nameOf(processes, r.pid) || r.process || ''),
    source,
    true,
    '谁在 39877 上听：pid 必须与 Gateway 自己一致，且进程名不是 Blender',
  )
  const worker = portRow(
    'worker',
    workerPort,
    listeners,
    processes,
    (r) => isBlenderName(nameOf(processes, r.pid) || r.process || ''),
    source,
    true,
    '热无头 worker（默认 9879）',
  )
  const legacy = portRow(
    'legacy',
    legacyPort,
    listeners,
    processes,
    () => false,
    source,
    false,
    '3.0.x 旧后端端口：只展示，不冒充 Gateway 判据',
  )
  if (!scanOk) degradeUnscanned([gateway, worker, legacy], source)
  const { visible, degraded, error } = visibilityOf(input, processes)
  return {
    ok: scanOk,
    degraded,
    error,
    sessions: [],
    // 契约口径：{pid, name, role, port}（decoy 是内部判定标记，不外泄）。
    local_processes: visible.map((row) => ({
      pid: row.pid,
      name: row.name,
      role: row.role,
      port: row.port,
    })),
    ports: portsBrief([gateway, worker, legacy], source === 'fixture' ? 'fixture' : 'live'),
    ports_evidence: {
      gateway,
      worker,
      legacy,
      matched_gateway_pid: gateway.matched ? gateway.pid : null,
      conflicts: gatewayConflicts(listeners, processes, gatewayPort, gatewayPid),
      source,
      reader: source,
      scanned_at: scannedAt,
    },
    false_positives: decoyPositives(listeners, processes, gatewayPort, workerPort, gatewayPid),
    fixture,
    scanned_at: scannedAt,
    platform: process.platform,
    source,
    note: scanOk
      ? '端口 → 进程双向印证；9877 是 3.0.x 旧后端，不是判据'
      : '进程/端口表拿不到：listening=false + degraded，不冒充关闭',
  }
}

/* ────────────────────────────── 采集入口 ────────────────────────────── */

export interface CollectOptions {
  gatewayPort?: number
  workerPort?: number
  legacyPort?: number
  gatewayPid?: number
  probeFixture?: string | null
  timeoutMs?: number
  /** worker 注册表里活着的 pid（route 从 engine.worker.list() 传入）。 */
  workerPids?: number[]
  /** 当前是否有 ready 的 GUI addon。 */
  addonConnected?: boolean
  /** 有可见主窗口的 blender pid（测试注入；省略时 Windows 自动扫）。 */
  guiPids?: number[]
}

/** worker 端口：DSH_WORKER_PORT 是工单里的键名，DSH_BLENDER_WORKER_PORT 为兼容保留。 */
export function workerPortOf(): number {
  const raw = process.env.DSH_WORKER_PORT || process.env.DSH_BLENDER_WORKER_PORT
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : Number(CFG.workerPort) || WORKER_PORT_DEFAULT
}

export function gatewayPortOf(): number {
  const n = Number(process.env.DSH_BLENDER_HTTP_PORT) || Number(CFG.httpPort)
  return Number.isInteger(n) && n > 0 ? n : GATEWAY_PORT_DEFAULT
}

function readFixture(file: string): { doc: FixtureDoc; path: string } | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const doc = decodeFixture(parsed)
    return doc ? { doc, path: file } : null
  } catch {
    return null
  }
}

/** 收集本地证据：有 probeFixture 就回放它，否则真扫（超时 + 输出上限，失败降级不沉默）。 */
export function collectLocalEvidence(opts: CollectOptions = {}): LocalEvidence {
  const gatewayPort = opts.gatewayPort || gatewayPortOf()
  const workerPort = opts.workerPort || workerPortOf()
  const legacyPort = opts.legacyPort || LEGACY_PORT_DEFAULT
  const gatewayPid =
    Number.isInteger(Number(opts.gatewayPid)) && Number(opts.gatewayPid) > 0
      ? Number(opts.gatewayPid)
      : process.pid
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000
  if (opts.probeFixture) {
    const loaded = readFixture(String(opts.probeFixture))
    if (loaded) {
      const rows = fixtureRows(loaded.doc)
      return classifyLocals({
        listeners: rows.listeners,
        processes: rows.processes,
        gatewayPid: Number(loaded.doc.gatewayPid) || gatewayPid,
        gatewayPort,
        workerPort,
        legacyPort,
        source: 'fixture',
        scanOk: true,
        fixture: {
          path: loaded.path,
          name: String(loaded.doc.name || ''),
          decoys: rows.decoys,
        },
      })
    }
    return classifyLocals({
      listeners: [],
      processes: [],
      gatewayPid,
      gatewayPort,
      workerPort,
      legacyPort,
      source: 'fixture',
      scanOk: false,
      degraded: true,
      error: 'probeFixture 读不到或 schema 不对：' + String(opts.probeFixture),
      fixture: { path: String(opts.probeFixture), name: '', decoys: 0 },
    })
  }
  const procs = scanProcesses(timeoutMs)
  const listen = scanListeners(timeoutMs)
  const errors: string[] = []
  if (!procs.ok) errors.push('processes(' + procs.source + '): ' + (procs.error || 'unavailable'))
  if (!listen.ok)
    errors.push('listeners(' + listen.source + '): ' + (listen.error || 'unavailable'))
  return classifyLocals({
    listeners: listen.rows,
    processes: procs.rows.map((r) => ({ pid: r.pid, name: r.name, decoy: false })),
    gatewayPid,
    gatewayPort,
    workerPort,
    legacyPort,
    source: listen.ok ? listen.source : 'unavailable',
    scanOk: listen.ok && procs.ok,
    degraded: errors.length > 0,
    error: errors.length ? errors.join('; ') : null,
    fixture: null,
    workerPids: opts.workerPids || [],
    addonConnected: opts.addonConnected === true,
    guiPids: opts.guiPids || scanGuiPids(),
  })
}
