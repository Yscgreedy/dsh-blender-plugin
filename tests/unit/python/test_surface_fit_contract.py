"""Static contract for surface_fit / surface_blend / surface_offset.

This test never imports bpy: it parses runtime/py/geometry/surface.py plus its
surface_impl package and asserts the catalog-declared ops are implemented as the
honest pure-numpy approximations (not the old "M3/M5 refusal" stubs).
"""
import ast
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SURFACE = ROOT / "runtime" / "py" / "geometry" / "surface.py"
SURFACE_IMPL = ROOT / "runtime" / "py" / "geometry" / "surface_impl"
LOCK = ROOT / "tests" / "fixtures" / "capability.lock.json"


def _sources():
    files = [SURFACE]
    if SURFACE_IMPL.is_dir():
        files.extend(sorted(SURFACE_IMPL.glob("*.py")))
    return [(path, path.read_text(encoding="utf-8")) for path in files]


def _trees():
    return [(path, ast.parse(source)) for path, source in _sources()]


def test_surface_fit_is_registered():
    found = False
    for _, tree in _trees():
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute) and func.attr == "register"):
                continue
            if len(node.args) < 3 or not isinstance(node.args[2], ast.Dict):
                continue
            keys = [k.value for k in node.args[2].keys if isinstance(k, ast.Constant)]
            if "fit" in keys:
                found = True
    assert found, "surface.py must register the catalog-declared fit op"


def test_surface_fit_is_implemented_not_a_stub():
    source = "\n".join(text for _, text in _sources())
    assert "def surface_fit(" in source
    assert "fit_loft_sections(" in source
    assert "sliced_ring_fit" in source
    assert "M3_NOT_IMPLEMENTED" not in source
    assert "not implemented in pure-python" not in source


def test_surface_blend_and_offset_are_implemented():
    source = "\n".join(text for _, text in _sources())
    assert "def surface_blend(" in source and "blend_rings(" in source
    assert "def surface_offset(" in source and "offset_vertices(" in source
    assert "_OCCT_MSG" not in source
    assert 'quality": "approximate"' in source


def test_catalog_and_lock_agree_on_surface_ops():
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    surface = next(f for f in lock["families"] if f["f"] == "surface")
    assert surface["ops"] == 11
    assert lock["ops_count"] == 261
