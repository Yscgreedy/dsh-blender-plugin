"""audit_scene 的 screen/gate 档位语义（纯逻辑，不 import bpy）。

现场两个误读：
  * 把默认初筛当门（clean=false 却不是几何坏了）；
  * 看到 clean=false 就去改几何（其实只是自检没跑）。
这里钉住三件事：gate 档强制自交检查、screen 档不偷偷升级、矛盾参数直接报错。
"""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE = ROOT / "runtime" / "py" / "core" / "audit_impl" / "scene_profile.py"


def _load():
    spec = importlib.util.spec_from_file_location("audit_scene_profile", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_default_screen_is_not_gate_ready():
    mod = _load()
    opts, err = mod.resolve_scene_profile()
    assert err is None
    assert opts["profile"] == "screen"
    assert opts["self_intersect"] is False
    assert opts["summary_only"] is False
    assert opts["gate_ready"] is False
    assert opts["forced"] == []


def test_gate_profile_forces_complete_check():
    mod = _load()
    opts, err = mod.resolve_scene_profile(profile="gate")
    assert err is None
    assert opts["self_intersect"] is True
    assert opts["summary_only"] is True
    assert opts["gate_ready"] is True
    assert opts["forced"] == ["self_intersect", "summary_only"]


def test_gate_profile_conflict_is_an_error_not_a_silent_override():
    mod = _load()
    opts, err = mod.resolve_scene_profile(profile="gate", self_intersect=False)
    assert opts is None
    assert err["code"] == "GATE_PROFILE_CONFLICT"
    assert "self_intersect=false" in err["error"]
    assert err["hint"]


def test_screen_can_opt_in_to_gate_ready():
    mod = _load()
    opts, err = mod.resolve_scene_profile(profile="screen", self_intersect=True)
    assert err is None
    assert opts["gate_ready"] is True
    assert opts["summary_only"] is False
    assert opts["forced"] == []


def test_unknown_profile_is_rejected():
    mod = _load()
    opts, err = mod.resolve_scene_profile(profile="fast")
    assert opts is None
    assert err["code"] == "BAD_PROFILE"
    assert "screen" in err["error"] and "gate" in err["error"]
