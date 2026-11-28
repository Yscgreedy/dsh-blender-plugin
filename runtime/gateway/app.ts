// Gateway HTTP app assembly: one loopback server, the existing 29 routes, and
// the /addon WebSocket upgrade. No addon listener, no second port.
import http from 'node:http'
import type { Server } from 'node:http'
import { createEngine, engineProvenance } from '../engine.js'
import { createSelectionStore } from '../selectionstore.js'
import { CFG, describeConfig } from '../config.js'
import { HOST, stats, pushRtt, rttView, reqCounts, bump } from '../http/config.js'
import { json, streamJson, readBody, hostJson, hostErrText } from '../http/response.js'
import {
  LEASE,
  leaseView,
  releaseStaleLease,
  leaseAcquire,
  leaseGate,
  isReadOnly,
} from '../http/lease.js'
import { trimJob, clampIntParam } from '../http/jobs.js'
import { SessionRegistry } from '../core/sessions/registry.js'
import { JobQueue } from '../core/queue/manager.js'
import { SpawnJobExecutor } from '../core/queue/spawn-executor.js'
import { installPresencePublisher } from './presence-push.js'
import { gatewayInstances } from '../transport/addon-handshake.js'
import { createRouter } from '../http/router.js'
import { createRoutes, CONTRACT_ROUTES } from '../http/routes/index.js'
import { AddonGateway, GatewayAddonClient, GATEWAY_DEFAULT_PORT } from '../transport/addon-ws.js'
import type { EngineSurface } from '../core/engine/index.js'
import type { AddonClient } from '../transport/probes.js'
import type { HttpRouteDeps } from '../http/routes/deps.js'
import type { AddonGatewayOptions } from '../transport/addon-ws.js'
import type { GatewayOwner } from './owner.js'

export interface GatewayAppOptions extends AddonGatewayOptions {
  port?: number
  host?: string
  /**
   * 只由进程入口（runtime/gateway.ts）打开：打开后 action=reload / action=shutdown
   * 才会真的排定 process.exit —— 测试里进程不能自己死。
   */
  selfExit?: boolean
}

export interface GatewayApp {
  server: Server
  engine: EngineSurface
  sessionRegistry: SessionRegistry
  jobQueue: JobQueue
  addonGateway: AddonGateway
  addonClient: GatewayAddonClient
  port: number
  host: string
  routes: string[]
  owner: GatewayOwner | null
  close: () => void
}

/** Forward addon events to the session registry and any external listener. */
function addonEventSink(
  opts: GatewayAppOptions,
  registryRef: { current: SessionRegistry | null },
): (event: Record<string, unknown>) => void {
  return (event) => {
    if (event.type === 'event' && event.name === 'pause' && registryRef.current) {
      registryRef.current.applyHumanPause(
        event.instanceId === null ? undefined : String(event.instanceId),
        event.paused === true,
      )
    }
    if (event.type === 'connection_closed' && registryRef.current) {
      registryRef.current.handleInstanceGone(String(event.instanceId || ''))
    }
    if (event.type === 'event' && event.name === 'human_edit' && registryRef.current) {
      registryRef.current.applyHumanEdits(
        event.instanceId === null ? undefined : String(event.instanceId),
        [
          ...(Array.isArray(event.objects) ? event.objects : []),
          ...(Array.isArray(event.collections) ? event.collections : []),
        ] as Record<string, unknown>[],
      )
    }
    opts.onEvent?.(event)
  }
}

/**
 * The live liveness probe attachChecked uses (S-1): the transport-level ping is
 * the only proof that the addon inside that Blender still runs its command loop.
 * Extracted so createGatewayApp stays an assembly sequence, not a closure gallery.
 */
function addonPingProbe(addonClient: GatewayAddonClient): (instanceId: string) => Promise<boolean> {
  return async (instanceId: string): Promise<boolean> => {
    try {
      const reply = await addonClient.send('ping', {}, 3000, { instanceId })
      const rec = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : {}
      return rec.ok !== false
    } catch (error) {
      return false
    }
  }
}

/**
 * How many headless/render jobs the queue is running right now (S-5c).
 *
 * Read through the queue's own perf projection instead of poking at job records:
 * `byState.running` is the figure the queue already publishes on /host/jobs, and a
 * queue that cannot answer (null, a shape change) reads as 0 — which is exactly
 * the pre-S-5c budget behaviour rather than a blocked start.
 */
function runningJobCount(queue: JobQueue | null): number {
  if (!queue) return 0
  const byState = queue.perf().byState as Record<string, unknown> | undefined
  const running = Number(byState ? byState.running : 0)
  return Number.isFinite(running) && running > 0 ? Math.floor(running) : 0
}

/** Build the Gateway app without listening; tests and the process entry share it. */
export function createGatewayApp(opts: GatewayAppOptions = {}): GatewayApp {
  const port = opts.port ?? GATEWAY_DEFAULT_PORT
  const host = opts.host ?? HOST
  const registryRef: { current: SessionRegistry | null } = { current: null }
  // S-5c: the registry is assembled before the queue (the queue's reservedGpu reads
  // the registry), so the virtual-gui budget reaches the queue through this ref.
  // Until it is filled, jobLoad reads 0 = the old budget.
  const jobQueueRef: { current: JobQueue | null } = { current: null }
  const addonGateway = new AddonGateway({ ...opts, onEvent: addonEventSink(opts, registryRef) })
  const addonClient = new GatewayAddonClient(addonGateway)
  installPresencePublisher(addonClient)
  const engine = createEngine({ addonClient: addonClient as unknown as AddonClient })
  const selectionStore = createSelectionStore()
  const sessionRegistry = new SessionRegistry(
    () =>
      (gatewayInstances(addonClient) || []).map((x) => ({
        instanceId: x.instanceId,
        kind: x.kind,
        ready: x.ready,
        project: x.project,
      })),
    {
      // attachChecked: a live ping, not the listed socket.
      verify: addonPingProbe(addonClient),
      // S-5c: virtual-gui admission and the post-ready recheck reserve memory for
      // the running headless/render jobs, so a start does not eat their budget.
      jobLoad: () => runningJobCount(jobQueueRef.current),
    },
  )
  registryRef.current = sessionRegistry
  // 队列容量来自 runtime/config.ts 的三段式（Q-1）：env → features.queue → 默认 1/2/64/8，
  // 不在这里写死、也不做自适应；写错的值已在那里回落到默认并留下 invalid:… 来源。
  const queueCapacity = CFG.features.queue
  const jobQueue = new JobQueue({
    executor: new SpawnJobExecutor(),
    capacity: {
      gpu: queueCapacity.gpu,
      cpu: queueCapacity.cpu,
      pending: queueCapacity.pending,
      ownerQuota: queueCapacity.ownerQuota,
    },
    // 每个 starting/ready 的 virtual-gui 占 1 个 GPU slot（Q-2）：render 在它活着时排队并
    // 得到 decision.reason='virtual_gui'，而不是挤上去把显存打爆。
    reservedGpu: () => sessionRegistry.virtualGuiCount(),
  })
  jobQueueRef.current = jobQueue
  const E: HttpRouteDeps = {
    sessionRegistry,
    jobQueue,
    addon: addonClient,
    gatewayOwner: () => app.owner,
    engine,
    selectionStore,
    PORT: port,
    HOST: host,
    stats,
    json,
    streamJson,
    readBody,
    pushRtt,
    rttView,
    reqCounts,
    bump,
    LEASE,
    leaseView,
    releaseStaleLease,
    leaseAcquire,
    // The write gate gets the registry explicitly; routes keep the single-arg
    // LeaseGateFn signature, so no route reads the registry behind the gate's back.
    leaseGate: (p) => leaseGate(p, sessionRegistry),
    isReadOnly,
    trimJob,
    clampIntParam,
    describeConfig,
    engineProvenance,
    hostJson,
    hostErrText,
    // H2/H4 控制面：关停/自重启的出口。close 引用 app（后定义，调用时才求值）。
    gatewayControl: {
      selfExit: opts.selfExit === true,
      close: () => app.close(),
      pid: process.pid,
    },
  }
  const routes = createRoutes(E)
  const server = http.createServer(
    createRouter({ HOST: host, PORT: port, bump, routes, sessionRegistry }),
  )
  addonGateway.attach(server)
  const app: GatewayApp = {
    server,
    engine,
    sessionRegistry,
    jobQueue,
    addonGateway,
    addonClient,
    port,
    host,
    routes: CONTRACT_ROUTES,
    owner: null,
    close: () => {
      try {
        engine.stop()
      } catch (e) {
        /* ignore */
      }
      addonGateway.close()
      try {
        server.close()
      } catch (e) {
        /* ignore */
      }
    },
  }
  return app
}
