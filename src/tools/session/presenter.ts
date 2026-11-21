/** blender_session 的呈现层：会话列表、动作回执、status/doctor 摘要。 */
import { asRecord, isRecord, text } from '../../contracts/dynamic.js'
import type { SessionRow } from '../shared/session.js'
import { formatLocalEvidence } from './evidence-presenter.js'

const LF = String.fromCharCode(10)
const CLIP = 6000

function clip(v: unknown, max = CLIP): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + ' …' : s
}

/**
 * 痛点1b 现场：consent_required 过去只回一句 "需要人类授权"，既没有请求 id，也没有任何
 * 可执行的下一步 —— 用户说"确认界面我从来没看见过"。这个回执把**人类要做的动作**放在
 * 最前面（一行可复制的命令），并把 request_id 留在正文里。
 */
export function formatConsent(body: Record<string, unknown>): string {
  const ev = asRecord(body.evidence)
  const req = asRecord(body.human_action)
  const requestId = text(body.request_id || ev.request_id || '')
  const lines = [
    '⚠ 需要你（人类）确认：启动一个可见的 virtual-gui Blender 窗口',
    'request_id ' + (requestId || '(缺失：先 action=start 一次生成请求)'),
  ]
  if (req.approve) {
    lines.push('在 Gateway 所在机器的任意终端执行：', '  ' + text(req.approve))
    lines.push('拒绝：', '  ' + text(req.deny || ''))
    lines.push(
      '然后让 agent 再调一次 blender_session action=start kind=virtual-gui（批准只消费一次）',
    )
  } else {
    lines.push(
      'policy=' +
        text(ev.policy || 'ask') +
        ' · reason=' +
        text(ev.reason || 'missing') +
        ' · request_expires_at=' +
        text(ev.request_expires_at || '-'),
    )
    lines.push(
      '批准方式：把 request_id 交给人类执行 approve（或设 DSH_BLENDER_VIRTUAL_GUI_CONSENT=allow 预批准）',
    )
  }
  if (req.preapprove_env) lines.push('预批准（无人值守）：' + text(req.preapprove_env))
  return lines.join(LF)
}

/** consent 系列动作的回执（请求本身，不是授权）。 */
export function formatConsentState(action: string, body: Record<string, unknown>): string {
  const head = 'SESSION ' + action + ' · policy=' + text(body.policy || 'ask')
  if (action === 'consent_status') {
    const rows = Array.isArray(body.requests) ? body.requests : []
    if (!rows.length)
      return head + LF + '没有为该 agent 记录过 consent 请求（action=start 会生成一条）'
    const lines = [head]
    for (const row of rows) {
      const r = asRecord(row)
      lines.push(
        '· ' +
          text(r.request_id) +
          ' · ' +
          text(r.state) +
          ' · expires_in_ms=' +
          String(r.expires_in_ms ?? '-') +
          ' · source=' +
          text(r.source || '-'),
      )
    }
    return lines.join(LF)
  }
  const request = asRecord(body.request)
  return (
    head +
    LF +
    'request_id=' +
    text(request.request_id) +
    ' · state=' +
    text(request.state) +
    ' · expires_in_ms=' +
    String(request.expires_in_ms ?? '-') +
    (body.reused === true ? ' · 复用已存在的待批准请求' : '')
  )
}

/**
 * 工单 6e：会话数的唯一判据是 local_evidence.sessions（Gateway 的 registry.list()），
 * 不是本调用者可见的行（registry.listFor(caller)）。别人的会话会让两者不一致：
 * 旧文本会同时写「0 个会话」和「未认领」，用户照着 attach 只会吃 session_in_use。
 * 返回 null 表示这份证据没带 sessions 字段（老 Gateway / 部分 fixture），退回行数。
 */
function evidenceSessions(evidence?: Record<string, unknown> | null): SessionRow[] | null {
  const raw = evidence ? evidence.sessions : undefined
  if (!Array.isArray(raw)) return null
  return raw.filter(isRecord).map(asRecord)
}

function claimedElsewhereText(rows: SessionRow[]): string {
  const shown = rows
    .slice(0, 4)
    .map((s) => text(s.id || '-') + '(' + text(s.kind || '-') + ',' + text(s.status || '-') + ')')
  if (rows.length > shown.length) shown.push('+' + String(rows.length - shown.length))
  return shown.join(' · ')
}

function emptySessionListText(
  header: string,
  evidenceRows: SessionRow[] | null,
  addon: Record<string, unknown> | null | undefined,
  blocks: string[],
): string {
  if (evidenceRows && evidenceRows.length) {
    return [
      header,
      '已认领但不在本调用者名下：' + claimedElsewhereText(evidenceRows),
      '说明：这些会话已有 owner，attach 会被 session_in_use 拒绝 —— 让 owner 先 detach/release，或换一个 DSH 会话。',
      'next_actions · blender_session action=list（owner 释放后再 attach）',
    ]
      .concat(blocks)
      .join(LF)
  }
  // 2026-11-19 纠正：3.1+ addon 主动拨 39877，**不需要用户点 Connect**。
  // list=0 只说明"还没认领"，不说明通道离线 —— 文案必须给可粘贴的 attach。
  const view = asRecord(addon)
  const known = Object.keys(view).length > 0
  const ready = Number(view.ready_instances ?? 0)
  const instanceId = text(view.instanceId || '')
  const actions = Array.isArray(view.next_actions)
    ? view.next_actions.map(text).filter(Boolean)
    : []
  const attachLine = instanceId
    ? 'blender_session action=attach instance_id=' + instanceId
    : actions[0] || ''
  const addonText = !known
    ? 'addon 状态未知（evidenceOnly 未取到）'
    : ready > 0
      ? 'addon 已连，ready_instances=' + String(ready)
      : 'addon 未连，ready_instances=0'
  const head = [
    header,
    '未认领（' + addonText + '）' + (attachLine ? ' → 直接 attach：' + attachLine : ''),
    '说明：list=0 只是未认领，不代表 addon 离线。',
    attachLine
      ? 'next_actions · ' + attachLine
      : known && ready > 0
        ? 'next_actions · 多实例：先 action=doctor 取 instance_id，再 blender_session action=attach（3.1+ 无需手动连接）'
        : 'next_actions · addon 未连：启动 Blender 并启用扩展后再 action=list 取 instance_id（3.1+ 无需手动连接）',
  ]
  return head.concat(blocks).join(LF)
}

export function formatSessionList(
  sessions: SessionRow[],
  evidence?: Record<string, unknown> | null,
  addon?: Record<string, unknown> | null,
): string {
  const blocks = formatLocalEvidence(evidence)
  const evidenceRows = evidenceSessions(evidence)
  const total = evidenceRows ? evidenceRows.length : sessions.length
  const header =
    total === sessions.length
      ? 'SESSION list · ' + String(total) + ' 个会话'
      : 'SESSION list · ' +
        String(total) +
        ' 个会话（本调用者可见 ' +
        String(sessions.length) +
        '）'
  if (!sessions.length) return emptySessionListText(header, evidenceRows, addon, blocks)
  const lines = [header]
  for (const s of sessions) {
    const agents = Array.isArray(s.agents) ? s.agents.length : 0
    lines.push(
      '· ' +
        text(s.id) +
        ' · ' +
        text(s.kind) +
        ' · ' +
        text(s.status) +
        ' · instance=' +
        text(s.instanceId || '-') +
        ' · owner=' +
        text(asRecord(s.owner).agentId || '-') +
        (s.is_mine === true ? ' · mine=yes' : s.is_mine === false ? ' · mine=no（只读可见）' : '') +
        ' · agents=' +
        String(agents) +
        (s.paused ? ' · PAUSED(human)' : '') +
        (s.humanModified ? ' · human_modified' : '') +
        (s.owner_expired === true ? ' · owner_expired → re-attach' : '') +
        // 反馈 2: show the reclaim contract instead of an opaque 15-20 min wait.
        (asRecord(s.owner).stale === true
          ? ' · owner-stale(age=' +
            String(asRecord(s.owner).heartbeat_age_ms ?? '?') +
            'ms / ' +
            String(asRecord(s.owner).stale_after_ms ?? '?') +
            'ms)' +
            (s.is_mine === false && s.readable === true
              ? ' → blender_session action=release session_id=' + text(s.id) + ' force=true'
              : '')
          : ''),
    )
  }
  return lines.concat(blocks).join(LF)
}

export function formatSessionResult(action: string, body: Record<string, unknown>): string {
  const s = asRecord(body.session)
  const head = 'SESSION ' + action + ' ok'
  if (action === 'whoami')
    return (
      head +
      LF +
      'agentId=' +
      text(asRecord(body.caller).agentId || body.agentId || '-') +
      ' · dshSessionId=' +
      text(asRecord(body.caller).dshSessionId || body.dshSessionId || '-') +
      ' · hostId=' +
      text(asRecord(body.caller).hostId || body.hostId || '-') +
      ' · role=' +
      text(asRecord(body.caller).role || body.role || '-')
    )
  if (action === 'release' || action === 'detach')
    return (
      head +
      ' · released=' +
      String(body.released === true) +
      (body.reason ? ' · reason=' + text(body.reason) : '')
    )
  if (action === 'grants')
    return head + LF + clip(body.grants ?? []) + (body.note ? LF + text(body.note) : '')
  if (action === 'presence') return head + LF + clip(body.presence ?? body.sessions ?? [])
  if (
    action === 'attach' ||
    action === 'claim' ||
    action === 'start' ||
    action === 'stop' ||
    action === 'detach' ||
    action === 'release'
  )
    return (
      head +
      (s.id
        ? LF +
          'session=' +
          text(s.id) +
          ' · kind=' +
          text(s.kind) +
          ' · status=' +
          text(s.status) +
          ' · instance=' +
          text(s.instanceId || '-') +
          ' · owner=' +
          text(asRecord(s.owner).agentId || '-') +
          (body.viewer === true ? ' · viewer=true' : '') +
          (s.is_mine === false ? ' · is_mine=false' : s.is_mine === true ? ' · is_mine=true' : '') +
          (s.borrowed === true ? ' · borrowed=true' : '')
        : LF + clip(body))
    )
  if (
    action === 'consent_request' ||
    action === 'consent_status' ||
    action === 'consent_approve' ||
    action === 'consent_deny'
  )
    return formatConsentState(action, body)
  if (action === 'grant') return head + LF + clip(body.grant ?? body.grants ?? body)
  if (action === 'revoke') return head + (body.revoked === false ? ' · 未找到该 grant' : '')
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(body)) if (k !== 'ok') rest[k] = body[k]
  return head + (Object.keys(rest).length ? LF + clip(rest) : '')
}

/**
 * reload 回执（H2）：**原样**呈现 ReloadReport 的关键字段 —— mode / pid / verdict / changed /
 * receipt / needsRestart / note。失败（含浏览器面 409 的 mode=hmr）也走这里，
 * 绝不压成一句 "request failed"：模型要能读到"为什么还得重启"。
 */
export function formatReloadReport(body: Record<string, unknown>): string {
  const mode = text(body.mode || 'unavailable')
  const staleLayer = Array.isArray(body.staleLayer) ? body.staleLayer.map(text) : []
  const lines = [
    'SESSION reload · mode=' +
      mode +
      ' · ok=' +
      String(body.ok === true) +
      ' · pending=' +
      String(body.pending === true) +
      ' · pid ' +
      String(body.pidBefore ?? 'null') +
      '→' +
      String(body.pidAfter ?? 'null') +
      ' · verdict=' +
      text(body.verdict || 'unknown') +
      (staleLayer.length ? ' · staleLayer=' + staleLayer.join(',') : ''),
  ]
  const count = asRecord(body.changedCount)
  lines.push(
    'changed host=' +
      String(count.host ?? 0) +
      ' · runtime=' +
      String(count.runtime ?? 0) +
      ' · other=' +
      String(count.other ?? 0),
  )
  const changed = asRecord(body.changed)
  for (const layer of ['host', 'runtime', 'other']) {
    const list = Array.isArray(changed[layer]) ? (changed[layer] as unknown[]).map(text) : []
    if (list.length) lines.push('· ' + layer + ': ' + list.join(', '))
  }
  // 宿主自己的层自证（装载时指纹 vs 磁盘）：判据不能只看 Gateway 的增量 diff ——
  // 清单缺失/被别的安装覆盖时，这一行是「宿主 fiber 到底是不是磁盘这一代」的唯一证据。
  const hostSelf = asRecord(asRecord(body.layers).hostSelf)
  if (hostSelf.verdict) {
    lines.push(
      'hostLayer(self) loaded=' +
        text(hostSelf.loadedHash || 'null') +
        ' · disk=' +
        text(hostSelf.currentHash || 'null') +
        ' · verdict=' +
        text(hostSelf.verdict) +
        ' · changed=' +
        String(hostSelf.changedCount ?? 0),
    )
  }
  // H5：作业被 reload 取消时**必须**说出来（上一版恒空 → 用户以为还在跑）。
  const jobs = Array.isArray(body.jobsDropped) ? body.jobsDropped.map(text) : []
  if (jobs.length) lines.push('jobsDropped: ' + jobs.join(', ') + '（重跑请重新 submit）')
  const stopped = Array.isArray(body.stopped) ? body.stopped.map(text) : []
  if (stopped.length) lines.push('stopped: ' + stopped.join(', '))
  if (body.receipt) lines.push('profile receipt: ' + text(body.receipt))
  const needs = Array.isArray(body.needsRestart) ? body.needsRestart.map(text) : []
  if (needs.length) {
    lines.push('needsRestart:')
    for (const n of needs) lines.push('  · ' + n)
  }
  if (body.note) lines.push('note: ' + text(body.note))
  return lines.join(LF)
}

/** Runtime-module provenance lines (status): one string, or null when absent. */
function runtimeModulesLines(body: Record<string, unknown>): string[] {
  const region = asRecord(body.region)
  const addonRegion = asRecord(asRecord(body.addon).region)
  const topRuntimeModules = asRecord(body.runtimeModules)
  const runtimeModules = Object.keys(topRuntimeModules).length
    ? topRuntimeModules
    : asRecord(region.runtime_modules || addonRegion.runtime_modules)
  if (!Object.keys(runtimeModules).length) return []
  const modules = asRecord(runtimeModules.modules)
  const stale = Object.entries(modules)
    .filter(([, v]) => text(asRecord(v).verdict) === 'stale')
    .map(([k]) => k)
  const out = [
    'runtime modules loaded=' +
      text(runtimeModules.loaded_hash || '-') +
      ' · disk=' +
      text(runtimeModules.disk_hash || '-') +
      ' · verdict=' +
      text(runtimeModules.verdict || 'unknown') +
      ' · count=' +
      String(runtimeModules.count ?? 0) +
      (stale.length ? ' · stale=' + stale.join(',') : ''),
  ]
  if (text(runtimeModules.verdict) === 'stale')
    out.push(
      '⚠ runtime 模块仍是旧代码：下一次业务调用会先重注入 —— 首调用结果可能来自旧代码，重跑一次再定论',
    )
  return out
}
export function formatStatus(
  body: Record<string, unknown>,
  sessions: SessionRow[],
  evidence?: Record<string, unknown> | null,
): string {
  const readiness = asRecord(body.readiness)
  const addon = asRecord(readiness.addon)
  const vg = asRecord(body.virtualGui)
  const lines = ['SESSION status']
  lines.push(
    'gateway  ' + (readiness.gateway ? 'up' : 'down') + (body.running ? ' · backend running' : ''),
  )
  lines.push(
    'addon    ' +
      (addon.connected ? 'connected' : 'disconnected') +
      ' · ready_instances=' +
      String(addon.ready_instances ?? 0) +
      (addon.instanceId ? ' · instance=' + text(addon.instanceId) : '') +
      (addon.kind ? ' · kind=' + text(addon.kind) : '') +
      (addon.handshake_error ? ' · handshake_error=' + text(addon.handshake_error) : ''),
  )
  lines.push('bpy      ' + (readiness.bpy ? 'ready' : 'not ready'))
  const plugin = asRecord(body.plugin)
  const prov = asRecord(plugin.provenance)
  if (Object.keys(prov).length)
    lines.push(
      'provenance loaded=' +
        text(prov.loadedHash || '-') +
        ' · current=' +
        text(prov.currentHash || '-') +
        ' · verdict=' +
        text(prov.verdict || 'unknown') +
        (prov.staleReason ? ' · ' + text(prov.staleReason).slice(0, 240) : ''),
    )
  lines.push(...runtimeModulesLines(body))
  if (body.addonError) lines.push('addonError ' + text(body.addonError))
  if (vg.enabled !== undefined)
    lines.push(
      'virtual-gui ' +
        (vg.enabled ? 'enabled' : 'disabled') +
        (vg.ready ? ' · ready' : '') +
        (vg.preview ? ' · preview-only' : '') +
        (vg.reason ? ' · reason=' + text(vg.reason) : ''),
    )
  // status 内嵌的 list 段必须与上面的 addon 行同源（不许自相矛盾）。
  const addonView = {
    connected: addon.connected === true,
    ready_instances: addon.ready_instances ?? 0,
    instanceId: addon.instanceId || null,
    next_actions: addon.instanceId
      ? ['blender_session action=attach instance_id=' + text(addon.instanceId)]
      : [],
  }
  lines.push(formatSessionList(sessions, evidence || null, addonView))
  return lines.join(LF)
}

export function formatDoctor(body: Record<string, unknown>): string {
  const lines = [
    'SESSION doctor · ok=' +
      String(body.ok === true) +
      (body.kind ? ' · kind=' + text(body.kind) : '') +
      (body.verdict ? ' · verdict=' + text(body.verdict) : '') +
      (body.protocol !== undefined ? ' · protocol=' + text(body.protocol) : ''),
  ]
  if (body.root_cause) lines.push('root_cause: ' + text(body.root_cause))
  if (body.fix) lines.push('fix: ' + text(body.fix))
  const checks = body.checks
  if (Array.isArray(checks)) {
    for (const c of checks) {
      const row = asRecord(c)
      lines.push(
        '· ' +
          text(row.name || row.id || '?') +
          ' ' +
          (row.ok === false ? 'FAIL' : 'ok') +
          (row.detail ? ' · ' + text(row.detail) : ''),
      )
    }
  }
  const vg = asRecord(body.virtualGui)
  if (vg.enabled !== undefined)
    lines.push(
      'virtual-gui ' +
        (vg.enabled ? 'enabled' : 'disabled') +
        (vg.ready ? ' · ready' : '') +
        (vg.reason ? ' · reason=' + text(vg.reason) : ''),
    )
  // 6b：no-addon / headless 态也必须给端口证据 + 一行可执行的激活方式。
  const evidence = asRecord(body.local_evidence)
  const hasEvidence = Object.keys(evidence).length > 0
  if (hasEvidence) lines.push(...formatLocalEvidence(evidence))
  const actions = Array.isArray(body.next_actions)
    ? body.next_actions.map(text).filter(Boolean)
    : []
  if (actions.length) lines.push('next_actions · ' + actions.join(' | '))
  if (body.fixture_activation) lines.push('fixture_activation · ' + text(body.fixture_activation))
  if (!checks && !body.root_cause && !hasEvidence) lines.push(clip(body))
  return lines.join(LF)
}

export function sessionHelp(): string {
  return [
    'blender_session 动作（会话生命周期与归属；不含 Gateway 运维）：',
    '  whoami（回本调用者的 agentId / dshSessionId / hostId / role）',
    '  list | status | doctor | attach | claim | detach | release',
    '  grant / revoke / grants（写权限 scope：exclusive | collection:名 | prefix:名 | object:名）',
    '  pause / resume（只有人类能暂停；agent 调用返回 human_action_required）',
    '  mark_read（清掉 human_modified 冲突）| presence | heartbeat',
    '  start / stop（只作用 virtual-gui；首次 start 返回 consent_required，回执里带 request_id + 人类要跑的一行命令）',
    '  consent_request / consent_status（查看本 agent 的待批准请求）| consent_approve / consent_deny（request_id）',
    '  txn（子动作 op=snapshot|restore|list|prune|mark|revert|marks|drop|help；写快照/回滚需 exclusive grant）',
    '  reload（热更不重启：宿主层→写 profile patch 触发 HMR；运行时层→重拉 Gateway；dry_run=true 只诊断；force=true 强制重组合一次）',
    '旧工具迁移：blender_viewport → blender_session（status/doctor）+ blender_see；blender_rt_txn → blender_session action=txn。',
  ].join(LF)
}

export function isSessionRow(v: unknown): boolean {
  const r = asRecord(v)
  return isRecord(r) && typeof r.id === 'string'
}
