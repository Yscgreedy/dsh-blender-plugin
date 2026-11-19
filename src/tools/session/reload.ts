/**
 * blender_session action=reload（H2）：**工具面**的一步式热更。
 *
 * 与 HTTP 面（POST /lease{action:"reload"}）的分工：
 *   - HTTP 面只能诊断（Gateway 看不到宿主 fiber/profile）→ 宿主层有变时回 409 `mode=hmr`；
 *   - 工具面在宿主机里，所以它做得到那一步：写 profile 的 cordis.patch.yml 触发 HMR 重组合，
 *     或者杀掉宿主手里的 Gateway 句柄从磁盘重拉。
 *
 * ★ 回执**原样**回给模型：无论是 ok=true 还是 409 语义的 ok=false，都走同一份 ReloadReport
 *   （mode / changed / pidBefore / pidAfter / verdict / needsRestart / receipt / note），
 *   **不**压成一句 "SESSION reload 失败 · request failed" —— 那正是上一轮下游验收的痛点：
 *   模型看不到 mode=hmr 与"为什么必须重启"，只能去猜。
 */
import { text } from '../../contracts/dynamic.js'
import { hostReload } from '../../host/reload/index.js'
import { formatReloadReport } from './presenter.js'

export async function executeReload(port: number, args: Record<string, unknown>): Promise<unknown> {
  const dryRun = args.dry_run === true || args.apply === false
  const report = await hostReload({
    port,
    apply: !dryRun,
    // force：不信判据，强制重组合一次。给「镜像被中断 + 清单丢了 → 两层都说 current」留的
    // 唯一恢复手段（不必重启 DSH）。
    force: args.force === true,
    reason: text(args.reason).trim() || undefined,
  })
  return { text: formatReloadReport(report as unknown as Record<string, unknown>), report }
}
