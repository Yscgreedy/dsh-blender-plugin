# -*- coding: utf-8 -*-
"""卡通渲染：建卡通材质 + 反向外壳描边，并给出描边体检（toon_* 前缀 op，render 领域）。

ops（走 blender_op；模块尾部注册 K.dsh_toon_api）：
    toon_build(objects, collection, bands, outline_mm, colors, material_name, outline_material,
               shell, emission_strength)
        每件网格：卡通材质（Diffuse → **Shader to RGB** → ColorRamp(CONSTANT) 色阶 → Emission）
        + 反向外壳描边（Solidify：flip normals + material_offset 指到描边材质）。
    toon_outline_audit(objects, min_mm, max_mm, require_flip, require_emission, require_backface,
                       max_objects)
        逐件查：厚度 / 翻转法线 / 描边自发光 / 背面剔除 / 是否被本体吞掉（可见性估算）。
    toon_help()

判据（三态）：pass = 每一项都成立；degraded = 缺证据或只能在特定引擎成立；fail = 判据不成立。
**degraded 不是通过**（顶层 ok 只在 pass 时为 true）。

EEVEE 限制（写进每条回执的 warnings，别让模型以为 Cycles 也这样）：
  · **Shader to RGB 只在 EEVEE 生效**；Cycles 里该节点被忽略 ⇒ 色阶退化为纯 Emission（无光照带）；
  · 反向外壳依赖 **背面剔除（use_backface_culling）+ 阴影关掉**（shadow NONE），
    否则描边会自遮挡或投射错误阴影；
  · EEVEE Next（4.2+）/ 旧 EEVEE 的节点名与属性一致，但 shadow 属性名不同（shadow_method / shadow_mode）
    —— 两边都探，探不到就当 degraded，不编。

诚实边界：
  · 可见性是**估算**：把 evaluated 外壳顶点到本体顶点的最近距离与目标厚度比，超采样上限会降精度；
  · 不做描边像素级验收（那要走 qc_render_views / visualreport_report 出图对比）；
  · 无 bpy 环境一律回 degraded + repro，不抛异常。
"""
import json
import math
import sys

TOON_VERSION = 1

_K = sys.modules.get("dsh_rt_kernel")
_KIT = getattr(_K, "dsh_kit", None)
if _KIT is None:
    raise RuntimeError("toon.py 需要共享内核 K.dsh_kit（由 KERNEL_BOOTSTRAP 注入）")
_j = _KIT.j

DEFAULT_BANDS = 3
DEFAULT_OUTLINE_MM = 2.0
DEFAULT_MAIN_MATERIAL = "TOON_Main"
DEFAULT_OUTLINE_MATERIAL = "TOON_Outline"
OUTLINE_MODIFIER = "DSH_ToonOutline"
EEVEE_ENGINES = ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT")
SHADER_TO_RGB = "ShaderNodeShaderToRGB"
EMISSION = "ShaderNodeEmission"
DIFFUSE = "ShaderNodeBsdfDiffuse"
RAMP = "ShaderNodeValToRGB"
OUTPUT = "ShaderNodeOutputMaterial"


def _bpy():
    """惰性取 bpy：pytest 里可以整段 monkeypatch 掉，模块本身保持可导入。"""
    import bpy
    return bpy


# ────────────────────────────── 回执骨架 ──────────────────────────────
def _prune(**kw):
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
    return 'blender_op(op="toon_%s", args=%s)' % (op, body)


def _fail(op, msg, args=None, hint=None, **kw):
    d = {"ok": False, "op": "toon_" + op, "version": TOON_VERSION, "verdict": "fail",
         "status": "fail", "error": str(msg)[:320], "repro": _repro(op, args)}
    if hint:
        d["hint"] = str(hint)[:420]
    d.update(kw)
    return d


def _degraded(op, msg, args=None, hint=None, **kw):
    d = {"ok": False, "op": "toon_" + op, "version": TOON_VERSION, "verdict": "degraded",
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


# ────────────────────────────── 色阶 / 单位 ──────────────────────────────
def band_colors(bands=DEFAULT_BANDS, base=(0.62, 0.66, 0.78), shade=(0.10, 0.12, 0.22)):
    """深→浅的 N 级色阶（N 夹在 2..8）；纯线性插值，纯函数。"""
    count = max(2, min(int(bands or DEFAULT_BANDS), 8))
    out = []
    for index in range(count):
        t = index / (count - 1)
        out.append([round(shade[c] + (base[c] - shade[c]) * t, 4) for c in range(3)])
    return out


def ramp_stops(colors):
    """色阶 → ColorRamp 的 (position, color) 列表（等距）。"""
    count = len(colors or ())
    return [[round(index / count, 4), list(color)] for index, color in enumerate(colors or ())]


def mm_to_bu(mm, mm_per_unit=1000.0):
    """毫米 → Blender 单位；<=0 直接报错（描边厚度没有"0 也算过"这回事）。"""
    value = float(mm)
    if value <= 0:
        raise ValueError("描边厚度必须 > 0（收到 %r）" % (mm,))
    return value / float(mm_per_unit or 1000.0)


def _mm_per_unit():
    try:
        return float(_KIT.units())
    except Exception:
        return 1000.0


# ────────────────────────────── 可见性 / 审计项 ──────────────────────────────
def outline_visibility(shell_distances, thickness, sample_cap=4096):
    """外壳顶点到本体的最近距离 → 被吞进本体内部的估算比例（纯函数）。"""
    thickness = float(thickness or 0.0)
    distances = [float(d) for d in (shell_distances or ())][: int(sample_cap)]
    if not distances or thickness <= 0:
        return {"samples": len(distances), "inside": 0, "inside_fraction": None,
                "status": "degraded", "reason": "没有外壳采样或厚度为 0：可见性不可判"}
    inside = sum(1 for d in distances if d < thickness * 0.25)
    fraction = inside / len(distances)
    if fraction <= 0.05:
        status = "pass"
    elif fraction <= 0.5:
        status = "degraded"
    else:
        status = "fail"
    return {"samples": len(distances), "inside": inside, "inside_fraction": round(fraction, 4),
            "status": status,
            "reason": None if status == "pass" else
            "外壳有 %.1f%% 顶点离本体小于目标厚度的 25%%：描边被本体吞掉（厚度太小或法线朝里）"
            % (100.0 * fraction)}


def outline_checks(row, min_mm=0.5, max_mm=8.0, require_flip=True, require_emission=True,
                   require_backface=True):
    """一件描边的逐项三态（纯函数：喂 dict，不碰 bpy）。"""
    thickness = row.get("thickness_mm")
    if thickness is None:
        thickness_item = {"id": "thickness", "status": "fail", "detail": "没有 SOLIDIFY 厚度"}
    else:
        value = float(thickness)
        if value < float(min_mm) or value > float(max_mm):
            thickness_item = {"id": "thickness", "status": "fail", "mm": value,
                              "detail": "厚度 %.3f mm 越界（%.3f–%.3f mm）"
                                        % (value, float(min_mm), float(max_mm))}
        else:
            thickness_item = {"id": "thickness", "status": "pass", "mm": value,
                              "detail": "厚度 %.3f mm 在 %.3f–%.3f mm 内"
                                        % (value, float(min_mm), float(max_mm))}
    flip_item = {"id": "flip_normals",
                 "status": "pass" if row.get("flip_normals") else
                 ("fail" if require_flip else "degraded"),
                 "detail": "Solidify 翻转法线" if row.get("flip_normals") else
                           "Solidify 没翻转法线：外壳会画成本体的放大版（描边不可见）"}
    emission_item = {"id": "emission",
                     "status": "pass" if row.get("emission") else
                     ("degraded" if require_emission else "degraded"),
                     "detail": "描边材质带自发光（Emission 节点）" if row.get("emission") else
                               "描边材质没有 Emission 节点：描边会被场景光照吃掉（自发光才是描边）"}
    backface_item = {"id": "backface_culling",
                     "status": "pass" if row.get("backface_culling") else
                     ("fail" if require_backface else "degraded"),
                     "detail": "描边材质开了背面剔除" if row.get("backface_culling") else
                               "描边材质没开 use_backface_culling：外壳内壁会挡住本体"}
    visibility = row.get("visibility") or {}
    visible_item = {"id": "visibility", "status": str(visibility.get("status") or "degraded"),
                    "detail": visibility.get("reason") or "外壳可见性估算通过"}
    shadow = str(row.get("shadow") or "")
    shadow_item = {"id": "shadow", "status": "pass" if shadow.upper().endswith("NONE") else "degraded",
                   "detail": "描边不投阴影" if shadow.upper().endswith("NONE") else
                             "描边材质的 shadow 不是 NONE（%r）：会投错误阴影" % (shadow or "?",)}
    return [thickness_item, flip_item, emission_item, backface_item, visible_item, shadow_item]


# ────────────────────────────── 材质 / 节点（bpy 面） ──────────────────────────────
def _material(bpy, name):
    materials = getattr(getattr(bpy, "data", None), "materials", None)
    if materials is None:
        raise RuntimeError("bpy.data.materials 不可用")
    mat = materials.get(str(name))
    if mat is None:
        mat = materials.new(str(name))
    try:
        mat.use_nodes = True
    except Exception:
        pass
    return mat


def _node(tree, kind):
    try:
        return tree.nodes.new(kind)
    except Exception:
        return None


def _node_types(mat):
    tree = getattr(mat, "node_tree", None)
    nodes = getattr(tree, "nodes", None)
    types = []
    for node in list(nodes or ()):
        types.append(str(getattr(node, "type", "") or ""))
    return types


def _set_ramp(ramp_node, colors):
    """ColorRamp 写成 CONSTANT + N 级色阶；返回真正写进去的级数（写不动回 0）。"""
    ramp = getattr(ramp_node, "color_ramp", None) if ramp_node is not None else None
    if ramp is None:
        return 0
    try:
        ramp.interpolation = "CONSTANT"
    except Exception:
        pass
    elements = list(getattr(ramp, "elements", []) or [])
    if not elements:
        return 0
    try:
        for index, color in enumerate(colors):
            element = elements[index] if index < len(elements) else ramp.elements.new(
                index / max(1, len(colors)))
            element.position = index / max(1, len(colors))
            element.color = (color[0], color[1], color[2], 1.0)
    except Exception:
        return 0
    return len(colors)


def _build_main_material(bpy, name, colors, emission_strength=1.0):
    """卡通材质：Diffuse → Shader to RGB → ColorRamp(CONSTANT) → Emission → Output。"""
    mat = _material(bpy, name)
    tree = getattr(mat, "node_tree", None)
    if tree is None:
        return {"name": str(name), "shader_to_rgb": False, "ramp_stops": 0,
                "reason": "材质没有 node_tree（节点树不可用）"}
    diffuse = _node(tree, DIFFUSE)
    to_rgb = _node(tree, SHADER_TO_RGB)
    ramp = _node(tree, RAMP)
    emission = _node(tree, EMISSION)
    output = _node(tree, OUTPUT)
    stops = _set_ramp(ramp, colors)
    _link(tree, diffuse, to_rgb)
    _link(tree, to_rgb, ramp)
    _link(tree, ramp, emission)
    _link(tree, emission, output)
    try:
        emission.inputs["Strength"].default_value = float(emission_strength)
    except Exception:
        pass
    return {"name": str(getattr(mat, "name", name)), "shader_to_rgb": to_rgb is not None,
            "ramp_stops": stops, "ramp_interpolation": "CONSTANT",
            "nodes": [kind for kind in (DIFFUSE, SHADER_TO_RGB, RAMP, EMISSION, OUTPUT)
                      if kind in _node_types(mat)],
            "reason": None if to_rgb is not None else "Shader to RGB 节点建不出来（当前 Blender/引擎不支持）"}


def _build_outline_material(bpy, name, color=(0.02, 0.02, 0.03), emission_strength=2.0):
    """描边材质：纯 Emission（黑线）+ 背面剔除 + 不投阴影。"""
    mat = _material(bpy, name)
    tree = getattr(mat, "node_tree", None)
    emission = _node(tree, EMISSION) if tree is not None else None
    output = _node(tree, OUTPUT) if tree is not None else None
    _link(tree, emission, output)
    warnings = []
    try:
        emission.inputs["Color"].default_value = (color[0], color[1], color[2], 1.0)
        emission.inputs["Strength"].default_value = float(emission_strength)
    except Exception:
        warnings.append("描边材质颜色/强度写不进去（节点输入名变了）")
    for attr, value in (("use_backface_culling", True), ("shadow_method", "NONE"),
                        ("shadow_mode", "NONE")):
        try:
            setattr(mat, attr, value)
        except Exception:
            warnings.append("描边材质 %s 设置失败（这个 Blender 不支持该属性）" % attr)
    return {"name": str(getattr(mat, "name", name)),
            "emission": EMISSION in _node_types(mat), "warnings": warnings}


def _link(tree, a, b):
    if tree is None or a is None or b is None:
        return False
    try:
        tree.links.new(a.outputs[0], b.inputs[0])
        return True
    except Exception:
        return False


def _assign_material(ob, mat):
    """把材质塞进对象槽位；返回槽位下标（塞不进去回 None）。"""
    slots = getattr(getattr(ob, "data", None), "materials", None)
    if slots is None or mat is None:
        return None
    append = getattr(slots, "append", None)
    if callable(append):
        try:
            append(mat)
        except Exception:
            return None
    else:
        return None
    return len(slots) - 1


def _add_shell(ob, thickness_bu, material_offset):
    """Solidify 反向外壳（flip normals + material_offset 指到描边材质）。"""
    modifiers = getattr(ob, "modifiers", None)
    if modifiers is None:
        return None
    mod = modifiers.new(OUTLINE_MODIFIER, "SOLIDIFY")
    for attr, value in (("thickness", float(thickness_bu)), ("offset", 1.0),
                        ("use_flip_normals", True), ("use_rim", False),
                        ("material_offset", int(material_offset or 0))):
        try:
            setattr(mod, attr, value)
        except Exception:
            pass
    return mod


def _mesh_objects(bpy, names=None):
    pool = list(bpy.data.objects)
    if names:
        got = [bpy.data.objects.get(str(name)) for name in ([names] if isinstance(names, str) else names)]
        return [ob for ob in got if ob is not None and str(getattr(ob, "type", "")) == "MESH"]
    return [ob for ob in pool if str(getattr(ob, "type", "")) == "MESH"]


def _apply_to_object(bpy, ob, material_name, outline_material, thickness_bu, outline_mm, shell):
    """给一件网格挂卡通材质（shell=true 时再加反向外壳）；返回 (修改器行 或 None, ok, detail)。"""
    name = str(getattr(ob, "name", "?"))
    if _assign_material(ob, _material(bpy, material_name)) is None:
        return None, False, "材质槽写不进去（对象没有 data.materials）"
    if not shell:
        return None, True, None
    outline_index = _assign_material(ob, _material(bpy, outline_material))
    mod = _add_shell(ob, thickness_bu, outline_index)
    if mod is None:
        return None, False, "修改器栈不可用：描边没建"
    return {"object": name, "modifier": str(getattr(mod, "name", OUTLINE_MODIFIER)),
            "thickness_mm": round(abs(float(outline_mm)), 4),
            "flip_normals": bool(getattr(mod, "use_flip_normals", False)),
            "material_offset": int(getattr(mod, "material_offset", 0) or 0)}, True, None


def _engine_state(bpy):
    scene = getattr(getattr(bpy, "context", None), "scene", None)
    engine = str(getattr(getattr(scene, "render", None), "engine", "") or "")
    return engine, engine in EEVEE_ENGINES


def toon_build(objects=None, collection=None, bands=DEFAULT_BANDS, outline_mm=DEFAULT_OUTLINE_MM,
               colors=None, material_name=DEFAULT_MAIN_MATERIAL,
               outline_material=DEFAULT_OUTLINE_MATERIAL, shell=True, emission_strength=1.0):
    """建卡通材质 + 反向外壳描边 → 材质/修改器/描边对象清单 + EEVEE 限制 warnings。"""
    args = _prune(objects=objects, collection=collection, bands=_nd(bands, DEFAULT_BANDS),
                  outline_mm=_nd(outline_mm, DEFAULT_OUTLINE_MM), colors=colors,
                  material_name=_nd(material_name, DEFAULT_MAIN_MATERIAL),
                  outline_material=_nd(outline_material, DEFAULT_OUTLINE_MATERIAL),
                  shell=_nd(shell, True), emission_strength=_nd(emission_strength, 1.0))
    try:
        bpy = _bpy()
    except Exception as e:
        return _degraded("build", "没有 bpy：%s" % str(e)[:80], args,
                         hint="建卡通材质要在 GUI 会话里跑：blender_op(op=\"toon_build\", args={...})")
    try:
        palette = [list(c) for c in colors] if colors else band_colors(bands)
        thickness_bu = mm_to_bu(abs(float(outline_mm)), _mm_per_unit())
    except (ValueError, TypeError) as e:
        return _fail("build", str(e), args, hint="outline_mm 是毫米，必须 > 0；bands 建议 2–5")
    targets = _mesh_objects(bpy, objects)
    if not targets:
        return _fail("build", "没有可加卡通材质的网格（objects 指名的对象不存在或不是 MESH）", args,
                     hint="objects=[\"网格名\"]；不带 objects 会取全场景网格")
    engine, eevee = _engine_state(bpy)
    warnings = [
        "EEVEE 限制：Shader to RGB 只在 EEVEE 生效；Cycles 里该节点被忽略 ⇒ 色阶退化为纯 Emission（无光照带）",
        "EEVEE 限制：反向外壳依赖 use_backface_culling + 阴影 NONE，少了会自遮挡/投错阴影",
    ]
    if not eevee:
        warnings.append("当前 engine=%r 不在 EEVEE 家族里：这次建出来的色阶在渲染时不会出效果"
                        % (engine or "?"))
    main = _build_main_material(bpy, material_name, palette, emission_strength)
    outline = _build_outline_material(bpy, outline_material) if shell else None
    warnings.extend(outline["warnings"] if outline else [])
    items = [
        {"id": "engine", "status": "pass" if eevee else "degraded",
         "detail": "engine=%r（Shader to RGB 只在 EEVEE 生效）" % (engine or "?")},
        {"id": "material", "status": "pass" if main["shader_to_rgb"] else "degraded",
         "detail": main["reason"] or "卡通材质带 Shader to RGB + %d 级色阶" % main["ramp_stops"]},
    ]
    if not main["shader_to_rgb"]:
        warnings.append("Shader to RGB 节点没建出来：色阶只剩 Emission（卡通分层缺失）")
    if shell and not outline["emission"]:
        warnings.append("描边材质没有 Emission 节点：描边会被光照吃掉")
    modifiers, outline_objects = [], []
    for ob in targets:
        name = str(getattr(ob, "name", "?"))
        row, ok, detail = _apply_to_object(bpy, ob, material_name, outline_material,
                                          thickness_bu, outline_mm, shell)
        if not ok:
            items.append({"id": "mesh:" + name, "status": "degraded", "detail": detail})
            continue
        outline_objects.append(name)
        if row is not None:
            modifiers.append(row)
    agg = aggregate_verdict(items)
    return {"ok": agg["verdict"] == "pass", "op": "toon_build", "version": TOON_VERSION,
            "verdict": agg["verdict"], "status": agg["verdict"], "engine": engine,
            "eevee": bool(eevee), "items": items,
            "materials": [{"name": main["name"], "shader_to_rgb": main["shader_to_rgb"],
                           "ramp_stops": main["ramp_stops"],
                           "ramp_interpolation": main["ramp_interpolation"],
                           "colors": palette},
                          {"name": outline["name"] if outline else outline_material,
                           "emission": bool(outline and outline["emission"]),
                           "backface_culling": True}],
            "modifiers": modifiers, "outline_objects": outline_objects,
            "collection": collection, "warnings": warnings,
            "verdict_reason": "fail：%s / degraded：%s（degraded 不是通过）"
                              % (agg["failed"], agg["degraded"]),
            "repro": _repro("build", args)}


# ────────────────────────────── 描边体检 ──────────────────────────────
def _solidify(ob):
    for mod in list(getattr(ob, "modifiers", []) or []):
        if str(getattr(mod, "type", "")) == "SOLIDIFY":
            return mod
    return None


def _slots(ob):
    return list(getattr(getattr(ob, "data", None), "materials", []) or [])


def _slot_material(ob, index):
    slots = _slots(ob)
    if 0 <= int(index) < len(slots):
        return slots[int(index)]
    return None


def _outer_shell_distances(ob, depsgraph, cap=64):
    """evaluated 外壳顶点到本体顶点的最近距离（估算；取不到回空表）。"""
    getter = getattr(ob, "evaluated_get", None)
    if not callable(getter) or depsgraph is None:
        return []
    rest = [(float(v.co[0]), float(v.co[1]), float(v.co[2]))
            for v in list(getattr(getattr(ob, "data", None), "vertices", []) or [])]
    if not rest:
        return []
    ev = None
    try:
        ev = getter(depsgraph)
        me = ev.to_mesh()
        shell = [(float(v.co[0]), float(v.co[1]), float(v.co[2]))
                 for v in list(getattr(me, "vertices", []) or [])][len(rest):]
    except Exception:
        return []
    finally:
        try:
            ev.to_mesh_clear()
        except Exception:
            pass
    if not shell:
        return []
    rest_sample = rest[:400]
    distances = []
    for point in shell[: int(cap)]:
        best = min(math.dist(point, other) for other in rest_sample)
        distances.append(best)
    return distances


def _outline_row(ob, depsgraph, min_mm, max_mm, require_flip, require_emission, require_backface):
    name = str(getattr(ob, "name", "?"))
    mod = _solidify(ob)
    if mod is None:
        return {"object": name, "status": "fail",
                "items": [{"id": "solidify", "status": "fail",
                           "detail": "没有 SOLIDIFY 修改器：反向外壳不存在"}]}
    thickness_mm = round(abs(float(getattr(mod, "thickness", 0.0) or 0.0)) * _mm_per_unit(), 4)
    offset = int(getattr(mod, "material_offset", 0) or 0)
    mat = _slot_material(ob, offset)
    distances = _outer_shell_distances(ob, depsgraph)
    row = {"object": name, "modifier": str(getattr(mod, "name", "?")),
           "thickness_mm": thickness_mm,
           "flip_normals": bool(getattr(mod, "use_flip_normals", False)),
           "material": str(getattr(mat, "name", "")) if mat is not None else None,
           "emission": EMISSION in _node_types(mat) if mat is not None else False,
           "backface_culling": bool(getattr(mat, "use_backface_culling", False)) if mat else False,
           "shadow": str(getattr(mat, "shadow_method", None) or getattr(mat, "shadow_mode", ""))
           if mat is not None else "",
           "visibility": outline_visibility(distances, thickness_mm / _mm_per_unit())}
    row["items"] = outline_checks(row, min_mm, max_mm, require_flip, require_emission,
                                  require_backface)
    row["status"] = aggregate_verdict(row["items"])["verdict"]
    return row


def toon_outline_audit(objects=None, min_mm=0.5, max_mm=8.0, require_flip=True,
                       require_emission=True, require_backface=True, max_objects=20):
    """逐件描边体检：厚度 / 翻转法线 / 自发光 / 背面剔除 / 可见性 → 三态 + 证据。"""
    args = _prune(objects=objects, min_mm=_nd(min_mm, 0.5), max_mm=_nd(max_mm, 8.0),
                  require_flip=_nd(require_flip, True),
                  require_emission=_nd(require_emission, True),
                  require_backface=_nd(require_backface, True),
                  max_objects=_nd(max_objects, 20))
    try:
        bpy = _bpy()
    except Exception as e:
        return _degraded("outline_audit", "没有 bpy：%s" % str(e)[:80], args,
                         hint="描边体检要在 GUI 会话里跑（修改器与材质只有 bpy 读得到）")
    targets = _mesh_objects(bpy, objects)
    if not targets:
        return _fail("outline_audit", "没有可体检的网格（objects 指名了不存在的对象？）", args,
                     hint="objects=[\"网格名\"]；先用 toon_build 建描边再体检")
    depsgraph = None
    try:
        depsgraph = bpy.context.evaluated_depsgraph_get()
    except Exception:
        depsgraph = None
    rows = [_outline_row(ob, depsgraph, min_mm, max_mm, require_flip, require_emission,
                         require_backface) for ob in targets[: max(1, int(max_objects))]]
    items = [{"id": row["object"], "status": row["status"]} for row in rows]
    agg = aggregate_verdict(items)
    warnings = ["可见性是估算（外壳顶点到本体顶点的最近距离 vs 目标厚度）：采样 %d 个外壳顶点"
                % max((len(row.get("visibility", {}).get("samples") or []) for row in rows), default=0)]
    if agg["verdict"] != "pass":
        warnings.append("三态 = %s：failed=%s degraded=%s（degraded 不是通过）"
                        % (agg["verdict"], agg["failed"], agg["degraded"]))
    return {"ok": agg["verdict"] == "pass", "op": "toon_outline_audit", "version": TOON_VERSION,
            "verdict": agg["verdict"], "status": agg["verdict"], "objects": rows, "items": items,
            "thresholds": {"min_mm": float(min_mm), "max_mm": float(max_mm)},
            "warnings": warnings, "repro": _repro("outline_audit", args)}


def toon_help():
    return {"op": "toon_help", "version": TOON_VERSION, "ops": sorted(TOON_OPS),
            "schemas": {
                "build": "objects, collection, bands=3, outline_mm=2.0, colors=[...], "
                         "material_name, outline_material, shell=true, emission_strength=1.0",
                "outline_audit": "objects, min_mm=0.5, max_mm=8.0, require_flip=true, "
                                 "require_emission=true, require_backface=true, max_objects=20",
            },
            "verdicts": "pass / fail / degraded（degraded 不是通过；ok 只在 pass 时为 true）",
            "eevee_limits": [
                "Shader to RGB 只在 EEVEE 生效；Cycles 里色阶退化为纯 Emission（无光照带）",
                "反向外壳靠 use_backface_culling + shadow NONE；少了就是自遮挡/错阴影",
                "EEVEE Next 与旧 EEVEE 的 shadow 属性名不同（shadow_mode / shadow_method），两边都探",
            ],
            "limits": [
                "可见性是估算，不做描边像素级验收（那走 qc_render_views / visualreport_report）",
                "只处理 MESH；曲线/字体要先转网格",
                "写作用域 exclusive：改材质前先 blender_session(op=\"txn\", action=\"snapshot\")",
            ],
            "kernel": "共享内核 K.dsh_kit v%s" % getattr(_KIT, "version", "?")}


TOON_OPS = {"build": toon_build, "outline_audit": toon_outline_audit, "help": toon_help}


def toon_dispatch(op, args_json=None):
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
    handler = TOON_OPS.get(name)
    if handler is None:
        return _j({"ok": False, "op": "toon_" + name, "version": TOON_VERSION,
                   "error": "unknown toon op", "ops": sorted(TOON_OPS),
                   "hint": "允许列表里的名字才进 catalog：blender_op(op=\"catalog\", args={family:\"toon\"})",
                   "repro": _repro(name or "help", {})})
    try:
        out = handler(**kwargs)
    except TypeError as e:
        return _j(_fail(name, "参数不匹配：%s" % str(e)[:160], kwargs, hint="可用参数见 toon_help"))
    except Exception as e:
        return _j(_fail(name, "%s: %s" % (type(e).__name__, str(e)[:200]), kwargs))
    return out if isinstance(out, str) else _j(out)


# 注册（一行）：K.dsh_toon_api["build"] / K.dsh_toon_api("build", {...})
_KIT.register("toon", TOON_VERSION, {
    "build": toon_build,
    "outline_audit": toon_outline_audit,
    "help": toon_help,
}, dispatch=toon_dispatch)
