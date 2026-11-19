# -*- coding: utf-8 -*-
"""surface_fit / surface_offset / surface_blend 的纯 numpy 几何。

为什么单独一个文件：这三个 op 过去是"诚实拒绝"（M3/M5 需 OCCT）。现在给纯 numpy 的
可用近似，但必须能脱离 Blender 测：本模块只 import math + numpy，不碰 bpy/mathutils。

口径（写死）：
  * 长度全部 mm；
  * fit = 按 axis 切环 → 平面内极角排序 → 等弧长重采样 → 交给 loft 的 B-spline 插值；
    残差 = 原始切环点到重采样环的最短距离（不是 BRep 偏差）；
  * offset = 顶点法线 × 距离（面积加权法线）；尖角/凹处可能自交，调用方必须看
    self_intersections / verdict，不能当稳健 offset；
  * blend = 两条环之间按 smoothstep 的点对点过渡面，不是 BRep 圆角/相切混合。
"""
import math

import numpy as np

AXES = {"x": 0, "y": 1, "z": 2}
# loft 轴 → 截面平面内的两轴（保持右手序）
PLANE = {0: (1, 2), 1: (2, 0), 2: (0, 1)}


def _verts(raw):
    V = np.asarray(raw, dtype=np.float64)
    if V.ndim != 2 or V.shape[1] != 3:
        raise ValueError("verts 必须是 (N,3)")
    if V.size and not np.isfinite(V).all():
        raise ValueError("verts 含 NaN/Inf")
    return V


def _tris(raw):
    T = np.asarray(raw, dtype=np.int64)
    if T.size == 0:
        return T.reshape(0, 3)
    if T.ndim != 2 or T.shape[1] != 3:
        raise ValueError("tris 必须是 (M,3)")
    return T


def vertex_normals(verts, tris):
    """面积加权的逐顶点法线（不再归一化面积，直接累加叉积）。返回 (N, 3) 与零法线数。"""
    V = _verts(verts)
    T = _tris(tris)
    N = np.zeros_like(V)
    if len(T):
        a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
        fn = np.cross(b - a, c - a)
        for k in range(3):
            np.add.at(N, T[:, k], fn)
    ln = np.linalg.norm(N, axis=1)
    zero = ln < 1e-12
    N[~zero] = N[~zero] / ln[~zero, None]
    return N, int(zero.sum())


def offset_vertices(verts, tris, distance_mm):
    """沿顶点法线等距偏置；正=向外（法线方向），负=向内。"""
    d = float(distance_mm)
    if not math.isfinite(d) or abs(d) < 1e-12:
        raise ValueError("distance_mm 必须是非零有限数")
    V = _verts(verts)
    N, zero = vertex_normals(V, tris)
    if zero == len(V):
        raise ValueError("所有顶点都没有可用法线（退化网格）")
    return {"verts": V + N * d, "zero_normal": zero, "distance_mm": d,
            "moved": int(len(V) - zero)}


def _as_ring(raw, label="ring"):
    P = np.asarray(raw, dtype=np.float64)
    if P.ndim != 2 or P.shape[1] != 3 or len(P) < 3:
        raise ValueError("%s 必须是至少 3 个 [x,y,z]" % label)
    if not np.isfinite(P).all():
        raise ValueError("%s 含 NaN/Inf" % label)
    return P


def resample_ring(raw, count, closed=True):
    """按弦长等弧长重采样（2D/3D 均可）；closed 时首尾相连、采样点不含重复终点。"""
    P = np.asarray(raw, dtype=np.float64)
    if P.ndim != 2 or P.shape[1] < 2 or len(P) < 2:
        raise ValueError("ring 必须是至少 2 点的 (N,2) 或 (N,3)")
    if not np.isfinite(P).all():
        raise ValueError("ring 含 NaN/Inf")
    count = int(count)
    if count < 3:
        raise ValueError("count 至少 3")
    Q = np.vstack([P, P[:1]]) if closed else P
    seg = np.linalg.norm(np.diff(Q, axis=0), axis=1)
    total = float(seg.sum())
    if total <= 1e-12:
        raise ValueError("环长度为 0（点重复）")
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    s = np.linspace(0.0, total, count, endpoint=not closed)
    out = np.empty((count, P.shape[1]), dtype=np.float64)
    for k in range(P.shape[1]):
        out[:, k] = np.interp(s, cum, Q[:, k])
    return out


def _polyline_distance(points, ring, closed):
    """每个点到折线/多边形环的最短距离（mm）。"""
    P = np.asarray(points, dtype=np.float64)
    R = np.asarray(ring, dtype=np.float64)
    A = R
    B = np.roll(R, -1, axis=0) if closed else R[1:]
    A = R if closed else R[:-1]
    best = np.full(len(P), np.inf, dtype=np.float64)
    for a, b in zip(A, B):
        ab = b - a
        L2 = float(ab @ ab)
        if L2 <= 1e-18:
            continue
        t = np.clip(((P - a) @ ab) / L2, 0.0, 1.0)
        proj = a + t[:, None] * ab
        best = np.minimum(best, np.linalg.norm(P - proj, axis=1))
    return best


def _axis_index(axis):
    if isinstance(axis, str):
        key = axis.strip().lower()
        if key not in AXES:
            raise ValueError('axis 只支持 "x" / "y" / "z"')
        return AXES[key]
    try:
        idx = int(axis)
    except (TypeError, ValueError):
        raise ValueError("axis 必须是 x/y/z 或 0/1/2")
    if idx not in (0, 1, 2):
        raise ValueError("axis 必须是 x/y/z 或 0/1/2")
    return idx


def _fit_one_section(sel, ai, pu, pv, ring, closed):
    plane = sel[:, [pu, pv]]
    cen = plane.mean(axis=0)
    ang = np.arctan2(plane[:, 1] - cen[1], plane[:, 0] - cen[0])
    ordered = plane[np.argsort(ang, kind="stable")]
    ring_pts = resample_ring(ordered, ring, closed=closed)
    dist = _polyline_distance(ordered, ring_pts, closed)
    return {
        "z_mm": float(np.median(sel[:, ai])),
        "points_mm": ring_pts.tolist(),
        "n": int(len(sel)),
        "rmse_mm": float(np.sqrt(np.mean(dist ** 2))),
        "max_mm": float(dist.max()) if len(dist) else 0.0,
        "sum_sq": float((dist ** 2).sum()),
        "used": int(len(dist)),
    }


def fit_loft_sections(points, axis="z", sections=8, ring=24, closed=True):
    """点云 → loft sections（按 axis 切环、极角排序、等弧长采样），带残差。

    返回 {sections, residual, axes, ring, closed, points}。不做跨截面平滑——那交给 loft 的
    B-spline 插值；本函数只保证每个截面的环形状与残差可复核。
    """
    P = np.asarray(points, dtype=np.float64)
    if P.ndim == 1 and P.size == 0:
        P = P.reshape(0, 3)
    if P.ndim != 2 or P.shape[1] != 3:
        raise ValueError("points 必须是 [[x,y,z], ...]")
    P = P[np.isfinite(P).all(axis=1)]
    if len(P) < 12:
        raise ValueError("有效点不足 12 个（切环至少要 3 点/截面 × 2 截面）")
    ai = _axis_index(axis)
    pu, pv = PLANE[ai]
    sections = int(sections)
    ring = int(ring)
    if not 2 <= sections <= 64:
        raise ValueError("sections 必须在 2..64")
    if not 3 <= ring <= 256:
        raise ValueError("ring 必须在 3..256")

    vals = P[:, ai]
    order = np.argsort(vals, kind="stable")
    P = P[order]
    vals = vals[order]
    edges = np.quantile(vals, np.linspace(0.0, 1.0, sections + 1))
    if np.any(np.diff(edges) <= 1e-9):
        lo, hi = float(vals[0]), float(vals[-1])
        if hi - lo <= 1e-9:
            raise ValueError("所有点沿 %s 坐标相同，无法切环" % "xyz"[ai])
        edges = np.linspace(lo, hi, sections + 1)
    bins = np.clip(np.searchsorted(edges, vals, side="right") - 1, 0, sections - 1)

    cand = []
    for k in range(sections):
        sel = P[bins == k]
        if len(sel) < 3:
            continue
        cand.append(_fit_one_section(sel, ai, pu, pv, ring, closed))
    if len(cand) < 2:
        raise ValueError("有效截面不足 2 个（点太稀或分布太集中）")

    kept = []
    last = None
    for sec in cand:
        if last is not None and sec["z_mm"] <= last + 1e-9:
            continue
        kept.append(sec)
        last = sec["z_mm"]
    if len(kept) < 2:
        raise ValueError("切环后 z 不严格递增（点云分层退化），先抽稀或换 axis")

    sum_sq = float(sum(s["sum_sq"] for s in kept))
    used = int(sum(s["used"] for s in kept))
    rmse = math.sqrt(sum_sq / used) if used else 0.0
    return {
        "sections": [{"z_mm": round(float(s["z_mm"]), 9), "points_mm": s["points_mm"]} for s in kept],
        "residual": {
            "rmse_mm": round(rmse, 6),
            "max_mm": round(float(max(s["max_mm"] for s in kept)), 6),
            "sections_used": int(len(kept)),
            "points_used": used,
            "per_section": [{"z_mm": round(float(s["z_mm"]), 6), "n": s["n"],
                             "rmse_mm": round(float(s["rmse_mm"]), 6),
                             "max_mm": round(float(s["max_mm"]), 6)} for s in kept],
        },
        "axes": {"axis": "xyz"[ai], "plane": ["xyz"[pu], "xyz"[pv]]},
        "ring": int(ring),
        "closed": bool(closed),
        "points": int(len(P)),
    }


def align_rings(ring_a, ring_b):
    """把 B 环调到与 A 环起点/绕向一致：返回 (A, B, reversed)。"""
    A = _as_ring(ring_a, "ring_a")
    B = _as_ring(ring_b, "ring_b")
    if A.shape != B.shape:
        raise ValueError("两条环点数必须一致（先用 samples 重采样）")
    fwd = float(((A - B) ** 2).sum())
    rev = float(((A - B[::-1]) ** 2).sum())
    if rev < fwd:
        return A, B[::-1].copy(), True
    return A, B, False


def blend_rings(ring_a, ring_b, rows=16, closed=True):
    """两条同点数环 → smoothstep 过渡网格（quads）。"""
    rows = int(rows)
    if rows < 2:
        raise ValueError("rows 至少 2")
    A, B, rev = align_rings(ring_a, ring_b)
    cols = int(len(A))
    if cols < 3:
        raise ValueError("每环至少 3 点")
    layers = []
    for i in range(rows):
        t = i / float(rows - 1)
        w = t * t * (3.0 - 2.0 * t)
        layers.append(A * (1.0 - w) + B * w)
    V = np.vstack(layers)
    faces = []
    span = cols if closed else cols - 1
    for i in range(rows - 1):
        for j in range(span):
            j2 = (j + 1) % cols
            faces.append((i * cols + j, (i + 1) * cols + j,
                          (i + 1) * cols + j2, i * cols + j2))
    return {"verts": V, "faces": faces, "rows": rows, "cols": cols,
            "reversed": bool(rev), "closed": bool(closed)}
