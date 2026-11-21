# -*- coding: utf-8 -*-
"""工单 7：worker digest 的纯逻辑字段（不导入 bpy，直接调 _digest_fields）。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from runtime.py.core import worker  # noqa: E402


def _d(digest, **extra):
    row = {"digest": digest, "scope": "scene", "algo": "sha256:12", "truncated": False, "domains": ["objects", "mesh"]}
    row.update(extra)
    return row


def test_changed_is_content_hash_not_mtime():
    same = worker._digest_fields(_d("aaaaaaaaaaaa"), _d("aaaaaaaaaaaa"), 12, "boot")
    assert same["changed"] is False
    assert same["digest_before"] == "aaaaaaaaaaaa"
    assert same["digest_after"] == "aaaaaaaaaaaa"

    diff = worker._digest_fields(_d("aaaaaaaaaaaa"), _d("bbbbbbbbbbbb"), 34, "boot")
    assert diff["changed"] is True
    assert isinstance(diff["digest_scope"], list)


def test_never_auto_restores():
    fields = worker._digest_fields(_d("aaaaaaaaaaaa"), _d("bbbbbbbbbbbb"), 7, "boot-degraded")
    assert fields["auto_restore"] is False
    assert fields["restore_applied"] is False
    assert fields["kit_source"] == "boot-degraded"
    assert fields["digest_scope"] == ["objects", "mesh"]
    assert fields["elapsed_ms"] == 7


def test_kit_source_labels():
    old = worker._boot_info
    try:
        worker._boot_info = {"skipped": True}
        assert worker._kit_source() == "bootstrap"
        worker._boot_info = {"ok": False}
        assert worker._kit_source() == "boot-degraded"
        worker._boot_info = {"ok": True}
        assert worker._kit_source() == "boot"
    finally:
        worker._boot_info = old

def test_filepath_is_not_part_of_the_content_hash():
    """反馈 4：同内容 save_as 换路径必须 changed=false；路径单独报 filepath_changed。"""
    before = _d("aaaaaaaaaaaa", file="D:/proj/a.blend", faces=6)
    after = _d("aaaaaaaaaaaa", file="D:/proj/b.blend", faces=6)
    fields = worker._digest_fields(before, after, 3, "boot")
    assert fields["changed"] is False
    assert fields["filepath_changed"] is True
    assert fields["filepath_before"] == "D:/proj/a.blend"
    assert fields["filepath_after"] == "D:/proj/b.blend"
    same = worker._digest_fields(before, dict(before), 3, "boot")
    assert same["filepath_changed"] is False


def test_faces_and_verts_deltas_are_reported():
    before = _d("aaaaaaaaaaaa", faces=6, verts=8, objects=1)
    after = _d("bbbbbbbbbbbb", faces=54, verts=56, objects=2)
    fields = worker._digest_fields(before, after, 5, "boot")
    assert fields["faces_delta"] == 48
    assert fields["verts_delta"] == 48
    assert fields["objects_delta"] == 1


def test_frame_is_reported_but_not_part_of_changed():
    """只读 frame_set 不能 changed=true；frame 单独回报（现场 7f30f12d77d6→3039b9a84278）。"""
    before = _d("aaaaaaaaaaaa", frame=1, eval_faces=18, eval_verts=24)
    after = _d("aaaaaaaaaaaa", frame=25, eval_faces=18, eval_verts=24)
    fields = worker._digest_fields(before, after, 3, "boot")
    assert fields["changed"] is False
    assert fields["frame_before"] == 1
    assert fields["frame_after"] == 25
    assert fields["eval_faces_before"] == 18
    assert fields["eval_faces_after"] == 18
    assert fields["eval_faces_delta"] == 0


def test_eval_counts_are_reported_separately_from_base():
    before = _d("aaaaaaaaaaaa", faces=18, eval_faces=18, eval_verts=24)
    after = _d("bbbbbbbbbbbb", faces=18, eval_faces=90, eval_verts=96)
    fields = worker._digest_fields(before, after, 3, "boot")
    assert fields["faces_before"] == 18
    assert fields["faces_after"] == 18
    assert fields["eval_faces_before"] == 18
    assert fields["eval_faces_after"] == 90
    assert fields["eval_faces_delta"] == 72
    assert fields["eval_verts_after"] == 96
    assert fields["changed"] is True


def test_digest_reports_ms_and_limited():
    fields = worker._digest_fields(
        _d("aaaaaaaaaaaa", digest_ms=7, limited=True),
        _d("bbbbbbbbbbbb", digest_ms=9, limited=True),
        9,
        "boot",
    )
    assert fields["digest_ms"] == 9
    assert fields["digest_limited"] is True
    full = worker._digest_fields(_d("a", digest_ms=4), _d("a", digest_ms=4), 4, "boot")
    assert full["digest_limited"] is False
    assert full["digest_ms"] == 4


def test_scene_digest_does_not_hash_filepath():
    import inspect

    source = inspect.getsource(worker._scene_digest)
    assert '("F|"' not in source
    assert "_hash_materials" in source
