# -*- coding: utf-8 -*-
"""audit_mesh 作用域/来源（2026-11-20 三路并发现场）。

现场两条误判：
  * objects=[] 被静默当成"当前场景全部对象"，审计到用户自己打开的另一个 .blend；
  * 回执没有 source，agent 以为审的是自己造的件。
这里钉住纯逻辑：empty_objects_guard 只放行 None/非空列表；mesh_source 把来源写死。
"""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE = ROOT / "runtime" / "py" / "core" / "audit_impl" / "scope.py"
MESH = ROOT / "runtime" / "py" / "core" / "audit_impl" / "mesh.py"


def _load():
    spec = importlib.util.spec_from_file_location("audit_scope", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_explicit_empty_objects_is_an_error_not_the_whole_scene():
    mod = _load()
    err = mod.empty_objects_guard([], None, None)
    assert err is not None
    assert err["ok"] is False
    assert "objects=[]" in err["error"]
    assert "audit_scene" in err["hint"]
    assert err["scope"] == "objects=[]"


def test_none_scope_and_file_are_legitimate_scopes():
    mod = _load()
    assert mod.empty_objects_guard(None, None, None) is None
    assert mod.empty_objects_guard(["P01"], None, None) is None
    assert mod.empty_objects_guard([], "COL_Geo", None) is None
    assert mod.empty_objects_guard([], None, "D:/proj/a.blend") is None


def test_wrapped_dict_with_empty_list_is_also_explicit():
    mod = _load()
    err = mod.empty_objects_guard({"objects": []}, None, None)
    assert err is not None and err["ok"] is False
    assert mod.empty_objects_guard({"objects": ["P01"]}, None, None) is None


def test_mesh_source_reports_file_scene_scope_and_original_names():
    mod = _load()
    src = mod.mesh_source(
        mode="file",
        file_path="D:/proj/other.blend",
        scene="Scene",
        scope="file",
        objects=["Human", "legwear"],
        requested=["Human"],
        session_file="D:/proj/mine.blend",
    )
    assert src == {
        "mode": "file",
        "file": "D:/proj/other.blend",
        "scene": "Scene",
        "scope": "file",
        "objects": ["Human", "legwear"],
        "requested": ["Human"],
        "session_file": "D:/proj/mine.blend",
    }
    session = mod.mesh_source(mode="session", file_path=None, scene="Scene",
                             scope="current_scene", objects=None)
    assert session["file"] is None and session["objects"] == [] and session["requested"] is None


class _FakeLib:
    def __init__(self, name, path="", dead=False):
        self.name = name
        self.filepath = path
        self.dead = dead

    def __getattribute__(self, attr):
        if attr in ("name", "filepath") and object.__getattribute__(self, "dead"):
            raise ReferenceError("StructRNA of type Library has been removed")
        return object.__getattribute__(self, attr)


def test_library_meta_snapshots_names_before_any_remove():
    mod = _load()
    a, b = _FakeLib("geometry_nodes_essentials.blend", "D:/blender/assets/x.blend"), _FakeLib(
        "geometry_nodes_essentials.blend.001", "D:/blender/assets/x.blend"
    )
    meta = mod.library_meta([a, b, _FakeLib("gone.blend", dead=True)])
    assert [m[1] for m in meta] == [
        "geometry_nodes_essentials.blend",
        "geometry_nodes_essentials.blend.001",
    ]
    assert meta[0][0] is a and meta[1][0] is b


def test_purge_libraries_treats_co_removed_reference_as_removed():
    mod = _load()
    a, b = _FakeLib("a.blend"), _FakeLib("a.blend.001")
    meta = [(a, "a.blend", ""), (b, "a.blend.001", "")]
    state = {"a": False}

    def remove(lib):
        if lib is a:
            state["a"] = True
            return
        if lib is b and state["a"]:
            raise ReferenceError("StructRNA of type Library has been removed")
        raise AssertionError("unexpected library")

    removed, failed = mod.purge_libraries(meta, remove)
    assert removed == ["a.blend", "a.blend.001"]
    assert failed == []


def test_purge_libraries_reports_real_failures():
    mod = _load()
    meta = [(_FakeLib("locked.blend"), "locked.blend", "")]

    def remove(_lib):
        raise RuntimeError("library is in use")

    removed, failed = mod.purge_libraries(meta, remove)
    assert removed == []
    assert failed and "locked.blend" in failed[0] and "in use" in failed[0]


def test_audit_mesh_exposes_file_mode_and_source_echo():
    source = MESH.read_text(encoding="utf-8")
    assert "file=None" in source
    assert "empty_objects_guard(objects, scope, file)" in source
    assert "mesh_source(" in source
    assert "_objs_with_optional_file(objects, scope, True, file)" in source
    assert 'res["source"] = mesh_source(' in source
