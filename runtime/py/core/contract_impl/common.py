# -*- coding: utf-8 -*-
"""DSH 契约层—— 把「假设 / 区间 / 校验 / 证据 / 门控」变成机器可查的 API。

API 挂在持久内核上：K.dsh_contract_api（与 K.dsh_perf_api 同一个约定）。

基础能力：
  help()                     契约速查
  reset()                    清空契约（不动场景）
  register_component(id, objects, tags, note)      组件 = 一组对象的语义名
  register_connection(id, a, b, candidates, params, forbidden, confidence, evidence_required)
                             连接 = 两个组件之间的关系（含候选类型 / 参数区间 / 禁止项）
  register_envelope(id, min, max, scope, note)     包络 = 允许空间范围
  check_envelope(id)                               越界清单（只读）
  check_interference(scope, use_bvh, limit)        AABB 粗筛 + BVH 精查（只读）
  check_interface(conn_id, mesh, samples)          两组件间隙/侵入（bbox 级老字段不变；
                                                   mesh=True 追加真实网格量测块，只做加法）
  destructive_guard(op, targets, conn_ids)         破坏性操作门控（boolean/weld/merge/apply_transform）
  evidence(label, view)                            出图 + md5 + 记账（走端口 view_capture；提供方 render/view.py 注册）
  ledger() / status()                              证据账本 / 全局概览
  report(path)                                     生成 Markdown 报告（含判定与复现命令）

假设生命周期（三态）：
  verify(conn_id, err, tolerance, identifiable, probe_err, probe_tolerance)
      外部证据 + 探针证据 → supported / refuted / unresolved（规则见 docs/假设驱动建模-cookbook.md §5）
  flip(conn_id, to, why)      假设翻转（记历史，不删旧判定）
  advance(conn_id, status, why)  手动推进状态（proposed → testing → supported/refuted）

装配级判据（v0.9.0，全部在**真实网格**上量，不再用 bbox）：
  mate_check(conn_id, fit, nominal, tol_mm, samples, contact_max_mm, depth_eps_mm)
      配合门：面积加权采样 + BVH 最近点 → 接触面积占比 / 接触锚点 / 接触法向 / 单边间隙(mm)
      / 穿透深度(mm) → supported / refuted / unresolved（三态纪律：证据不足不许二选一）
  fit_help(fit, feature, m, d)
      装配特征库速查（读装配包 assembly_features.json，runtime/py/assembly/）：9 个配合特征 + asm_fit 四档
      + asm_lead 导向倒角 + ISO 273 间隙孔 + 「Blender 侧建议怎么造」
  interference_report(scope, use_bvh, limit, declared_ok, depth_eps, include_hidden)
      逐对干涉报告（穿透深度 mm + 重叠体积占比 + 严重度排序 + 分组 + 设计意图白名单豁免）
      —— 老 op check_interference 原样保留，返回结构不变（向后兼容）

约定：状态放 K.dsh_contract（跨调用保留）；任何"只读"检查都不会改场景。
     铁律：空产出必须 ok:false；数值必带单位（mm 口径按场景 scale_length 换算）；结论三态。
"""
import bpy, json as json, time, math as math, os

CONTRACT_VERSION = 3
# 破坏性操作清单：**判据是"会不会改拓扑/覆盖几何后对象级 mark/revert 回不去"**，不是"名字里有没有 merge"。
# 2026-11 现场（P1-6）：旧清单只有 5 个布尔合并名，于是 boolean / hole_cut / slots_cut / mirror /
# fix_repair / sculpt_setup(VOXEL) / surface_tessellate 全被"非破坏性操作，不拦"放行 —— 而 catalog 里
# class=boolean 的第一步正是 destructive_guard，护栏是假的。
DESTRUCTIVE_OPS = (
    # 布尔/合并（原有）
    "boolean_union", "boolean_difference", "boolean_intersect", "boolean",
    "weld", "merge", "join", "apply_transform", "apply_mods",
    # 切削（几何层 geo_* 的动词，含不带前缀的裸名）
    "hole_cut", "slots_cut", "mirror",
    # 修复/重构（会重写拓扑）
    "fix_repair", "sculpt_setup", "sculpt_remesh", "voxel_remesh",
    # 曲面细分/铺面
    "surface_tessellate",
    # 逐顶点改写（拓扑不变，但 **顶点级回不去**）：txn 的对象级 mark/revert 只记
    # transform / 材质槽 / 可见性 / 修改器开关，不含顶点坐标（blender_rt_txn 的边界说明
    # 明写「对象级不含拓扑/UV/顶点级改动」）。所以 sculpt_apply 与 sculpt_filter 属于
    # 「改了就回不去却没被拦」——2026-11 复审（YSC 第二条）后纳入清单。
    "sculpt_apply", "sculpt_filter",
    # 带 family 前缀的同一批 op（调用方直接拿 catalog 全名时也要拦住）
    "geo_boolean", "geo_hole_cut", "geo_slots_cut", "geo_mirror", "geo_join", "geo_apply_mods",
    "geo_sculpt_apply", "geo_sculpt_filter",
)
# v0.9.0（Procedura 融合 #8）：判定随几何失效的门限 —— 中心漂移 > 对角线 10% 或尺寸漂移 > 20%
# → 旧判定自动降级为 unresolved（上游 assembly-seed.ts 的 DRIFT_CENTER/SIZE_FRACTION）
DRIFT_CENTER_FRACTION = 0.10
DRIFT_SIZE_FRACTION = 0.20

# --- v0.9.0：装配级阈值（来源见文件下方 段的说明块；改数值必须同时改那里的理由） ---
CONTACT_SAMPLE_CAP = 4000              # 采样硬上限（上游 CONTACT_SAMPLE_CAP=4000，同口径）
CONTACT_MIN_POINTS = 8                 # 证据下限：接触点 < 8 一律 unresolved（上游 CONTACT_MIN_POINTS）
DEFAULT_CONTACT_DISTANCE_FRAC = 0.015  # 接触距离 = 1.5% × 合并 bbox 对角线（上游 DEFAULT_CONTACT_DISTANCE_FRAC）
FIT_TABLE = {"clearance": 0.25, "location": 0.15, "press": -0.05, "snap": 0.20}  # 单边 mm
FIT_DEFAULT_CLS = "location"
FIT_DEFAULT_TOL_MM = 0.15              # 默认容差（理由见 c_mate_check 文档串第 3 段）
MATE_DEPTH_EPS_MM = 0.2                # 计划内接触允许的穿透深度（理由见 c_interference_report）
MATE_MAX_TRIS = 0                      # **0 = 不设上限（默认全跑）**；显式设非 0 才在超限时 ok:false
INSIDE_MAX_TRIS = 0                    # **0 = 不设上限（默认全跑）**；显式设非 0 才在超限时报 skipped
VOL_SAMPLES = 1200                     # 重叠体积蒙特卡洛采样数（低差异序列，确定性）
VOL_MAX_TRIS = 0                       # **0 = 不设上限（默认全跑）**；显式设非 0 才在超限时只报深度
SEV_DEPTH_HIGH_MM = 2.0                # 严重度分档：深度
SEV_DEPTH_MED_MM = 0.5
SEV_FRAC_HIGH = 0.25                   # 严重度分档：体积占比
SEV_FRAC_MED = 0.02
FEATURES_JSON_NAME = "assembly_features.json"
# All supported loaders provide __file__: normal import, preloadChunk,
# injectModule, and offline_bootstrap. A missing __file__ is an injection
# contract violation, so there is no compatibility fallback here.
_HERE = os.path.dirname(os.path.abspath(__file__))
FEATURES_JSON = os.path.join(_HERE, FEATURES_JSON_NAME)


import sys as _sys_kit
_KIT = getattr(_sys_kit.modules.get("dsh_rt_kernel"), "dsh_kit", None)


def kit():
    """真实共享内核（KERNEL_BOOTSTRAP 注入的 dsh_kit）。

    与 generator / sculpt 不同：contract 要 Api / wrap_dispatch / find_runtime_file，
    **最小 kit 给不出来**，所以这里不装兜底，改成惰性 —— import 期（打包 / 静态检查 /
    第三方 import）不再炸，缺内核只在真正调用时以可读文案出现。
    """
    K = _sys_kit.modules.get("dsh_rt_kernel")
    found = getattr(K, "dsh_kit", None) if K is not None else None
    if found is None or not hasattr(found, "Api"):
        raise RuntimeError(
            "contract 需要真实共享内核（KERNEL_BOOTSTRAP 注入的 dsh_kit）。"
            "裸 python 路径请先注入 dsh_rt_kernel.dsh_kit 再调用；"
            "会话内请走 blender_op(op=\"contract_status\")。")
    return found


def _j(obj):
    """JSON 序列化（惰性取内核的 j：import 期不要求 kit 在）。"""
    return kit().j(obj)
def _kernel():
    import sys
    return sys.modules.get("dsh_rt_kernel")


def _store():
    K = _kernel()
    if K is None:
        raise RuntimeError("需要持久内核 K（走 blender_rt_* 通道）")
    if not hasattr(K, "dsh_contract"):
        K.dsh_contract = {"components": {}, "connections": {}, "envelopes": {}, "evidence": [], "log": []}
    return K.dsh_contract


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _log(action, detail):
    st = _store()
    st["log"].append({"t": _now(), "action": action, "detail": detail})
    del st["log"][:-200]


# ---------------------------------------------------------------- 组件 / 连接 / 包络

def c_reset():
    K = _kernel()
    K.dsh_contract = {"components": {}, "connections": {}, "envelopes": {}, "evidence": [], "log": []}
    return _j({"ok": True, "reset": True})
def _scope_objects(scope=None, include_hidden=False):
    out = []
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        if not include_hidden and (ob.hide_render or ob.hide_viewport):
            continue
        if scope:
            if any(str(ob.name).startswith(str(s)) for s in scope):
                out.append(ob)
        else:
            out.append(ob)
    return out
def _bbox(ob):
    from mathutils import Vector
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))
def _component_objects(cid):
    st = _store()
    comp = st["components"].get(str(cid))
    if not comp:
        return []
    return [ob for ob in (bpy.data.objects.get(n) for n in comp["objects"]) if ob is not None]


__all__ = [name for name in list(globals()) if not name.startswith("__")]
