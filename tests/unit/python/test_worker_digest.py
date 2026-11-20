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
