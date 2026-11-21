/**
 * dsh-blender-plugin —— 客户端半边（浏览器 bundle）。
 *
 * 手写、零打包器、零新增依赖（契约 §0 / §2.2）。本文件**就是** bundle 源：
 * `scripts/build-client.mjs` 原样拷成 `lib/client.js`，由 `package.json` 的
 * `dsh.client` + `exports["./client"]` 暴露给 DSH 宿主。
 *
 * 包装格式逐字照本机已在跑的第三方样板
 * `@dsh-external/dsh-coc-dice/lib/client.js`：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 * 加载器语义（`dsh-client-modules/lib/types/client/manifest.d.ts:9-16`）：执行 bundle 只
 * **登记** factory；所有副作用在 materialization 时才跑。
 *
 * v2.3 仅保留两块功能（DSH 侧视口面板与 blender_rt_pick 已于 v2.3 删除）：
 *   ① `@` 提及源 —— `GET /host/scene-items?q=` 按 对象/材质/集合 分组；
 *   ② Blender 原生选中 → 草稿 —— 无头桥（`conversation.input.dock`）轮询
 *      `GET /host/selection/latest`，把 addon 推来的选中插入当前会话草稿（**不自动发送**）。
 *
 * 纪律：
 *   - 不得 `import`/`export` 语法、不得顶层 `await`、不得引用 Node 内置模块；
 *     可 `require("react")`（baseline 提供，core client-ui 包同样用法）。
 *   - 所有 fetch 失败**静默降级**；`@` 候选失败返回 `[]` **不抛**。
 *   - 选中插入**不自动发送**，只填草稿。
 *   - Gateway 地址默认 http://127.0.0.1:39877，可被 ctx 配置 / localStorage 覆盖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-blender-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    //#region 配置
    /** Gateway 默认地址（契约 §2.4：Gateway 127.0.0.1:39877）。 */
    var DEFAULT_BACKEND = 'http://127.0.0.1:39877'
    /** localStorage 覆盖键（最高优先级的用户侧覆盖）。 */
    var LS_BACKEND_KEY = 'dsh-blender-plugin:backend'
    /** v2.3：Blender 原生选中轮询间隔（会话可见时才轮询）。 */
    var SELECTION_POLL_MS = 100 // v2.6.1 性能实测：1200→100ms，端到端 p50 993→156ms（本机回环，见契约「选中轮询」）
    /** v2.3：草稿文本里最多列多少个对象名（几百个零件时收敛成摘要，别刷屏）。 */
    var SELECTION_DRAFT_NAME_LIMIT = 24
    /** v2.4：子元素（顶点/边/面/骨骼）草稿里最多列多少个索引/名字。 */
    var SUB_DRAFT_INDEX_LIMIT = 12

    /** apply() 期间由 ctx 配置解析出的地址；backend() 在它之上叠 localStorage。 */
    var configuredBackend = DEFAULT_BACKEND
    /** 幂等守卫：cordis 同一 fiber 只 apply 一次；卸载时复位（见 apply 里的 effect）。 */
    var started = false

    /** 去掉尾部斜杠（不用正则字面量，避免粗筛误伤）。 */
    function stripTrailingSlashes(value) {
      var out = String(value === null || value === undefined ? '' : value)
      while (out.length > 0 && out.charAt(out.length - 1) === '/') out = out.slice(0, -1)
      return out
    }

    /**
     * 当前生效的后端地址。每次调用都重读 localStorage，所以用户在控制台里
     * `localStorage.setItem("dsh-blender-plugin:backend", "http://…")` 后立刻生效。
     */
    function backend() {
      try {
        var v = window.localStorage.getItem(LS_BACKEND_KEY)
        if (v) return stripTrailingSlashes(v)
      } catch (e) {
        /* 隐私模式 / 无 localStorage → 退回配置值 */
      }
      return configuredBackend
    }

    /** 优先级：window.__DSH_BLENDER_BACKEND__ > ctx.config.{backend,host,blenderBackend} > 默认。 */
    function resolveConfiguredBackend(ctx) {
      try {
        var g = window.__DSH_BLENDER_BACKEND__
        if (typeof g === 'string' && g) return stripTrailingSlashes(g)
      } catch (e) {
        /* ignore */
      }
      try {
        var c = ctx && ctx.config
        if (c) {
          if (typeof c.backend === 'string' && c.backend) return stripTrailingSlashes(c.backend)
          if (typeof c.host === 'string' && c.host) return stripTrailingSlashes(c.host)
          if (typeof c.blenderBackend === 'string' && c.blenderBackend)
            return stripTrailingSlashes(c.blenderBackend)
        }
      } catch (e) {
        /* ignore */
      }
      return DEFAULT_BACKEND
    }
    //#endregion

    //#region 通用小工具
    /** 任何值 → 可读错误文本（绝不抛）。 */
    function errText(e) {
      if (e === null || e === undefined) return '未知错误'
      if (typeof e === 'string') return e
      if (e.message) return String(e.message)
      return String(e)
    }

    /** 夹到 [0,1]（契约 §1.5：坐标超出范围夹住）。 */
    function clamp01(n) {
      if (!(typeof n === 'number') || n !== n) return 0
      if (n < 0) return 0
      if (n > 1) return 1
      return n
    }

    /** 取路径最后一段（面板里显示 .blend 文件名）。 */
    function shortPath(p) {
      var s = String(p === null || p === undefined ? '' : p)
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
      return i >= 0 ? s.slice(i + 1) : s
    }

    /** Unix 秒 → 本地 HH:MM:SS。 */
    function timeLabel(unixSec) {
      try {
        var d = new Date(unixSec * 1000)
        function two(n) {
          return n < 10 ? '0' + n : String(n)
        }
        return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
      } catch (e) {
        return ''
      }
    }

    /** source 字段 → 中文（契约 §1.2）。 */
    function sourceLabel(src) {
      if (src === 'user') return '用户'
      if (src === 'auto') return '自动'
      if (src === 'model') return '模型'
      return '无'
    }

    /**
     * 从 ctx 上安全取一个服务：`ctx.get(name)` 是 cordis 的安全访问器
     * （`dsh-client-ui-conversation/lib/client.js:22945` 同款用法）；
     * 服务未挂载时返回 undefined 而不是抛。
     */
    function serviceOf(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get(name)
        if (ctx) return ctx[name]
      } catch (e) {
        /* ignore */
      }
      return undefined
    }
    //#endregion

    //#region HTTP（全部永不抛，失败折叠成 {ok:false}）
    /**
     * 永不抛的 JSON 取回。失败一律折叠成 `{ ok:false, status, body:null, error }`，
     * 由调用方静默降级 —— 契约要求面板「fetch 失败必须静默降级」。
     * @returns {Promise<{ok:boolean,status:number,body:any,error:(string|null)}>}
     */
    async function fetchJSON(url, init) {
      var res
      try {
        res = await window.fetch(url, init)
      } catch (e) {
        return { ok: false, status: 0, body: null, error: errText(e) }
      }
      var status = res && typeof res.status === 'number' ? res.status : 0
      var httpOk = !!(res && res.ok)
      var body = null
      try {
        body = await res.json()
      } catch (e) {
        body = null
      }
      return { ok: httpOk, status: status, body: body, error: null }
    }

    /** POST 一个小 JSON 体（自动带 content-type）。 */
    function postJSON(url, payload) {
      return fetchJSON(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    /**
     * `GET /host/ready` → 响应体或 null（契约 §7.1）。
     * **门控的唯一依据**；取不到/未就绪一律当作"不可用"（静默降级）。
     */
    //#endregion

    //#region 点击 → 草稿（契约 §2.4；**不自动发送**）
    /**
     * 读会话输入框当前草稿文本（备用通道用：绝不覆盖用户已写的内容）。
     * `SessionInput.state: SnapshotStore<InputState>`，`InputState.draft: string`
     * （`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:254-260`）。
     * @returns {{readable:boolean, draft:string}}
     */
    function readDraftInfo(sessionInput) {
      try {
        var st = sessionInput && sessionInput.state
        if (st && typeof st.getSnapshot === 'function') {
          var snap = st.getSnapshot()
          if (snap && typeof snap.draft === 'string') return { readable: true, draft: snap.draft }
        }
      } catch (e) {
        /* ignore */
      }
      return { readable: false, draft: '' }
    }

    /**
     * 失败提示：用 error 级，DSH 会渲染成自动消失的 Toast（约 4 秒，无关闭按钮）；不可用则静默。
     * **不要用 info**：DSH 把 info 渲染成输入栏里的常驻 banner，没有清除接口，
     * 发送消息后也不会消失（v2.3 的“已接收 Blender 选中”因此变成永久横幅）。
     * 成功路径也不提示：草稿里出现文本本身就是反馈。
     */
    function notifyError(deps, text) {
      try {
        var f = deps && deps.fallbackInput
        if (f && typeof f.notify === 'function') f.notify('error', text)
      } catch (e) {
        /* 静默 */
      }
    }

    //#endregion

    //#region v2.3 · Blender 原生选中 → DSH 草稿（契约 v2.3 增补）
    /**
     * 把 addon 推来的 selection payload 折成一条草稿文本。
     * 空选中（names 为空）返回 null —— 调用方据此跳过插入。
     *
     * v2.3 两种 kind：
     *   · objects    —— 用户选中的对象；名单超过 SELECTION_DRAFT_NAME_LIMIT 时收敛成"前 N 件 + 共 M 件"；
     *   · collection —— 用户直接发的整个集合（大装配体）；给集合名 + 件数 + 前几个成员。
     */
    /**
     * v2.4：编辑模式 / 姿态模式的子元素选中 → 草稿文本。
     * 网格给 点/边/面 计数 + 索引样例；骨架给选中的骨骼名；曲线/晶格给控制点计数。
     * 完整数组在 payload 里（get_selection 也能查），这里只列前 SUB_DRAFT_INDEX_LIMIT 个。
     */
    function subSelectionText(sel) {
      var sub = sel && sel.sub
      if (!sub || typeof sub !== 'object') return null
      var type = String(sub.type || '')
      var obj = String(sub.object || '')
      var counts = sub.counts && typeof sub.counts === 'object' ? sub.counts : {}
      var more = sub.truncated === true
      var prefix = 'Blender 子元素选中'
      if (type === 'MESH') {
        var v = Number(counts.vertices || 0),
          e = Number(counts.edges || 0),
          f = Number(counts.faces || 0)
        var text =
          'Blender 编辑模式（网格）「' +
          obj +
          '」：已选 ' +
          v +
          ' 顶点 / ' +
          e +
          ' 边 / ' +
          f +
          ' 面。'
        var idx = sub.indices && typeof sub.indices === 'object' ? sub.indices : {}
        var labels = { vertices: '顶点索引', edges: '边索引', faces: '面索引' }
        var parts = []
        for (var k in labels) {
          if (!Object.prototype.hasOwnProperty.call(labels, k)) continue
          var arr = Array.isArray(idx[k]) ? idx[k] : []
          if (!arr.length) continue
          var shown = arr.slice(0, SUB_DRAFT_INDEX_LIMIT).join(',')
          if (arr.length > SUB_DRAFT_INDEX_LIMIT || more) shown += '…'
          parts.push(labels[k] + '：' + shown)
        }
        if (parts.length) text += parts.join('；') + '。'
        return text + '用 bpy / BMesh 精确修改这些元素；用户说"这些点/线/面"时指它们。'
      }
      if (type === 'ARMATURE') {
        var bones = Array.isArray(sub.bones) ? sub.bones : []
        var boneCount = Number(counts.bones || bones.length)
        var head =
          'Blender 骨骼（骨架）「' +
          obj +
          '」' +
          (String(sub.mode || '') === 'POSE' ? '姿势模式' : '编辑模式') +
          '：已选 ' +
          boneCount +
          ' 根'
        if (bones.length) {
          head += '：' + bones.slice(0, SUB_DRAFT_INDEX_LIMIT).join('、')
          if (bones.length > SUB_DRAFT_INDEX_LIMIT || more) head += '…'
        }
        return (
          head +
          "。用 bpy.data.objects['" +
          obj +
          '\'].pose.bones[...] 精确定位；用户说"这些骨骼"时指它们。'
        )
      }
      if (type === 'CURVE' || type === 'LATTICE') {
        var pts = Array.isArray(sub.points) ? sub.points : []
        var pcount = Number(counts.points || pts.length)
        var label = type === 'CURVE' ? '曲线/曲面控制点' : '晶格控制点'
        var txt =
          'Blender ' +
          label +
          '「' +
          obj +
          '」：' +
          String(sub.mode || '') +
          '，已选 ' +
          pcount +
          ' 个'
        if (pts.length) {
          var sample = pts.slice(0, SUB_DRAFT_INDEX_LIMIT).map(function (p) {
            return Array.isArray(p) ? String(p[0]) + ':' + String(p[1]) : String(p)
          })
          txt += '：' + sample.join('、')
          if (pts.length > SUB_DRAFT_INDEX_LIMIT || more) txt += '…'
        }
        return txt + '。元素用 (spline_index, point_index) 定位；用户说"这些点"时指它们。'
      }
      if (type === 'OTHER') {
        return (
          'Blender ' +
          String(sub.mode || '编辑模式') +
          '（对象「' +
          obj +
          '」）：' +
          String(sub.note || '子元素暂未展开，请用 Python 读当前选择集') +
          '。'
        )
      }
      return null
    }

    function selectionMessageText(payload) {
      var sel = payload && payload.selection ? payload.selection : null
      if (!sel) return null
      var kind = sel.kind === 'collection' ? 'collection' : 'objects'
      var names = Array.isArray(sel.names)
        ? sel.names.filter(function (n) {
            return typeof n === 'string' && n.length > 0
          })
        : []
      var count = typeof sel.count === 'number' ? sel.count : names.length

      if (kind === 'collection') {
        var coll =
          typeof sel.collection === 'string' && sel.collection.length > 0 ? sel.collection : null
        if (!coll) return null
        var shown = names.slice(0, SELECTION_DRAFT_NAME_LIMIT)
        var head = 'Blender 集合：' + coll + '（' + count + ' 件'
        if (shown.length) {
          head += '，前 ' + shown.length + ' 件：' + shown.join('、')
          if (sel.truncated || count > shown.length || names.length > shown.length) head += '…'
        }
        head +=
          "）。集合成员用 bpy.data.collections['" +
          coll +
          '\'].objects 取；用户说"这个集合/这批"时指它。'
        return head
      }

      var subText = subSelectionText(sel)
      if (subText) return subText
      if (!names.length) return null
      var drawn = names.slice(0, SELECTION_DRAFT_NAME_LIMIT)
      var text = 'Blender 选中：' + drawn.join('、')
      if (sel.truncated || count > drawn.length || names.length > drawn.length) {
        text += '（共 ' + count + ' 件，只列前 ' + drawn.length + ' 件）'
      }
      text += '。'
      if (sel.active) text += '活动对象：' + sel.active + '。'
      if (sel.mode) text += '模式：' + sel.mode + '。'
      if (Array.isArray(sel.collections) && sel.collections.length && count > 1) {
        var summary = sel.collections.slice(0, 4).map(function (c) {
          return String(c.name) + '(' + Number(c.count || 0) + ')'
        })
        text += '涉及集合：' + summary.join('、') + '。'
      }
      return text + '用户说"这个/这些"时指它们；对象名在 bpy.data.objects 里可直接用。'
    }

    /**
     * 把选中写进当前会话草稿（**不自动发送**）。
     * 优先 inputActions.insertText（可追加），否则退回 SessionInput.setDraft（仅当草稿为空）。
     * 成功不弹提示（草稿文本可见）；失败由调用方用 notifyError 报 error 级 Toast。
     * @returns {Promise<{ok:boolean, how?:string, reason?:string, text?:string}>}
     */
    async function applySelectionToDraft(deps, payload) {
      var text = selectionMessageText(payload)
      if (!text) return { ok: false, reason: '没有对象名可插入（空选中）' }
      var sessionId = deps && deps.sessionId
      var actions = deps && deps.inputActions
      var fallback = deps && deps.fallbackInput
      if (!sessionId) return { ok: false, reason: '未取得 sessionId —— 不能写入草稿', text: text }
      if (!actions && !fallback)
        return { ok: false, reason: '未取得 inputActions —— 无法写入草稿', text: text }
      if (actions) {
        var wrote = false
        for (var attempt = 0; attempt < 2 && !wrote; attempt++) {
          try {
            wrote = actions.insertText(text, actions.captureInsertion()) === true
          } catch (e) {
            wrote = false
          }
        }
        if (!wrote) return { ok: false, reason: '文本插入被拒（草稿正在变或已锁定）', text: text }
        return { ok: true, how: 'actions', text: text }
      }
      // 备用通道只有 setDraft（整体替换）→ 只在"读得到且为空"时才写，绝不覆盖用户内容
      var info = readDraftInfo(fallback)
      if (!info.readable) return { ok: false, reason: '备用通道读不到当前草稿', text: text }
      if (info.draft.length > 0)
        return { ok: false, reason: '草稿已有内容，备用通道不覆盖', text: text }
      try {
        fallback.setDraft(text)
      } catch (e) {
        return { ok: false, reason: '文本写入失败：' + errText(e), text: text }
      }
      return { ok: true, how: 'fallback', text: text }
    }

    /**
     * 造「Blender 选中 → 草稿」的无头桥组件。
     * 注册在 `conversation.input.dock`（session 作用域、常驻挂载、渲染 null）：
     * 面板收起来也照常接收 Blender 端按钮推来的选中。
     */
    function makeSelectionBridge() {
      function BlenderSelectionBridge(props) {
        var p = props || {}
        var sessionId =
          p.sessionId !== undefined && p.sessionId !== null ? p.sessionId : p.blenderSessionId
        var inputActions = p.inputActions || null
        var fallbackInput = p.blenderInput || null
        var lastSeqRef = React.useRef(0)
        var busyRef = React.useRef(false)
        var failCountRef = React.useRef(0)
        var sessionRef = React.useRef(sessionId)
        var actionsRef = React.useRef(inputActions)
        var fallbackRef = React.useRef(fallbackInput)
        sessionRef.current = sessionId
        actionsRef.current = inputActions
        fallbackRef.current = fallbackInput

        React.useEffect(function () {
          var alive = true
          var timer = 0
          function schedule() {
            if (!alive) return
            timer = window.setTimeout(tick, SELECTION_POLL_MS)
          }
          async function tick() {
            try {
              // 不按页面可见性跳过：用户可能在 Blender 里点了按钮、DSH 标签页在后台；
              // 选中仍应进草稿（否则回到 DSH 时发现什么都没收到）。轮询本身很便宜（零 Blender 往返）。
              if (busyRef.current || !sessionRef.current) {
                schedule()
                return
              }
              var res = await fetchJSON(backend() + '/host/selection/latest', { cache: 'no-store' })
              var body = res && res.body
              if (alive && body && body.ok === true && body.unconsumed === true && body.selection) {
                var seq = Number(body.seq) || 0
                if (seq > lastSeqRef.current) {
                  lastSeqRef.current = seq
                  busyRef.current = true
                  var out = { ok: false, reason: 'bridge_error' }
                  try {
                    out = await applySelectionToDraft(
                      {
                        sessionId: sessionRef.current,
                        inputActions: actionsRef.current,
                        fallbackInput: fallbackRef.current,
                      },
                      { selection: body.selection },
                    )
                  } catch (e) {
                    out = { ok: false, reason: 'bridge_exception:' + errText(e) }
                  }
                  if (out.ok === true) {
                    failCountRef.current = 0
                    try {
                      var consumedOk = await postJSON(backend() + '/host/selection/consume', {
                        seq: seq,
                        ok: true,
                        how: out.how || 'actions',
                      })
                      void consumedOk
                    } catch (e) {
                      /* 本地 lastSeq 已挡住重复插入，下次再消费 */
                    }
                    busyRef.current = false
                  } else {
                    // 插入失败：**不消费**，下一 tick 重试（会话/草稿锁常在几百 ms 内恢复）。
                    // 连续失败 3 次才消费掉并在回执里记下原因，避免无限重试。
                    failCountRef.current += 1
                    if (failCountRef.current === 1) {
                      notifyError(
                        { fallbackInput: fallbackRef.current },
                        'Blender 选中未写入草稿：' + String(out.reason || 'unknown'),
                      )
                    }
                    if (failCountRef.current >= 3) {
                      try {
                        var consumedFail = await postJSON(backend() + '/host/selection/consume', {
                          seq: seq,
                          ok: false,
                          reason: String(out.reason || 'unknown'),
                        })
                        void consumedFail
                      } catch (e) {
                        /* ignore */
                      }
                      failCountRef.current = 0
                    } else {
                      lastSeqRef.current = seq - 1 // 允许下一 tick 重试同一 seq
                    }
                    busyRef.current = false
                  }
                }
              }
            } catch (e) {
              /* 静默：桥不能影响会话 */
            }
            schedule()
          }
          tick()
          return function () {
            alive = false
            if (timer) window.clearTimeout(timer)
          }
        }, [])
        return null
      }
      return BlenderSelectionBridge
    }
    //#endregion

    //#region v3.4 · Blender 会话（右侧栏 tab + 折叠行极简状态 + 策略配置）
    /**
     * 面板的容器改了（用户实拍：贴在输入框上方、跟对话流无关）：
     *   · 主体 → 会话视图右侧栏 tab（`sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`，
     *     先注册 tab 类型 `blender-session`，再用它的 id 注册 body/title 两个 keyed 槽）；
     *   · 入口 → 会话头部按钮（`conversation.session.header.actions`）+ `shell.overlay` 抽屉兜底；
     *   · 输入框上方只留一行极简状态（`Blender · N 待批准`），点它打开面板。
     * 面板只做三件事：待批准卡片（批准/拒绝）、认领表、策略切换（manual/auto/deny）。
     * 写路径只有两条：`consent_approve|deny` 与 `consent_policy_set`，都只答回环来源、都拒带身份头的调用。
     */
    var PANEL_TAB_KIND = 'blender-session'
    var PANEL_TAB_ID = 'dsh-blender-plugin/session-panel'
    var PANEL_TITLE = 'Blender 会话'
    /** pending 时快一点（人点完立刻消失），空闲时慢一点。 */
    var PANEL_POLL_BUSY_MS = 500
    var PANEL_POLL_IDLE_MS = 2000
    /** 卡片/表格里最多显示多少条（其它折叠成 +N）。 */
    var PANEL_CARD_LIMIT = 3
    /** 新容器的展开状态键（旧 key 不再沿用，避免状态错位）。 */
    var PANEL_OPEN_KEY = 'dsh-blender-plugin:panel:tab-open'
    var PANEL_LEGACY_KEYS = ['dsh-blender-plugin:panel:collapsed']

    function msLabel(ms) {
      var n = Number(ms)
      if (!isFinite(n) || n < 0) return '-'
      if (n < 1000) return '<1s'
      var s = Math.round(n / 1000)
      if (s < 60) return s + 's'
      var m = Math.floor(s / 60)
      return m + 'm' + (s % 60 < 10 ? '0' : '') + (s % 60)
    }

    /** 一张待批准卡片：人不需要看见 request_id，按钮自带 handle。 */
    function panelCard(row, now) {
      var r = row && typeof row === 'object' ? row : {}
      var caller = r.caller && typeof r.caller === 'object' ? r.caller : {}
      var expiresAt = Number(r.expires_at) || 0
      var remaining = expiresAt ? Math.max(0, expiresAt - now) : Number(r.expires_in_ms) || 0
      var state = String(r.state || 'pending')
      return {
        handle: String(r.handle || ''),
        state: state,
        who:
          String(caller.agentId || '?') +
          ' · 会话 ' +
          String(caller.dshSessionId || '?') +
          ' · ' +
          String(caller.role || 'subagent'),
        action: '启动一个可见的 virtual-gui Blender 窗口',
        reason: String(r.reason || 'start_virtual_gui'),
        expiresAt: expiresAt,
        remainingMs: remaining,
        remainingLabel: msLabel(remaining),
        singleWindow: state === 'pending' || state === 'approved',
      }
    }

    /** 认领表一行：与 blender_session status 同源字段（owner / is_mine / expiresInMs / grants）。 */
    function panelRow(row) {
      var r = row && typeof row === 'object' ? row : {}
      var owner = r.owner && typeof r.owner === 'object' ? r.owner : null
      var grants = Array.isArray(r.grants) ? r.grants : []
      var grantText = grants
        .map(function (g) {
          var scopes = Array.isArray(g && g.scopes) ? g.scopes : []
          return scopes
            .map(function (s) {
              return String((s && s.kind) || '') + (s && s.value ? ':' + String(s.value) : '')
            })
            .join(',')
        })
        .filter(Boolean)
      return {
        id: String(r.id || ''),
        kind: String(r.kind || ''),
        instanceId: String(r.instanceId || ''),
        status: String(r.status || ''),
        ownerSession: owner ? String(owner.dshSessionId || '') : null,
        ownerAgent: owner ? String(owner.agentId || '') : null,
        ownerRole: owner ? String(owner.role || '') : null,
        isMine: r.is_mine === true,
        viewer: r.viewer === true,
        borrowed: r.borrowed === true,
        heartbeatAgeMs: owner ? Number(owner.heartbeat_age_ms) || 0 : null,
        expiresInMs: owner ? Number(owner.expiresInMs) || 0 : null,
        grants: grantText,
        grantCount: grants.length,
      }
    }

    /** 策略：当前值 + 来源 + 是否被环境变量钉住 + 写入目标文件。 */
    function policyView(policy) {
      var p = policy && typeof policy === 'object' ? policy : {}
      var locked = p.locked === true
      return {
        mode: String(p.mode || 'manual'),
        auto: p.auto === true,
        source: String(p.source || 'default'),
        sourceLabel:
          String(p.mode || 'manual') +
          ' · ' +
          String(p.source || 'default') +
          (p.file ? ' · ' + shortPath(String(p.file)) : ''),
        locked: locked,
        lockEnv: locked ? String(p.lock_env || 'DSH_BLENDER_VIRTUAL_GUI_CONSENT') : null,
        lockValue: locked ? String(p.lock_value || '') : null,
        writable: !locked && p.writable !== false,
        target: p.write_target ? String(p.write_target) : null,
        note: locked
          ? '被环境变量 ' +
            String(p.lock_env || '') +
            '=' +
            String(p.lock_value || '') +
            ' 锁定：改了也会被覆盖，先取消该变量'
          : '改完立即生效，无需重启',
      }
    }

    /** 面板的纯投影（测试直接对拍；不碰 DOM、不抛）。 */
    function panelModel(payload, now) {
      var p = payload && typeof payload === 'object' ? payload : {}
      var res = p.resources && typeof p.resources === 'object' ? p.resources : {}
      var requests = Array.isArray(p.requests) ? p.requests : []
      var sessions = Array.isArray(p.sessions) ? p.sessions : []
      var ts = Number(p.ts) || now || Date.now()
      var pending = []
      var decided = []
      for (var i = 0; i < requests.length; i++) {
        var card = panelCard(requests[i], ts)
        if (card.state === 'pending') pending.push(card)
        else decided.push(card)
      }
      var rows = []
      for (var j = 0; j < sessions.length; j++) rows.push(panelRow(sessions[j]))
      var auto = p.policy && p.policy.auto === true
      var limit = Number(res.limit) || 0
      var instances = Number(res.instances) || 0
      var claimM = rows.length
      return {
        ok: p.ok === true,
        ts: ts,
        auto: auto,
        autoBanner: auto
          ? '自动批准已开：virtual-gui 的每次 start 都直接放行（consent_source=policy:allow），不再弹卡片'
          : null,
        policy: policyView(p.policy),
        policyLabel:
          String((p.policy && p.policy.mode) || 'manual') +
          ' · ' +
          String((p.policy && p.policy.source) || 'default') +
          (p.policy && p.policy.file ? ' · ' + shortPath(String(p.policy.file)) : ''),
        pending: pending,
        pendingCount: pending.length,
        pendingShown: pending.slice(0, PANEL_CARD_LIMIT),
        decidedShown: decided.slice(0, PANEL_CARD_LIMIT),
        decidedCount: decided.length,
        rows: rows,
        claimCount: claimM,
        instanceLabel:
          '实例 ' +
          instances +
          '/' +
          limit +
          (res.low_resource === true ? '（低内存，已降到 ' + limit + '）' : ''),
        resourceLabel:
          '实例 ' +
          instances +
          '/' +
          limit +
          (res.low_resource === true ? '（低内存，已降到 ' + limit + '）' : ''),
        countsLabel: '待批准 ' + pending.length + ' ｜ 认领 ' + claimM,
        title:
          'Blender 会话' +
          (pending.length ? ' · ' + pending.length + ' 待批准' : '') +
          (auto ? ' · 自动批准已开' : ''),
        chipLabel: 'Blender · ' + pending.length + ' 待批准',
        chipActive: pending.length > 0,
      }
    }

    //#region 数据面（每个会话一条轮询，多个面板位共享）
    function panelUrl(sessionId) {
      return (
        backend() +
        '/lease?action=consent_panel&dshSessionId=' +
        encodeURIComponent(String(sessionId || ''))
      )
    }

    function decideUrl(handle, action) {
      return (
        backend() +
        '/lease?action=' +
        (action === 'deny' ? 'consent_deny' : 'consent_approve') +
        '&handle=' +
        encodeURIComponent(String(handle || '')) +
        '&source=panel'
      )
    }

    function policyUrl() {
      return backend() + '/lease'
    }

    /** 唯一的新写路径：POST /lease {action:consent_policy_set, mode}。 */
    async function postPolicy(mode) {
      return fetchJSON(policyUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'consent_policy_set', mode: String(mode || '') }),
      })
    }

    var FEEDS = {}
    function feedOf(sessionId) {
      var key = String(sessionId || '')
      if (!FEEDS[key])
        FEEDS[key] = { payload: null, error: '', subscribers: [], timer: 0, started: false }
      return FEEDS[key]
    }
    function notifyFeed(feed) {
      for (var i = 0; i < feed.subscribers.length; i++) {
        try {
          feed.subscribers[i](feed)
        } catch (e) {
          /* 单个订阅者出错不影响别的面板位 */
        }
      }
    }
    function pollFeed(feed, sessionId) {
      if (!feed.started) return
      fetchJSON(panelUrl(sessionId), { cache: 'no-store' }).then(
        function (r) {
          if (!feed.started) return
          if (r && r.ok && r.body) {
            feed.payload = r.body
            feed.error = ''
          } else if (r && r.body && r.body.code === 'origin_not_allowed') {
            feed.error = '面板来源不被允许：请从 DSH 应用里打开'
          }
          notifyFeed(feed)
          var busy =
            !!(feed.payload && Array.isArray(feed.payload.requests)) &&
            feed.payload.requests.some(function (x) {
              return x && x.state === 'pending'
            })
          feed.timer = window.setTimeout(
            function () {
              pollFeed(feed, sessionId)
            },
            busy ? PANEL_POLL_BUSY_MS : PANEL_POLL_IDLE_MS,
          )
        },
        function () {
          if (!feed.started) return
          feed.timer = window.setTimeout(function () {
            pollFeed(feed, sessionId)
          }, PANEL_POLL_IDLE_MS)
        },
      )
    }
    function subscribeFeed(sessionId, listener) {
      var feed = feedOf(sessionId)
      feed.subscribers.push(listener)
      if (!feed.started) {
        feed.started = true
        pollFeed(feed, sessionId)
      }
      listener(feed)
      return function () {
        feed.subscribers = feed.subscribers.filter(function (x) {
          return x !== listener
        })
        if (feed.subscribers.length) return
        feed.started = false
        if (feed.timer) window.clearTimeout(feed.timer)
        feed.timer = 0
      }
    }
    async function refreshFeed(sessionId) {
      var feed = feedOf(sessionId)
      var r = await fetchJSON(panelUrl(sessionId), { cache: 'no-store' })
      if (r && r.ok && r.body) {
        feed.payload = r.body
        feed.error = ''
        notifyFeed(feed)
      }
      return feed
    }
    //#endregion

    //#region v3.5 · 运维面（连接 / 通道 / 作业 / 诊断 / 设置）
    /**
     * 面板的第二个数据面：三份**只读**快照（`/host/state`、`/health`、`/host/jobs`）拼成一块，
     * 全部零 Blender 往返；诊断（`/status` + `/doctor`）只在人点按钮时取一次，避免轮询把面板拖慢。
     *
     * 边界（面板需求书 §五）：这里没有任何会话写路径 —— 不 attach、不 release、不改 owner/grant，
     * 也不新增 consent 之外的写接口。设置区只写本机 localStorage（后端地址 / 轮询间隔），
     * 属于客户端偏好，不是 Gateway 的权限面。
     */
    var OPS_POLL_BUSY_MS = 1000
    var OPS_POLL_IDLE_MS = 2500
    var OPS_MIN_POLL_MS = 800
    var OPS_MAX_POLL_MS = 15000
    var OPS_JOB_LIMIT = 6
    var OPS_LOG_TAIL = 6000
    var OPS_RAW_LIMIT = 4000
    var LS_OPS_POLL_KEY = 'dsh-blender-plugin:panel:ops-poll-ms'
    var LS_OPS_OPEN_KEY = 'dsh-blender-plugin:panel:ops-open'
    var LS_SETTINGS_OPEN_KEY = 'dsh-blender-plugin:panel:settings-open'
    var LS_RAW_KEY = 'dsh-blender-plugin:panel:raw'

    var JOB_STATUS_LABELS = {
      running: '运行中',
      completed: '完成',
      failed: '失败',
      killed: '已取消',
      queued: '排队',
      pending: '待跑',
      unknown: '未知',
    }
    var BACKEND_SOURCE_LABELS = {
      localStorage: '本地面板覆盖',
      window: '宿主注入',
      config: '插件配置',
      default: '默认',
    }

    function readStoredFlag(key, fallback) {
      try {
        var v = window.localStorage.getItem(key)
        if (v === null) return fallback
        return v !== '0'
      } catch (e) {
        return fallback
      }
    }

    function storeFlag(key, on) {
      try {
        window.localStorage.setItem(key, on ? '1' : '0')
      } catch (e) {
        /* 隐私模式：只在本组件生命周期内记住 */
      }
    }

    function clampInt(v, lo, hi, fallback) {
      var n = Number(v)
      if (!isFinite(n)) return fallback
      return Math.max(lo, Math.min(hi, Math.round(n)))
    }

    function opsPollMs() {
      var raw = null
      try {
        raw = window.localStorage.getItem(LS_OPS_POLL_KEY)
      } catch (e) {
        raw = null
      }
      return clampInt(raw, OPS_MIN_POLL_MS, OPS_MAX_POLL_MS, OPS_POLL_IDLE_MS)
    }

    function storeOpsPollMs(ms) {
      var v = clampInt(ms, OPS_MIN_POLL_MS, OPS_MAX_POLL_MS, OPS_POLL_IDLE_MS)
      try {
        window.localStorage.setItem(LS_OPS_POLL_KEY, String(v))
      } catch (e) {
        /* ignore */
      }
      return v
    }

    /** 当前后端地址是谁给的：面板覆盖 > 宿主注入 > 插件配置 > 默认。 */
    function backendSource() {
      try {
        if (window.localStorage.getItem(LS_BACKEND_KEY)) return 'localStorage'
      } catch (e) {
        /* ignore */
      }
      try {
        var injected = window.__DSH_BLENDER_BACKEND__
        if (typeof injected === 'string' && injected) return 'window'
      } catch (e) {
        /* ignore */
      }
      if (configuredBackend !== DEFAULT_BACKEND) return 'config'
      return 'default'
    }

    /** 规范化面板里的后端覆盖值（空 = 清除覆盖）；不碰存储，纯函数，便于测试。 */
    function normalizeBackendOverride(value) {
      var s = String(value === null || value === undefined ? '' : value).trim()
      if (!s) return ''
      if (!/^https?:\/\//i.test(s)) return ''
      return stripTrailingSlashes(s)
    }

    /** 写/清后端覆盖（仅 localStorage）。返回是否落盘。 */
    function setBackendOverride(value) {
      var v = normalizeBackendOverride(value)
      try {
        if (!v) window.localStorage.removeItem(LS_BACKEND_KEY)
        else window.localStorage.setItem(LS_BACKEND_KEY, v)
        return true
      } catch (e) {
        return false
      }
    }

    /** 复制文本：clipboard API 优先，退回隐藏 textarea（都失败就返回 false，不抛）。 */
    function copyText(text) {
      var s = String(text === null || text === undefined ? '' : text)
      if (!s) return false
      try {
        if (
          navigator &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          navigator.clipboard.writeText(s)
          return true
        }
      } catch (e) {
        /* 没授权 / 非安全上下文 → 走 textarea */
      }
      try {
        var el = document.createElement('textarea')
        el.value = s
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
        return true
      } catch (e2) {
        return false
      }
    }

    function shortId(id) {
      var s = String(id === null || id === undefined ? '' : id)
      if (s.length <= 12) return s
      return s.slice(0, 8) + '…'
    }

    function jobStatusLabel(job) {
      var j = job && typeof job === 'object' ? job : {}
      var key = String(j.status || 'unknown')
      var label = JOB_STATUS_LABELS[key] || key
      if (key === 'running' && j.stageName) label += ' · ' + String(j.stageName)
      return label
    }

    function scopeLabel(scope) {
      if (!Array.isArray(scope)) return ''
      var out = []
      for (var i = 0; i < scope.length; i++) {
        var row = scope[i] && typeof scope[i] === 'object' ? scope[i] : {}
        var kind = String(row.kind || '')
        var value = String(row.value || '')
        if (!kind && !value) continue
        out.push(kind + (value ? ':' + value : ''))
      }
      return out.join(',')
    }

    /** 通道一行字：最近一次成功的年龄 + 在飞数 + AI 是否暂停。 */
    function channelLabel(chan) {
      var c = chan && typeof chan === 'object' ? chan : {}
      var age = c.lastOkAgeMs === null || c.lastOkAgeMs === undefined ? null : Number(c.lastOkAgeMs)
      var base = age === null ? '通道无成功记录' : '通道最近 ok ' + msLabel(age) + '前'
      var inflight = Number(c.inflight) || 0
      if (inflight > 0) base += ' · 在飞 ' + inflight
      if (c.aiPaused === true) base += ' · AI 已暂停'
      return base
    }

    function leaseLabel(lease) {
      var l = lease && typeof lease === 'object' ? lease : {}
      if (l.active !== true) return '无写租约'
      var text =
        '写租约 ' +
        String(l.holder || 'anonymous') +
        ' · 剩余 ' +
        msLabel(Number(l.expiresInMs) || 0)
      if (l.holderAlive === false) text += ' · holder 已退出（下次写自动回收）'
      var scope = scopeLabel(l.scope)
      if (scope) text += ' · scope ' + scope
      return text
    }

    function renderLabel(render) {
      var r = render && typeof render === 'object' ? render : {}
      if (r.busy !== true) return '未在渲染'
      var text = '渲染中'
      if (r.ageMs !== null && r.ageMs !== undefined)
        text += ' · 已 ' + msLabel(Number(r.ageMs) || 0)
      if (r.scene) text += ' · ' + String(r.scene)
      return text
    }

    // ------------------------------------------------------------ 只读 HTTP
    function opsUrlState() {
      return backend() + '/host/state'
    }

    function opsUrlHealth() {
      return backend() + '/health'
    }

    function opsUrlJobs(limit) {
      return backend() + '/host/jobs?limit=' + String(clampInt(limit, 1, 100, OPS_JOB_LIMIT))
    }

    function opsUrlJobLog(id, tail) {
      return (
        backend() +
        '/host/jobs/log?id=' +
        encodeURIComponent(String(id || '')) +
        '&tail=' +
        String(clampInt(tail, 1, 200000, OPS_LOG_TAIL))
      )
    }

    function opsUrlStatus() {
      return backend() + '/status'
    }

    function opsUrlDoctor() {
      return backend() + '/doctor'
    }

    /** 一次取三份只读快照；单个失败只记进 errors，不拖垮其余两块。 */
    async function fetchOpsSnapshot() {
      var out = { ts: Date.now(), state: null, health: null, jobs: null, errors: [] }
      var results = await Promise.all([
        fetchJSON(opsUrlState(), { cache: 'no-store' }),
        fetchJSON(opsUrlHealth(), { cache: 'no-store' }),
        fetchJSON(opsUrlJobs(OPS_JOB_LIMIT), { cache: 'no-store' }),
      ])
      var keys = ['state', 'health', 'jobs']
      for (var i = 0; i < results.length; i++) {
        var res = results[i]
        var body = res && res.body ? res.body : null
        if (res && res.ok && body && body.ok !== false) out[keys[i]] = body
        else
          out.errors.push(
            keys[i] + '：' + String((res && (res.error || 'HTTP ' + res.status)) || '取不到'),
          )
      }
      return out
    }

    /** 按需诊断：`/status`（版本 / addon / Blender）+ `/doctor`（verdict / 配置 / 修法）。 */
    async function fetchDiagnostics() {
      var results = await Promise.all([
        fetchJSON(opsUrlStatus(), { cache: 'no-store' }),
        fetchJSON(opsUrlDoctor(), { cache: 'no-store' }),
      ])
      var out = { ts: Date.now(), status: null, doctor: null, error: '' }
      if (results[0] && results[0].ok && results[0].body) out.status = results[0].body
      if (results[1] && results[1].ok && results[1].body) out.doctor = results[1].body
      if (!out.status && !out.doctor)
        out.error =
          '诊断取不到：' +
          String(
            (results[1] && results[1].error) ||
              (results[0] && results[0].error) ||
              'Gateway 未响应',
          )
      return out
    }

    /** 作业日志尾部（stdout + stderr）。失败给 error 文本，不抛。 */
    async function fetchJobLog(id) {
      var jobId = String(id || '')
      var res = await fetchJSON(opsUrlJobLog(jobId, OPS_LOG_TAIL), { cache: 'no-store' })
      if (!res || !res.body)
        return {
          id: jobId,
          text: '',
          error: '日志取不到：' + String((res && res.error) || 'unknown'),
        }
      if (res.body.ok === false)
        return {
          id: jobId,
          text: '',
          error: '作业不存在或已清理：' + String(res.body.error || 'unknown_job'),
        }
      var text =
        res.body.stdout === null || res.body.stdout === undefined ? '' : String(res.body.stdout)
      var err =
        res.body.stderr === null || res.body.stderr === undefined ? '' : String(res.body.stderr)
      if (err) text += (text ? '\n' : '') + '--- stderr ---\n' + err
      if (!text) text = '（这个作业还没有输出）'
      return { id: jobId, text: text, error: '' }
    }

    // ------------------------------------------------------------ 轮询（多个面板位共享）
    var OPS_FEED = { payload: null, error: '', subscribers: [], timer: 0, started: false }

    function notifyOps() {
      for (var i = 0; i < OPS_FEED.subscribers.length; i++) {
        try {
          OPS_FEED.subscribers[i](OPS_FEED)
        } catch (e) {
          /* 单个订阅者出错不影响别的面板位 */
        }
      }
    }

    /** 把新一轮快照并进旧 payload：诊断结果与已打开的日志跨轮询保留。 */
    function mergeOps(prev, snap) {
      var base = prev && typeof prev === 'object' ? prev : {}
      return {
        ts: snap.ts,
        state: snap.state,
        health: snap.health,
        jobs: snap.jobs,
        errors: snap.errors,
        diagnostics: base.diagnostics || null,
        log: base.log || null,
      }
    }

    function opsBusyNow() {
      var p = OPS_FEED.payload
      if (!p) return false
      var st = p.state && typeof p.state === 'object' ? p.state : {}
      var running = st.jobs && typeof st.jobs === 'object' ? Number(st.jobs.running) || 0 : 0
      var render = st.render && typeof st.render === 'object' && st.render.busy === true
      return running > 0 || render
    }

    function scheduleOpsPoll() {
      var ms = opsBusyNow() ? OPS_POLL_BUSY_MS : opsPollMs()
      OPS_FEED.timer = window.setTimeout(function () {
        pollOps()
      }, ms)
    }

    function pollOps() {
      if (!OPS_FEED.started) return
      fetchOpsSnapshot().then(
        function (snap) {
          if (!OPS_FEED.started) return
          OPS_FEED.payload = mergeOps(OPS_FEED.payload, snap)
          OPS_FEED.error = ''
          notifyOps()
          scheduleOpsPoll()
        },
        function () {
          if (!OPS_FEED.started) return
          OPS_FEED.error = '运维面取不到：Gateway 未响应'
          notifyOps()
          scheduleOpsPoll()
        },
      )
    }

    function subscribeOps(listener) {
      OPS_FEED.subscribers.push(listener)
      if (!OPS_FEED.started) {
        OPS_FEED.started = true
        pollOps()
      }
      listener(OPS_FEED)
      return function () {
        OPS_FEED.subscribers = OPS_FEED.subscribers.filter(function (x) {
          return x !== listener
        })
        if (OPS_FEED.subscribers.length) return
        OPS_FEED.started = false
        if (OPS_FEED.timer) window.clearTimeout(OPS_FEED.timer)
        OPS_FEED.timer = 0
      }
    }

    async function refreshOpsFeed() {
      var snap = await fetchOpsSnapshot()
      OPS_FEED.payload = mergeOps(OPS_FEED.payload, snap)
      OPS_FEED.error = ''
      notifyOps()
      return OPS_FEED
    }

    async function refreshOpsDiagnostics() {
      var d = await fetchDiagnostics()
      var base = OPS_FEED.payload && typeof OPS_FEED.payload === 'object' ? OPS_FEED.payload : {}
      OPS_FEED.payload = {
        ts: base.ts || Date.now(),
        state: base.state || null,
        health: base.health || null,
        jobs: base.jobs || null,
        errors: base.errors || [],
        diagnostics: d,
        log: base.log || null,
      }
      notifyOps()
      return d
    }

    async function openOpsJobLog(id) {
      var log = await fetchJobLog(id)
      var base = OPS_FEED.payload && typeof OPS_FEED.payload === 'object' ? OPS_FEED.payload : {}
      OPS_FEED.payload = {
        ts: base.ts || Date.now(),
        state: base.state || null,
        health: base.health || null,
        jobs: base.jobs || null,
        errors: base.errors || [],
        diagnostics: base.diagnostics || null,
        log: log,
      }
      notifyOps()
      return log
    }

    function closeOpsJobLog() {
      if (!OPS_FEED.payload || typeof OPS_FEED.payload !== 'object') return
      OPS_FEED.payload = {
        ts: OPS_FEED.payload.ts,
        state: OPS_FEED.payload.state || null,
        health: OPS_FEED.payload.health || null,
        jobs: OPS_FEED.payload.jobs || null,
        errors: OPS_FEED.payload.errors || [],
        diagnostics: OPS_FEED.payload.diagnostics || null,
        log: null,
      }
      notifyOps()
    }

    // ------------------------------------------------------------ 投影（纯函数，不抛）
    /**
     * 运维面的全部显示字段。入参是三份快照（可为 null），出参只含字符串/数字/数组，
     * 缺失一律降级成 `''` / `null`，绝不让面板因为一个缺字段整块消失。
     */
    function panelOpsModel(ops, now) {
      var o = ops && typeof ops === 'object' ? ops : {}
      var st = o.state && typeof o.state === 'object' ? o.state : {}
      var hl = o.health && typeof o.health === 'object' ? o.health : {}
      var jb = o.jobs && typeof o.jobs === 'object' ? o.jobs : {}
      var diag = o.diagnostics && typeof o.diagnostics === 'object' ? o.diagnostics : null
      var chan = st.channel && typeof st.channel === 'object' ? st.channel : {}
      // /host/state 只给 pid+uptime，/health 还多一个 rssMB：逐字段合并，别整块二选一。
      var bkState = st.backend && typeof st.backend === 'object' ? st.backend : {}
      var bkHealth = hl.backend && typeof hl.backend === 'object' ? hl.backend : {}
      var bk = {
        pid: bkState.pid || bkHealth.pid || null,
        uptimeMs: bkState.uptimeMs || bkHealth.uptimeMs || 0,
        rssMB: bkState.rssMB || bkHealth.rssMB || 0,
      }
      var prov = hl.provenance && typeof hl.provenance === 'object' ? hl.provenance : {}
      var gw = hl.gateway && typeof hl.gateway === 'object' ? hl.gateway : {}
      var lease =
        st.lease && typeof st.lease === 'object'
          ? st.lease
          : hl.lease && typeof hl.lease === 'object'
            ? hl.lease
            : {}
      var render = st.render && typeof st.render === 'object' ? st.render : {}
      var errors = Array.isArray(o.errors) ? o.errors : []
      var problems = []
      for (var e = 0; e < errors.length && problems.length < 3; e++)
        problems.push(String(errors[e]))
      if (chan.lastError) problems.push('通道最后错误：' + String(chan.lastError).slice(0, 160))
      if (chan.diagnosis) problems.push('诊断：' + String(chan.diagnosis))

      var rawJobs = Array.isArray(jb.jobs) ? jb.jobs : []
      var jobRows = []
      for (var i = 0; i < rawJobs.length; i++) {
        var job = rawJobs[i] && typeof rawJobs[i] === 'object' ? rawJobs[i] : {}
        jobRows.push({
          id: String(job.id || ''),
          short: shortId(job.id),
          kind: String(job.kind || 'job'),
          status: String(job.status || 'unknown'),
          statusLabel: jobStatusLabel(job),
          msLabel: msLabel(Number(job.ms) || 0),
          pid: job.pid === null || job.pid === undefined ? null : Number(job.pid),
        })
      }

      var source = backendSource()
      var dg = null
      if (diag) {
        var doc = diag.doctor && typeof diag.doctor === 'object' ? diag.doctor : {}
        var stt = diag.status && typeof diag.status === 'object' ? diag.status : {}
        var cfg = doc.config && typeof doc.config === 'object' ? doc.config : {}
        var readiness =
          doc.readiness && typeof doc.readiness === 'object'
            ? doc.readiness
            : stt.readiness && typeof stt.readiness === 'object'
              ? stt.readiness
              : {}
        var addon = readiness.addon && typeof readiness.addon === 'object' ? readiness.addon : {}
        var blender = stt.blender && typeof stt.blender === 'object' ? stt.blender : {}
        var next = Array.isArray(doc.next_actions)
          ? doc.next_actions
          : Array.isArray(stt.next_actions)
            ? stt.next_actions
            : []
        var diagnosis = doc.diagnosis && typeof doc.diagnosis === 'object' ? doc.diagnosis : null
        var workDir = cfg.workDir && typeof cfg.workDir === 'object' ? cfg.workDir : {}
        var pairs = [
          ['HTTP', String(cfg.http || '')],
          ['Gateway', String(cfg.gateway || '')],
          ['工作目录', String(workDir.win || workDir.wsl || '')],
          ['Blender', cfg.blenderExe ? shortPath(String(cfg.blenderExe)) : ''],
          ['配置文件', cfg.configFile ? shortPath(String(cfg.configFile)) : '（默认）'],
          ['租约 TTL', cfg.leaseTtlMs ? msLabel(Number(cfg.leaseTtlMs)) : ''],
          ['平台', String(cfg.platform || '') + (cfg.distro ? '/' + String(cfg.distro) : '')],
        ]
        var configRows = []
        for (var c = 0; c < pairs.length; c++) {
          if (pairs[c][1]) configRows.push({ label: pairs[c][0], value: pairs[c][1] })
        }
        dg = {
          verdict: String(doc.verdict || 'unknown'),
          ok: doc.ok === true,
          error: String(diag.error || ''),
          summary: String((diagnosis && diagnosis.summary) || stt.addonError || '').slice(0, 300),
          fix: String((diagnosis && diagnosis.fix) || '').slice(0, 240),
          readyInstances:
            addon.ready_instances === null || addon.ready_instances === undefined
              ? null
              : Number(addon.ready_instances),
          instanceId: addon.instanceId ? String(addon.instanceId) : '',
          pluginVersion: String(stt.pluginVersion || (stt.plugin && stt.plugin.version) || ''),
          provenance: String(
            (stt.plugin && stt.plugin.provenance && stt.plugin.provenance.verdict) ||
              prov.verdict ||
              '',
          ),
          blenderVersion: blender.version ? String(blender.version) : '',
          blenderExe: blender.exe ? String(blender.exe) : '',
          nextActions: next.slice(0, 3).map(function (x) {
            return String(x)
          }),
          configRows: configRows,
          ageLabel: diag.ts
            ? msLabel(Math.max(0, (Number(now) || Date.now()) - Number(diag.ts))) + '前'
            : '',
        }
      }

      var rawText = ''
      try {
        rawText = JSON.stringify(
          {
            ts: o.ts || null,
            state: o.state || null,
            health: o.health || null,
            jobs: o.jobs || null,
          },
          null,
          1,
        ).slice(0, OPS_RAW_LIMIT)
      } catch (e) {
        rawText = '（原始快照无法序列化）'
      }

      var log = null
      if (o.log && typeof o.log === 'object') {
        log = {
          id: String(o.log.id || ''),
          short: shortId(o.log.id),
          text: String(o.log.text || ''),
          error: String(o.log.error || ''),
        }
      }

      return {
        ready: !!(o.state || o.health),
        ts: Number(o.ts) || 0,
        errors: errors,
        problems: problems,
        problemLabel: problems.length ? problems[0] : '',
        connection: {
          backendLabel: backend(),
          backendSource: source,
          backendSourceLabel: BACKEND_SOURCE_LABELS[source] || source,
          gatewayPid: Number(gw.pid) || Number(bk.pid) || null,
          uptimeLabel: bk.uptimeMs ? msLabel(Number(bk.uptimeMs)) : '',
          rssLabel: bk.rssMB ? String(Math.round(Number(bk.rssMB))) + ' MB' : '',
          pluginVersion: String(prov.pluginVersion || ''),
          provenance: String(prov.verdict || ''),
          channelLabel: channelLabel(chan),
          inflight: Number(chan.inflight) || 0,
          lastCmd: String(chan.lastCmd || ''),
          aiPaused: chan.aiPaused === true,
          channelError: String(chan.lastError || ''),
          leaseLabel: leaseLabel(lease),
          leaseActive: lease && lease.active === true,
          renderLabel: renderLabel(render),
          renderBusy: !!(render && render.busy === true),
        },
        jobs: {
          running: Number(jb.running) || 0,
          total: Number(jb.total) || jobRows.length,
          rows: jobRows,
          shown: jobRows.length,
          log: log,
          label:
            '运行中 ' +
            (Number(jb.running) || 0) +
            ' ｜ 共 ' +
            (Number(jb.total) || jobRows.length),
        },
        diagnostics: dg,
        settings: {
          backend: backend(),
          backendSource: source,
          backendSourceLabel: BACKEND_SOURCE_LABELS[source] || source,
          pollMs: opsPollMs(),
        },
        rawText: rawText,
        opsLabel: channelLabel(chan),
      }
    }

    //#endregion

    //#region 抽屉（右侧栏不可用时的兜底入口）
    var OVERLAY = { open: false, sessionId: '', subscribers: [] }
    function notifyOverlay() {
      for (var i = 0; i < OVERLAY.subscribers.length; i++) {
        try {
          OVERLAY.subscribers[i](OVERLAY)
        } catch (e) {
          /* ignore */
        }
      }
    }
    function subscribeOverlay(listener) {
      OVERLAY.subscribers.push(listener)
      listener(OVERLAY)
      return function () {
        OVERLAY.subscribers = OVERLAY.subscribers.filter(function (x) {
          return x !== listener
        })
      }
    }
    function openOverlay(sessionId) {
      OVERLAY.open = true
      OVERLAY.sessionId = String(sessionId || '')
      notifyOverlay()
    }
    function closeOverlay() {
      OVERLAY.open = false
      notifyOverlay()
    }
    /**
     * 打开面板：优先右侧栏 tab（会话视图的正式挂载点）；右侧栏服务不可用时落到抽屉。
     * 两个都是"同一份数据 + 同一套动作"，只是容器不同。
     */
    function openPanel(ctx, sessionId) {
      try {
        var right = serviceOf(ctx, 'sidebarRight')
        if (right && typeof right.openTab === 'function') {
          right.openTab(PANEL_TAB_KIND)
          return 'sidebar'
        }
      } catch (e) {
        /* 右侧栏不可用 → 抽屉 */
      }
      openOverlay(sessionId)
      return 'overlay'
    }

    function readOpen() {
      try {
        for (var i = 0; i < PANEL_LEGACY_KEYS.length; i++)
          window.localStorage.removeItem(PANEL_LEGACY_KEYS[i])
        return window.localStorage.getItem(PANEL_OPEN_KEY) !== '0'
      } catch (e) {
        return true
      }
    }

    function writeOpen(v) {
      try {
        window.localStorage.setItem(PANEL_OPEN_KEY, v ? '1' : '0')
      } catch (e) {
        /* 隐私模式：只在本组件生命周期内记住 */
      }
    }
    //#endregion

    //#region 渲染树（纯函数：入参是 createElement，测试不需要 DOM / React）
    /**
     * 面板主体：计数行 → auto 常显 → 策略区（三态 + 来源 + 立即生效）→ 待批准卡片 → 认领表。
     * auto 的「自动批准已开」在收起状态下也渲染 —— 那是硬要求。
     */
    function panelTree(h, view) {
      var model = view.model
      var error = view.error
      var busy = view.busy
      var collapsed = view.collapsed
      var confirmAuto = view.confirmAuto
      var decide = view.onDecide
      var onPolicy = view.onPolicy
      var toggle = view.onToggle
      var policy = model.policy
      var children = []
      children.push(
        h(
          'div',
          { key: 'head', style: PANEL_STYLE.head, onClick: toggle },
          h('span', { style: PANEL_STYLE.title }, model.title),
          h('span', { style: PANEL_STYLE.meta }, model.countsLabel),
          h('span', { style: PANEL_STYLE.meta }, model.instanceLabel),
          h('span', { style: PANEL_STYLE.toggle }, collapsed ? '展开' : '收起'),
        ),
      )
      if (model.autoBanner)
        children.push(h('div', { key: 'auto', style: PANEL_STYLE.auto }, '● ' + model.autoBanner))
      if (error) children.push(h('div', { key: 'err', style: PANEL_STYLE.err }, error))
      if (!model.ok && view.ops)
        children.push(
          h(
            'div',
            { key: 'no-feed', style: PANEL_STYLE.err },
            '会话面板取不到：待批准与认领表暂不可用（检查 Gateway 端口 / addon 是否已连接）',
          ),
        )
      if (!collapsed) {
        // 策略区：manual / auto / deny
        var radios = []
        var modes = ['manual', 'auto', 'deny']
        for (var r = 0; r < modes.length; r++) {
          var mode = modes[r]
          var isCurrent = policy.mode === mode
          var confirming = confirmAuto === 'auto' && mode === 'auto'
          radios.push(
            h(
              'button',
              {
                key: 'mode-' + mode,
                type: 'button',
                'data-mode': mode,
                'aria-pressed': isCurrent ? 'true' : 'false',
                disabled: !policy.writable || busy !== '',
                style: isCurrent ? PANEL_STYLE.modeActive : PANEL_STYLE.mode,
                onClick: (function (m) {
                  return function () {
                    if (onPolicy) onPolicy(m)
                  }
                })(mode),
              },
              (isCurrent ? '● ' : '○ ') +
                (confirming ? '确认自动批准' : mode) +
                (mode === 'auto' && confirming ? '（以后每次 start 都直接放行、不再询问）' : ''),
            ),
          )
        }
        children.push(
          h(
            'div',
            { key: 'policy', style: PANEL_STYLE.policy },
            h('span', { style: PANEL_STYLE.policyLabel }, '策略'),
            h('span', { style: PANEL_STYLE.radios }, radios),
            h('span', { style: PANEL_STYLE.meta }, '当前 ' + policy.sourceLabel),
            h(
              'span',
              { key: 'policy-note', style: policy.locked ? PANEL_STYLE.locked : PANEL_STYLE.meta },
              policy.note,
            ),
          ),
        )
        if (policy.target)
          children.push(
            h('div', { key: 'policy-file', style: PANEL_STYLE.meta }, '写入 ' + policy.target),
          )
        if (confirmAuto === 'auto')
          children.push(
            h(
              'div',
              { key: 'confirm', style: PANEL_STYLE.confirm },
              '再点一次「确认自动批准」：开启后 virtual-gui 的每次 start 都直接放行，不再询问（人只在面板里能看到它开着）。',
            ),
          )
        for (var i = 0; i < model.pendingShown.length; i++) {
          var c = model.pendingShown[i]
          children.push(
            h(
              'div',
              { key: 'card-' + c.handle, style: PANEL_STYLE.card },
              h('div', { style: PANEL_STYLE.cardTitle }, '待批准 · ' + c.action),
              h('div', { style: PANEL_STYLE.meta }, '请求方 ' + c.who),
              h(
                'div',
                { style: PANEL_STYLE.meta },
                '影响：再起一个 Blender 进程 · ' + model.instanceLabel,
              ),
              h('div', { style: PANEL_STYLE.meta }, '有效期剩余 ' + c.remainingLabel),
              h(
                'div',
                { style: PANEL_STYLE.actions },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-request': c.handle,
                    disabled: busy !== '',
                    style: PANEL_STYLE.approve,
                    onClick: (function (handle) {
                      return function () {
                        decide(handle, 'approve')
                      }
                    })(c.handle),
                  },
                  busy === c.handle + ':approve' ? '批准中…' : '批准',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-request': c.handle,
                    disabled: busy !== '',
                    style: PANEL_STYLE.deny,
                    onClick: (function (handle) {
                      return function () {
                        decide(handle, 'deny')
                      }
                    })(c.handle),
                  },
                  busy === c.handle + ':deny' ? '拒绝中…' : '拒绝',
                ),
              ),
            ),
          )
        }
        if (model.pending.length > model.pendingShown.length)
          children.push(
            h(
              'div',
              { key: 'more-pending', style: PANEL_STYLE.meta },
              '另有 ' + (model.pending.length - model.pendingShown.length) + ' 条待批准',
            ),
          )
        if (!model.pending.length && !model.rows.length)
          children.push(h('div', { key: 'empty', style: PANEL_STYLE.meta }, '0 待批准 · 0 实例'))
        for (var k = 0; k < model.rows.length; k++) {
          var row = model.rows[k]
          children.push(
            h(
              'div',
              { key: 'row-' + row.id, style: PANEL_STYLE.row },
              h('span', { style: PANEL_STYLE.cellStrong }, row.instanceId || row.id),
              h(
                'span',
                { style: PANEL_STYLE.cell },
                String(row.kind || '') + (row.status ? ' · ' + row.status : ''),
              ),
              h(
                'span',
                { style: PANEL_STYLE.cell },
                row.ownerSession
                  ? row.ownerSession + '/' + (row.ownerAgent || '?')
                  : '（无主，可 attach 认领）',
              ),
              h('span', { style: PANEL_STYLE.cell }, row.isMine ? 'is_mine ✓' : 'is_mine ✗'),
              h('span', { style: PANEL_STYLE.cell }, row.viewer ? 'viewer' : '—'),
              h('span', { style: PANEL_STYLE.cell }, row.borrowed ? 'borrowed' : '—'),
              h(
                'span',
                { style: PANEL_STYLE.cell },
                row.heartbeatAgeMs === null ? '心跳 -' : '心跳 ' + msLabel(row.heartbeatAgeMs),
              ),
              h(
                'span',
                { style: PANEL_STYLE.cell },
                row.expiresInMs === null ? '归属 -' : '归属剩 ' + msLabel(row.expiresInMs),
              ),
              h(
                'span',
                { style: PANEL_STYLE.cell },
                row.grantCount ? 'grant ×' + row.grantCount : '无 grant',
              ),
              h(
                'button',
                {
                  key: 'copy-' + row.id,
                  type: 'button',
                  'data-copy': row.instanceId || row.id,
                  style: PANEL_STYLE.small,
                  onClick: (function (inst) {
                    return function () {
                      if (view.onCopy)
                        view.onCopy('blender_session action=attach instance_id=' + inst)
                    }
                  })(row.instanceId || row.id),
                },
                '复制 attach',
              ),
            ),
          )
        }
        var opsBlocks = opsTree(h, view, view.ops)
        for (var b = 0; b < opsBlocks.length; b++) children.push(opsBlocks[b])
      }
      return h('div', { style: PANEL_STYLE.root }, children)
    }

    /** 连接行：后端 + 来源 + Gateway 进程 + 版本。 */
    function connectionLine(conn) {
      var c = conn && typeof conn === 'object' ? conn : {}
      var parts = []
      if (c.backendLabel)
        parts.push(String(c.backendLabel) + '（' + String(c.backendSourceLabel || '') + '）')
      if (c.gatewayPid) parts.push('pid ' + c.gatewayPid)
      if (c.uptimeLabel) parts.push('运行 ' + c.uptimeLabel)
      if (c.rssLabel) parts.push('RSS ' + c.rssLabel)
      if (c.pluginVersion) parts.push('插件 ' + c.pluginVersion)
      if (c.provenance) parts.push(String(c.provenance))
      return parts.join(' · ')
    }

    /** 一条作业行：短 id · kind · 状态 · 耗时 · 日志按钮。 */
    function jobRowTree(h, view, row) {
      var r = row && typeof row === 'object' ? row : {}
      var failed = String(r.status || '') === 'failed'
      return h(
        'div',
        { key: 'job-' + String(r.id || r.short), style: PANEL_STYLE.row },
        h('span', { style: PANEL_STYLE.cellStrong }, r.short),
        h('span', { style: PANEL_STYLE.cell }, r.kind),
        h('span', { style: failed ? PANEL_STYLE.err : PANEL_STYLE.cell }, r.statusLabel),
        h('span', { style: PANEL_STYLE.cell }, r.msLabel),
        h(
          'button',
          {
            key: 'job-log-' + String(r.id || r.short),
            type: 'button',
            'data-job': String(r.id || ''),
            style: PANEL_STYLE.small,
            onClick: function () {
              if (view.onJobLog) view.onJobLog(String(r.id || ''))
            },
          },
          '日志',
        ),
      )
    }

    /** 作业日志尾部（stdout + stderr）。 */
    function jobLogTree(h, view, log) {
      var l = log && typeof log === 'object' ? log : {}
      var kids = [
        h(
          'div',
          { key: 'job-log-title', style: PANEL_STYLE.cardTitle },
          '作业日志 ' + String(l.short || l.id || ''),
        ),
      ]
      if (l.error) kids.push(h('div', { key: 'job-log-err', style: PANEL_STYLE.err }, l.error))
      kids.push(h('pre', { key: 'job-log-pre', style: PANEL_STYLE.pre }, String(l.text || '')))
      kids.push(
        h(
          'button',
          {
            key: 'job-log-close',
            type: 'button',
            'data-action': 'job-log-close',
            style: PANEL_STYLE.small,
            onClick: function () {
              if (view.onJobLogClose) view.onJobLogClose()
            },
          },
          '关闭日志',
        ),
      )
      return h('div', { key: 'job-log', style: PANEL_STYLE.card }, kids)
    }

    /** 诊断结果：版本 + 缺口 + 修法 + 配置摘要（/doctor 的 config）。 */
    function diagnosticsTree(h, view, om) {
      var dg = om.diagnostics
      var kids = []
      if (!dg) {
        kids.push(
          h(
            'div',
            { key: 'diag-hint', style: PANEL_STYLE.meta },
            '点「运行诊断」取 /status + /doctor：版本自证、addon 就绪、缺失前提、配置与修法（只读，不 spawn 任何进程）',
          ),
        )
        return kids
      }
      kids.push(
        h(
          'div',
          { key: 'diag-line', style: PANEL_STYLE.meta },
          '插件 ' +
            String(dg.pluginVersion || '-') +
            ' · provenance ' +
            String(dg.provenance || '-') +
            ' · addon 就绪 ' +
            (dg.readyInstances === null ? '-' : String(dg.readyInstances)) +
            (dg.instanceId ? ' · ' + String(dg.instanceId) : '') +
            (dg.ageLabel ? ' · ' + dg.ageLabel : ''),
        ),
      )
      if (dg.blenderVersion || dg.blenderExe)
        kids.push(
          h(
            'div',
            { key: 'diag-blender', style: PANEL_STYLE.meta },
            'Blender ' +
              String(dg.blenderVersion || '-') +
              (dg.blenderExe ? ' · ' + shortPath(dg.blenderExe) : ''),
          ),
        )
      if (dg.error) kids.push(h('div', { key: 'diag-err', style: PANEL_STYLE.err }, dg.error))
      if (dg.summary)
        kids.push(h('div', { key: 'diag-summary', style: PANEL_STYLE.warn }, dg.summary))
      if (dg.fix)
        kids.push(h('div', { key: 'diag-fix', style: PANEL_STYLE.meta }, '修法：' + dg.fix))
      for (var i = 0; i < dg.nextActions.length; i++)
        kids.push(
          h(
            'div',
            { key: 'diag-next-' + i, style: PANEL_STYLE.meta },
            '下一步 ' + (i + 1) + '：' + String(dg.nextActions[i]).slice(0, 160),
          ),
        )
      for (var k = 0; k < dg.configRows.length; k++)
        kids.push(
          h(
            'div',
            { key: 'diag-cfg-' + k, style: PANEL_STYLE.kv },
            h('span', { style: PANEL_STYLE.kvKey }, dg.configRows[k].label),
            h('span', { style: PANEL_STYLE.kvValue }, dg.configRows[k].value),
          ),
        )
      return kids
    }

    /**
     * 运维区（连接 / 通道 · 作业 · 诊断 · 设置）。只读，动作只有：刷新、看日志、跑诊断、
     * 改本机后端地址/轮询间隔。没有 attach / release / grant 这类会动会话所有权的按钮。
     */
    function opsTree(h, view, opsModel) {
      var om = opsModel && typeof opsModel === 'object' ? opsModel : panelOpsModel(null, Date.now())
      var busy = view.busy || ''
      var conn = om.connection || {}
      var out = []

      var connKids = [
        h(
          'div',
          { key: 'ops-conn-head', style: PANEL_STYLE.sectionHead },
          h('span', { style: PANEL_STYLE.sectionTitle }, '连接 / 通道'),
          h(
            'span',
            { style: om.ready ? PANEL_STYLE.meta : PANEL_STYLE.err },
            om.ready ? '实时' : '取不到',
          ),
          h(
            'button',
            {
              key: 'ops-refresh',
              type: 'button',
              'data-action': 'ops-refresh',
              disabled: busy === 'ops',
              style: PANEL_STYLE.small,
              onClick: function () {
                if (view.onRefresh) view.onRefresh()
              },
            },
            busy === 'ops' ? '刷新中…' : '刷新',
          ),
        ),
        h('div', { key: 'ops-gw', style: PANEL_STYLE.meta }, connectionLine(conn)),
        h(
          'div',
          { key: 'ops-chan', style: PANEL_STYLE.meta },
          String(conn.channelLabel || '') + (conn.lastCmd ? ' · 最后命令 ' + conn.lastCmd : ''),
        ),
        h(
          'div',
          { key: 'ops-lease', style: conn.leaseActive ? PANEL_STYLE.warn : PANEL_STYLE.meta },
          String(conn.leaseLabel || '') + ' ｜ ' + String(conn.renderLabel || ''),
        ),
      ]
      for (var p = 0; p < (om.problems || []).length; p++)
        connKids.push(h('div', { key: 'ops-prob-' + p, style: PANEL_STYLE.err }, om.problems[p]))
      out.push(h('div', { key: 'ops-conn', style: PANEL_STYLE.section }, connKids))

      var jobKids = [
        h(
          'div',
          { key: 'ops-jobs-head', style: PANEL_STYLE.sectionHead },
          h('span', { style: PANEL_STYLE.sectionTitle }, '作业'),
          h('span', { style: PANEL_STYLE.meta }, String((om.jobs && om.jobs.label) || '')),
          h(
            'button',
            {
              key: 'ops-jobs-toggle',
              type: 'button',
              'data-action': 'ops-jobs-toggle',
              style: PANEL_STYLE.small,
              onClick: function () {
                if (view.onToggleOps) view.onToggleOps()
              },
            },
            view.opsOpen ? '收起' : '展开',
          ),
        ),
      ]
      if (view.opsOpen) {
        var rows = (om.jobs && om.jobs.rows) || []
        if (!rows.length)
          jobKids.push(
            h(
              'div',
              { key: 'ops-jobs-empty', style: PANEL_STYLE.meta },
              '还没有作业（blender_run 提交后出现在这里）',
            ),
          )
        for (var i = 0; i < rows.length; i++) jobKids.push(jobRowTree(h, view, rows[i]))
        if (om.jobs && om.jobs.log) jobKids.push(jobLogTree(h, view, om.jobs.log))
      }
      out.push(h('div', { key: 'ops-jobs', style: PANEL_STYLE.section }, jobKids))

      var diagHead = h(
        'div',
        { key: 'ops-diag-head', style: PANEL_STYLE.sectionHead },
        h('span', { style: PANEL_STYLE.sectionTitle }, '诊断'),
        h(
          'span',
          {
            style: om.diagnostics
              ? om.diagnostics.ok
                ? PANEL_STYLE.okText
                : PANEL_STYLE.warn
              : PANEL_STYLE.meta,
          },
          om.diagnostics
            ? om.diagnostics.ok
              ? 'verdict ' + om.diagnostics.verdict
              : '有缺口 · ' + om.diagnostics.verdict
            : '未诊断',
        ),
        h(
          'button',
          {
            key: 'ops-diag-run',
            type: 'button',
            'data-action': 'ops-diagnose',
            disabled: busy === 'diagnose',
            style: PANEL_STYLE.small,
            onClick: function () {
              if (view.onDiagnose) view.onDiagnose()
            },
          },
          busy === 'diagnose' ? '诊断中…' : '运行诊断',
        ),
      )
      var diagKids = [diagHead]
      if (view.opsOpen) diagKids = diagKids.concat(diagnosticsTree(h, view, om))
      out.push(h('div', { key: 'ops-diag', style: PANEL_STYLE.section }, diagKids))

      var setKids = [
        h(
          'div',
          { key: 'ops-set-head', style: PANEL_STYLE.sectionHead },
          h('span', { style: PANEL_STYLE.sectionTitle }, '设置（本机）'),
          h(
            'span',
            { style: PANEL_STYLE.meta },
            '前端缓存 ' + String(om.settings && om.settings.pollMs) + 'ms',
          ),
          h(
            'button',
            {
              key: 'ops-set-toggle',
              type: 'button',
              'data-action': 'settings-toggle',
              style: PANEL_STYLE.small,
              onClick: function () {
                if (view.onToggleSettings) view.onToggleSettings()
              },
            },
            view.settingsOpen ? '收起' : '展开',
          ),
        ),
      ]
      if (view.settingsOpen) {
        setKids.push(
          h(
            'div',
            { key: 'ops-set-backend', style: PANEL_STYLE.inputRow },
            h('span', { style: PANEL_STYLE.meta }, '后端地址'),
            h('input', {
              key: 'ops-set-backend-input',
              type: 'text',
              spellCheck: false,
              value:
                view.backendDraft === undefined
                  ? String(conn.backendLabel || '')
                  : view.backendDraft,
              placeholder: DEFAULT_BACKEND,
              style: PANEL_STYLE.input,
              onChange: function (ev) {
                if (view.onBackendDraft) view.onBackendDraft(ev && ev.target ? ev.target.value : '')
              },
            }),
            h(
              'button',
              {
                key: 'ops-set-save',
                type: 'button',
                'data-action': 'backend-save',
                style: PANEL_STYLE.small,
                onClick: function () {
                  if (view.onBackendSave) view.onBackendSave()
                },
              },
              '保存',
            ),
            h(
              'button',
              {
                key: 'ops-set-reset',
                type: 'button',
                'data-action': 'backend-reset',
                style: PANEL_STYLE.small,
                onClick: function () {
                  if (view.onBackendReset) view.onBackendReset()
                },
              },
              '恢复默认',
            ),
          ),
          h(
            'div',
            { key: 'ops-set-note', style: PANEL_STYLE.meta },
            '当前 ' +
              String(conn.backendLabel || '') +
              ' · 来源 ' +
              String(conn.backendSourceLabel || '') +
              '（只写本机 localStorage）',
          ),
          h(
            'div',
            { key: 'ops-set-poll', style: PANEL_STYLE.inputRow },
            h(
              'span',
              { style: PANEL_STYLE.meta },
              '轮询间隔 ' + String(om.settings && om.settings.pollMs) + 'ms',
            ),
            h(
              'button',
              {
                key: 'ops-set-poll-slow',
                type: 'button',
                'data-action': 'poll-slow',
                style: PANEL_STYLE.small,
                onClick: function () {
                  if (view.onPollSlow) view.onPollSlow()
                },
              },
              '慢一点',
            ),
            h(
              'button',
              {
                key: 'ops-set-poll-fast',
                type: 'button',
                'data-action': 'poll-fast',
                style: PANEL_STYLE.small,
                onClick: function () {
                  if (view.onPollFast) view.onPollFast()
                },
              },
              '快一点',
            ),
          ),
          h(
            'div',
            { key: 'ops-set-raw', style: PANEL_STYLE.inputRow },
            h('span', { style: PANEL_STYLE.meta }, '原始快照（排错用）'),
            h(
              'button',
              {
                key: 'ops-set-raw-toggle',
                type: 'button',
                'data-action': 'raw-toggle',
                style: PANEL_STYLE.small,
                onClick: function () {
                  if (view.onRawToggle) view.onRawToggle()
                },
              },
              view.rawOpen ? '隐藏' : '显示',
            ),
          ),
        )
        if (view.rawOpen)
          setKids.push(
            h('pre', { key: 'ops-set-raw-pre', style: PANEL_STYLE.pre }, String(om.rawText || '')),
          )
      }
      out.push(h('div', { key: 'ops-set', style: PANEL_STYLE.section }, setKids))
      return out
    }

    var PANEL_STYLE = {
      root: {
        padding: '8px',
        fontSize: '12px',
        lineHeight: '1.5',
        overflowY: 'auto',
        height: '100%',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        flexWrap: 'wrap',
      },
      title: { fontWeight: 600 },
      meta: { opacity: 0.75 },
      toggle: { marginLeft: 'auto', opacity: 0.6 },
      auto: { marginTop: '4px', color: '#b26a00', fontWeight: 600 },
      err: { marginTop: '4px', color: '#c0392b' },
      policy: {
        marginTop: '8px',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        flexWrap: 'wrap',
      },
      policyLabel: { fontWeight: 600 },
      radios: { display: 'inline-flex', gap: '4px' },
      mode: { padding: '2px 8px', cursor: 'pointer', opacity: 0.85 },
      modeActive: {
        padding: '2px 8px',
        cursor: 'pointer',
        fontWeight: 600,
        borderColor: '#4C8DFF',
      },
      locked: { color: '#b26a00' },
      confirm: { marginTop: '4px', color: '#b26a00' },
      card: {
        marginTop: '8px',
        padding: '6px 8px',
        border: '1px solid rgba(127,127,127,.35)',
        borderRadius: '6px',
      },
      cardTitle: { fontWeight: 600 },
      actions: { marginTop: '4px', display: 'flex', gap: '8px' },
      approve: { padding: '2px 10px', cursor: 'pointer' },
      deny: { padding: '2px 10px', cursor: 'pointer' },
      row: {
        display: 'flex',
        gap: '8px',
        flexWrap: 'wrap',
        paddingTop: '6px',
        marginTop: '6px',
        borderTop: '1px dashed rgba(127,127,127,.3)',
      },
      cell: { whiteSpace: 'nowrap' },
      drawer: {
        position: 'fixed',
        right: '16px',
        top: '72px',
        width: 'min(560px, 92vw)',
        maxHeight: '70vh',
        overflow: 'auto',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid rgba(127,127,127,.45)',
        borderRadius: '10px',
        boxShadow: '0 8px 30px rgba(0,0,0,.25)',
        pointerEvents: 'auto',
        zIndex: 60,
        padding: '10px',
      },
      drawerHead: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
      close: { marginLeft: 'auto', padding: '2px 8px', cursor: 'pointer' },
      chip: {
        alignSelf: 'flex-start',
        margin: '2px 0 0',
        padding: '1px 8px',
        fontSize: '11px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.5)',
        background: 'transparent',
        cursor: 'pointer',
      },
      chipDim: {
        alignSelf: 'flex-start',
        margin: '2px 0 0',
        padding: '1px 8px',
        fontSize: '11px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.25)',
        background: 'transparent',
        opacity: 0.55,
        cursor: 'pointer',
      },
      headerButton: { padding: '2px 8px', fontSize: '12px', cursor: 'pointer' },
      section: {
        marginTop: '10px',
        paddingTop: '6px',
        borderTop: '1px solid rgba(127,127,127,.25)',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        marginBottom: '4px',
      },
      sectionTitle: { fontWeight: 600 },
      small: { padding: '1px 6px', fontSize: '11px', cursor: 'pointer' },
      cellStrong: { whiteSpace: 'nowrap', fontWeight: 600 },
      okText: { color: '#2f7d32' },
      warn: { color: '#b26a00' },
      kv: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      kvKey: { opacity: 0.6, minWidth: '64px' },
      kvValue: { wordBreak: 'break-all' },
      pre: {
        marginTop: '4px',
        maxHeight: '220px',
        overflow: 'auto',
        padding: '6px',
        fontSize: '11px',
        lineHeight: '1.35',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        background: 'rgba(127,127,127,.12)',
        borderRadius: '4px',
      },
      inputRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        marginTop: '4px',
      },
      input: {
        flex: '1 1 200px',
        minWidth: '160px',
        padding: '2px 6px',
        fontSize: '12px',
      },
    }
    //#endregion

    //#region 组件
    function sessionIdOf(props) {
      var p = props || {}
      if (p.sessionId !== undefined && p.sessionId !== null) return p.sessionId
      if (p.blenderSessionId !== undefined && p.blenderSessionId !== null) return p.blenderSessionId
      var s = p.session
      if (s && typeof s === 'object') {
        if (s.sessionId) return s.sessionId
        if (s.key) return s.key
        if (s.id) return s.id
      }
      return ''
    }

    /** 面板主体（右侧栏 tab 与抽屉共用）。 */
    function makeSessionPanel() {
      function BlenderSessionPanel(props) {
        var sessionId = sessionIdOf(props)
        var feedTuple = React.useState(feedOf(sessionId).payload)
        var payload = feedTuple[0]
        var setPayload = feedTuple[1]
        var errTuple = React.useState('')
        var error = errTuple[0]
        var setError = errTuple[1]
        var tickTuple = React.useState(Date.now())
        var nowTs = tickTuple[0]
        var setNow = tickTuple[1]
        var collapseTuple = React.useState(readOpen)
        var collapsed = collapseTuple[0]
        var setCollapsed = collapseTuple[1]
        var busyTuple = React.useState('')
        var busy = busyTuple[0]
        var setBusy = busyTuple[1]
        var confirmTuple = React.useState('')
        var confirmAuto = confirmTuple[0]
        var setConfirmAuto = confirmTuple[1]
        var opsTuple = React.useState(OPS_FEED.payload)
        var ops = opsTuple[0]
        var setOps = opsTuple[1]
        var opsErrTuple = React.useState(OPS_FEED.error)
        var opsError = opsErrTuple[0]
        var setOpsError = opsErrTuple[1]
        var opsOpenTuple = React.useState(readStoredFlag(LS_OPS_OPEN_KEY, false))
        var opsOpen = opsOpenTuple[0]
        var setOpsOpen = opsOpenTuple[1]
        var settingsOpenTuple = React.useState(readStoredFlag(LS_SETTINGS_OPEN_KEY, false))
        var settingsOpen = settingsOpenTuple[0]
        var setSettingsOpen = settingsOpenTuple[1]
        var rawOpenTuple = React.useState(readStoredFlag(LS_RAW_KEY, false))
        var rawOpen = rawOpenTuple[0]
        var setRawOpen = rawOpenTuple[1]
        var draftTuple = React.useState(backend())
        var draft = draftTuple[0]
        var setDraft = draftTuple[1]
        var pollTuple = React.useState(0)
        var pollTick = pollTuple[0]
        var setPollTick = pollTuple[1]

        var model = React.useMemo
          ? React.useMemo(
              function () {
                return panelModel(payload, nowTs)
              },
              [payload, nowTs],
            )
          : panelModel(payload, nowTs)

        var opsModel = React.useMemo
          ? React.useMemo(
              function () {
                return panelOpsModel(ops, nowTs)
              },
              [ops, nowTs, pollTick],
            )
          : panelOpsModel(ops, nowTs)

        React.useEffect(
          function () {
            if (!sessionId) return undefined
            return subscribeFeed(sessionId, function (feed) {
              setPayload(feed.payload)
              setError(feed.error || '')
            })
          },
          [sessionId],
        )

        // 运维面只有一条轮询（多面板位共享），与 sessionId 无关。
        React.useEffect(function () {
          return subscribeOps(function (feed) {
            setOps(feed.payload)
            setOpsError(feed.error || '')
          })
        }, [])

        React.useEffect(function () {
          var t = window.setInterval(function () {
            setNow(Date.now())
          }, 500)
          return function () {
            window.clearInterval(t)
          }
        }, [])

        async function decide(handle, action) {
          if (!handle || busy) return
          setBusy(handle + ':' + action)
          try {
            var r = await fetchJSON(decideUrl(handle, action), { cache: 'no-store' })
            var body = r && r.body ? r.body : {}
            if (!r.ok || body.ok !== true)
              setError(String(body.root_cause || body.code || '决定未生效'))
            else setError('')
            await refreshFeed(sessionId)
          } catch (e) {
            setError('决定未生效：' + errText(e))
          }
          setBusy('')
        }

        async function onPolicy(mode) {
          if (!model.policy.writable || busy) return
          if (String(mode) === 'auto' && confirmAuto !== 'auto') {
            setConfirmAuto('auto')
            return
          }
          setConfirmAuto('')
          setBusy('policy:' + mode)
          try {
            var r = await postPolicy(mode)
            var body = r && r.body ? r.body : {}
            if (!r.ok || body.ok !== true)
              setError(String(body.root_cause || body.code || '策略没有改成功'))
            else setError('')
            await refreshFeed(sessionId)
          } catch (e) {
            setError('策略没有改成功：' + errText(e))
          }
          setBusy('')
        }

        function toggle() {
          var next = !collapsed
          setCollapsed(next)
          writeOpen(next)
        }

        async function refreshOps() {
          if (busy) return
          setBusy('ops')
          try {
            await refreshOpsFeed()
            setOpsError('')
          } catch (e) {
            setOpsError('刷新失败：' + errText(e))
          }
          setBusy('')
        }

        async function runDiagnose() {
          if (busy) return
          setBusy('diagnose')
          if (!opsOpen) {
            setOpsOpen(true)
            storeFlag(LS_OPS_OPEN_KEY, true)
          }
          try {
            var d = await refreshOpsDiagnostics()
            setOpsError(d && d.error ? d.error : '')
          } catch (e) {
            setOpsError('诊断失败：' + errText(e))
          }
          setBusy('')
        }

        async function showJobLog(id) {
          if (busy) return
          setBusy('log')
          try {
            var log = await openOpsJobLog(id)
            setOpsError(log && log.error ? log.error : '')
          } catch (e) {
            setOpsError('日志取不到：' + errText(e))
          }
          setBusy('')
        }

        function closeJobLog() {
          closeOpsJobLog()
        }

        function toggleOps() {
          var next = !opsOpen
          setOpsOpen(next)
          storeFlag(LS_OPS_OPEN_KEY, next)
        }

        function toggleSettings() {
          var next = !settingsOpen
          setSettingsOpen(next)
          storeFlag(LS_SETTINGS_OPEN_KEY, next)
        }

        function toggleRaw() {
          var next = !rawOpen
          setRawOpen(next)
          storeFlag(LS_RAW_KEY, next)
        }

        function draftChanged(value) {
          setDraft(String(value === null || value === undefined ? '' : value))
        }

        function saveBackend() {
          var raw = String(draft || '').trim()
          var v = normalizeBackendOverride(raw)
          if (raw && !v) {
            setOpsError('后端地址要以 http:// 或 https:// 开头')
            return
          }
          if (!setBackendOverride(v)) {
            setOpsError('浏览器拒绝写入 localStorage')
            return
          }
          setDraft(v || '')
          setOpsError('')
          refreshOpsFeed()
        }

        function resetBackend() {
          if (!setBackendOverride('')) {
            setOpsError('浏览器拒绝写入 localStorage')
            return
          }
          setDraft('')
          setOpsError('')
          refreshOpsFeed()
        }

        function pollSlower() {
          storeOpsPollMs(opsPollMs() * 2)
          setPollTick(Date.now())
        }

        function pollFaster() {
          storeOpsPollMs(opsPollMs() / 2)
          setPollTick(Date.now())
        }

        function copySomething(text) {
          if (!copyText(text)) setOpsError('复制失败：浏览器不允许访问剪贴板')
        }

        if (!sessionId && !model.ok && !error && !opsError) return null
        return panelTree(React.createElement, {
          model: model,
          ops: opsModel,
          error: error || opsError,
          busy: busy,
          collapsed: collapsed,
          confirmAuto: confirmAuto,
          opsOpen: opsOpen,
          settingsOpen: settingsOpen,
          rawOpen: rawOpen,
          backendDraft: draft,
          onDecide: decide,
          onPolicy: onPolicy,
          onToggle: toggle,
          onToggleOps: toggleOps,
          onToggleSettings: toggleSettings,
          onRefresh: refreshOps,
          onDiagnose: runDiagnose,
          onJobLog: showJobLog,
          onJobLogClose: closeJobLog,
          onBackendDraft: draftChanged,
          onBackendSave: saveBackend,
          onBackendReset: resetBackend,
          onPollSlow: pollSlower,
          onPollFast: pollFaster,
          onRawToggle: toggleRaw,
          onCopy: copySomething,
        })
      }
      return BlenderSessionPanel
    }

    /** 右侧栏 tab 的标题（独立槽位，必须单独注册）。 */
    function makePanelTitle() {
      function BlenderSessionTitle(props) {
        var sessionId = sessionIdOf(props)
        var feedTuple = React.useState(feedOf(sessionId).payload)
        var payload = feedTuple[0]
        var setPayload = feedTuple[1]
        React.useEffect(
          function () {
            if (!sessionId) return undefined
            return subscribeFeed(sessionId, function (feed) {
              setPayload(feed.payload)
            })
          },
          [sessionId],
        )
        var model = panelModel(payload, Date.now())
        return React.createElement(
          'span',
          null,
          PANEL_TITLE + (model.pendingCount ? ' · ' + model.pendingCount : ''),
        )
      }
      return BlenderSessionTitle
    }

    /** 会话头部入口按钮：有 pending 时带徽标数，点开右侧栏 tab（不可用则抽屉）。 */
    function makeHeaderAction(ctx) {
      function BlenderHeaderAction(props) {
        var sessionId = sessionIdOf(props)
        var feedTuple = React.useState(feedOf(sessionId).payload)
        var payload = feedTuple[0]
        var setPayload = feedTuple[1]
        React.useEffect(
          function () {
            if (!sessionId) return undefined
            return subscribeFeed(sessionId, function (feed) {
              setPayload(feed.payload)
            })
          },
          [sessionId],
        )
        var model = panelModel(payload, Date.now())
        return React.createElement(
          'button',
          {
            type: 'button',
            'data-blender-panel': 'open',
            title: 'Blender 会话：' + model.countsLabel,
            style: PANEL_STYLE.headerButton,
            onClick: function () {
              openPanel(ctx, sessionId)
            },
          },
          'Blender 会话' + (model.pendingCount ? ' · ' + model.pendingCount : ''),
        )
      }
      return BlenderHeaderAction
    }

    /** 输入框上方的极简状态：一行，点它打开面板；没有 pending 时灰显。 */
    function makeSessionChip(ctx) {
      function BlenderSessionChip(props) {
        var sessionId = sessionIdOf(props)
        var feedTuple = React.useState(feedOf(sessionId).payload)
        var payload = feedTuple[0]
        var setPayload = feedTuple[1]
        React.useEffect(
          function () {
            if (!sessionId) return undefined
            return subscribeFeed(sessionId, function (feed) {
              setPayload(feed.payload)
            })
          },
          [sessionId],
        )
        var model = panelModel(payload, Date.now())
        if (!model.ok) return null
        // 无 pending 且无会话：留一条灰字，入口仍可达（不占视觉重量）
        var dim = model.pendingCount === 0
        return React.createElement(
          'button',
          {
            type: 'button',
            'data-blender-chip': model.chipActive ? 'active' : 'idle',
            style: dim ? PANEL_STYLE.chipDim : PANEL_STYLE.chip,
            title: '打开 Blender 会话面板（' + model.countsLabel + '）',
            onClick: function () {
              openPanel(ctx, sessionId)
            },
          },
          model.chipLabel,
        )
      }
      return BlenderSessionChip
    }

    /** 抽屉兜底（右侧栏服务不存在时）。 */
    function makeOverlayDrawer() {
      function BlenderOverlayDrawer() {
        var stateTuple = React.useState(OVERLAY)
        var state = stateTuple[0]
        var setState = stateTuple[1]
        React.useEffect(function () {
          return subscribeOverlay(function () {
            setState({ open: OVERLAY.open, sessionId: OVERLAY.sessionId })
          })
        }, [])
        if (!state.open) return null
        var Panel = OVERLAY_PANEL
        var h = React.createElement
        return h(
          'div',
          { style: PANEL_STYLE.drawer },
          h(
            'div',
            { style: PANEL_STYLE.drawerHead },
            h('span', { style: PANEL_STYLE.title }, PANEL_TITLE),
            h(
              'button',
              { type: 'button', style: PANEL_STYLE.close, onClick: closeOverlay },
              '关闭',
            ),
          ),
          h(Panel, { sessionId: state.sessionId }),
        )
      }
      return BlenderOverlayDrawer
    }
    var OVERLAY_PANEL = null
    //#endregion

    //#region @ 提及源（契约 §2.5）
    /** ref 前缀 → 允许的种类（`object:<name>` / `material:<name>` / `collection:<name>`）。 */
    var REF_KINDS = { object: true, material: true, collection: true }

    /**
     * 拆 ref：`object:Cube` → `{kind:"object", name:"Cube"}`；裸 `Cube` → `{kind:"object", name:"Cube"}`。
     * 裸值按 object 处理 ⇒ 契约 §2.5 里那两行 codec 写法（`'@'+ref`、`'<blender-object>'+ref+'</blender-object>'`）
     * 对裸 ref **逐字成立**，对带前缀的 ref 则给出更准确的模型文本。
     */
    function splitRef(ref) {
      var s = String(ref === null || ref === undefined ? '' : ref)
      var i = s.indexOf(':')
      if (i > 0) {
        var kind = s.slice(0, i)
        if (REF_KINDS[kind] === true) return { kind: kind, name: s.slice(i + 1) }
      }
      return { kind: 'object', name: s }
    }

    /**
     * `@` 候选数据源：`GET /host/scene-items?q=<query>`。
     * 按 对象 / 材质 / 集合 用 `section` 分组（候选**没有**缩略图字段，契约 §2.5）。
     * **失败必须返回 `[]` 且不抛** —— 抛了会污染输入框。
     */
    async function sceneItemCandidates(req) {
      try {
        var q = req && typeof req.query === 'string' ? req.query : ''
        var r = await fetchJSON(backend() + '/host/scene-items?q=' + encodeURIComponent(q))
        if (!r.ok || !r.body || r.body.ok !== true) return []
        var out = []
        // [响应字段, section 名, ref 前缀, icon]
        var groups = [
          ['objects', '对象', 'object', 'file'],
          ['materials', '材质', 'material', 'file'],
          ['collections', '集合', 'collection', 'folder'],
        ]
        for (var g = 0; g < groups.length; g++) {
          var list = r.body[groups[g][0]]
          if (!list || typeof list.length !== 'number') continue
          for (var i = 0; i < list.length; i++) {
            var it = list[i]
            if (!it || !it.name) continue
            var name = String(it.name)
            out.push({
              name: name,
              label: name,
              description: groups[g][0] === 'objects' ? String(it.type || 'OBJECT') : groups[g][1],
              icon: groups[g][3],
              section: groups[g][1],
              value: groups[g][2] + ':' + name,
            })
          }
        }
        return out
      } catch (e) {
        return []
      }
    }

    /** 选中一个候选 → ReferenceInsert（契约 §2.5）。 */
    function onPickItem(pick) {
      var c = pick && pick.candidate ? pick.candidate : {}
      var ref = typeof c.value === 'string' && c.value ? c.value : String(c.name || '')
      var parts = splitRef(ref)
      return {
        insert: {
          source: 'blender',
          ref: ref,
          label: parts.name,
          appearance: 'file',
          clipboardText: '@' + parts.name,
        },
      }
    }

    /** ref ↔ 文本/剪贴板投影（契约 §2.5；`serialize` 是"@提及 → 模型文本"的正式通道）。 */
    var blenderCodec = {
      clipboardText: function (ref) {
        return '@' + splitRef(ref).name
      },
      serialize: function (ref) {
        var parts = splitRef(ref)
        return Promise.resolve(
          '<blender-' + parts.kind + '>' + parts.name + '</blender-' + parts.kind + '>',
        )
      },
    }
    //#endregion

    //#region 插件入口
    /**
     * 备用通道：由框架解析出的 `sessionId` 反查会话作用域 ctx，
     * 再取该会话的 `SessionInput`（有 `setDraft`/`addAttachments`/`notify`）。
     *
     * 出处（本机运行时）：`dsh-client-ui-conversation/lib/client.js:20515-20522`
     * 的 QueueDock 同款写法 —— `const actx = ctx.sessions.scope(sessionId)` →
     * `actx.get("conversation")` → `conversation.input.for(actx)`。
     * `ctx.sessions.scope(id)` 签名见
     * `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:212`。
     */
    function sessionFallback(ctx, sessionId) {
      var out = { blenderSessionId: sessionId, blenderInput: null }
      try {
        var sessions = serviceOf(ctx, 'sessions')
        var actx =
          sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
        if (actx && typeof actx.get === 'function') {
          var conversation = actx.get('conversation')
          if (conversation && conversation.input && typeof conversation.input.for === 'function') {
            out.blenderInput = conversation.input.for(actx)
          }
        }
      } catch (e) {
        out.blenderInput = null
      }
      return out
    }

    /**
     * cordis 插件入口。只 inject `slots`（面板必需，且是本机 coc-dice 验证过的写法）；
     * `inputTriggers` 用 `ctx.inject([...])` **懒等**，避免"输入触发器没挂载 ⇒ 面板也一起消失"。
     */
    /**
     * cordis 插件入口。只 inject `slots`；`inputTriggers` 用 `ctx.inject([...])` 懒等，
     * 避免"输入触发器没挂载 ⇒ 连原生选中桥也一起消失"。
     * v2.3：DSH 侧视口面板与 blender_rt_pick 已删除；这里只留 @ 提及源 + 原生选中桥。
     */
    function apply(ctx) {
      if (started) return
      started = true
      configuredBackend = resolveConfiguredBackend(ctx)

      var SelectionBridge = makeSelectionBridge()
      var SessionPanel = makeSessionPanel()
      var PanelTitle = makePanelTitle()
      var HeaderAction = makeHeaderAction(ctx)
      var SessionChip = makeSessionChip(ctx)
      var OverlayDrawer = makeOverlayDrawer()
      OVERLAY_PANEL = SessionPanel

      // ① @ 提及源（契约 §2.5）。inputTriggers 服务名见
      //    dsh-client-ui-input-trigger/lib/client.js:1526
      ctx.inject(['inputTriggers'], function (scope) {
        var triggers = typeof scope.get === 'function' ? scope.get('inputTriggers') : undefined
        if (!triggers || typeof triggers.registerSource !== 'function') return
        scope.effect(function () {
          return triggers.registerSource({
            trigger: '@',
            name: 'blender',
            candidates: function (session, req) {
              return sceneItemCandidates(req)
            },
            onPick: onPickItem,
            codec: blenderCodec,
          })
        }, 'dsh-blender-plugin: @ blender scene items')
      })

      // ② v2.3：Blender 原生选中 → 当前会话草稿（无头 dock；不渲染任何 UI）
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'blender-selection-bridge',
            order: 90,
            inject: function (sessionId) {
              return sessionFallback(ctx, sessionId)
            },
          },
          SelectionBridge,
        )
      })

      // ③ v3.4：主体进**会话视图右侧栏 tab**（会话视图的正式挂载点），输入框上方只留一行状态。
      //    tab 类型与 body/title 是两个阶段：先注册类型（`sidebarRightTabs`），再用类型的 id 注册
      //    两个 keyed 槽位（body 与 title 各自独立，不能只注册 body）。
      ctx.inject(['sidebarRightTabs'], function () {
        var tabs = serviceOf(ctx, 'sidebarRightTabs')
        if (!tabs || typeof tabs.register !== 'function') return
        ctx.effect(function () {
          return tabs.register({
            id: PANEL_TAB_ID,
            kind: PANEL_TAB_KIND,
            priority: 'extension',
            title: function () {
              return PANEL_TITLE
            },
          })
        }, 'dsh-blender-plugin: blender-session tab type')
        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: PANEL_TAB_ID,
              inject: function (sessionId) {
                return sessionFallback(ctx, sessionId)
              },
            },
            SessionPanel,
          )
        })
        ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab.title',
              key: PANEL_TAB_ID,
              inject: function (sessionId) {
                return sessionFallback(ctx, sessionId)
              },
            },
            PanelTitle,
          )
        })
      })

      // ④ 会话头部入口（有 pending 时带徽标数）；点它 openTab('blender-session')，
      //    右侧栏服务不可用时落 `shell.overlay` 抽屉。
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'blender-session-open',
            order: 20,
            inject: function (sessionId) {
              return sessionFallback(ctx, sessionId)
            },
          },
          HeaderAction,
        )
      })

      // ⑤ 输入框上方：一行极简状态（点它开面板）。卡片/认领表/策略都不在这里。
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'blender-session-chip',
            order: 80,
            inject: function (sessionId) {
              return sessionFallback(ctx, sessionId)
            },
          },
          SessionChip,
        )
      })

      // ⑥ 抽屉兜底（右侧栏不可用时才有内容；列表槽位，空白时不渲染）
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'blender-session-drawer',
            order: 40,
          },
          OverlayDrawer,
        )
      })

      // ④ 卸载时复位守卫（便于热重载 / 重新 apply）
      ctx.effect(function () {
        return function () {
          started = false
        }
      }, 'dsh-blender-plugin: reset apply guard')
    }

    var inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    // 仅供离线自检/探针断言纯函数（DSH 只读 apply/inject，未知导出无副作用）
    exports.__selftest = {
      DEFAULT_BACKEND: DEFAULT_BACKEND,
      LS_BACKEND_KEY: LS_BACKEND_KEY,
      splitRef: splitRef,
      onPickItem: onPickItem,
      blenderCodec: blenderCodec,
      sceneItemCandidates: sceneItemCandidates,
      stripTrailingSlashes: stripTrailingSlashes,
      // v2.3（Blender 原生选中 → DSH）
      SELECTION_POLL_MS: SELECTION_POLL_MS,
      SELECTION_DRAFT_NAME_LIMIT: SELECTION_DRAFT_NAME_LIMIT,
      SUB_DRAFT_INDEX_LIMIT: SUB_DRAFT_INDEX_LIMIT,
      selectionMessageText: selectionMessageText,
      subSelectionText: subSelectionText,
      applySelectionToDraft: applySelectionToDraft,
      notifyError: notifyError,
      makeSelectionBridge: makeSelectionBridge,
      // v3.3.1（Blender 会话面板）
      PANEL_POLL_BUSY_MS: PANEL_POLL_BUSY_MS,
      PANEL_POLL_IDLE_MS: PANEL_POLL_IDLE_MS,
      panelModel: panelModel,
      panelCard: panelCard,
      panelRow: panelRow,
      panelUrl: panelUrl,
      decideUrl: decideUrl,
      msLabel: msLabel,
      makeSessionPanel: makeSessionPanel,
      makePanelTitle: makePanelTitle,
      makeHeaderAction: makeHeaderAction,
      makeSessionChip: makeSessionChip,
      makeOverlayDrawer: makeOverlayDrawer,
      panelTree: panelTree,
      policyView: policyView,
      policyUrl: policyUrl,
      openPanel: openPanel,
      OVERLAY: OVERLAY,
      PANEL_TAB_ID: PANEL_TAB_ID,
      PANEL_TAB_KIND: PANEL_TAB_KIND,
      PANEL_OPEN_KEY: PANEL_OPEN_KEY,
      // v3.5（面板运维面：连接 / 通道 · 作业 · 诊断 · 设置）
      panelOpsModel: panelOpsModel,
      opsTree: opsTree,
      connectionLine: connectionLine,
      jobRowTree: jobRowTree,
      jobLogTree: jobLogTree,
      diagnosticsTree: diagnosticsTree,
      fetchOpsSnapshot: fetchOpsSnapshot,
      fetchDiagnostics: fetchDiagnostics,
      fetchJobLog: fetchJobLog,
      opsUrlState: opsUrlState,
      opsUrlHealth: opsUrlHealth,
      opsUrlJobs: opsUrlJobs,
      opsUrlJobLog: opsUrlJobLog,
      opsUrlStatus: opsUrlStatus,
      opsUrlDoctor: opsUrlDoctor,
      normalizeBackendOverride: normalizeBackendOverride,
      backendSource: backendSource,
      shortId: shortId,
      jobStatusLabel: jobStatusLabel,
      channelLabel: channelLabel,
      leaseLabel: leaseLabel,
      renderLabel: renderLabel,
      scopeLabel: scopeLabel,
      OPS_POLL_BUSY_MS: OPS_POLL_BUSY_MS,
      OPS_POLL_IDLE_MS: OPS_POLL_IDLE_MS,
      OPS_JOB_LIMIT: OPS_JOB_LIMIT,
      OPS_FEED: OPS_FEED,
      LS_OPS_POLL_KEY: LS_OPS_POLL_KEY,
    }
    return module.exports
  },
})
