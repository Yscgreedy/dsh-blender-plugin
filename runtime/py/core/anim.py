# -*- coding: utf-8 -*-
"""角色动画体检 / pose 施加 / 变形审计（anim_* 前缀 op，core 领域）。

ops（走 blender_op；模块尾部注册 K.dsh_anim_api）：
    anim_rig_report(objects|armature, actions_limit, min_coverage)
        骨架体检：骨骼/变形骨/约束/IK/权重覆盖（顶点的非零权重组数）/动作/帧范围，逐项三态。
    anim_pose_apply(pose, armature, reset, dry_run)
        按 {bone: {location|rotation_euler|rotation_quaternion|scale}} 施 pose（写作用域 exclusive），
        回 applied / skipped + 前后通道差异。
    anim_deform_audit(objects, edge_tol, area_tol, flip_tol, max_objects)
        rest vs evaluated 变形网格：边长比 / 面面积比 / 翻转面，阈值给三态。
    anim_help()

判据（三态）：pass = 每一项都成立；degraded = 有项只能"看着像"或证据不足；fail = 判据不成立。
**degraded 不是通过**（顶层 ok 只在 pass 时为 true）。

诚实边界：
  · 权重覆盖只数「组名 ∈ 变形骨名 且 weight > 0」的顶点 —— 不判权重质量（归一化/滑动/超 4 影响）；
    顶点组可被别的东西复用，所以 coverage 是上界估计，不是绑定质量结论。
  · deform_audit 只比**同拓扑**（顶点数/面数一致）：Subsurf、阵列、布尔这类改拓扑的修改器直接判 degraded，
    不假装"量过了"；也不做自交/体积判定（那是 audit 族的活）。
  · IK 只**记录**约束，不做解算收敛判定（解算要真实 depsgraph 与逐帧推进）。
  · 无 bpy 环境（离线/pytest）一律回 degraded + repro，不抛异常。
"""
import json
import math
import sys

ANIM_VERSION = 1

_K = sys.modules.get("dsh_rt_kernel")
_KIT = getattr(_K, "dsh_kit", None)
if _KIT is None:
    raise RuntimeError("anim.py 需要共享内核 K.dsh_kit（由 KERNEL_BOOTSTRAP 注入）")
_j = _KIT.j

POSE_CHANNELS = ("location", "rotation_euler", "rotation_quaternion", "scale")
CHANNEL_LEN = {"location": 3, "rotation_euler": 3, "rotation_quaternion": 4, "scale": 3}
CHANNEL_IDENTITY = {"location": (0.0, 0.0, 0.0), "rotation_euler": (0.0, 0.0, 0.0),
                    "rotation_quaternion": (1.0, 0.0, 0.0, 0.0), "scale": (1.0, 1.0, 1.0)}
ROTATION_MODE = {"rotation_euler": "XYZ", "rotation_quaternion": "QUATERNION"}


def _bpy():
    """惰性取 bpy：pytest 里可以整段 monkeypatch 掉，模块本身保持可导入。"""
    import bpy
    return bpy


# ────────────────────────────── 回执骨架 ──────────────────────────────
def _prune(**kw):
    """回执/repro 只带**非默认**参数：{} 就是"全部走默认"，读起来才有信息量。"""
    out = {}
    for key, val in kw.items():
        if val is None or val is False or val == "":
            continue
        if isinstance(val, (list, tuple, dict)) and not val:
            continue
        out[key] = val
    return out


def _nd(value, default):
    """等于默认值就回 None —— 回执/repro 只留**显式传过**的参数。"""
    return None if value == default else value


def _repro(op, args=None):
    body = json.dumps(args or {}, ensure_ascii=False, separators=(",", ":"), default=str)
    return 'blender_op(op="anim_%s", args=%s)' % (op, body)


def _fail(op, msg, args=None, hint=None, **kw):
    d = {"ok": False, "op": "anim_" + op, "version": ANIM_VERSION, "verdict": "fail",
         "status": "fail", "error": str(msg)[:320], "repro": _repro(op, args)}
    if hint:
        d["hint"] = str(hint)[:420]
    d.update(kw)
    return d


def _degraded(op, msg, args=None, hint=None, **kw):
    d = {"ok": False, "op": "anim_" + op, "version": ANIM_VERSION, "verdict": "degraded",
         "status": "degraded", "warnings": [str(msg)[:320]], "repro": _repro(op, args)}
    if hint:
        d["hint"] = str(hint)[:420]
    d.update(kw)
    return d


def aggregate_verdict(items):
    """逐项 status → 顶层三态（fail > degraded > pass）；degraded 不进 pass。"""
    rows = list(items or [])
    states = [str(row.get("status", "degraded")) for row in rows]
    if not states:
        return {"verdict": "degraded", "failed": [], "degraded": [], "reason": "没有可判定的项"}
    failed = [row.get("id") for row in rows if row.get("status") == "fail"]
    degraded = [row.get("id") for row in rows if row.get("status") not in ("pass", "fail")]
    if failed:
        verdict = "fail"
    elif degraded:
        verdict = "degraded"
    else:
        verdict = "pass"
    return {"verdict": verdict, "failed": failed, "degraded": degraded}


# ────────────────────────────── pose 归一 ──────────────────────────────
def _num_list(value, size, where):
    if isinstance(value, bool):
        raise ValueError("%s 不能是布尔值" % where)
    if isinstance(value, (int, float)):
        return [float(value)] * size
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise ValueError("%s 需要 %d 个数（收到 %r）" % (where, size, value))
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError("%s 里必须全是数字（收到 %r）" % (where, item))
        out.append(float(item))
    return out


def normalize_pose(pose):
    """{骨名: {通道: 数值/列表}} → 归一成 float 列表；坏值 raise ValueError（带允许列表）。"""
    if not isinstance(pose, dict) or not pose:
        raise ValueError("pose 必须是非空 dict：{骨骼名: {%s}}" % "|".join(POSE_CHANNELS))
    out = {}
    for bone, channels in pose.items():
        name = str(bone or "").strip()
        if not name:
            raise ValueError("pose 里出现了空骨骼名")
        if not isinstance(channels, dict):
            raise ValueError("pose[%r] 必须是 dict（可用通道：%s）" % (bone, ", ".join(POSE_CHANNELS)))
        clean = {}
        for key, val in channels.items():
            channel = str(key)
            if channel not in POSE_CHANNELS:
                raise ValueError("pose[%r] 不认识 %r（可用通道：%s）"
                                 % (bone, key, ", ".join(POSE_CHANNELS)))
            clean[channel] = _num_list(val, CHANNEL_LEN[channel], "pose[%r].%s" % (bone, channel))
        if not clean:
            raise ValueError("pose[%r] 没有任何通道（可用通道：%s）" % (bone, ", ".join(POSE_CHANNELS)))
        out[name] = clean
    return out


def _channel_value(pbone, key):
    """从一个 pose bone 读通道（列表 → 四舍五入的 float 列表）；读不到回 None。"""
    raw = getattr(pbone, key, None)
    if raw is None:
        return None
    try:
        return [round(float(x), 6) for x in raw]
    except TypeError:
        try:
            return round(float(raw), 6)
        except (TypeError, ValueError):
            return None


def _vec_delta(before, after):
    if not before or not after or len(before) != len(after):
        return None
    return [round(b - a, 6) for a, b in zip(before, after)]


def pose_delta(before, after):
    """before/after：{骨名: {通道: 值}} → 逐通道变化行（值没变就不报）。"""
    rows = []
    for bone, channels in (after or {}).items():
        prev_bone = (before or {}).get(bone) or {}
        for key, val in channels.items():
            prev = prev_bone.get(key)
            if prev == val:
                continue
            rows.append({"bone": bone, "channel": key, "before": prev, "after": val,
                         "delta": _vec_delta(prev, val)})
    return rows


# ────────────────────────────── 权重覆盖 ──────────────────────────────
def weight_coverage(per_vertex_groups, deform_bones=(), sample=10):
    """每顶点的非零权重组名 → 覆盖率 / 未绑定顶点样本（纯函数，不碰 bpy）。"""
    bones = set(str(bone) for bone in (deform_bones or ()))
    total = weighted = 0
    max_groups = 0
    unbound = []
    for index, groups in enumerate(per_vertex_groups or ()):
        names = [str(g) for g in (groups or ()) if g]
        if bones:
            names = [name for name in names if name in bones]
        total += 1
        if names:
            weighted += 1
            max_groups = max(max_groups, len(names))
        elif len(unbound) < sample:
            unbound.append(index)
    coverage = round(weighted / total, 4) if total else 0.0
    return {"vertices": total, "weighted": weighted, "unweighted": total - weighted,
            "coverage": coverage, "max_groups": max_groups, "unbound_sample": unbound}


def coverage_status(cov, min_coverage=0.6):
    """全绑 → pass；覆盖率达到阈值但没全绑 → degraded；低于阈值 → fail；空网格 → degraded。"""
    if not (cov or {}).get("vertices"):
        return "degraded"
    if not cov.get("unweighted"):
        return "pass"
    if float(cov.get("coverage") or 0.0) >= float(min_coverage):
        return "degraded"
    return "fail"


# ────────────────────────────── 变形度量 ──────────────────────────────
def _dist(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def _poly_normal(verts, idx):
    """Newell 法：多边形法线（未归一，长度 = 2×面积）。"""
    nx = ny = nz = 0.0
    count = len(idx)
    for i in range(count):
        x1, y1, z1 = verts[idx[i]][:3]
        x2, y2, z2 = verts[idx[(i + 1) % count]][:3]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return (nx, ny, nz)


def _poly_area(verts, idx):
    nx, ny, nz = _poly_normal(verts, idx)
    return 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)


def edge_stats(rest, evaluated, edges, tol=0.05, sample=3):
    """逐边 evaluated/rest 长度比：越界计数 + 极值 + 最差样本。"""
    tol = abs(float(tol))
    ratios = []
    worst = []
    for pair in edges or ():
        a, b = int(pair[0]), int(pair[1])
        if max(a, b) >= len(rest) or max(a, b) >= len(evaluated):
            continue
        length0 = _dist(rest[a], rest[b])
        if length0 <= 1e-9:
            continue
        ratio = _dist(evaluated[a], evaluated[b]) / length0
        ratios.append(ratio)
        if abs(ratio - 1.0) > tol and len(worst) < int(sample):
            worst.append({"edge": [a, b], "ratio": round(ratio, 4)})
    outside = sum(1 for ratio in ratios if abs(ratio - 1.0) > tol)
    return {"edges": len(ratios), "outside": outside, "tol": tol,
            "min_ratio": round(min(ratios), 4) if ratios else None,
            "max_ratio": round(max(ratios), 4) if ratios else None,
            "mean_ratio": round(sum(ratios) / len(ratios), 4) if ratios else None,
            "worst": worst}


def face_stats(rest, evaluated, faces, tol=0.1, sample=3):
    """逐面面积比 + 翻转面（同一面 rest/evaluated 法线点积 < 0）。"""
    tol = abs(float(tol))
    total = outside = flipped = 0
    ratios = []
    flips = []
    worst = []
    for index, poly in enumerate(faces or ()):
        idx = [int(i) for i in poly]
        if len(idx) < 3 or max(idx) >= len(rest) or max(idx) >= len(evaluated):
            continue
        area0 = _poly_area(rest, idx)
        area1 = _poly_area(evaluated, idx)
        n0 = _poly_normal(rest, idx)
        n1 = _poly_normal(evaluated, idx)
        total += 1
        if n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0:
            flipped += 1
            if len(flips) < int(sample):
                flips.append(index)
        if area0 <= 1e-12:
            continue
        ratio = area1 / area0
        ratios.append(ratio)
        if abs(ratio - 1.0) > tol:
            outside += 1
            if len(worst) < int(sample):
                worst.append({"face": index, "ratio": round(ratio, 4)})
    return {"faces": total, "outside": outside, "flipped": flipped, "flip_sample": flips,
            "tol": tol, "min_ratio": round(min(ratios), 4) if ratios else None,
            "max_ratio": round(max(ratios), 4) if ratios else None, "worst": worst}


def deform_status(edge_row, face_row, flip_tol=0):
    """翻转面越界或任一边长/面积越界 → fail；量不到边 → degraded；否则 pass。"""
    if int(face_row.get("flipped") or 0) > int(flip_tol):
        return "fail"
    if int(edge_row.get("outside") or 0) or int(face_row.get("outside") or 0):
        return "fail"
    if not edge_row.get("edges"):
        return "degraded"
    return "pass"


# ────────────────────────────── 场景读取（bpy 面） ──────────────────────────────
def _objects(names=None, types=None):
    """按名字取对象（strict）或按类型筛全场景；返回 (got, missing)。"""
    bpy = _bpy()
    pool = list(bpy.data.objects)
    if isinstance(names, str):
        names = [names]
    if names:
        got, missing = [], []
        for name in names:
            ob = bpy.data.objects.get(str(name))
            if ob is None:
                missing.append(str(name))
                continue
            if types and str(getattr(ob, "type", "")) not in types:
                missing.append("%s(type=%s)" % (name, getattr(ob, "type", "?")))
                continue
            got.append(ob)
        return got, missing
    if types:
        pool = [ob for ob in pool if str(getattr(ob, "type", "")) in types]
    return pool, []


def _vertex_coords(me):
    out = []
    for vert in list(getattr(me, "vertices", []) or []):
        co = getattr(vert, "co", None)
        if co is None:
            co = getattr(vert, "co", [0.0, 0.0, 0.0])
        out.append((float(co[0]), float(co[1]), float(co[2])))
    return out


def _primitive_index(me, attr):
    out = []
    for row in list(getattr(me, attr, []) or []):
        out.append(tuple(int(i) for i in getattr(row, "vertices", ())))
    return out


def _evaluated_arrays(ob, depsgraph):
    """取 evaluated 网格；拿不到回 (None, [], [])（不抛，让调用方判 degraded）。"""
    getter = getattr(ob, "evaluated_get", None)
    if not callable(getter):
        return None, [], []
    ev = None
    try:
        ev = getter(depsgraph)
        me = ev.to_mesh()
    except Exception:
        return None, [], []
    try:
        return _vertex_coords(me), _primitive_index(me, "edges"), _primitive_index(me, "polygons")
    finally:
        try:
            ev.to_mesh_clear()
        except Exception:
            pass


def _vertex_group_names(ob):
    """对象 → 每顶点的"有权重"顶点组名（weight > 0）。"""
    names = [str(getattr(vg, "name", "")) for vg in list(getattr(ob, "vertex_groups", []) or [])]
    per_vertex = []
    for vert in list(getattr(getattr(ob, "data", None), "vertices", []) or []):
        groups = []
        for group in list(getattr(vert, "groups", []) or []):
            if float(getattr(group, "weight", 0.0) or 0.0) <= 0.0:
                continue
            index = int(getattr(group, "group", -1))
            if 0 <= index < len(names) and names[index]:
                groups.append(names[index])
        per_vertex.append(groups)
    return per_vertex


def _driven_by(ob, armature_name):
    for mod in list(getattr(ob, "modifiers", []) or []):
        if str(getattr(mod, "type", "")) != "ARMATURE":
            continue
        if str(getattr(getattr(mod, "object", None), "name", "")) == armature_name:
            return True
    return False


def _merged_coverage(armature, deform_names, meshes):
    total = {"vertices": 0, "weighted": 0, "unweighted": 0, "max_groups": 0,
             "coverage": 0.0, "unbound_sample": [], "meshes": []}
    for ob in meshes:
        if not _driven_by(ob, str(getattr(armature, "name", ""))):
            continue
        cov = weight_coverage(_vertex_group_names(ob), deform_names)
        total["meshes"].append(str(getattr(ob, "name", "?")))
        for key in ("vertices", "weighted", "unweighted"):
            total[key] += int(cov[key])
        total["max_groups"] = max(total["max_groups"], int(cov["max_groups"]))
        total["unbound_sample"].extend(cov["unbound_sample"][:3])
    if total["vertices"]:
        total["coverage"] = round(total["weighted"] / total["vertices"], 4)
    return total


def rig_record(arm, meshes=()):
    """一根骨架的记录：骨骼/变形骨/约束/IK/权重覆盖（假对象也能喂）。"""
    bones = list(getattr(getattr(arm, "data", None), "bones", []) or [])
    deform_names = [str(bone.name) for bone in bones if bool(getattr(bone, "use_deform", True))]
    constraints, ik_bones = {}, []
    pose_bones = list(getattr(getattr(arm, "pose", None), "bones", []) or [])
    for pbone in pose_bones:
        types = [str(getattr(con, "type", "?")) for con in list(getattr(pbone, "constraints", []) or [])]
        if not types:
            continue
        constraints[str(getattr(pbone, "name", "?"))] = types
        if "IK" in types:
            ik_bones.append(str(getattr(pbone, "name", "?")))
    return {"armature": str(getattr(arm, "name", "?")), "bones": len(bones),
            "deform_bones": len(deform_names), "deform_names": deform_names[:40],
            "constraints": constraints,
            "constraint_count": sum(len(types) for types in constraints.values()),
            "ik_bones": ik_bones, "weights": _merged_coverage(arm, deform_names, meshes)}


def _action_rows(bpy, limit=20):
    rows = []
    for action in list(getattr(getattr(bpy, "data", None), "actions", []) or [])[: int(limit)]:
        frame = getattr(action, "frame_range", None)
        rows.append({"name": str(getattr(action, "name", "?")),
                     "frame_range": [round(float(frame[0]), 3), round(float(frame[1]), 3)]
                     if frame else None})
    return rows


def _scene_frame_range(bpy):
    scene = getattr(getattr(bpy, "context", None), "scene", None)
    try:
        return [float(getattr(scene, "frame_start", 0.0)), float(getattr(scene, "frame_end", 0.0))]
    except (TypeError, ValueError):
        return [0.0, 0.0]


def rig_items(record, actions, frame_range, min_coverage=0.6, actions_limit=20):
    """一根骨架 → 逐项三态（bones / constraints / weights / actions / frame_range）。"""
    cov = record["weights"]
    weighted_note = ("%d/%d 顶点有变形骨权重（覆盖 %.1f%%）"
                     % (cov["weighted"], cov["vertices"], 100.0 * float(cov.get("coverage") or 0.0)))
    items = [
        {"id": "bones", "status": "pass" if record["bones"] else "fail",
         "bones": record["bones"], "deform_bones": record["deform_bones"],
         "detail": "骨架 %s 有 %d 根骨（其中 %d 根参与变形）"
                   % (record["armature"], record["bones"], record["deform_bones"])},
        {"id": "constraints", "status": "pass", "count": record["constraint_count"],
         "by_bone": record["constraints"], "ik_bones": record["ik_bones"],
         "detail": "约束 %d 个（IK 骨 %d 根；本项只记录，不做解算收敛判定）"
                   % (record["constraint_count"], len(record["ik_bones"]))},
        {"id": "weights", "status": coverage_status(cov, min_coverage),
         "vertices": cov["vertices"], "weighted": cov["weighted"],
         "unweighted": cov["unweighted"], "coverage": cov["coverage"],
         "max_groups": cov["max_groups"], "unbound_sample": cov["unbound_sample"],
         "meshes": cov["meshes"], "detail": weighted_note if cov["vertices"] else
         "没有受这根骨架驱动的网格：权重覆盖无从判定"},
        {"id": "actions", "status": "pass" if actions else "degraded", "count": len(actions),
         "sample": actions[: int(actions_limit)],
         "detail": "动作 %d 条" % len(actions) if actions else "没有 action：动画数据不在这个 .blend"},
        {"id": "frame_range", "status": "pass" if frame_range and frame_range[1] > frame_range[0]
         else "degraded", "range": list(frame_range or []),
         "detail": "场景帧范围 %s" % (list(frame_range or []) or "空")},
    ]
    return items


def _rig_warnings(records, agg):
    warnings = []
    if agg["verdict"] != "pass":
        warnings.append("三态 = %s：failed=%s degraded=%s（degraded 不是通过）"
                        % (agg["verdict"], agg["failed"], agg["degraded"]))
    for record in records:
        if record["ik_bones"]:
            warnings.append("%s：IK 约束只记录不解算（%s）"
                            % (record["armature"], record["ik_bones"][:5]))
        if not record["weights"]["meshes"]:
            warnings.append("%s：没有网格挂 Armature 修改器 —— 权重覆盖项不可判" % record["armature"])
    return warnings


def anim_rig_report(objects=None, armature=None, actions_limit=20, min_coverage=0.6):
    """骨架/骨骼/约束/IK/权重覆盖/动作/帧范围 → 逐项三态。"""
    args = _prune(objects=objects, armature=armature,
                  actions_limit=_nd(actions_limit, 20), min_coverage=_nd(min_coverage, 0.6))
    try:
        bpy = _bpy()
    except Exception as e:
        return _degraded("rig_report", "没有 bpy：%s" % str(e)[:80], args,
                         hint="骨架体检要在 GUI 会话里跑：blender_op(op=\"anim_rig_report\", args={...})")
    targets, missing = _objects(armature or objects, ("ARMATURE",))
    if not targets:
        every = [str(getattr(ob, "name", "?")) for ob in list(bpy.data.objects)]
        return _fail("rig_report", "没有可体检的骨架：objects/armature 指到的对象不是 ARMATURE",
                     args, missing=missing, objects=every[:20],
                     hint="先 blender_op(op=\"catalog\", args={family:\"anim\"})；ARMATURE 对象名可用 "
                          "audit_scene 或 blender_inspect 列出，armature=\"名字\" 指名")
    meshes = [ob for ob in list(bpy.data.objects) if str(getattr(ob, "type", "")) == "MESH"]
    actions = _action_rows(bpy, actions_limit)
    frame_range = _scene_frame_range(bpy)
    items, records = [], []
    for arm in targets:
        record = rig_record(arm, meshes)
        records.append(record)
        for item in rig_items(record, actions, frame_range, min_coverage, actions_limit):
            items.append(dict(item, armature=record["armature"]))
    agg = aggregate_verdict(items)
    out = {"ok": agg["verdict"] == "pass", "op": "anim_rig_report", "version": ANIM_VERSION,
           "verdict": agg["verdict"], "status": agg["verdict"], "items": items, "rigs": records,
           "missing": missing,
           "scene": {"actions": len(actions), "frame_range": list(frame_range)},
           "warnings": _rig_warnings(records, agg),
           "min_coverage": float(min_coverage), "repro": _repro("rig_report", args)}
    if agg["verdict"] != "pass":
        out["verdict_reason"] = ("fail：%s / degraded：%s（degraded 不是通过）"
                                 % (agg["failed"], agg["degraded"]))
    return out


def _pose_verdict(applied, skipped, diff, dry_run):
    if not applied:
        return "fail", "一个骨骼都没施上（见 skipped）"
    if dry_run:
        return "degraded", "dry_run：只算计划，没改骨架"
    if skipped:
        return "degraded", "有骨骼被跳过（见 skipped）"
    if not diff:
        return "degraded", "值本来就是这样，没有任何通道改变"
    return "pass", "全部骨骼按计划改变"


def _apply_channels(pbone, channels):
    """把一路通道写到 pose bone；失败回错误串（rotation 同时钉 rotation_mode）。"""
    for key, val in channels.items():
        mode = ROTATION_MODE.get(key)
        try:
            if mode:
                setattr(pbone, "rotation_mode", mode)
            setattr(pbone, key, list(val))
        except Exception as e:
            return "设置 %s 失败：%s" % (key, str(e)[:80])
    return None


def anim_pose_apply(pose=None, armature=None, reset=False, dry_run=False):
    """按 {骨名: {通道: 值}} 施 pose（写作用域 exclusive）→ applied/skipped + 前后差异。"""
    args = _prune(pose=pose, armature=armature, reset=reset, dry_run=dry_run)
    if pose is None:
        return _fail("pose_apply", "缺 pose 参数", args,
                     hint="形状：{骨骼名: {location:[x,y,z] | rotation_euler:[x,y,z] | "
                          "rotation_quaternion:[w,x,y,z] | scale:[x,y,z]}}")
    try:
        plan = normalize_pose(pose)
    except ValueError as e:
        return _fail("pose_apply", str(e), args,
                     hint="允许通道：%s；改前先 blender_session(op=\"txn\", action=\"snapshot\")"
                          % ", ".join(POSE_CHANNELS))
    try:
        bpy = _bpy()
    except Exception as e:
        return _degraded("pose_apply", "没有 bpy：%s" % str(e)[:80], args,
                         hint="pose 施加必须在 GUI 会话里跑")
    targets, missing = _objects(armature, ("ARMATURE",))
    if not targets:
        return _fail("pose_apply", "没找到骨架（armature 没指名或类型不是 ARMATURE）", args,
                     missing=missing, hint="armature=\"骨架对象名\" 指名；多骨架时必须指名")
    if len(targets) > 1:
        return _fail("pose_apply", "匹配到 %d 个骨架：请用 armature 指名一个" % len(targets), args,
                     armatures=[str(getattr(ob, "name", "?")) for ob in targets])
    arm = targets[0]
    pbones = {str(getattr(pb, "name", "")): pb
              for pb in list(getattr(getattr(arm, "pose", None), "bones", []) or [])}
    warnings = []
    if reset and not dry_run:
        for bone in plan:
            pbone = pbones.get(bone)
            if pbone is None:
                continue
            for key, identity in CHANNEL_IDENTITY.items():
                try:
                    setattr(pbone, key, list(identity))
                except Exception:
                    warnings.append("%s 复位 %s 失败（忽略）" % (bone, key))
    before, after, applied, skipped = {}, {}, [], []
    for bone, channels in plan.items():
        pbone = pbones.get(bone)
        if pbone is None:
            skipped.append({"bone": bone, "reason": "骨架里没有这个 pose bone"})
            continue
        before[bone] = {key: _channel_value(pbone, key) for key in channels}
        if dry_run:
            applied.append(bone)
            after[bone] = dict(before[bone])
            continue
        error = _apply_channels(pbone, channels)
        if error:
            skipped.append({"bone": bone, "reason": error})
            continue
        applied.append(bone)
        after[bone] = {key: _channel_value(pbone, key) for key in channels}
    diff = pose_delta(before, after)
    verdict, reason = _pose_verdict(applied, skipped, diff, dry_run)
    return {"ok": verdict == "pass", "op": "anim_pose_apply", "version": ANIM_VERSION,
            "verdict": verdict, "status": verdict, "armature": str(getattr(arm, "name", "?")),
            "applied": applied, "skipped": skipped, "diff": diff,
            "before": before, "after": after, "dry_run": bool(dry_run), "reset": bool(reset),
            "verdict_reason": reason, "warnings": warnings, "repro": _repro("pose_apply", args)}


def _deform_row(ob, depsgraph, edge_tol, area_tol):
    name = str(getattr(ob, "name", "?"))
    me = getattr(ob, "data", None)
    rest_verts = _vertex_coords(me)
    rest_edges = _primitive_index(me, "edges")
    rest_faces = _primitive_index(me, "polygons")
    ev_verts, ev_edges, ev_faces = _evaluated_arrays(ob, depsgraph)
    if ev_verts is None:
        return {"object": name, "status": "degraded", "reason": "取不到 evaluated 网格（对象可能被隐藏/禁用）"}
    if len(ev_verts) != len(rest_verts) or len(ev_faces) != len(rest_faces):
        return {"object": name, "status": "degraded",
                "reason": "拓扑不一致（rest %d 顶点/%d 面，evaluated %d 顶点/%d 面）："
                          "修改器改了拓扑，rest-evaluated 逐元素比对不适用"
                          % (len(rest_verts), len(rest_faces), len(ev_verts), len(ev_faces)),
                "rest": {"vertices": len(rest_verts), "faces": len(rest_faces)},
                "evaluated": {"vertices": len(ev_verts), "faces": len(ev_faces)}}
    edge_row = edge_stats(rest_verts, ev_verts, ev_edges or rest_edges, edge_tol)
    face_row = face_stats(rest_verts, ev_verts, ev_faces or rest_faces, area_tol)
    return {"object": name, "status": deform_status(edge_row, face_row, 0),
            "edges": edge_row, "faces": face_row}


def anim_deform_audit(objects=None, edge_tol=0.05, area_tol=0.1, flip_tol=0, max_objects=40):
    """rest vs evaluated：边长比 / 面面积比 / 翻转面 → 逐对象三态。"""
    args = _prune(objects=objects, edge_tol=_nd(edge_tol, 0.05), area_tol=_nd(area_tol, 0.1),
                  flip_tol=_nd(flip_tol, 0), max_objects=_nd(max_objects, 40))
    try:
        bpy = _bpy()
    except Exception as e:
        return _degraded("deform_audit", "没有 bpy：%s" % str(e)[:80], args,
                         hint="变形审计要在 GUI 会话里跑（evaluated mesh 只有 bpy 给得出）")
    targets, missing = _objects(objects, ("MESH",))
    if not targets:
        return _fail("deform_audit", "没有可审计的网格（objects 指名了不存在的对象？）", args,
                     missing=missing, hint="objects=[\"网格名\"]；不带 objects 会取全场景（最多 max_objects 个）")
    limit = max(1, int(max_objects))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    rows = [_deform_row(ob, depsgraph, edge_tol, area_tol) for ob in targets[:limit]]
    items = [{"id": row["object"], "status": row["status"], "reason": row.get("reason")}
             for row in rows]
    agg = aggregate_verdict(items)
    warnings = ["拓扑不一致的对象是 degraded，不是 pass：%s"
                % [row["object"] for row in rows if row["status"] == "degraded"]
                ] if any(row["status"] == "degraded" for row in rows) else []
    if any(int((row.get("faces") or {}).get("flipped") or 0) > int(flip_tol) for row in rows):
        warnings.append("有翻转面：法线朝向被 deformation 翻过去了（先查镜像/负缩放/绕序）")
    return {"ok": agg["verdict"] == "pass", "op": "anim_deform_audit", "version": ANIM_VERSION,
            "verdict": agg["verdict"], "status": agg["verdict"], "objects": rows, "items": items,
            "missing": missing, "thresholds": {"edge_tol": float(edge_tol),
                                               "area_tol": float(area_tol),
                                               "flip_tol": int(flip_tol)},
            "verdict_reason": "fail：%s / degraded：%s（degraded 不是通过）"
                              % (agg["failed"], agg["degraded"]),
            "warnings": warnings, "repro": _repro("deform_audit", args)}


def anim_help():
    return {"op": "anim_help", "version": ANIM_VERSION, "ops": sorted(ANIM_OPS),
            "schemas": {
                "rig_report": "objects|armature, actions_limit=20, min_coverage=0.6",
                "pose_apply": "pose={骨名: {location|rotation_euler|rotation_quaternion|scale: 数值或列表}}, "
                              "armature, reset=false, dry_run=false",
                "deform_audit": "objects, edge_tol=0.05, area_tol=0.1, flip_tol=0, max_objects=40",
            },
            "verdicts": "pass / fail / degraded（degraded 不是通过；ok 只在 pass 时为 true）",
            "limits": [
                "权重覆盖是上界估计（顶点组可能被别的东西复用），不判权重质量",
                "deform_audit 只比同拓扑；改拓扑的修改器直接 degraded",
                "IK 只记录约束，不做解算收敛判定",
                "写作用域 exclusive：pose_apply 改场景前先 blender_session(op=\"txn\", action=\"snapshot\")",
            ],
            "kernel": "共享内核 K.dsh_kit v%s" % getattr(_KIT, "version", "?")}


ANIM_OPS = {"rig_report": anim_rig_report, "pose_apply": anim_pose_apply,
            "deform_audit": anim_deform_audit, "help": anim_help}


def anim_dispatch(op, args_json=None):
    """标准 dispatch：解析 → 摊平 → 查表；失败回执一律带 repro。"""
    payload = args_json
    if isinstance(payload, str):
        try:
            payload = json.loads(payload) if payload.strip() else {}
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    kwargs = {}
    for key, val in payload.items():
        if key == "args" and isinstance(val, dict):
            kwargs.update(val)
        else:
            kwargs[key] = val
    name = str(op or "")
    handler = ANIM_OPS.get(name)
    if handler is None:
        return _j({"ok": False, "op": "anim_" + name, "version": ANIM_VERSION,
                   "error": "unknown anim op", "ops": sorted(ANIM_OPS),
                   "hint": "允许列表里的名字才进 catalog：blender_op(op=\"catalog\", args={family:\"anim\"})",
                   "repro": _repro(name or "help", {})})
    try:
        out = handler(**kwargs)
    except TypeError as e:
        return _j(_fail(name, "参数不匹配：%s" % str(e)[:160], kwargs,
                        hint="可用参数见 anim_help"))
    except Exception as e:
        return _j(_fail(name, "%s: %s" % (type(e).__name__, str(e)[:200]), kwargs))
    return out if isinstance(out, str) else _j(out)


# 注册（一行）：K.dsh_anim_api["rig_report"] / K.dsh_anim_api("rig_report", {...})
_KIT.register("anim", ANIM_VERSION, {
    "rig_report": anim_rig_report,
    "pose_apply": anim_pose_apply,
    "deform_audit": anim_deform_audit,
    "help": anim_help,
}, dispatch=anim_dispatch)
