# -*- coding: utf-8 -*-
"""toon_* 族单测（fake-bpy，无 Blender）。

钉住四件事：
  1. 纯逻辑：色阶数量/颜色单调、mm→BU、外壳可见性估算、审计项三态；
  2. 分派：未知 op 回允许列表，失败回执带 repro 命令串；
  3. toon_build 在假材质/假节点树上建出「Shader to RGB + CONSTANT 色阶」与
     「Solidify 反向外壳 + 描边材质」，并把 EEVEE 限制写进 warnings；
  4. toon_outline_audit 三态：厚度越界/没翻转 → fail，缺自发光/背面剔除 → degraded。

真实 Blender 行为不在本文件（E2E 层负责）；这里只证明纯逻辑与回执形状。
"""
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_PY = ROOT / "runtime" / "py"
KIT = RUNTIME_PY / "core" / "kit.py"

ALLOWED_OPS = ["build", "help", "outline_audit"]


def _boot_kernel():
    kernel = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = kernel
    with open(KIT, encoding="utf-8") as fh:
        exec(compile(fh.read(), str(KIT), "exec"), {})


@pytest.fixture()
def toon():
    saved = sys.modules.get("dsh_rt_kernel")
    _boot_kernel()
    for name in [n for n in list(sys.modules) if n == "render" or n.startswith("render.")]:
        del sys.modules[name]
    sys.path.insert(0, str(RUNTIME_PY))
    try:
        yield importlib.import_module("render.toon")
    finally:
        sys.path.remove(str(RUNTIME_PY))
        if saved is None:
            sys.modules.pop("dsh_rt_kernel", None)
        else:
            sys.modules["dsh_rt_kernel"] = saved


# ── 假 bpy（材质 / 节点树 / 修改器） ───────────────────────────────────────


class _Element:
    def __init__(self, position=0.0):
        self.position = position
        self.color = (0.0, 0.0, 0.0, 1.0)


class _Elements:
    def __init__(self):
        self._items = [_Element(0.0), _Element(1.0)]

    def __len__(self):
        return len(self._items)

    def __getitem__(self, index):
        return self._items[index]

    def new(self, position=0.0):
        element = _Element(position)
        self._items.append(element)
        return element


class _Ramp:
    def __init__(self):
        self.interpolation = "LINEAR"
        self.elements = _Elements()


class _Inputs(dict):
    def __missing__(self, key):
        self[key] = types.SimpleNamespace(default_value=None)
        return self[key]


class _Nodes:
    def __init__(self):
        self.created = []

    def new(self, kind):
        node = types.SimpleNamespace(
            type=kind,
            inputs=_Inputs(),
            outputs={0: object()},
            color_ramp=_Ramp(),
        )
        self.created.append(node)
        return node

    def __iter__(self):
        return iter(self.created)

    def __len__(self):
        return len(self.created)


class _NodeTree:
    def __init__(self):
        self.nodes = _Nodes()
        self.links = types.SimpleNamespace(links=[], new=self._link)

    def _link(self, a, b):
        self.links.links.append((a, b))


class _Material:
    def __init__(self, name):
        self.name = name
        self.use_nodes = False
        self.node_tree = _NodeTree()
        self.use_backface_culling = False
        self.shadow_method = "OPAQUE"
        self.blend_method = "OPAQUE"


class _Materials:
    def __init__(self):
        self._items = []

    def get(self, name, default=None):
        for m in self._items:
            if m.name == name:
                return m
        return default

    def new(self, name):
        m = _Material(name)
        self._items.append(m)
        return m

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


class _Modifiers:
    def __init__(self):
        self._items = []

    def new(self, name, kind):
        mod = types.SimpleNamespace(name=name, type=kind)
        self._items.append(mod)
        return mod

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


def make_mesh_object(name="Body", slots=()):
    materials = list(slots)
    me = types.SimpleNamespace(materials=materials)
    ob = types.SimpleNamespace(
        name=name,
        type="MESH",
        data=me,
        modifiers=_Modifiers(),
        evaluated_get=None,
    )
    return ob


class _Objects:
    def __init__(self, items=()):
        self._items = list(items)

    def get(self, name, default=None):
        for ob in self._items:
            if getattr(ob, "name", None) == name:
                return ob
        return default

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


def make_bpy(objects=(), engine="BLENDER_EEVEE_NEXT"):
    scene = types.SimpleNamespace(render=types.SimpleNamespace(engine=engine))
    data = types.SimpleNamespace(objects=_Objects(objects), materials=_Materials())
    return types.SimpleNamespace(
        data=data,
        context=types.SimpleNamespace(scene=scene, evaluated_depsgraph_get=lambda: object()),
    )


# ── 纯逻辑 ───────────────────────────────────────────────────────────────────


def test_band_colors_are_monotonic_and_ramp_stops_cover_the_range(toon):
    colors = toon.band_colors(4)
    assert len(colors) == 4
    assert colors[0][2] < colors[-1][2]
    stops = toon.ramp_stops(colors)
    assert [stop[0] for stop in stops] == [0.0, 0.25, 0.5, 0.75]
    assert toon.band_colors(99) == toon.band_colors(8)


def test_mm_to_bu_rejects_zero_and_scales(toon):
    assert toon.mm_to_bu(2.0, 1000.0) == pytest.approx(0.002)
    with pytest.raises(ValueError):
        toon.mm_to_bu(0, 1000.0)


def test_outline_visibility_flags_swallowed_shell(toon):
    hidden = toon.outline_visibility([0.0001, 0.0002, 0.01], 0.002)
    assert hidden["status"] == "fail"
    ok = toon.outline_visibility([0.002, 0.003, 0.0025], 0.002)
    assert ok["status"] == "pass"
    empty = toon.outline_visibility([], 0.002)
    assert empty["status"] == "degraded"


def test_outline_checks_fail_on_bad_thickness_and_missing_flip(toon):
    row = {
        "thickness_mm": 20.0,
        "flip_normals": False,
        "emission": True,
        "backface_culling": True,
        "visibility": {"status": "pass"},
    }
    items = toon.outline_checks(row)
    status = {item["id"]: item["status"] for item in items}
    assert status["thickness"] == "fail"
    assert status["flip_normals"] == "fail"
    assert toon.aggregate_verdict(items)["verdict"] == "fail"


def test_outline_checks_degrade_on_missing_emission(toon):
    row = {
        "thickness_mm": 2.0,
        "flip_normals": True,
        "emission": False,
        "backface_culling": True,
        "visibility": {"status": "pass"},
    }
    items = toon.outline_checks(row)
    status = {item["id"]: item["status"] for item in items}
    assert status["emission"] == "degraded"
    assert toon.aggregate_verdict(items)["verdict"] == "degraded"


# ── 分派 / 回执形状 ──────────────────────────────────────────────────────────


def test_dispatch_unknown_op_returns_allowed_ops_and_repro(toon):
    out = json.loads(toon.toon_dispatch("bogus", "{}"))
    assert out["ok"] is False
    assert out["ops"] == ALLOWED_OPS
    assert out["repro"].startswith('blender_op(op="toon_bogus"')


def test_build_without_objects_fails_with_repro(toon, monkeypatch):
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[]))
    out = json.loads(toon.toon_dispatch("build", "{}"))
    assert out["ok"] is False
    assert out["verdict"] == "fail"
    assert out["repro"] == 'blender_op(op="toon_build", args={})'


def test_build_without_bpy_is_degraded_not_crash(toon, monkeypatch):
    def boom():
        raise ImportError("no bpy in this interpreter")

    monkeypatch.setattr(toon, "_bpy", boom)
    out = json.loads(toon.toon_dispatch("build", json.dumps({"objects": ["Body"]})))
    assert out["verdict"] == "degraded"
    assert out["warnings"]


# ── bpy 面（假对象） ─────────────────────────────────────────────────────────


def test_build_makes_shader_to_rgb_ramp_and_inverted_hull(toon, monkeypatch):
    ob = make_mesh_object()
    bpy = make_bpy(objects=[ob])
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    out = json.loads(
        toon.toon_dispatch(
            "build", json.dumps({"objects": ["Body"], "bands": 3, "outline_mm": 2.0})
        )
    )
    assert out["ok"] is True, out
    assert out["verdict"] == "pass"
    assert [m["name"] for m in out["materials"]] == ["TOON_Main", "TOON_Outline"]
    main = [m for m in out["materials"] if m["name"] == "TOON_Main"][0]
    assert main["shader_to_rgb"] is True
    assert main["ramp_stops"] == 3
    assert main["ramp_interpolation"] == "CONSTANT"
    mods = [m for m in out["modifiers"]]
    assert mods[0]["modifier"] == "DSH_ToonOutline"
    assert mods[0]["flip_normals"] is True
    assert mods[0]["thickness_mm"] == pytest.approx(2.0)
    assert out["outline_objects"] == ["Body"]
    assert any("EEVEE" in w for w in out["warnings"])


def test_build_on_cycles_degrades_and_warns(toon, monkeypatch):
    ob = make_mesh_object()
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[ob], engine="CYCLES"))
    out = json.loads(toon.toon_dispatch("build", json.dumps({"objects": ["Body"]})))
    assert out["verdict"] == "degraded"
    assert any("Shader to RGB" in w for w in out["warnings"])


def test_outline_audit_reads_solidify_and_material_flags(toon, monkeypatch):
    ob = make_mesh_object()
    mat = _Material("TOON_Outline")
    mat.use_backface_culling = True
    mat.shadow_method = "NONE"
    bpy = make_bpy(objects=[ob])
    mod = ob.modifiers.new("DSH_ToonOutline", "SOLIDIFY")
    mod.thickness = -0.002
    mod.use_flip_normals = True
    mod.material_offset = 1
    ob.data.materials = [types.SimpleNamespace(name="TOON_Main"), mat]
    # 描边材质用 Emission 节点 → 自发光成立
    mat.node_tree.nodes.created = [
        types.SimpleNamespace(type="ShaderNodeOutputMaterial"),
        types.SimpleNamespace(type="ShaderNodeEmission"),
    ]
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    out = json.loads(toon.toon_dispatch("outline_audit", json.dumps({"objects": ["Body"]})))
    row = out["objects"][0]
    status = {item["id"]: item["status"] for item in row["items"]}
    assert status["thickness"] == "pass"
    assert status["flip_normals"] == "pass"
    assert status["emission"] == "pass"
    assert status["backface_culling"] == "pass"


def test_outline_audit_fails_without_solidify(toon, monkeypatch):
    ob = make_mesh_object()
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[ob]))
    out = json.loads(toon.toon_dispatch("outline_audit", json.dumps({"objects": ["Body"]})))
    assert out["verdict"] == "fail"
    assert "SOLIDIFY" in out["objects"][0]["items"][0]["detail"]


def test_api_registers_ops_and_help_lists_them(toon):
    kernel = sys.modules["dsh_rt_kernel"]
    api = kernel.dsh_toon_api
    assert sorted(k for k in api if k in ALLOWED_OPS) == ALLOWED_OPS
    help_out = json.loads(toon.toon_dispatch("help", "{}"))
    assert help_out["op"] == "toon_help"
    assert sorted(help_out["ops"]) == ALLOWED_OPS
