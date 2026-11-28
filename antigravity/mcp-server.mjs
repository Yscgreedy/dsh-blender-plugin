#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { losslessSanitize } from '../lib/contracts/lossless.js'
import {
  base,
  ensureBackend,
  isPaused,
  killBackendByCmd,
  killChildHandle,
  probe,
  resolveHttpPort,
  sleep,
} from '../lib/host/backend/index.js'
import {
  canRestartGateway,
  noteGatewayRestartFailure,
  noteGatewayRestartSuccess,
} from '../lib/host/backend/restart.js'
import { EXEC_CTX } from '../lib/host/exec-context.js'
import { executeInspect } from '../lib/tools/inspect/execute.js'
import { executeOp } from '../lib/tools/op/execute.js'
import { executePy } from '../lib/tools/py/execute.js'
import { executeRun } from '../lib/tools/run/execute.js'
import { executeSee } from '../lib/tools/see/execute.js'
import { pngSize } from '../lib/tools/see/presenter.js'
import { executeSession } from '../lib/tools/session/execute.js'
import { requireReadySession, sessionRequiredFailure } from '../lib/tools/shared/session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PANEL_URI = 'ui://dsh-blender/panel.html'
const MAX_INLINE_IMAGES = 6
const MAX_INLINE_IMAGE_BYTES = 750 * 1024
const PORT = resolveHttpPort()

const CALLER = {
  hostId: `antigravity-pid-${process.pid}`,
  dshSessionId: process.env.ANTIGRAVITY_SESSION_ID || `antigravity-mcp-${process.pid}`,
  agentId: 'antigravity',
  role: 'main',
}

const EXEC_STUB = {
  agent: {
    id: CALLER.agentId,
    role: CALLER.role,
    session: {
      id: CALLER.dshSessionId,
      cwd: process.cwd(),
    },
  },
}

function createMockContext() {
  const savedImages = new Map()
  const ctx = {
    get(name) {
      if (name !== 'attachments') return undefined
      return {
        imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] },
        async saveImage({ data, mediaType, name: fileName }) {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
          const [width, height] = pngSize(bytes)
          const attachmentId = randomUUID()
          savedImages.set(attachmentId, {
            base64: Buffer.from(bytes).toString('base64'),
            mediaType: mediaType || 'image/png',
            bytes: bytes.byteLength,
          })
          return {
            attachmentId,
            mediaType: mediaType || 'image/png',
            bytes: bytes.byteLength,
            width: width || 0,
            height: height || 0,
            name: fileName,
          }
        },
      }
    },
  }
  return { ctx, savedImages }
}

function toMcpToolResult(raw, savedImages) {
  const { value } = losslessSanitize(raw)
  const record = value && typeof value === 'object' ? value : { text: String(value ?? '') }
  const content = []
  if (record.envelope) {
    content.push({ type: 'text', text: JSON.stringify(record.envelope) })
  }
  content.push({ type: 'text', text: String(record.text || '') })

  const refs = []
  if (record.image) refs.push(record.image)
  if (Array.isArray(record.images)) refs.push(...record.images)

  let usedBytes = 0
  let attached = 0
  let omitted = 0
  for (const ref of refs) {
    const id = ref && typeof ref === 'object' ? ref.attachmentId : null
    if (!id || !savedImages.has(id)) continue
    const entry = savedImages.get(id)
    if (attached >= MAX_INLINE_IMAGES || usedBytes + entry.base64.length > MAX_INLINE_IMAGE_BYTES) {
      omitted += 1
      continue
    }
    content.push({ type: 'image', data: entry.base64, mimeType: entry.mediaType })
    usedBytes += entry.base64.length
    attached += 1
  }
  if (omitted > 0) {
    content.push({
      type: 'text',
      text: `[antigravity-mcp] 已省略 ${omitted} 张图片以控制单次工具回执在 1 MiB 上限内。`,
    })
  }
  return { content, isError: Boolean(record.isError) }
}

async function fetchJsonNoIdentity(urlPath, init) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(base(PORT) + urlPath, { ...(init || {}), signal: ac.signal })
    const text = await res.text()
    try {
      return { status: res.status, ok: res.ok, body: JSON.parse(text) }
    } catch {
      return { status: res.status, ok: res.ok, body: { raw: text.slice(0, 500) } }
    }
  } finally {
    clearTimeout(timer)
  }
}

async function collectPanelState(includeFrame = false) {
  const online = await probe(PORT)
  if (!online) {
    return {
      online: false,
      port: PORT,
      health: {},
      hostState: {},
      panel: {
        policy: { mode: 'manual', source: 'default', locked: false },
        pending: [],
        claims: [],
      },
      jobs: [],
      frameBase64: null,
    }
  }

  const [healthRes, hostStateRes, panelRes, jobsRes] = await Promise.all([
    fetchJsonNoIdentity('/health').catch(() => ({ body: {} })),
    fetchJsonNoIdentity('/host/state').catch(() => ({ body: {} })),
    fetchJsonNoIdentity('/lease?action=consent_panel').catch(() => ({ body: {} })),
    fetchJsonNoIdentity('/host/jobs?limit=20').catch(() => ({ body: {} })),
  ])

  let frameBase64 = null
  if (includeFrame) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 5000)
      const r = await fetch(base(PORT) + '/frame.png?size=480', { signal: ac.signal })
      clearTimeout(timer)
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 0 && buf.length < 700 * 1024) {
          frameBase64 = buf.toString('base64')
        }
      }
    } catch {
      frameBase64 = null
    }
  }

  const jobsBody = jobsRes.body && typeof jobsRes.body === 'object' ? jobsRes.body : {}
  const jobs = Array.isArray(jobsBody.jobs) ? jobsBody.jobs : []

  return {
    online: true,
    port: PORT,
    health: healthRes.body || {},
    hostState: hostStateRes.body || {},
    panel: panelRes.body || {},
    jobs,
    frameBase64,
  }
}

const TOOLS = [
  {
    name: 'blender_session',
    description:
      '【会话 / 归属 / 权限】管理 GUI 会话：list/status/doctor/attach/claim/detach/release/grant/revoke/grants/pause/resume/mark_read/presence/heartbeat/start/stop/consent_request/consent_status/txn/reload/help。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '会话动作，默认 list' },
        session_id: { type: 'string' },
        instance_id: { type: 'string' },
        kind: { type: 'string' },
        wait_ms: { type: 'integer' },
        scopes: { type: 'string' },
        target_agent_id: { type: 'string' },
        target_dsh_session_id: { type: 'string' },
        target_host_id: { type: 'string' },
        grant_id: { type: 'string' },
        request_id: { type: 'string' },
        ttl_ms: { type: 'integer' },
        op: { type: 'string' },
        label: { type: 'string' },
        note: { type: 'string' },
        objects: { type: 'string' },
        keep: { type: 'integer' },
        into: { type: 'string' },
        backup: { type: 'boolean' },
        force: { type: 'boolean' },
        dry_run: { type: 'boolean' },
        reason: { type: 'string' },
        probeFixture: { type: 'string' },
        forceNoAddon: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'blender_op',
    description:
      '【算子】执行 catalog 的 plan 算子（38 family / 270 op；op=catalog 看目录），以及 loop/opt/preset/help。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'plan | loop | opt | preset | help（默认 plan）' },
        op: { type: 'string' },
        args: { type: ['object', 'string'] },
        path: { type: 'string' },
        instance_id: { type: 'string' },
        write_scope: { type: ['object', 'string'] },
        attach_images: { type: 'boolean' },
        headless: { type: 'boolean' },
        session: { type: 'string' },
        target: { type: 'string' },
        spec: { type: ['object', 'string'] },
        history: { type: 'integer' },
        board: { type: 'integer' },
        limit: { type: 'integer' },
        groups: { type: 'boolean' },
        top: { type: 'integer' },
        include_variants: { type: 'boolean' },
        note: { type: 'string' },
        iterations: { type: 'integer' },
        name: { type: 'string' },
        kind: { type: 'string' },
        tags: { type: 'string' },
        names: { type: 'string' },
        targets: { type: 'string' },
        data: { type: ['object', 'string'] },
        overwrite: { type: 'boolean' },
      },
    },
  },
  {
    name: 'blender_py',
    description:
      '【执行 Python】在 ready 的 GUI 会话里跑 agent 写的 Python（/act 通道），可选 see=true 抓一帧。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        file: { type: 'string' },
        see: { type: 'boolean' },
        max_size: { type: 'integer' },
        force: { type: 'boolean' },
        write_scope: { type: ['object', 'string'] },
        checkpoint: { type: 'string' },
        wait_ms: { type: 'integer' },
      },
    },
  },
  {
    name: 'blender_see',
    description:
      '【看 GUI】从 ready 的 GUI 会话抓帧（viewport / camera / custom，mode=frame 或 sequence）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        camera: { type: 'string' },
        aspect: { type: 'string' },
        max_size: { type: 'integer' },
        from: { type: ['array', 'string'] },
        look_at: { type: ['array', 'string'] },
        lens: { type: 'number' },
        ortho: { type: 'boolean' },
        ortho_scale: { type: 'number' },
        fit: { type: 'string' },
        fit_object: { type: ['boolean', 'string', 'array'] },
        clip_start: { type: 'number' },
        full: { type: 'boolean' },
        area: { type: 'integer' },
        shading: { type: 'string' },
        overlays: { type: 'boolean' },
        diagnostics: { type: 'boolean' },
        seconds: { type: 'number' },
        fps: { type: 'number' },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'blender_run',
    description:
      '【作业 / 渲染】后台异步作业（submit kind=render|headless）、队列查询（status/wait/collect/cancel/list）、持久无头 worker 与性能调优（tune）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        kind: { type: 'string' },
        id: { type: 'string' },
        priority: { type: 'integer' },
        timeout_ms: { type: 'integer' },
        tail: { type: 'integer' },
        state: { type: 'string' },
        owner: { type: 'string' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        since_ms: { type: 'integer' },
        file: { type: 'string' },
        output: { type: 'string' },
        outdir: { type: 'string' },
        frames: { type: ['array', 'string', 'integer'] },
        resolution: { type: ['array', 'string'] },
        samples: { type: 'integer' },
        engine: { type: 'string' },
        format: { type: 'string' },
        camera: { type: ['string', 'boolean'] },
        device: { type: 'string' },
        compute_device_type: { type: 'string' },
        channels: { type: ['array', 'string'] },
        script: { type: 'string' },
        code: { type: 'string' },
        script_file: { type: 'string' },
        preload: { type: 'string' },
        factory_startup: { type: 'boolean' },
        bootstrap: { type: 'boolean' },
        workdir: { type: 'string' },
        include_noise: { type: 'boolean' },
        out_json: { type: 'string' },
        args: { type: ['array', 'string', 'object'] },
        env: { type: ['object', 'string'] },
        op: { type: 'string' },
        digest: { type: 'boolean' },
        session: { type: 'string' },
        label: { type: 'string' },
        purge: { type: 'string' },
        spec: { type: ['object', 'string'] },
      },
    },
  },
  {
    name: 'blender_inspect',
    description:
      '【只读检查】列出 addon 只读命令目录（help）或执行只读命令（如 get_scene_info / bpy_api_lookup）。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: ['object', 'string'] },
        force_headless: { type: 'boolean' },
        expect_version: { type: 'string' },
        version_fixture: { type: 'string' },
      },
    },
  },
  {
    name: 'blender_panel',
    title: 'Blender 会话',
    description:
      '打开 Blender 会话监控与审批面板（查看 Gateway 状态、virtual-gui 审批请求、策略切换、会话占用、作业与视口预览）。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      ui: { resourceUri: PANEL_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Blender 会话' },
          { type: 'global', title: 'Blender 会话' },
        ],
      },
    },
  },
  {
    name: 'blender_panel_state',
    description: 'App-only: read live Blender Gateway health, consent panel, and job state.',
    inputSchema: {
      type: 'object',
      properties: {
        includeFrame: { type: 'boolean' },
      },
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'blender_panel_decide',
    description: 'App-only: approve or deny a pending virtual-gui consent request.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['consent_approve', 'consent_deny'] },
        requestId: { type: 'string' },
      },
      required: ['action', 'requestId'],
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
  {
    name: 'blender_panel_policy',
    description: 'App-only: update virtual-gui consent policy (manual | auto | deny).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['manual', 'auto', 'deny'] },
      },
      required: ['mode'],
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
]

const server = new Server(
  { name: 'dsh-blender-mcp', version: '3.3.0' },
  { capabilities: { tools: {}, resources: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: PANEL_URI,
      name: 'Blender 会话面板',
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== PANEL_URI) {
    throw new Error(`Unknown resource: ${request.params.uri}`)
  }
  const htmlPath = process.env.DSH_BLENDER_PANEL_HTML || path.join(HERE, 'dist', 'panel.html')
  const html = readFileSync(htmlPath, 'utf8')
  return {
    contents: [
      {
        uri: PANEL_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args =
    request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments
      : {}

  if (name === 'blender_panel') {
    await ensureBackend(PORT).catch(() => false)
    const state = await collectPanelState(false)
    return {
      content: [
        {
          type: 'text',
          text: state.online
            ? `Blender Gateway 在线（127.0.0.1:${PORT}），待批准请求 ${Array.isArray(state.panel?.pending) ? state.panel.pending.length : 0} 条。`
            : `Blender Gateway 离线（127.0.0.1:${PORT}）。`,
        },
      ],
      structuredContent: state,
    }
  }

  if (name === 'blender_panel_state') {
    const state = await collectPanelState(Boolean(args.includeFrame))
    return {
      content: [{ type: 'text', text: state.online ? 'ok' : 'offline' }],
      structuredContent: state,
    }
  }

  if (name === 'blender_panel_decide') {
    const action = String(args.action || '')
    const requestId = String(args.requestId || '')
    if (!['consent_approve', 'consent_deny'].includes(action) || !requestId) {
      return { isError: true, content: [{ type: 'text', text: 'invalid decide params' }] }
    }
    const res = await fetchJsonNoIdentity('/lease', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, requestId, source: 'antigravity-panel' }),
    })
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: JSON.stringify(res.body) }],
      structuredContent: res.body,
    }
  }

  if (name === 'blender_panel_policy') {
    const mode = String(args.mode || '')
    if (!['manual', 'auto', 'deny'].includes(mode)) {
      return { isError: true, content: [{ type: 'text', text: 'invalid policy mode' }] }
    }
    const res = await fetchJsonNoIdentity('/lease', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'consent_policy_set', mode }),
    })
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: JSON.stringify(res.body) }],
      structuredContent: res.body,
    }
  }

  const { ctx, savedImages } = createMockContext()
  return EXEC_CTX.run({ caller: CALLER }, async () => {
    let raw
    if (name === 'blender_session') {
      raw = await executeSession(PORT, args)
    } else if (name === 'blender_op') {
      raw = await executeOp(ctx, PORT, args, EXEC_STUB)
    } else if (name === 'blender_py') {
      const ready = await requireReadySession(PORT)
      raw = ready.ok ? await executePy(ctx, PORT, args, ready.session) : ready.failure
    } else if (name === 'blender_see') {
      const ready = await requireReadySession(PORT)
      raw = ready.ok ? await executeSee(ctx, PORT, args, ready.session) : sessionRequiredFailure()
    } else if (name === 'blender_run') {
      raw = await executeRun(ctx, PORT, args, EXEC_STUB)
    } else if (name === 'blender_inspect') {
      raw = await executeInspect(PORT, args)
    } else {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      }
    }
    return toMcpToolResult(raw, savedImages)
  })
})

let probeMisses = 0
let watchdog = null
let cleanedUp = false

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (watchdog) {
    clearInterval(watchdog)
    watchdog = null
  }
  try {
    killChildHandle()
  } catch {
    /* ignore */
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
process.stdin.on('close', () => {
  cleanup()
})

if (process.env.DSH_BLENDER_TEST_NO_SPAWN !== '1') {
  void ensureBackend(PORT)
    .then((ok) => {
      if (ok) noteGatewayRestartSuccess()
      else noteGatewayRestartFailure()
    })
    .catch(() => noteGatewayRestartFailure())

  watchdog = setInterval(() => {
    void (async () => {
      try {
        if (isPaused()) return
        if (await probe(PORT)) {
          probeMisses = 0
          noteGatewayRestartSuccess()
          return
        }
        probeMisses += 1
        if (probeMisses >= 2) {
          probeMisses = 0
          try {
            killBackendByCmd(PORT, 'SIGTERM')
          } catch {
            /* ignore */
          }
          await sleep(1200)
          try {
            killBackendByCmd(PORT, 'SIGKILL')
          } catch {
            /* ignore */
          }
        }
        if (!canRestartGateway()) return
        if (await ensureBackend(PORT)) noteGatewayRestartSuccess()
        else noteGatewayRestartFailure()
      } catch {
        /* ignore */
      }
    })()
  }, 15000)
  watchdog.unref()
}

const transport = new StdioServerTransport()
await server.connect(transport)
