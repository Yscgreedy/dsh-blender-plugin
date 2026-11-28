# P0 重构计划 — 先破环，再降噪

> 配套报告：[ARCHITECTURE.md](ARCHITECTURE.md)（诊断与证据）。本文件只讲**怎么做、改哪些文件、怎么证明没改坏**。
> 原则（来自 `docs/architecture.md` §8 与 `AGENTS.md`）：**一次一刀、只动一个边界、移动代码行为零变化、旧文件同刀删除、行为变更先写失败测试**。
> 基线：v3.3.0，2026-11-27。所有路径相对仓库根。
> **当前执行状态以 [ARCHITECTURE.md](ARCHITECTURE.md) §7 演进记录 / §4.2 环现状为准**：P0 与 P1-1a 已合并（代码基线 `427a02f`）。

---

## 0 总览

| 顺序 | 工作流 | 破的环 | 预计 | 风险 | 依赖 |
|---|---|---|---|---|---|
| **P0-1** | 契约单源与可达性 | D1/D2/D5（变更传播） | 2–3 天 | 低 | 无 |
| **P0-2** | `core` ↔ `execution` 分层 | R1（包级双向） | 2 天 | 中（机械移动） | 无 |
| **P0-3** | 写鉴权单一权威 + 会话解析 | R2（双权威/ fail-open） | 3–4 天 | 中高（安全语义） | P0-1 的测试基线 |
| **P0-4** | 证据/重载断环 + 唯一回执 | R3/R5（控制回路） | 3 天 | 中（跨进程） | P0-2 之后更干净 |

**先做 P0-1a**：只读清单已经腐坏（98 vs 104），6 个只读 op 在无会话时被误判 `session_required`。这是一行级 hotfix + 一个缺失的测试，应当**今天合入**，不等整个 P0。

**不在 P0 内**：Python 五域断环（P1-1）、SessionRegistry 拆分（P1-2）、config 拆分（P1-3）、client 拆分（P1-4）。原因见 §6。

---

## 1 P0-1 契约单源与可达性

### 1a. 立即修复只读判定（hotfix，独立 PR）

**问题** ✅ 已复核
- `src/tools/op/read-only.ts` 98 项；`runtime/catalog/data.ts:633-740` 104 项。
- 缺 6 个：`fingerprint`、`asset_search`、`asset_help`、`anim_rig_report`、`anim_deform_audit`、`toon_outline_audit`。
- 文件头声称 `op-read-only-parity.test.ts` 守门，但**该测试不存在**；真实门只比 `data.ts` ↔ `tests/fixtures/plan_readonly.baseline.json`。
- 后果：`src/tools/op/execute.ts:102` 的 `gate(port, !READ_ONLY.has(op) && !dryRun(...))` 对这 6 个 op 要求会话。

**改动**
1. `src/tools/op/read-only.ts`：补 6 个名字（保持排序），共 104。
2. 新建 `tests/unit/js/contract/op-read-only-parity.test.ts`：
   ```ts
   import { READ_ONLY_OPS } from '../../../../src/tools/op/read-only.js'
   import { PLAN_READ_ONLY_OPS } from '../../../../runtime/engine.js'
   expect(new Set(READ_ONLY_OPS)).toEqual(new Set(PLAN_READ_ONLY_OPS))
   ```
3. （同 PR）在 `tests/unit/js/contract/op-contract.test.ts` 增加"每个只读 op 都能被 `blender_op` 无会话调用"的断言（表驱动，至少覆盖新增 6 个）。

**验收**
```text
npx vitest run tests/unit/js/contract/op-read-only-parity.test.ts
npx vitest run tests/unit/js/contract/op-contract.test.ts
npm run test:unit
```

### 1b. 只读清单生成化（消除第二份）

**目标**：宿主不再手写 104 项，改为生成。

**步骤**
1. 新脚本 `scripts/gen-read-only.mjs`：import 构建产物 `lib/runtime/engine.js` 的 `PLAN_READ_ONLY_OPS`，渲染 `src/tools/op/read-only.generated.ts`（头行 `AUTO-GENERATED … source sha256`，沿用 `gen-routes.mjs` 的写法）。
2. `src/tools/op/read-only.ts` 改为 `export { READ_ONLY_OPS, READ_ONLY } from './read-only.generated.js'`（保留 `READ_ONLY` Set 语义）。
3. `package.json`：`build` 增加该生成步骤；`lint` 增加 `node scripts/check-read-only.mjs`（生成物新鲜度，仿 `check-routes.mjs`）。
4. `src/tools/op/read-only.ts` 头注释更新为"生成 + 门禁"，删掉对不存在测试的引用。

**验收**：改 `data.ts` 的一个只读 op → `npm run check:read-only` 失败并给出 regen 命令；regen 后通过；`test:contract` 全绿。

### 1c. 本地无头车道白名单单源

**问题**：`src/tools/op/local.ts:28-47` ↔ `runtime/execution/local-op/names.ts:6-28` 两份 8 op + `img_` 前缀，靠 `tests/unit/js/op-local-lane.test.ts` 粘合。

**步骤**
1. 新增 `config/local-ops.json`：
   ```json
   { "version": 1, "ops": ["audit_mesh","img_digest","img_probe","img_measure","img_calib","visualreport_report","qc_render_views","montage"], "prefixes": ["img_"] }
   ```
2. 新脚本 `scripts/gen-local-ops.mjs` → 生成两个文件：
   - `runtime/contracts/local-lane.ts`（生成的 `LOCAL_OP_NAMES/LOCAL_OP_PREFIXES/isLocalOpName`；P0-2 之后的稳定落点）
   - `src/contracts/local-lane.ts`（同常量；宿主可 import）
   若 P0-1c 先于 P0-2 合入，`runtime/execution/local-op/names.ts` 暂时 re-export `contracts/local-lane.ts`，P0-2 再删壳。
3. `names.ts`、`src/tools/op/local.ts` 改为 re-export；`runtime/core/output/render.ts` 的 headless 判定继续走 `names`。
4. `lint` 增加 `node scripts/check-local-ops.mjs`；`build` 先生成。

**验收**：`rg "audit_mesh" src runtime` 只剩生成文件与 catalog data；`op-local-lane.test.ts` 改为断言两侧 === 生成常量（或删除）；`check:routes`/`test:contract` 绿。

### 1d. routing ↔ catalog 双向门禁

**问题**：`shape_solve`、`model_deliver` 只在 routing（`config/routing.json:196-254`），不在 catalog；`montage.help` 可能被空前缀 `ext-contract` 抢先（表尾 catch-all）。

**步骤**
1. 给 `config/contracts.json` 增加 `routeAliases` 字段，显式声明"routing-only 的 exact op"（`shape_solve`、`model_deliver`），每项带 `reason` 与 `catalogOp?: string`。
2. `scripts/gen-routes.mjs` 的 `validateRouting` 增加：
   - 每个 `match:"exact"` 的 `op` ∈ catalog ops ∪ `routeAliases`；
   - 每个 catalog op（除 host-side family）至少有一个路由命中；
   - 空前缀路由只能有一条且必须在表尾（否则报错）。
3. 新增 `tests/unit/js/contract/route-catalog-parity.test.ts` 覆盖上述三条，失败信息给 op 名与文件行。
4. 对 `montage.help`：先在 catalog 里改名（如 `montage_help`）或给它一条 exact 路由；同步锁文件与文档计数（若 op 数不变，仅改名）。

**验收**：故意把某个 catalog op 从 routing 删除 → 测试失败并点名；`npm run check:routes` 绿。

### 1e. 路由字面量消费者门禁

**问题**：`CONTRACT_ROUTES`（29）是唯一真源，但工具硬编码 `'/job'`、`'/lease'`，客户端 13 个端点字符串；`check-routes.mjs` 只查生成表。

**步骤**
1. 新增 `tests/unit/js/contract/route-consumers.test.ts`：
   - 扫描 `src/tools/**/*.ts` 的 `backendPost(port, '<path>'` 与 `fetch('<path>')`；
   - 扫描 `src/client/index.js` 的单/双引号路径字面量；
   - 去掉 query（`split('?')`）后必须 ∈ `CONTRACT_ROUTES` ∪ `{'/host'}`。
2. 对动态拼接（`'/host/jobs?limit=' + n`）用"前缀匹配"规则白名单化，规则写在测试里（一条 op 一行）。

**验收**：把 `/job` 改成 `/jobs` → 测试失败并指出文件:行。

### 1f. 渲染通道词表对齐（低成本）

**问题**：3 份：`src/tools/run/execute.ts:44`、`runtime/execution/render-channels.ts:18`、`runtime/py/render/channels_impl/metrics.py:23`。

**步骤（MVP）**：新增 `tests/unit/js/contract/channel-vocabulary.test.ts`，用正则从三处读列表并断言集合相等；Python 侧用 `ast` 或正则读 `CHANNEL_NAMES`。
**步骤（后续，P1）**：`config/render-channels.json` 生成 TS/Python 两份常量，删除 parity 测试。

**验收**：任一处增删通道 → 测试失败并列出差异。

### P0-1 完成定义

- 只读清单 1 份（生成）+ 真门；local-op 白名单 1 份（生成）+ 门；通道词表有 parity 门；routing↔catalog 双向门；路由字面量消费者门。
- `npm run lint`、`npm run test:contract`、`npm run test:unit` 全绿。
- 文档：`AGENTS.md` 的计数行、`docs/architecture.md` §8 的生成物清单同步（若新增 `gen-*` 脚本）。

---

## 2 P0-2 `core` ↔ `execution` 分层

### 2.1 目标（可量化）

| 边 | 现状 | 目标 |
|---|---|---|
| `execution/**` → `core/{json,output,progress,kernel,scripts,errors,evidence*,layers}` | **45** | **0**（已完成：改为 → `foundation/`；`local-evidence` 留在 core） |
| `execution/local-op/table.ts` → `core/dispatcher/*` | **2** | **0**（改为 → `contracts/routes*`） |
| `core/queue` / `core/engine` → `execution` | 17 | 保留（正确的向下依赖） |

> 关键：**只要求反向边归零**。`queue → execution`、`engine(assembly) → execution` 是编排层依赖执行层，方向正确。

### 2.2 步骤（每步一个 commit，内容零改动）

**Step 1 — 迁出 contracts（必须先做）**

> 顺序原因：`core/output/render.ts` 目前 import `execution/local-op/names.js`。若先移 `output/` 再移 `names`，会留下 `foundation→execution` 的反向边。

- `runtime/execution/local-op/names.ts`：若 P0-1c 已生成 `runtime/contracts/local-lane.ts`，这里只保留 re-export 并于本刀删除；否则先整文件迁到 `contracts/local-lane.ts`，P0-1c 再替换为生成内容。
- 更新消费者：`core/output/render.ts`、`execution/local-op/table.ts`、`execution/local-op/driver.ts`（如有）
- `runtime/core/dispatcher/routes.generated.ts` → `runtime/contracts/routes.generated.ts`
- `routeMatches()` 从 `plan-call.ts:68` 抽到 `runtime/contracts/route-match.ts`（纯函数，只依赖 `GuiRoute` 类型）
- 更新：`scripts/gen-routes.mjs:25` 的 `GENERATED_FILES`、`tests/unit/js/contract/routes-generated.test.ts:12`、消费者 `plan-call.ts:7-8`、`ext-routing.ts:3`、`local-op/table.ts:8-9`


**Step 2 — 建 `runtime/foundation/`（纯移动）**

| 从 | 到 |
|---|---|
| `core/json.ts` | `foundation/json.ts` |
| `core/errors.ts` | `foundation/errors.ts` |
| `core/progress.ts` | `foundation/progress.ts` |
| `core/scripts.ts` | `foundation/scripts.ts` |
| `core/flags.ts` | `foundation/flags.ts` |
| `core/selftest.ts` | **留在 `core/dispatcher/`**（仅 dispatcher 归一化用；移走会制造反向边） |
| `core/output/**` | `foundation/output/**` |
| `core/kernel/**` | `foundation/kernel/**` |
| `core/evidence.ts`、`evidence-host.ts`、`evidence-types.ts`、`evidence-util.ts` | `foundation/evidence*.ts` |
| `core/layers.ts` | `foundation/layers.ts`（`local-evidence.ts` **留在 core**：只有 http/health 消费，且 config/exceptions.json 有 file-budget 例外） |
| `core/availability.ts`、`availability-schema.generated.ts` | `foundation/availability*` |
| `core/render-state.ts`、`bpy-api-probe.ts` | `foundation/` |

只改 import 说明符（`.js` 后缀保持），逻辑零改动。用一次性 codemod（node 脚本）完成，然后 `git diff --stat` 应只有 rename + import 行。

**Step 3 — 重指 execution 的 import**

- `execution/**` 中所有 `../core/...` → `../foundation/...`（按 Step 2 映射）
- `execution/local-op/table.ts` → `../../contracts/routes.generated.js` + `../../contracts/route-match.js`
- `core/queue/job-args.ts`、`spawn-executor.ts` 对 execution 的依赖保持不变（向下允许）

**Step 4 — 收尾**

- `core/` 只剩 sessions / queue / dispatcher / engine / engine-api / plan / plan-dispatch 等编排件；`foundation/` 对 `core/**` 的 import 必须为 0。
- 更新 `docs/architecture.md` §3 的 layout 与 `AGENTS.md` §2 的路径表（同刀）。

### 2.3 验收

```text
node <导入图脚本>            # 断言 execution→core = 0，local-op→dispatcher = 0
npm run typecheck            # 含 build runtime + host + tests
npm run build
npm run check:build
npm run test:unit
npm run test:integration     # route-matrix / job-queue / headless
npm run test:contract
```

**回滚**：每步独立 commit；Step 1 只 rename，可 `git revert` 单步。

**风险与对策**
- 循环 import 的求值顺序变化 → 只移动无副作用模块；`foundation` 内禁止 import `core`。
- 生成物路径变化导致 gate 失效 → `check:routes` 的 `GENERATED_FILES` 同步，`routes-generated.test.ts` 是第二道。
- 源码映射/包内容 → `files` 已含 `runtime`，`lib/` 重建。

---

## 3 P0-3 写鉴权单一权威 + 会话解析收口

### 3.1 目标

- 一条写请求只经过**一个**授权入口，顺序固定；未装配 registry 时**失败关闭**。
- 宿主 7 处会话解析 → 1 个值对象。
- LEASE 保留为"无 caller 头的旧客户端"兼容适配器，不再与 registry 并列决策。

### 3.2 后端：`WriteAuthority` 端口

**新增** `runtime/core/sessions/write-authority.ts`：

```ts
export interface WriteRequest {
  sessionId?: string
  scope: unknown
  py?: boolean
  scopeDeclared?: boolean
}
export interface WriteDecision { ok: true; sessionId: string; mode: 'main' | 'grant' }
export interface WriteDenied extends AvailabilityFailure { ok: false }

export interface WriteAuthority {
  authorize(c: CallerIdentity, req: WriteRequest): WriteDecision | WriteDenied
}
```

- `SessionRegistry` 实现该接口（内部仍用 `authorizeWrite`，逻辑不动）。
- `runtime/http/write-gate.ts`（新）：`authorizeRoute(E, payload, opts)` —— 唯一入口；`E.sessionRegistry` 缺失且有 caller → 返回 `session_unavailable`（**fail-closed**）。
- 所有写路由改为同一顺序：`caller → authorizeRoute → handler`（`act.ts`、`plan.ts`、`job.ts`、`headless.ts`、`txn.ts`、`preset.ts`、`view.ts`、`worker.ts`、`commands.ts`、`loop.ts`、`opt.ts`、`perf.ts`）。跳过规则改为**数据**：路由声明 `{readOnlyOps, isolated, allowPyCaller}`，由 `authorizeRoute` 统一解释。
- 删除 `http/session-gate.ts` 的模块级 `REGISTRY` 与 `setSessionRegistry`；`gateway/app.ts:119` 不再注入全局；`http/target.ts:14` 改为从 `E` 取。
- LEASE 适配：`legacyLeaseAuthority` 只在 `caller == null` 时被调用，且其失败文案标注 `legacy_lease`。

### 3.3 宿主：`SessionRef` 值对象

`src/tools/shared/session.ts` 增加：

```ts
export interface SessionRef {
  ok: true
  sessionId: string
  instanceId: string
  owner: string
  source: 'mine' | 'visible'
}
export interface NoSessionRef { ok: false; failure: ToolFailure }
```

- 6 个工具改用 `resolveSession()`；删除 `op/execute.ts:59-67`、`op/local.ts:267-275`、`see/index.ts:89-91`、`run/execute.ts:384-386`、`session/execute.ts:150-174,254-265` 的自解逻辑。
- `see/index.ts:90` 改为 `if (!ref.ok) return ref.failure`（保留 instance 线索）。

### 3.4 验收

```text
npx vitest run tests/integration/js/lease-scope.test.ts
npx vitest run tests/unit/js/session-family.test.ts tests/unit/js/session-registry.test.ts
npx vitest run tests/unit/js/virtual-gui-consent-panel.test.ts
npm run test:integration
```

新增测试：
1. **fail-closed**：构造 `E` 无 registry + 有 caller 头 → 写路由 409/403，且不落 handler。
2. **顺序唯一**：表驱动 8 条写路由，断言 `authorizeRoute` 在 handler 前被调用一次。
3. **legacy lease**：无 caller 头的老请求仍按 LEASE 判定通过或否定，回执含 `legacy_lease`。

**风险**：`/act` 的 `beginPy` 必须早于授权（`registry.ts:1100-1121`）；在 `authorizeRoute` 内部保留 `py` 标记，顺序写死并加注释。
**回滚**：`write-authority.ts` 是新增；旧 `session-gate` 保留一个 release 分支，回滚只需恢复 4 条路由的调用。

---

## 4 P0-4 证据/重载断环 + 唯一回执

### 4.1 分层证据显式化

**现状**：`engineProvenance()` 内部读 `hostLayerSnapshot()`，后者从 env/磁盘发现清单；宿主在装载期写清单并用 `globalThis` 记代际。

**步骤**
1. `foundation/layers.ts`：`hostLayerSnapshot({ root, manifestPath, manifest? })` —— 三个入参全部显式；删除模块内 `manifestPath()` 的 env 读取（移到调用方）。
2. `foundation/evidence-host.ts`：`hostProvenance(snapshot)` 只接受快照；`engineProvenance({ layers, fresh, verify })`。
3. `src/host/backend/host-manifest.ts`：**保留但收敛** `globalThis.__dshBlenderHostManifestGeneration` / `ACTIVATED`——它不是随手写的全局，而是 HMR 下"模块是否被重新求值"的唯一探针（模块实例复用时 `MY_GENERATION` 不变，`refreshHostManifest` 才不会把旧一代洗成 current）。本刀只做三件事：两个 key 收进一个 `HostManifestProbe` 对象、导出测试用 `resetHostManifestProbeForTest()`、禁止其它模块直接读写这两个 key。**不删除探针**，删了会退化成"假 current"。
4. `http/routes/session/control.ts:115` 与 `src/host/reload/index.ts:77-82`：改为消费显式快照；`/status` 的 `provenance` 响应保留字段不变（行为兼容）。

**验收**：单测直接构造两个 manifest 快照 → 断言 `current/stale/unknown`；`rg "__dshBlenderHostManifest" src runtime` 只出现在 `src/host/backend/host-manifest.ts` 与它的测试。

### 4.2 唯一 verdict / receipt 构造器

**步骤**
1. 新增 `src/tools/receipt.ts`（≤120 行/函数）：
   `deriveVerdict({ ok, degraded, channels, job })`、`receiptV2({ contract, verdict, evidence, next_actions })`、`withEvidence()`。
2. 替换 6 处手写 `contract: 'receipt.v2'`：`op/local.ts:175,224`、`run/presenter.ts:228,259,297`、`op/plan-response.ts:227`。
3. `op/local.ts:174-186,222-229` 的恒 `degraded` 改由 `deriveVerdict` 产出；`run/presenter.ts:151-154` 只展示。
4. `src/headless/receipts/**`（≈648 行、0 生产调用）：**已删除**（P2 第一批，见
   [ARCHITECTURE.md](ARCHITECTURE.md) §7.5）。3 文件与 `__internals` 四项一并移除，测试接缝迁到
   `src/tools/receipt.ts` 的生产构造器；`HEADLESS_WAIT_MS` 的唯一读者随模块消失，常量不再保留。

**验收**：`rg "receipt.v2" src` 只剩 1 处；`tests/unit/js/run-receipt.test.ts`、`worker-receipt.test.ts`、`act-receipt.test.ts`、`tool-presenter.test.ts` 全绿。

### 4.3 reload 收尾去环

**步骤**
1. `src/host/reload/index.ts`：新增 `reloadOnce({ settle })`，把"提交 → 等待 → 收尾"封成一次调用；`writeReloadState`/`settleReloadState` 只在内部使用。
2. `src/plugin-lifecycle.ts:27-38` 只调 `reloadOnce({ settle: true })`；删 `:76` 的 `viewport/execute.ts` 死引用。
3. `src/tools/session/reload.ts` 降为纯呈现（只调 `formatReloadReport`）。

**验收**：`npx vitest run tests/unit/js/reload-drain-report.test.ts tests/unit/js/reload-host-self.test.ts tests/unit/js/session-copy.test.ts`；新增"两代写同一状态"的回归：模拟旧 fiber 收尾后新 fiber 再收尾，断言幂等。

---

## 5 全局验收矩阵

| 层 | 命令 | 期望 |
|---|---|---|
| 类型 | `npm run typecheck`（runtime→host→tests 三段） | 0 error |
| 构建 | `npm run build && npm run check:build` | 产物一致 |
| 单测 | `npm run test:unit` | 全绿（含函数预算门） |
| 集成 | `npm run test:integration` | 全绿 |
| 契约 | `npm run test:contract` | 6/39/275/25/29/12 不变 |
| 静态 | `npm run lint`、`npm run check:python-static` | 0 violation |
| 结构 | `npm run check:structure`、`check:exceptions` | 0 新增债务 |
| 导入图 | 自建脚本（ARCHITECTURE §0.2） | execution→core = 0；SCC 不增加 |
| 端到端 | `npm run test:e2e`（Windows GUI / headless） | 至少 1 条 GUI 装、1 条 headless 作业 |

**定义完成（每刀）**
- 行为不变（除 P0-1a 的 bugfix）：回执字段、错误码、HTTP 状态逐字节兼容；有对照测试。
- 旧文件同刀删除；文档（`docs/architecture.md`、`AGENTS.md` 路径/计数）同刀更新。
- 提交带 `AI-Assisted: DeepSeek Harness (<model>)` trailer（`AGENTS.md` §6）。

---

## 6 P1 / P2 路线（不在本次 P0 执行）

### P1-1 Python 五域断环（最大的一处，先设计后动手）

1. **core → render**：`contract.evidence` 不再 `K.dsh_view_api`，改由 render 注册 `evidence_sink` provider（`kit.register`）。
2. **core → export**：`gate_deliver` 只写"门通过"事件/账本；deliver 订阅执行。
3. **geometry ↔ assembly**：把 `shapegen` 的 4 个透传 op 上提为 geometry 自有实现，或整体迁 assembly（产品决策）。
4. **场景上下文单一 DP**：`core/scene_ctx`（选择/模式/单位/坐标系），替换 40 处 `select_set`、13 处 `mode_set`、71 处 `scale_length` 的散落直写。
5. **依赖显式化**：`DEPS` 表 + `kit.require()` + preload 由 `modules.json` 生成；`_kernel()` 18 份 → 1 份。
6. **事务合并**：`txn` 与 `worker.checkpoint` 两套文件级回退点合并。

门槛：P0-1（契约单源）+ P0-2（基础层）完成；每步保持 `test_runtime_layout.py` 的 0 跨域 import；用 pytest 子集 + `check:python-static` 验证。

### P1-2 SessionRegistry 拆分（1193 行 → 4 个 ≤400 行模块）

`ownership` / `consent` / `presence+selection` / `virtual-gui lifecycle`；registry 只做门面。前置：P0-3 的 `WriteAuthority` 已把授权路径固定。

### P1-3 config 拆分

`config/{platform.ts,paths.ts,file.ts,blender.ts}` + 显式 `loadConfig(env, file)`；`CFG` 改为惰性/注入；环境变量 46 → 声明式 schema（含默认值与来源），消除"第一个存在的配置文件整份胜出"。

### P1-4 client bundle

3058 行 / 197 函数 / 13 端点：拆模块 + 纳入类型检查（`allowJs` 或迁移 TS）+ 纳入行预算（`check-structure.mjs` 扩到 `.js`，或单独预算）。

### P2（降噪）

- availability 出口收敛（3 份生成物 + addon 生产路径接入信封）。
- `server.py` 传输/分派拆分；`config.py` 反向依赖 server 断开。
- 作业状态单源（内存 + 事件归约，台账只读）。
- 死代码清理：`ADDRESS`、`T` 8 个死键、6 个死导出、`renderStructured`、`inspectHelp`。
- 计数生成覆盖 `runtime/classes.ts:176`（"38 个能力族"目前不在 `sync_counts` 正则内）。
- 渲染旗标 4 跳字符串契约 → 注入一个结构化对象 + Python 侧读取函数。

---

## 7 风险登记

| 风险 | 触发 | 缓解 |
|---|---|---|
| P0-2 移动改变模块求值顺序 | 有副作用的模块被提前/延后 import | foundation 只收无副作用模块；`config.ts` 留在 L0 不动 |
| P0-3 破坏旧客户端 | LEASE 路径被误删 | 保留 `legacyLeaseAuthority` + 双写测试；release 一个版本后再删 |
| P0-4 回执字段变化 | 第三方按旧 `receipt.v2` 解析 | 构造器保持字段字节不变；只新增字段，既有字段语义不动 |
| 生成器增加构建复杂度 | 每次改 catalog 都要 regen | 生成 + 新鲜度门 + `sync_counts` 一条命令；CI 失败信息给命令 |
| 改动与 `check-parity` 基线冲突 | catalog 结构变化 | P0 不动 catalog 结构（只加 `routeAliases` 字段）；`check-parity` 的 declared removals 不需要改 |
| 时间 | 4 条工作流交叉 | 严格顺序 P0-1 → P0-2 → P0-3 → P0-4；每条独立可回滚 |

---

## 8 一页执行清单

- [x] **今天**：P0-1a 只读 6 项 + parity 测试 + 合约断言（独立 PR）
- [x] 第 1 周：P0-1c/d/e（生成器 + 三道门）；P0-1b 只读生成化留 P1（104 条 + parity 门）
- [x] 第 1 周末：P0-2 Step 1–4（foundation 移动 + 路由表迁出）；`execution → core` = 0
- [x] 第 2 周：P0-3（WriteAuthority + SessionRef + fail-closed 测试）；跳过谓词数据化留 P1
- [x] 第 3 周：P0-4（显式快照 + globalThis 收敛 + 唯一 receipt + reloadOnce）
- [ ] 每刀后跑 §5 验收矩阵；导入图指标写入 PR 描述
- [ ] P0 全部完成后，再开 P1-1 的 Python 断环设计评审
