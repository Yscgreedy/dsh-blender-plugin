# OCCT 后端接入计划（暂缓，未排期）

> **状态：DEFERRED（2026-11-17 存档）**。本文只记录接入方案、阶段拆分与验收门，**不代表已排期、不承诺版本**。
> 当前实现仍是纯 numpy 近似（回执 `quality:"approximate"`）；在 OCCT 后端就绪前，不要把 `surface_offset` / `surface_blend` / `surface_fit` 当 BRep 精度能力使用。
>
> 相关：[曲面算法.md](../skills/blender-modeling/references/曲面算法.md) · [flash建模上限-整合方案.md](flash建模上限-整合方案.md) · [操作教程.md](操作教程.md) · [architecture.md](architecture.md) · [CHANGELOG.md](../CHANGELOG.md)

## 0. 一页结论

| 项 | 结论 |
|---|---|
| 为什么暂缓 | 3.1.0 正式版仍欠 vision / OpenCV / 资产库；OCCT 依赖重（ABI、平台矩阵、体积、许可），且当前 numpy 近似已能跑通链路并诚实标注 |
| 现在有什么 | `surface_fit`（切环拟合，带 `residual_mm`）、`surface_offset`（顶点法线偏置，带 `verdict`/`self_intersections`）、`surface_blend`（边界环过渡面） |
| 缺什么 | BRep 精确 offset/圆角、trim、自交修复、相切连续性、约束曲面拟合 |
| 推荐后端形态 | **独立 OCCT worker 进程**（不在 Blender 内加载 native 库） |
| 推荐发行 | OCP / pythonocc-core 二选一，P0 spike 决定；默认**不随插件包分发**，按需安装 |
| 工程量 | MVP 2–3 周；完整 M5+M3 5–8 周（专注工程量），日历约 1.5–2 个月（含评审/CI） |
| 启动条件 | 产品决定 + owner + 转成 openspec change（见 §9） |

## 1. 目标与非目标

**目标**

1. 在**不改现有 op 名、不改调用方**的前提下，为 `surface_offset` / `surface_blend` / `surface_fit` 增加 `backend:"occt"` 与 `quality:"exact"` 路径。
2. 精确 offset / 圆角 / 约束拟合通过 `BRepCheck_Analyzer` 等几何检查后，回执才允许标 `quality:"exact"`。
3. OCCT 缺失、崩溃、超时、几何失败时**显式降级**（numpy 或 `degraded`/`fail`），绝不静默把近似结果标成精确。
4. 保持现有三态纪律：`pass` / `fail` / `degraded`；`degraded` 不等于通过。

**非目标**

- 不在 Blender 进程内直接加载 OCCT native 库（崩溃会带走 Blender；ABI 也被 Blender Python 版本锁死）。
- 不新增 surface op（保持 11 个 op；能力通过参数/后端字段扩展）。
- 不承诺“任意输入都能圆角成功”：OCCT 圆角在薄壁、尖角、变半径、自交输入上失败率不低。
- 不把 OCCT 结果当制造认证；仍需项目门与公差评审。

## 2. 现状与差距

| 能力 | 现实现（numpy） | OCCT 后端目标 |
|---|---|---|
| offset | 顶点法线平移；不裁剪、不消自交；尖角/凹角可能自交 | 精确等距/厚壁（`MakeOffsetShape` / `MakeThickSolid`），trim + shape healing |
| blend | 两条边界环之间的 smoothstep 过渡面；不保证相切 | BRep 圆角（`BRepFilletAPI_MakeFillet`），半径/连续性/trim |
| fit | 按 axis 切环 + 极角排序 + 等弧长重采样 | 约束曲面拟合（`GeomPlate` / `PointsToBSplineSurface`），带公差与残差 |
| 质量证据 | `quality:"approximate"`、`method`、BVH 自交、残差 | `quality:"exact"`、`BRepCheck`、体积/面积/公差、版本号 |

## 3. 关键约束与未决问题

1. **Blender Python ABI**：Blender 4.2 为 Python 3.11，Blender 5.3 为 Python 3.13（本机实测）。若在 Blender 内装绑定，必须按版本/平台出轮子；一份包通吃不了。
2. **依赖形态**：`pythonocc-core`（conda 渠道为主）、`OCP/cadquery-ocp`（pip wheel）、或系统级 OCCT + 自编译绑定。P0 spike 需要实测目标平台与 Python 版本的可用性。
3. **许可与体积**：OCCT 为 LGPL 2.1 + exception；打包需保留 notice。wheel/conda 包通常 100–300MB，不适合塞进 addon zip。
4. **平台矩阵**：Windows / Linux / macOS（含 Apple Silicon）；macOS 还需考虑签名/隔离属性。
5. **失败隔离**：OCCT 可能 crash/超时；必须放在 worker 进程，Blender/Gateway 只处理结果与超时。
6. **确定性**：同版本 OCCT 对同输入通常确定，但跨版本不保证；回执必须记录 `occt_version` / `backend_version`。
7. **输入合法性**：OCCT 需要合法 BRep；网格输入要先做缝合/修复（`ShapeFix`），否则失败归因会落在“输入不合法”而不是算法。

**待决决策**

| 决策 | 推荐 | 状态 |
|---|---|---|
| 后端形态 | 独立 worker（JSON + STEP/BREP 文件） | 未决 |
| OCCT 发行 | OCP pip wheels 优先，conda 作为 fallback | 未决 |
| 支持平台 | Windows + Linux 先行，macOS 第二阶段 | 未决 |
| 最低 OCCT 版本 | 与 OCP 版本对齐并 pin | 未决 |
| 是否随包分发 | 否；安装脚本按需拉取 | 未决 |

## 4. 架构选项

### A. Blender 内加载 OCP / pythonocc（不推荐）

- 调用链最短，无序列化。
- 但 native 库与 Blender Python ABI 强绑定；崩溃直接带走 Blender；包体积大；升级 Blender 即需重发。

### B. 独立 worker（推荐）

```text
Blender addon / backend
  └─ surface_* op（backend="auto"|"occt"）
       └─ OCCT worker（独立 Python 进程，pin 版本）
            ├─ 输入：STEP/BREP 文件 + JSON 参数
            └─ 输出：STEP/BREP + JSON 回执（verdict/defects/metrics）
```

- 优点：ABI 解耦（worker 用 3.11/3.12/3.13 任一可用环境）、崩溃隔离、可超时/重启、可无头运行。
- 代价：多一层序列化与进程管理；大模型 STEP 落盘有 IO 成本；需要 worker 生命周期与清理。

### C. 外部 CAD CLI（FreeCAD 等，不推荐）

- 代码最少，但错误保真度差、依赖更重、版本与行为不可控，难以给稳定回执。

## 5. 分阶段计划（P0–P6）

> 估算为“专注工程量”；日历含评审、CI、跨平台验证。每阶段都可独立回滚，numpy 路径始终保留。

| 阶段 | 交付物 | 验收门 | 估算 |
|---|---|---|---|
| **P0 决策 / spike** | 在 Win/Linux/macOS + 目标 Python 上实测 OCP 与 pythonocc-core 安装、导入、启动、体积；ADR（选 worker + 发行） | 两平台各一次 import + 一次 offset 冒烟；记录体积/启动时延/许可结论 | 1 周 |
| **P1 后端 seam** | `backend` / `quality` 字段、`surface_help` 口径、doctor/availability 探测；numpy 结果保持原样 | 现有 op 契约不变；缺 OCCT 时 `backend:"numpy"`；探测结果可读 | 3–5 天 |
| **P2 worker 协议** | JSON v1 请求/响应、STEP/BREP 文件交换、超时/重启/清理、`setup:occt` 安装与 `check:occt` 就绪探测 | worker 崩溃不影响 Gateway；超时回 `OCCT_TIMEOUT`；临时文件无残留 | 3–5 天 |
| **P3 精确 offset** | `MakeOffsetShape` / `MakeThickSolid`、`BRepCheck_Analyzer`、`ShapeFix`、失败码与降级 | 盒/筒/薄壁/凹槽 golden 用例；体积/bbox 在公差内；失败不冒充 pass | 1–2 周 |
| **P4 精确圆角 / blend** | `BRepFilletAPI_MakeFillet`（等半径→变半径）、trim、连续性、失败分类 | 直边/凹角/变半径用例；相切误差可测；失败码可归因 | 1–2 周 |
| **P5 约束拟合（fit）** | `GeomPlate` / `GeomAPI_PointsToBSplineSurface`、残差采样、公差与不确定性 | 点云/曲线拟合残差达标；跨截面光滑；`residual_mm` 可复核 | 约 1 周 |
| **P6 打包 / CI / 验收** | 依赖安装矩阵、版本 pin、体积/时延预算、golden 用例、跨平台 CI、文档与回滚 | 三平台 CI 绿；安装失败有明确修复命令；回滚 numpy 可一键切换 | 1–2 周 |

**总工程量**：MVP（P0–P3 + 最小 P6）约 2–3 周；完整 P0–P6 约 5–8 周。若排在 3.1.0 GA 之后启动，日历大致为 1.5–2 个月。

## 6. 接口契约（冻结形状，启动后按此实现）

保持现有函数签名，新增**可选**字段：

```text
surface_offset(spec_or_object, distance_mm, ..., backend="auto")
surface_blend(a, b, rows=16, samples=24, ..., backend="auto")
surface_fit(points, axis="z", sections=8, ring=24, ..., backend="auto")
```

回执新增/固定字段：

| 字段 | 取值 | 说明 |
|---|---|---|
| `backend` | `"numpy"` / `"occt"` | 实际执行的实现 |
| `quality` | `"approximate"` / `"exact"` | 只有通过 BRep 检查才可标 exact |
| `backend_version` | 字符串 | OCCT/OCP 版本；numpy 路径给 numpy 版本 |
| `fallback_reason` | 字符串/空 | 从 occt 降级到 numpy 的原因 |
| `verdict` | `pass` / `fail` / `degraded` | 语义不变；`degraded` 不等于通过 |
| `defects` | 数组 | 失败原因逐条（几何/内核/输入） |

错误码建议：

- `OCCT_NOT_AVAILABLE`（未安装/未就绪）
- `OCCT_INVALID_INPUT`（非法/非流形输入，先修复）
- `OCCT_OFFSET_FAILED` / `OCCT_FILLET_FAILED`
- `OCCT_TIMEOUT`（worker 超时）
- `OCCT_WORKER_CRASHED`（进程异常退出）

**降级策略**：`backend:"auto"` 只在“内核不可用/超时/崩溃”时回退 numpy，并在回执写明 `fallback_reason` + `quality:"approximate"`；几何失败（如圆角失败）**不回退成近似并标通过**，直接 `fail`/`degraded` 让调用方决定。

## 7. 测试与验收门

**单元 / 纯逻辑**

- 后端选择、字段映射、错误码、降级策略（不依赖 OCCT）。
- worker 协议序列化/反序列化、超时、临时目录清理。

**真机 golden（每平台）**

- 盒体等半径圆角（R=2/5/10mm）、圆柱 offset、薄壁（0.5mm）、凹槽/内角、变半径圆角。
- 非法输入：非流形、翻转法线、自交、单位错误（mm vs m）。
- 精确性：体积/面积/bbox/厚度与解析值比对；`BRepCheck_Analyzer` 有效；水密。
- 失败诚实性：故意让圆角失败，回执必须是 `fail` 或 `degraded`，不得 `pass`。
- 回退：卸载 OCCT 后同一调用回 `backend:"numpy"` + `fallback_reason`。
- 确定性：同版本同输入重复跑，STEP 哈希/几何指标一致（或记录允许的容差）。
- 性能：worker 冷/热启动、单次调用时延、超时；大网格先拒绝或转 job。

**契约**

- 6 tools / 38 families / 270 ops / 25 addon commands / protocol 12 不变。
- `surface_help` 与 catalog 文案同步；`quality` 语义写进 skill。
- 失败回执可被 `gate_run` 的 `pass_if` 读取（不要只给自然语言）。

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| OCCT 圆角/偏置失败率高 | 用户以为“有后端就万能” | 失败码 + `defects`；文档写明；numpy 仍可用 |
| wheel/conda 在某平台缺失 | 无法安装 | P0 spike 先验证；worker 允许独立 Python 版本 |
| 体积/下载失败 | 安装体验差 | 不随包分发；安装脚本给绝对路径与镜像说明；失败可重试 |
| worker 崩溃/泄漏 | 任务卡死 | 超时 + 重启 + 进程树清理；回执 `OCCT_WORKER_CRASHED` |
| 版本漂移 | 结果不可复现 | pin OCCT/OCP；回执记版本；CI 固定镜像 |
| 许可/合规 | 分发受阻 | LGPL notice + 法务评审；不静态链接进 addon |
| macOS 签名/隔离 | 无法加载 | 第二阶段支持；安装文档给 quarantine 处理 |
| 路径/WSL | 文件交换失败 | 复用现有 path 映射；worker 用显式临时目录 |

## 9. 启动清单（产品决定后）

1. 指定 owner 与目标版本（建议独立 minor，不混入 3.1 GA）。
2. 开 openspec change：`occt-backend`（proposal / design / tasks），把本文 §5–§7 转成任务与验收门。
3. P0 spike 出 ADR：worker 形态、OCP/pythonocc 选择、平台矩阵、体积/许可结论。
4. 预留 CI 预算（三平台 + 依赖缓存）；确定 golden 用例存放位置与基线。
5. 确定回滚策略：`backend:"numpy"` 强制开关 + 版本回退。
6. 文档/技能同步：`surface_help`、catalog、操作教程、曲面算法参考、CHANGELOG。

## 10. 启动触发条件（满足任一即可重新评估）

- 出现必须依赖 BRep 精度的交付（STEP/CAD、厚壁/抽壳、制造公差）。
- numpy 近似在真实项目中反复因自交/不相切被判 `fail`，且 fallback 无法满足验收。
- 需要把 `surface_fit` 用于带约束的工程曲面（而非切环近似）。
- 3.1.0 GA 完成，vision/OpenCV/资产库不再占用主路径。

## 11. 相关文件

- [曲面算法参考](../skills/blender-modeling/references/曲面算法.md)：现实现、回执字段与限制。
- [flash 建模上限-整合方案](flash建模上限-整合方案.md)：为什么把测量/几何/规则交给外部通路。
- [操作教程](操作教程.md) §3.5.6b：surface 调用链。
- [architecture](architecture.md)：模块边界与迁移规则。
- [CHANGELOG](../CHANGELOG.md)：版本记录（本文不改变版本）。
