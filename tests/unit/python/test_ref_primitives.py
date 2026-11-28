# -*- coding: utf-8 -*-
"""C-1：ref_measure / ref_crop_atlas / ref_readability 的纯规则测试。

bpy 读图/落盘在 runtime/py/render/imgtools_impl/ref_ops.py，pytest 里没有 Blender，
所以这里测 ref_core（不 import bpy / numpy）并对 ref_ops 做静态守卫（函数与分派键）。
真机 IO 路径只能在 Blender 里验：blender_run(action="worker", op="exec", code=...)。
"""
import ast
import hashlib
import importlib.util
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
IMPL = os.path.join(ROOT, "runtime", "py", "render", "imgtools_impl")
CORE_FILE = os.path.join(IMPL, "ref_core.py")
OPS_FILE = os.path.join(IMPL, "ref_ops.py")


def _load_core():
    spec = importlib.util.spec_from_file_location("dsh_ref_core", CORE_FILE)
    module = importlib.util.module_from_spec(spec)
    sys.modules["dsh_ref_core"] = module
    spec.loader.exec_module(module)
    return module


ref_core = _load_core()


def _source(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


# ── ref_measure ───────────────────────────────────────────────────────────────

def test_measure_basic_scale_and_error_model():
    plan = ref_core.measure_plan([1000, 500], [0, 0], [100, 0], 2.0)
    assert plan["ok"] is True
    assert plan["px"] == pytest.approx(100.0)
    assert plan["px_per_m"] == pytest.approx(50.0)
    assert plan["err_m_per_px"] == pytest.approx(0.02)
    assert plan["err_m_at_300px"] == pytest.approx(6.0)
    assert plan["axis"] == "X"
    assert plan["native_px"] == [1000, 500]
    assert [row["name"] for row in plan["stations"]] == ["p1", "p2"]
    assert plan["stations"][0]["metres"] == 0.0
    assert plan["stations"][1]["metres"] == pytest.approx(2.0)
    assert all(row["err_m"] == 0.0 for row in plan["stations"])


def test_measure_stations_convert_from_anchor_with_linear_error():
    plan = ref_core.measure_plan(
        [1000, 500], [200, 100], [300, 100], 2.0,
        stations=[{"name": "tip", "px_x": 350}, {"name": "hatch", "px": 250, "axis": "X"}],
    )
    tip, hatch = plan["stations"]
    assert tip["px_x"] == pytest.approx(350.0)
    assert tip["metres"] == pytest.approx(3.0)      # (350-200)/50
    assert tip["err_m"] == pytest.approx(3.0)       # 150 px * 0.02 m/px
    assert tip["confidence"] == "近似"
    assert hatch["metres"] == pytest.approx(1.0)
    assert hatch["err_m"] == pytest.approx(1.0)


def test_measure_axis_y_uses_pixel_rows():
    plan = ref_core.measure_plan([500, 1000], [100, 0], [100, 200], 4.0, axis="y",
                                 stations=[{"name": "deck", "px_y": 400}])
    assert plan["axis"] == "Y"
    assert plan["px_per_m"] == pytest.approx(50.0)
    assert plan["stations"][0]["metres"] == pytest.approx(8.0)
    assert plan["stations"][0]["err_m"] == pytest.approx(8.0)
    assert plan["stations"][0]["px_x"] == pytest.approx(400.0)


def test_measure_rejects_bad_input():
    cases = [
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=0),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=-2),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=float("nan")),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[0, 0], known_len_m=2),
        dict(native_px=[1000, 500], p1=[1], p2=[100, 0], known_len_m=2),
        dict(native_px=[1000, 500], p1=[-1, 0], p2=[100, 0], known_len_m=2),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=2, axis="Z"),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=2, stations=[]),
        dict(native_px=[1000, 500], p1=[0, 0], p2=[100, 0], known_len_m=2,
             stations=[{"name": "no-pos"}]),
        dict(native_px=[0, 500], p1=[0, 0], p2=[100, 0], known_len_m=2),
    ]
    for kwargs in cases:
        with pytest.raises(ValueError):
            ref_core.measure_plan(**kwargs)


# ── ref_crop_atlas ────────────────────────────────────────────────────────────

def test_crop_plan_keeps_native_scale_and_reports_mm():
    rows = ref_core.crop_plan(
        [1000, 500],
        [{"name": "nose", "box_px": [10, 20, 110, 120]},
         {"name": "hatch", "box_px": [200, 100, 260, 140], "size_m": 0.35}],
        px_per_m=50.0,
    )
    assert [row["name"] for row in rows] == ["nose", "hatch"]
    assert rows[0]["box_px"] == [10, 20, 110, 120]
    assert rows[0]["px"] == [100, 100]
    assert rows[0]["scale"] == 1.0
    assert rows[0]["source_px"] == [1000, 500]
    assert rows[0]["mm"] == [2000.0, 2000.0]        # 100 px / 50 px每m = 2 m
    assert rows[1]["size_m"] == pytest.approx(0.35)
    assert rows[1]["mm"] == [1200.0, 800.0]


def test_crop_plan_without_scale_omits_mm_but_keeps_px():
    rows = ref_core.crop_plan([100, 100], [{"name": "a", "box_px": [0, 0, 10, 20]}])
    assert rows[0]["px"] == [10, 20]
    assert "mm" not in rows[0]


def test_crop_plan_rejects_bad_input():
    good = {"name": "a", "box_px": [0, 0, 10, 10]}
    cases = [
        ([100, 100], []),
        ([100, 100], "not-a-list"),
        ([100, 100], [{"box_px": [0, 0, 1, 1]}]),
        ([100, 100], [good, dict(good)]),
        ([100, 100], [{"name": "a/b", "box_px": [0, 0, 1, 1]}]),
        ([100, 100], [{"name": "a", "box_px": [0, 0, 1]}]),
        ([100, 100], [{"name": "a", "box_px": [0, 0, "x", 1]}]),
        ([100, 100], [{"name": "a", "box_px": [10, 0, 0, 10]}]),
        ([100, 100], [{"name": "a", "box_px": [0, 0, 101, 10]}]),
        ([100, 100], [{"name": "a", "box_px": [5, 5, 5, 10]}]),
        ([100, 100], [{"name": "a", "box_px": [0, 0, 10, 10], "size_m": 0}]),
        ([100, 100], [{"name": "a", "box_px": [0, 0, 10, 10]}], 0),
    ]
    for item in cases:
        native_px, crops = item[0], item[1]
        kwargs = {"px_per_m": item[2]} if len(item) > 2 else {}
        with pytest.raises(ValueError):
            ref_core.crop_plan(native_px, crops, **kwargs)


# ── ref_readability ───────────────────────────────────────────────────────────

def test_readability_threshold_and_boundary():
    result = ref_core.readability_rows(
        [{"name": "seam", "m": 0.10}, {"name": "bolt", "m": 0.20},
         {"name": "edge", "px": 8}, {"name": "dip", "size_m": 0.05}],
        px_per_m=55.0, min_px=8,
    )
    verdicts = {row["feature"]: row["verdict"] for row in result["rows"]}
    assert verdicts == {"seam": "unreadable", "bolt": "readable", "edge": "readable", "dip": "unreadable"}
    assert result["unreadable_count"] == 2
    assert result["readable_count"] == 2
    assert [row["feature"] for row in result["unreadable"]] == ["seam", "dip"]
    assert result["min_px"] == 8.0


def test_readability_rejects_bad_input():
    cases = [
        ([], 55.0, 8),
        ([{"name": "a", "m": 0.1}], None, 8),          # 没有 px_per_m 就换算不了
        ([{"name": "a", "m": 0.1}], 0, 8),
        ([{"name": "a", "px": 10}], None, 0),
        ([{"name": "a", "px": -1}], None, 8),
        ([{"name": "", "px": 10}], None, 8),
        (["not-a-dict"], None, 8),
    ]
    for features, ppm, min_px in cases:
        with pytest.raises(ValueError):
            ref_core.readability_rows(features, px_per_m=ppm, min_px=min_px)


# ── atlas / grid / provenance ─────────────────────────────────────────────────

def test_atlas_manifest_keeps_provenance():
    rows = ref_core.crop_plan([640, 480], [{"name": "a", "box_px": [0, 0, 32, 16]}], px_per_m=40.0)
    manifest = ref_core.atlas_manifest("D:/ref/front.png", [640, 480], "d41d8cd98f00b204e9800998ecf8427e",
                                       rows, px_per_m=40.0)
    assert manifest["version"] == 1
    assert manifest["source"] == "D:/ref/front.png"
    assert manifest["native_px"] == [640, 480]
    assert manifest["px_per_m"] == pytest.approx(40.0)
    assert manifest["units"] == "m"
    assert manifest["count"] == 1
    assert manifest["crops"][0]["px"] == [32, 16]
    with pytest.raises(ValueError):
        ref_core.atlas_manifest("x", [10, 10], "", [])


def test_grid_lines_cover_the_image_without_overshoot():
    xs, ys = ref_core.grid_lines([100, 50], px_per_m=50.0, step_m=0.1)   # 5 px 一格
    assert xs[0] == 0 and ys[0] == 0
    assert xs == list(range(0, 101, 5))
    assert ys == list(range(0, 51, 5))
    with pytest.raises(ValueError):
        ref_core.grid_lines([100, 50], px_per_m=0, step_m=0.1)
    with pytest.raises(ValueError):
        ref_core.grid_lines([100, 50], px_per_m=50.0, step_m=0)
    with pytest.raises(ValueError):
        ref_core.grid_lines([100, 50], px_per_m=50.0, step_m=0.001)   # 0.05 px：亚像素网格拒绝


def test_md5_of_file_matches_hashlib(tmp_path):
    payload = b"dsh-ref-provenance"
    target = tmp_path / "ref.png"
    target.write_bytes(payload)
    assert ref_core.md5_of_file(str(target)) == hashlib.md5(payload).hexdigest()


def test_self_check_passes():
    checks = ref_core.self_check()
    assert checks and all(item["ok"] for item in checks), checks


# ── 结构守卫：纯核心不碰 bpy；ref_ops 暴露三条原语 ────────────────────────────

def test_core_stays_pure_and_ops_expose_the_primitives():
    core_tree = ast.parse(_source(CORE_FILE))
    for node in ast.walk(core_tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name.split(".")[0] not in ("bpy", "numpy"), alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            assert node.module.split(".")[0] not in ("bpy", "numpy"), node.module
    tree = ast.parse(_source(OPS_FILE))
    names = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    for expected in ("ref_measure", "ref_crop_atlas", "ref_readability", "ref_help", "ref_selftest"):
        assert expected in names, expected
    api_source = _source(os.path.join(IMPL, "api.py"))
    for key in ('"ref_measure"', '"ref_crop_atlas"', '"ref_readability"', '"ref_help"', '"ref_selftest"'):
        assert key in api_source, key
