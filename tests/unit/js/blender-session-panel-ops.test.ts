import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { pkgPath } from '../../helpers/pkg'

/**
 * v3.5 面板运维面（连接 / 通道 · 作业 · 诊断 · 设置）。
 *
 * 这组用例只测**纯函数**：投影 `panelOpsModel` 与渲染树 `opsTree` / `panelTree`。
 * 数据全部来自 `/host/state` + `/health` + `/host/jobs`（只读、零 Blender 往返）与
 * 按需的 `/status` + `/doctor`；面板没有新增任何会话写路径。
 */
function h(type: string, props: Record<string, any> | null, ...children: any[]): any {
  return {
    type,
    props: props || {},
    children: children.reduce((acc: any[], c: any) => acc.concat(c), []),
  }
}

function treeText(node: any): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' | ')
  return treeText(node.children)
}

function findByType(node: any, type: string, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findByType(n, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  findByType(node.children, type, out)
  return out
}

/** The shipped client bundle, loaded the way the DSH web app loads it. */
function clientSelf(): Record<string, any> {
  const source = fs.readFileSync(pkgPath('lib', 'client.js'), 'utf8')
  let registration: any = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (def: any) => {
          registration = def
        },
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
    console,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const react = { useEffect: () => {}, useRef: (v: unknown) => ({ current: v }) }
  const exported = registration.factory((id: string) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
  return exported.__selftest
}

const TS = 1_700_000_000_000

/** 一份"三条线都在忙"的运维快照：渲染 + 两个作业 + 写租约 + AI 暂停。 */
function busyOps(over: Record<string, any> = {}) {
  return {
    ts: TS,
    state: {
      ok: true,
      channel: {
        lastOkAgeMs: 12_000,
        inflight: 1,
        lastCmd: 'blender_py',
        aiPaused: true,
        lastError: null,
        diagnosis: null,
      },
      lease: {
        active: true,
        holder: 'plugin-pid-4988',
        expiresInMs: 300_000,
        holderAlive: true,
        scope: [{ kind: 'prefix', value: 'L5_' }],
      },
      render: { busy: true, ageMs: 32_000, scene: 'ROSE' },
      jobs: { running: 2 },
      backend: { pid: 4988, uptimeMs: 1_500_000 },
    },
    health: {
      ok: true,
      provenance: { verdict: 'current', pluginVersion: '3.3.0' },
      gateway: { pid: 4988, endpoint: '127.0.0.1:39877' },
      backend: { pid: 4988, rssMB: 180, uptimeMs: 1_500_000 },
      lease: { active: false },
    },
    jobs: {
      ok: true,
      running: 2,
      total: 12,
      jobs: [
        {
          id: 'job-abcdef123456',
          kind: 'render',
          status: 'running',
          ms: 1200,
          stageName: 'cycles',
        },
        { id: 'job-2', kind: 'headless', status: 'failed', ms: 800 },
      ],
    },
    errors: [],
    diagnostics: null,
    log: null,
    ...over,
  }
}

describe('panelOpsModel（连接 / 通道 / 作业 / 诊断投影）', () => {
  it('合并 /host/state + /health + /host/jobs：Gateway、通道、租约、渲染、作业行', () => {
    const self = clientSelf()
    const model = self.panelOpsModel(busyOps(), TS + 5000)
    expect(model.ready).toBe(true)
    expect(model.connection.backendLabel).toBe('http://127.0.0.1:39877')
    expect(model.connection.backendSourceLabel).toBe('默认')
    expect(model.connection.gatewayPid).toBe(4988)
    expect(model.connection.uptimeLabel).toBe('25m00')
    expect(model.connection.rssLabel).toBe('180 MB')
    expect(model.connection.pluginVersion).toBe('3.3.0')
    expect(model.connection.provenance).toBe('current')
    // 通道：最近成功年龄 + 在飞 + AI 暂停；最后命令单独显示
    expect(model.connection.channelLabel).toContain('通道最近 ok 12s前')
    expect(model.connection.channelLabel).toContain('在飞 1')
    expect(model.connection.channelLabel).toContain('AI 已暂停')
    expect(model.connection.lastCmd).toBe('blender_py')
    // 写租约 + 渲染：同一行里点出"谁在写 / 在渲什么"
    expect(model.connection.leaseActive).toBe(true)
    expect(model.connection.leaseLabel).toContain('写租约 plugin-pid-4988')
    expect(model.connection.leaseLabel).toContain('剩余 5m00')
    expect(model.connection.leaseLabel).toContain('scope prefix:L5_')
    expect(model.connection.renderBusy).toBe(true)
    expect(model.connection.renderLabel).toContain('渲染中')
    expect(model.connection.renderLabel).toContain('已 32s')
    // 作业行：短 id / kind / 中文状态 / 耗时
    expect(model.jobs.label).toBe('运行中 2 ｜ 共 12')
    expect(model.jobs.rows[0].short).toBe('job-abcd…')
    expect(model.jobs.rows[0].statusLabel).toBe('运行中 · cycles')
    expect(model.jobs.rows[1].statusLabel).toBe('失败')
    expect(model.problems).toEqual([])
  })

  it('取不到时不抛：ready=false、空作业表、空 problems', () => {
    const self = clientSelf()
    const model = self.panelOpsModel(null, TS)
    expect(model.ready).toBe(false)
    expect(model.jobs.rows).toEqual([])
    expect(model.problems).toEqual([])
    expect(model.connection.channelLabel).toBe('通道无成功记录')
    expect(model.connection.leaseLabel).toBe('无写租约')
    expect(model.connection.renderLabel).toBe('未在渲染')
    expect(String(model.rawText)).toContain('"state": null')
  })

  it('三份快照里某一份失败：只把失败写进 problems，其余照常显示', () => {
    const self = clientSelf()
    const ops = busyOps({ jobs: null, errors: ['jobs：Gateway 未响应'] })
    const model = self.panelOpsModel(ops, TS)
    expect(model.ready).toBe(true)
    expect(model.jobs.rows).toEqual([])
    expect(model.jobs.label).toBe('运行中 0 ｜ 共 0')
    expect(model.problems[0]).toContain('jobs：Gateway 未响应')
    expect(model.problemLabel).toBe(model.problems[0])
  })

  it('诊断投影：verdict / 版本 / 缺口语义 / next_actions / /doctor 的 config', () => {
    const self = clientSelf()
    const ops = busyOps({
      diagnostics: {
        ts: TS - 3000,
        error: '',
        status: {
          ok: true,
          pluginVersion: '3.3.0',
          plugin: { version: '3.3.0', provenance: { verdict: 'current' } },
          readiness: { addon: { ready_instances: 1, instanceId: 'inst-1' } },
          blender: {
            exe: 'C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe',
            version: '5.3.0',
          },
          addonError: null,
        },
        doctor: {
          ok: true,
          verdict: 'ok',
          readiness: { addon: { ready_instances: 1, instanceId: 'inst-1' } },
          next_actions: ['blender_session action=attach instance_id=inst-1'],
          config: {
            http: '127.0.0.1:39877',
            gateway: '127.0.0.1:39877',
            workDir: { win: 'C:\\Users\\u\\AppData\\Local\\dsh-blender-rt' },
            blenderExe: 'C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe',
            configFile: 'C:\\Users\\u\\.dsh\\dsh-blender.config.json',
            leaseTtlMs: 600_000,
            platform: 'win32',
          },
        },
      },
    })
    const model = self.panelOpsModel(ops, TS)
    const dg = model.diagnostics
    expect(dg.verdict).toBe('ok')
    expect(dg.ok).toBe(true)
    expect(dg.readyInstances).toBe(1)
    expect(dg.pluginVersion).toBe('3.3.0')
    expect(dg.provenance).toBe('current')
    expect(dg.blenderVersion).toBe('5.3.0')
    expect(dg.blenderExe).toContain('Blender 5.3')
    expect(dg.nextActions).toEqual(['blender_session action=attach instance_id=inst-1'])
    const labels = dg.configRows.map((r: any) => r.label)
    expect(labels).toContain('HTTP')
    expect(labels).toContain('工作目录')
    expect(labels).toContain('配置文件')
    expect(labels).toContain('租约 TTL')
    expect(dg.configRows.find((r: any) => r.label === '租约 TTL').value).toBe('10m00')
    expect(dg.ageLabel).toBe('3s前')
  })
})

describe('opsTree（运维区渲染树）', () => {
  const view = (over: Record<string, any> = {}) => ({
    model: null,
    ops: null,
    error: '',
    busy: '',
    collapsed: false,
    confirmAuto: '',
    opsOpen: true,
    settingsOpen: true,
    rawOpen: false,
    backendDraft: '',
    onDecide: () => {},
    onPolicy: () => {},
    onToggle: () => {},
    onToggleOps: () => {},
    onToggleSettings: () => {},
    onRefresh: () => {},
    onDiagnose: () => {},
    onJobLog: () => {},
    onJobLogClose: () => {},
    onBackendDraft: () => {},
    onBackendSave: () => {},
    onBackendReset: () => {},
    onPollSlow: () => {},
    onPollFast: () => {},
    onRawToggle: () => {},
    onCopy: () => {},
    ...over,
  })

  it('四块都在：连接 / 通道、作业、诊断、设置；动作按钮带 data-action', () => {
    const self = clientSelf()
    const model = self.panelOpsModel(busyOps(), TS)
    const tree = self.panelTree(
      h,
      view({
        model: self.panelModel(
          { ok: true, policy: { mode: 'manual' }, requests: [], sessions: [] },
          TS,
        ),
        ops: model,
      }),
    )
    const text = treeText(tree)
    expect(text).toContain('连接 / 通道')
    expect(text).toContain('作业')
    expect(text).toContain('诊断')
    expect(text).toContain('设置（本机）')
    expect(text).toContain('写租约 plugin-pid-4988')
    expect(text).toContain('运行诊断')
    expect(text).toContain('后端地址')
    expect(text).toContain('轮询间隔')
    const actions = findByType(tree, 'button').map((b: any) => b.props['data-action'])
    expect(actions).toContain('ops-refresh')
    expect(actions).toContain('ops-diagnose')
    expect(actions).toContain('ops-jobs-toggle')
    expect(actions).toContain('settings-toggle')
    expect(actions).toContain('backend-save')
    expect(actions).toContain('backend-reset')
    expect(actions).toContain('poll-fast')
    expect(actions).toContain('raw-toggle')
  })

  it('作业行点「日志」把 id 交给回调；日志正文渲染在 pre 里，可关闭', () => {
    const self = clientSelf()
    const logId: string[] = []
    const closed: number[] = []
    const ops = busyOps({
      log: { id: 'job-abcdef123456', text: 'STDOUT: built 92 objects\nDONE', error: '' },
    })
    const model = self.panelOpsModel(ops, TS)
    const tree = self.panelTree(
      h,
      view({
        model: self.panelModel(
          { ok: true, policy: { mode: 'manual' }, requests: [], sessions: [] },
          TS,
        ),
        ops: model,
        onJobLog: (id: string) => logId.push(id),
        onJobLogClose: () => closed.push(1),
      }),
    )
    const jobButtons = findByType(tree, 'button').filter((b: any) => b.props['data-job'])
    expect(jobButtons.length).toBe(2)
    jobButtons[1].props.onClick()
    expect(logId).toEqual(['job-2'])
    const pre = findByType(tree, 'pre').map((p: any) => treeText(p))
    expect(pre.join('\n')).toContain('STDOUT: built 92 objects')
    expect(treeText(tree)).toContain('作业日志 job-abcd…')
    findByType(tree, 'button')
      .filter((b: any) => b.props['data-action'] === 'job-log-close')[0]
      .props.onClick()
    expect(closed).toEqual([1])
  })

  it('折叠运维块后不再渲染作业表与设置表单（只留标题行）', () => {
    const self = clientSelf()
    const model = self.panelOpsModel(busyOps(), TS)
    const tree = self.panelTree(
      h,
      view({
        model: self.panelModel(
          { ok: true, policy: { mode: 'manual' }, requests: [], sessions: [] },
          TS,
        ),
        ops: model,
        opsOpen: false,
        settingsOpen: false,
      }),
    )
    const text = treeText(tree)
    expect(text).toContain('连接 / 通道')
    expect(text).toContain('作业')
    expect(text).not.toContain('job-abcd…')
    expect(text).not.toContain('后端地址')
    expect(text).toContain('展开')
  })

  it('诊断前给一句可执行提示，诊断后显示 verdict / 配置 / 下一步', () => {
    const self = clientSelf()
    const base = self.panelModel(
      { ok: true, policy: { mode: 'manual' }, requests: [], sessions: [] },
      TS,
    )
    const empty = self.panelOpsModel(busyOps(), TS)
    const textEmpty = treeText(self.panelTree(h, view({ model: base, ops: empty })))
    expect(textEmpty).toContain('点「运行诊断」')

    const withDiag = self.panelOpsModel(
      busyOps({
        diagnostics: {
          ts: TS,
          error: '',
          status: {
            pluginVersion: '3.3.0',
            readiness: { addon: { ready_instances: 1 } },
            blender: { version: '5.3.0' },
          },
          doctor: {
            ok: false,
            verdict: 'degraded',
            next_actions: ['blender_session action=doctor'],
            config: { http: '127.0.0.1:39877', workDir: { win: 'C:\\rt' } },
            diagnosis: { summary: 'addon 半开：TCP 通但没有握手', fix: '重启 Blender 里的 addon' },
          },
        },
      }),
      TS,
    )
    const text = treeText(self.panelTree(h, view({ model: base, ops: withDiag })))
    expect(text).toContain('有缺口 · degraded')
    expect(text).toContain('addon 半开')
    expect(text).toContain('修法：重启 Blender 里的 addon')
    expect(text).toContain('下一步 1：blender_session action=doctor')
    expect(text).toContain('127.0.0.1:39877')
  })

  it('设置区：后端地址输入 + 保存/恢复默认 + 原始快照开关；覆盖来源写进提示', () => {
    const self = clientSelf()
    const model = self.panelOpsModel(busyOps(), TS)
    const saved: number[] = []
    const tree = self.panelTree(
      h,
      view({
        model: self.panelModel(
          { ok: true, policy: { mode: 'manual' }, requests: [], sessions: [] },
          TS,
        ),
        ops: model,
        backendDraft: 'http://127.0.0.1:41000',
        rawOpen: true,
        onBackendSave: () => saved.push(1),
      }),
    )
    const inputs = findByType(tree, 'input')
    expect(inputs.length).toBe(1)
    expect(inputs[0].props.value).toBe('http://127.0.0.1:41000')
    const save = findByType(tree, 'button').find(
      (b: any) => b.props['data-action'] === 'backend-save',
    )
    save.props.onClick()
    expect(saved).toEqual([1])
    expect(treeText(tree)).toContain('来源 默认')
    expect(treeText(tree)).toContain('"state"')
    // 隐藏原始快照 = 不渲染 pre
    const treeNoRaw = self.panelTree(
      h,
      view({
        model: self.panelModel({ ok: true }, TS),
        ops: model,
        rawOpen: false,
        settingsOpen: true,
      }),
    )
    expect(findByType(treeNoRaw, 'pre').length).toBe(0)
  })

  it('认领表每行给「复制 attach」命令，kind/status 同排显示', () => {
    const self = clientSelf()
    const copied: string[] = []
    const payload = {
      ok: true,
      policy: { mode: 'manual', auto: false, source: 'default' },
      resources: { instances: 1, limit: 4 },
      requests: [],
      sessions: [
        {
          id: 'user-gui:g1',
          instanceId: 'g1',
          kind: 'user-gui',
          status: 'ready',
          is_mine: true,
          owner: {
            dshSessionId: 'dsh-1',
            agentId: 'agent-main',
            heartbeat_age_ms: 10,
            expiresInMs: 600_000,
          },
          grants: [],
        },
      ],
    }
    const tree = self.panelTree(
      h,
      view({
        model: self.panelModel(payload, TS),
        ops: self.panelOpsModel(busyOps(), TS),
        onCopy: (text: string) => copied.push(text),
      }),
    )
    expect(treeText(tree)).toContain('user-gui · ready')
    const copy = findByType(tree, 'button').find((b: any) => b.props['data-copy'] === 'g1')
    expect(copy).toBeTruthy()
    copy.props.onClick()
    expect(copied).toEqual(['blender_session action=attach instance_id=g1'])
  })
})

describe('运维面 URL 与工具函数（纯函数）', () => {
  it('URL 全走当前后端，作业日志带编码与 clamp 过的 tail', () => {
    const self = clientSelf()
    expect(self.opsUrlState()).toBe('http://127.0.0.1:39877/host/state')
    expect(self.opsUrlHealth()).toBe('http://127.0.0.1:39877/health')
    expect(self.opsUrlJobs(6)).toBe('http://127.0.0.1:39877/host/jobs?limit=6')
    expect(self.opsUrlJobs(9999)).toBe('http://127.0.0.1:39877/host/jobs?limit=100')
    expect(self.opsUrlJobLog('a b', 4000)).toBe(
      'http://127.0.0.1:39877/host/jobs/log?id=a%20b&tail=4000',
    )
    expect(self.opsUrlStatus()).toBe('http://127.0.0.1:39877/status')
    expect(self.opsUrlDoctor()).toBe('http://127.0.0.1:39877/doctor')
  })

  it('后端覆盖：只收 http(s)、去尾斜杠、空=清除', () => {
    const self = clientSelf()
    expect(self.normalizeBackendOverride('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000')
    expect(self.normalizeBackendOverride('  https://host:9/// ')).toBe('https://host:9')
    expect(self.normalizeBackendOverride('localhost:4000')).toBe('')
    expect(self.normalizeBackendOverride('')).toBe('')
    expect(self.normalizeBackendOverride(null)).toBe('')
    // 沙箱里没有 localStorage 覆盖 / 宿主注入 → 默认来源
    expect(self.backendSource()).toBe('default')
  })

  it('小工具：短 id / 状态中文 / 租约 / 渲染 / scope', () => {
    const self = clientSelf()
    expect(self.shortId('abc')).toBe('abc')
    expect(self.shortId('0123456789abcdef')).toBe('01234567…')
    expect(self.jobStatusLabel({ status: 'killed' })).toBe('已取消')
    expect(self.jobStatusLabel({ status: 'running', stageName: 'cycles' })).toBe('运行中 · cycles')
    expect(self.jobStatusLabel({})).toBe('未知')
    expect(self.channelLabel({ lastOkAgeMs: null })).toBe('通道无成功记录')
    expect(self.channelLabel({ lastOkAgeMs: 2000, inflight: 2 })).toContain('在飞 2')
    expect(self.leaseLabel({ active: false })).toBe('无写租约')
    expect(
      self.leaseLabel({ active: true, holder: 'h', expiresInMs: 60_000, holderAlive: false }),
    ).toContain('holder 已退出')
    expect(
      self.scopeLabel([
        { kind: 'collection', value: 'C' },
        { kind: 'prefix', value: 'L' },
      ]),
    ).toBe('collection:C,prefix:L')
    expect(self.renderLabel({ busy: false })).toBe('未在渲染')
  })

  it('三道只读请求全失败时 fetchOpsSnapshot 只返回 errors，不抛', async () => {
    const self = clientSelf()
    const snap = await self.fetchOpsSnapshot()
    expect(snap.state).toBe(null)
    expect(snap.health).toBe(null)
    expect(snap.jobs).toBe(null)
    expect(snap.errors.length).toBe(3)
    const diag = await self.fetchDiagnostics()
    expect(diag.status).toBe(null)
    expect(diag.doctor).toBe(null)
    expect(String(diag.error)).toContain('诊断取不到')
    const log = await self.fetchJobLog('job-1')
    expect(log.id).toBe('job-1')
    expect(String(log.error)).toContain('日志取不到')
  })
})
