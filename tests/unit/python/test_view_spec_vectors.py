# -*- coding: utf-8 -*-
"""view.py 的 from/look_at 解析（3.2.0-alpha.1 复测现场）。

现场：`blender_see(viewpoint="custom", from="7,-7,5", look_at="0,0,1")` 回 502，
addon 侧 `ValueError: could not convert string to float: ','`。根因是 `_spec` 对字符串直接
`[float(v) for v in frm]` —— 迭代字符串拿到的是字符，第二个字符正好是逗号。

这些用例钉住三件事：字符串与数组都收、带括号/空格/分号也能收、解析失败时报**原串**。
"""
from __future__ import annotations

import importlib
import json
import pathlib
import sys
import types

import pytest

from bpy_stub import install as install_bpy_stub

ROOT = pathlib.Path(__file__).resolve().parents[3]
RUNTIME_PY = ROOT / "runtime" / "py"
KIT = RUNTIME_PY / "core" / "kit.py"


def _boot_kernel() -> None:
    kernel = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = kernel
    with open(KIT, encoding="utf-8") as fh:
        exec(compile(fh.read(), str(KIT), "exec"), {})


@pytest.fixture(scope="module")
def view():
    install_bpy_stub()
    saved = sys.modules.get("dsh_rt_kernel")
    _boot_kernel()
    for name in [n for n in sys.modules if n == "render" or n.startswith("render.")]:
        del sys.modules[name]
    sys.path.insert(0, str(RUNTIME_PY))
    try:
        yield importlib.import_module("render.view")
    finally:
        sys.path.remove(str(RUNTIME_PY))
        for name in [n for n in sys.modules if n == "render" or n.startswith("render.")]:
            del sys.modules[name]
        if saved is None:
            sys.modules.pop("dsh_rt_kernel", None)
        else:
            sys.modules["dsh_rt_kernel"] = saved


def test_comma_string_is_parsed(view):
    # 现场原串：这正是那个 502 的输入
    s = view._spec({"from": "7,-7,5", "look_at": "0, 0, 1"})
    assert s["from"] == [7.0, -7.0, 5.0]
    assert s["look_at"] == [0.0, 0.0, 1.0]


def test_array_and_bracketed_forms(view):
    # worker 的 see 走数组；文档写的是 "x,y,z"；两种都不能挑
    assert view._spec({"from": [7, -7, 5], "look_at": [0, 0, 1]})["from"] == [7.0, -7.0, 5.0]
    bracketed = view._spec({"from": "[7, -7, 5]", "look_at": "(0 0 1)"})
    assert bracketed["from"] == [7.0, -7.0, 5.0]
    assert bracketed["look_at"] == [0.0, 0.0, 1.0]


def test_defaults_when_vectors_are_absent(view):
    s = view._spec({})
    assert s["from"] == [7.0, -7.0, 5.0]
    assert s["look_at"] == [0.0, 0.0, 1.0]


def test_bad_vector_names_the_field_and_the_raw_value(view):
    with pytest.raises(ValueError) as err:
        view._spec({"from": "7,,x", "look_at": [0, 0, 1]})
    msg = str(err.value)
    assert "from" in msg
    assert "7,,x" in msg  # 只报 "float: xy" 根本不知道调用方传了什么


def test_empty_vector_is_an_error_not_the_default(view):
    # 缺省才用默认机位；显式给了但是空的 → 必须报错，不能静默换一个机位
    with pytest.raises(ValueError):
        view._vec3("", None, "from")
    with pytest.raises(ValueError):
        view._vec3([], None, "from")


def test_capture_rejects_a_bad_vector_before_touching_the_gpu(view):
    # capture() 是 /view 真正调用的入口：解析必须在建离屏缓冲之前失败
    with pytest.raises(ValueError) as err:
        view.capture(json.dumps({"from": "7,-7", "look_at": [0, 0, 1]}))
    assert "from" in str(err.value)
    assert "7,-7" in str(err.value)
