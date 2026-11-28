/**
 * blender_session：GUI 会话的生命周期、归属、写权限 scope、pause 与 txn 子面。
 *
 * Gateway 进程本身由宿主管理；这个工具不暴露 launch / lease / kill 运维动作。
 */
import { BACKEND_HINT } from '../../constants.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import { ensureBackend } from '../../host/backend/index.js'
import { backendJson } from '../../host/http.js'
import { toolError } from '../errors.js'
import { gatewayFailure, isFailureBody, listSessions, sessionAction } from '../shared/session.js'
import {
  formatConsent,
  formatDoctor,
  formatSessionList,
  formatSessionResult,
  formatStatus,
  sessionHelp,
} from './presenter.js'
import { executeReload } from './reload.js'
import { executeTxn } from './txn.js'

/**
 * 人类专属的决定动作。保留在这里只为了给出**明确的拒绝**（而不是"未知动作"），
 * 让人知道批准发生在会话面板 / 终端，而不是模型这一侧。
 */
const HUMAN_ONLY_ACTIONS = ['consent_approve', 'consent_deny']

const CAMEL: Record<string, string> = {
  request_id: 'requestId',
  session_id: 'sessionId',
  instance_id: 'instanceId',
  kind: 'kind',
  grant_id: 'grantId',
  ttl_ms: 'ttlMs',
  target_agent_id: 'targetAgentId',
  target_dsh_session_id: 'targetDshSessionId',
  target_host_id: 'targetHostId',
  force: 'force',
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

/** 工单 6 注入参数：snake_case 与 camelCase 都认（工单里的键名是 camelCase）。 */
function boolArg(args: Record<string, unknown>, ...names: string[]): boolean {
  for (const name of names) {
    const v = args[name]
    if (v === true) return true
    const s = String(v ?? '')
      .trim()
      .toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
  }
  return false
}

function strArg(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    if (present(args[name])) return String(args[name]).trim()
  }
  return null
}

interface ListContext {
  evidence: Record<string, unknown> | null
  addon: Record<string, unknown> | null
}

/**
 * 工单 6：list 的本地证据 + addon 实例表来自 Gateway 的 /status?evidenceOnly=1（不付 addon 往返）。
 *
 * 这里不解析会话行（只取 local_evidence / addon），所以没有可迁移的 ready 判定：
 * resolveSession 回答"这次调用驱动哪一个会话"，这里回答"本机看见了什么"。
 */
async function listContextOf(port: number, args: Record<string, unknown>): Promise<ListContext> {
  const q = new URLSearchParams({ evidence: '1', evidenceOnly: '1' })
  const fixture = strArg(args, 'probeFixture', 'probe_fixture')
  if (fixture) q.set('probeFixture', fixture)
  try {
    const body = await backendJson(port, '/status?' + q.toString(), 20000)
    return { evidence: asRecord(body.local_evidence), addon: asRecord(body.addon) }
  } catch {
    return { evidence: null, addon: null }
  }
}

/** scopes 接受数组、JSON 数组字符串，或逗号分隔字符串。 */
function parseScopes(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean)
  const s = String(raw).trim()
  if (!s) return undefined
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean)
    } catch {
      /* 不是 JSON，按逗号串处理 */
    }
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function payloadFor(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  for (const [snake, camel] of Object.entries(CAMEL)) {
    if (present(args[snake])) p[camel] = args[snake]
  }
  const scopes = parseScopes(args.scopes ?? args.scope)
  if (scopes !== undefined) p.scopes = scopes
  if (action === 'start') {
    p.kind = present(args.kind) ? text(args.kind) : 'virtual-gui'
    const token = args.__consent_token ?? args.consent_token
    if (present(token)) p.consentToken = text(token)
    const waitMs = args.wait_ms ?? args.waitMs
    if (present(waitMs)) p.waitMs = Number(waitMs)
  }
  return p
}

/** start 的 HTTP 预算：人可能要看一眼面板再点批准，别让传输层先超时。 */
function startTimeout(args: Record<string, unknown>): number {
  const raw = Number(args.wait_ms ?? args.waitMs)
  const wait = Number.isFinite(raw) && raw >= 0 ? raw : 20000
  return Math.min(120000, wait) + 20000
}

/**
 * Actions that must name a session. presence / grants / heartbeat / detach are
 * intentionally absent: the registry resolves the caller's own session
 * (`findForCaller`) and the old guard only produced "需要 session_id" with no
 * candidate id even when the caller had exactly one session (field report C-12).
 */
const NEED_SESSION = ['release', 'stop', 'pause', 'resume', 'mark_read', 'grant', 'revoke']

function validate(action: string, args: Record<string, unknown>): string | null {
  if (action === 'start') {
    const kind = present(args.kind) ? text(args.kind) : 'virtual-gui'
    if (kind !== 'virtual-gui')
      return 'start 只启动 virtual-gui；user-gui 由用户在 Blender 里打开并 Connect 后 action=attach'
    return null
  }
  if (NEED_SESSION.includes(action) && !present(args.session_id)) return action + ' 需要 session_id'
  if (action === 'grant' && parseScopes(args.scopes ?? args.scope) === undefined)
    return 'grant 需要 scopes（exclusive | collection:名 | prefix:名 | object:名）'
  if (action === 'revoke' && !present(args.grant_id)) return 'revoke 需要 grant_id'
  return null
}

/**
 * status 要**整张**会话表（formatStatus 逐行渲染），不是"挑一个 ready 会话"；
 * sessionRefOf 只描述一行，用它会把多行证据压成一个。这里保留 listSessions。
 */
async function statusOf(port: number): Promise<unknown> {
  const listed = await listSessions(port)
  if (!listed.ok) return listed.failure
  let body: Record<string, unknown>
  try {
    // 反馈 7: status and list must read the same source (local_evidence.sessions).
    body = await backendJson(port, '/status?evidence=1', 20000)
  } catch (e: unknown) {
    return toolError(
      'gateway_unreachable',
      'status 失败 · ' + text(e instanceof Error ? e.message : e),
      BACKEND_HINT,
    )
  }
  if (body.ok === false && !body.readiness && !body.running)
    return toolError(
      'backend_error',
      'status 失败 · ' + text(body.error || body.raw || 'unknown'),
      '先 blender_session action=doctor 看 Gateway/addon 状态',
    )
  return {
    text: formatStatus(body, listed.sessions, asRecord(body.local_evidence)),
    evidence: asRecord(body.local_evidence),
  }
}

async function doctorOf(port: number, args: Record<string, unknown>): Promise<unknown> {
  // 6b：no-addon 态也要能出 39877 证据 —— 这些键必须真能激活（参数 / env 两条路）。
  const q = new URLSearchParams()
  if (boolArg(args, 'forceNoAddon', 'force_no_addon')) q.set('forceNoAddon', '1')
  const probeFixture = strArg(args, 'probeFixture', 'probe_fixture')
  if (probeFixture) q.set('probeFixture', probeFixture)
  const suffix = q.toString() ? '?' + q.toString() : ''
  let body: Record<string, unknown>
  try {
    body = await backendJson(port, '/doctor' + suffix, 60000)
  } catch (e: unknown) {
    return toolError(
      'gateway_unreachable',
      'doctor 失败 · ' + text(e instanceof Error ? e.message : e),
      BACKEND_HINT,
    )
  }
  if (body.ok === false && !body.checks && !body.kind && !body.error)
    return toolError('backend_error', 'doctor 失败 · ' + text(body.raw || 'unknown'), BACKEND_HINT)
  if (body.ok === false && body.error && !body.checks && !body.kind && !body.root_cause)
    return toolError(
      'backend_error',
      'doctor 失败 · ' + text(body.error),
      'Gateway 由宿主管理：重启 DSH 插件后重试；addon 需在 Blender N 面板点 Connect',
    )
  return {
    text: formatDoctor(body),
    evidence: asRecord(body.local_evidence),
    verdict: body.verdict ?? null,
  }
}

/** Structured companion to the human text: attach/viewer flags at the top level. */
function sessionReceipt(action: string, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { text: formatSessionResult(action, body) }
  const row = asRecord(body.session)
  if (row.id) {
    out.session_id = row.id
    out.owner = row.owner ?? null
    out.is_mine = row.is_mine ?? null
    out.borrowed = row.borrowed ?? null
  }
  // 3.3.1：consent_source 是"这次 start 凭什么被允许"的唯一字段，放在回执顶层，
  // 别逼调用方去 session.consent_source 里翻。
  if (row.consent_source !== undefined) out.consent_source = row.consent_source
  if (body.viewer !== undefined) out.viewer = body.viewer === true
  if (action === 'whoami') {
    out.caller = body.caller ?? null
    out.agentId = body.agentId ?? null
    out.dshSessionId = body.dshSessionId ?? null
    out.hostId = body.hostId ?? null
    out.role = body.role ?? null
  }
  if (action === 'release' || action === 'detach') {
    out.released = body.released === true
    out.reason = body.reason ?? null
  }
  if (Array.isArray(body.grants)) out.grants = body.grants
  return out
}
export async function executeSession(
  port: number,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!(await ensureBackend(port)))
    return toolError(
      'backend_unreachable',
      '后端不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  const action = text(args.action).trim() || 'list'
  if (action === 'help') return { text: sessionHelp() }
  if (action === 'txn') return executeTxn(port, args)
  // H2：reload 是**宿主**的动作（写 profile patch / 杀自己的 Gateway 句柄），不转发给 /lease
  // 的会话动作通道 —— 那条通道只会 409，并把 ReloadReport 包成一句 request failed。
  if (action === 'reload') return executeReload(port, args)
  if (action === 'status') return statusOf(port)
  if (action === 'doctor') return doctorOf(port, args)
  if (action === 'list') {
    // 0 会话也要给出 attach 指引：这里需要全部行，不是 resolveSession 的单行结果。
    const listed = await listSessions(port)
    if (!listed.ok) return listed.failure
    // 6a：0 会话也要能看见 local_processes / ports / ports_evidence + 可粘贴的 attach。
    const ctx = await listContextOf(port, args)
    // 结构化面：文本给人看，evidence/addon 给判据（别让验收只能靠正则扒文本）。
    return {
      text: formatSessionList(listed.sessions, ctx.evidence, ctx.addon),
      evidence: ctx.evidence,
      addon: ctx.addon,
    }
  }
  if (HUMAN_ONLY_ACTIONS.includes(action))
    return toolError(
      'consent_human_only',
      action + ' 是人类动作：agent 不能批准自己刚落的 virtual-gui 请求',
      '在会话的「Blender 会话」面板点「批准」，或让 Gateway 主机的终端执行回执里的命令；无人值守设 virtualGuiConsent=auto',
      JSON.stringify({ action, request_id: args.request_id || null }),
      'session',
    )
  const bad = validate(action, args)
  if (bad) return toolError('invalid_params', bad, 'action=help 查看可用动作与参数')
  const body = await sessionAction(
    port,
    action,
    payloadFor(action, args),
    action === 'start' ? startTimeout(args) : undefined,
  )
  if (isFailureBody(body)) return consentOrFailure(action, body)
  return sessionReceipt(action, asRecord(body))
}

/**
 * consent_required 不是一句普通错误：它是**给人类看的请求**。带上 request_id 与
 * 可直接复制的一行 approve 命令返回，agent 照着转述即可；其余失败保持原样。
 */
function consentOrFailure(
  action: string,
  body: Record<string, unknown> | Record<string, unknown>,
): unknown {
  if (String(body.code || '') === 'consent_required')
    return {
      text: formatConsent(body),
      envelope: {
        code: 'consent_required',
        action: action,
        request_id: body.request_id || asRecord(body.evidence).request_id || null,
        human_action: body.human_action || null,
        policy: asRecord(body.evidence).policy || 'ask',
      },
    }
  return gatewayFailure(body, 'SESSION ' + action)
}
