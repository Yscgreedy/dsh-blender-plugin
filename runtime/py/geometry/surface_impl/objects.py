# -*- coding: utf-8 -*-
"""Split from surface_orig.py; behavior preserved by the facade."""
from .common import *  # noqa: F401,F403
from .advmath import blend_rings, resample_ring
from .build import surface_mesh_data

# ────────────────────────────── 对象创建（bmesh，不碰 bpy.ops） ──────────────────────────────
def _coll(name=None):
    nm = str(name or DEFAULT_COLL).strip() or DEFAULT_COLL
    c = bpy.data.collections.get(nm)
    if c is None:
        c = bpy.data.collections.new(nm)
        bpy.context.scene.collection.children.link(c)
    return c


def _bbox_mm(verts_mm):
    V = np.asarray(verts_mm, dtype=np.float64)
    if V.size == 0:
        return {"min_mm": None, "max_mm": None, "size_mm": None, "center_mm": None}
    lo = V.min(axis=0)
    hi = V.max(axis=0)
    return {"min_mm": [_r(x, 4) for x in lo], "max_mm": [_r(x, 4) for x in hi],
            "size_mm": [_r(x, 4) for x in (hi - lo)],
            "center_mm": [_r(x, 4) for x in ((hi + lo) / 2.0)]}


def _create_object(mesh_data, kind, norm, name=None, collection=None):
    """内存网格（mm）→ bmesh 网格对象（Blender 单位）；返回 (object, info)。"""
    import bmesh
    mmu = max(_mmu(), 1e-12)
    verts_u = np.asarray(mesh_data["verts_mm"], dtype=np.float64) / mmu
    faces = mesh_data["faces"]
    nm = str(name or "").strip() or (PFX + "%s_%s" % (kind, str(norm.get("spec_hash") or "nohash")[:8]))
    nm = nm.replace("\n", " ").strip()[:120]
    me = bpy.data.meshes.new(nm)
    bm = bmesh.new()
    made_faces = 0
    try:
        bverts = [bm.verts.new((float(v[0]), float(v[1]), float(v[2]))) for v in verts_u.tolist()]
        bm.verts.ensure_lookup_table()
        for f in faces:
            try:
                bm.faces.new([bverts[int(i)] for i in f])
                made_faces += 1
            except ValueError:
                continue
        bm.normal_update()
        bm.to_mesh(me)
    finally:
        bm.free()
    if made_faces == 0:
        bpy.data.meshes.remove(me, do_unlink=True)
        raise ValueError("没有任何有效 face（截面/剖面退化？）")
    ob = bpy.data.objects.new(nm, me)
    coll = _coll(collection)
    coll.objects.link(ob)
    try:
        ob["surface.kind"] = kind
        ob["surface.version"] = int(SURFACE_VERSION)
        ob["surface.spec_hash"] = str(norm.get("spec_hash") or "")
        ob["surface.tessellation"] = json.dumps(norm.get("tessellation") or {}, ensure_ascii=False)
        ob["dsh.surface"] = "%s:%s" % (kind, str(norm.get("spec_hash") or "")[:12])
    except Exception:
        pass
    info = {"object": str(ob.name), "collection": str(coll.name), "mesh": str(me.name),
            "verts": int(len(me.vertices)), "tris": int(sum(max(0, len(p.vertices) - 2) for p in me.polygons)),
            "faces": int(len(me.polygons)), "bbox_mm": _bbox_mm(mesh_data["verts_mm"])}
    return ob, info


def _spec_summary(norm):
    d = {k: v for k, v in (norm or {}).items() if not str(k).startswith("_")}
    return d


def _build_from_norm(norm, name=None, collection=None):
    md = surface_mesh_data(norm)
    ob, info = _create_object(md, str(norm["kind"]), norm, name=name, collection=collection)
    return ob, info, md


def _op_ok(kind, norm, md, info, t0, extra=None):
    body = {"ok": True, "kind": kind, "object": info["object"], "collection": info["collection"],
            "mesh": info["mesh"], "verts": info["verts"], "tris": info["tris"],
            "bbox_mm": info["bbox_mm"], "spec_hash": norm["spec_hash"],
            "tessellation": norm["tessellation"], "meta": md["meta"],
            "spec": _spec_summary(norm),
            "note": "尺寸单位 mm（内部已按 scene.unit_settings 折算）；同 spec+tessellation 可复现"}
    if extra:
        body.update(extra)
    return _j(_receipt(body, t0))


# ────────────────────────────── M1 公开 op ──────────────────────────────
def surface_loft(sections=None, degree=3, continuity="G1", closed=False, tessellation=None,
                 name=None, collection=None, constraints=None, units="mm", spec=None):
    """Bézier/B-spline 截面放样：sections=[{z_mm, points_mm:[[x,y],...]}] → bmesh 网格对象。"""
    t0 = time.perf_counter()
    raw = spec if isinstance(spec, dict) else {
        "kind": "loft", "units": units, "sections": sections, "degree": degree,
        "continuity": continuity, "closed": closed, "tessellation": tessellation,
        "constraints": constraints}
    norm, errs = surface_spec_normalize(raw)
    if errs:
        return _err("loft spec 校验失败", errors=errs[:12], stage="M0",
                    hint="sections 至少 2 个、z_mm 严格递增、points_mm 为 [[x,y],...]（closed=True 时 ≥3 点）")
    try:
        ob, info, md = _build_from_norm(norm, name=name, collection=collection)
    except Exception as e:
        import traceback
        return _err("loft 生成失败: %s: %s" % (type(e).__name__, str(e)[:240]), stage="M1",
                    traceback=traceback.format_exc()[-600:])
    return _op_ok("loft", norm, md, info, t0,
                  {"degree_used": md["meta"].get("degree_used")})


def surface_sweep(profile_mm=None, rail_mm=None, orientation="auto", twist_deg=0.0,
                  scale=1.0, tessellation=None, name=None, collection=None, closed=False,
                  constraints=None, units="mm", spec=None):
    """沿折线扫掠：profile_mm 二维截面 + rail_mm 三维路径 → bmesh 网格对象。"""
    t0 = time.perf_counter()
    raw = spec if isinstance(spec, dict) else {
        "kind": "sweep", "units": units, "profile_mm": profile_mm, "rail_mm": rail_mm,
        "orientation": orientation, "twist_deg": twist_deg, "scale": scale,
        "tessellation": tessellation, "closed": closed, "constraints": constraints}
    norm, errs = surface_spec_normalize(raw)
    if errs:
        return _err("sweep spec 校验失败", errors=errs[:12], stage="M0",
                    hint="profile_mm 至少 3 点（closed 环）、rail_mm 至少 2 个非重复 [x,y,z]")
    try:
        ob, info, md = _build_from_norm(norm, name=name, collection=collection)
    except Exception as e:
        import traceback
        return _err("sweep 生成失败: %s: %s" % (type(e).__name__, str(e)[:240]), stage="M1",
                    traceback=traceback.format_exc()[-600:])
    return _op_ok("sweep", norm, md, info, t0, {"meta_extra": md["meta"]})


def surface_patch(control_grid=None, degree_u=3, degree_v=3, tessellation=None, name=None,
                  collection=None, constraints=None, units="mm", spec=None):
    """四边 B-spline 面片：control_grid=[[[x,y,z],...],...]（行=u，列=v）→ bmesh 网格对象。"""
    t0 = time.perf_counter()
    raw = spec if isinstance(spec, dict) else {
        "kind": "patch", "units": units, "control_grid": control_grid,
        "degree_u": degree_u, "degree_v": degree_v, "tessellation": tessellation,
        "constraints": constraints}
    norm, errs = surface_spec_normalize(raw)
    if errs:
        return _err("patch spec 校验失败", errors=errs[:12], stage="M0",
                    hint="control_grid 必须是矩形（≥2×2），degree_u/v 不得超过对应方向控制点数-1")
    try:
        ob, info, md = _build_from_norm(norm, name=name, collection=collection)
    except Exception as e:
        import traceback
        return _err("patch 生成失败: %s: %s" % (type(e).__name__, str(e)[:240]), stage="M1",
                    traceback=traceback.format_exc()[-600:])
    return _op_ok("patch", norm, md, info, t0)


def _object_eval_mesh(ob):
    """对象 → 求值后网格（顶点为 Blender 单位世界坐标，含对象变换与修改器）。"""
    dg = bpy.context.evaluated_depsgraph_get()
    obe = ob.evaluated_get(dg)
    me = obe.to_mesh()
    try:
        if me is None:
            raise ValueError("对象没有可求值网格")
        me.calc_loop_triangles()
        nv = len(me.vertices)
        v = np.empty(nv * 3, dtype=np.float64)
        me.vertices.foreach_get("co", v)
        v = v.reshape(-1, 3)
        mw = np.array(obe.matrix_world, dtype=np.float64)
        v = v @ mw[:3, :3].T + mw[:3, 3]
        idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", idx)
        idx = idx.reshape(-1, 3)
        return {"verts": v, "tris": idx}
    finally:
        try:
            obe.to_mesh_clear()
        except Exception:
            pass


def surface_tessellate(spec_or_object=None, quality="normal", name=None, collection=None,
                       tessellation=None, spec=None):
    """曲面规格或对象 → 网格对象（规格走 M1 生成；对象=烘焙求值网格/应用修改器）。"""
    t0 = time.perf_counter()
    src = spec if isinstance(spec, dict) else spec_or_object
    if isinstance(src, dict):
        spec_obj = dict(src)
        if tessellation is not None:
            spec_obj["tessellation"] = tessellation
        elif spec_obj.get("tessellation") is None and quality:
            spec_obj["tessellation"] = str(quality)
        norm, errs = surface_spec_normalize(spec_obj)
        if errs:
            return _err("tessellate spec 校验失败", errors=errs[:12], stage="M0")
        try:
            ob, info, md = _build_from_norm(norm, name=name, collection=collection)
        except Exception as e:
            return _err("tessellate 生成失败: %s: %s" % (type(e).__name__, str(e)[:240]), stage="M1")
        return _j(_receipt({"ok": True, "mode": "spec", "object": info["object"],
                            "collection": info["collection"], "verts": info["verts"],
                            "tris": info["tris"], "bbox_mm": info["bbox_mm"],
                            "spec_hash": norm["spec_hash"], "tessellation": norm["tessellation"],
                            "meta": md["meta"], "spec": _spec_summary(norm)}, t0))
    if isinstance(src, str):
        ob = bpy.data.objects.get(src)
        if ob is None or ob.type != "MESH":
            return _err("对象不存在或不是 mesh: %r" % src, stage="M0")
        try:
            baked = _object_eval_mesh(ob)
        except Exception as e:
            return _err("对象求值失败: %s: %s" % (type(e).__name__, str(e)[:200]), stage="M1")
        import bmesh
        mmu = max(_mmu(), 1e-12)
        nm = str(name or (str(ob.name) + "_tess"))
        me = bpy.data.meshes.new(nm)
        bm = bmesh.new()
        try:
            bv = [bm.verts.new(tuple(v)) for v in baked["verts"].tolist()]
            bm.verts.ensure_lookup_table()
            for tri in baked["tris"]:
                try:
                    bm.faces.new([bv[int(i)] for i in tri])
                except ValueError:
                    continue
            bm.normal_update()
            bm.to_mesh(me)
        finally:
            bm.free()
        nob = bpy.data.objects.new(nm, me)
        coll = _coll(collection)
        coll.objects.link(nob)
        try:
            nob["surface.kind"] = "tessellated"
            nob["surface.source"] = str(ob.name)
            nob["surface.version"] = int(SURFACE_VERSION)
        except Exception:
            pass
        verts_mm = baked["verts"] * mmu
        info = {"object": str(nob.name), "collection": str(coll.name), "mesh": str(me.name),
                "verts": int(len(me.vertices)),
                "tris": int(sum(max(0, len(p.vertices) - 2) for p in me.polygons)),
                "bbox_mm": _bbox_mm(verts_mm)}
        return _j(_receipt({"ok": True, "mode": "object_bake", "source": str(ob.name),
                            "object": info["object"], "collection": info["collection"],
                            "verts": info["verts"], "tris": info["tris"],
                            "bbox_mm": info["bbox_mm"],
                            "note": "对象已按求值网格烘焙（修改器/变换已应用）"}, t0))
    return _err("spec_or_object 必须是 SurfaceSpec 对象或 mesh 对象名", stage="M0")


# ────────────────────────────── M5：纯 numpy 近似（如实标注 quality） ──────────────────────────────
def _mm_mesh_from_source(src):
    """SurfaceSpec（dict）或 mesh 对象名 → (verts_mm, faces, source_label, spec_hash|None)。"""
    mmu = max(_mmu(), 1e-12)
    if isinstance(src, dict):
        norm, errs = surface_spec_normalize(src)
        if errs:
            raise ValueError("spec 校验失败：%s" % (errs[:1],))
        md = surface_mesh_data(norm)
        return (np.asarray(md["verts_mm"], dtype=np.float64),
                [tuple(int(i) for i in f) for f in md["faces"]],
                "spec:%s" % norm["kind"], norm.get("spec_hash"))
    if isinstance(src, str):
        ob = bpy.data.objects.get(src)
        if ob is None or ob.type != "MESH":
            raise ValueError("对象不存在或不是 mesh: %r" % src)
        baked = _object_eval_mesh(ob)
        return (baked["verts"] * mmu,
                [tuple(int(i) for i in t) for t in baked["tris"]],
                "object:%s" % ob.name, None)
    raise ValueError("spec_or_object 必须是 SurfaceSpec 对象或 mesh 对象名")


def _boundary_ring(name, samples):
    """开放面片的最长边界边环（mm）；闭合壳没有边界环 → 明确报错。"""
    ob = bpy.data.objects.get(str(name))
    if ob is None or ob.type != "MESH":
        raise ValueError("对象不存在或不是 mesh: %r" % name)
    baked = _object_eval_mesh(ob)
    tris = np.asarray(baked["tris"], dtype=np.int64)
    if len(tris) == 0:
        raise ValueError("对象没有三角面")
    edges = {}
    for tri in tris.tolist():
        for i in range(3):
            a, b = tri[i], tri[(i + 1) % 3]
            key = (a, b) if a < b else (b, a)
            edges[key] = edges.get(key, 0) + 1
    bnd = [e for e, n in edges.items() if n == 1]
    if not bnd:
        raise ValueError("对象是闭合壳（没有边界环）：blend 需要开放面片，或直接给 a/b 点列")
    adj = {}
    for a, b in bnd:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    best, seen = [], set()
    for start in sorted(adj):
        if start in seen:
            continue
        loop, cur, prev = [start], start, None
        seen.add(start)
        while True:
            nxt = [v for v in adj.get(cur, []) if v != prev and v not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            loop.append(cur)
            seen.add(cur)
        if len(loop) > len(best):
            best = loop
    if len(best) < 3:
        raise ValueError("边界边链不成环")
    pts = baked["verts"][best] * max(_mmu(), 1e-12)
    return resample_ring(pts, samples, closed=True)


def _ring_source(src, samples, closed):
    if isinstance(src, list):
        return resample_ring(src, samples, closed=closed), "ring"
    if isinstance(src, str):
        return _boundary_ring(src, samples), "object:%s" % src
    raise ValueError("a/b 必须是对象名或 [[x,y,z],...] 点列")


def surface_blend(a=None, b=None, rows=16, samples=24, closed=True, name=None, collection=None):
    """M5：两条边界环之间的 smoothstep 过渡面（纯 numpy 近似，不是 BRep 圆角）。"""
    t0 = time.perf_counter()
    try:
        n_rows, n_samples = int(rows), int(samples)
    except (TypeError, ValueError):
        return _err("rows / samples 必须是整数", stage="M5", op="blend", code="BLEND_BAD_INPUT")
    if not 2 <= n_rows <= 256:
        return _err("rows 必须在 2..256", stage="M5", op="blend", code="BLEND_BAD_INPUT")
    if not 3 <= n_samples <= 512:
        return _err("samples 必须在 3..512", stage="M5", op="blend", code="BLEND_BAD_INPUT")
    try:
        ring_a, src_a = _ring_source(a, n_samples, closed)
        ring_b, src_b = _ring_source(b, n_samples, closed)
        bd = blend_rings(ring_a, ring_b, rows=n_rows, closed=closed)
    except ValueError as exc:
        return _err(str(exc), stage="M5", op="blend", code="BLEND_BAD_INPUT",
                    hint="a/b 用对象名（开放面片的边界环）或 [[x,y,z],...] 两条同点数环")
    norm = {"kind": "blend", "units": "mm", "rows": n_rows, "samples": n_samples,
            "closed": bool(closed), "source_a": src_a, "source_b": src_b,
            "tessellation": {"u": n_samples, "v": n_rows}}
    norm["spec_hash"] = _spec_hash(norm)
    try:
        _ob, info = _create_object({"verts_mm": bd["verts"], "faces": bd["faces"]},
                                   "blend", norm, name=name, collection=collection)
    except ValueError as exc:
        return _err("blend 生成失败：%s" % exc, stage="M5", op="blend",
                    code="BLEND_BUILD_FAILED")
    body = {"ok": True, "op": "blend", "kind": "blend", "method": "smoothstep_bridge",
            "quality": "approximate", "object": info["object"],
            "collection": info["collection"], "mesh": info["mesh"], "rows": n_rows,
            "samples": n_samples, "closed": bool(closed), "reversed_b": bd["reversed"],
            "verts": info["verts"], "tris": info["tris"], "bbox_mm": info["bbox_mm"],
            "source_a": src_a, "source_b": src_b, "spec_hash": norm["spec_hash"],
            "note": "点对点平滑过渡面（smoothstep）；不是 BRep 圆角/相切混合，"
                    "接缝连续性未保证 —— 用 surface_validate 验收"}
    return _j(_receipt(body, t0))
# ────────────────────────────── M2：网格分析（全部 mm 口径） ──────────────────────────────
class _SpecError(Exception):
    def __init__(self, errors):
        self.errors = errors or []
        Exception.__init__(self, "spec 校验失败")


def _faces_to_tris(faces):
    out = []
    for f in faces:
        f = [int(i) for i in f]
        for k in range(1, len(f) - 1):
            out.append((f[0], f[k], f[k + 1]))
    return np.asarray(out, dtype=np.int64).reshape(-1, 3)
