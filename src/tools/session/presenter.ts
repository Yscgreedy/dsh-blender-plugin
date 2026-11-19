/** blender_session 的呈现层：会话列表、动作回执、status/doctor 摘要。 */
import { asRecord, isRecord, text } from '../../contracts/dynamic.js'
import type { SessionRow } from '../shared/session.js'

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

export function formatSessionList(sessions: SessionRow[]): string {
  if (!sessions.length)
    return (
      'SESSION list · 0 个会话' +
      LF +
      '没有可见会话：在 Blender N 面板点 Connect 后 blender_session action=attach（多实例必须带 instance_id），' +
      '或经用户同意 action=start kind=virtual-gui。'
    )
  const lines = ['SESSION list · ' + String(sessions.length) + ' 个会话']
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
        ' · agents=' +
        String(agents) +
        (s.paused ? ' · PAUSED(human)' : '') +
        (s.humanModified ? ' · human_modified' : ''),
    )
  }
  return lines.join(LF)
}

export function formatSessionResult(action: string, body: Record<string, unknown>): string {
  const s = asRecord(body.session)
  const head = 'SESSION ' + action + ' ok'
  if (action === 'grants') return head + LF + clip(body.grants ?? [])
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
          text(asRecord(s.owner).agentId || '-')
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

export function formatStatus(body: Record<string, unknown>, sessions: SessionRow[]): string {
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
  if (body.addonError) lines.push('addonError ' + text(body.addonError))
  if (vg.enabled !== undefined)
    lines.push(
      'virtual-gui ' +
        (vg.enabled ? 'enabled' : 'disabled') +
        (vg.ready ? ' · ready' : '') +
        (vg.preview ? ' · preview-only' : '') +
        (vg.reason ? ' · reason=' + text(vg.reason) : ''),
    )
  lines.push(formatSessionList(sessions))
  return lines.join(LF)
}

export function formatDoctor(body: Record<string, unknown>): string {
  const lines = [
    'SESSION doctor · ok=' +
      String(body.ok === true) +
      (body.kind ? ' · kind=' + text(body.kind) : '') +
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
  if (!checks && !body.root_cause) lines.push(clip(body))
  return lines.join(LF)
}

export function sessionHelp(): string {
  return [
    'blender_session 动作（会话生命周期与归属；不含 Gateway 运维）：',
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
