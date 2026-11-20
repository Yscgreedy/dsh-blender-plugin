# -*- coding: utf-8 -*-
"""FFMPEG probe: the static enum must not be trusted without the assignment.

Blender can expose FFMPEG in file_format.enum_items while assigning it raises
TypeError with a shorter dynamic list.  The blockout turntable precheck therefore
probes the write itself and reports both flags.  This test uses a fake image
settings object; real Blender behaviour is covered by the 5.3 E2E probe.
"""
from __future__ import annotations

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

# blockout requires the shared kernel at import time (kit.j).
_KERNEL = types.ModuleType("dsh_rt_kernel")
_KERNEL.dsh_kit = types.SimpleNamespace(
    j=lambda o: json.dumps(o, ensure_ascii=False),
    register=lambda *args, **kwargs: None,
)
sys.modules.setdefault("dsh_rt_kernel", _KERNEL)

# Minimal bpy/bmesh/mathutils surface for module import; only the fake IMS is used.
_BPY = types.ModuleType("bpy")
_BPY.context = types.SimpleNamespace(
    scene=types.SimpleNamespace(render=types.SimpleNamespace(image_settings=None))
)
sys.modules.setdefault("bpy", _BPY)
sys.modules.setdefault("bmesh", types.ModuleType("bmesh"))
_MU = types.ModuleType("mathutils")
_MU.Euler = type("Euler", (), {})
_MU.Matrix = type("Matrix", (), {})
_MU.Vector = type("Vector", (), {})
sys.modules.setdefault("mathutils", _MU)

from runtime.py.geometry.blockout_impl import present  # noqa: E402

# Do not leak the import-only bmesh/mathutils stubs into other tests: the
# import-smoke boundary expects them to be missing outside Blender.
sys.modules.pop("bmesh", None)


class _Item:
    def __init__(self, identifier):
        self.identifier = identifier


class _Prop:
    enum_items = [_Item("PNG"), _Item("FFMPEG")]


class _RNA:
    properties = {"file_format": _Prop()}


class _FakeIMS:
    bl_rna = _RNA()

    def __init__(self):
        self._fmt = "PNG"
        self.media_type = "IMAGE"

    @property
    def file_format(self):
        return self._fmt

    @file_format.setter
    def file_format(self, value):
        if value == "FFMPEG":
            raise TypeError('enum "FFMPEG" not found in (AVIF,JPEG,OPEN_EXR,PNG)')
        self._fmt = value


def test_static_enum_true_but_assignment_false_is_not_available():
    ims = _FakeIMS()
    out = present._ffmpeg_probe(ims)
    assert out["enum_static"] is True
    assert out["assign_ok"] is False
    assert out["available"] is False
    assert "赋值失败" in out["error"]
    # The probe must leave the caller's settings exactly as it found them.
    assert ims.file_format == "PNG"
    assert ims.media_type == "IMAGE"


def test_probe_restores_media_type_after_successful_assignment():
    class _OKIMS(_FakeIMS):
        @_FakeIMS.file_format.setter
        def file_format(self, value):
            self._fmt = value

    ims = _OKIMS()
    out = present._ffmpeg_probe(ims)
    assert out["enum_static"] is True
    assert out["assign_ok"] is True
    assert out["available"] is True
    assert ims.file_format == "PNG"
    assert ims.media_type == "IMAGE"

def test_missing_k_action_fcurves_uses_local_fallback_without_warning(monkeypatch):
    class _Curve:
        def __init__(self, pointer):
            self._pointer = pointer
            self.keyframe_points = [types.SimpleNamespace(interpolation="BEZIER")]

        def as_pointer(self):
            return self._pointer

    curve = _Curve(7)
    action = types.SimpleNamespace(fcurves=[curve])
    cam = types.SimpleNamespace(animation_data=types.SimpleNamespace(action=action))

    monkeypatch.setattr(present, "_K", types.SimpleNamespace())
    monkeypatch.setattr(present, "_KIT", types.SimpleNamespace())
    warnings = []
    count = present._linearize_camera_action(cam, warnings)
    assert count == 1
    assert warnings == []
    assert curve.keyframe_points[0].interpolation == "LINEAR"


def test_missing_k_action_fcurves_falls_back_for_layered_actions(monkeypatch):
    class _Curve:
        def __init__(self, pointer):
            self._pointer = pointer
            self.keyframe_points = [types.SimpleNamespace(interpolation="BEZIER")]

        def as_pointer(self):
            return self._pointer

    curve = _Curve(11)
    slot = object()
    strip = types.SimpleNamespace(
        channelbag=lambda candidate: types.SimpleNamespace(fcurves=[curve])
        if candidate is slot
        else None
    )
    action = types.SimpleNamespace(layers=[types.SimpleNamespace(strips=[strip])], slots=[slot])
    cam = types.SimpleNamespace(animation_data=types.SimpleNamespace(action=action))

    monkeypatch.setattr(present, "_K", types.SimpleNamespace())
    monkeypatch.setattr(present, "_KIT", types.SimpleNamespace())
    assert present._linearize_camera_action(cam, []) == 1
    assert curve.keyframe_points[0].interpolation == "LINEAR"
