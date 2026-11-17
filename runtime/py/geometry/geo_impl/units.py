# -*- coding: utf-8 -*-
"""geo 的单位口径 / 回执 / 统一 dispatch —— 从 geo.py 拆出（2026-11-17 · 消费方需求 R1/R5/R6）。

为什么单独一个文件：geo.py 已到 check:structure 的 Python 单文件 1000 行预算；这里只放
"与物品无关"的口径与回执层，geo.py 保留几何动词与 OPS 表。加载方式与其它 runtime 模块一致：
geo.py 按 __file__ 定位本文件并 exec（不登记 modules.json —— 它不是公开模块，没有 API 名）。
"""
import json

import bpy


def _j(obj):
    """统一 JSON 序列化（中文不转义；非 JSON 类型退化为 str）。"""
    return json.dumps(obj, ensure_ascii=False, default=str)


def _units():
    """mm_per_bu = scene.unit_settings.scale_length * 1000（Blender 默认 1 单位 = 1 m ⇒ 1000）。"""
    try:
        return float(bpy.context.scene.unit_settings.scale_length or 1.0) * 1000.0
    except Exception:
        return 1000.0


# dispatch 的上下文（make_dispatch 一次性填好；Blender 单线程，不存在并发写）
_CTX = {}
# ══════════════════════════════════════════════════════════════════════
# 档 A.1 · 单位口径（v1.1 / 消费方需求 2026-11-17 R1）
#
# 问题（现场）：同一段"毫米"代码在两种会话里差 1000× —— GUI 会话
# scale_length=0.001（1 BU = 1 mm），无头工厂场景 scale_length=1.0（1 BU = 1 m）。
# catalog 的 geo op 只吃"场景单位"，于是 120 mm 的板在无头里变成 120000 mm。
#
# 口径：
#   unit="bu"（默认，兼容旧行为）：坐标就是场景单位，dispatch 不做任何换算；
#   unit="mm"：调度层把**长度参数**按 mm_per_bu = scale_length × 1000 换算成 BU。
#              **不改** scene.unit_settings —— 换算是纯参数变换，落盘/会话口径不动。
#   带 _mm 后缀的参数（bevel_mm / width_mm）永远是毫米，任何 unit 下都不再换算。
#   回执固定带 units={mm_per_bu, scale_length, unit_mode}（每个 geo op）。
#   粗尺度（mm_per_bu > 10）下 < 1 mm、或任何尺度下 < 0.5 mm 的特征给
#   warning="sub_mm_feature" + warnings[{code,param,mm,bu,fix}] —— 不静默出错。
# ══════════════════════════════════════════════════════════════════════

_UNIT_MODES = ("bu", "mm")
_SUB_MM = 0.5            # 任何尺度下都算"亚毫米特征"
_SUB_MM_COARSE = 1.0     # 粗尺度下更宽的告警带
_COARSE_MM_PER_BU = 10.0
_MAX_WARNINGS = 20

_DESTRUCTIVE_OPS = ("boolean", "hole_cut", "slots_cut", "join", "apply_mods", "clear_scene")


def units_state(mode=None):
    """归一 unit 参数 → (unit_mode, mm_per_bu, scale_length)。"""
    raw = str("bu" if mode is None else mode).strip().lower()
    if raw in ("", "bu", "blender", "scene", "u"):
        raw = "bu"
    if raw not in _UNIT_MODES:
        raise ValueError("unit 只认 'mm' | 'bu'（默认 bu 保持兼容；收到 %r）" % (mode,))
    mm_per_bu = float(_units() or 1000.0)
    return raw, mm_per_bu, mm_per_bu / 1000.0


def units_receipt(mode=None):
    """当前会话的 units 回执（供脚本自查口径，不进 scene）。"""
    unit_mode, mm_per_bu, scale = units_state(mode)
    return {"mm_per_bu": round(mm_per_bu, 6), "scale_length": round(scale, 9),
            "unit_mode": unit_mode}


def _mm_feature_scan(kw):
    """unit != mm 时也要看 *_mm 参数：0.4 mm 倒角在 1 BU = 1 m 下必然退化。"""
    feats = []
    for key, value in (kw or {}).items():
        if not str(key).endswith("_mm"):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        feats.append((str(key), float(value)))
    return feats


def _convert_op_args(op, kw, mm_per_bu):
    """unit="mm"：把长度参数按 mm → BU 换算。返回 (kwargs, converted_keys, features)。"""
    k = 1.0 / float(mm_per_bu or 1000.0)
    converted = []
    feats = []

    def n(path, value):
        if isinstance(value, bool) or value is None:
            return value
        try:
            mm = float(value)
        except (TypeError, ValueError):
            return value
        feats.append((path, mm))
        return mm * k

    def pt(path, value):
        if not isinstance(value, (list, tuple)) or len(value) < 3:
            return value
        return [n(path, value[0]), n(path, value[1]), n(path, value[2])]

    def rng(path, value):
        if not isinstance(value, (list, tuple)) or len(value) < 2:
            return value
        return [n(path, value[0]), n(path, value[1])]

    def poly(path, pts):
        out = []
        for p in (pts or []):
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                out.append([n(path, p[0]), n(path, p[1])])
            else:
                out.append(p)
        return out

    if op == "box":
        for key in ("xr", "yr", "zr"):
            if key in kw:
                kw[key] = rng(key, kw[key])
        if isinstance(kw.get("size_mm"), (list, tuple)):
            kw["size_mm"] = [n("size_mm", v) for v in kw["size_mm"]]
        if isinstance(kw.get("at_mm"), (list, tuple)):
            kw["at_mm"] = [n("at_mm", v) for v in kw["at_mm"]]
    elif op == "cyl":
        for key in ("p0", "p1"):
            if key in kw:
                kw[key] = pt(key, kw[key])
        for key in ("r", "r2"):
            if key in kw:
                kw[key] = n(key, kw[key])
    elif op == "tube":
        for key in ("p0", "p1"):
            if key in kw:
                kw[key] = pt(key, kw[key])
        for key in ("r_out", "r_in"):
            if key in kw:
                kw[key] = n(key, kw[key])
    elif op == "prism":
        if "profile" in kw:
            kw["profile"] = poly("profile", kw["profile"])
        for key in ("a0", "a1"):
            if key in kw:
                kw[key] = n(key, kw[key])
    elif op == "loft":
        if "rings" in kw:
            kw["rings"] = [[pt("rings", p) for p in ring] for ring in (kw["rings"] or [])]
    elif op == "stack":
        sections = []
        for sec in (kw.get("sections") or []):
            if isinstance(sec, (list, tuple)) and len(sec) >= 2:
                sections.append([n("sections.a", sec[0]), poly("sections.pts", sec[1])])
            else:
                sections.append(sec)
        kw["sections"] = sections
    elif op == "hole_cut":
        holes = []
        for h in (kw.get("holes") or []):
            if isinstance(h, dict):
                h = dict(h)
                if "center" in h:
                    h["center"] = pt("holes.center", h["center"])
                for key in ("r", "length"):
                    if key in h:
                        h[key] = n("holes." + key, h[key])
            elif isinstance(h, (list, tuple)) and len(h) >= 3:
                h = [pt("holes.p0", h[0]), pt("holes.p1", h[1]), n("holes.r", h[2])]
            holes.append(h)
        kw["holes"] = holes
    elif op == "slots_cut":
        slots = []
        for s in (kw.get("slots") or []):
            if isinstance(s, (list, tuple)) and len(s) >= 3:
                slots.append([rng("slots.0", s[0]), rng("slots.1", s[1]), rng("slots.2", s[2])])
            else:
                slots.append(s)
        kw["slots"] = slots
    elif op == "linear_array":
        if "offset" in kw:
            kw["offset"] = pt("offset", kw["offset"])
    elif op == "quick_views":
        views = []
        for v in (kw.get("views") or []):
            if isinstance(v, dict):
                v = dict(v)
                for key in ("from", "look_at"):
                    if key in v:
                        v[key] = pt("views." + key, v[key])
                if "ortho" in v:
                    v["ortho"] = n("views.ortho", v["ortho"])
            views.append(v)
        kw["views"] = views
    if feats:
        converted.extend(sorted(set(path for path, _ in feats)))
    return kw, converted, feats


def _sub_mm_warnings(feats, mm_per_bu):
    out = []
    seen = set()
    coarse = float(mm_per_bu or 1000.0) > _COARSE_MM_PER_BU
    for path, mm in feats:
        size = abs(float(mm))
        if size <= 0.0:
            continue
        if not (size < _SUB_MM or (coarse and size < _SUB_MM_COARSE)):
            continue
        key = (str(path), round(float(mm), 9))
        if key in seen:
            continue
        seen.add(key)
        out.append({"code": "sub_mm_feature", "param": str(path), "mm": round(float(mm), 6),
                    "bu": round(float(mm) / float(mm_per_bu or 1000.0), 9),
                    "fix": "把 scene.unit_settings.scale_length 设成 0.001（1 BU = 1 mm），或把特征放大到 >= 1 mm"})
        if len(out) >= _MAX_WARNINGS:
            break
    return out


def _stamp(ob, kind, payload):
    """把一次破坏性操作的 before/after 记在对象上（回执读它，不额外算一遍）。"""
    try:
        data = dict(payload or {})
        data["kind"] = str(kind)
        ob["dsh.last_receipt"] = _j(data)
    except Exception:
        pass


def _read_stamp(ob):
    try:
        raw = ob.get("dsh.last_receipt")
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _agg_stats(objs, stats_fn):
    total = {"nonmanifold_edges": 0, "degenerate_faces": 0, "verts": 0, "faces": 0}
    for ob in (objs or []):
        try:
            s = stats_fn(ob)
        except Exception:
            continue
        for key in total:
            total[key] += int(s.get(key) or 0)
    return total


def _geo_receipt(op, out, unit_mode, mm_per_bu, feats, converted, stats_fn):
    """把 dispatch 的返回值统一成 JSON 回执：objects / mesh_stats / units / warnings。"""
    mm_per_bu = float(mm_per_bu or 1000.0)
    units = {"mm_per_bu": round(mm_per_bu, 6), "scale_length": round(mm_per_bu / 1000.0, 9),
             "unit_mode": str(unit_mode)}
    rec = {"ok": True, "op": str(op)}
    payload = None
    if isinstance(out, str):
        try:
            payload = json.loads(out)
        except Exception:
            payload = None
        if isinstance(payload, dict):
            rec.update(payload)
        else:
            rec["value"] = out
    elif isinstance(out, dict):
        rec.update(out)
    elif isinstance(out, (list, tuple)):
        objs = [o for o in out if hasattr(o, "data") and hasattr(o, "name")]
        if objs:
            rec["objects"] = [o.name for o in objs]
            rec["mesh_stats"] = _agg_stats(objs, stats_fn)
        elif out and all(hasattr(x, "bl_rna") for x in out):
            rec["value"] = [{"type": type(x).__name__, "name": getattr(x, "name", None),
                             "bl_idname": getattr(x, "bl_idname", None)} for x in out]
        else:
            rec["value"] = list(out)
    elif hasattr(out, "data") and hasattr(out, "name"):
        rec["object"] = out.name
        rec["objects"] = [out.name]
        stats = stats_fn(out) if getattr(out, "type", "") == "MESH" else None
        stamp = _read_stamp(out)
        if isinstance(stamp, dict):
            # 顶层 mesh_stats 永远是**改后**的那一份（R1 断言直接读 degenerate_faces）；
            # 破坏性 op 的 before 单独放在 mesh_stats_before（R6.3 要求前后可对账）。
            rec["mesh_stats"] = stamp.get("after") or stats
            rec["mesh_stats_before"] = stamp.get("before")
            if "baked_transforms" in stamp:
                rec["baked_transforms"] = stamp.get("baked_transforms")
        elif stats is not None:
            rec["mesh_stats"] = stats
    elif hasattr(out, "bl_rna"):
        # 集合 / 材质 / 节点这类 bpy_struct：给机器可读的身份，不要 repr
        rec["value"] = {"type": type(out).__name__, "name": getattr(out, "name", None),
                        "bl_idname": getattr(out, "bl_idname", None)}
    elif out is not None:
        rec["value"] = out
    rec.setdefault("ok", True)
    rec["units"] = units
    rec["unit_mode"] = str(unit_mode)
    if converted:
        rec["converted_params"] = list(converted)
    warnings = _sub_mm_warnings(feats, mm_per_bu)
    if warnings:
        rec["warnings"] = warnings
        rec["warning"] = "sub_mm_feature"
    if str(op) in _DESTRUCTIVE_OPS:
        rec["rollback"] = "snapshot_required"
    return rec


def _resolve_object_refs(kw):
    """JSON 只能传名字：dispatch 边界把 "A"/["A","B"] 换成 bpy 对象。

    这是 catalog op 可用性的前提 —— 直接函数调用仍可传对象（先命中 isinstance 原样返回）。
    """
    def one(v):
        if isinstance(v, str):
            return bpy.data.objects.get(v, v)
        return v

    for key in ("ob", "obj", "target", "cutter"):
        if key in kw:
            kw[key] = one(kw[key])
    if isinstance(kw.get("mat"), str):
        kw["mat"] = bpy.data.materials.get(kw["mat"], kw["mat"])
    if isinstance(kw.get("nt"), str):
        _mat = bpy.data.materials.get(kw["nt"])
        if _mat is not None:
            kw["nt"] = getattr(_mat, "node_tree", None)
    for key in ("objs", "objects"):
        if isinstance(kw.get(key), (list, tuple)):
            kw[key] = [one(x) for x in kw[key]]
    return kw


def geo_dispatch(op, args_json=None):
    """geo 的唯一 JSON 入口：unit 口径 → 换算 → 调用 → 统一回执。

    直接函数调用（K.dsh_geo_api["box"](...)）保持旧语义：返回 bpy 对象、不做换算。
    """
    name = str(op)
    kw = _CTX["kit"].flatten(args_json)
    try:
        kw = _CTX["kit"].resolve_refs(kw)
    except KeyError as e:
        return _CTX["err"]("引用解析失败: %s" % str(e)[:160], op=name)
    mode_raw = kw.pop("unit", None)
    # bbox_all 的 unit 一直是**输出**单位（老语义），输入口径走 input_unit；其余 op 的 unit 是输入口径。
    if name == "bbox_all":
        if mode_raw is not None:
            kw["unit"] = mode_raw
        mode_raw = kw.pop("input_unit", None)
    elif "out_unit" in kw:
        kw.pop("out_unit", None)
    try:
        unit_mode, mm_per_bu, _scale = units_state(mode_raw)
    except ValueError as e:
        return _CTX["err"](str(e), op=name, unit_allowed=list(_UNIT_MODES))
    kw = _resolve_object_refs(kw)
    # *_mm 参数（bevel_mm / width_mm）在任何 unit 下都是毫米 —— 先抓一遍，别让粗尺度静默退化
    feats = _mm_feature_scan(kw)
    if unit_mode == "mm":
        kw, converted, conv_feats = _convert_op_args(name, kw, mm_per_bu)
        feats.extend(conv_feats)
    else:
        converted = []
    fn = _CTX["ops"].get(name)
    if fn is None:
        return _CTX["err"]("unknown op", op=name, ops=sorted(_CTX["ops"]))
    try:
        out = fn(**kw)
    except TypeError as e:
        return _CTX["err"]("参数不匹配: %s" % str(e)[:200], op=name, given=sorted(kw))
    except Exception as e:
        return _CTX["err"]("%s: %s" % (type(e).__name__, str(e)[:300]), op=name)
    try:
        return _CTX["j"](_geo_receipt(name, out, unit_mode, mm_per_bu, feats, converted, _CTX["stats"]))
    except Exception as e:
        return _CTX["err"]("回执序列化失败: %s: %s" % (type(e).__name__, str(e)[:200]), op=name)



def make_dispatch(ops, kit, err, j_dump, stats_fn):
    """把 geo 的 OPS 表接进统一 dispatch（口径 → 换算 → 调用 → 回执）。

    为什么用闭包而不是模块级全局：geo.py 的 OPS 在文件末尾才定义，registrar 也在那里；
    闭包让"谁提供 OPS / kit / mesh_stats"一目了然，也避免 helper 模块反向依赖 geo.py。
    """
    _CTX.update({"ops": ops, "kit": kit, "err": err, "j": j_dump, "stats": stats_fn})
    return geo_dispatch
