# -*- coding: utf-8 -*-
"""asset 契约族（runtime/py/core/asset.py）的纯逻辑单测。

覆盖不依赖 Blender 与网络的部分：搜索行归一、文件映射选择、路径防越界、
以及 dispatch / 前置校验的错误口径。真实下载与 bpy 导入需要真机（另有 E2E）。
"""
import importlib.util
import json
import os

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ASSET_PATH = os.path.join(ROOT, "runtime", "py", "core", "asset.py")


def _load():
    spec = importlib.util.spec_from_file_location("dsh_asset_under_test", ASSET_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


asset = _load()


def _payload():
    return {
        "armchair_01": {"name": "Armchair", "categories": ["furniture"], "tags": ["seat"],
                        "download_count": 10, "thumbnail_url": {"url": "https://t/1.png"}},
        "desk_01": {"name": "Desk", "categories": ["furniture"], "tags": ["office"],
                    "download_count": 99, "thumbnail_url": "https://t/2.png"},
        "rock_01": {"name": "Rock", "categories": ["nature"], "tags": [],
                    "download_count": 1, "thumbnail_url": None},
    }


def test_search_rows_filters_and_sorts_by_downloads():
    rows = asset._search_rows(_payload(), "desk", 10)
    assert [r["id"] for r in rows] == ["desk_01"]
    assert rows[0]["thumb"] == "https://t/2.png"

    all_rows = asset._search_rows(_payload(), "", 2)
    assert [r["id"] for r in all_rows] == ["desk_01", "armchair_01"]


def test_search_rows_tolerates_non_dict_entries():
    rows = asset._search_rows({"bad": "nope", "ok": {"name": "Ok"}}, "", 5)
    assert [r["id"] for r in rows] == ["ok"]


def test_pick_model_files_prefers_gltf_and_keeps_includes():
    files = {
        "glb": {"1k": {"glb": {"url": "https://x/a.glb"}}},
        "gltf": {"1k": {"gltf": {"gltf": {"url": "https://x/a.gltf"},
                                 "include": {"textures/a.png": {"url": "https://x/a.png"}}}}},
    }
    picked = asset._pick_model_files(files, "1k")
    assert picked["format"] == "gltf"
    assert picked["record"]["url"] == "https://x/a.gltf"
    assert picked["includes"]["textures/a.png"]["url"] == "https://x/a.png"


def test_pick_model_files_reports_missing_resolution():
    files = {"gltf": {"4k": {"gltf": {"url": "https://x/a.gltf"}}}}
    picked = asset._pick_model_files(files, "1k")
    assert picked["unsupported"] is True
    assert picked["allowed_resolutions"] == ["4k"]


def test_safe_join_rejects_traversal(tmp_path):
    assert asset._safe_join(str(tmp_path), "textures/a.png").endswith("a.png")
    with pytest.raises(ValueError):
        asset._safe_join(str(tmp_path), "../outside.txt")


def test_search_rejects_unknown_source():
    out = json.loads(asset.asset_search(source="sketchfab", query="chair"))
    assert out["ok"] is False
    assert out["code"] == "source_unsupported"
    assert out["supported"] == ["polyhaven"]


def test_search_respects_online_access(monkeypatch):
    monkeypatch.setattr(asset, "online_access", lambda: False)
    out = json.loads(asset.asset_search(source="polyhaven", query="chair"))
    assert out["code"] == "network_policy"
    assert "联网" in out["fix"]


def test_fetch_validates_slug_before_network(monkeypatch):
    monkeypatch.setattr(asset, "online_access", lambda: True)
    out = json.loads(asset.asset_fetch(id="../etc/passwd"))
    assert out["ok"] is False
    assert out["code"] == "bad_params"


def test_dispatch_unknown_op_lists_ops():
    out = json.loads(asset.asset_dispatch("nope", "{}"))
    assert out["code"] == "unknown_op"
    assert out["ops"] == ["fetch", "help", "search"]


def test_dispatch_rejects_bad_json():
    out = json.loads(asset.asset_dispatch("search", "{not json"))
    assert out["code"] == "bad_args"


def test_help_lists_both_ops_and_limits():
    out = json.loads(asset.asset_help())
    assert set(out["ops"]) == {"search", "fetch"}
    assert out["sources"]["polyhaven"].startswith("免 key")
    assert any("audit_mesh" in item for item in out["next"])
