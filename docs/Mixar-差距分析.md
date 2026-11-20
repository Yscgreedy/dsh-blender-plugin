# Mixar → dsh-blender-plugin 差距分析

> 对象：[Mixar-AI/mixar-app](https://github.com/Mixar-AI/mixar-app)（GPL-3.0，Blender 5.2 定制 fork，最新 Release **v4.4.7 / 2026-11-14**，★610 / fork 103）
> 分析日期：2026-11-19 · 依据：上游 README 与 Release notes、官方 MCP skill 包（[hermes-mixar/skills/mixar/SKILL.md](https://github.com/Mixar-AI/hermes-mixar)）、[mixar.app](https://www.mixar.app) 公开页；本仓库 `docs/architecture.md`、`runtime/catalog/data.ts`、`runtime/py/**`、`extension/dsh_blender_bridge/command_registry.py`、`src/tools/**` 实盘核对
> 结论先行：**形态不学（不 fork Blender、不做内置 agent、不改 6 工具面、不引 MCP 分发面），只搬三类工程做法：交付预设化、请求级幂等、外部资产/生成的一等公民化。** 已领先的面（261 语义算子、三态门、事务与证据账本、零遥测、无入站端口）记为防守项，本轮不动。
>
> **本文件只梳理，不改代码。** §6 的三个待定项已改写为「今天会发生什么 + 各选项的真实代价」，可直接按 A/B/C 拍板。
> **落地状态（2026-11-19，按 A/A/A 执行完毕）**：三条都进了主干，计数 35/261 → **36/264**；工具面 6、addon 25 命令、29 路由、protocol 12 不变。
>
> | 项 | 落地 | 证据 |
> |---|---|---|
> | 决策一 资产归口 | 新 `asset` 族（`search`/`fetch`/`help`），实现在 `runtime/py/core/asset.py`；**没有**复活 addon 写命令（3.1 的架构决定），也没引 MCP | `tests/unit/python/test_asset_ops.py`（11 例），modules.json/contracts/routing/catalog/lock 五处登记 |
> | 决策二 交付预设 | `asm_export(use_case=unity/unreal/godot/web)` + 四个受控参数；默认 `none` 逐字节保持旧 kwargs；fbx 现在按预设 `bake_anim=True` | `tests/unit/python/test_asm_export_use_case.py`（23 例），manifest/ledger/回执均带 `export_options` |
> | 决策三 超时兜底 | `blender_py` 超时/断线回 `outcome_unknown` + `request_id` + `checkpoint`；默认 `checkpoint="auto"` 执行前快照 | `tests/unit/js/py-outcome-unknown.test.ts`（14 例） |
> | 附带项 | SKILL 计数一致性契约测试；8 条资产文案改正；新增 `references/资产与生成.md` | `tests/unit/js/contract/skill-counts.test.ts`；`src/tools/inspect/execute.ts` |
>
> 未验证项（需要真机）：PolyHaven 真实下载/导入、Blender 对 `bake_anim`/`export_animations` 的实际接受、快照在真实大场景上的耗时。这些在对应回执与 `honest_limits` 里写明，不当成通过。


## 0. 两边是什么形态

| | Mixar | 本插件 |
|---|---|---|
| 底座 | **fork 整个 Blender 5.2**（`upstream/` 子模块），App 自带 `source/{blender,creator}` | 原装 Blender + 随包 addon，不 fork、不改上游 |
| AI 在哪 | 内置 agent（Mixie）+ 托管后端 `api.mixar.app`（闭源），也可 BYOK | 模型在 DSH 宿主；插件只提供工具面与执行面 |
| 模型接口 | MCP server（`~/.mixar/connector/mixar-mcp`），外部 agent 可接 | 6 个 DSH 宿主工具，不外露协议 |
| 执行粒度 | `execute_bpy_script` 大块 Python + 约 30 个工具 | 35 family / 261 个语义 op + 参数校验 + `did_you_mean` |
| 传输 | App 内 loopback + 每次启动的 bearer token，再转发云端 | Gateway `127.0.0.1:39877`，addon 主动拨入，**无入站端口** |
| 验收 | `verification_passed` 字段 + 「改完必须 render_viewport」 | `gate_*` 三态 + `require_gate` + `contract_*` 证据账本 |
| 收费 | 免费 + credits（仅生成与 `create_layered_material`） | 不涉及 |

上游自己的版本口径也在漂：README 写「Project status: v2.0.0 — first public source release」，Release 已到 v4.4.7。这条反证了 G13 的诉求。

## 1. 差距矩阵

判定口径：**吸收**＝本轮该做；**对等**＝已有等价物；**防守**＝我们更强，吸收时别破坏；**不吸收**＝形态不符或有更便宜的兜底。

| ID | 维度 | Mixar 做法 | 我们现状（证据） | 判定 | 优先级 |
|---|---|---|---|---|---|
| G1 | 交付预设 | `export_scene(use_case)`：unreal/unity→fbx、godot/web→glb、ar→usdz、print→stl，一次调用定轴向/缩放/叶骨/动画烘焙/切线，回 `verification_passed` | `asm_export` 出 glb/fbx/obj 且自带 manifest/ledger/verify（`runtime/py/assembly/assembly_impl/export/index.py:14`），但 FBX 参数**写死** `bake_anim=False / add_leaf_bones=False / FBX_SCALE_ALL`（`export/helpers.py:201-202`）；`deliver_export` 只 obj/stl（`runtime/py/export/deliver_impl/common.py:41`）；**无 usdz**（全仓 0 命中） | 吸收 | **第一优先** |
| G2 | 资产/生成一等公民 | `search_asset_library`（语义）、`list_terrain_assets`、`enqueue_generation`+`get_generation_params`+`poll_generation` | addon 已注册 5 组集成，但**只有搜索与状态**能从 `blender_inspect` 打到；下载/导入/提交被 `WRONG_TOOL` 踢回 `blender_py`（`src/tools/inspect/execute.ts:21-52`）。addon 里其实**已有**三套下载/导入实现（`polyhaven/download.py:15`、`sketchfab/download.py:82`、`polypizza/download.py:60`）但未注册；提示文案还写着「或用 op 的资产算子」——catalog 没有资产族 | 吸收（分层） | **第一优先（文案）+ 第二优先（结构）** |
| G3 | 请求级幂等 | 每次调用带 call UUID，`mixar_call_status(uuid)` 查 pending/complete；HTTP 524＝仍在跑；连续 3 次失败暂停 server 一分钟 | 传输层有 `req-<uuid>`（`runtime/transport/addon-ws.ts:143`），重连时在途请求失败且**不重放**（`tests/integration/js/gateway-addon-channel.test.ts:223`）；作业有 jobId。但单次 op/py 调用没有事后查询入口，也没有取消在途 py 的手段 | 吸收 | **第二优先** |
| G4 | 就绪判定 | `mixar_status` 软检查；文档明写「工具列表 ≠ 就绪」 | `doctor`→`kind=ok`；inspect 对未开开关的命令标 `DISABLED(gate)`（`src/tools/inspect/presenter.ts:51`），执行时回 `command_disabled` + 开开关指引（`execute.ts:185-190`） | 对等 | — |
| G5 | 验证纪律 | 「每次可见改动必须 render_viewport，不许汇报没看见的东西」 | SKILL §0 已写「改一步看一眼」；交付侧更硬：`require_gate` 不过门直接 `blocked`（`deliver_impl/export.py:35-60`），未强制时回 `gate_warning` 不静默 | 防守 | — |
| G6 | 长任务队列 | 队列 + 时长档 + 禁止紧轮询 | `blender_run` 唯一作业入口：submit 立即回 jobId，status/wait/collect/cancel/list，pending 64 / GPU 1 / CPU 2；SKILL 明写「超时≠失败」 | 对等 | — |
| G7 | 场景/会话模型 | 一连接一 scene tab，scenes/switch/projects | sessions + attach/claim/grant + txn snapshot/restore/mark/revert + pause/mark_read | 防守 | — |
| G8 | 分层材质 | `create_layered_material`：图层栈 + mask + bake 一次成型 | `material_build/apply/bake`（preset+params，无图层栈） | 观察 | 备选 |
| G9 | 自动重拓扑 | retopology 工具 | 自动 UV 对等（`uv_smart_project/unwrap/pack`）；**retopo 无实现**（runtime 与 addon 里都没有，只在 `references/modeling-overview.md` 当方法提到），减面只有 `fix_decimate` | 观察 | 备选 |
| G10 | UI 驱动 | `ui_observe/act/wait`（用户显式开关） | `gui` 族只读取帧（frame/shading/open） | 不吸收 | — |
| G11 | 引擎侧闭环 | `mixar-engine-unreal` / `mixar-engine-godot` 两个仓库 | 只到导出文件 | 不吸收 | — |
| G12 | 诊断 | 每次调用记录输入输出，30 天 | 零遥测（有测试断言）；本地 `DSH_TRAJ` JSONL（`runtime/config.ts:126`） | 不吸收（留本地轨迹） | — |
| G13 | Playbook 组织 | `mixar_guide(topic)` 按需取，随 App 版本走 | SKILL.md 1315 行 + `references/` 5 篇；头部手写「6/35/261/protocol 12」**无一致性测试**（`skill-bundle.test.ts` 只校验 frontmatter 与文件树） | 吸收 | **第一优先** |

## 2. 不依赖拍板就能做的（第一优先）

### 第 0 步·之一 · G13 SKILL.md 计数一致性门
- **为什么**：SKILL.md 是模型的事实来源，计数靠手写；上游 README 漂了 2 个大版本就是现成反例。
- **做什么**：`tests/unit/js/contract/skill-bundle.test.ts` 增一例，读 SKILL.md 前 15 行的 `6 / 35 / 261 / protocol 12`，与 `blender_op(op="catalog")` payload、`tests/fixtures/capability.lock.json` 比对。
- **代价**：半人日，只加测试，不动计数。
- **验收**：改成 260 必红；`npm run test:contract` 绿。

### 第 0 步·之三 · G2 文案漂移 + 资产脚本模板
- **为什么**：`execute.ts` 说「或用 op 的资产算子」，但 catalog 没有资产族——模型会白跑一轮找不存在的 op。
- **做什么**：改 8 条资产相关 `WRONG_TOOL` 文案为唯一真实路径（搜索/状态走 inspect，需先开 N 面板开关；下载/导入/提交走 `blender_py`，模板见新 reference）；新增 `skills/blender-modeling/references/资产与生成.md`（PolyHaven/Sketchfab/Poly Pizza 下载→导入→单位归一→`audit_mesh` 复检脚本骨架）。
- **代价**：半人日；不动计数。
- **验收**：`skill-bundle.test.ts` 文件树断言补新文件；真跑一次搜索→脚本导入→体检。

### 第 0 步·之二 · G1 交付预设（只加参数，不动计数）
- **为什么**：见 决策二——今天 FBX 硬编码 `bake_anim=False`，带绑定资产交到 Unity/UE 会静默丢动画，而 `verify` 只校验魔数与 md5，不报这一项。
- **做什么**：`asm_export` 增 `use_case`（`unity|unreal|godot|web|print`，缺省 `none` 保持旧行为）+ 把 `bake_anim / add_leaf_bones / apply_scale_options / export_yup` 变成受控参数；manifest 与回执记录实取值；`deliver_export` 保持 obj/stl 单件口径，文档写清分工；usdz 先探 `bpy.ops.wm.usd_export`，跑不通就写进 `honest_limits`。
- **代价**：1–2 人日；改 `assembly/assembly_impl/export/{helpers,index}.py` + catalog 的 `key` + e2e。
- **验收**：6 个 use_case 映射单测 + 非法值回 `allowed`；unity(fbx)/web(glb)/print(stl) 各跑一次真实导出，回执/manifest 里的 `bake_anim` 与文件体积可复算。

## 3. 明确不吸收

| 项 | 理由 |
|---|---|
| fork Blender / 内置 agent | 与现有策略正面冲突：靠 addon 桥保持上游可升级，内置 agent 会把模型选择权从宿主拿走 |
| MCP 分发面 | 本轮是宿主插件。将来要扩覆盖面，最便宜的是**只读 MCP facade 包 `blender_inspect`+`catalog`**，而不是换传输 |
| `execute_bpy_script` 式大块执行 | `blender_py` 只是兜底，不是主路径；放开等于放弃参数校验与 `did_you_mean` |
| UI 驱动 | 与用户抢操作，收益低；取帧已够用 |
| 引擎侧插件 | 两个新仓库的维护面，超出插件边界 |
| 云端调用记录 | 零遥测是已上测试的承诺；本地 `DSH_TRAJ` 够复盘 |
| credits / 计费 | 无对应商业模式 |

## 4. 防守项（吸收时不许破坏）

1. **契约计数**：6 工具 / 35 family / 261 op / 25 注册命令（26 wire）/ 29 路由 / protocol 12 —— 改动必须同步 catalog、lock、测试、文档（`docs/architecture.md` §1）。
2. **三态判定**：`pass|fail|degraded`，`degraded ≠ pass`；`require_gate` 失败必须 `blocked`。
3. **无入站端口**：addon 拨出、Gateway 收；新账本也不许引入监听。
4. **零遥测**：新代码不得引入上报入口（有测试守着）。
5. **事务可回滚**：`blender_session(action="txn")` 的快照语义不能被新参数破坏。

## 5. 执行顺序

| 步 | 内容 | 变更面 | 完成判据 |
|---|---|---|---|
| 1（无需拍板） | 第 0 步·之一、第 0 步·之三 | 测试 + 文案 + 一篇 reference | `test:contract` 绿；新 reference 进包 |
| 2（无需拍板） | 第 0 步·之二 | `runtime/py/assembly/**/export` + catalog `key` | 单测 + 3 次真实导出 e2e |
| 3（待 决策一） | 资产/生成归口 | 见 决策一 选项 | 见 决策一 |
| 4（待 决策三） | 超时/断线兜底 | 见 决策三 选项 | 见 决策三 |

## 6. 三个待拍板项：今天到底会发生什么

> 写法：先给可复现场景与今天的真实行为（带证据行号），再给选项与代价。你只需要回 `决策一=A` 这种一行，或者说「按建议」，我按建议开工。

### 决策一 · 素材与生成要不要在插件里包好

**场景**：用户说「桌上放一把 Poly Haven 的现代椅子」。

**今天**：
1. `blender_inspect(command="search_polyhaven_assets", args={asset_type:"models", query:"chair"})` —— 能搜，前提是 N 面板里对应集成开关已打开；没开会回 `command_disabled` + 开开关指引。
2. 想下载？没有命令。addon 里 `download_polyhaven_asset`（`commands/polyhaven/download.py:15`）、`download_sketchfab_model`（`sketchfab/download.py:82`）、`download_polypizza_model`（`polypizza/download.py:60`）**实现都在，但命令没注册**；`inspect` 对它们回 `wrong_tool`，让模型「用 blender_py 自己写脚本」。
3. 于是每个会话都要现写：请求 → 解包 → `bpy.ops.import_scene.gltf` → 清场 → 单位归一。Sketchfab/Hyper3D 的 key 在 addon 偏好或环境变量里（`config.py:15-19`、`server.py:103-116`），模型脚本得自己摸进去。写错就是 traceback，写对了也可能留下 12 个未命名的空对象。

**选项**：

| 选项 | 具体动作 | 契约影响 | 估算 | 风险 |
|---|---|---|---|---|
| **A 恢复成命令 + op** | 复用现成实现，注册 `download_polyhaven_asset` / `download_sketchfab_model` / `download_polypizza_model`；op 走 `contracts.json` 表 | 注册命令 25→28，op 261→264，命令矩阵测试 +3 行 | 2–3 人日 | 协议号可不变；三处计数要同步 |
| **B 搬进 `runtime/py/asset/`** | 新 `asset` 族 3–5 op，下载器改写进 Python 域 | 261→264+，addon 不动 | 3–5 人日 | **首次让 op 层做网络 I/O**；凭据只能走宿主 env（跨进程读不到 addon 偏好），多一套配置面 |
| **C 只修文档 + 模板** | 改 8 条文案，加 `references/资产与生成.md` | 无 | 0.5 人日 | 每次仍靠模型现写脚本，失败率不可控 |

**建议 A**：代码已经写好且被老版本验证过，动的是「暴露」而不是「实现」；B 会把网络与凭据塞进本来纯计算的 op 层。
**判据**：素材获取是你项目的常规步骤 → A；一个项目只偶尔抓一次 → C 就够。

### 决策二 · 交付是一条命令还是两条

**场景**：用户说「把这个带绑定和动画的角色导出给 Unity」。

**今天**（都是可验证的行为，不是推测）：
- 引擎格式只有 `asm_export` 出（glb/fbx/obj），但它把 FBX 参数写死：`add_leaf_bones=False, bake_anim=False, apply_scale_options="FBX_SCALE_ALL"`（`assembly_impl/export/helpers.py:201-202`），GLB 固定 `export_yup=True`（同文件 :193）。
  → **动画不烘焙**。交付到 Unity/UE 后动作静默丢失；而 `asm_export` 的 verify 只校验魔数、大小、md5、空文件（`helpers.py:90-124`），**不会报这一项**。
- 带门的交付只有 `deliver_export`（obj/stl），有 `normalize / target_half_extent / manifest / require_gate`，但它**没有 fbx/glb**。
- 结果：「过了门的」和「能进引擎的」是两个不同产物，模型必须跑两次，两份 manifest 字段还不一样。

**选项**：

| 选项 | 具体动作 | 契约影响 | 估算 | 风险 |
|---|---|---|---|---|
| **A 给 `asm_export` 加 `use_case`** | 加 5 个档 + 4 个受控参数（烘焙/叶骨/缩放/Y-up）；manifest 记录实取值；`deliver_export` 保持单件口径并在文档写清分工 | 只加参数与 manifest 字段，计数不变 | 1–2 人日 | usdz 需先探 Blender USD 导出面 |
| **B 合并成单一出口** | glb/fbx writer 搬进 `deliver_export`，`asm_export` 退化为 merge 前置 | 动 8 个 asm op + 3 个 deliver op + 全套 e2e | 4–6 人日 | 重构面大，回归风险高 |
| **C 只在文档写「动画不烘焙」** | 不改代码 | 无 | 0.3 人日 | 已知缺陷继续静默 |

**建议 A**：它顺手修掉「动画静默丢失」这个真缺陷，而且 `asm_export` 已经具备 manifest/ledger/verify，不需要把管线推倒。
**判据**：近期要往引擎交付带绑定的资产 → A 立刻做；只做静态件 → C 能顶。

### 决策三 · 超时/断线后怎么避免重复写

**场景**：模型跑一个 3 分钟的批量材质脚本（30 个对象各建 4 层节点）。

**今天**：
- `blender_py` 的客户端上限 180 s（`src/tools/py/execute.ts:77`，`POST /act`）；到点宿主拿到错误，**Blender 里的脚本不会停**；
- 25 个注册命令里没有取消/中断在途执行的通道；
- 断线时在途请求直接失败且不重放（`tests/integration/js/gateway-addon-channel.test.ts:223`），但也不会告诉你「那一次到底跑完了没有」。
- 于是模型重跑 → 对象上出现两套材质槽、双倍节点；而这种脏状态 `audit_mesh` 不报（它不是网格缺陷）。

**选项**：

| 选项 | 具体动作 | 契约影响 | 估算 | 风险 |
|---|---|---|---|---|
| **A 快照兜底** | 写操作前自动 `txn snapshot`（复用 `blender_session(action="txn")`）；超时/断线回执改成 `outcome_unknown` + 「先 `txn revert` 到该 label 再重试」 | 无 | 1–2 人日 | 大场景快照耗时与磁盘占用需实测 |
| **B 请求账本** | 回执带 `request_id`，新增只读 `call_status` 查询，Gateway 存最近 N 条 | 无（查询放只读面，不加 addon 命令） | 3–4 人日 | 新增 runtime 状态；重启即失效需你认可 |
| **C 只写规则** | SKILL 加「长脚本先快照，超时先查场景不要重跑」 | 无 | 0.2 人日 | 靠模型自觉 |

**建议 A**：把「不确定」变成「可回滚」，且复用已有机制；B 更正确，但要引入新状态，等你确认「进程内、重启失效」可接受再做。
**判据**：超时重跑造成过实际损失 → A 现在做；脚本普遍 <30 s → C 够。

### 你只需要回一行

```
决策一=A  决策二=A  决策三=A        # 或者：按建议（= A/A/A）
```

不拍板也不影响 §2 的三项第一优先——它们不改任何契约计数，我可以直接开工。