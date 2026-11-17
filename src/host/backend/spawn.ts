/** host/backend/spawn：子进程句柄与生命周期（issue #51 的 win32 三件套集中在这里）。 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_PATH } from '../../constants.js'
import { HOST_MANIFEST_ENV, winKillPids } from '../runtime-bridge.js'
import { ensureHostManifest } from './host-manifest.js'

let child: ChildProcess | null = null

function openGatewayLog(): number | null {
  try {
    return openSync(gatewayLogPath(), 'a')
  } catch {
    return null
  }
}

/** Host-side Gateway log; the child inherits the same file for stdout and stderr. */
export function gatewayLogPath(): string {
  const dir = process.env.DSH_BLENDER_WORKDIR
    ? path.join(process.env.DSH_BLENDER_WORKDIR, 'logs')
    : path.join(os.tmpdir(), 'dsh-blender-gateway')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'gateway-host.log')
}

/** 子进程是否真的还活着：被信号杀掉时 exitCode 仍为 null、只有 signalCode 有值 */
export function childAlive(): boolean {
  return !!(child && child.exitCode === null && child.signalCode === null && child.pid)
}

export function spawnChild(port: number): string {
  // issue #51（win32 宿主）：三处都必须显式给，不能靠环境继承。
  //   ① ELECTRON_RUN_AS_NODE：host 跑在 Electron 里时 process.execPath 是 **GUI 可执行体**，
  //      不带这个变量会另起一个 GUI 实例（或直接被单实例锁吞掉），而不是 node 子进程；
  //   ② windowsHide：console-subsystem 可执行体在"宿主无控制台"时会新配一个控制台（#38/#43 同族）；
  //   ③ detached=false：Gateway 生命周期归 host/plugin；不 detach、不 unref，host 退出由插件清理。
  const logFd = openGatewayLog()
  // H1：把「宿主这一代装载的是哪些 lib 文件」交给 Gateway。清单在宿主 fiber 首次 spawn 时
  // 定型，之后只重启 Gateway 不会重写 —— 宿主层因此不会「一重启就自证成最新」。
  const hostManifest = ensureHostManifest()
  const spawned = spawn(process.execPath, [GATEWAY_PATH, '--port', String(port)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(hostManifest ? { [HOST_MANIFEST_ENV]: hostManifest } : {}),
    },
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    detached: false,
    windowsHide: true,
  })
  if (logFd !== null) {
    try {
      closeSync(logFd)
    } catch {
      /* the child keeps its inherited handle */
    }
  }
  child = spawned
  // ★ 必须挂监听：spawn 的失败（EPERM / EACCES / ENOENT）是**异步 'error' 事件**。
  //   没有监听时它会冒到宿主的 uncaughtException —— 现场（#51）表现为 dsh-desktop-host 每 15 s
  //   整个被打死一次（看护间隔 ENSURE_INTERVAL_MS 一到就重试），并且残留后端占着端口。
  //   有监听则只降级为"后端不可用"，宿主照常跑。
  spawned.on('error', (err: Error) => {
    if (child === spawned) child = null
    try {
      console.error('[dsh-blender] Gateway 子进程启动失败（已降级，宿主不受影响）：' + err.message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  })
  spawned.on('exit', () => {
    if (child === spawned) child = null
  })
  return 'spawned pid=' + String(spawned.pid)
}

/** stale-handle 分支：句柄在、端口不通 → 按平台停掉不可信的旧句柄并返回其 pid。 */
export function killStaleChild(): number | null {
  const stalePid = child?.pid
  if (!stalePid) return null
  try {
    if (process.platform === 'win32') winKillPids([stalePid])
    else process.kill(stalePid, 'SIGTERM')
  } catch {
    /* 已经没了 */
  }
  child = null
  return stalePid
}

export function getChild(): ChildProcess | null {
  return child
}

/**
 * 杀掉并清空当前子进程句柄；返回是否原本有句柄（调用方据此写回执）。
 *
 * H4（dispose 收干净）：**必须杀进程树**。Gateway 自己 spawn 的 helper
 * （dsh-blender-hidden-desktop）与它拉起的隐藏 Blender 是它的子/孙进程，只 kill 父进程会留孤儿 ——
 * 现场后果是"热更十轮之后 helper 越堆越多 / 目录替换半残"。win32 没有优雅信号，
 * 统一走 win_proc 的 taskkill /T /F（与 killStaleChild、作业队列同一套清理原语）；
 * POSIX 仍发 SIGTERM，让 Gateway 自己的 shutdown 钩子（engine.stop + server.close）跑完。
 */
export function killChildHandle(): boolean {
  if (!child) return false
  const handle = child
  const pid = handle.pid
  child = null
  try {
    if (pid && process.platform === 'win32') winKillPids([pid])
    else handle.kill()
  } catch {
    /* 已经退出 */
  }
  return true
}
