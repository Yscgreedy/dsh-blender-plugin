/** blender_py：在 ready 的 GUI 会话里执行 Python（不启动 headless）。 */
import { vTool } from '../../contracts/tool.js'
import type { HostContext } from '../../host/context.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { renderOne } from '../../ui/cards.js'
import { requireReadySession } from '../shared/session.js'
import { executePy } from './execute.js'

function buildPyTool(ctx: HostContext, port: number) {
  return vTool({
    name: 'blender_py',
    description:
      '【执行 Python】在 ready 的 GUI 会话里跑 agent 写的 Python（/act 通道）。' +
      '没有会话直接拒绝，不启动 headless、不自动降级。超过 ~1s 的重活请用 blender_run(kind=headless)。' +
      '可选 see=true（默认）跑完抓一帧（共享用户视口，同画面不重复附图）。' +
      '默认留 txn 回退点（checkpoint=auto）：超时/掉线时脚本可能仍在跑，回执给 outcome_unknown + request_id，先确认现场再重跑。' +
      '旧工具迁移：blender_rt_do / blender_rt_watch 的 code → blender_py。',
    parameters: {
      code: { type: 'string', description: '要执行的 Python 源码（与 file 二选一）' },
      file: { type: 'string', description: '要执行的 .py 文件路径（与 code 二选一）' },
      see: { type: 'boolean', description: '跑完是否抓当前视口一帧（默认 true）' },
      max_size: { type: 'integer', description: 'see 的最长边像素，默认 560' },
      force: { type: 'boolean', description: 'see：同画面默认不重复附图，true 强制重发' },
      write_scope: {
        type: 'json',
        description:
          '写作用域：exclusive（默认）| collection:COL | prefix:LGT- | object:uid；须与父 grant 覆盖一致，超出记 scope_violation',
      },
      checkpoint: {
        type: 'string',
        description: '执行前是否留 txn 回退点：auto（默认，失败只告警）| off',
      },
      wait_ms: {
        type: 'integer',
        description:
          '等其它 agent 的 py 跑完的毫秒数（0–5000，默认 0）；真的排队等锁，等满才回 py_busy',
      },
    },
    output: { schema: ANY_SCHEMA, render: renderOne },
    isConcurrencySafe: () => false,
    timeoutMs: T.act,
    async execute(args: Record<string, unknown>) {
      const ready = await requireReadySession(port)
      if (!ready.ok) return ready.failure
      return executePy(ctx, port, args, ready.session)
    },
  })
}

export function registerPy(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildPyTool(ctx, port)), 'dsh-blender-plugin: py')
}
