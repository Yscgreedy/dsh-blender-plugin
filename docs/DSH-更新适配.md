# DSH 更新适配（当前插件 v3.2.0-alpha.1）

> 触发场景：DSH 升级（`npm i -g @deepseek-ai/dsh@<版本>`）之后，本插件的 6 个工具是否还在、行为是否变了。
> 结论依据：2026-09-23 对宿主 0.1.6-alpha.1 ↔ 0.1.7-alpha.2 的逐包 diff + 版本矩阵实测（**历史快照**）。
>
> **当前口径（2026-11-17）**：插件 **v3.2.0-alpha.1** · **6 个模型工具** · plan catalog **35 family / 261 op** ·
> addon **v2.0.0 / protocol 12**；验收仍以 `doctor` 回 `kind=ok` 为准。DSH 升级适配结论（§0–§4）不变，
> 具体工具数 / 目录数以当前仓库与 `blender_op(op="catalog")` 为准。

## 0. 一句话

**工具定义契约是安全的**（6 个工具在 `dsh-tools` 0.1.5-rc.2 / 0.1.6-alpha.1 / 0.1.6-alpha.2 /
0.1.7-alpha.1 / 0.1.7-alpha.2 五个版本下全部注册成功、0 报错、参数 schema 逐字节一致）。
真正要盯的是**四件与工具定义无关的事**：加载链、解析链、取消/超时、输出预算口径。

> 2026-10-28 复核（历史口径）：工具数当时为 **15**（v3.0.1；v3.1 起为 **6**），plan catalog 为 **34 family / 228 op**（v3.2 起 **35 / 261**）；上述四个风险点的结论不变。

## 1. 本插件在 DSH 里的三条链（先认清结构，再看风险）

| 链 | 现状 | 断了的症状 |
|---|---|---|
| **加载链** | **bundle 式（2026-09-23 起）**：插件列在 profile 的 `dsh.profile.bundles`，patch 层由本包 `cordis.patch.yml` 提供（邻位 coc-dice / session-list-cache 同批迁入）。`dsh-super-injector` 已卸载并删除 | 工具整体消失，但 Blender / 插件包都没坏；先用 `--dump-config` 看本包那一层在不在（§2） |
| **解析链** | `<插件>/node_modules/@deepseek-ai/dsh-tools` → `~/dsh-harness`（fake checkout 软链）→ `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools`（**全局安装**）；`cordis`/`schemastery`/`cosmokit`/`dsh-llm` 同理 | 载入期 `ERR_MODULE_NOT_FOUND`（不是降级，是整体消失）；换 npm prefix / nvm / pnpm global 就会触发 |
| **构建链** | `npm run build`（`scripts/build.mjs`）是唯一默认入口；旧 `scripts/build.sh` 只保留为可选的 `DSH_CHECKOUT` 依赖链接兼容入口，已标记 deprecated | 构建失败 / `tsc not found`；只有使用 `DSH_CHECKOUT` 时才需要旧 wrapper |

好处：解析链指向**全局安装本身**，所以插件的 `defineTool` 与宿主**永远同版本**（不存在"对着旧副本编译"）。
代价：没有冻结基线 —— 宿主怎么改，插件下一次载入就吃什么；所以下面的回归必须跑。

## 2. 更新后验收（三步，约 30 秒）

```bash
cd ~/DSH/dsh-blender-plugin
npm run test:dsh-api                    # ② 工具契约：6 工具 + 6 timeoutMs + 0 报错 + 前缀 [v3.2.0-alpha.1]
npm run test:dsh-api -- --version 0.1.7-alpha.2   # ③ 升级前预演：把待升级版本的 dsh-tools 拉下来先测
```

会话里再点一次 `blender_session(action="doctor")`：

```
诊断：…
宿主 API：dsh-tools@<当前版本> @ /usr/lib/node_modules/.../dsh-tools/lib/index.js   ← 自证（版本以本机为准）
插件：v3.2.0-alpha.1 @ /home/sixtyseven67/DSH/dsh-blender-plugin/lib/index.js
```

`宿主 API` 这行是**升级后第一时间要看的**：它证明"插件挂上了哪一份宿主 API"。
若工具整体消失，先跑装配预演：

```bash
dsh --profile web --dump-config | grep -A3 dsh-blender-plugin
```

有本包那一层 = 加载链没断（去查解析链 / 宿主 API）；没有 = profile 的 `dsh.profile.bundles` 被改过。
（`dev_plugin_status` / `dev_injected_list` 属于已删除的 super-injector，不再可用。）

## 3. 已知风险与状态

| 编号 | 风险 | 状态 |
|---|---|---|
| R1 | 曾只能靠 super-injector 注入：第三方 hook 吃宿主内部面（`loader.internal.loadCache`/`entry._dispose`），loader 一重构就可能整体消失 | **已解决**：2026-09-23 切到官方 bundle 装配并删除 super-injector（见 §4） |
| R2 | 解析链依赖全局安装的绝对路径；无冻结基线 | **已加自证**（`HOST_API` + doctor/status）；换安装位置仍需人工确认 |
| R3 | 宿主 `exec.signal` 未接、未声明 `timeoutMs` → 上游设默认截止时"Blender 还在跑、工具已判超时" | **已修**（当前 v3.2.0-alpha.1 仍成立：`EXEC_CTX` 贯通 + 6 个静态 `timeoutMs`） |
| R4 | 0.1.7 把 spill 口径从 `maxInlineBytes: 50000` 改成 `maxInlineTokens: 12500`，且图片会计入省略 → 大文本可能改为落盘 spill、长会话图片可能被省略 | **观察项**：升级后按 token 重新校准本插件自己的 12KB 截断阈值 |
| R5 | 新版 `plugin-manager` 按 `dsh.bundle` 判定 bundle | **已声明**（`package.json` + `cordis.patch.yml`），可切 §4 |
| R6 | 0.1.7 把官方 HMR 行 `cordis-plugin-hmr` 换成 `@deepseek-ai/dsh-hmr`、`dsh-settings-file` → `dsh-settings` | 本插件不依赖这些 id；injector 已删除 —— 代价是不再有第三方"运行时热注入"，改配置需重启（官方 HMR 行在 0.1.7 才启用） |
| R7 | `peerDependencies` 写的是裸名 `cordis`/`schemastery`（npm 上是另一条谱系），宿主用的是 `@deepseek-ai/*` | 现在走 **link 装配**（profile node_modules → 本目录 → 全局安装）→ 无影响；**改成 registry 安装**（`pnpm add`）前必须先解决，否则会引入第二份实现 |
| R8 | 图片回传失败被 `catch` 吞掉，纯文本结果无告警 | **已修**（当前 v3.2.0-alpha.1 仍成立：`{ref}`/`{why}` + `⚠ 图片未回传：<原因>`） |
| R9 | 6 个工具 + 超长中文描述全量进 prompt；新版 dsh-tools 已有 `deferLoading` | **优化项**：上游若默认延迟加载，需评估"描述即文档"策略 |

## 4. 装配方式：bundle 式（2026-09-23 已切换 + 迁移记录）

本机现状：插件列在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，patch 层由本包
`cordis.patch.yml` 提供；`dsh-super-injector` 已从 bundles / 依赖 / 状态目录 / 源码 / 分发产物里全部删除。

同批迁移的还有两个**原先只靠注入活着**的插件 —— 不迁就拆注入器会把它们一起弄丢：

| 插件 | 迁移前 | 迁移后 |
|---|---|---|
| `dsh-blender-plugin` | injector 注入（`ctx.loader.create` 挂 root） | profile bundle（本包 `cordis.patch.yml`） |
| `@dsh-external/dsh-coc-dice` | 同上 | profile bundle（该包 `cordis.patch.yml`）—— 仍是**宿主级**，掷骰工具对所有会话可见 |
| `@dsh-external/dsh-session-list-cache` | 同上 | profile bundle（该包 `cordis.patch.yml`） |

**必须重启 DSH 才真正生效**（重启前旧进程里仍留着注入器 entry 与注入式 fiber；重启后只按 bundles 装配）。
注意：重启前那个活着的注入器 fiber 会**自己重建** `~/.dsh/super-injector/` 里的统计/日志文件（它的定时写），
所以"删了又出现"是正常的 —— 重启后再删一次即可：

```bash
rm -rf ~/.dsh/super-injector   # 重启后执行；此后不会被重建
```
重启后自检：

```bash
dsh --profile web --dump-config | grep -A3 "dsh-blender-plugin\|dsh-coc-dice\|dsh-session-list-cache"
# 期望：三层各一行 insert；另外 grep super-injector 应无输出
```

**回滚**：把 `~/.dsh/profiles/web/package.json` 换回 `package.json.bak-injector-removal-<时间戳>`，
重装 super-injector，重启。

⚠ 不要同时用两种装配：两个 fiber 会**重复注册同名工具**（会话里看到两份同名工具）。

## 5. 每次 DSH 升级的固定动作（抄这段）

1. 升级前：`npm run test:dsh-api -- --version <目标版本>` → PASS 再升。
2. 升级时：**别用裸 `npm i -g @deepseek-ai/dsh`** —— `latest` 可能比现装版本**旧**（2026-09-23 历史快照曾出现）。
   升级前先用 `npm view @deepseek-ai/dsh dist-tags`（或项目文档的推荐版本）核对，再用显式版本 / `@alpha` 安装。
3. 升级后：§2 三步 + `dsh --profile web --dump-config | grep -c super-injector`（应为 0）
   + `blender_session(action="doctor")` 看 `宿主 API` 行。
4. 若 R4 生效（结果改为落盘 spill）：调 `docs/配置参考.md` 里记录的截断阈值，并复跑一次大型
   `blender_op(op="audit_scene")` 看输出形态。
## 6. 热更新（不重启 DSH）

> 2026-11-16 下游（BlenderProject）验收后定稿。前置事实：DSH desktop 自带 `@deepseek-ai/dsh-hmr`，
> 改 profile 的 `cordis.patch.yml` 会触发一次 profile 重组合 —— 把 profile 下**磁盘已变的已加载插件整代换掉**
> （拆旧 fiber → 拉新 fiber），宿主进程不动。插件 dispose 杀 Gateway 子进程，新 fiber 从磁盘重拉
> `lib/runtime/gateway.js`。于是有两条热更路径，插件要做的是把这件事做成**可自证**的。

### 6.1 边界表（`/status.hotReload` 的同一份内容）

| 改动 | 热更是否生效 | 备注 |
|---|---|---|
| `lib/runtime/**`、`.py` 内核、catalog/plan 表 | ✅ 重启 Gateway 即可 | 不碰宿主（`mode=gateway-restart`） |
| `lib/tools/**`、`lib/host/**`、`lib/plugin*.js`、`lib/constants.js`、`lib/contracts/**` | ✅ 宿主重组合 | 新工具名/参数建议刷新页面（`mode=hmr`） |
| `extension/**` | ⚠ Blender 侧 Reload Scripts | 与 DSH 无关 |
| `skills/**`、`docs/**` | ✅ 下次调用读盘 | — |
| **reload 的副作用（不是"改动"）** | ⚠ 会取消在跑作业 | **reload 会取消在跑作业**（headless / job 一律置 `canceled`）并停掉 virtual-gui 会话：长作业请避开热更窗口，或等 resume 能力；被取消的 id 在回执 `jobsDropped` 里，**重跑请重新 submit** |
| `package.json` 依赖、`cordis.patch.yml` 结构、宿主 dsh 版本 | ❌ 重启 | HMR 只报 pending |

### 6.2 两层自证：`/status.provenance.{runtime,host}`（H1）

`provenance` 是**两层**判定，任一层 stale 即顶层 `verdict=stale`，`staleLayer` 说清是哪层：

| 层 | 「已装载」的来源 | 谁写、什么时候 |
|---|---|---|
| `runtime` | Gateway 进程启动那一刻 `lib/runtime/**` 的逐文件哈希（`RUNTIME_SELF`） | Gateway 自己 |
| `host` | **宿主插件装载那一刻**的扫描结果（模块求值时抓的 `LOAD_SCAN`；环境变量 `DSH_BLENDER_HOST_MANIFEST` 指向的 JSON） | 宿主首次 `spawnChild` 之前落盘（`src/host/backend/host-manifest.ts`） |

清单的两条硬约束（2026-11-19 补，都是「假 noop」的成因）：

- **装载时定型，不是 spawn 时现扫**：扫描在 `host-manifest.ts` 模块求值那一刻完成，落盘只是把这份
  结果写出去。否则「镜像完成 → 首次 spawn 之前被中断」这一小段里，清单会把新磁盘记成「已装载」，
  下一次 reload 又是 noop（磁盘新代码、宿主旧代码，两边都自证 current）。
- **清单必须属于本安装**：文件名带宿主层根指纹（`host-manifest-<sha12(root)>.json`），且清单里的
  `root` 会与 Gateway 自己的 `<包根>/lib` 比对（`layers.sameRoot`）。不一致 → 宿主层
  `verdict=unknown`、`source` 不是 `manifest`，**不再冒充 current**。共享目录（`<workDir>/logs`
  或 OS tmpdir）里同时有仓库开发副本、另一个 profile 的安装副本时，这条是唯一的隔离。

`provenance.host` 的字段：

```json
{
  "source": "manifest",
  "verdict": "stale",
  "root": "<包根>/lib",
  "loadedAt": "2026-11-16T12:53:57.853Z",
  "loadedHash": "8c60b2f9e2ad",
  "currentHash": "f9ebc2aeb7d7",
  "loadedFileCount": 75,
  "fileCount": 75,
  "changedFiles": ["constants.js"],
  "changedCount": 1,
  "truncated": false,
  "note": "宿主层磁盘已变（1 个文件：constants.js）→ 本宿主 fiber 是旧一代（装载于 …）：只重启 Gateway 不会换掉宿主层，要 blender_session action=reload 触发热组合（或重启 DSH）"
}
```

- `source=manifest` 才是**可信**的「已装载」。清单由宿主 fiber 写，**fiber 不换清单就不换** ——
  所以「改 `lib/constants.js` → 只重启 Gateway」会**一直**报 `host.verdict=stale`，
  不会像旧实现那样一重启就自证成 current（那是把「Gateway 启动时扫的盘」当成了「宿主装载的那一代」）。
- `source=self` / `none` = **降级**（清单缺失：直接跑 `lib/runtime/gateway.js`、测试环境、隔离副本）。
  `note` 里会写明「降级」，宿主层判 `unknown` —— **不冒充 current**：Gateway 启动时的扫盘不是宿主
  fiber 的证据（fiber 可能更早装载）。要 current 只能让宿主写清单。
- `changedFiles` 是相对 `lib/` 的 posix 路径，≤20 条（超出看 `changedCount` / `truncated`）。
- 判定用**内容哈希**（`sha256:12`），不是 mtime：`touch` 不会造成假 stale，同尺寸改写也不会漏。

### 6.3 一步式 reload（H2）：两个面，一套回执

工具面 `blender_session(action="reload")` 与 HTTP 面 `POST /lease {action:"reload"}` 返回同构结构：

```json
{
  "ok": true,
  "mode": "noop | hmr | gateway-restart",
  "changed": { "host": [], "runtime": [], "other": [] },
  "changedCount": { "host": 0, "runtime": 0, "other": 0 },
  "pidBefore": 36460,
  "pidAfter": 36460,
  "verdict": "current",
  "staleLayer": [],
  "needsRestart": [],
  "jobsDropped": [],
  "stopped": [],
  "pending": false,
  "note": "…"
}
```

语义：

- `mode=noop`：两层都 current → **不动 pid**（不杀 Gateway、不写 profile patch）。
- `mode=hmr`：宿主层有变 → 只有宿主能重组合（写 profile 的 `cordis.patch.yml` 触发 HMR）；
  Gateway 面会返回 `pending=true` + `needsRestart[]` 说明为什么必须宿主出面。
- `mode=gateway-restart`：只有运行时层有变 → 重启 Gateway 子进程即可。
  **`pidAfter=null` + `pending=true` 是正常语义**（本进程报不出自己的后继 pid）：
  用 `GET /health` 的 `backend.pid`（或 `/status`）复核新 pid，再问一次 `provenance` 应变 `current`。
- `jobsDropped` / `stopped`（H5）：两条路径都**先 drain 再动进程**，所以回执里带得出"这一下收掉了什么" ——
  `jobsDropped` 是被置 `canceled` 的作业 id（**重跑 = 重新 submit**），`stopped` 是被停掉的会话 id；
  整份 drain 回执（`failed` / `exitScheduled` / `ms`）另外留在 `layers.drain`。
  `note` 会点名列 id（如"本次取消 1 个在跑作业（job-…），重跑请重新 submit"），
  没有可收的也说"drain 干净"，**绝不静默**：空数组 = 真的没有在跑作业，不是"没查"。

⚠ **裸 HTTP 调用的身份头**：`/lease` 的会话动作走 caller 身份校验，缺头直接 400
`caller_identity_required`。所以 `POST /lease` 带 `action:"reload"` 时必须同时给：

```
X-DSH-Host-Id: <宿主实例 id>
X-DSH-Session-Id: <DSH 会话 id>
X-DSH-Agent-Id: <agent id>
```

```powershell
# 复验（PowerShell）：身份头齐全才会执行
$h = @{ 'X-DSH-Host-Id'='local'; 'X-DSH-Session-Id'='probe'; 'X-DSH-Agent-Id'='probe' }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:39877/lease -Headers $h `
  -ContentType 'application/json' -Body '{"action":"reload"}'
# 或直接用工具面（宿主会带上真实身份）：
# blender_session(action="reload")
```

### 6.4 标准操作顺序

1. `npm run build`（runtime → host → client；只改 Python/catalog 时也走这一步，产物落在 `lib/`）。
2. 工具面 `blender_session(action="reload")` 或 `POST /lease{action:"reload"}`（带头）。
3. 看回执：`mode` 决定要不要重组合；`verdict` 应变 `current`，`staleLayer` 应为空。
4. `mode=gateway-restart` 时用 `GET /health` 复核 `backend.pid` 与 `provenance.verdict`。
5. 仍是 `stale`：`staleLayer` 含 `host` → `lib/tools/**`、`lib/host/**`、`lib/constants.js` 这类改动，
   HMR 没触发（profile 的 `cordis.patch.yml` 没变 / 重组合失败）→ 重启 DSH；
   `staleLayer` 含 `runtime` → Gateway 没被换掉（看护没拉起）→ 再 reload 一次或重启 DSH。

> 插件不替你改 profile：`reload` 只在**已经**由宿主/HMR 提供重组合通道时给出 `mode=hmr` 与原因；
> 触发 profile 重组合仍是宿主的动作（`@deepseek-ai/dsh-hmr` 监听 `cordis.patch.yml`）。

### 6.5 换代收尾（H4 / H5）：进程树、lost 作业、lastReload 读侧

热更 = 频繁 dispose/activate，任何泄漏都会累积成现场事故。换代前后各有一半，缺一半就会变成
「helper 越堆越多」或「/status 里一堆 running 僵尸」：

| 面 | 谁做 | 语义 |
|---|---|---|
| dispose 停进程 | 宿主 `killChildHandle()`（`src/host/backend/spawn.ts`） | **杀进程树**（win32 `taskkill /T /F`）：helper（`dsh-blender-hidden-desktop`）与它拉起的隐藏 Blender 是 Gateway 的孙进程，只 kill 父进程必留孤儿 |
| 优雅收尾 | 宿主 `drainGateway()`（`src/host/backend/drain.ts`） | 两条路径都**先** `POST /lease{action:"shutdown"}` → `sessionRegistry.disposeAll()` + `jobQueue.cancelAll()`，**然后**才动进程（运行时层杀进程树 / 宿主层写 patch 触发重组合）。回执 `stopped/failed/jobsDropped/exitScheduled` 原样进 `ReloadReport.layers.drain`，其中 `jobsDropped` / `stopped` 提升到 `ReloadReport` 顶层并写进 `note`（H5） |
| 作业对账 | Gateway 启动时 `JobQueue.restore()` | 上一个 Gateway 留下的 `assigned`/`running` → `failed(gateway_restart)` + **`lost:true`** + `lostReason`：id/参数保留、状态不再自称 running；要产物就用同一组参数重新 `submit`。`queued` 的作业**照旧入队**（reload 不会把排队的活排掉） |
| 运行台账 | Gateway 启动时 `ledger.reconcileLedger()` | pid 没了但磁盘有终态证据 → `recovered`；否则 `stale`（带 `staleReason` 与证据路径） |

读侧（以前只写不读，所以恒 `null`）：

- `/status.hotReload.lastReload` = `DSH_BLENDER_WORKDIR/state/last-reload.json`（没设 workDir 时
  `%TEMP%/dsh-blender-gateway/last-reload.json`）的原样投影：
  `{mode, pidBefore, pidAfter, startedAt, finishedAt, pending, verdict, changed:{host,runtime}, needsRestart, error, jobsDropped}`。
  两段式：旧宿主写 `pending:true` + `pidBefore`，新一代宿主 activate 时补 `pidAfter` / `verdict` ——
  HMR 之后 `pending` 应转 `false`、`verdict` 应转 `current`。
- `/status.jobsLost` = 队列里 `lost=true` 的作业（≤5 条，`{id, kind, state, finishedAt, lostReason}`）。
  进程随旧 Gateway 没了而记录还在：`/status` 自己说出来，调用者不必拿 `status=unknown` 猜。
- `lastReload.jobsDropped` = 这次 reload 取消掉的作业 id：换代之后（回执已经翻页）仍能从 `/status` 查到
  "我的作业去哪了"，不必去翻队列台账。

> 原始需求与验收记录：见 [CHANGELOG.md](../CHANGELOG.md) 的 v3.1.0-alpha.1 / v3.2.0-alpha.1（H1–H5 热更新）与 [docs/architecture.md](architecture.md)。
