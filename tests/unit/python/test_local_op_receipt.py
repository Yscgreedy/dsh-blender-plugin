# -*- coding: utf-8 -*-
"""无 GUI 本地车道：headless 作业驱动的回执语义（纯逻辑，不 import bpy）。

驱动在 Blender 进程里跑一个 catalog op 之后必须自己给回执：
  · 成功 → verdict=pass + 结果摘要；
  · op 自称 ok=false / clean=false → 不能伪装成功；
  · 抛异常 → verdict=degraded + evidence（op / file / stage / 错误摘要）。

本文件只测纯逻辑：驱动源码同时被 Gateway 内联进 headless 作业脚本（见
runtime/execution/local-op/），所以它必须 import 时零副作用、零 bpy。
"""
import importlib
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

DRIVER = importlib.import_module("runtime.py.core.local_op.driver")


def test_parse_result_unwraps_the_json_string_a_dispatch_returns():
    assert DRIVER.parse_result('{"ok": true, "verdict": "pass"}') == {"ok": True, "verdict": "pass"}


def test_parse_result_keeps_dicts_and_wraps_non_objects():
    assert DRIVER.parse_result({"ok": True}) == {"ok": True}
    assert DRIVER.parse_result(None) == {}
    assert DRIVER.parse_result([1, 2]) == {"value": [1, 2]}


def test_parse_result_reports_broken_json_instead_of_pretending_success():
    out = DRIVER.parse_result("not json at all")
    assert out["ok"] is False
    assert out["raw"] == "not json at all"
    assert out["error"]


def test_verdict_prefers_the_explicit_field_from_the_op():
    assert DRIVER.verdict_of({"verdict": "degraded", "ok": True}) == "degraded"
    assert DRIVER.verdict_of({"state": "fail"}) == "fail"


def test_verdict_never_turns_an_unknown_result_into_a_pass():
    assert DRIVER.verdict_of({"ok": True}) == "pass"
    assert DRIVER.verdict_of({"ok": True, "clean": False}) == "degraded"
    assert DRIVER.verdict_of({"ok": False, "error": "boom"}) == "fail"
    assert DRIVER.verdict_of({}) == "degraded"
    assert DRIVER.verdict_of("pass") == "degraded"


def test_receipt_carries_the_job_identity_and_a_summary():
    out = DRIVER.receipt("audit_mesh", "C:/proj/scene.blend", {"ok": True, "summary": "3 objects"})
    assert out["op"] == "audit_mesh"
    assert out["file"] == "C:/proj/scene.blend"
    assert out["stage"] == "op"
    assert out["verdict"] == "pass"
    assert out["ok"] is True
    assert out["degraded"] is False
    assert out["summary"] == "3 objects"
    assert out["evidence"] == {"op": "audit_mesh", "file": "C:/proj/scene.blend", "verdict": "pass"}
    json.dumps(out)


def test_receipt_marks_a_non_pass_result_as_degraded_and_not_ok():
    out = DRIVER.receipt("audit_mesh", "scene.blend", {"ok": True, "clean": False, "offenders": ["a"]})
    assert out["verdict"] == "degraded"
    assert out["ok"] is False
    assert out["degraded"] is True
    assert out["evidence"]["verdict"] == "degraded"
    assert out["offenders"] == ["a"] or out["evidence"].get("offenders") == ["a"]


def test_failure_receipt_is_degraded_and_carries_evidence():
    out = DRIVER.failure_receipt(
        "montage",
        "C:/proj/scene.blend",
        RuntimeError("boom"),
        "Traceback (most recent call last):\nValueError: boom",
    )
    assert out["ok"] is False
    assert out["verdict"] == "degraded"
    assert out["stage"] == "op"
    assert out["degraded"] is True
    evidence = out["evidence"]
    assert evidence["op"] == "montage"
    assert evidence["file"] == "C:/proj/scene.blend"
    assert "boom" in evidence["error"]
    assert "ValueError: boom" in evidence["traceback"]
    assert out["summary"]
    json.dumps(out)


def test_failure_receipt_truncates_a_long_traceback():
    out = DRIVER.failure_receipt("montage", "scene.blend", "plain error", "x" * 5000)
    assert len(out["evidence"]["traceback"]) <= 2000
    assert "plain error" in out["evidence"]["error"]


def test_dumps_keeps_unicode_and_serializes_odd_values():
    text = DRIVER.dumps({"summary": "中文摘要", "box": (1, 2)})
    assert "中文摘要" in text
    assert json.loads(text)["box"] == [1, 2]
