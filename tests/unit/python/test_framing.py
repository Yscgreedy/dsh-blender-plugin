# -*- coding: utf-8 -*-
"""T-4：worker 的 fit 取景纯计算（runtime/py/core/framing.py）。

只测数学：不 import bpy，不需要 Blender。worker.py 里"从 bpy 取世界角点"那段
无法在这里覆盖（依赖真机），回执在任务报告里说明。
"""
import math
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from runtime.py.core.framing import (  # noqa: E402
    DEFAULT_DIRECTION,
    bbox_of_points,
    fit_view,
)

SENSOR = 36.0
LENS = 50.0


def _corners(lo, hi):
    xs, ys, zs = (lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2])
    return [(x, y, z) for x in xs for y in ys for z in zs]


def _half_fovs(aspect, lens=LENS, sensor=SENSOR):
    """Blender sensor_fit=AUTO：大边吃满 sensor，另一条按 aspect 收窄。"""
    if aspect >= 1.0:
        tan_h = sensor / (2.0 * lens)
        tan_v = tan_h / aspect
    else:
        tan_v = sensor / (2.0 * lens)
        tan_h = tan_v * aspect
    return math.atan(tan_h), math.atan(tan_v)


def _angle_from_axis(point, look_at, frm):
    """点相对相机视轴的夹角。"""
    fwd = [look_at[i] - frm[i] for i in range(3)]
    n = math.sqrt(sum(c * c for c in fwd))
    fwd = [c / n for c in fwd]
    rel = [point[i] - frm[i] for i in range(3)]
    along = sum(rel[i] * fwd[i] for i in range(3))
    perp = math.sqrt(max(0.0, sum(c * c for c in rel) - along * along))
    return math.atan2(perp, max(along, 0.0))


def _inside(point, lo, hi, eps=1e-9):
    return all(lo[i] - eps <= point[i] <= hi[i] + eps for i in range(3))


def _dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def test_bbox_of_points_single_and_multi():
    assert bbox_of_points([]) is None
    assert bbox_of_points(None) is None
    single = bbox_of_points([(1, 2, 3)])
    assert single == ((1.0, 2.0, 3.0), (1.0, 2.0, 3.0))
    multi = bbox_of_points([(1, -2, 0.5), (-3, 4, 2), (0, 0, 0)])
    assert multi == ((-3.0, -2.0, 0.0), (1.0, 4.0, 2.0))


def test_bbox_of_points_rejects_malformed():
    for bad in [(1, 2), None, (1, 2, "x"), (1, 2, float("nan")), (1, 2, float("inf"))]:
        with pytest.raises(ValueError):
            bbox_of_points([bad])


def test_fit_view_looks_at_center_and_stays_outside():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    view = fit_view(lo, hi, aspect=16 / 9, lens_mm=LENS)
    assert view["look_at"] == pytest.approx([0.0, 0.0, 1.0], abs=1e-6)
    frm = view["from"]
    assert not _inside(frm, lo, hi), "相机不能落在包围盒里"
    # 默认视线方向是右前上：x 正、y 负、z 正。
    assert frm[0] > 0.0 and frm[1] < 0.0 and frm[2] > 1.0
    assert _dist(frm, view["look_at"]) > 1.0


def test_fit_view_covers_every_corner():
    lo, hi = (-2.0, -0.5, 0.0), (1.5, 2.0, 3.0)
    for aspect in (1.0, 16 / 9, 4 / 3, 9 / 16):
        view = fit_view(lo, hi, aspect=aspect, lens_mm=LENS)
        half_h, half_v = _half_fovs(aspect)
        half_min = min(half_h, half_v)
        for corner in _corners(lo, hi):
            angle = _angle_from_axis(corner, view["look_at"], view["from"])
            assert angle < half_min, (aspect, corner, angle, half_min)


def test_fit_view_aspect_changes_distance_monotonically():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    d13 = _dist(fit_view(lo, hi, aspect=4 / 3, lens_mm=LENS)["from"], (0.0, 0.0, 1.0))
    d169 = _dist(fit_view(lo, hi, aspect=16 / 9, lens_mm=LENS)["from"], (0.0, 0.0, 1.0))
    d219 = _dist(fit_view(lo, hi, aspect=21 / 9, lens_mm=LENS)["from"], (0.0, 0.0, 1.0))
    assert d13 < d169 < d219
    # 竖屏 9:16 与横屏 16:9 的最小半视角相同 → 距离相同。
    d916 = _dist(fit_view(lo, hi, aspect=9 / 16, lens_mm=LENS)["from"], (0.0, 0.0, 1.0))
    assert d916 == pytest.approx(d169, rel=1e-9)


def test_fit_view_margin_scales_distance_and_never_crops():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    tight = fit_view(lo, hi, aspect=1.0, lens_mm=LENS, margin=1.0)
    loose = fit_view(lo, hi, aspect=1.0, lens_mm=LENS, margin=2.0)
    center = (0.0, 0.0, 1.0)
    assert _dist(loose["from"], center) == pytest.approx(2.0 * _dist(tight["from"], center), rel=1e-6)
    # margin<1 会被夹到 1.0，否则相机会进包围盒。
    clamped = fit_view(lo, hi, aspect=1.0, lens_mm=LENS, margin=0.5)
    assert clamped["from"] == pytest.approx(tight["from"], abs=1e-6)


def test_fit_view_ortho_scale_covers_projection():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    view = fit_view(lo, hi, aspect=16 / 9, lens_mm=LENS, ortho=True)
    scale = view["ortho_scale"]
    # 透视分支不给 ortho_scale；正交分支必须给，且是"能盖住投影的最大边 × margin"。
    assert scale == pytest.approx(scale)  # 仅保证是数字
    assert scale > 0.0
    persp = fit_view(lo, hi, aspect=16 / 9, lens_mm=LENS)
    assert "ortho_scale" not in persp
    explicit = fit_view(lo, hi, aspect=16 / 9, lens_mm=LENS, ortho=True, ortho_scale=3.5)
    assert explicit["ortho_scale"] == pytest.approx(3.5)
    assert not _inside(explicit["from"], lo, hi)


def test_fit_view_ortho_scale_grows_with_margin():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    a = fit_view(lo, hi, aspect=1.0, lens_mm=LENS, ortho=True, margin=1.15)["ortho_scale"]
    b = fit_view(lo, hi, aspect=1.0, lens_mm=LENS, ortho=True, margin=2.30)["ortho_scale"]
    assert b == pytest.approx(2.0 * a, rel=1e-6)


def test_fit_view_degenerate_bbox_still_pushes_camera_out():
    view = fit_view((0, 0, 0), (0, 0, 0), aspect=1.0, lens_mm=LENS)
    assert _dist(view["from"], view["look_at"]) > 1e-3
    ortho = fit_view((0, 0, 0), (0, 0, 0), aspect=1.0, lens_mm=LENS, ortho=True)
    assert ortho["ortho_scale"] >= 1e-3


def test_fit_view_normalizes_reversed_bounds_and_custom_direction():
    forward = fit_view((-1.0, -1.0, 0.0), (1.0, 1.0, 2.0), aspect=1.0, lens_mm=LENS)
    reversed_args = fit_view((1.0, 1.0, 2.0), (-1.0, -1.0, 0.0), aspect=1.0, lens_mm=LENS)
    assert reversed_args["from"] == pytest.approx(forward["from"])
    behind = fit_view((-1.0, -1.0, 0.0), (1.0, 1.0, 2.0), aspect=1.0, lens_mm=LENS,
                      direction=(-1.0, 1.0, 0.0))
    assert behind["from"][0] < 0.0 and behind["from"][1] > 0.0
    assert behind["from"][2] == pytest.approx(1.0, abs=1e-6)
    assert DEFAULT_DIRECTION == (1.0, -1.0, 0.8)


def test_fit_view_rejects_illegal_scalars():
    lo, hi = (-1.0, -1.0, 0.0), (1.0, 1.0, 2.0)
    for kw in (
        {"aspect": 0.0},
        {"aspect": -1.0},
        {"aspect": float("nan")},
        {"lens_mm": 0.0},
        {"lens_mm": -50.0},
        {"lens_mm": float("inf")},
        {"sensor_mm": 0.0},
        {"margin": 0.0},
        {"margin": float("nan")},
    ):
        with pytest.raises(ValueError):
            fit_view(lo, hi, **{"aspect": 1.0, "lens_mm": LENS, **kw})
    with pytest.raises(ValueError):
        fit_view((0, 0), (1, 1, 1), aspect=1.0, lens_mm=LENS)
    with pytest.raises(ValueError):
        fit_view(lo, hi, aspect=1.0, lens_mm=LENS, direction=(0, 0, 0))
