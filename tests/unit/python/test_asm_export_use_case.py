# -*- coding: utf-8 -*-
"""asm_export use_case 预设：unity / unreal / godot / web + 逐轮显式覆盖。

问题：FBX 导出一度硬编码 add_leaf_bones=False, bake_anim=False,
apply_scale_options="FBX_SCALE_ALL"，交付给 Unity/Unreal 的绑定动画被悄悄丢掉；
verify 只查魔数/大小/md5，所以照样报成功。本文件钉住：

  A  默认（use_case 未给）下发给导出器的关键字与拆分前逐字相同 —— 老调用零行为变化
  B  预设：unity/unreal → fbx（bake_anim=True、轴 -Z/Y）；godot/web → glb（export_animations=True）
  C  显式覆盖优先于预设；不认识的取值、落不了地的按键一律 ok:false（不静默退回默认）
  D  print/ar 不走这条路：ok:false + allowed + hint 指向 deliver_export(fmt='stl') / USD
  E  显式给了关键字后不再"丢掉关键字重试"（旧默认路径保留回退），失败就是 ok:false
  F  manifest 与回执都记录 use_case 与解析后的关键字，调用方可以自证发生了什么

bpy/mathutils/共享内核都用 stub 顶住（不启动 Blender）；真 Blender 行为仍由
tests/e2e/blender/native/assembly_export.py 覆盖。
"""

from __future__ import annotations

import json
import math
import sys
import types
from pathlib import Path

import pytest

from bpy_stub import install as install_bpy_stub

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_PY = ROOT / "runtime" / "py"
KIT = RUNTIME_PY / "core" / "kit.py"

FBX_MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
GLB_MAGIC = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 16

UNITY_FBX = {"bake_anim": True, "add_leaf_bones": False,
             "apply_scale_options": "FBX_SCALE_ALL", "axis_forward": "-Z", "axis_up": "Y"}
UNREAL_FBX = {"bake_anim": True, "add_leaf_bones": False,
              "apply_scale_options": "FBX_SCALE_UNITS", "axis_forward": "-Z", "axis_up": "Y"}
GODOT_GLB = {"export_yup": True, "export_animations": True}


class _Vector:
    """mathutils.Vector 的最小实现：assembly_impl/common.py 在 import 时归一化射线方向。"""

    def __init__(self, values=(0.0, 0.0, 0.0)):
        self.values = [float(v) for v in values]

    def __iter__(self):
        return iter(self.values)

    def __len__(self):
        return len(self.values)

    def __getitem__(self, index):
        return self.values[index]

    def __add__(self, other):
        return _Vector([a + b for a, b in zip(self.values, other)])

    def __sub__(self, other):
        return _Vector([a - b for a, b in zip(self.values, other)])

    def __mul__(self, scalar):
        return _Vector([v * scalar for v in self.values])

    __rmul__ = __mul__

    def normalized(self):
        norm = math.sqrt(sum(v * v for v in self.values)) or 1.0
        return _Vector([v / norm for v in self.values])

    @property
    def x(self):
        return self.values[0]

    @property
    def y(self):
        return self.values[1]

    @property
    def z(self):
        return self.values[2]


def _replace_mathutils():
    """换上够用的 mathutils（bpy_stub 自带的那份没有 Vector.normalized）。返回 (saved, installed)。"""
    names = ("mathutils", "mathutils.bvhtree")
    saved = {name: sys.modules.get(name) for name in names}
    for name in names:
        sys.modules.pop(name, None)
    mathutils = types.ModuleType("mathutils")
    mathutils.Vector = _Vector
    mathutils.Matrix = type("Matrix", (), {})
    mathutils.Euler = type("Euler", (), {})
    bvhtree = types.ModuleType("mathutils.bvhtree")
    bvhtree.BVHTree = type("BVHTree", (), {"FromPolygons": staticmethod(lambda *a, **k: None)})
    mathutils.bvhtree = bvhtree
    sys.modules["mathutils"] = mathutils
    sys.modules["mathutils.bvhtree"] = bvhtree
    return saved, set(names)


@pytest.fixture(scope="module")
def export_lib():
    """bpy/mathutils/内核 stub + 真 kit.py → assembly.assembly_impl.export 包。"""
    saved_mathutils, mathutils_names = _replace_mathutils()
    bpy = install_bpy_stub()          # mathutils 已在 sys.modules → stub 不覆盖
    saved_kernel = sys.modules.get("dsh_rt_kernel")
    kernel = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = kernel
    with open(KIT, encoding="utf-8") as handle:
        exec(compile(handle.read(), str(KIT), "exec"), {})
    added = [name for name in sys.modules if name == "assembly" or name.startswith("assembly.")]
    sys.path.insert(0, str(RUNTIME_PY))
    try:
        import assembly.assembly_impl.export as export_pkg
        yield types.SimpleNamespace(
            bpy=bpy,
            pkg=export_pkg,
            export=export_pkg.asm_export,
            plan=sys.modules["assembly.assembly_impl.export.plan"],
            helpers=sys.modules["assembly.assembly_impl.export.helpers"],
            write=sys.modules["assembly.assembly_impl.export.write"],
            targets=sys.modules["assembly.assembly_impl.export.targets"],
        )
    finally:
        sys.path.remove(str(RUNTIME_PY))
        for name in [n for n in sys.modules if n == "assembly" or n.startswith("assembly.")]:
            if name not in added:
                sys.modules.pop(name, None)
        if saved_kernel is None:
            sys.modules.pop("dsh_rt_kernel", None)
        else:
            sys.modules["dsh_rt_kernel"] = saved_kernel
        for name in mathutils_names:
            sys.modules.pop(name, None)
        for name, module in saved_mathutils.items():
            if module is not None:
                sys.modules[name] = module


class _Obj:
    def __init__(self, name):
        self.name = name
        self.type = "MESH"
        self.hide_render = False
        self.hide_viewport = False
        self.selected = False

    def select_set(self, value):
        self.selected = bool(value)

    def select_get(self):
        return self.selected


def _scene(bpy, monkeypatch, names=("BOX",)):
    objects = [_Obj(name) for name in names]
    monkeypatch.setattr(bpy.data, "objects", {ob.name: ob for ob in objects})
    monkeypatch.setattr(bpy.context, "view_layer",
                        types.SimpleNamespace(objects=list(objects), active=None))
    return objects


def _ops(bpy, monkeypatch, calls, reject_extra=(), minimal=None):
    """假导出器：记录 kwargs、写带魔数的假文件；reject_extra 模拟旧版 Blender 不认关键字。"""
    minimal = minimal or {}
    scene = types.SimpleNamespace()

    def make(op_name, magic):
        def operator(**kwargs):
            calls.append({"op": op_name, "kwargs": dict(kwargs)})
            allowed = minimal.get(op_name)
            if op_name in reject_extra and allowed is not None and set(kwargs) - set(allowed):
                raise TypeError("%s() got an unexpected keyword argument" % op_name)
            with open(kwargs["filepath"], "wb") as handle:
                handle.write(magic)
            return {"FINISHED"}

        return operator

    scene.fbx = make("fbx", FBX_MAGIC)
    scene.gltf = make("gltf", GLB_MAGIC)
    monkeypatch.setattr(bpy.ops, "export_scene", scene)
    return calls


def _patch_heavy_stages(lib, monkeypatch):
    """把 mesh_map / asm_gate 换成确定性结果：本文件只钉 use_case 通道。"""
    monkeypatch.setattr(lib.write, "_mesh_map", lambda objs: ({}, {}))
    monkeypatch.setattr(lib.targets, "asm_gate", lambda **kwargs: json.dumps(
        {"ok": True, "verdict": "pass", "export_allowed": True, "gates": []}))


def _export(lib, **kwargs):
    return json.loads(lib.export(**kwargs))


# ───────────────────────────── A 默认行为零变化 ─────────────────────────────
def test_default_fbx_kwargs_are_byte_identical_to_the_old_call(export_lib, tmp_path, monkeypatch):
    calls = _ops(export_lib.bpy, monkeypatch, [])
    target = tmp_path / "a.fbx"
    rec = export_lib.helpers._asm_export_one("fbx", [], str(target))
    assert rec["exists"] is True and (rec["bytes"] or 0) > 0, rec
    assert calls[0]["kwargs"] == {
        "filepath": str(target), "use_selection": True, "add_leaf_bones": False,
        "bake_anim": False, "apply_scale_options": "FBX_SCALE_ALL",
    }
    # 回执自带证据：调用方不用猜导出器收到了什么
    assert rec["options"] == {"use_selection": True, "add_leaf_bones": False,
                              "bake_anim": False, "apply_scale_options": "FBX_SCALE_ALL"}


def test_default_glb_kwargs_are_byte_identical_to_the_old_call(export_lib, tmp_path, monkeypatch):
    calls = _ops(export_lib.bpy, monkeypatch, [])
    target = tmp_path / "a.glb"
    export_lib.helpers._asm_export_one("glb", [], str(target))
    assert calls[0]["kwargs"] == {
        "filepath": str(target), "export_format": "GLB", "use_selection": True,
        "export_apply": True, "export_yup": True,
    }


def test_default_export_records_use_case_none_without_extra_options(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "out"), name="plain",
                      formats=["fbx"])
    assert receipt["ok"] is True, receipt
    assert receipt["use_case"]["name"] == "none"
    assert receipt["use_case"]["options"] == {}
    assert calls[0]["kwargs"] == {
        "filepath": str(tmp_path / "out" / "plain.fbx"), "use_selection": True,
        "add_leaf_bones": False, "bake_anim": False, "apply_scale_options": "FBX_SCALE_ALL",
    }


# ───────────────────────────── B 预设 ─────────────────────────────
@pytest.mark.parametrize("use_case,expect", [("unity", UNITY_FBX), ("unreal", UNREAL_FBX)])
def test_fbx_presets_bake_animation_and_axis(export_lib, tmp_path, monkeypatch, use_case, expect):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / use_case),
                      name="rig", formats=["fbx"], use_case=use_case)
    assert receipt["ok"] is True, receipt
    assert receipt["use_case"] == {
        "name": use_case, "format": "fbx", "options": {"fbx": expect},
        "overrides": {"bake_anim": None, "add_leaf_bones": None,
                      "apply_scale_options": None, "export_yup": None},
        "allowed": ["none", "unity", "unreal", "godot", "web"],
    }
    kwargs = calls[0]["kwargs"]
    assert kwargs["use_selection"] is True
    for key, value in expect.items():
        assert kwargs[key] == value, (key, kwargs)


@pytest.mark.parametrize("use_case", ["godot", "web"])
def test_glb_presets_export_animations(export_lib, tmp_path, monkeypatch, use_case):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / use_case),
                      name="rig", formats=["glb"], use_case=use_case)
    assert receipt["ok"] is True, receipt
    assert receipt["use_case"]["format"] == "glb"
    assert receipt["use_case"]["options"] == {"glb": GODOT_GLB}
    kwargs = calls[0]["kwargs"]
    assert kwargs["export_format"] == "GLB"
    assert kwargs["export_animations"] is True
    assert kwargs["export_yup"] is True


# ───────────────────────────── C 覆盖优先 ─────────────────────────────
def test_explicit_overrides_win_over_the_preset(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "ov"), name="rig",
                      formats=["fbx"], use_case="unity", bake_anim=False,
                      add_leaf_bones=True, apply_scale_options="FBX_SCALE_NONE")
    assert receipt["ok"] is True, receipt
    kwargs = calls[0]["kwargs"]
    assert kwargs["bake_anim"] is False
    assert kwargs["add_leaf_bones"] is True
    assert kwargs["apply_scale_options"] == "FBX_SCALE_NONE"
    assert receipt["use_case"]["overrides"]["bake_anim"] is False
    assert receipt["use_case"]["options"]["fbx"]["bake_anim"] is False


def test_export_yup_override_reaches_the_glb_operator(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "yup"), name="rig",
                      formats=["glb"], use_case="godot", export_yup=False)
    assert receipt["ok"] is True, receipt
    assert calls[0]["kwargs"]["export_yup"] is False
    assert calls[0]["kwargs"]["export_animations"] is True


def test_overrides_work_with_use_case_none(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "bare"), name="rig",
                      formats=["fbx"], bake_anim=True)
    assert receipt["ok"] is True, receipt
    assert receipt["use_case"]["name"] == "none"
    assert receipt["use_case"]["options"] == {"fbx": {"bake_anim": True}}
    assert calls[0]["kwargs"]["bake_anim"] is True
    assert calls[0]["kwargs"]["apply_scale_options"] == "FBX_SCALE_ALL"


# ───────────────────────────── D 不支持 / 坏参数 ─────────────────────────────
@pytest.mark.parametrize("use_case", ["print", "ar"])
def test_print_and_ar_are_rejected_with_a_route_hint(export_lib, tmp_path, use_case):
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path), use_case=use_case)
    assert receipt["ok"] is False, receipt
    assert receipt["allowed"] == ["none", "unity", "unreal", "godot", "web"]
    hint = str(receipt["hint"])
    assert "deliver_export" in hint
    assert ("stl" in hint) or ("USD" in hint)
    assert not (tmp_path / use_case).exists()


def test_unknown_use_case_is_rejected_instead_of_falling_back(export_lib, tmp_path):
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path), use_case="blender")
    assert receipt["ok"] is False, receipt
    assert receipt["allowed"] == ["none", "unity", "unreal", "godot", "web"]
    assert "blender" in str(receipt["error"])


def test_preset_format_must_be_in_formats(export_lib, tmp_path):
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path), formats=["glb"],
                      use_case="unity")
    assert receipt["ok"] is False, receipt
    assert "fbx" in str(receipt["error"])
    assert str(tmp_path) not in str(receipt.get("files") or {})


def test_override_for_an_absent_format_is_rejected(export_lib, tmp_path):
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path), formats=["glb"],
                      bake_anim=True)
    assert receipt["ok"] is False, receipt
    assert "bake_anim" in str(receipt["error"])


@pytest.mark.parametrize("kwargs", [
    {"bake_anim": "maybe"},
    {"add_leaf_bones": 2},
    {"export_yup": "sure"},
    {"apply_scale_options": "FBX_SCALE_BANANA"},
])
def test_bad_override_values_are_rejected_by_name(export_lib, tmp_path, kwargs):
    name = next(iter(kwargs))
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path), formats=["fbx", "glb"],
                      **kwargs)
    assert receipt["ok"] is False, receipt
    assert name in str(receipt["error"])


# ───────────────────────────── E 不静默丢关键字 ─────────────────────────────
def test_typeerror_never_silently_drops_explicit_options(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    calls = _ops(export_lib.bpy, monkeypatch, [], reject_extra=("fbx",),
                 minimal={"fbx": ("filepath", "use_selection")})
    _patch_heavy_stages(export_lib, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "old"), name="rig",
                      formats=["fbx"], use_case="unity")
    assert receipt["ok"] is False, receipt
    assert receipt["formats_ok"] == []
    err = str(receipt["exports"]["fbx"]["error"])
    assert "bake_anim" in err or "use_case" in err, err
    # 请求过的关键字在失败回执里仍然可见（不能被悄悄抹掉）
    assert receipt["exports"]["fbx"]["options"]["bake_anim"] is True
    assert len(calls) == 1, calls


def test_legacy_typeerror_fallback_still_works_for_the_default_path(export_lib, tmp_path, monkeypatch):
    calls = _ops(export_lib.bpy, monkeypatch, [], reject_extra=("fbx",),
                 minimal={"fbx": ("filepath", "use_selection")})
    rec = export_lib.helpers._asm_export_one("fbx", [], str(tmp_path / "old.fbx"))
    assert rec["exists"] is True and (rec["bytes"] or 0) > 0, rec
    assert len(calls) == 2, calls
    assert calls[1]["kwargs"] == {"filepath": str(tmp_path / "old.fbx"), "use_selection": True}


# ───────────────────────────── F manifest / 回执可自证 ─────────────────────────────
def test_manifest_records_use_case_and_resolved_options(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    _ops(export_lib.bpy, monkeypatch, [])
    _patch_heavy_stages(export_lib, monkeypatch)
    out = tmp_path / "man"
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(out), name="rig",
                      formats=["fbx"], use_case="unreal", bake_anim=True)
    assert receipt["ok"] is True, receipt
    manifest = json.loads(Path(receipt["files"]["manifest"]).read_text(encoding="utf-8"))
    assert manifest["use_case"]["name"] == "unreal"
    assert manifest["use_case"]["options"]["fbx"] == UNREAL_FBX
    assert manifest["use_case"]["overrides"]["bake_anim"] is True
    assert manifest["exports"]["fbx"]["options"]["apply_scale_options"] == "FBX_SCALE_UNITS"
    assert manifest["files"]["fbx"]["verify"]["magic_ok"] is True
    # 回执同样带全量证据
    assert receipt["use_case"]["options"]["fbx"] == UNREAL_FBX
    assert receipt["exports"]["fbx"]["options"]["axis_up"] == "Y"
    # ledger 事件也记 use_case（append-only 流水能自证）
    events = [json.loads(line) for line in
              Path(receipt["files"]["ledger"]).read_text(encoding="utf-8").splitlines() if line.strip()]
    assert events[-1]["use_case"] == "unreal"


def test_dry_run_receipt_shows_use_case(export_lib, tmp_path, monkeypatch):
    _scene(export_lib.bpy, monkeypatch)
    receipt = _export(export_lib, objects=["BOX"], out_dir=str(tmp_path / "dry"), name="rig",
                      formats=["fbx"], use_case="unity", dry_run=True)
    assert receipt["ok"] is True, receipt
    assert receipt["dry_run"] is True
    assert receipt["use_case"]["name"] == "unity"
    assert receipt["use_case"]["options"]["fbx"]["bake_anim"] is True
    assert not (tmp_path / "dry").exists()
