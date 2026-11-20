# -*- coding: utf-8 -*-
"""render 通道指标（render / alpha / mask / ink）的纯函数口径。

这里只测 numpy 纯函数（不碰 bpy）：全透明 / 单连通 / 多连通 / 空掩码，
以及 alpha、ink 两种掩膜与 ink 对象命名识别。真渲染由 Blender E2E 覆盖。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from runtime.py.render.channels_impl import metrics as channels  # noqa: E402


def _rect(shape, y0, y1, x0, x1):
    mask = np.zeros(shape, dtype=bool)
    mask[y0:y1, x0:x1] = True
    return mask


def _rgba(mask, ink=None):
    """把布尔掩膜包成 RGBA：掩膜内 alpha=1，ink 掩膜内像素变暗。"""
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.float32)
    rgba[..., :3] = 1.0
    rgba[..., 3] = np.where(mask, 1.0, 0.0)
    if ink is not None:
        rgba[ink] = np.array([0.0, 0.0, 0.0, 1.0], dtype=np.float32)
    return rgba


def test_empty_mask_metrics_are_zero():
    mask = np.zeros((8, 8), dtype=bool)
    m = channels.metrics_from_mask(mask)
    assert m == {"foreground_px": 0, "coverage": 0.0, "n_components": 0, "bbox": None}
    assert channels.empty_metrics() == m


def test_single_component_metrics():
    mask = _rect((10, 20), 2, 6, 3, 8)  # 4 行 × 5 列 = 20 px
    m = channels.metrics_from_mask(mask)
    assert m["foreground_px"] == 20
    assert m["coverage"] == 0.1  # 20 / (10*20)
    assert m["n_components"] == 1
    assert m["bbox"] == [3, 2, 7, 5]  # x0,y0,x1,y1（含端点）


def test_two_components_and_bbox_span():
    mask = _rect((10, 20), 1, 3, 1, 3) | _rect((10, 20), 6, 9, 14, 18)
    m = channels.metrics_from_mask(mask)
    assert m["n_components"] == 2
    assert m["foreground_px"] == 4 + 12
    assert m["bbox"] == [1, 1, 17, 8]


def test_diagonal_touch_is_two_components_in_four_connectivity():
    mask = np.zeros((3, 3), dtype=bool)
    mask[0, 0] = True
    mask[1, 1] = True
    assert channels.n_components(mask) == 2
    # 4-连通下 L 形仍然是一块
    lmask = np.zeros((3, 3), dtype=bool)
    lmask[0, 0] = lmask[1, 0] = lmask[1, 1] = True
    assert channels.n_components(lmask) == 1


def test_single_pixel_bbox_is_degenerate():
    mask = np.zeros((5, 5), dtype=bool)
    mask[0, 0] = True
    m = channels.metrics_from_mask(mask)
    assert m["bbox"] == [0, 0, 0, 0]
    assert m["coverage"] == 0.04


def test_alpha_mask_thresholds_the_alpha_channel():
    object_mask = _rect((6, 6), 1, 4, 1, 4)
    rgba = _rgba(object_mask)
    rgba[..., 3] = np.where(object_mask, 0.3, 0.0)  # 半透明：alpha 覆盖率仍算，掩膜不算
    assert int(channels.alpha_mask(rgba, alpha_min=0.0).sum()) == 9
    assert int(channels.alpha_mask(rgba, alpha_min=0.5).sum()) == 0
    assert int(channels.alpha_mask(rgba, alpha_min=0.2).sum()) == 9


def test_ink_mask_keeps_dark_pixels_inside_the_object():
    object_mask = _rect((8, 8), 1, 7, 1, 7)
    ink = np.zeros((8, 8), dtype=bool)
    ink[3, 1:7] = True
    rgba = _rgba(object_mask, ink=ink)
    out = channels.ink_mask(rgba, ink_level=0.5)
    assert int(out.sum()) == 6
    assert out[3, 1] and not out[0, 0]


def test_metrics_from_rgba_dispatches_by_channel_name():
    object_mask = _rect((8, 8), 2, 6, 2, 6)
    rgba = _rgba(object_mask)
    alpha = channels.metrics_from_rgba(rgba, "alpha")
    mask = channels.metrics_from_rgba(rgba, "mask")
    render = channels.metrics_from_rgba(rgba, "render")
    assert alpha["foreground_px"] == 16 and alpha["n_components"] == 1
    assert mask["foreground_px"] == 16
    assert render["foreground_px"] == 16
    assert channels.metrics_from_rgba(rgba, "nope") is None


def test_ink_object_names_recognises_common_naming():
    names = ["ink_lines", "Body", "outline_mesh", "描边", "LineArt", "inkwell", "Cube.001"]
    assert channels.ink_object_names(names) == ["ink_lines", "outline_mesh", "描边", "LineArt"]
    assert channels.ink_object_names(["Body", "Cube.001"]) == []


def test_channel_entry_shape_for_ok_and_skipped():
    ok = channels.channel_entry("render", path="D:/out/frame_0001.png", mask=_rect((4, 4), 0, 2, 0, 2))
    assert ok["name"] == "render" and ok["status"] == "ok"
    assert ok["path"] == "D:/out/frame_0001.png"
    assert ok["metrics"]["foreground_px"] == 4
    skipped = channels.channel_entry("ink", status="skipped", reason="no_ink_object")
    assert skipped == {"name": "ink", "status": "skipped", "reason": "no_ink_object"}


def test_receipt_lists_every_requested_channel():
    rgba = _rgba(_rect((4, 4), 0, 2, 0, 2))
    receipt = channels.receipt(
        requested=["render", "ink"],
        images={"render": ("D:/out/r.png", rgba)},
        ink_objects=[],
        frame=1,
    )
    assert receipt["ok"] is True
    assert [c["name"] for c in receipt["channels"]] == ["render", "ink"]
    assert receipt["channels"][1]["status"] == "skipped"
    assert receipt["channels"][1]["reason"] == "no_ink_object"
    assert receipt["frame"] == 1
