# -*- coding: utf-8 -*-
"""File-level checkpoint stack in the hot headless worker (blender_run action=worker).

Field report: three discarded iterations were recovered only by hand-saving five
intermediate .blend files. The worker now owns a checkpoint stack; these tests pin
the stack, the naming, the index persistence and the revert target selection with a
stub bpy (no Blender required).
"""
from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "runtime" / "py" / "core" / "worker.py"


class StubBpy:
    """Minimal bpy surface the checkpoint ops touch."""

    def __init__(self) -> None:
        self.saved = []
        self.opened = []
        self.objects = [type("Obj", (), {"name": name})() for name in ("Cube", "Mesh_0")]
        self.filepath = ""
        ops = types.SimpleNamespace(
            wm=types.SimpleNamespace(
                save_as_mainfile=self._save, open_mainfile=self._open
            )
        )
        self.ops = ops
        self.data = types.SimpleNamespace(objects=self.objects, filepath="")
        self.context = types.SimpleNamespace(scene=types.SimpleNamespace())

    def _save(self, filepath, check_existing=False, copy=False):
        Path(filepath).write_bytes(b"BLENDER-v300")
        self.saved.append({"filepath": filepath, "check_existing": check_existing, "copy": copy})
        return {"FINISHED"}

    def _open(self, filepath):
        if not Path(filepath).exists():
            raise RuntimeError("no such file: " + str(filepath))
        self.opened.append(filepath)
        self.data.filepath = filepath
        return {"FINISHED"}


@pytest.fixture()
def worker(monkeypatch):
    stub = StubBpy()
    monkeypatch.setitem(sys.modules, "bpy", stub)
    monkeypatch.setitem(sys.modules, "mathutils", types.ModuleType("mathutils"))
    monkeypatch.setitem(sys.modules, "math", __import__("math"))
    spec = importlib.util.spec_from_file_location("dsh_worker_under_test", WORKER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    module._CHECKPOINTS.clear()
    return module, stub


def test_checkpoint_writes_a_file_and_pushes_the_stack(worker, tmp_path):
    module, stub = worker
    out = module._checkpoint({"label": "s1 raw", "dir": str(tmp_path)})

    assert out["ok"] is True
    assert out["count"] == 1
    record = out["checkpoint"]
    assert Path(record["path"]).exists()
    assert Path(record["path"]).name == "01_s1_raw.blend"
    assert record["objects"] == 2
    assert stub.saved[0]["copy"] is True  # the worker keeps its own filepath
    assert out["revert"].endswith('label="s1_raw"')


def test_index_persists_across_process_restarts(worker, tmp_path):
    module, _ = worker
    module._checkpoint({"label": "s1", "dir": str(tmp_path)})
    module._checkpoint({"label": "s2", "dir": str(tmp_path)})

    index = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    assert [row["label"] for row in index] == ["s1", "s2"]

    module._CHECKPOINTS.clear()
    listed = module._checkpoints({"dir": str(tmp_path)})
    assert listed["count"] == 2
    assert listed["last"]["label"] == "s2"
    assert all(row["exists"] for row in listed["stack"])


def test_revert_loads_the_named_checkpoint_last_opens_the_newest(worker, tmp_path):
    module, stub = worker
    module._checkpoint({"label": "s1", "dir": str(tmp_path)})
    module._checkpoint({"label": "s2", "dir": str(tmp_path)})

    named = module._revert({"label": "s1", "dir": str(tmp_path)})
    assert named["ok"] is True
    assert Path(named["restored_from"]["path"]).name == "01_s1.blend"
    assert stub.opened[-1].endswith("01_s1.blend")

    last = module._revert({"label": "last", "dir": str(tmp_path)})
    assert last["ok"] is True
    assert last["restored_from"]["label"] == "s2"


def test_revert_reports_unknown_and_missing_files(worker, tmp_path):
    module, _ = worker
    missing = module._revert({"label": "nope", "dir": str(tmp_path)})
    assert missing["ok"] is False
    assert "没有匹配的 checkpoint" in missing["error"]

    out = module._checkpoint({"label": "s1", "dir": str(tmp_path)})
    Path(out["checkpoint"]["path"]).unlink()
    gone = module._revert({"label": "s1", "dir": str(tmp_path)})
    assert gone["ok"] is False
    assert "已不在磁盘" in gone["error"]
