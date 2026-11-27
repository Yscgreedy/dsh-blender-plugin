# ARCHITECTURE.md — DSH × Blender 插件：当前架构与公理化设计审计

> **性质**：架构现状 + 公理化设计（AD）审计。规范以 [docs/architecture.md](docs/architecture.md) 与 [AGENTS.md](AGENTS.md) 为准；本文回答“现在长什么样、哪里仍然耦合、为什么、下一步拆哪”。
> **代码基线**：`5476cb3`（P0 + P1-1a + P2 第一批已合并）。文档提交不影响该基线；§7 记录演进。
> **方法**：Nam P. Suh 公理化设计——FR–DP 映射、独立公理（三角化/破环）、信息公理（I 最小）、之字形分解。
> **证据**：结论给 `文件:行` 或生成物路径；✅ = 本报告复核，◐ = 分层审计给出（原始报告在 `.audit/`，本地忽略）。
> **未覆盖**：真实 Blender E2E、Windows GUI、浏览器面板运行时未在本报告中实测。

---

## 0 摘要

**一句话：三段进程边界稳定，TypeScript 值级图是 DAG；P0 拆掉装配/契约/证据的环，P1-1a 把 Python 五域的源码层耦合降到 5 个单点，P2 把队列传输/取帧去重/回执/写门跳过判据收成单入口并删掉 648 行死模块。剩余耦合只剩 R4 的 12 条 `core→` 域 API 字面与几何↔装配的归属（已复核为“需先做截面策略，暂不迁移”），不再是全仓级架构缺陷。**

| 维度 | 现状 | 证据 |
|---|---|---|
| 进程边界 | **解耦**：宿主只走 HTTP；addon 只拨 Gateway；只有 addon 碰 bpy | §2.1 |
| TS 值级导入图 | **DAG（0 环）**；类型级 6 个 barrel 环 | §1.2 |
| `execution → core` | **0**（P0-2b） | 导入图 |
| `foundation → core/execution` | **0 / 0** | 导入图 |
| `core → execution` | 16（正向：编排依赖执行） | 导入图 |
| Python 语法跨域 import | **0**（测试硬守卫） | `tests/unit/python/test_runtime_layout.py` |
| Python 源码层 SCC（import + API 字面） | **5 个单点**（P1-1a 收尾） | §7.2 |
| Python 端口层 SCC | `{core, export}` 互调（交付必须过门，产品语义） | §7.2 |
| 写鉴权 | **单一入口 + fail-closed**；跳过谓词仍分散 | §2.4、§4.4 |
| 契约计数 | 6 工具 / 38 family / 270 op / 45 路由行 / 44 Python 模块 / 25 addon 命令 / 29 HTTP 路由 / protocol 12 | `capability.lock.json` |
| 测试面 | unit 137 文件 / 1210 passed（2 skipped）；integration 32 / 309；contract 49 / 432；pytest 522 | §7.4、§7.6 |

**评级：Decoupled（主干）/ Coupled（局部）**。仍 Coupled 的只剩 R4：`core→` 域 API 12 条字面 + `geometry↔assembly` 的归属（复核后确认要先做截面策略，不能靠搬文件解）。R2/D3/D4 均已收口。详见 §4。

**下一步**：P1-1b 第二刀（截面策略 seam，需要 Blender E2E）→ P1-1c（`scene_ctx`、preload/DEPS、txn/checkpoint）→ P1-2/3/4（SessionRegistry/config/client 拆分）。

---

## 1 范围、方法与度量

### 1.1 判定规则

- **FR**：模型/用户可观察的能力。**DP**：承载它的物理实体（模块、类、生成表、配置键、HTTP 路由、Python 注册面）。
- **A_ij = X**（三者之一）：改 DP_j 会改变 FR_i 的契约/回执格式；改变 FR_i 依赖的共享可变状态；必须同步修改 FR_i 的实现才能保持行为。
- **不计 X**：只读、无副作用、稳定的基础库调用（如 `foundation/json.ts` 的 `isRecord`）。
- **三角化**：允许基础 DP 在左下、界面 DP 在右上；仍存在双向边或反馈回路 → Coupled。
- **信息量 I**：隐含前置条件、未声明调用顺序、同一事实副本数、配置自由度、跨进程握手点。
- **之字形**：系统层 FR0/DP0 → 逐 DP 下钻，找耦合最早被引入的层。

### 1.2 度量口径（代码基线 `427a02f`）

| 指标 | 值 | 口径 |
|---|---|---|
| TS 源文件 / 相对导入边 | **301 / 1088** | `src/**` + `runtime/**` 的 `.ts`（不含 `.d.ts`）；相对 import/export 解析 `.js`→`.ts`（含 type import） |
| 值级 SCC / 类型级 SCC | **0 / 6** | 排除 `import type` 后为 0；含类型为 6（全 barrel） |
| 跨层边 | execution→core **0**；foundation→core/execution **0**；core→execution **16** | 相对 import 解析 `.js`→`.ts` |
| `src` ↔ `runtime` 源码 import | **0** | 唯一跨界：`src/host/runtime-bridge.ts` → 编译产物 `lib/runtime/*.js` |
| Python import / 跨域 import | **940 / 0** | 守卫：`tests/unit/python/test_runtime_layout.py` |
| Python 源码层 SCC | **5 个单点**（import + API 字面） | §7.2 |
| 模块 fan-in 前 5 | config **57**、foundation/json **53**、contracts/dynamic **50**、paths **32**、src/constants **27** | 直接 import |
| `DSH_*` 环境变量 | **46**（config.ts 独占 24 处读取） | 排除 vendored |
| 契约规模 | 6 / 38 / 270 / 45 / 44 / 25 / 29 / 12 | 见 §2.8 |
| 债务台账 | 函数预算 **110**、路径例外 **16**（file-budget 5 / py-private-import 8 / reexport 3） | `config/*.json` |
| 测试面 | **312** 文件（ts/mjs/py） | `tests/**` |

### 1.3 未做与 `[待核实]`

- 未运行真实 Blender E2E；GUI/面板运行时只做静态结构检查。
- Python 分域 `K.<attr>` 计数沿用审计基线（297 处 / 跨域 95）；P1-1a 后未重算全矩阵，只验证了 view/deliver/gate 三条边。
- `.audit/` 与 `.review-tmp/` 是本地证据，已被 `.gitignore` 忽略，不随提交/发布。

---

## 2 当前架构

### 2.1 进程与调用链

```
DSH host ──src/tools（6 工具）──HTTP──> Gateway（runtime/http + engine）
                                            │  WebSocket /addon（addon 拨出）
                                            ▼
                                     Blender addon（25 命令）
                                            │
                                            ▼ bpy
```

三段进程边界：宿主只走 HTTP；addon 只拨 Gateway；只有 addon 调用 bpy。Gateway 拥有作业、租约、会话、回执与路由；宿主拥有模型工具与 headless 回退策略。

### 2.2 宿主层（`src/`）

- `src/index.ts` 仅入口；`src/plugin*.ts` 装配；`src/tools/*` 一工具一目录；`src/host/*` 后端生命周期与 HTTP；`src/contracts/*` 边界类型；`src/ui`、`src/tui`、`src/client/index.js` 呈现。
- 6 个工具之间**没有横向业务 import**；共享的是 `src/tools/shared/session.ts` 的 `SessionRef/resolveSession`（会话解析单一链）与 `utils/frame-cache`（状态，见 D4）。
- 回执与判定：`src/tools/receipt.ts` 是 verdict 与 `receipt.v2` 的唯一构造器；失败面由 `errors.ts` 的 `toolError` 起头、再并进同一形状。`src/headless/receipts/**`（648 行、0 生产调用）已删除。

### 2.3 后端 TypeScript（`runtime/` → `lib/runtime/`）

| 层 | 职责 | 约束 |
|---|---|---|
| `runtime/foundation/` | json/errors/progress/scripts/output/kernel/evidence*/layers | **不许** import `runtime/core/**` 或 `runtime/execution/**` |
| `runtime/contracts/` | `routes.generated.ts`、`route-match.ts`、`local-lane.ts`（生成） | 纯数据/纯函数；dispatcher 与 execution 共同消费 |
| `runtime/core/` | dispatcher、catalog、engine、engine-api、sessions、queue、plan | 编排；允许依赖 foundation/execution |
| `runtime/execution/` | headless、jobs、workers、ledger、local-op、txn、preset | 执行；**0** 反向 import core |
| `runtime/http/`、`runtime/gateway/`、`runtime/transport/` | 29 路由、租约、写门跳过判据（`write-skip.ts`）、addon WS | HTTP 只消费 engine |
| `runtime/config.ts`、`paths.ts`、`launch/`、`display/` | 配置/路径/启动/显示 | 基础常量，fan-in 最高 |

### 2.4 会话、写鉴权与同意

- `runtime/core/sessions/registry.ts` 管归属/实例/租约/presence/selection/py 窗口（**807 行**）：拆分已移出写授权（`write-authority.ts`）、同意面（`consent-book.ts`）与只读视图（`session-views.ts`）；剩余 instances / lifecycle。
- **写鉴权单一入口**：`runtime/http/session-gate.ts` 的 `sessionWriteGate(payload, registry)`；`leaseGate(payload, registry)` 在 `gateway/app.ts` 绑定 registry。**带 caller 头但 registry 缺失 → fail-closed（`session_unavailable`）**；无 caller 头的旧客户端仍走 LEASE 兼容路径。
- **跳过判据单入口（P2）**：`runtime/http/write-skip.ts` 的 `shouldGateWrite(path, payload)` 是唯一解释器；例外只有两条例外规则（`/act` 的 `py+caller`、`/worker` 的 `isolated`），路由只问“要不要过门”，不再自己拼三元式。默认是过门：未知路径/未知 op 一律落到写门。
- virtual-gui 同意：`consent.ts`（一次性令牌）、`consent-requests.ts`（持久化、人类批准）、`consent-policy.ts`（env → policy 文件 → 配置 → 默认 manual，≤250 ms 生效）。

### 2.5 证据与验收

- `runtime/foundation/evidence.ts` 的 `engineProvenance({ layers })` 接受**显式快照**；`foundation/evidence-host.ts` 的 `hostProvenance(fresh, snapshot)` 不再隐式读 env/扫盘；HTTP 边界（health/status/doctor、session control）取一次快照传入。
- 分层判定仍保留 `src/host/backend/host-manifest.ts` 的 `globalThis` 代际探针：它是 HMR 下“模块是否被重新求值”的唯一判据，**收敛保留**，不做删除。
- 三态 verdict（pass/fail/degraded）由 Python 域判定、TS 归一、宿主回执；`src/tools/receipt.ts` 统一 TS 侧构造，`receipt.v2` 手写点 1 处。

### 2.6 Blender Python（`runtime/py/`）

- 五域：`core`（audit/contract/gate/motion/planner/txn…）、`geometry`、`assembly`、`render`、`export`；`modules.json` 是唯一注册表（44 模块）。
- 域包之间 **0 跨域 import**（硬守卫）；跨域能力经内核命名空间 `K` 与 **端口**：
  - `K.dsh_ports` + `register_port / port_available / call_port / port_names`（`core/kit.py`）；
  - `view_capture`（render 注册，core 的 `c_evidence` 消费）；
  - `deliver_export` / `deliver_verify`（export 注册，core 的 `gate_deliver` 消费）；
  - `gate_run`（core 注册，export 的 `require_gate` 消费；端口内部仍走 `gate_dispatch`）。
- `K.dsh_<name>_api` 仍是模块注册入口；P1-1a 后 `core` 不再直取 `view/deliver` API，`export` 不再直取 `gate` API。

### 2.7 Blender 扩展（`extension/dsh_blender_bridge/`）

- 2.0.0 / protocol 12；`command_registry.py` 是 25 命令的唯一真源（+ping=26 wire）；catalog 与它双向对拍。
- addon 只拨 Gateway，无入站端口；凭据只存 addon preferences（无 Scene 镜像）。

### 2.8 契约与生成物

| 事实 | 源 | 生成/消费 | 门 |
|---|---|---|---|
| GUI 路由（45 行） | `config/routing.json` | `runtime/contracts/routes.generated.ts` | `check:routes` |
| 本地车道（8 op） | `config/local-ops.json` | `runtime/contracts/local-lane.ts` + `src/contracts/local-lane.ts` | `check:local-ops` |
| catalog ↔ Python | `config/contracts.json` | Python dispatch 表 / catalog | `catalog-dispatch-parity` |
| 可用性 schema | `config/availability.json` | 3 份生成文件 | `check:availability` |
| 计数 | catalog | `capability.lock.json` + 文档 + `sync_counts` | `test:contract` |
| 只读清单 | `runtime/catalog/data.ts` | 宿主 `src/tools/op/read-only.ts`（104） | `op-read-only-parity` |

### 2.9 三个单入口（P2 第一批）

| 收口 | 入口 | 替代了什么 |
|---|---|---|
| 队列传输 | `src/tools/shared/queue-job.ts`（`queueJobBody` / `jobSubmitBody` / `postQueueJob` / `postJobSubmit`） | `run/execute.ts` 与 `op/local.ts` 各手写一遍 `/job` 请求体：surface 两次、`op:'submit'` 两次、Gateway 不可达回执两份 |
| 取帧去重键 | `src/tools/shared/frame-key.ts`（`frameKey` / `callerScope`） | `py/frame.ts` 手工拼 caller；`see/capture.ts` 三条通道用不含调用方的固定键（A 看过的画面会让 B 收到"上一张相同"） |
| 回执 | `src/tools/receipt.ts` + `src/tools/errors.ts` | 6 处手写 `contract: 'receipt.v2'`；死模块 `headless/receipts`（648 行） |

---

## 3 FR / DP

### 3.1 FR（9 条）

| ID | FR | 观测面 | 证据 |
|---|---|---|---|
| FR1 | 会话取得与授权：attach/claim/heartbeat/release；virtual-gui 需人类同意 | 会话型工具（op/py/see/run） | `src/tools/shared/session.ts`、`core/sessions/registry.ts` |
| FR2 | 规划面解析与 op 调用：38/270 可发现、可路由 GUI/本地无头 | `blender_op` | `catalog/data.ts`、`core/dispatcher/plan-call.ts`、`src/tools/op/local.ts` |
| FR3 | GUI 内执行与观察：Python、取帧、事务、worker 热内核 | `blender_py`/`blender_see` | `src/tools/py/*`、`see/*`、`runtime/py/core/worker.py` |
| FR4 | 作业执行：render/headless 提交、排队、执行、恢复、回收 | `blender_run` | `core/queue/*`、`execution/jobs/*` |
| FR5 | 证据与验收：provenance/verdict/receipt，三态判定 | 所有返回值 | `foundation/evidence.ts`、`src/tools/receipt.ts` |
| FR6 | 装配与生命周期：装载、Gateway 启停/热重载、显示、doctor | `blender_session action=doctor` | `src/plugin-lifecycle.ts`、`gateway/app.ts`、`foundation/layers.ts` |
| FR7 | 契约稳定：6/38/270/25/29/12、单源、迁移门 | `test:contract` | `tests/unit/js/contract/*`、`scripts/check-*.mjs` |
| FR8 | 人类可见面：Web 面板/TUI/卡片；可批准同意 | 右侧栏 tab + chip | `src/client/index.js`（3058 行）、`src/tui/*` |
| FR9 | 扩展命令执行：25 命令在 bpy 内执行并回传 | `blender_inspect`/`/cmd` | `extension/.../command_registry.py` |

### 3.2 DP（12 个）

| ID | DP | 物理载体 | 规模 |
|---|---|---|---|
| A | 宿主工具面 | `src/plugin*.ts`、`src/tools/*`、`src/host/*` | 87 TS / 11.5k 行 |
| B | HTTP 契约层 | `runtime/http/*` | 46 文件 |
| C | 会话域 | `runtime/core/sessions/*` | registry 1193 行 |
| D | 规划与目录 | `core/{dispatcher,catalog}`、`contracts/routes.generated.ts` | 5 + 4 文件 |
| E | 队列 | `core/queue/*` | 4 文件 / ~1.4k 行 |
| F | 执行 | `runtime/execution/*` | 40+ 文件 |
| G | 传输 / Gateway | `runtime/transport/*`、`gateway/*` | 10 文件 |
| H | 内核与证据 | `runtime/foundation/*` + `core/local-evidence.ts` | ~3k 行 |
| I | Blender Python | `runtime/py/*` + `modules.json` | 44 模块 |
| J | 扩展 | `extension/dsh_blender_bridge/*` | 73 文件 / 7.2k 行 |
| K | 配置/路径/显示/启动 | `config.ts`、`paths.ts`、`launch/*`、`display/*` | config fan-in 57 |
| L | 契约表与生成物 | `config/*.json`、生成 schema、lock、`scripts/gen-*` | 12+ 文件 |

### 3.3 维度检查

- **系统层**：9 FR / 12 DP；DP>FR 来自共享基础设施（A/H/K），不是过度分层。
- **DP < FR（职责过度集中）**：`core/sessions/registry.ts`（807 行 / 48 public / 9 子能力，拆分进行中）、`core/local-evidence.ts`（817）、`config.ts`（572）、`src/client/index.js`（3058，且不在行预算门内）、`runtime/py/core/worker.py`（1452）。
- **DP > FR（透传/碎片）**：工具 presenter 链；队列四层（route → JobSurface → Queue → SpawnExecutor）；`PlanCallDeps` 40 字段。
- **死质量**：`src/headless/receipts/**`（648 行、0 生产调用）已删除；当前无已知死模块。

---

## 4 设计矩阵与独立公理

### 4.1 系统级 FR–DP

图例：**X** 契约/状态耦合；**x** 条件/只读；**·** 无影响。

| FR ↓ / DP → | A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FR1 会话 | X | X | X | · | · | · | X | x | · | · | X | · |
| FR2 规划 | X | X | · | X | · | x | · | x | X | · | · | X |
| FR3 GUI 执行 | X | X | X | · | · | · | X | X | X | · | X | · |
| FR4 作业 | X | X | · | · | X | X | · | X | X | · | X | · |
| FR5 证据 | X | x | x | X | x | x | · | X | X | · | X | X |
| FR6 生命周期 | X | X | x | · | · | · | X | X | · | · | X | · |
| FR7 契约 | X | X | · | X | · | · | · | · | X | X | · | X |
| FR8 可见面 | X | X | X | · | · | · | · | · | · | · | · | · |
| FR9 扩展命令 | X | X | · | x | · | · | X | · | · | X | · | x |

读法：A 列 9 格是“最后一公里”表面层，不是耦合源；真正的耦合在 C/D/E/F/H/I 内部。完整 X 证据见 `.audit/task-1..4` 与 §4.2。

### 4.2 环清单与现状

| # | 环 | 类型 | 现状 |
|---|---|---|---|
| **R1** | `core` ↔ `execution` 包级双向 | 导入 | **已断（P0-2b）**：execution→core **0**；core→execution 16 条正向 |
| **R2** | 写鉴权双权威 / 跳过谓词 | 状态 | **已断（P0-3a + P2）**：入口唯一 + fail-closed；跳过判据收成 `shouldGateWrite` + 2 条例外数据 |
| **R3** | 证据 ↔ 重载 跨进程回路 | 状态 | **已断（P0-4a）**：显式快照；`unknown` 可单测 |
| **R4** | Python 五域功能 SCC | 功能 | **源码层已解（P1-1a）**：5 个单点；端口层 `{core, export}` 属产品语义；剩余 `core→` 域 API 12 条字面；`geometry↔assembly` 委托已收成 1 入口（P1-1b 第一刀） |
| **R5** | 会话 ⇄ 热更 ⇄ 生命周期 两代写 | 状态 | **已断（P0-4b）**：`reloadOnce` 单入口；`globalThis` 探针收敛 |
| **D1** | 只读判定腐坏 | 契约 | **已修（P0-1a）**：104 + parity 门 |
| **D2** | op 可达性双向破洞 | 契约 | **已加 ratchet（P0-1d）**：exact op 可发现、catch-all 唯一且表尾、重名只允许 `help` |
| **D3** | 本地车道 ↔ 作业回执 | 契约 | **已修（P2）**：`/job` 请求体与不可达回执单源（`shared/queue-job.ts`），两个车道共用 |
| **D4** | py 抓帧 ↔ see 取帧 共享去重状态 | 状态 | **已修（P2）**：键统一由 `shared/frame-key.ts` 构造（通道 + 调用方 + 参数） |
| **D5** | 通道词表 3 副本 | 契约 | **已加 parity 门（P0-1f）**；生成化 P1 |

### 4.3 已断环的证据

- **R1**：`execution/**` 45 条 `core/*` 反向边在 P0-2b 后为 **0**；`core/queue` 与 `core/engine` 对 execution 的正向边保留（16 条）。`routes.generated`/`local-lane` 已迁 `runtime/contracts/`，`local-op/table.ts` 不再 import `core/dispatcher`。
- **R3**：`engineProvenance({layers})` / `hostProvenance(fresh, snapshot)` 显式；`tests/unit/js/provenance-snapshot.test.ts` 用构造快照断言 current/stale/unknown。
- **R5**：`src/host/reload/index.ts` 的 `reloadOnce({settle})` 收口“提交→等待→收尾”；`plugin-lifecycle.ts` 只调一次。
- **D1**：`src/tools/op/read-only.ts` 104 项；`op-read-only-parity.test.ts` 与 catalog 对拍。
- **D2**：`route-catalog-parity.test.ts` 三条 ratchet。
- **D5**：`channel-vocabulary.test.ts` 三处集合相等。
- **D3/D4**：`job-transport-single-source.test.ts` 锁"只有 `shared/queue-job.ts` POST /job、`op:'submit'` 只写一次、两个车道都经构造器"；`frame-key.test.ts` 锁"同通道同参数、不同调用方 → 不同键；无调用方 → 显式 `no-caller`"。
- **R2**：`write-skip.test.ts` 锁"默认过门（未知路径/op 也过门）、两条例外行为不变、`runtime/http/routes/*` 里不再出现 `isReadOnly(`"。

### 4.4 仍耦合的局部

1. **R4 剩余字面**：`core/gate_impl/common.py` 的 12 条跨域 dispatch 条目（assembly 7 / export 2 / geometry 2 / render 1）+ `evalharness.py` 的 `MODULE_ATTR` 7 条（评估面，未列入口径）。`geometry↔assembly` 归属复核后改为"先做截面策略 seam，暂不搬文件"（§8 P1-1b）；第一刀把 5 处委托收成 `shapegen._shell` 1 处，归属未动。
2. **R4 端口层**：`{core, export}` 仍互调（core 交付调用 export；export 交付前过门调用 core）。这是业务前置关系，不是私有 API 耦合；若要端口图也单点，需把 gate 提到域外，属架构决策。

### 4.5 三角化与安全修改顺序

块下三角（基础→表面）：`foundation → execution → queue/sessions → http → host`；`contracts` 与 catalog 在 foundation 之上、execution 之下。

维护者安全顺序：
1. `config.ts`/`paths.ts` → 2. `foundation/*` → 3. `execution/*` → 4. `core/queue`/`sessions` → 5. `http/*` → 6. `src/tools` → 7. `src/client`/`tui`
8. 契约改动单独成刀：`routing.json`/catalog → `gen-routes` → Python 表 → `capability.lock` → 文档计数

### 4.6 评级

**Decoupled（主干）/ Coupled（局部）**。P0 前判定的四条结构环里 R1/R3/R5 已断；R2 在 P2 收口（写门入口 + 跳过判据都单点）；R4 在源码层降为 5 个单点；D3/D4 已修。剩余只有 R4 的 12 条 `core→` 字面与`geometry↔assembly` 的归属（需截面策略 + E2E，属下一刀）。主干可继续演进，P1 的靶子已收敛。

---

## 5 信息公理

### 5.1 当前热点

| # | 坏味道 | 证据 | 量化 |
|---|---|---|---|
| I1 | 配置是“环境推导的全局常量” | `runtime/config.ts` 的 `FILE/BLENDER/WORK/CFG/PATHS` 在 import 期求值；`CONFIG_FILES` 三处候选取第一个存在 | 46 个 `DSH_*`、24 处 env、fan-in 57 |
| I2 | 同意策略 5 源 + 2 套词表 | `consent-policy.ts`：env / policy 文件 / profile / 配置 / 默认；`auto/manual/deny` ↔ `allow/ask/deny` | 4 读取源 + 250ms 缓存 |
| I3 | 构建顺序耦合 | `src/host/runtime-bridge.ts` 引 `lib/runtime/*.js`；`typecheck` 先 build runtime | 7 个运行时模块按产物路径消费 |
| I4 | 会话/身份解析 | `resolveSession` 已是唯一入口；`session/execute.ts` 的 status/list 因逻辑不等价保留 | 1 链 + 2 处例外（有注释） |
| I5 | 回执/判定 | `src/tools/receipt.ts` 唯一构造器（失败面经 `toolError` 起头）；`receipt.v2` 手写 1 处；`headless/receipts` 已删 | 1 构造器 + 1 失败构造点 |
| I6 | 全局可变单例 | `host-manifest.ts` 的 `globalThis` 代际（收敛保留）、`consent-policy` 缓存、`config.ts` 常量 | 3 处重点 |
| I7 | 作业状态三副本 | 内存 + `queue.json` + 台账 `index.jsonl`；`ledger/recover.ts` 对账 | 3 副本 + 389 行对账 |
| I8 | 渲染旗标 4 跳字符串契约 | `render-state.ts` → `assemble.ts` → `kernel/api.ts` → `render_guard.py` | 1 字符串名 / 2 个不一致回退 |
| I9 | 装配期可变袋 | `engine/assemble.ts` 8 次 `Object.assign`；12 文件 29 处 `as unknown as` | 8 突变点 / 29 强转 |
| I10 | 债务台账 | 110 条函数预算、16 条路径例外 | stale 0 |
| I11 | 同一事实的多个请求体/键 | `/job` 请求体（两车道）、取帧去重键（三通道）原来各写一套 | 已各自收成 1 个构造器（§2.9） |

### 5.2 Python 信息量（P1-1a 后）

- **已降**：core 不再认识 `view/deliver` API 名；export 不再认识 `gate` API 名；三个端口是显式契约（`view_capture`、`deliver_export/verify`、`gate_run`）。
- **仍高**：preload 提示 83 处、17 处软缺失降级、10/45 路由无 preload、13/44 模块从不 preload；`scale_length` 71 处、`select_set` 40 / `active=` 26 / `mode_set` 13 / `context.mode` 读 1；`def _kernel()` 18 份；`Api.__call__` 与 `dispatch` 两套返回契约。
- 这些是 P1-1c 的靶子（`scene_ctx`、DEPS/preload 生成、事务合并）。

### 5.3 债务

函数预算 110 条（`runtime/py` 80）、路径例外 17 条；`check:function-budget` / `check:exceptions` 均为 stale 0。

---

## 6 之字形分解：耦合最早在哪一层

| 层 | 现状 | 最早引入点 |
|---|---|---|
| L1 宿主 | 6 工具独立；共享 `SessionRef` 与 `frame-cache` | `src/host/runtime-bridge.ts`（构建前置）、`host-manifest.ts`（装载期副作用） |
| L2 HTTP/Gateway | 29 路由单源；写门单入口 | `session-gate.ts` 旧全局（已删）、`gateway/app.ts` 复用门面（仍在） |
| L3 会话 | 49 方法 / 1193 行；就绪双源 | consent/presence 并入 registry 的那次演进 |
| L4 规划/目录 | `routing.json → routes.generated`；`PlanCallDeps` 40 字段 | 手写依赖注入 + `plan-dispatch` 历史旁路 |
| L5 队列/执行 | 队列职责清晰；反向边已断 | 渠道模块曾放在 execution 而 queue 直接消费（P0-2b 已解） |
| L6 Python | 语法 0 跨域；源码层 5 单点；端口 3 个 | `kit.install_kernel` 的 `setattr(K, "dsh_%s_api")`；P1-1a 用端口补了三个方向 |
| L7 扩展 | 命令单源；`server.py` 混合传输/分派 | 命令面与 catalog 的双向对拍 |

**结论**：耦合最早来自两个“便利设施”——Python 的 `K.dsh_*_api` 服务定位器、TS 的手写装配/模块级单例。P0/P1-1a 已把前者的三条关键路径改成端口；后者的 `session-gate` 全局已删，剩余是 `PlanCallDeps` 与 `engine/assemble` 的可变袋（P1-3）。

---

## 7 演进记录

### 7.1 P0（commits `fbea0a3` + `f5b0ed0`）

| 工作流 | 结果 |
|---|---|
| P0-1 契约单源 | 只读 104 + parity；local-lane 生成；routing↔catalog ratchet；路由消费者门；通道 parity |
| P0-2 分层 | `runtime/foundation/` 15 文件；121 处 import；`contracts/` 承接路由表/车道；execution→core 45→0 |
| P0-3 鉴权/会话 | `session-gate` 去全局 + fail-closed；`SessionRef` 收口 |
| P0-4 证据/重载 | 显式快照；`reloadOnce`；唯一 `receipt.ts`（receipt.v2 6→1） |

### 7.2 P1-1a（commits `1ae237d` + `8f1b026` + `427a02f`）

| 端口 | 提供方 | 消费方 |
|---|---|---|
| `view_capture` | render（v4） | core 的 `c_evidence` |
| `deliver_export` / `deliver_verify` | export（v1） | core 的 `gate_deliver` |
| `gate_run` | core | export 的 `require_gate`（内部仍走 `gate_dispatch`） |

- **结果**：core↔export API 字面双向 **0**；Python 源码层 SCC **5 个单点**；端口层 `{core, export}` 为产品语义（交付必须过门）。
- **剩余**：`core→render` 2 条、`core→assembly` 9 条、`core→geometry` 1 条；`geometry↔assembly` 产品决策。
- **行为差异**：缺失端口文案更新；`gate_preflight.available_modules` 只列真正加载的模块；`deliver` 缺失时 `blocked=true`。`gate_run` 端口与旧 API 走同一 `gate_dispatch`，参数白名单/@工件解析保持。

### 7.3 路径映射（审计基线 → 当前）

| 基线 | 当前 |
|---|---|
| `runtime/core/json.ts` · errors · progress · scripts | `runtime/foundation/*` |
| `runtime/core/output/**` · `kernel/**` · `evidence*.ts` · `layers.ts` | `runtime/foundation/*` |
| `runtime/core/dispatcher/routes.generated.ts` | `runtime/contracts/routes.generated.ts` |
| `plan-call.ts` 的 `routeMatches` | `runtime/contracts/route-match.ts` |
| `runtime/execution/local-op/names.ts` | `runtime/contracts/local-lane.ts`（生成） |
| —（新增） | `src/contracts/local-lane.ts`、`src/tools/receipt.ts`、`config/local-ops.json` |
| `runtime/core/local-evidence.ts` | **仍留 core**（只有 health 消费，有预算例外） |

### 7.4 验证（合并时实际执行）

| 命令 | 结果 |
|---|---|
| `npm run build` / `typecheck` / `check:build` | 全绿 |
| `npm run lint` | PASS（eslint / any / exceptions / plan-ids / doc-paths / local-ops / ports） |
| `npm run test:unit` | 134 文件 / **1194 passed**, 2 skipped |
| `npm run test:integration` | 32 文件 / **309 passed**（并发 flake 单跑通过） |
| `npm run test:contract` | 49 文件 / **432 passed** |
| `pytest tests/unit/python` | **exit 0（522 passed）** |
| `check:python-static` | ruff + pyright clean |
| `check:structure` / `function-budget` / `routes` / `no-shims` / `runtime-layout` | 全 PASS |

### 7.5 P2 第一批（commit `5476cb3`：单入口收敛 + 死模块删除）

| 收口 | 结果 | 证据 |
|---|---|---|
| 队列传输单源 | `/job` 请求体与不可达回执只在 `src/tools/shared/queue-job.ts`；`op:'submit'` 写一次 | `job-transport-single-source.test.ts`（5 条，含源码扫描） |
| 取帧去重键 | `py-see` 与 `see` 三条通道都经 `frameKey(channel, …parts)`，键含调用方 | `frame-key.test.ts`（5 条） |
| 死模块删除 | `src/headless/receipts/**` 3 文件 648 行 + `__internals` 四项；测试接缝迁到 `receipt.ts` / `toolError` | `lossless.test.ts`（4 条）、`tool-error-contract.test.ts`（脱敏断言 3→11） |
| 写门跳过判据 | `runtime/http/write-skip.ts` 的 `shouldGateWrite` + 2 条例外数据；8 个写路由不再自己拼 `isReadOnly(...)` | `write-skip.test.ts`（6 条，含路由源码扫描） |
| 债务台账 | 路径例外 17 → 16（删 `EXC-SINGLE-LINE-REEXPORT-HEADLESS-RECEIPTS`） | `check:exceptions` |
| 文档真值 | `DSH_HEADLESS_WAIT_MS` / `DSH_HEADLESS_AUTO_JOB_MS` 已无代码读者 → `docs/配置参考.md` §3/§11.1 改为"窗口由 `timeout_ms` 给"；`AGENTS.md` 回到 118 行 | `check:doc-paths`、`agents-doc` |
| P1-1b 第一刀 | `shapegen` 的 5 处 `_api("vehicle")` + 5 份缺失文案 → `_shell()` 1 处 | `npm run test:python` |

**验证**：unit 136 / 1204 passed（2 skipped）；integration 32 / 309；contract 49 / 432；`test:python` 522 passed；`lint`（check:any / exceptions / plan-ids / doc-paths / local-ops / ports）全 PASS；`check:build` PASS（产物清单含 `lib/tools/shared/queue-job.js`）。**行为差异**：回执侧不再有 `promoted` 信封与 `HEADLESS_WAIT_MS` 常量；两个 `DSH_HEADLESS_*` 环境变量由"无读者"变为"明确不存在"。

### 7.6 P2 第二批（写门跳过判据单入口）

| 收口 | 结果 | 证据 |
|---|---|---|
| 跳过判据 | `runtime/http/write-skip.ts` 的 `shouldGateWrite(path, payload)` + 2 条例外数据（`/act` 的 `py+caller`、`/worker` 的 `isolated`）；**默认过门** | `write-skip.test.ts`（6 条） |
| 路由 | 8 个写路由的 `isReadOnly(...) ? null : leaseGate(...)` 三元式删除；`/plan` 的歧义判定与门共用同一个 `writeRequest` | 源码扫描：`runtime/http/routes/*` 不再出现 `isReadOnly(` |
| 契约测试 | `security.test.ts` 的写门断言跟到新形状（解释器 + 例外数据 + 默认过门） | 16 条相关断言全绿 |

**验证**：unit 137 / 1210（2 skipped）；integration 32 / 309（两轮各有一个并发 flake，单跑均绿：`gateway-addon-channel`、`gateway-lifecycle`）；contract 49 / 432；`typecheck` / `lint` / `check:build` 全绿。**行为差异**：无（`shouldGateWrite` 对每条真实请求返回与旧三元式相同的结果，由 `write-skip.test.ts` 与 146 条 `route-matrix` 用例对拍）。

### 7.7 registry 拆分第一刀（写授权移出）

| 项 | 结果 |
|---|---|
| 新模块 | `runtime/core/sessions/write-authority.ts`（227 行）：`WriteAuthority` + `WriteAuthorityHost`（sessions 映射、prune、findForCaller、实例表） |
| 迁走 | `authorizeWrite` / `writableSession` / 缺失实例探针 / `writeScopeFailure` / `writeFailureEvidence`（逐字搬运，含注释） |
| 顺带 | 删除零引用的 `private mustOwn`；`registry.ts` 1193 → 1021 行 |
| 表面不变 | `SessionRegistry.authorizeWrite` 签名与返回不变（`WriteAuthoritySource` 仍取 `Pick<SessionRegistry,'authorizeWrite'>`），`sessionWriteGate` 无需改 |

**验证**：10 个会话相关单测文件 125 条全绿；unit 137 / 1210（2 skipped）、integration 32 / 309、contract 49 / 432；`typecheck` / `lint` / `check:build` 全绿。**行为差异**：无（逐字搬运；宿主接口只做取值转发）。

### 7.8 registry 拆分第二刀（同意面移出）

| 项 | 结果 |
|---|---|
| 新模块 | `runtime/core/sessions/consent-book.ts`（206 行）：`ConsentBook` + `ConsentBookHost`（sessions 映射、prune、实例表、limits、virtualGuiCount）+ 面板行投影 |
| 迁走 | `issueConsent` / `requestConsent` / `approveConsent` / `denyConsent` / `consentStatus` / `consentPanel` 与 `panelSessionRow`（逐字搬运） |
| 表面不变 | 六个方法的签名与返回不变；`consent_human_only` 的约束留在注释与 `dispatchSessionAction` 里，未被放宽 |
| 累计 | registry 1193 → **893** 行；两个协作者合计 433 行 |

**验证**：7 个会话相关单测文件 95 条绿（含 `virtual-gui-consent-panel` 28 条）；unit 137 / 1210、integration 串行 32 / 309、contract 49 / 432；`typecheck` / `lint` 全绿。**行为差异**：无。

### 7.9 registry 拆分第三刀（只读视图移出）

| 项 | 结果 |
|---|---|
| 新模块 | `runtime/core/sessions/session-views.ts`（156 行）：`SessionViews` + `SessionViewsHost`（sessions 映射、实例表、prune、findForCaller、tombstone、liveness） |
| 迁走 | `list` / `listFor` / `readableInstanceFor` / `sessionInfo` / `status` 与它们的 `refreshOwner` 心跳 |
| 表面不变 | 五个方法签名不变；`status` 的 tombstone 分支（"释放后 Blender 断了"仍答 stopped）原样保留 |
| 累计 | registry 1193 → **807** 行；三个协作者合计 589 行 |

**验证**：8 个会话相关单测文件 116 条绿；unit 137 / 1210、integration 串行 32 / 309、contract 49 / 432；`typecheck` / `lint` / `check:build` 全绿。**行为差异**：无。

---

## 8 路线图

### P1-1b：geometry ↔ assembly 归属（决策修正：先做截面策略，暂不搬文件）

- **复核证据（2026-11-27）**：`vehicle_loft/fit/sections` 并不是"与车无关"的通用壳层——`loft.py` 的 `_ring_from_station` 默认环来自 `common._section`（超级椭圆 + tumblehome + beltline），`fit.py`/sections 直接吃 `vehicle_spec` 的车辆参数默认值。5 个 `shape_*` op 是"把车辆形工具当量具用"，不是"通用几何"。
- **结论**：整体上提 geometry 会把 `vehicle_spec`/车形语义一起拖进几何域；整体迁 assembly 又会把 674 行里约 600 行与车辆无关的方法层（协议表、旋转体、草稿、自检）塞进装配域。**两条整体搬迁都不做**。
- **第二刀改成**：在 geometry 抽象"截面策略"seam（`ring_from_outline` / `ring_from_shape` / `ring_from_station` 三选一，默认环由调用方注入），vehicle 提供车形策略，shapegen 用自己的策略。该 seam 是纯函数、可单测；但 loft 的真实网格**必须**带回 Blender E2E 验收，所以排在 P1-1c 之后。
- **第一刀（已落，commit `5476cb3`）**：`shapegen` 的 5 处 `_api("vehicle")` + 5 份缺失文案收成 `_shell(op, kw, layer)` 1 处；**归属未动**，R4 的这条边按现状记账，不假装已解。

### P1-1c：场景上下文与依赖声明

- `core/scene_ctx`：选择/模式/单位/坐标系的单一入口，替换 40 处 `select_set`、13 处 `mode_set`、71 处 `scale_length` 的散落直写。
- DEPS 表 + `kit.require()` + preload 由注册表生成；`_kernel()` 18 份 → 1 份。
- `txn` 与 `worker.checkpoint` 两套文件级回退点合并。

### P1-2/3/4

- `SessionRegistry` 拆分：**已完成三刀**（写授权 227 行 / 同意面 206 行 / 只读视图 156 行），registry 1193 → 807；剩 instances / lifecycle 两刀，目标是 ≤400 行 + 子模块各 ≤400，并去掉它的 file-budget 例外。
- `config.ts` 拆 platform/paths/file/blender-detect，配置声明式化。
- 客户端 3058 行拆分并纳入类型/行预算。

### P2

- **已完成（本批）**：`headless/receipts` 删除（648 行）；`/job` 请求体单源；取帧去重键带调用方；写门跳过判据单入口；路径例外 17→16；`AGENTS.md` 回到 120 行预算内。
- **待做**：只读/通道生成化；availability/addon 出口收敛；死代码清理。

---

## 9 附录

### 9.1 分层审计（本地证据）

| 层 | 报告（`.audit/`，gitignored） |
|---|---|
| Host | `task-1-host-layer.md` |
| Backend TS | `task-2-backend-runtime.md` |
| Python | `task-3-python-domains.md` |
| 扩展/边界 | `task-4-extension-boundary.md` |

### 9.2 复现

```text
git log -1 --format='%h %s'
npm run typecheck && npm run lint
npm run test:unit && npm run test:integration && npm run test:contract
node scripts/check-structure.mjs        # files / edges / cycles / budgets
.venv/Scripts/python.exe -m pytest tests/unit/python -q
npm run check:python-static
node scripts/sync_counts.mjs --dry
```

度量口径：TS 只统计 `src/**` + `runtime/**` 的 `.ts`（排除 `.d.ts`、`lib/`、`node_modules`）；相对 import/export 解析 `.js` → `.ts`（含 type import）；SCC 用 Tarjan。本机复算 297 文件 / 1063 边。

### 9.3 术语

- **FR / DP**：功能需求 / 设计参数。
- **耦合环**：A 影响 B 且 B 影响 A 的依赖回路。
- **端口**：`K.dsh_ports` 上的命名回调；提供方注册，消费方只认名字。
- **fail-closed**：缺少授权装配时按失败处理，而不是放行。
