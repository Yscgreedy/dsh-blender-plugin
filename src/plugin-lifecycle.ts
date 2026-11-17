/** 插件生命周期装配：自动拉起、15s 常驻看护、卸载清句柄（与工具面解耦）。 */
import {
  ensureBackend,
  isPaused,
  killBackendByCmd,
  killChildHandle,
  probe,
  sleep,
} from './host/backend/index.js'
import {
  canRestartGateway,
  noteGatewayRestartFailure,
  noteGatewayRestartSuccess,
} from './host/backend/restart.js'
import { refreshHostManifest } from './host/backend/host-manifest.js'
import { settlePendingReload } from './host/reload/index.js'
import type { HostContext } from './host/context.js'

export function registerLifecycle(ctx: HostContext, port: number, autoStart: boolean): void {
  // H1：这一代 fiber 装载时重写宿主层清单（模块实例被复用时**不**重写 —— 旧代码不该自证成最新）。
  try {
    refreshHostManifest()
  } catch {
    /* 清单失败 = 降级（Gateway 回扫盘并在 note 里写明），不影响启动 */
  }

  void (async () => {
    if (autoStart && !isPaused()) {
      if (await ensureBackend(port)) noteGatewayRestartSuccess()
      else noteGatewayRestartFailure()
    }
    // H2：上一代触发的 HMR 到底成不成 —— 只有新一代写得下 pidAfter/verdict（两段式收尾）。
    try {
      await settlePendingReload(port)
    } catch {
      /* 收尾失败只影响自证记录的完整性，不影响后端可用性 */
    }
  })()

  // 常驻看护：每 15s 探活一次，掉线自动拉起（宿主重启 / 进程被杀 / 端口被回收都能自愈）。
  // 显式 op=stop 会置 paused，看护尊重它，不会跟用户对着干。
  // ★ v1.0.1（探活失败时**先清尸再重生**）：否则"僵死后端占着端口"时，重生进程必然撞
  //   EADDRINUSE 退出 → 每 15 s 空转一次、永不自愈（现场：后端事件循环被长时间同步操作占死，
  //   /health 不应答、连 SIGTERM 都排不上队）。probe 超时只有 1500ms，所以连续 2 次（≈30s）
  //   失败才认定卡死，避免把"只是忙"的后端杀掉。
  let probeMisses = 0
  ctx.effect(() => {
    const wd = setInterval(() => {
      void (async () => {
        try {
          if (isPaused()) return
          if (await probe(port)) {
            probeMisses = 0
            noteGatewayRestartSuccess()
            // 3.1: ownership/grant heartbeats travel with real calls; the watchdog
            // only checks Gateway liveness and never renews a legacy write lease.
            return
          }
          probeMisses += 1
          if (probeMisses >= 2) {
            probeMisses = 0
            // SIGTERM → 1.2s → SIGKILL：事件循环被同步操作占死的进程只认 SIGKILL
            try {
              killBackendByCmd(port, 'SIGTERM')
            } catch {
              /* 忽略 */
            }
            await sleep(1200)
            try {
              killBackendByCmd(port, 'SIGKILL')
            } catch {
              /* 忽略 */
            }
          }
          // Bounded auto-restart: exponential backoff up to 30 s, five failures.
          // An explicit op=start resets the budget (see viewport/execute.ts).
          if (!canRestartGateway()) return
          if (await ensureBackend(port)) noteGatewayRestartSuccess()
          else noteGatewayRestartFailure()
        } catch {
          /* 看护失败静默，下一轮再试 */
        }
      })()
    }, 15000)
    return () => clearInterval(wd)
  }, 'dsh-blender-plugin: watchdog')

  ctx.effect(
    () => () => {
      // H4（dispose 收干净）：杀**进程树**，不只是一个句柄 —— helper
      // （dsh-blender-hidden-desktop）与它拉起的隐藏 Blender 都是 Gateway 的孙进程，
      // 只 kill 父进程会留下一串孤儿（现场：热更十轮后 helper 越堆越多、目录替换半残）。
      //
      // 这里**不做** graceful drain：dispose 是同步回调，先发 shutdown 再杀会和新 fiber 的
      // ensureBackend 抢同一端口（新 fiber 可能把"正在退出的旧 Gateway"认成已就绪）。
      // 优雅收尾放在异步面：blender_session action=reload 的运行时层换代先 drainGateway 再杀
      // （见 src/host/reload/index.ts）；其余情况由下一代的台账收敛
      // （queue restore → lost=true、ledger reconcile → recovered/stale）。
      killChildHandle()
    },
    'dsh-blender-plugin: backend',
  )
}
