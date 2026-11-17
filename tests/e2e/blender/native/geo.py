# -*- coding: utf-8 -*-
"""Native E2E: geometry base module (geo.py).

Ported from the archived geo_selftest.py. F2.3 removed the flat runtime/geo.py
and runtime/kit.py, so the native runner preloads the registry modules instead
of load_flat. Assertions are the same evidence keys plus ok/no-error.

v2（2026-11-17 消费方需求 R1/R5）：unit="mm" 口径、units 回执、sub_mm 警告、join 烘 matrix_world。
"""

from __future__ import annotations

import json


def test_geo_selftest(ctx):
    # The manifest preloads geo (and kit through the registry); exercising the
    # selftest is the same module body the archived case loaded by hand.
    api = ctx.api("geo")
    out = ctx.call(api, "selftest")
    evidence = out.get("evidence") or {}
    ctx.check("geo version is 2", out.get("version") == 2, out.get("version"))
    for key in sorted(evidence):
        ctx.check("geo evidence " + key, evidence[key] is True, evidence.get(key))
    ctx.check("geo ok", out.get("ok") is True, out.get("ok"))
    ctx.check("geo has no error", not out.get("error"), out.get("error"))


def _call(api, op, **kw):
    raw = api["dispatch"](op, json.dumps(kw))
    return json.loads(raw) if isinstance(raw, str) else raw


def test_geo_unit_mode(ctx):
    """R1：同一段毫米参数在 1 BU = 1 m 与 1 BU = 1 mm 两种口径下都是 120×80×6 mm。"""
    import bpy

    api = ctx.api("geo")
    scene = bpy.context.scene
    prev = float(scene.unit_settings.scale_length)
    try:
        scene.unit_settings.scale_length = 1.0
        r = _call(api, "box", size_mm=[120, 80, 6], unit="mm")
        ctx.check("R1①a：units.mm_per_bu == 1000", (r.get("units") or {}).get("mm_per_bu") == 1000.0, r.get("units"))
        ctx.check("R1①b：units.scale_length 回显 1.0", (r.get("units") or {}).get("scale_length") == 1.0, r.get("units"))
        ctx.check("R1①c：unit_mode == mm", r.get("unit_mode") == "mm", r.get("unit_mode"))
        bb = _call(api, "bbox_all", objs=[r["object"]], unit="mm")
        ctx.check("R1①d：bbox 120×80×6 mm", [round(v, 6) for v in bb["size"]] == [120.0, 80.0, 6.0], bb.get("size"))
        ctx.check("R1①e：0 退化面", (r.get("mesh_stats") or {}).get("degenerate_faces") == 0, r.get("mesh_stats"))
        ctx.check("R1①f：converted_params 点名 size_mm", "size_mm" in (r.get("converted_params") or []), r.get("converted_params"))

        scene.unit_settings.scale_length = 0.001
        r2 = _call(api, "box", size_mm=[120, 80, 6], unit="mm")
        bb2 = _call(api, "bbox_all", objs=[r2["object"]], unit="mm")
        ctx.check("R1②a：1 BU = 1 mm 下同一段参数同尺寸",
                  [round(v, 6) for v in bb2["size"]] == [120.0, 80.0, 6.0], bb2.get("size"))
        ctx.check("R1②b：units.mm_per_bu == 1", (r2.get("units") or {}).get("mm_per_bu") == 1.0, r2.get("units"))

        # 默认口径（unit 缺省）保持旧行为：场景单位
        scene.unit_settings.scale_length = 1.0
        r3 = _call(api, "box", xr=[-60, 60], yr=[-40, 40], zr=[-3, 3])
        bb3 = _call(api, "bbox_all", objs=[r3["object"]], unit="mm")
        ctx.check("R1③：unit 缺省 = bu（120000 mm，兼容旧行为）",
                  [round(v, 6) for v in bb3["size"]] == [120000.0, 80000.0, 6000.0], bb3.get("size"))

        # 亚毫米特征：0.4 mm 倒角在粗尺度必须给警告，不静默
        r4 = _call(api, "box", size_mm=[120, 80, 6], unit="mm", bevel_mm=0.4, seg=2)
        ctx.check("R1④a：sub_mm_feature 警告", r4.get("warning") == "sub_mm_feature", r4.get("warnings"))
        warn = (r4.get("warnings") or [{}])[0]
        ctx.check("R1④b：警告点名 bevel_mm 与 0.4 mm",
                  warn.get("param") == "bevel_mm" and abs(float(warn.get("mm") or 0) - 0.4) < 1e-9, warn)

        # 老调用方：直接函数调用返回 bpy 对象，不做换算
        direct = api["box"]("__e2e_direct", [0, 10], [0, 10], [0, 10])
        ctx.check("R1⑤：直接函数调用仍返回 bpy 对象", getattr(direct, "type", "") == "MESH", type(direct))
    finally:
        scene.unit_settings.scale_length = prev


def test_geo_join_bakes_world(ctx):
    """R5：linear_array 的对象级位移必须在 join 时烘进顶点（旧实现静默叠回原点）。"""
    api = ctx.api("geo")
    base = _call(api, "box", xr=[0, 4], yr=[0, 4], zr=[0, 60], coll="COL_e2e")
    arr = _call(api, "linear_array", ob=base["object"], count=8, offset=[12, 0, 0])
    ctx.check("R5①：阵列 8 件", len(arr.get("objects") or []) == 8, arr.get("objects"))
    joined = _call(api, "join", objs=arr["objects"], name="__e2e_join")
    bb = _call(api, "bbox_all", objs=[joined["object"]], unit="bu")
    ctx.check("R5②：join 后 bbox 88×4×60", [round(v, 4) for v in bb["size"]] == [88.0, 4.0, 60.0], bb.get("size"))
    ctx.check("R5③：baked_transforms = 7", joined.get("baked_transforms") == 7, joined.get("baked_transforms"))
    ctx.check("R5④：join 回执带 mesh_stats",
              isinstance(joined.get("mesh_stats"), dict)
              and joined["mesh_stats"].get("verts") == 64, joined.get("mesh_stats"))
    ctx.check("R5⑤：破坏性 op 声明 snapshot_required",
              joined.get("rollback") == "snapshot_required", joined.get("rollback"))
