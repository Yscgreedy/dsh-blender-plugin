/** blender_session：GUI 会话生命周期、所有权、写权限 scope、pause 与事务快照。 */
import { vTool } from '../../contracts/tool.js'
import type { HostContext } from '../../host/context.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { renderOne } from '../../ui/cards.js'
import { executeSession } from './execute.js'

const ACTIONS = [
  'list',
  'status',
  'doctor',
  'attach',
  'claim',
  'detach',
  'release',
  'grant',
  'revoke',
  'grants',
  'pause',
  'resume',
  'mark_read',
  'presence',
  'heartbeat',
  'start',
  'stop',
  'consent_request',
  'consent_status',
  'consent_approve',
  'consent_deny',
  'txn',
  'reload',
  'help',
]

function buildSessionTool(ctx: HostContext, port: number) {
  return vTool({
    name: 'blender_session',
    description:
      '【会话 / 归属 / 权限】管理 GUI 会话：list/status/doctor 看状态；attach 附着到已打开的 Blender（多实例给 instance_id）；grant/revoke 把写 scope（exclusive | collection:名 | prefix:名 | object:名）授予子 agent；pause/resume 只有人类能操作；mark_read 清 human_modified 冲突。' +
      'start/stop 只作用 virtual-gui：start 返回 consent_required 时回执带 request_id 与人类要跑的一行 approve/deny 命令，批准后再 start（只消费一次）；无人值守可设 DSH_BLENDER_VIRTUAL_GUI_CONSENT=allow。' +
      'txn：snapshot/restore/list/prune/mark/revert/marks/drop（写操作需 exclusive grant）。' +
      'reload：一步式热更（宿主层写 profile patch 触发 HMR，运行时层重拉 Gateway），回执 mode/pid/verdict/needsRestart（dry_run 只诊断）。' +
      '旧 blender_viewport 动作用这里。',
    parameters: {
      action: { type: 'string', required: true, description: ACTIONS.join(' | ') },
      session_id: { type: 'string', description: '会话 id（大多数会话级动作必填）' },
      instance_id: { type: 'string', description: 'attach/claim 的实例 id（多实例必填）' },
      kind: { type: 'string', description: 'start 的会话类型，只接受 virtual-gui' },
      scopes: {
        type: 'string',
        description: 'exclusive | collection:COL | prefix:OBJ_ | object:Cube',
      },
      target_agent_id: {
        type: 'string',
        description: 'grant 的目标 agent id（同 DSH session 内）',
      },
      target_dsh_session_id: { type: 'string', description: 'grant 的目标 DSH session id' },
      target_host_id: { type: 'string', description: 'grant 的目标 host id' },
      grant_id: { type: 'string', description: 'revoke 的 grant id' },
      request_id: {
        type: 'string',
        description: 'consent_approve/deny 的 request_id（来自 start 回执）',
      },
      ttl_ms: { type: 'integer', description: 'grant 有效期毫秒（默认由 Gateway 决定）' },
      op: {
        type: 'string',
        description: 'txn 子动作：snapshot/restore/list/prune/mark/revert/marks/drop/help',
      },
      label: { type: 'string', description: 'txn：快照 / mark 的名字' },
      note: { type: 'string', description: 'txn：snapshot 备注' },
      objects: { type: 'string', description: 'txn：mark 限定的对象（逗号分隔）' },
      keep: { type: 'integer', description: 'txn prune：保留最近 N 个快照' },
      into: { type: 'string', description: 'txn restore：auto | snapshot | original' },
      backup: { type: 'boolean', description: 'txn restore：是否先留 pre_restore 备份' },
      force: {
        type: 'boolean',
        description: 'txn/lease 强抢；reload 强制重组合一次',
      },
      dry_run: { type: 'boolean', description: 'reload：只诊断不动进程（不写 profile、不换 pid）' },
      reason: { type: 'string', description: 'reload：写进 profile 触发注释的原因（单行）' },
      probeFixture: {
        type: 'string',
        description: 'list/doctor：回放诱饵 fixture，回执含 false_positives',
      },
      forceNoAddon: { type: 'boolean', description: 'doctor：模拟无 addon，仍出 39877 证据' },
    },
    output: { schema: ANY_SCHEMA, render: renderOne },
    isConcurrencySafe: () => true,
    timeoutMs: T.txn,
    async execute(args: Record<string, unknown>) {
      return executeSession(port, args)
    },
  })
}

export function registerSession(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildSessionTool(ctx, port)), 'dsh-blender-plugin: session')
}
