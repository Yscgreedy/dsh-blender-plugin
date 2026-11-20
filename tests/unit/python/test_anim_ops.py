# -*- coding: utf-8 -*-
"""anim_* 族单测（fake-bpy，无 Blender）。

钉住四件事：
  1. 纯逻辑：pose 归一/校验、权重覆盖、三态聚合、变形度量（边长/面积/翻转面）；
  2. 分派：未知 op 回允许列表，失败回执带 repro 命令串；
  3. 三态：pass / fail / degraded 各自有可复现的构造；
  4. bpy 面：用 SimpleNamespace 形的假对象喂 rig_report / pose_apply / deform_audit，
     证明"读骨架 / 施 pose / 比 rest-evaluated"这三条路径真的走了。

真实 Blender 行为不在本文件（E2E 层负责）；这里只证明纯逻辑与回执形状。
"""
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_PY = ROOT / "runtime" / "py"
KIT = RUNTIME_PY / "core" / "kit.py"

ALLOWED_OPS = ["deform_audit", "help", "pose_apply", "rig_report"]


def _boot_kernel():
    kernel = types.ModuleType("dsh_rt_kernel")
    sys.modules["dsh_rt_kernel"] = kernel
    with open(KIT, encoding="utf-8") as fh:
        exec(compile(fh.read(), str(KIT), "exec"), {})


@pytest.fixture()
def anim():
    saved = sys.modules.get("dsh_rt_kernel")
    _boot_kernel()
    for name in [n for n in list(sys.modules) if n == "core" or n.startswith("core.")]:
        del sys.modules[name]
    sys.path.insert(0, str(RUNTIME_PY))
    try:
        yield importlib.import_module("core.anim")
    finally:
        sys.path.remove(str(RUNTIME_PY))
        if saved is None:
            sys.modules.pop("dsh_rt_kernel", None)
        else:
            sys.modules["dsh_rt_kernel"] = saved


# ── 假 bpy ──────────────────────────────────────────────────────────────────


class _Objects:
    def __init__(self, items=None):
        self._items = list(items or [])

    def get(self, name, default=None):
        for ob in self._items:
            if getattr(ob, "name", None) == name:
                return ob
        return default

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


def _action(name, start=1.0, end=48.0):
    return types.SimpleNamespace(name=name, frame_range=(start, end))


def make_bpy(objects=(), actions=(), engine="BLENDER_EEVEE_NEXT", depsgraph=None):
    scene = types.SimpleNamespace(
        frame_start=1,
        frame_end=48,
        render=types.SimpleNamespace(engine=engine),
    )
    context = types.SimpleNamespace(
        scene=scene,
        evaluated_depsgraph_get=lambda: depsgraph,
    )
    data = types.SimpleNamespace(objects=_Objects(objects), actions=list(actions))
    return types.SimpleNamespace(data=data, context=context)


def make_armature(name="Armature", bones=("Hips", "Spine"), deform=("Hips",), constraints=None):
    data_bones = [
        types.SimpleNamespace(name=b, use_deform=(b in deform)) for b in bones
    ]
    pose_bones = []
    for b in bones:
        cons = [types.SimpleNamespace(type=t) for t in (constraints or {}).get(b, [])]
        pose_bones.append(
            types.SimpleNamespace(
                name=b,
                constraints=cons,
                location=[0.0, 0.0, 0.0],
                rotation_euler=[0.0, 0.0, 0.0],
                rotation_quaternion=[1.0, 0.0, 0.0, 0.0],
                scale=[1.0, 1.0, 1.0],
            )
        )
    return types.SimpleNamespace(
        name=name,
        type="ARMATURE",
        data=types.SimpleNamespace(bones=data_bones),
        pose=types.SimpleNamespace(bones=pose_bones),
    )


def make_mesh(name="Body", armature=None, group_names=("Hips",), weights=(1.0, 0.0), me=None):
    verts = []
    for w in weights:
        groups = [types.SimpleNamespace(group=0, weight=w)] if w else []
        verts.append(types.SimpleNamespace(groups=groups, co=[0.0, 0.0, 0.0]))
    modifiers = []
    if armature is not None:
        modifiers.append(types.SimpleNamespace(type="ARMATURE", object=armature, name="Armature"))
    if me is None:
        me = types.SimpleNamespace(vertices=verts, edges=[], polygons=[])
    return types.SimpleNamespace(
        name=name,
        type="MESH",
        data=me,
        vertex_groups=[types.SimpleNamespace(name=g, index=i) for i, g in enumerate(group_names)],
        modifiers=modifiers,
        evaluated_get=None,
    )


def make_grid(name="Body", armature=None, size=1.0, offset=0.0, flip=False):
    """2×2 平面（4 顶点 / 4 边 / 1 面）；offset 拉伸 x，flip 反转绕序。"""
    s = size
    verts = [
        types.SimpleNamespace(co=[x, y, 0.0])
        for x, y in ((-s, -s), (s, -s), (s, s), (-s, s))
    ]
    edges = [types.SimpleNamespace(vertices=e) for e in ((0, 1), (1, 2), (2, 3), (3, 0))]
    order = (3, 2, 1, 0) if flip else (0, 1, 2, 3)
    faces = [types.SimpleNamespace(vertices=order)]
    me = types.SimpleNamespace(vertices=verts, edges=edges, polygons=faces)
    me_stretched = types.SimpleNamespace(
        vertices=[types.SimpleNamespace(co=[x + offset, y, 0.0]) for x, y in (
            (-s, -s), (s, -s), (s, s), (-s, s))],
        edges=edges,
        polygons=faces,
    )
    ob = make_mesh(name=name, armature=armature, me=me)
    ob.data = me
    return ob, me_stretched


# ── 纯逻辑 ───────────────────────────────────────────────────────────────────


def test_normalize_pose_rejects_unknown_channel_with_allowed_list(anim):
    with pytest.raises(ValueError) as exc:
        anim.normalize_pose({"Hips": {"rotate": [0, 0, 1]}})
    message = str(exc.value)
    assert "rotation_euler" in message and "rotation_quaternion" in message
    assert "rotate" in message


def test_normalize_pose_rejects_wrong_length_and_bool(anim):
    with pytest.raises(ValueError) as exc:
        anim.normalize_pose({"Hips": {"location": [1, 2]}})
    assert "location" in str(exc.value)
    with pytest.raises(ValueError):
        anim.normalize_pose({"Hips": {"scale": [True, 1, 1]}})


def test_normalize_pose_expands_scalar_and_keeps_quaternion_arity(anim):
    plan = anim.normalize_pose(
        {"Hips": {"location": 0, "rotation_quaternion": [1, 0, 0, 0]}}
    )
    assert plan["Hips"]["location"] == [0.0, 0.0, 0.0]
    assert plan["Hips"]["rotation_quaternion"] == [1.0, 0.0, 0.0, 0.0]


def test_pose_delta_reports_changed_channels_only(anim):
    before = {"Hips": {"location": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}}
    after = {"Hips": {"location": [0.0, 0.0, 1.5], "scale": [1.0, 1.0, 1.0]}}
    rows = anim.pose_delta(before, after)
    assert [r["channel"] for r in rows] == ["location"]
    assert rows[0]["delta"] == [0.0, 0.0, 1.5]


def test_weight_coverage_filters_to_deform_bones_and_samples_unbound(anim):
    cov = anim.weight_coverage(
        [["Hips", "Spine"], ["Spine"], [], ["Prop"]], deform_bones=("Hips", "Spine")
    )
    assert cov["vertices"] == 4
    assert cov["weighted"] == 2
    assert cov["unweighted"] == 2
    assert cov["coverage"] == 0.5
    assert cov["unbound_sample"] == [2, 3]
    assert anim.coverage_status(cov, min_coverage=0.6) == "fail"
    assert anim.coverage_status(cov, min_coverage=0.4) == "degraded"
    assert anim.coverage_status(
        {"vertices": 2, "weighted": 2, "unweighted": 0, "coverage": 1.0}
    ) == "pass"


def test_aggregate_verdict_is_three_state_and_degraded_is_not_pass(anim):
    assert anim.aggregate_verdict([{"id": "a", "status": "pass"}])["verdict"] == "pass"
    assert (
        anim.aggregate_verdict(
            [{"id": "a", "status": "pass"}, {"id": "b", "status": "degraded"}]
        )["verdict"]
        == "degraded"
    )
    failed = anim.aggregate_verdict(
        [{"id": "a", "status": "degraded"}, {"id": "b", "status": "fail"}]
    )
    assert failed["verdict"] == "fail"
    assert failed["failed"] == ["b"]
    assert failed["degraded"] == ["a"]


def test_edge_and_face_metrics_detect_stretch_and_flip(anim):
    rest = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)]
    stretched = [(0.0, 0.0, 0.0), (2.0, 0.0, 0.0), (2.0, 1.0, 0.0), (0.0, 1.0, 0.0)]
    edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
    faces = [(0, 1, 2, 3)]
    stats = anim.edge_stats(rest, stretched, edges, tol=0.05)
    assert stats["edges"] == 4
    assert stats["outside"] == 2  # (0,1) 与 (2,3) 长度 1 → 2
    assert round(stats["max_ratio"], 4) == 2.0
    faces_stats = anim.face_stats(rest, stretched, faces, tol=0.1)
    assert faces_stats["flipped"] == 0
    # 负缩放/镜像会翻法线：顶点镜像、绕序不变 ⇒ 同一面在 rest/evaluated 法线反向
    mirrored = [(-x, y, z) for x, y, z in rest]
    flipped = anim.face_stats(rest, mirrored, faces, tol=0.1)
    assert flipped["flipped"] == 1


# ── 分派 / 回执形状 ──────────────────────────────────────────────────────────


def test_dispatch_unknown_op_returns_allowed_ops_and_repro(anim):
    out = json.loads(anim.anim_dispatch("nope", "{}"))
    assert out["ok"] is False
    assert out["ops"] == ALLOWED_OPS
    assert out["repro"].startswith('blender_op(op="anim_nope"')


def test_failed_receipts_carry_a_runnable_repro(anim):
    out = json.loads(anim.anim_dispatch("pose_apply", "{}"))
    assert out["ok"] is False
    assert out["verdict"] == "fail"
    assert out["repro"] == 'blender_op(op="anim_pose_apply", args={})'


def test_rig_report_without_armature_fails_with_hint_and_repro(anim, monkeypatch):
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[make_mesh(name="Body")]))
    out = json.loads(anim.anim_dispatch("rig_report", json.dumps({"objects": ["Body"]})))
    assert out["ok"] is False
    assert out["verdict"] == "fail"
    assert out["repro"].startswith('blender_op(op="anim_rig_report"')
    assert "ARMATURE" in out["hint"]


def test_rig_report_without_bpy_is_degraded_not_crash(anim, monkeypatch):
    def boom():
        raise ImportError("no bpy in this interpreter")

    monkeypatch.setattr(anim, "_bpy", boom)
    out = json.loads(anim.anim_dispatch("rig_report", json.dumps({"objects": ["Armature"]})))
    assert out["ok"] is False
    assert out["verdict"] == "degraded"
    assert "bpy" in out["warnings"][0]
    assert out["repro"]


# ── bpy 面（假对象） ─────────────────────────────────────────────────────────


def test_rig_report_reads_bones_constraints_weights_and_actions(anim, monkeypatch):
    arm = make_armature(constraints={"Spine": ["IK"]})
    body = make_mesh(armature=arm, weights=(1.0, 1.0))
    monkeypatch.setitem(
        sys.modules, "bpy", make_bpy(objects=[arm, body], actions=[_action("Walk")])
    )
    out = json.loads(
        anim.anim_dispatch(
            "rig_report", json.dumps({"objects": ["Armature"], "min_coverage": 0.5})
        )
    )
    assert out["ok"] is True, out
    assert out["verdict"] == "pass"
    rig = out["rigs"][0]
    assert rig["bones"] == 2 and rig["deform_bones"] == 1
    assert rig["constraint_count"] == 1 and rig["ik_bones"] == ["Spine"]
    assert rig["weights"]["coverage"] == 1.0
    assert out["scene"]["actions"] == 1
    ids = [item["id"] for item in out["items"]]
    assert ids == ["bones", "constraints", "weights", "actions", "frame_range"]


def test_rig_report_flags_unweighted_mesh_as_degraded(anim, monkeypatch):
    arm = make_armature()
    body = make_mesh(armature=arm, weights=(1.0, 0.0, 0.0, 0.0))
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[arm, body], actions=[]))
    out = json.loads(anim.anim_dispatch("rig_report", json.dumps({"objects": ["Armature"]})))
    weights = [item for item in out["items"] if item["id"] == "weights"][0]
    assert weights["status"] == "fail"
    assert out["verdict"] == "fail"
    actions = [item for item in out["items"] if item["id"] == "actions"][0]
    assert actions["status"] == "degraded"


def test_pose_apply_reports_applied_bones_and_delta(anim, monkeypatch):
    arm = make_armature()
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[arm]))
    out = json.loads(
        anim.anim_dispatch(
            "pose_apply",
            json.dumps(
                {"armature": "Armature", "pose": {"Hips": {"location": [0, 0, 1.5]}}}
            ),
        )
    )
    assert out["ok"] is True, out
    assert out["applied"] == ["Hips"]
    assert out["diff"][0]["channel"] == "location"
    assert out["diff"][0]["after"] == [0.0, 0.0, 1.5]
    pb = [b for b in arm.pose.bones if b.name == "Hips"][0]
    assert pb.location == [0.0, 0.0, 1.5]


def test_pose_apply_unknown_bone_degrades_but_keeps_good_ones(anim, monkeypatch):
    arm = make_armature()
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[arm]))
    out = json.loads(
        anim.anim_dispatch(
            "pose_apply",
            json.dumps(
                {
                    "armature": "Armature",
                    "pose": {"Hips": {"scale": [2, 2, 2]}, "Tail": {"scale": [1, 1, 1]}},
                }
            ),
        )
    )
    assert out["applied"] == ["Hips"]
    assert [row["bone"] for row in out["skipped"]] == ["Tail"]
    assert out["verdict"] == "degraded"
    assert out["ok"] is False


def test_pose_apply_dry_run_does_not_touch_the_rig(anim, monkeypatch):
    arm = make_armature()
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[arm]))
    out = json.loads(
        anim.anim_dispatch(
            "pose_apply",
            json.dumps(
                {
                    "armature": "Armature",
                    "dry_run": True,
                    "pose": {"Hips": {"location": [0, 0, 1.0]}},
                }
            ),
        )
    )
    assert out["applied"] == ["Hips"]
    assert out["diff"] == []
    assert out["verdict"] == "degraded"
    pb = [b for b in arm.pose.bones if b.name == "Hips"][0]
    assert pb.location == [0.0, 0.0, 0.0]


def test_deform_audit_marks_topology_change_degraded(anim, monkeypatch):
    class Eval:
        def __init__(self, me):
            self._me = me

        def to_mesh(self):
            return self._me

        def to_mesh_clear(self):
            return None

    ob, stretched = make_grid()
    rest_me = ob.data
    # 拓扑被修改器改掉：evaluated 只有 3 顶点
    alt = types.SimpleNamespace(
        vertices=rest_me.vertices[:3], edges=rest_me.edges[:2], polygons=[]
    )
    ob.evaluated_get = lambda dg: Eval(alt)
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[ob], depsgraph=object()))
    out = json.loads(anim.anim_dispatch("deform_audit", json.dumps({"objects": ["Body"]})))
    assert out["verdict"] == "degraded"
    assert "拓扑" in out["objects"][0]["reason"]


def test_deform_audit_passes_identity_and_fails_on_flip(anim, monkeypatch):
    class Eval:
        def __init__(self, me):
            self._me = me

        def to_mesh(self):
            return self._me

        def to_mesh_clear(self):
            return None

    ob, stretched = make_grid()
    ob.evaluated_get = lambda dg: Eval(ob.data)
    monkeypatch.setitem(sys.modules, "bpy", make_bpy(objects=[ob], depsgraph=object()))
    same = json.loads(anim.anim_dispatch("deform_audit", json.dumps({"objects": ["Body"]})))
    assert same["verdict"] == "pass", same

    flipped = types.SimpleNamespace(
        vertices=[types.SimpleNamespace(co=[-v.co[0], v.co[1], v.co[2]]) for v in ob.data.vertices],
        edges=ob.data.edges,
        polygons=ob.data.polygons,
    )
    ob.evaluated_get = lambda dg: Eval(flipped)
    bad = json.loads(anim.anim_dispatch("deform_audit", json.dumps({"objects": ["Body"]})))
    assert bad["verdict"] == "fail"
    assert bad["objects"][0]["faces"]["flipped"] == 1


def test_api_registers_ops_and_help_lists_them(anim):
    kernel = sys.modules["dsh_rt_kernel"]
    api = kernel.dsh_anim_api
    assert sorted(k for k in api if k in ALLOWED_OPS) == ALLOWED_OPS
    help_out = json.loads(anim.anim_dispatch("help", "{}"))
    assert help_out["op"] == "anim_help"
    assert sorted(help_out["ops"]) == ALLOWED_OPS
