# ARCHITECTURE.md — DSH × Blender 插件公理化设计（AD）审计

> **性质**：一次性架构审计报告（2026-11-27，基线 v3.3.0），不是规范文件，不替代 [docs/architecture.md](docs/architecture.md)。
> 规范仍以 `docs/architecture.md` / `AGENTS.md` 为准；本报告回答：**哪里耦合、为什么耦合、先拆哪一刀**。
> **范围**：全仓库（src / runtime TS / runtime/py / extension / config / tests / scripts）。
> **方法**：Nam P. Suh 公理化设计——FR–DP 映射、独立公理（三角化/破环）、信息公理（I 最小）、之字形分层。
> **证据**：结论均给 `文件:行`。标 ✅ 的是本报告亲自复核；标 ◐ 的来自分层审计（原始报告见 §8），未逐条重跑。
> **状态**：审计基线 = P0 前；**当前仓库状态 = `1ae237d`（P0 + P1-1a 已合并）**。§9 是动态状态页，路径映射/度量/验证以 §9 为准；§1–§8 保留审计基线（路径可按 §9.1 映射到当前布局）。

---

## 摘要

**一句话：调用主干是干净的解耦链；耦合全部集中在"状态、装配、契约副本"三类内脏——共 5 条结构性环 + 4 条缺陷型环，其中 1 条已经造成真实功能缺陷。**

| 维度 | 判定 | 关键证据 |
|---|---|---|
| 宿主 6 工具 | **解耦** | 工具之间零横向业务 import；唯一共享是 `src/tools/shared/session.ts` 与 `utils/frame-cache`（状态，见 D4） |
| DSH → Gateway → addon 主干 | **解耦（下三角）** | `src` 与 `runtime` 源码 **0** 条互相 import；HTTP 只消费 engine |
| runtime TS 值级导入图 | **DAG（0 环）** | 排除 215 条 `import type` 后 Tarjan SCC = 0 ◐ |
| runtime TS 类型级 | 6 个 barrel 环 | `engine-api`(8)、`dispatcher`(3)、`jobs/start`(3)、`shape-search`(3)、`engine`(3)、`http/host`(3) ◐ |
| `core` ↔ `execution` | **严重耦合（越层双向）** | core→execution 17 条、execution→core 45 条 ✅ |
| 写鉴权 | **严重耦合（双权威）** | `http/lease.ts:176-182` 把 registry 授权与 LEASE 串在同一函数；8+ 路由各带跳过规则 ◐ |
| 证据 ↔ 重载 | **严重耦合（跨进程控制回路）** | 宿主装载写清单 → 运行时读清单出 verdict → reload 以 verdict 为唯一判据 ✅ |
| Blender Python 五域 | **局部耦合（P1-1a 后）** | view/deliver 已端口化；剩余 `core→render`（calib/material）、`export→core`（gate）、`geometry↔assembly` ◐ |
| 契约/计数 | **分布式事实** | 只读清单 98 vs 104（**已腐坏**）✅；op 名 4 份；通道词表 3 份 ✅ |

**正式评级：Coupled（局部严重）**。运行时无环是优点，但仍不足以抵消"状态双权威 + 跨进程回路 + 功能 SCC + 已腐坏副本"这四件事。主干可以继续演进；每次触碰 `core`、`evidence`、`runtime/py`、写路由，都会产生"改一处、验五处"的回归税。

**P0（先破环，详见 [P0-REFACTOR-PLAN.md](P0-REFACTOR-PLAN.md)）**

| 编号 | 目标 | 一句话 |
|---|---|---|
| **P0-1** | 契约单源 + 可达性 | 修掉 98/104 只读缺陷；只读/车道/通道/路由字面量全部收敛或加门禁 |
| **P0-2** | `core` ↔ `execution` 分层 | 拆 `foundation`；生成路由表迁 `contracts/`；execution→core 45 → 0 |
| **P0-3** | 写鉴权单一权威 | LEASE 降为兼容适配器；会话解析 7 处 → 1 处；写门 fail-closed |
| **P0-4** | 证据/重载断环 | 分层快照显式入参；去 `globalThis` 代际；唯一 receipt/verdict 构造器 |

Python 五域断环（最大的一处）放在 **P1-1**：它需要"先有稳定基础层 + 契约单源"才可控，且当前有 80 条函数预算债务与硬守卫测试，P0 动它是赌博。

---

## 0 方法

### 0.1 判定规则

- **FR**：模型/用户可观察的能力。**DP**：承载它的物理实体（模块、类、生成表、配置键、HTTP 路由、Python 注册面）。
- **A_ij = X**（三者之一）：改 DP_j 会改变 FR_i 的**契约/回执格式**；改变 FR_i 依赖的**共享可变状态**；必须**同步修改** FR_i 的实现才能保持行为。
- **不计 X**：只读、无副作用、稳定的基础库调用（如 `foundation/json.ts` 的 `isRecord`）。
- **三角化**：允许基础 DP 在左下、界面 DP 在右上；若仍存在双向边或反馈回路 → Coupled。
- **信息量 I**：隐含前置条件、未声明调用顺序、同一事实副本数、配置自由度、跨进程握手点。
- **之字形**：系统层 FR0/DP0 → 逐 DP 下钻（§6），找耦合**最早被引入的层**。

### 0.2 统计口径（可复现）

| 指标 | 审计基线 | 当前（fbea0a3） | 口径 |
|---|---|---|---|
| TS 源文件 / 相对导入边 | 295 / 987 | **298 / 1000** | `src/**` + `runtime/**`，排除 `lib/`、`node_modules` |
| 值级 SCC / 类型级 SCC | 0 / 6 | **0 / 6** | 排除 `import type` 后为 0 ◐；含类型为 6 ✅（全是 barrel） |
| `execution → core` 反向边 | 45 | **0** | P0-2b 后 foundation/contracts 承接 |
| `foundation → core/execution` | — | **0 / 0** | §9 复核 |
| `core → execution` 正向边 | 17 | **16** | 编排依赖执行，方向正确 |
| `src` ↔ `runtime` 源码 import | 0 | **0** | 唯一跨界：`src/host/runtime-bridge.ts` → 编译产物 `lib/runtime/*.js` |
| Python import / 跨域 import | 940 / 0 | **940 / 0** | 守卫：`tests/unit/python/test_runtime_layout.py:128-177` |
| Python `K.<attr>` / 跨域 | 297 / 95 | **297 / 95**（P1-1a 只改 view/deliver 两条边，分域矩阵待重算） | ◐ python-audit 分域归属 |
| 模块 fan-in 前 5 | config 57、core/json 53（基线） | config **57**、foundation/json **53**、contracts/dynamic **50**、paths **32**、src/constants **27** | 直接 import |
| `DSH_*` 环境变量 | 46 | **46**（config.ts 独占 24 处读取） | 排除 vendored |
| 契约规模 | 6 / 38 / 270 / 45 / 44 / 25 / 29 / 12 | **不变** | `capability.lock.json`、`routing.json`、`modules.json` |
| 债务台账 | 函数预算 110、路径例外 17 | **110 / 17**（stale 0） | `config/*.json` |
| 测试面 | 299 | **308**（ts/mjs/py） | `tests/**` |

### 0.3 未做与 `[待核实]`

- 未运行 build / test / Blender；E2E 行为、Windows GUI、面板运行时均未实测。
- ◐ 标记的结论来自四个分层审计 agent（host/backend/python/boundary），已交叉核对的部分标 ✅；未复核的保留原证据路径。
- 浏览器面板 `src/client/index.js` 只做静态结构与端点统计。

---

## 1 系统级 FR 与 DP

### 1.1 FR0 → DP0

```
FR0：让 AI 在一次 DSH 会话内安全地驱动一台真实 Blender（看得到、改得动、验得了、可回滚）
DP0：宿主插件（6 工具） + 本机 Gateway（HTTP + addon WS） + Blender 扩展（25 命令） + Python 内核（44 模块）
```

顶层映射**不耦合**：三段进程边界清晰（宿主只走 HTTP；addon 只拨 Gateway；只有 addon 碰 bpy）。这是本仓库最强的设计资产。

### 1.2 FR（9 条）

| ID | FR | 观测面 | 证据 |
|---|---|---|---|
| FR1 | **会话取得与授权**：attach/claim/heartbeat/release；virtual-gui 需人类同意 | 会话型工具（op/py/see/run）的前置门 | `src/tools/shared/session.ts:144-166`；`sessions/registry.ts:318-560,629-760` |
| FR2 | **规划面解析与 op 调用**：38/270 可发现、可判定 needs_gui、可路由 GUI/本地无头 | `blender_op` | `catalog/data.ts`；`dispatcher/plan-call.ts:248-305`；`src/tools/op/local.ts:42-47` |
| FR3 | **GUI 内执行与观察**：会话内 Python、取帧、事务、worker 热内核 | `blender_py`/`blender_see`/`worker` | `src/tools/py/execute.ts`、`see/capture.ts`、`runtime/py/core/worker.py` |
| FR4 | **作业执行**：render/headless 提交、排队、执行、恢复、回收 | `blender_run` | `core/queue/manager.ts:74-323`、`execution/jobs/**` |
| FR5 | **证据与验收**：provenance/verdict/receipt，三态判定 | 所有返回值 | `runtime/foundation/evidence.ts`（`engineProvenance`）；回执构造 `src/tools/run/presenter.ts:228-306`、`op/local.ts:174-229`（`headless/receipts` 已无生产调用，见 §5） |
| FR6 | **装配与生命周期**：装载、Gateway 启停/热重载、显示、doctor | `blender_session action=doctor` | `src/plugin-lifecycle.ts`、`gateway/app.ts:87-170`、`runtime/foundation/layers.ts` |
| FR7 | **契约稳定**：6/38/270/25/29/12、单源、迁移门 | `test:contract` | `tests/unit/js/contract/single-source.test.ts`、`scripts/check-parity.mjs` |
| FR8 | **人类可见面**：Web 面板/TUI/卡片；可批准同意 | 右侧栏 tab + chip | `src/client/index.js`（3058 行）、`src/tui/**` |
| FR9 | **扩展命令执行**：25 命令在 bpy 内执行并回传 | `blender_inspect`/`/cmd` | `extension/.../command_registry.py`、`server.py` |

### 1.3 DP（12 个）

| ID | DP | 物理载体 | 规模 |
|---|---|---|---|
| A | **宿主工具面** | `src/plugin*.ts`、`src/tools/*`、`src/host/*` | 87 TS / 11.5k 行 |
| B | **HTTP 契约层** | `runtime/http/*`（router、29 路由、lease、session-gate、response） | 46 文件 |
| C | **会话域** | `runtime/core/sessions/*`（registry、consent*、presence、virtual-gui） | 9 文件；registry 1193 行 |
| D | **规划与目录** | `runtime/core/{dispatcher,catalog}`、`config/routing.json`、`runtime/contracts/routes.generated.ts` | dispatcher 5 + catalog 4 |
| E | **队列** | `core/queue/*`（manager、job-args、spawn-executor、handler） | 4 文件 / ~1.4k 行 |
| F | **执行** | `runtime/execution/*`（headless、jobs、workers、ledger、local-op、txn、preset） | 40+ 文件 |
| G | **传输 / Gateway** | `runtime/transport/*`、`runtime/gateway/*` | 10 文件 |
| H | **内核与证据** | `runtime/foundation/{kernel,scripts,output,json,evidence*,layers}` + `runtime/core/local-evidence.ts` | ~3k 行 |
| I | **Blender Python** | `runtime/py/{core,geometry,assembly,render,export}` + `modules.json` | 180 文件 / 44 模块 |
| J | **扩展** | `extension/dsh_blender_bridge/*` | 73 文件 / 7.2k 行 |
| K | **配置/路径/显示/启动** | `config.ts`(572)、`paths.ts`、`launch/*`、`display/*` | config fan-in 57 |
| L | **契约表与生成物** | `config/{contracts,routing,availability}.json`、3 套生成 schema、`capability.lock.json`、`scripts/gen-*` | 12 个 config 文件 |

### 1.4 维度检查

- **系统层**：9 FR / 12 DP。DP>FR 不是"过度分层"，而是**基础设施被多 FR 共享**（A/H/K 各支撑 5–9 条）。真正的问题：这些共享 DP 没有被声明为基础层（§3.2、§6.2）。
- **DP < FR（职责过度集中）** ✅：

| 模块 | 行数 | 承担的 FR | 证据 |
|---|---|---|---|
| `core/sessions/registry.ts` | **1193** | 归属/实例/租约/同意/授权/presence/selection/py 窗口/人编辑（9 子能力） | 48 public + 14 private 方法 ◐；`:118-1161` |
| `core/local-evidence.ts` | **817** | 端口扫描 + 5 种平台解析 + fixture + 误报 | `parseNetstat/Tasklist/Ps/Lsof/Ss`（`:159-231`） |
| `config.ts` | **572** | 平台探测/路径翻译/配置发现/Blender 发现/派生常量 | `:90-115,401,407,415,527` |
| `src/client/index.js` | **3058** | 面板+作业+同意+场景项+轮询+13 端点 | 197 function；**不在行预算门内**（`check-structure.mjs:295` 只收 `.ts`）✅ |
| `runtime/py/core/worker.py` | **1452** | exec/see/watch/checkpoint/digest/场景哈希（8 类职责） | 653 行是场景哈希（`:647-1300`）◐ |
| `runtime/py/render/view.py` | **1187** | 矩阵数学+PNG IO+视口+宿主 RPC | ◐ |
| `runtime/py/assembly/assembly_impl/repair.py` | **996** | 规划器+bpy 执行器+报告器 | ◐ |

- **DP > FR（透传/碎片）**：
  - `blender_session` 一个工具 7 文件（`index/execute/presenter/evidence-presenter/txn/txn-response/reload`），`txn-response.ts` 56 行仅形状转换。
  - 队列一条 FR 四层：`/job` 路由 → `JobSurface` → `JobQueue` → `SpawnJobExecutor`。
  - `PlanCallDeps` **40 个字段**（35 个 `ensure*` + 5），`kernel/api.ts` 40 个 ensure 工厂（`dispatcher/index.ts:2-43`）◐。
  - `src/headless/receipts/**` **≈648 行 / 0 条生产 FR**：只有 `plugin.ts:98-120` 的 `__internals` 与 1 个单测消费 ✅。

---

## 2 设计矩阵

### 2.1 系统级 FR–DP

图例：**X** 契约/状态耦合；**x** 条件/只读；**·** 无影响。

| FR ↓ / DP → | A 宿主 | B HTTP | C 会话 | D 规划 | E 队列 | F 执行 | G 传输 | H 内核证据 | I Python | J 扩展 | K 配置 | L 契约 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FR1 会话与授权 | X | X | X | · | · | · | X | x | · | · | X | · |
| FR2 规划与 op | X | X | · | X | · | x | · | x | X | · | · | X |
| FR3 GUI 执行/观察 | X | X | X | · | · | · | X | X | X | · | X | · |
| FR4 作业执行 | X | X | · | · | X | X | · | X | X | · | X | · |
| FR5 证据与验收 | X | x | x | X | x | x | · | X | X | · | X | X |
| FR6 装配/生命周期 | X | X | x | · | · | · | X | X | · | · | X | · |
| FR7 契约稳定 | X | X | · | X | · | · | · | · | X | X | · | X |
| FR8 人类可见面 | X | X | X | · | · | · | · | · | · | · | · | · |
| FR9 扩展命令 | X | X | · | x | · | · | X | · | · | X | · | x |

**读法**：X 共 32 格，A 列占 9 格——A 是"最后一公里"表面层，不是耦合源。真正的耦合在 C/D/E/F/H/I 内部（§3）。

### 2.2 X 的证据（摘要）

- **A**：6 工具注册 `src/tools/index.ts:11-23`；工具直接拼 HTTP body（`run/execute.ts:259`、`op/local.ts:129`）；编排 `src/plugin.ts:61-95`。
- **B**：29 路由唯一真源 `http/routes/index.ts:23-53`；写门 `http/session-gate.ts:33-50`；`/lease` 承载 **23 个动作**（`session/api.ts:354-427`）◐。
- **C**：写授权 `registry.ts:973-1027`；同意状态机 `:636-760`；presence `:906-940`。
- **D**：`routing.json` → `routes.generated.ts`（AUTO-GENERATED，`gen-routes.mjs`）；dispatch 三段 `plan-call.ts:291-305`；另有硬编码 if 链 `plan-dispatch.ts:101-124` ◐。
- **E**：`JobQueue` 持 `JobStore`+`JobExecutor`+容量+GPU 预留（`manager.ts:74-92`）；作业状态 **3 副本**（内存 / queue.json / 台账）◐。
- **F**：headless 子进程、worker 池、台账、local-op。
- **G**：`gatewayInstances(addon)` 被 6 处消费（`engine/lifecycle.ts:88,135`、`engine-api/doctor.ts:101,436`、`routes/health.ts:192`、`gateway/app.ts:98`）。
- **H**：注入 `runtime/foundation/kernel/api.ts`；provenance `runtime/foundation/evidence.ts`；层判定 `runtime/foundation/layers.ts`；宿主清单 `src/host/backend/host-manifest.ts`。
- **I**：五域 44 模块；内核命名空间 `K` 是真实连接面（§3.6）。
- **J**：`command_registry.py` 唯一命令真源；`server.py`（469 行）混合传输+分派 ◐。
- **K**：`config.ts` 五个 import 期求值点（`:117,401,407,415,527`）；`PATHS` 形状绑定 Blender 平台。
- **L**：`contracts.json` 38 family → Python 表；`capability.lock.json` 冻结核数；`check-parity.mjs` 还与 `b8778c8` 基线对拍。

### 2.3 语法依赖 ≠ 功能耦合（本仓库最重要的区分）

- **Python**：940 条 import 跨域 **0** 条，硬守卫（`test_runtime_layout.py:159-161`）。但功能层经 `K.*` 互达：`geometry→core 20`、`assembly→core 21`、`render→core 35`、`core→render 7`、`core→export 1`、`geometry↔assembly` 双向。**"域包互不 import"是装饰，不是解耦。**
- **TS**：`src` ↔ `runtime` 源码 0 条，但 `src/host/runtime-bridge.ts:8-50` 直接 import **7 个 `lib/runtime/*.js` 编译产物**。这是**构建顺序耦合**：先 build runtime，才能 typecheck/build host（`scripts/typecheck.mjs` 第一步即 `build.mjs runtime`）。

---

## 3 独立公理诊断

### 3.1 环清单（按严重度）

| # | 环 | 类型 | 证据（P0 前基线，路径映射见 §9.1） | 后果 | 现状 |
|---|---|---|---|---|---|
| **R1** | `core` ↔ `execution` | 包级双向 | core→execution 17 / execution→core 45 ✅ | 改内核/脚本必须重验作业；execution 难以单独测试 | **已断（P0-2b）**：execution→core **0**；正向 core→execution 16 |
| **R2** | 写鉴权双权威 | 状态 | `http/lease.ts:176-182` 的 `leaseGate` 内串联 registry 授权与 LEASE；各路由跳过规则不同 ◐ | 同一入口里两套权威串联；跳过条件是散落的布尔公式；registry 未装配时放行 | **部分（P0-3a）**：入口唯一 + fail-closed；跳过谓词仍在路由（P1 数据化） |
| **R3** | 证据 ↔ 重载 | 跨进程控制回路 | 清单写入 `host-manifest.ts:90-100` → 读取 `layers.ts` → verdict → reload ✅ | 唯一判据是被 reload 自己改写的事实；`unknown` 难以单测 | **已断（P0-4a）**：显式快照入参；`unknown` 可单测 |
| **R4** | Python 五域 | 功能 SCC | core↔render、core↔export、geometry↔assembly、（弱）core↔assembly ◐ | 不存在拓扑序；改一域语义波及证据/交付/形状 | **部分（P1-1a 已合并）**：view/deliver 端口化；剩余 export→core gate、core→render calib/material、geometry↔assembly |
| **R5** | 会话 ⇄ 热更 ⇄ 生命周期 | 状态（两代写） | `session/reload.ts` → `hostReload` → `plugin-lifecycle.ts` → settle ◐ | 同一 reload 状态被两代 fiber 写 | **已断（P0-4b）**：`reloadOnce` 单入口；`globalThis` 探针收敛保留 |
| **D1** | **只读判定已腐坏** | 契约副本 | 宿主 98 vs catalog 104；缺 6 个；声称的 parity 测试不存在 ✅ | 6 个只读 op 无会话时被判 `session_required` | **已修复（P0-1a）**：104 + parity 门 |
| **D2** | op 可达性双向破洞 | 契约 | routing-only exact op；空前缀 catch-all 抢名 ◐ | 广告出来不可达 / 可路由但不可发现 | **已加 ratchet（P0-1d）**：exact op 可发现、catch-all 唯一且表尾、重名只允许 `help` |
| **D3** | 本地车道 ↔ 作业回执 | 契约 | `op/local.ts` vs `run/execute.ts` 各懂一半 `/job` ◐ | 改 submit 语义要同改两处 | **部分（P0-1c）**：白名单单源；`/job` payload 构造仍两处 |
| **D4** | py 抓帧 ↔ see 取帧 | 共享状态 | `py/frame.ts` → `frame-cache.ts` ← `see/capture.ts`；键含/不含 caller 不对称 ◐ | 去重判据互相影响 | **仍存在**（P1） |
| **D5** | 通道词表 3 副本 | 契约 | TS 两处 + Python 一处 ✅ | 增删通道要同步三处 | **已加 parity 门（P0-1f）**，生成化 P1 |

**文件级/类型级不算环**：6 个类型级 SCC 全是 barrel 与成员互指（`import type`），编译后消失；值级图是 DAG。它们的问题是**认知宿主**（改 deps 字段波及 7 个文件），不是运行期耦合。

### 3.2 R1：core ↔ execution（双向越层）

**链路（已核验）**

```
core/queue/job-args.ts:5-10        → execution/{input-paths,local-op,render-channels,render-device}
core/queue/spawn-executor.ts:8-10  → execution/{render-channels,render-device}
core/engine/assemble.ts:13-21      → execution/{ledger,trajectory,jobs,workers,txn,preset,headless}
execution/**                       → core/{evidence,json,output,progress,kernel,scripts,errors}  （45 条）
execution/local-op/table.ts:1-9    → core/dispatcher/{routes.generated,plan-call}
```

**根因**：`core` 同时是**基础层**（json/output/progress/evidence/kernel/scripts）与**编排层**（queue/sessions/dispatcher/engine）。execution 依赖前者，core/queue 与 core/engine 又依赖 execution——角色混装，环即出现。

**风险（具体）**
- 改 `runtime/foundation/kernel/api.ts` 注入格式 → 重验 `execution/jobs/script/*`、`headless/script.ts`、`workers/*`、`core/queue/job-args.ts`。
- 改 `execution/render-channels.ts` CHANNELS 标记 → 触及 `core/queue/spawn-executor.ts:8`、`src/tools/run/execute.ts:44`、`runtime/py/render/channels_impl/metrics.py:23`（D5）。
- 单独测试 execution 不可能：45 条 import 里 20+ 指向 core 具体文件。

**断环（已执行）**：拆 `foundation`；`routes.generated`、`routeMatches` 与 `local-op/names.ts` 迁 `runtime/contracts/`。结果：**execution→core 0**；`core→execution` 16 条为正向（queue/engine 依赖执行），方向正确。P0-2b 完成。

### 3.3 R2：写鉴权双权威

- `http/lease.ts:176-182` 的 `leaseGate` 先调 `sessionWriteGate`（registry 授权），再走进程级 `LEASE`（holder/token/ttl/scope）——两套权威在同一入口串联，谁先谁后写死在函数体里。
- 各写路由的跳过规则各不相同：`act.ts:149`（`isPy && caller` 跳过 leaseGate）、`plan.ts:76` / `job.ts:52` / `loop.ts:17` / `opt.ts:17` / `perf.ts:17` / `txn.ts:19` / `preset.ts:19`（`isReadOnly` 跳过）、`worker.ts:125`（`isolated` 跳过）、`commands.ts:48`（无条件）◐。
- `session-gate.ts:13-21,39` 用模块级 `REGISTRY`，未设置时**返回 null（放行）**——fail-open ✅。

**风险**：新增写路由时复制哪一套都能"看起来工作"；顺序错时表现为 `wait_ms` 永不生效（`act.ts:143-146` 注释自述）◐；未装配窗口内授权可绕过。

**断环**：唯一 `WriteAuthority` 端口（registry 为权威，LEASE 降级适配器），路由只调一次、顺序固定、未装配即失败关闭。P0-3。

### 3.4 R3：证据 ↔ 重载（跨进程反馈）

```
宿主装载  host-manifest.ts:90-100        写 manifest（globalThis 代际 :73-80）
运行时    foundation/layers.ts          读 manifest + 扫 lib/
合成      foundation/evidence-host.ts    current/stale/unknown
判定      reload/index.ts:77-82     reload 后"换干净没有"只看这个 verdict
再装载    host 重启 → 重写 manifest …
```

**风险**：verdict 的输入被 reload 自己改写；`unknown` 分支让 doctor 与回执同时降级且难以构造；`DSH_BLENDER_HOST_MANIFEST` 是隐式环境契约，Gateway 单独启动即 unknown；`globalThis.__dshBlenderHostManifestGeneration` 跨测试串味 ✅。

**断环**：`engineProvenance({layers})` 显式入参；清单作为启动事实传入；reload 报告做纯函数 `compare(before, after)`；删除 `globalThis`。P0-4。

### 3.5 R5 + D3：宿主内部的状态环

- **R5**：reload 状态被 `writeReloadState`（`host/reload/index.ts:329-342`）与 `settleReloadState`（`:419-431`）两代写；`plugin-lifecycle.ts:27-38` 在新 fiber 收尾；"第几代"靠 `host-manifest.ts:73-77` 的 `globalThis` 探针 ◐。**注意**：该探针是 HMR 下"模块是否被重新求值"的唯一判据，P0 只做收敛（单点 + 测试重置），不做删除。
- **D3**：`op/local.ts` 与 `run/execute.ts` 各懂一半 `/job` 语义（提交键、file/workspace/outdir），无共享客户端。
- **D4**：frame-cache 键空间不对称（`py-see:<agent>:<size>` vs `see:current:<w>x<h>`），去重判据互相影响 ◐。

### 3.6 R4：Python 五域功能 SCC

| from ↓ / to → | core | geometry | assembly | render | export |
|---|---|---|---|---|---|
| core | 116 | 0 | 3 | **7** | **1** |
| geometry | **20** | 23 | 0 | 2 | 0 |
| assembly | **21** | **1** | 10 | 0 | 0 |
| render | **35** | 0 | 0 | 38 | 0 |
| export | **5** | 0 | 0 | 0 | 15 |

**强 2-环**：core↔render（`contract_impl/fingerprint.py:136` ↔ `render/qc_render_impl/common.py:44`、`calib.py:366-368`）；core↔export（`gate_impl/api.py:95-101` ↔ `deliver_impl/export.py:42-46`）；geometry↔assembly（`shapegen.py:161,171,181` ↔ `repair.py:493-501`）。

**根因**：`kit.install_kernel` 把每个模块挂成 `K.dsh_<name>_api`（`core/kit.py:187-200`）。语法解耦由测试守卫，功能耦合被搬进命名空间——**"模块解耦"换成了"命名空间耦合"**。

**风险**：改 `view.capture` spec → 改 `contract.evidence` 证据格式；改 `gate_deliver` 默认值 → 同时改门与交付；改 shapegen op 名 → geometry 与 vehicle 两侧同时断。这一层也是最热的：110 条函数预算债务里 **80** 条在 `runtime/py`。

### 3.7 D1/D2/D5：契约副本与可达性

- **D1（真实缺陷）**：`src/tools/op/read-only.ts` 98 项 vs `runtime/catalog/data.ts:633-740` 104 项；缺 6 个；`op-read-only-parity.test.ts` 不存在；真实门 `op-contract.test.ts:107` 只比 data↔baseline ✅。
- **D2**：`routing.json:196-254` 的 `shape_solve`/`model_deliver` 不在 catalog；catalog 的 `montage.help` 会落到空前缀 `ext-contract`（`routing.json` 表尾）◐。
- **D5**：通道词表 3 份：`src/tools/run/execute.ts:44`、`runtime/execution/render-channels.ts:18`、`runtime/py/render/channels_impl/metrics.py:23` ✅。
- 另（P0 前）：local-op 白名单 2 份（`src/tools/op/local.ts` ↔ `runtime/execution/local-op/names.ts`）；P0-1c 后已收敛为 `config/local-ops.json` 生成的两份常量（§9.3）。

### 3.8 重排结果与安全修改顺序

**可三角化**（自底向上）：

| 层 | 内容 |
|---|---|
| L0 | `config.ts`/`paths.ts`/`ports.ts`/`blender-detect.ts`/`win_proc.ts` |
| L1 | `transport/*`（叶子）、`catalog/{data,tools,commands,logic}` |
| L2 | `foundation/{json,errors,scripts}`、`core/flags` |
| L3 | `foundation/output/*`、`foundation/evidence*`、`foundation/layers`、`core/local-evidence`、`core/availability*` |
| L4 | `foundation/kernel/*`、`display/*`、`execution/*` |
| L5 | `core/queue/*`、`core/sessions/*`、`launch/*` |
| L6 | `core/engine/*`（装配根）、`engine-api/*`、`dispatcher/*`、`plan/*` |
| L7 | `http/*` |
| L8 | `gateway/*`、`engine.ts`（门面） |

**禁止方向**：L7→L6 之外的任何反向（当前 core→http = 0，已守住）。**唯一例外**：装配根允许依赖 L0–L5。

**维护者在现有结构下的安全修改顺序**：
1. 配置/路径 → 2. 内核与证据 → 3. 执行 → 4. 队列 → 5. HTTP → 6. 宿主工具 → 7. 面板/TUI
8. 契约类改动单独成刀：`routing.json`/catalog → `gen-routes` → Python 表 → `capability.lock` → 文档计数

### 3.9 正式评级

**当前评级：Decoupled（主干）/ Coupled（局部）**

- **已消除**：R1（foundation 分层）、R3（显式快照）、R5（reloadOnce）、D1（只读 104 + 门）、D2/D5（ratchet/parity 门）。
- **仍 Coupled**：R2 的跳过谓词仍散落在各路由；R4 剩 `export→core` gate、`core→render` calib/material、`geometry↔assembly`；D3/D4 未收口。
- **结论**：P0 前判定的四条结构环里 R1/R3/R5 已断；R4 的 view/deliver 两条边已在 P1-1a 端口化，剩余三处属 P1-1b/1c。主干可继续演进。

---

## 4 信息公理审计

### 4.1 系统级热点

| # | 坏味道 | 证据 | 为何提高 I | 量化 |
|---|---|---|---|---|
| I1 | **配置是"环境推导的全局常量"** | `config.ts:117,401,407,415,527` 全在 import 期求值；`CONFIG_FILES:90-115` 三处候选取第一个存在 | 取值依赖环境+文件存在性+导入时机；部分配置整份遮蔽另一份 | 46 个 `DSH_*`、24 处 env、`CFG` ~25 键、fan-in **57** |
| I2 | **同意策略 5 源 + 2 套词表** | `consent-policy.ts:1-25,28-30,65-69,77` | 人类与模型看到两套词汇；改一处要同步映射/缓存/面板 | 4 读取源 + 1 缓存 + 1 测试重置钩子 |
| I3 | **构建顺序耦合** | `src/host/runtime-bridge.ts:8-50` 引 `lib/runtime/*.js`；`typecheck` 先 build runtime | "源码正确"≠"能编译"；导出签名变化延迟到 host 构建才爆 | 7 个模块、8+ 导出按产物路径消费 |
| I4 | **路由字面量无门禁** | 工具 `'/job'`(`run/execute.ts:259`)、`'/lease'`(`shared/session.ts:36`)；客户端 13 端点；`CONTRACT_ROUTES` 29 条 | 契约存在但消费者不受约束 | 29 路由 vs 2 套手写消费面；`check-routes` 只查生成表 |
| I5 | **回执/判定五个口径** | 派生 `op/plan-response.ts:186-189`、`envelope.ts:127-137`；硬编码 `op/local.ts:174-186,222-229`；透传 `session/execute.ts:204`；展示 `run/presenter.ts:151-154` ◐；`receipt.v2` 手写 6 处 | "degraded≠pass"没有单一载体 | 5 口径 + 6 手写 + ≈648 行 receipts 零生产调用 ✅ |
| I6 | **会话/身份 7 处解析** | 正确入口 `shared/session.ts:144-166`；另 6 处自解（`session/execute.ts:150-174,254-265`、`op/execute.ts:59-67`、`op/local.ts:267-275`、`see/index.ts:89-91`、`run/execute.ts:384-386`）◐ | 每处各有一套"什么算 ready" | 7 处 / 2 套身份源；`see/index.ts:90` 丢弃 failure |
| I7 | **全局可变单例** | `session-gate.ts:13`（P0 后已删）、`host-manifest.ts:73-80`、`consent-policy.ts:77`、`config.ts:117` 等 | 初始化顺序成为隐含前置 | 17 个可变模块级容器 ◐；4 个重点复核 ✅ |
| I8 | **作业状态 3 副本 + 389 行对账** | 内存 `manager.ts:81`、`queue.json`、`ledger/index.jsonl`；`ledger/recover.ts:139-260` ◐ | 三处可能漂移，恢复语义只在注释 | 3 副本 + 1 对账器 |
| I9 | **渲染旗标 4 跳字符串契约** | `render-state.ts:23-24` → `assemble.ts:39,52` → `kernel/api.ts:439` → `render_guard.py:45`；回退路径两侧不一致（`render_guard.py:52` vs TS）◐ | 契约是"Python 全局变量名"，无类型无对拍 | 4 跳 / 1 字符串名 / 2 个不一致回退 |
| I10 | **装配期可变袋** | `engine/assemble.ts:48,69-88` 8 次 `Object.assign`；12 文件 29 处 `as unknown as` ◐ | 初始化顺序隐含在语句顺序；类型系统被双重强转绕过 | 8 突变点 / 29 强转 |
| I11 | **死代码与死接口** | `headless/receipts/**` ≈648 行 0 生产调用 ✅；`ADDRESS` 零消费者 ◐；`runtime/classes.ts:176` 的"38 个能力族"不在 `sync_counts` 正则内 ◐；6 个死导出、8/15 死常量 ◐ | 阅读者难以区分"契约"与"遗物" | ≈648 行 + 6 导出 + 8 常量 |
| I12 | **债务台账本身是信号** | `function-budget-allowlist.json` 110 条（py 80）；`exceptions.json` 17 条 | 80–120 行函数 = 多职责未拆的代理指标 | 110 + 17 |

### 4.2 分层明细（原始报告）

- **Host**：会话/身份 7 处、verdict 5 口径、路径绝对化 3 份、reload 6 条未声明顺序、7 组进程级单例（2 组跨代）◐。
- **Backend**：写门 4 种顺序、作业 3 副本、渲染旗标 4 跳、17 个可变单例、`/lease` 23 动作 ◐。
- **Python**：preload 83 处提示、17 处软缺失降级、10/45 路由无 preload、13/44 模块从不 preload；`scale_length` 71 处、`select_set` 40 / `active=` 26 / `mode_set` 13 / `context.mode` 读 1；`def _kernel()` 18 份；`Api.__call__` 与 `dispatch` 两套返回契约 ◐。
- **扩展**：gate 属性名 17 处书写 / 5 个事实；只读名单 3 份（104/98/104）；`2.0.0` 8 处；新增 1 个 op = 3 必改 + 2 条件 + 5 步隐含顺序 ◐。

---

## 5 维度失衡与职责集中

（§1.4 已给表，结论）

- **五处"内脏肥大"**：sessions/registry、local-evidence、config、client bundle、worker.py。它们各自把 3–9 条 FR 塞进一个 DP，是 R2/R4/R5 的**共同物理载体**。
- **三处"透传"**：工具 presenter 链、队列四层、`PlanCallDeps` 40 字段。透传本身不是错，错在**装配点成为变更热点**。
- **一处"死质量"**：`headless/receipts` ≈648 行无生产调用——它曾经是回执的唯一实现，现在只剩测试接缝；要么接入，要么删除。
- **值得保留的冗余**：三态 verdict 的多层组装（Python 判定 → TS 归一 → 宿主回执）在信息公理上"贵"，但它是验收语义的护城河；P0 不合并三态，只合并**形状**（I5）。

---

## 6 之字形分层诊断

### 6.1 L1 宿主（DP-A）

- 6 工具互相独立；唯一共享 `shared/session.ts` 与 `frame-cache`（状态而非实现）。
- 最早引入点：`src/host/runtime-bridge.ts:8-50`（构建前置）与 `host-manifest.ts:73-100`（装载期副作用）。
- `contracts/tool.ts:9 → ui/cards.ts`、`headless/receipts/envelope.ts:4-5 → ui/cards + tools/errors`：**契约层反向依赖 UI**（结构反转）◐。

### 6.2 L2 HTTP/Gateway（DP-B/G）

- 29 路由单源、顺序即契约——良好。
- `session-gate` 模块全局（fail-open）、`gateway/app.ts:5` import 公开门面 `../engine.js`（与 `runtime/engine.ts:1-5` 自述"内部不穿门面"矛盾）✅。
- 最早引入点：`http/session-gate.ts` + `gateway/app.ts`。

### 6.3 L3 会话（DP-C）

- 1193 行 / 48 public / 9 子能力；就绪双源（快照 + 回调）、`refreshInstances` 无调用方 ✅。
- 同意与 presence 被并入 registry（`:629-760,906-940`）。
- 最早引入点：consent/presence 合并进 registry 的那次演进。

### 6.4 L4 规划/目录（DP-D/L）

- `routing.json → routes.generated` 是好设计；坏在装配接口（40 字段）与 op 名 4 份。
- `plan-dispatch.ts:101-124` 的硬编码 if 链与生成表并存 → 同一 op 去向取决于两机制先后 ◐。
- 最早引入点：`PlanCallDeps` 手写依赖注入 + `plan-dispatch` 历史旁路。

### 6.5 L5 队列/执行（DP-E/F）

- 队列职责清晰；坏在 `job-args/spawn-executor` 反向依赖 execution 渠道模块，`local-op/table` 反向依赖 dispatcher。
- 最早引入点：把 `render-channels/render-device/local-op` 放进 execution 却让 core/queue 直接消费。

### 6.6 L6 Python（DP-I）

- 域包互不 import；`kit.install_kernel` 的 `setattr(K, "dsh_%s_api")`（`core/kit.py:187-200`）把解耦换成命名空间耦合。
- 最早引入点：**这一行**。

### 6.7 L7 扩展（DP-J）

- `command_registry.py` 唯一真源；`server.py`（469 行）混合传输+分派；`config.py` 反向依赖 server ◐；命令 gate 改名后静默消失（`server.py:446,457`）◐。

### 6.8 结论：耦合最早出现在**两个便利设施**

1. **内核命名空间** `K.dsh_*_api`（Python 全域）；
2. **手写装配 + 模块级单例**（TS：`session-gate`、`PlanCallDeps`、`Object.assign` 袋、`globalThis` 代际）。

业务域（几何/装配/渲染/导出）与工具面本身是干净的。**这决定了 P0 的形状：先修装配与契约，不动业务算法。**

---

## 7 重构后预期矩阵与度量

目标不是"全对角"，而是**块下三角 + 0 反向边**。

```
                  foundation(H')   execution(F)   queue(E)   http(B)   host(A)
FR4 作业              X              X              X          X         X
FR3 GUI 执行          X              X              ·          X         X
FR2 规划              X              ·              x          X         X
FR1 会话              X              ·              ·          X         X
FR5 证据              X              X              ·          x         X
FR6 生命周期          X              ·              ·          X         X
FR7 契约              X              ·              ·          X         X
```

（列按"基础→表面"排序；上三角只剩 §3.7 的契约多副本，由 P0-1 消除。）

| 度量 | 审计基线 | 当前（fbea0a3） | 验证方式 |
|---|---|---|---|
| `execution → core` 边 | 45 | **0** | 重跑 §0.2 导入图 |
| `core → execution` 边 | 17 | **16（正向，保留）** | 同上；只断言方向 |
| execution → dispatcher 边 | 2 | **0** | 同上 |
| 写门变体（gate/skip 组合） | ≥5 | **1 入口 + fail-closed；skip 谓词仍分散**（P1） | 路由仿真 + `write-authority.test.ts` |
| 会话解析点 | 7 | **1 链（`resolveSession`）** | `session-ref.test.ts` |
| 只读清单副本 | 2（98 vs 104） | **2（104/104）+ parity 门**（生成化 P1） | `op-read-only-parity.test.ts` |
| 通道词表副本 | 3 | **3 + parity 门**（生成化 P1） | `channel-vocabulary.test.ts` |
| verdict 口径 | 5 | **1 构造器（TS 侧）** | `receipt-constructor.test.ts` |
| `receipt.v2` 手写 | 6 | **1** | `rg "receipt.v2" src` |
| 可变模块单例 | 17 | **16**（session-gate 移除） | 静态扫描 |
| `globalThis` 代际 | 2 键 | **2 键（收敛保留）** | 只在 `host-manifest.ts` |
| Python 跨域 `K` 引用 | 95 | **95（分域矩阵待重算；view/deliver 字面已归零）** | python-audit 脚本 |
| TS 文件 / 相对边 | 295 / 987 | **298 / 1000** | §0.2 口径 |
| 类型级 SCC | 6 | **6（全 barrel）** | Tarjan |

（矩阵图为 P0 前的目标形态；当前实际列顺序：foundation → execution → queue/http → host，已满足块下三角。）

---

## 8 附录：证据与分层原始报告

**分层审计（本报告输入，保留可追溯性）**

| 层 | 报告 | 规模 |
|---|---|---|
| Host（src/） | `.audit/task-1-host-layer.md` | 27763 B |
| Backend（runtime TS） | `.audit/task-2-backend-runtime.md` | 32541 B |
| Python（runtime/py） | `.audit/task-3-python-domains.md` | 31078 B |
| 扩展与跨边界 | `.audit/task-4-extension-boundary.md` | 33539 B |

> 这些是本地审计产物：`.audit/` 与 `.review-tmp/` 均已由 `.gitignore` 忽略，不随提交/发布。

**复现统计**

```text
# 导入图 + SCC：Node 直接解析相对导入（当前 298 个 TS 文件 / 1000 条边）
# 值级 SCC（排除 import type）= 0；类型级 SCC = 6（全是 barrel）
# env / 副本计数：grep + 逐文件行数（node 统计，非 PowerShell Measure-Object）
```


---

## 9 当前状态（动态页）

> **最后核对**：2026-11-27，HEAD `1ae237d`（P0 + P1-1a 已合并）；工作区干净。
> 本节是唯一“当前事实”页；§1–§8 保留审计基线，路径按 §9.1 映射到当前布局。

### 9.0 现在是什么状态

- **已合并（P0）**：foundation 分层、契约单源、写门单入口 + fail-closed、SessionRef 收口、证据显式快照、reloadOnce、唯一 receipt。
- **已合并（P1-1a，`1ae237d`）**：`view_capture` / `deliver_export` / `deliver_verify` 端口化；`runtime/py/core` 全域 `dsh_view_api` / `dsh_deliver_api` 字面 **0**；`modules.json` 仍 44。
- **仍未断**：`export → core` 的 `dsh_gate_api`（`require_gate` 路径）、`core → render` 的 `calib/material` 字面、`geometry ↔ assembly`。
- **下一刀候选**：把 export 的门调用也倒置成 `gate_run` 端口（去掉 `{core, export}` 的最后一环），再做 `geometry ↔ assembly` 的产品归属决策。

### 9.1 路径映射（审计基线 → 当前）

| 基线路径 | 当前路径 | 说明 |
|---|---|---|
| `runtime/core/json.ts` | `runtime/foundation/json.ts` | P0-2b |
| `runtime/core/errors.ts` · `progress.ts` · `scripts.ts` | `runtime/foundation/*` | P0-2b |
| `runtime/core/output/**` | `runtime/foundation/output/**` | P0-2b |
| `runtime/core/kernel/**` | `runtime/foundation/kernel/**` | P0-2b |
| `runtime/core/evidence*.ts` | `runtime/foundation/evidence*.ts` | P0-2b |
| `runtime/core/layers.ts` | `runtime/foundation/layers.ts` | P0-2b |
| `runtime/core/dispatcher/routes.generated.ts` | `runtime/contracts/routes.generated.ts` | P0-2a |
| `runtime/core/dispatcher/plan-call.ts` 的 `routeMatches` | `runtime/contracts/route-match.ts` | P0-2a |
| `runtime/execution/local-op/names.ts` | `runtime/contracts/local-lane.ts`（生成） | P0-1c |
| —（新增） | `src/contracts/local-lane.ts`（生成） | 宿主副本 |
| —（新增） | `src/tools/receipt.ts` | 唯一 verdict/receipt 构造器 |
| —（新增） | `config/local-ops.json` + `scripts/gen-local-ops.mjs` | 车道单源 |
| `runtime/core/local-evidence.ts` | **未迁移**（仍在 core） | 只有 http/health 消费，且有 file-budget 例外 |

### 9.2 当前度量（复核于 fbea0a3）

- **TS**：298 文件 / 1000 相对边；类型级 SCC **6**（全是 barrel：engine-api、dispatcher、jobs/start、shape-search、engine、http/host）；值级环 0。
- **跨层**：`execution → core` **0**；`foundation → core` **0**；`foundation → execution` **0**；`core → execution` **16**（正向，编排依赖执行）。
- **fan-in 前 5**：`runtime/config.ts` 57、`foundation/json.ts` 53、`src/contracts/dynamic.ts` 50、`runtime/paths.ts` 32、`src/constants.ts` 27。
- **行数热点**：`core/sessions/registry.ts` 1193、`config.ts` 572、`foundation/layers.ts` 578、`foundation/kernel/api.ts` 519、`foundation/evidence.ts` 388、`src/client/index.js` 3058。
- **契约**：6 工具 / 38 family / 270 op / 45 路由行 / 44 Python 模块 / 25 addon 命令 / 29 HTTP 路由 / protocol 12（未变）。
- **债务**：函数预算 110 条（stale 0）、路径例外 17 条。
- **Python**：跨域 import 0；`K.<attr>` 297 / 跨域 95（分域矩阵待重算）；view/deliver 直取已归零；`modules.json` 44。
- **Python 功能图（端口/API 口径）**：`[assembly] [geometry] [render] [core, export]`；`{core, export}` 的环由 `export → core` 的 gate 调用维持。

### 9.3 P0 逐项结果

| 项 | 计划 | 实际 | 证据 |
|---|---|---|---|
| 只读清单 98/104 | 生成化 | **104 + 强 parity 门**；生成化留 P1 | `src/tools/op/read-only.ts`、`tests/unit/js/contract/op-read-only-parity.test.ts` |
| 本地车道白名单 | 单源生成 | **完成**：`config/local-ops.json` → 两份 `local-lane.ts` | `scripts/gen-local-ops.mjs`、`check-local-ops.mjs` |
| routing ↔ catalog | 双向门 | **完成（ratchet）** | `tests/unit/js/contract/route-catalog-parity.test.ts` |
| 路由字面量消费者 | 门禁 | **完成**（tools/host/headless/client） | `route-consumers.test.ts` |
| 通道词表 | 3 → 1 或门禁 | **门禁完成**（生成化 P1） | `channel-vocabulary.test.ts` |
| `core` ↔ `execution` | 反向边 0 | **完成**：45 → 0；正向 16 条保留 | `runtime/foundation/`（15 文件） |
| 写鉴权 | 单一入口 + fail-closed | **完成**：模块级 `REGISTRY` 删除；缺装配 `session_unavailable` | `runtime/http/session-gate.ts`、`write-authority.test.ts` |
| 跳过规则数据化 | 8+ → 1 | **部分**：入口唯一，谓词仍在路由（P1） | `runtime/http/routes/*` |
| 会话解析 | 7 → 1 | **完成（链路）**：`resolveSession`；status/list 保留并注释 | `src/tools/shared/session.ts`、`session-ref.test.ts` |
| 证据/重载 | 断反馈环 | **完成**：显式快照 + `reloadOnce` | `runtime/foundation/{evidence,evidence-host,layers}.ts`、`src/host/reload/index.ts` |
| globalThis 代际 | 删除 | **改为收敛**（HMR 模块复用的判据；删除会退化“假 current”） | `src/host/backend/host-manifest.ts` |
| 回执构造器 | 唯一 | **完成**：`receipt.v2` 手写 6 → 1 | `src/tools/receipt.ts`、`receipt-constructor.test.ts` |
| `headless/receipts` 648 行零调用 | 接入或删除 | **未动**（P1 清理） | `src/headless/receipts/**` |

### 9.3.1 P1-1a 结果（commit 1ae237d）

| 项 | 结果 |
|---|---|
| 端口机制 | `K.dsh_ports` + `register_port / port_available / call_port / port_names`（`core/kit.py`）；`modules.json` 仍 **44** |
| core→render | `c_evidence` 走 `view_capture`（`render/view.py` 注册 v4）；缺端口时同形错误、全程不触 bpy |
| core→export | `gate_deliver` 走 `deliver_export` / `deliver_verify`；gate plan 的 `deliver_verify` 端口优先 + `dsh_<short>_api` 运行时回退 |
| 字面归零 | `runtime/py/core` 全域 `dsh_view_api` / `dsh_deliver_api` **0**（含 OP_MAP） |
| 仍存在 | `core→render`：`dsh_calib_api`（evalharness）、`dsh_material_api`（OP_MAP）；`export→core`：`dsh_gate_api`（`require_gate`） |
| 功能图 | `[assembly] [geometry] [render] [core, export]`；`{core, export}` 由 `export→core` 维持 |
| 验证 | pytest 全绿（exit 0）；`check:python-static`；`test:contract` 432；`typecheck`/`lint` |

### 9.4 合并验证（commit fbea0a3 时实际执行）

| 命令 | 结果 |
|---|---|
| `npm run build` / `typecheck` / `check:build` | 全绿 |
| `npm run lint` | PASS（eslint / any / exceptions / plan-ids / doc-paths / local-ops / ports） |
| `npm run test:contract` | **49 files / 432 tests** |
| `npm run test:unit` | **134/134 文件、1194 passed / 2 skipped**（consent 套件已做策略隔离） |
| `npm run test:integration` | **32/32 文件、309 passed** |
| `check:structure` / `check:function-budget` / `check:routes` / `check:no-shims` / `check:runtime-layout` | 全 PASS |
| `check-plan-ids --enforce` | residual **0**（基线 114 文件 / 1517 tokens；审计文档 skipFiles） |

### 9.5 如何保持本页同步

```text
git log -1 --format='%h %s'
npm run typecheck && npm run lint
npm run test:unit && npm run test:integration && npm run test:contract
node scripts/check-structure.mjs        # 打印 files / edges / cycles / budgets
.venv/Scripts/python.exe -m pytest tests/unit/python -q
npm run check:python-static
node scripts/sync_counts.mjs --dry      # 契约计数
```

度量口径：TS 只统计 `src/**` + `runtime/**`（排除 `lib/`、`node_modules`）；相对 import 解析 `.js` → `.ts`；SCC 用 Tarjan。

### 9.6 遗留（P1/P2）

- **P1-1a 后续**：把 `export → core` 的 gate 调用倒置为 `gate_run` 端口；清掉 `core → render` 的 calib/material 字面；之后重算五域 SCC。
- **P1-1b**：`geometry ↔ assembly` 的 shapegen/vehicle 归属（产品决策）。
- **P1-1c**：`core/scene_ctx`、preload/DEPS 生成、`txn` 与 `worker.checkpoint` 合并。
- **P1-2/3/4**：SessionRegistry 拆分、config 拆分、client 3058 行拆分与类型化。
- **P2**：只读/通道生成化、跳过谓词数据化、`headless/receipts` 清理、availability/addon 出口收敛。
