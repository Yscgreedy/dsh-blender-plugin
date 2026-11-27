# -*- coding: utf-8 -*-
"""provider 端口倒置 —— core → render / core → export 两条 2-环的机械断言。

背景：import 图是干净的，但依赖藏在 kernel 属性名上 ——
`core/contract_impl/fingerprint.py: c_evidence` 直接 `getattr(K, "dsh_view_api")`，
`core/gate_impl/api.py: gate_deliver` 直接 `getattr(K, "dsh_deliver_api")`。端口倒置后
core 只认 `view_capture` / `deliver_export` / `deliver_verify` 三个端口名。

本文件钉四件事（外加一条注册点静态锚）：
  a  没注册 view_capture 时 c_evidence 直接 ok:false，且**一次都不碰 bpy**（探针模块任何属性访问即炸）
  b  注册 fake view_capture 后 c_evidence 调它、把回执/错误原样映射
  c  gate_deliver 未注册 deliver_export 时保持 {ok:false, op:'deliver', verdict, blocked} 形状；
     注册 fake 后调一次、payload 带 require_gate:false；verify=false 不调 deliver_verify
  d  源码静态：core 的两个消费方文件里不再出现提供方的私有 API 名
  e  提供方模块尾部的注册行（端口名 + 版本常量）仍在
  f  plan 级 gate 步骤 deliver_verify 端口优先：只注册端口（没有 K.dsh_deliver_api）也能走通；
     端口/API 都没有 ⇒ 同形 error 行；只有旧 API 时按兼容回退跑通
  g  core 全域静态：`runtime/py/core` 下没有任何文件出现提供方的 API 名

加载方式沿用仓库现有做法：真 kit.py 执行进 `types.ModuleType("dsh_rt_kernel")`
（见 test_view_spec_vectors.py），被测 impl 用 `__path__` 指向实现目录的隔离包名导入
（不执行 impl 的 __init__.py，免得把整个域拖进来）。
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

from bpy_stub import install as install_bpy_stub

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_PY = ROOT / "runtime" / "py"
KIT_FILE = RUNTIME_PY / "core" / "kit.py"

CONSUMER_FILES = (
    RUNTIME_PY / "core" / "contract_impl" / "fingerprint.py",
    RUNTIME_PY / "core" / "gate_impl" / "api.py",
)


class _ExplodingBpy(types.ModuleType):
    """bpy 探针：任何属性访问立即失败 —— 拿它证明"这条路径根本没碰 bpy"。"""

    def __getattr__(self, name):
        raise AssertionError("不该触碰 bpy.%s" % name)


def _boot_kernel():
    """执行真 kit.py 到空的模块字典里，返回装着 dsh_kit 的内核模块。"""
    kernel = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = kernel
    with open(KIT_FILE, encoding="utf-8") as fh:
        exec(compile(fh.read(), str(KIT_FILE), "exec"), {})
    return kernel


def _load_isolated(pkg_name, impl_dir, module_name):
    """把 impl 目录挂成一个隔离包，只导入需要的子模块（不跑 impl 的 __init__.py）。"""
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [str(impl_dir)]
    sys.modules[pkg_name] = pkg
    return importlib.import_module(pkg_name + "." + module_name)


@pytest.fixture(scope="module")
def kernel():
    saved = {name: sys.modules.get(name) for name in ("bpy", "dsh_rt_kernel")}
    # 两个消费方在"未注册端口"的分支上都不该碰 bpy；装成炸弹模块，谁碰谁炸。
    sys.modules["bpy"] = _ExplodingBpy("bpy")
    kernel = _boot_kernel()
    try:
        yield kernel
    finally:
        for name in [n for n in sys.modules if n.startswith("_dsh_test_")]:
            del sys.modules[name]
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


@pytest.fixture(scope="module")
def contract_fingerprint(kernel):
    return _load_isolated("_dsh_test_contract", RUNTIME_PY / "core" / "contract_impl", "fingerprint")


@pytest.fixture(scope="module")
def gate_api(kernel):
    return _load_isolated("_dsh_test_gate", RUNTIME_PY / "core" / "gate_impl", "api")


@pytest.fixture
def ports(kernel):
    """每个用例一张干净的端口表：结束后卸载本用例注册的端口，不串味。"""
    saved = dict(getattr(kernel, "dsh_ports", {}) or {})
    yield kernel.dsh_kit
    reg = getattr(kernel, "dsh_ports", None)
    if isinstance(reg, dict):
        reg.clear()
        reg.update(saved)


# ────────────────────────────── a：未注册 = fail-closed，且不碰 bpy


def test_a_evidence_without_port_is_fail_closed(contract_fingerprint, kernel):
    assert kernel.dsh_kit.port_available("view_capture") is False
    payload = json.loads(contract_fingerprint.c_evidence("probe", {"path": "evidence.png"}))
    assert payload["ok"] is False
    assert "view_capture" in payload["error"]
    # bpy 是炸弹模块（module fixture）：走到这里没炸 = 这条路径一个 bpy 属性都没读
    assert isinstance(sys.modules["bpy"], _ExplodingBpy)


# ────────────────────────────── b：注册 fake 后调用 + 原样映射


def test_b_evidence_calls_port_and_maps_success(contract_fingerprint, ports, tmp_path, monkeypatch):
    png = tmp_path / "cap.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nprobe")
    # 成功路径会算几何指纹（吃 bpy）；本用例只测端口映射，把它顶掉。
    monkeypatch.setattr(contract_fingerprint, "_fingerprint", lambda *a, **kw: {"digest": "deadbeef"})
    seen = []

    def fake_capture(spec):
        seen.append(spec)
        return {"ok": True, "width": 8, "height": 6}

    ports.register_port("view_capture", fake_capture, 9)
    payload = json.loads(contract_fingerprint.c_evidence("probe", {"path": str(png), "from": [1, 2, 3]}))

    assert payload["ok"] is True
    assert payload["evidence"]["width"] == 8
    assert payload["evidence"]["height"] == 6
    assert payload["evidence"]["md5"] == hashlib.md5(png.read_bytes()).hexdigest()
    assert payload["evidence"]["fp"] == {"digest": "deadbeef"}
    assert seen == [{"path": str(png), "from": [1, 2, 3]}], "端口应收到原样的 spec（只归一 dict/JSON，不改内容）"
    assert ports.port_info("view_capture")["version"] == 9


def test_b_evidence_maps_port_error_verbatim(contract_fingerprint, ports):
    ports.register_port("view_capture", lambda spec: {"ok": False, "error": "boom"}, 1)
    payload = json.loads(contract_fingerprint.c_evidence("probe", {"path": "evidence.png"}))
    assert payload["ok"] is False
    assert payload["error"] == {"ok": False, "error": "boom"}, "端口回执要原样放进 error（旧行为）"


# ────────────────────────────── c：gate_deliver 的端口与 blocked 形状


def test_c_gate_deliver_without_export_port_keeps_blocked_shape(gate_api, ports, monkeypatch):
    monkeypatch.setattr(gate_api, "gate_run", lambda **kw: json.dumps({"verdict": "pass", "gates": []}))
    payload = json.loads(gate_api.gate_deliver(dir="D:/out", verify=False))
    assert payload["ok"] is False
    assert payload["op"] == "deliver"
    assert payload["blocked"] is True
    assert payload["verdict"] == "pass"
    assert "deliver_export" in payload["error"]


def test_c_gate_deliver_calls_export_then_verify(gate_api, ports, monkeypatch):
    monkeypatch.setattr(gate_api, "gate_run", lambda **kw: json.dumps({"verdict": "pass"}))
    seen = []

    def fake_export(payload):
        seen.append(("export", payload))
        return {"ok": True, "files": ["a.obj"]}

    def fake_verify(payload):
        seen.append(("verify", payload))
        return {"ok": True, "checked": 1}

    ports.register_port("deliver_export", fake_export, 1)
    ports.register_port("deliver_verify", fake_verify, 1)
    payload = json.loads(gate_api.gate_deliver(dir="D:/out", verify=True))

    assert payload["ok"] is True
    assert payload["delivery"] == {"ok": True, "files": ["a.obj"]}
    assert payload["verification"] == {"ok": True, "checked": 1}
    assert [kind for kind, _ in seen] == ["export", "verify"]
    assert seen[0][1]["dir"] == "D:/out"
    assert seen[0][1]["require_gate"] is False, "门已经跑过了，导出侧不许再要求一次"
    assert seen[1][1] == {"path_or_dir": "D:/out"}


def test_c_gate_deliver_skips_verify_when_disabled(gate_api, ports, monkeypatch):
    monkeypatch.setattr(gate_api, "gate_run", lambda **kw: json.dumps({"verdict": "pass"}))
    seen = []
    ports.register_port("deliver_export", lambda payload: seen.append("export") or {"ok": True}, 1)
    ports.register_port("deliver_verify", lambda payload: seen.append("verify") or {"ok": True}, 1)
    payload = json.loads(gate_api.gate_deliver(dir="D:/out", verify=False))
    assert payload["ok"] is True
    assert seen == ["export"]


def test_c_gate_deliver_wraps_port_exception(gate_api, ports, monkeypatch):
    monkeypatch.setattr(gate_api, "gate_run", lambda **kw: json.dumps({"verdict": "pass"}))

    def boom(payload):
        raise RuntimeError("disk full")

    ports.register_port("deliver_export", boom, 1)
    payload = json.loads(gate_api.gate_deliver(dir="D:/out", verify=False))
    assert payload["ok"] is False
    assert payload["op"] == "deliver"
    assert payload["verdict"] == "pass", "门过了，只是端口炸了：verdict 要保留"
    assert payload["error"].startswith("deliver_export 失败：RuntimeError: disk full")
    assert payload["gate"] == {"verdict": "pass"}


# ────────────────────────────── d：core 源码里不再出现提供方的私有 API 名


def test_d_core_sources_do_not_name_provider_apis():
    # 拼接构造，避免本文件自己命中同一规则（仓库现有做法，见 test_gate_eval.py）
    forbidden = ("dsh_" + "view_api", "dsh_" + "deliver_api")
    for path in CONSUMER_FILES:
        src = path.read_text(encoding="utf-8")
        for needle in forbidden:
            assert needle not in src, "%s 仍出现 %s（core 不该认识提供方的私有 API 名）" % (path.name, needle)


# ────────────────────────────── e：提供方注册点（静态锚）


def test_e_providers_register_their_ports():
    view_src = (RUNTIME_PY / "render" / "view.py").read_text(encoding="utf-8")
    deliver_src = (RUNTIME_PY / "export" / "deliver_impl" / "api.py").read_text(encoding="utf-8")

    assert "def _port_capture(" in view_src
    assert 'register_port("view_capture", _port_capture, VIEW_VERSION)' in view_src
    assert "def _port_deliver_export(" in deliver_src
    assert "def _port_deliver_verify(" in deliver_src
    assert 'register_port("deliver_export", _port_deliver_export, DELIVER_VERSION)' in deliver_src
    assert 'register_port("deliver_verify", _port_deliver_verify, DELIVER_VERSION)' in deliver_src
    # 复用已构造的同一个 Api，不复制 export/verify 实现
    assert '_DV_API("export", _port_payload(payload))' in deliver_src
    assert '_DV_API("verify", _port_payload(payload))' in deliver_src


# ────────────────────────────── f：plan 级 gate 步骤走端口（端口优先 + API 回退）


def _deliver_spec(name, args=None):
    return {"name": name, "gates": [
        {"id": "dv", "op": "deliver_verify", "args": args or {"path_or_dir": "D:/out"},
         "pass_if": "ok == True"}]}


def test_f_plan_step_deliver_verify_runs_on_port_only(gate_api, ports, kernel):
    """只注册 deliver_verify 端口、内核里没有 deliver API ⇒ 该门照样跑通。"""
    assert getattr(kernel, "dsh_deliver_api", None) is None
    seen = []
    ports.register_port("deliver_verify", lambda payload: seen.append(payload) or {"ok": True, "checked": 1}, 1)
    payload = json.loads(gate_api.gate_run(spec=_deliver_spec("port-only")))
    assert payload["verdict"] == "pass"
    assert payload["ok"] is True
    assert payload["gates"][0]["state"] == "pass"
    assert seen == [{"path_or_dir": "D:/out"}]


def test_f_plan_step_without_any_provider_reports_error(gate_api, ports, kernel):
    """端口与 API 都没有 ⇒ 同形 error 行（blocked：不静默 pass，也不编造回执）。"""
    assert getattr(kernel, "dsh_deliver_api", None) is None
    payload = json.loads(gate_api.gate_run(spec=_deliver_spec("no-provider")))
    row = payload["gates"][0]
    assert row["state"] == "error"
    assert "端口 deliver_verify" in row["error"]
    assert payload["verdict"] == "fail"
    assert payload["ok"] is False
    assert payload["failed"] == ["dv"]


def test_f_plan_step_falls_back_to_module_api(gate_api, ports, kernel, monkeypatch):
    """端口没注册、但旧的模块 API 在 ⇒ 兼容回退（已 preload deliver 的调用路径不受影响）。"""
    calls = []

    def fake_api(op, args):
        calls.append((op, args))
        return {"ok": True, "checked": 2}

    monkeypatch.setattr(kernel, "dsh_deliver_api", fake_api, raising=False)
    payload = json.loads(gate_api.gate_run(spec=_deliver_spec("api-fallback")))
    assert payload["verdict"] == "pass"
    assert payload["gates"][0]["state"] == "pass"
    assert calls == [("verify", {"path_or_dir": "D:/out"})]


# ────────────────────────────── g：core 全域不再点名提供方的 API


# ────────────────────────────── h：export → core 的 gate 也走端口（export 只认 gate_run）


@contextlib.contextmanager
def _export_runtime():
    """独立 boot：真 bpy stub + 新 kernel + 隔离包加载 export/deliver_impl/export.py。

    module 级 fixture 装的是"碰 bpy 就炸"的探针；export 侧导入需要真 stub，所以这里自带一套，
    退出时把 sys.modules 恢复原状（含 bpy.* 子模块与隔离包）。
    """
    prefixes = ("bpy", "_dsh_test_export")
    saved = {}
    for name in list(sys.modules):
        if name in prefixes or any(name.startswith(p + ".") for p in prefixes) or name == "dsh_rt_kernel":
            saved[name] = sys.modules.pop(name)
    try:
        install_bpy_stub()
        kernel = _boot_kernel()
        mod = _load_isolated("_dsh_test_export", RUNTIME_PY / "export" / "deliver_impl", "export")
        yield kernel, mod
    finally:
        for name in list(sys.modules):
            if name in prefixes or any(name.startswith(p + ".") for p in prefixes) or name == "dsh_rt_kernel":
                del sys.modules[name]
        sys.modules.update(saved)


def test_h_export_gate_runs_on_port_only():
    """只有 gate_run 端口、内核里没有 gate 模块 API ⇒ 门照常跑。"""
    with _export_runtime() as (kernel, mod):
        assert getattr(kernel, "dsh_gate_api", None) is None
        seen = []
        kernel.dsh_kit.register_port(
            "gate_run", lambda payload: seen.append(payload) or {"ok": True, "verdict": "pass", "gates": []}, 3)
        rec, err = mod._dv_export_gate(True, False, "", {"name": "t"}, "assembly", {"g": {}}, [])
        assert err is None
        assert rec["verdict"] == "pass"
        assert seen == [{"spec": {"name": "t"}, "preset": "assembly", "overrides": {"g": {}}}]


def test_h_export_gate_blocks_on_failing_verdict():
    with _export_runtime() as (kernel, mod):
        kernel.dsh_kit.register_port("gate_run", lambda payload: {"ok": False, "verdict": "fail", "failed": ["mesh"]}, 3)
        rec, err = mod._dv_export_gate(True, False, "", None, None, None, [])
        assert rec is None
        assert err["ok"] is False and err["blocked"] is True
        assert err["verdict"] == "fail"
        assert err["gate"] == {"ok": False, "verdict": "fail", "failed": ["mesh"]}
        assert err["error"] == "安全门未通过（verdict=fail）：拒绝导出"


def test_h_deliver_export_require_gate_returns_blocked(tmp_path):
    """端到端：require_gate=true + 门 fail ⇒ 在挑对象（碰 bpy）之前返回 blocked。"""
    with _export_runtime() as (kernel, mod):
        kernel.dsh_kit.register_port("gate_run", lambda payload: {"ok": False, "verdict": "fail"}, 3)
        out = json.loads(mod.deliver_export(dir=str(tmp_path), require_gate=True))
        assert out["ok"] is False and out["blocked"] is True and out["verdict"] == "fail"


def test_h_export_gate_falls_back_to_module_api():
    """端口没注册、旧的 gate 模块 API 在 ⇒ 兼容回退照旧工作。"""
    with _export_runtime() as (kernel, mod):
        calls = []

        def fake_api(op, args):
            calls.append((op, args))
            return {"ok": True, "verdict": "pass"}

        kernel.dsh_gate_api = fake_api
        rec, err = mod._dv_export_gate(True, False, "", "s", None, None, [])
        assert err is None and rec["verdict"] == "pass"
        assert calls == [("run", {"spec": "s", "preset": None, "overrides": None})]


def test_h_export_gate_without_any_provider_is_blocked():
    with _export_runtime() as (kernel, mod):
        rec, err = mod._dv_export_gate(True, False, "", None, None, None, [])
        assert rec is None
        assert err["ok"] is False and err["blocked"] is True
        assert "gate_run 端口不存在" in err["error"]
        assert "preload" in err["hint"]


def test_h_export_gate_force_still_needs_reason():
    with _export_runtime() as (kernel, mod):
        kernel.dsh_kit.register_port("gate_run", lambda payload: {"ok": True, "verdict": "pass"}, 3)
        rec, err = mod._dv_export_gate(True, True, "", None, None, None, [])
        assert rec is None
        assert err["blocked"] is True and "gate_reason" in err["error"]


# ────────────────────────────── i/j：export 全域无 gate API 字面 + 注册锚


def test_i_export_domain_never_names_gate_api():
    needle = "dsh_" + "gate_api"
    offenders = [p.relative_to(RUNTIME_PY).as_posix()
                 for p in sorted((RUNTIME_PY / "export").rglob("*.py"))
                 if "__pycache__" not in p.parts and needle in p.read_text(encoding="utf-8")]
    assert offenders == [], "export 仍点名 gate 的 API：%s" % offenders


def test_j_gate_module_registers_gate_run_port():
    gate_src = (RUNTIME_PY / "core" / "gate_impl" / "api.py").read_text(encoding="utf-8")
    assert "def _port_gate_run(" in gate_src
    assert 'register_port("gate_run", _port_gate_run, GATE_VERSION)' in gate_src
    export_src = (RUNTIME_PY / "export" / "deliver_impl" / "export.py").read_text(encoding="utf-8")
    assert '_KIT.call_port("gate_run", payload)' in export_src
    assert '"dsh_%s_api" % "gate"' in export_src, "兼容回退必须运行时构造 API 名（不写字面）"


def test_g_core_never_names_provider_apis():
    forbidden = ("dsh_" + "view_api", "dsh_" + "deliver_api")
    offenders = []
    for path in sorted((RUNTIME_PY / "core").rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        src = path.read_text(encoding="utf-8")
        for needle in forbidden:
            if needle in src:
                offenders.append("%s: %s" % (path.relative_to(RUNTIME_PY).as_posix(), needle))
    assert offenders == [], "core 仍点名提供方 API：%s" % offenders
