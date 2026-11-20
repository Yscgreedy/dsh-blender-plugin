# -*- coding: utf-8 -*-
"""P10c GUI 探针（由 blender_py 在 GUI 会话内执行；不碰用户场景）。

用法（两次调用）：
    P10C_MODE = "break"   # 模拟"老 K 缺 helper"：删掉 K.action_fcurves / K.dsh_kit
    P10C_MODE = "probe"   # 下一次 blender_py 由 bootstrap 自动重载 kit；校验 helper + 线性化
    P10C_MODE = "again"   # 幂等复跑：reload_count 必须为 0

只创建/删除临时 datablock（空对象 + 临时相机 + 临时 action），结束时对象数与名字集合必须回到基线。
打印一行 P10C {json} 供回执读取。
"""

import bpy
import hashlib
import json

MODE = str(globals().get("P10C_MODE") or "probe")


def _names_hash():
    joined = "|".join(sorted(o.name for o in bpy.data.objects))
    return hashlib.md5(joined.encode("utf-8")).hexdigest()[:12]


def _counts():
    return {
        "objects": len(bpy.data.objects),
        "actions": len(bpy.data.actions),
        "cameras": len(bpy.data.cameras),
    }


def _kit_state():
    kit = getattr(K, "dsh_kit", None)  # noqa: F821  (K 由 blender_py 注入)
    helper = getattr(K, "action_fcurves", None)  # noqa: F821
    return {
        "has_kit": kit is not None,
        "has_helper": callable(helper),
        "kit_id": id(kit) if kit is not None else None,
    }


if MODE == "break":
    before = _kit_state()
    K._p10c_old_kit_id = before["kit_id"]  # noqa: F821
    K._p10c_old_helper = before["has_helper"]  # noqa: F821
    for attr in ("action_fcurves", "dsh_kit"):
        try:
            delattr(K, attr)  # noqa: F821
        except Exception:
            pass
    print("P10C " + json.dumps({"mode": "break", "before": before, "after": _kit_state()}, default=str))
else:
    base_counts = _counts()
    base_hash = _names_hash()
    scene = bpy.context.scene.name
    state = _kit_state()
    old_id = getattr(K, "_p10c_old_kit_id", None)  # noqa: F821
    reload_count = 0
    if old_id is not None and state["kit_id"] is not None and state["kit_id"] != old_id:
        reload_count = 1

    warnings = []
    except_pass = 0
    temp = {"created": False, "renamed": False, "cleanup_ok": False}
    linear = {"applied": False, "curves": 0}

    try:
        ob = bpy.data.objects.new("p10c_tmp_probe", None)
        bpy.context.scene.collection.objects.link(ob)
        temp["created"] = True
        ob.name = "p10c_tmp_probe_renamed"
        temp["renamed"] = ob.name == "p10c_tmp_probe_renamed"
        bpy.data.objects.remove(ob, do_unlink=True)
        temp["cleanup_ok"] = True
    except Exception as e:
        warnings.append("temp object: %s: %s" % (type(e).__name__, str(e)[:160]))

    try:
        cam_data = bpy.data.cameras.new("p10c_tmp_cam")
        cam = bpy.data.objects.new("p10c_tmp_cam", cam_data)
        bpy.context.scene.collection.objects.link(cam)
        for frame in (1, 10, 20):
            cam.location = (float(frame), 0.0, 0.0)
            cam.keyframe_insert(data_path="location", frame=frame)
        ad = cam.animation_data
        act = ad.action if ad is not None else None
        # 产品路径：K.action_fcurves（老 K 缺 helper 时 bootstrap 已重载 kit）。
        curves = list(K.action_fcurves(act)) if act is not None else []  # noqa: F821
        linear["curves"] = len(curves)
        for fc in curves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        linear["applied"] = bool(curves) and all(
            kp.interpolation == "LINEAR" for fc in curves for kp in fc.keyframe_points
        )
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
        if act is not None:
            try:
                bpy.data.actions.remove(act)
            except Exception:
                except_pass += 1
    except Exception as e:
        warnings.append("linearize: %s: %s" % (type(e).__name__, str(e)[:160]))

    after_counts = _counts()
    after_hash = _names_hash()
    result = {
        "mode": MODE,
        "scene": scene,
        "kit": dict(state, reload_count=reload_count, old_kit_id_known=old_id is not None),
        "linearize": dict(linear, warnings=warnings, except_pass=except_pass),
        "temp": dict(
            temp,
            objects_before=base_counts["objects"],
            objects_after=after_counts["objects"],
            names_unchanged=base_hash == after_hash,
            counts_before=base_counts,
            counts_after=after_counts,
        ),
    }
    # 幂等基线：下一次比较的是"上一跑结束时的 kit"，不是 break 时的旧 id。
    K._p10c_old_kit_id = state["kit_id"]  # noqa: F821
    print("P10C " + json.dumps(result, default=str))
