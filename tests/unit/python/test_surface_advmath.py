"""Pure-numpy checks for surface_fit / surface_offset / surface_blend math."""
import importlib.util
import math
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE = ROOT / "runtime" / "py" / "geometry" / "surface_impl" / "advmath.py"


def _load():
    spec = importlib.util.spec_from_file_location("surface_advmath", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _cylinder_cloud(radius=20.0, height=100.0, n_z=10, n_ring=24):
    pts = []
    for k in range(n_z):
        z = height * k / float(n_z - 1)
        for j in range(n_ring):
            ang = 2.0 * math.pi * j / n_ring
            pts.append([radius * math.cos(ang), radius * math.sin(ang), z])
    return pts


def test_fit_recovers_a_cylinder():
    mod = _load()
    out = mod.fit_loft_sections(_cylinder_cloud(), axis="z", sections=6, ring=24)
    assert out["axes"] == {"axis": "z", "plane": ["x", "y"]}
    assert out["residual"]["sections_used"] == 6
    assert out["residual"]["points_used"] == 240
    assert out["residual"]["rmse_mm"] < 0.5
    assert len(out["sections"]) == 6
    assert all(len(s["points_mm"]) == 24 for s in out["sections"])
    zs = [s["z_mm"] for s in out["sections"]]
    assert zs == sorted(zs) and zs[-1] > zs[0]
    radius = math.hypot(*out["sections"][0]["points_mm"][0])
    assert abs(radius - 20.0) < 0.5


def test_fit_rejects_thin_or_degenerate_input():
    mod = _load()
    for pts in ([], [[0.0, 0.0, 0.0]] * 5):
        try:
            mod.fit_loft_sections(pts)
        except ValueError as e:
            assert "点不足" in str(e)
        else:
            raise AssertionError("expected ValueError")


def test_offset_plane_moves_along_its_normal():
    mod = _load()
    verts = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]]
    tris = [[0, 1, 2], [0, 2, 3]]
    out = mod.offset_vertices(verts, tris, 3.0)
    assert out["zero_normal"] == 0
    assert out["moved"] == 4
    assert np.allclose(out["verts"][:, 2], 3.0)
    assert np.allclose(out["verts"][:, :2], np.asarray(verts)[:, :2])


def test_offset_rejects_zero_distance():
    mod = _load()
    try:
        mod.offset_vertices([[0.0, 0.0, 0.0]], [], 0.0)
    except ValueError as e:
        assert "非零" in str(e)
    else:
        raise AssertionError("expected ValueError")


def test_blend_aligns_reversed_ring_and_builds_quads():
    mod = _load()
    ring_a = [[10.0 * math.cos(2 * math.pi * k / 12), 10.0 * math.sin(2 * math.pi * k / 12), 0.0]
              for k in range(12)]
    ring_b = [[6.0 * math.cos(2 * math.pi * k / 12), 6.0 * math.sin(2 * math.pi * k / 12), 30.0]
              for k in range(12)][::-1]
    out = mod.blend_rings(ring_a, ring_b, rows=5, closed=True)
    assert out["reversed"] is True
    assert out["rows"] == 5 and out["cols"] == 12
    assert out["verts"].shape == (60, 3)
    assert len(out["faces"]) == 4 * 12
    assert np.allclose(out["verts"][0], ring_a[0])
    assert out["verts"][-12:, 2].max() == 30.0
    assert out["verts"][-12:, 2].min() == 30.0


def test_blend_requires_matching_ring_sizes():
    mod = _load()
    try:
        mod.blend_rings([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                        [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
    except ValueError as e:
        assert "点数必须一致" in str(e)
    else:
        raise AssertionError("expected ValueError")
