import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

const root = document.getElementById('root')
const app = new App({ name: 'Blender 会话', version: '3.3.0' }, {})

let latestState = null
let lastError = ''
let polling = false
let autoConfirmPending = false

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatUptime(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 60) return `${Math.round(n)}s`
  if (n < 3600) return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return '-'
  const ms = Number(expiresAt) - Date.now()
  if (!Number.isFinite(ms)) return '-'
  if (ms <= 0) return '即将过期'
  return `${Math.ceil(ms / 1000)}s`
}

function render() {
  if (!root) return
  const st = latestState || {}
  const health = st.health || {}
  const hostState = st.hostState || {}
  const panel = st.panel || {}
  const policy = panel.policy || {}
  const pending = Array.isArray(panel.pending) ? panel.pending : []
  const claims = Array.isArray(panel.claims) ? panel.claims : []
  const jobs = Array.isArray(st.jobs) ? st.jobs : []
  const online = Boolean(st.online)
  const currentMode = String(policy.mode || 'manual')
  const policySource = String(policy.source || 'default')
  const policyLocked = Boolean(policy.locked)

  const headerHtml = `
    <div class="card">
      <div class="row">
        <div class="title">
          <span class="dot ${online ? 'ok' : 'err'}"></span>
          <span>Blender Gateway</span>
          <span class="badge">${online ? '在线' : '离线'}</span>
        </div>
        <button id="btn-refresh">刷新</button>
      </div>
      <div class="muted" style="margin-top:6px;">
        端口 <code>${esc(st.port ?? 39877)}</code>
        · PID <code>${esc(health.pid ?? hostState.pid ?? '-')}</code>
        · 运行 <code>${esc(formatUptime(health.uptimeSec ?? hostState.uptimeSec))}</code>
        · 内存 <code>${esc(health.rssMB != null ? health.rssMB + ' MB' : '-')}</code>
      </div>
    </div>
  `

  const errorHtml = lastError ? `<div class="banner-err">⚠ ${esc(lastError)}</div>` : ''

  const autoBannerHtml = policy.auto
    ? `<div class="banner-warn">⚠ 自动批准（auto）已开启：virtual-gui 请求将跳过人工确认直接启动。</div>`
    : ''

  const policyHtml = `
    <div class="card">
      <div class="row">
        <div class="title">virtual-gui 确认策略</div>
        <span class="muted">当前：<code>${esc(currentMode)}</code>（来源：${esc(policySource)}${policyLocked ? ' · 已锁定' : ''}）</span>
      </div>
      <div class="btn-group" style="margin-top:8px;">
        <button data-policy="manual" class="${currentMode === 'manual' ? 'active' : ''}" ${policyLocked ? 'disabled' : ''}>manual（人工确认）</button>
        <button data-policy="auto" class="${currentMode === 'auto' ? 'active' : ''}" ${policyLocked ? 'disabled' : ''}>${autoConfirmPending ? '再次点击确认开启 auto' : 'auto（自动批准）'}</button>
        <button data-policy="deny" class="${currentMode === 'deny' ? 'active' : ''}" ${policyLocked ? 'disabled' : ''}>deny（一律拒绝）</button>
      </div>
    </div>
  `

  const pendingHtml = `
    <div class="card">
      <div class="row">
        <div class="title">待批准请求（${pending.length}）</div>
      </div>
      ${
        pending.length === 0
          ? '<div class="muted" style="margin-top:6px;">暂无待批准的 virtual-gui 请求。</div>'
          : pending
              .map((req) => {
                const rid = req.requestId || req.request_id || req.id || ''
                return `
                  <div class="req-card">
                    <div class="row">
                      <div>
                        <strong>${esc(req.action || 'start virtual-gui')}</strong>
                        <span class="muted">· caller: <code>${esc(req.callerAgentId || req.caller || 'unknown')}</code></span>
                      </div>
                      <span class="badge">${esc(formatRemaining(req.expiresAt))}</span>
                    </div>
                    <div class="muted" style="margin-top:4px;">request_id: <code>${esc(rid)}</code></div>
                    <div class="btn-group" style="margin-top:8px;">
                      <button class="approve" data-decide="consent_approve" data-rid="${esc(rid)}">批准</button>
                      <button class="deny" data-decide="consent_deny" data-rid="${esc(rid)}">拒绝</button>
                    </div>
                  </div>
                `
              })
              .join('')
      }
    </div>
  `

  const claimsHtml = `
    <div class="card">
      <div class="title">会话与实例（${claims.length}）</div>
      ${
        claims.length === 0
          ? '<div class="muted" style="margin-top:6px;">暂无已连接的 Blender 实例或会话。</div>'
          : `
            <table>
              <thead>
                <tr>
                  <th>实例</th>
                  <th>类型</th>
                  <th>归属</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                ${claims
                  .map(
                    (c) => `
                  <tr>
                    <td><code>${esc(c.instanceId || c.sessionId || '-')}</code></td>
                    <td>${esc(c.kind || '-')}</td>
                    <td><code>${esc(c.owner || c.ownerSessionId || 'unclaimed')}</code></td>
                    <td>${c.paused ? 'paused' : c.ready ? 'ready' : esc(c.state || '-')}</td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          `
      }
    </div>
  `

  const jobsHtml = `
    <div class="card">
      <div class="title">最近作业（${jobs.length}）</div>
      ${
        jobs.length === 0
          ? '<div class="muted" style="margin-top:6px;">暂无后台作业记录。</div>'
          : `
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>类型</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                ${jobs
                  .slice(0, 8)
                  .map(
                    (j) => `
                  <tr>
                    <td><code>${esc(j.id || '-')}</code></td>
                    <td>${esc(j.kind || '-')}</td>
                    <td><span class="badge">${esc(j.state || '-')}</span></td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          `
      }
    </div>
  `

  const previewHtml = `
    <div class="card">
      <div class="row">
        <div class="title">视口预览</div>
        <button id="btn-frame">刷新视口预览</button>
      </div>
      ${
        st.frameBase64
          ? `<img class="preview-img" src="data:image/png;base64,${esc(st.frameBase64)}" alt="Blender Viewport" />`
          : '<div class="muted" style="margin-top:6px;">点击「刷新视口预览」从当前 GUI 会话拉取一帧。</div>'
      }
    </div>
  `

  root.innerHTML =
    headerHtml +
    errorHtml +
    autoBannerHtml +
    policyHtml +
    pendingHtml +
    claimsHtml +
    jobsHtml +
    previewHtml

  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    void refreshState(false)
  })
  document.getElementById('btn-frame')?.addEventListener('click', () => {
    void refreshState(true)
  })
  root.querySelectorAll('button[data-policy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-policy')
      if (!mode) return
      if (mode === 'auto' && currentMode !== 'auto' && !autoConfirmPending) {
        autoConfirmPending = true
        render()
        return
      }
      autoConfirmPending = false
      void setPolicy(mode)
    })
  })
  root.querySelectorAll('button[data-decide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-decide')
      const requestId = btn.getAttribute('data-rid')
      if (action && requestId) void decide(action, requestId)
    })
  })
}

async function refreshState(includeFrame = false) {
  if (polling) return
  polling = true
  try {
    const res = await app.callServerTool({
      name: 'blender_panel_state',
      arguments: { includeFrame },
    })
    if (res?.structuredContent) {
      const prevFrame = latestState?.frameBase64
      latestState = {
        ...res.structuredContent,
        frameBase64: res.structuredContent.frameBase64 || (includeFrame ? null : prevFrame),
      }
      lastError = ''
    } else if (res?.isError) {
      lastError = res.content?.[0]?.text || '读取面板状态失败'
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  } finally {
    polling = false
    render()
  }
}

async function decide(action, requestId) {
  try {
    const res = await app.callServerTool({
      name: 'blender_panel_decide',
      arguments: { action, requestId },
    })
    if (res?.isError) {
      lastError = res.content?.[0]?.text || '审批操作失败'
    } else {
      lastError = ''
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  }
  await refreshState(false)
}

async function setPolicy(mode) {
  try {
    const res = await app.callServerTool({
      name: 'blender_panel_policy',
      arguments: { mode },
    })
    if (res?.isError) {
      lastError = res.content?.[0]?.text || '切换策略失败'
    } else {
      lastError = ''
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  }
  await refreshState(false)
}

app.ontoolinput = () => {
  render()
}
app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    latestState = result.structuredContent
    lastError = ''
  }
  render()
}
app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme)
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
}

async function boot() {
  await app.connect()
  const hostCtx = app.getHostContext()
  if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme)
  if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables)

  render()
  void refreshState(false)
  setInterval(() => {
    void refreshState(false)
  }, 3000)
}

void boot()
