# -*- coding: utf-8 -*-
"""DSH 热无头 worker —— 常驻的 blender -b 进程，接受代码片段并复用同一个 Blender 会话。

为什么需要它：addon 的 socket 服务在 background 模式下不启动（别人维护的 addon 里的行为），
所以"用 socket 通道"= 必须 GUI、"用 headless"= 每次都冷启动。本 worker 两者都要：
    blender.exe -b --factory-startup --python worker.py -- --port 9879 --gpu auto
它把 **阻塞 accept 循环跑在主线程**（无头下 bpy.app.timers 不触发，实测 0 次；主线程执行 bpy 调用才安全），
复用持久内核 K（与 blender_py 同一套语义），并提供 GPU 前导与结构化回执。

协议（换行分帧 JSON）：
    请求  {"id":1,"op":"ping"} | {"id":2,"op":"exec","code":"..."} | {"id":3,"op":"status"} | {"id":4,"op":"shutdown"}
    应答  {"id":2,"ok":true,"ms":12,"stdout":"...","stderr":"","result":{...}}
约定：脚本里 print("HEADLESS {json}") （单行）会被解析成 result —— 与 blender_run 一致。
串行语义：一次只处理一个请求；长代码会占住 worker（这是"热"的代价，也是安全的来源）。
"""

import array
import base64
import hashlib
import io
import json
import os
import socket
import sys
import tempfile
import time
import traceback

WORKER_VERSION = 2
_started = time.time()
_calls = 0
_errors = 0
_boot_info = None
_seq = 0


def _j(o):
    return json.dumps(o, ensure_ascii=False, default=str)


def _arg(name, default=None):
    argv = sys.argv
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def _kernel_bootstrap():
    import types
    K = sys.modules.get("dsh_rt_kernel")
    if K is None:
        K = types.ModuleType("dsh_rt_kernel")
        sys.modules["dsh_rt_kernel"] = K
    import bpy, math, mathutils
    K.bpy = bpy
    K.math = math
    K.mathutils = mathutils
    return K


def _engine_setup(gpu_mode, engine="eevee"):
    """v0.8.0：默认 EEVEE + 光追；engine='cycles' 走 OptiX 设备前导；'keep' 不动。"""
    import bpy
    info = {"engine_mode": engine, "gpu_mode": gpu_mode}
    try:
        import gpu
        info["backend"] = gpu.platform.backend_type_get()
        info["renderer"] = gpu.platform.renderer_get()
    except Exception as e:
        info["backend"] = "n/a: %s" % str(e)[:60]
    sc = bpy.context.scene
    info["before"] = {"engine": sc.render.engine}
    if engine in ("keep", "workbench", "none"):
        if engine == "workbench":
            try:
                sc.render.engine = "BLENDER_WORKBENCH"
                try:
                    sc.display.shading.light = "STUDIO"
                    sc.display.shading.show_cavity = True
                except Exception:
                    pass
            except Exception as e:
                info["engine_set_err"] = str(e)[:120]
        info["ok"] = True
        info["skipped"] = engine != "workbench"
        info["configured"] = engine
        info["after"] = {"engine": sc.render.engine}
        info["fell_back_to_cpu"] = False
        return info
    if engine == "cycles":
        info.update(_gpu_setup(gpu_mode))
        try:
            sc.render.engine = "CYCLES"
            if info.get("configured"):
                sc.cycles.device = "GPU"
        except Exception as e:
            info["engine_set_err"] = str(e)[:80]
        info["after"] = {"engine": sc.render.engine}
        return info
    ee = getattr(sc, "eevee", None)
    try:
        sc.render.engine = "BLENDER_EEVEE_NEXT" if (4, 2, 0) <= bpy.app.version < (5, 0, 0) else "BLENDER_EEVEE"
        if ee is not None:
            if hasattr(ee, "use_raytracing"):
                ee.use_raytracing = True
            if hasattr(ee, "ray_tracing_method"):
                try:
                    ee.ray_tracing_method = "SCREEN"
                except Exception:
                    pass
            if hasattr(ee, "use_shadows"):
                ee.use_shadows = True
            for attr, val in (("shadow_ray_count", 2), ("shadow_step_count", 8)):
                if hasattr(ee, attr):
                    try:
                        setattr(ee, attr, val)
                    except Exception:
                        pass
            cur = getattr(ee, "taa_render_samples", 64) or 64
            if hasattr(ee, "taa_render_samples") and cur < 64:
                ee.taa_render_samples = 64
        info["configured"] = "eevee-rt" if (ee is not None and getattr(ee, "use_raytracing", False)) else "eevee"
        info["ok"] = True
    except Exception as e:
        info["ok"] = False
        info["error"] = "%s: %s" % (type(e).__name__, str(e)[:120])
    info["after"] = {"engine": sc.render.engine, "rt": getattr(ee, "use_raytracing", None),
                     "samples": getattr(ee, "taa_render_samples", None)}
    info["fell_back_to_cpu"] = False
    return info


def _gpu_setup(mode):
    """mode: auto / true / false —— 与插件侧 GPU_PRELUDE 同语义"""
    import bpy
    info = {"mode": mode}
    if str(mode).lower() in ("false", "off", "none", "0"):
        info.update({"skipped": True, "ok": True})
        return info
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except Exception as e:
        info.update({"ok": False, "error": "no cycles prefs: %s" % e})
        return info
    sc = bpy.context.scene

    def snap():
        try:
            devs = [d.name for d in prefs.devices if d.use and d.type != "CPU"]
        except Exception:
            devs = []
        return {"device_type": prefs.compute_device_type, "scene_device": getattr(sc.cycles, "device", None), "gpu_enabled": devs}

    info["before"] = snap()
    if info["before"]["device_type"] == "NONE" or not info["before"]["gpu_enabled"]:
        for t in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            try:
                prefs.compute_device_type = t
                prefs.get_devices()
                if [d for d in prefs.devices if d.type != "CPU"]:
                    for d in prefs.devices:
                        d.use = (d.type != "CPU")
                    try:
                        sc.cycles.device = "GPU"
                    except Exception:
                        pass
                    info["configured"] = t
                    break
            except Exception:
                continue
        else:
            info["configured"] = None
            info["error"] = "no GPU backend available"
    info["after"] = snap()
    a = info["after"]
    info["fell_back_to_cpu"] = bool(a["device_type"] == "NONE" or not a["gpu_enabled"])
    info["ok"] = (not info["fell_back_to_cpu"]) or (str(mode).lower() not in ("true", "required"))
    return info


def _run_boot(path):
    """执行 engine 拼好的启动前导（KERNEL_BOOTSTRAP + preload 模块源码）。

    为什么放这里：worker 原来只注入 K/bpy，preload 模块（audit/qc/runner…）完全不存在，
    于是热会话里 K.dsh_audit_api 等一律 AttributeError。engine 在 spawn 前把同一份前导写到
    --boot 指定的 .py；这里在 ready 之前 exec 一次。
    """
    global _boot_info
    if not path or not os.path.exists(str(path)):
        _boot_info = {"ok": True, "skipped": True}
        return _boot_info
    K = _kernel_bootstrap()
    out, err = io.StringIO(), io.StringIO()
    ok, errmsg, tb = True, None, None
    ns = {"K": K, "bpy": K.bpy, "math": K.math, "mathutils": K.mathutils,
          "Vector": K.mathutils.Vector, "__name__": "__main__", "__file__": str(path)}
    try:
        import contextlib
        src = open(str(path), "r", encoding="utf-8").read()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(src, str(path), "exec"), ns)
    except Exception as e:
        ok = False
        errmsg = "%s: %s" % (type(e).__name__, e)
        tb = traceback.format_exc()
    _boot_info = {"ok": ok, "path": str(path), "stdout": out.getvalue()[-2000:],
                  "stderr": err.getvalue()[-2000:], "error": errmsg,
                  "traceback": (tb or "")[-2000:],
                  "kernel_modules": sorted([a for a in dir(K) if a.startswith("dsh_") and a.endswith("_api")])}
    return _boot_info


def _frame_dir():
    return str(_arg("--frame-dir", None) or os.environ.get("DSH_WORKER_FRAME_DIR") or tempfile.gettempdir())


def _see(spec=None):
    """无头离屏 see：临时相机 + bpy.ops.render.render + Workbench。

    不走 view.py 的 GPUOffScreen.draw_view3d（需要 VIEW_3D），也不走 render.opengl（需要窗口）——
    这条路径与 geo.quick_views 同源，blender -b 下可用（本机实测 512² 稳态 31–38 ms/帧）。
    """
    global _seq
    import bpy
    try:
        from mathutils import Vector
    except Exception:
        Vector = None
    spec = dict(spec or {})
    if not spec.get("from"):
        spec["from"] = [7, -7, 5]
    if not spec.get("look_at"):
        spec["look_at"] = [0, 0, 1]
    width = int(spec.get("width") or spec.get("max_size") or 560)
    height = int(spec.get("height") or max(120, round(width * 9.0 / 16.0)))
    width = max(64, min(1600, width)); height = max(64, min(1600, height))
    sc = bpy.context.scene
    saved = {"engine": sc.render.engine, "rx": sc.render.resolution_x, "ry": sc.render.resolution_y,
             "pct": sc.render.resolution_percentage, "fp": sc.render.filepath,
             "fmt": sc.render.image_settings.file_format, "cm": sc.render.image_settings.color_mode,
             "transparent": bool(getattr(sc.render, "film_transparent", False)),
             "camera": sc.camera}
    cam = None
    t0 = time.time()
    try:
        cd = bpy.data.cameras.new("__dsh_see_cam")
        cam = bpy.data.objects.new("__dsh_see_cam", cd)
        sc.collection.objects.link(cam)
        cam.location = tuple(float(x) for x in spec["from"][:3])
        look = tuple(float(x) for x in spec["look_at"][:3])
        if Vector is not None:
            cam.rotation_euler = (Vector(look) - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = float(spec.get("lens") or 50.0)
        if bool(spec.get("ortho")):
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = float(spec.get("ortho_scale") or 10.0)
        sc.camera = cam
        sc.render.engine = "BLENDER_WORKBENCH"
        sc.render.resolution_x = width
        sc.render.resolution_y = height
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = "PNG"
        sc.render.image_settings.color_mode = "RGBA"
        try:
            sc.render.film_transparent = True
        except Exception:
            pass
        try:
            sh = sc.display.shading
            sh.light = "STUDIO"
            sh.color_type = "MATERIAL" if spec.get("shading") == "MATERIAL" else "SINGLE"
            if sh.color_type == "SINGLE":
                sh.single_color = (0.78, 0.78, 0.78)
            sh.show_cavity = bool(spec.get("cavity", True))
            sh.show_shadows = bool(spec.get("shadows", False))
            sc.display.render_aa = str(spec.get("aa") or "8")
        except Exception:
            pass
        _seq += 1
        path = os.path.join(_frame_dir(), "dsh_see_%d_%d.png" % (os.getpid(), _seq))
        sc.render.filepath = path
        _t_render = time.time()
        bpy.ops.render.render(write_still=True)
        _t_render_ms = int((time.time() - _t_render) * 1000)
        _t_read = time.time()
        data = open(path, "rb").read()
        coverage = None
        try:
            import numpy as np
            img = bpy.data.images.load(path, check_existing=False)
            n = int(img.size[0]) * int(img.size[1])
            buf = np.empty(n * 4, dtype=np.float32)
            img.pixels.foreach_get(buf)
            coverage = round(float((buf[3::4] > 0.5).mean()), 4)
            bpy.data.images.remove(img)
        except Exception:
            coverage = None
        return {"ok": True, "mode": "workbench-offscreen", "path": path,
                "png_b64": base64.b64encode(data).decode("ascii"),
                "width": width, "height": height, "bytes": len(data),
                "coverage_estimate": coverage, "ms": int((time.time() - t0) * 1000),
                "t": {"render_ms": _t_render_ms, "read_ms": int((time.time() - _t_read) * 1000),
                      "total_ms": int((time.time() - t0) * 1000)},
                "engine": "BLENDER_WORKBENCH"}
    except Exception as e:
        return {"ok": False, "mode": "workbench-offscreen", "error": "%s: %s" % (type(e).__name__, e),
                "traceback": traceback.format_exc()[-2000:], "ms": int((time.time() - t0) * 1000)}
    finally:
        try:
            if cam is not None:
                bpy.data.objects.remove(cam, do_unlink=True)
                if cam.data is not None and cam.data.users == 0:
                    bpy.data.cameras.remove(cam.data)
        except Exception:
            pass
        try:
            sc.render.engine = saved["engine"]
            sc.render.resolution_x = saved["rx"]; sc.render.resolution_y = saved["ry"]
            sc.render.resolution_percentage = saved["pct"]
            sc.render.filepath = saved["fp"]
            sc.render.image_settings.file_format = saved["fmt"]
            sc.render.image_settings.color_mode = saved["cm"]
            sc.render.film_transparent = saved["transparent"]
            sc.camera = saved["camera"]
            bpy.context.view_layer.update()
        except Exception:
            pass



def _watch(spec=None):
    """无头帧序列观察：可选先跑 code，再逐帧 Workbench 离屏 see，回逐帧 hash + ≤6 帧图。"""
    import bpy
    import hashlib
    spec = dict(spec or {})
    t0 = time.time()
    sh = {"width": 420, "height": 236}
    for k in ("width", "height", "from", "look_at", "ortho", "ortho_scale", "lens", "shading"):
        if spec.get(k) is not None:
            sh[k] = spec.get(k)
    out = {"ok": True, "mode": "workbench-offscreen-watch", "code": None,
           "frames": [], "picks": [], "distinct": 0, "changed": False, "static_render": False}
    saved_frame = int(getattr(bpy.context.scene, "frame_current", 1) or 1)
    shots = []
    try:
        if spec.get("code"):
            cr = _exec(str(spec.get("code")), int(spec.get("code_timeout_ms") or 60000))
            out["code"] = {"ok": bool(cr.get("ok")), "ms": cr.get("ms"), "error": cr.get("error"),
                           "result": cr.get("result"), "stdout": (cr.get("stdout") or "")[-800:]}
        seconds = max(0.2, min(20.0, float(spec.get("seconds") or 2.0)))
        fps = max(0.5, min(8.0, float(spec.get("fps") or 4.0)))
        total = int(max(1, min(32, int(spec.get("max_frames") or round(seconds * fps)))))
        sc = bpy.context.scene
        raw = spec.get("frames")
        frames = []
        if isinstance(raw, list) and raw:
            for x in raw:
                try:
                    frames.append(int(x))
                except Exception:
                    pass
        elif spec.get("frame_start") is not None or spec.get("frame_end") is not None:
            fs = int(spec.get("frame_start") if spec.get("frame_start") is not None else sc.frame_start)
            fe = int(spec.get("frame_end") if spec.get("frame_end") is not None else sc.frame_end)
            if fe < fs:
                fs, fe = fe, fs
            step = max(1, (fe - fs + 1) // max(1, total))
            frames = list(range(fs, fe + 1, step))[:total]
        if not frames:
            try:
                has_anim = bool(getattr(sc, "animation_data", None)) or any(
                    getattr(o, "animation_data", None) for o in bpy.data.objects)
                fs, fe = int(sc.frame_start), int(sc.frame_end)
                if has_anim and fe > fs:
                    step = max(1, (fe - fs + 1) // max(1, total))
                    frames = list(range(fs, fe + 1, step))[:total]
            except Exception:
                pass
        if not frames:
            frames = [int(getattr(sc, "frame_current", 1) or 1)] * total
            out["static_render"] = True
        if len(frames) > total:
            frames = [frames[int(round(k * (len(frames) - 1) / max(1, total - 1)))] for k in range(total)]
        for i, f in enumerate(frames):
            try:
                bpy.context.scene.frame_set(int(f))
            except Exception:
                pass
            r = _see(sh)
            if not r.get("ok"):
                out["frames"].append({"i": i, "frame": f, "ok": False, "error": r.get("error"), "ms": r.get("ms")})
                continue
            png = str(r.get("png_b64") or "")
            try:
                digest = hashlib.md5(base64.b64decode(png)).hexdigest()[:12]
            except Exception:
                digest = "BAD"
            out["frames"].append({"i": i, "frame": f, "ok": True, "ms": r.get("ms"),
                                  "hash": digest, "width": r.get("width"), "height": r.get("height"),
                                  "path": r.get("path"), "coverage": r.get("coverage_estimate")})
            shots.append({"frame": f, "hash": digest, "png_b64": png, "path": r.get("path")})
        hashes = [s["hash"] for s in shots]
        out["distinct"] = len(set(hashes))
        out["changed"] = out["distinct"] > 1
        if len(shots) <= 6:
            picks = shots
        else:
            picks = [shots[int(round(k * (len(shots) - 1) / 5))] for k in range(6)] if shots else []
        for p in picks:
            out["picks"].append({"frame": p.get("frame"), "hash": p.get("hash"),
                                 "path": p.get("path"), "png_b64": p.get("png_b64")})
        out["sampled"] = len(shots)
        out["requested"] = len(frames)
        out["ms"] = int((time.time() - t0) * 1000)
        return out
    except Exception as e:
        out.update({"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                    "traceback": traceback.format_exc()[-2000:], "ms": int((time.time() - t0) * 1000)})
        return out
    finally:
        try:
            bpy.context.scene.frame_set(saved_frame)
        except Exception:
            pass


def _reset():
    """清场景/材质/相机，保留 K（preload 模块 API 还在）。批量白模之间用。"""
    import bpy
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        return {"ok": True, "objects": len(bpy.data.objects),
                "note": "场景已重置；K 保留（preload 模块 API 仍在），渲染设置按空场景默认"}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                "traceback": traceback.format_exc()[-1200:]}


# ---------------------------------------------------------------- 7) checkpoint / revert （痛点8）
# 「改一步看一眼」的成本全在"回滚只能手工另存 .blend"：现场为三个废案存了五个中间档。
# worker 是常驻进程，天然有"当前场景"——这里给它一个文件级 checkpoint 栈：
#   {"op":"checkpoint","spec":{"label":"s2"}}  → 存 <dir>/NN_s2.blend 并压栈
#   {"op":"revert","spec":{"label":"s1"|"last"}} → 读回该档（同一进程内生效）
#   {"op":"checkpoints"}                         → 列栈
# 保存用 copy=True：worker 自己的 filepath 不被改写，revert 前后状态可预测。

_CHECKPOINTS = []


def _ck_dir(spec):
    d = str(spec.get("dir") or os.environ.get("DSH_WORKER_CHECKPOINT_DIR") or os.path.join(_frame_dir(), "dsh-checkpoints"))
    os.makedirs(d, exist_ok=True)
    return d


def _ck_index_path(d):
    return os.path.join(d, "index.json")


def _ck_load(d):
    global _CHECKPOINTS
    try:
        with open(_ck_index_path(d), "r", encoding="utf-8") as f:
            idx = json.load(f)
        if isinstance(idx, list):
            _CHECKPOINTS = idx
    except Exception:
        pass
    return _CHECKPOINTS


def _ck_save(d):
    try:
        with open(_ck_index_path(d), "w", encoding="utf-8") as f:
            f.write(_j(_CHECKPOINTS))
    except Exception:
        pass


def _ck_find(name):
    want = str(name or "").strip()
    if not want or want.lower() in ("last", "latest"):
        return _CHECKPOINTS[-1] if _CHECKPOINTS else None
    for rec in reversed(_CHECKPOINTS):
        if str(rec.get("label") or "") == want or str(rec.get("path") or "") == want:
            return rec
    return None


def _checkpoint(spec=None):
    import bpy
    import re
    spec = dict(spec or {})
    t0 = time.time()
    d = _ck_dir(spec)
    _ck_load(d)
    label = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(spec.get("label") or spec.get("name") or "")).strip("._")
    seq = len(_CHECKPOINTS) + 1
    name = "%02d_%s" % (seq, label or "ck")
    path = os.path.join(d, name + ".blend")
    try:
        bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False, copy=True)
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "dir": d,
                "traceback": traceback.format_exc()[-1200:]}
    rec = {"label": label or name, "path": path, "seq": seq,
           "objects": len(bpy.data.objects), "created_at": int(time.time()),
           # The working file at checkpoint time: revert must return to it, not to
           # the checkpoint copy under AppData (field 反馈 5).
           "file": bpy.data.filepath or None,
           "bytes": os.path.getsize(path) if os.path.exists(path) else None}
    _CHECKPOINTS.append(rec)
    _ck_save(d)
    return {"ok": True, "mode": "file-checkpoint", "dir": d, "checkpoint": rec,
            "count": len(_CHECKPOINTS), "ms": int((time.time() - t0) * 1000),
            "revert": 'op=revert label="%s"' % rec["label"]}


def _revert(spec=None):
    """回滚到 checkpoint，并把**工作文件**放回原路径。

    现场（反馈 5）：open_mainfile(checkpoint) 会把 bpy.data.filepath 改成 AppData 下的
    快照副本；之后任何 save / 相对路径都落到运行目录。bpy.data.filepath 是只读的
    （Blender 5.3 实测），所以这里显式 save_as_mainfile 回写原文件，并先给原文件留
    一份 pre_revert 备份；原文件不可回写时如实报 file_changed=true + relocate。
    """
    import bpy
    import shutil
    spec = dict(spec or {})
    t0 = time.time()
    d = _ck_dir(spec)
    _ck_load(d)
    rec = _ck_find(spec.get("label") or spec.get("name") or spec.get("checkpoint"))
    if not rec:
        return {"ok": False, "error": "没有匹配的 checkpoint", "dir": d,
                "known": [r.get("label") for r in _CHECKPOINTS]}
    path = str(rec.get("path") or "")
    if not os.path.exists(path):
        return {"ok": False, "error": "checkpoint 文件已不在磁盘：%s" % path, "dir": d}
    before_file = bpy.data.filepath or None
    try:
        bpy.ops.wm.open_mainfile(filepath=path)
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e), "path": path,
                "traceback": traceback.format_exc()[-1200:]}
    _kernel_bootstrap()
    target = str(rec.get("file") or before_file or "") or None
    backup = None
    relocate_error = None
    if target and os.path.normcase(os.path.abspath(target)) != os.path.normcase(os.path.abspath(path)):
        try:
            if os.path.isfile(target):
                seq = len(_CHECKPOINTS) + 1
                backup = os.path.join(d, "%02d_pre_revert_%s" % (seq, os.path.basename(target)))
                shutil.copy2(target, backup)
                _CHECKPOINTS.append({"label": "pre_revert_%02d" % seq, "path": backup, "seq": seq,
                                     "objects": None, "created_at": int(time.time()),
                                     "file": target, "bytes": os.path.getsize(backup),
                                     "kind": "pre_revert_backup"})
                _ck_save(d)
            bpy.ops.wm.save_as_mainfile(filepath=target, copy=False)
        except Exception as e:
            relocate_error = "%s: %s" % (type(e).__name__, e)
    file_after = bpy.data.filepath or None
    return {"ok": True, "mode": "file-revert", "restored_from": rec, "path": path,
            "file_before": before_file, "file": file_after,
            "file_changed": bool(file_after != before_file),
            "relocated": bool(target and file_after and os.path.normcase(os.path.abspath(file_after)) == os.path.normcase(os.path.abspath(target))),
            "backup": backup, "relocate_error": relocate_error,
            "next_save_goes_to": file_after,
            "objects": len(bpy.data.objects),
            "count": len(_CHECKPOINTS), "ms": int((time.time() - t0) * 1000)}


def _relocate(spec=None):
    """把 worker 的工作文件显式指到 spec.file（内容不变，写盘一次）。"""
    import bpy
    spec = dict(spec or {})
    target = str(spec.get("file") or spec.get("path") or "").strip()
    if not target:
        return {"ok": False, "error": "relocate 需要 file=<目标 .blend>"}
    target = os.path.abspath(target)
    parent = os.path.dirname(target)
    if parent and not os.path.isdir(parent):
        return {"ok": False, "error": "目标目录不存在：%s" % parent, "file": target}
    before = bpy.data.filepath or None
    try:
        if spec.get("save") is False:
            return {"ok": False, "error": "bpy.data.filepath 是只读的（Blender 5.3）；要换工作文件必须写盘一次",
                    "file_before": before, "file": before}
        bpy.ops.wm.save_as_mainfile(filepath=target, copy=False)
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                "traceback": traceback.format_exc()[-1200:], "file": before}
    return {"ok": True, "mode": "relocate", "file_before": before,
            "file": bpy.data.filepath or None, "next_save_goes_to": bpy.data.filepath or None,
            "objects": len(bpy.data.objects)}


def _checkpoints(spec=None):
    spec = dict(spec or {})
    d = _ck_dir(spec)
    _ck_load(d)
    out = [dict(r, exists=os.path.exists(str(r.get("path") or ""))) for r in _CHECKPOINTS]
    return {"ok": True, "mode": "file-checkpoints", "dir": d, "count": len(out),
            "stack": out, "last": out[-1] if out else None,
            "revert": 'op=revert label="%s"' % (out[-1].get("label") if out else "")}


def _purge_modules(prefixes):
    """热重载：按前缀清 sys.modules（改过的用户模块在热会话里会命中旧代码）"""
    import sys as _s, importlib as _i
    _i.invalidate_caches()
    pre = [str(p) for p in (prefixes or []) if str(p)]
    purged = []
    for _n, _m in list(_s.modules.items()):
        if pre and any(_n == p or _n.startswith(p + ".") for p in pre) and not _n.startswith("bpy"):
            _s.modules.pop(_n, None)
            purged.append(_n)
    return purged



def _load_action_helper(K):
    """Make K.action_fcurves available even when the worker booted without preload.

    The worker's minimal K historically skipped KERNEL_BOOTSTRAP when no preload was
    requested, so the layered-action helper did not exist in a plain exec.  Load the
    sibling kit.py once, lazily, and mirror its helper onto K.
    """
    try:
        if getattr(K, "action_fcurves", None) is not None:
            return
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kit.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        exec(compile(src, path, "exec"), {"__name__": "dsh_kit_worker", "__file__": path})
        fn = getattr(getattr(K, "dsh_kit", None), "action_fcurves", None)
        if fn is not None:
            K.action_fcurves = fn
    except Exception:
        pass


DIGEST_ALGO = "sha256:12"
DIGEST_MAX_FLOATS = 600000  # 顶点坐标最多哈希 20 万个顶点；超过只哈希拓扑+尺寸并标 truncated


def _kit_source():
    """本进程的 K 从哪来：boot（engine 拼的前导）| boot-degraded | bootstrap（最小内核）。"""
    info = _boot_info or {}
    if info.get("skipped"):
        return "bootstrap"
    if info.get("ok") is False:
        return "boot-degraded"
    return "boot"


def _hash_mesh(ob, h, info, domains, budget):
    """网格域：拓扑 +（预算内的）顶点坐标；超预算只哈希尺寸并标 truncated。"""
    data = getattr(ob, "data", None)
    if ob.type != "MESH" or data is None:
        return budget
    info["meshes"] += 1
    if "mesh" not in domains:
        domains.append("mesh")
    try:
        nv, npoly, ne = len(data.vertices), len(data.polygons), len(data.edges)
        info["verts"] += nv
        info["faces"] += npoly
        h.update(("T|%d|%d|%d" % (nv, npoly, ne)).encode("utf-8"))
        # UV layout is content too: unwrap changes nothing else (field 反馈 4).
        uv = getattr(data, "uv_layers", None)
        active = getattr(uv, "active", None)
        if active is not None:
            uvdata = active.data
            step = max(1, len(uvdata) // 2000)
            h.update(("G|%d" % len(uvdata)).encode("utf-8"))
            for i in range(0, len(uvdata), step):
                try:
                    uv_c = uvdata[i].uv
                    h.update(("%.5f,%.5f;" % (uv_c.x, uv_c.y)).encode("utf-8"))
                except Exception:
                    break
        if budget > 0 and nv * 3 <= budget:
            co = array.array("f", [0.0]) * (nv * 3)
            data.vertices.foreach_get("co", co)
            h.update(co.tobytes())
            return budget - nv * 3
        info["truncated"] = True
        dims = [round(float(v), 6) for v in getattr(ob, "dimensions", [])]
        h.update(("B|" + ",".join(str(v) for v in dims)).encode("utf-8"))
    except Exception as e:
        h.update(("E|" + str(e)[:120]).encode("utf-8"))
    return budget


def _sock_value(sock):
    """插座的 default_value → 可哈希标量/元组；不是所有插座都有值。"""
    try:
        val = getattr(sock, "default_value", None)
    except Exception:
        return None
    if val is None:
        return None
    try:
        return tuple(round(float(x), 5) for x in val)
    except TypeError:
        try:
            return round(float(val), 5)
        except Exception:
            return str(val)[:80]


def _hash_node_tree(nt, h, depth=0, seen=None, kind="gn"):
    """节点树结构 + 节点输入值 + 连线。GN/材质/合成器共用。

    只改一个 socket 值（不动对象变换/网格）时，这层必须让 digest 变化；
    只哈希节点数/名字会漏掉“值改了但拓扑没变”。

    成本控制：同一次 digest 内按 as_pointer() 去重；材质树 >80 节点、GN 树 >400 节点
    只哈希 (名称, 节点数, 类型直方图) 并返回 limited=True；每节点最多 48 个输入，
    连线最多 2×节点数。调用方据此标 digest_limited。
    """
    if nt is None or depth > 3:
        return False
    if seen is None:
        seen = set()
    try:
        key = nt.as_pointer()
    except Exception:
        key = id(nt)
    if key in seen:
        return False
    seen.add(key)
    try:
        nodes = list(nt.nodes)
        links = list(nt.links)
    except Exception:
        return False
    limit = 80 if kind == "material" else 400
    try:
        name = str(getattr(nt, "name", ""))
    except Exception:
        name = ""
    if len(nodes) > limit:
        hist = {}
        for node in nodes:
            bid = str(getattr(node, "bl_idname", ""))
            hist[bid] = hist.get(bid, 0) + 1
        h.update(("NTL|%s|%s|%d|%s" % (
            kind, name, len(nodes), json.dumps(hist, sort_keys=True))).encode("utf-8"))
        return True
    limited = False
    h.update(("NT|%s|%d|%d" % (name, len(nodes), len(links))).encode("utf-8"))
    try:
        nodes = sorted(nodes, key=lambda n: getattr(n, "name", ""))
    except Exception:
        pass
    for node in nodes:
        h.update(("N|%s|%s|%s" % (getattr(node, "name", ""), getattr(node, "bl_idname", ""),
                                  getattr(node, "label", ""))).encode("utf-8"))
        try:
            inputs = list(getattr(node, "inputs", []) or [])
            if len(inputs) > 48:
                inputs = inputs[:48]
                limited = True
            for sock in inputs:
                val = _sock_value(sock)
                if val is not None:
                    h.update(("I|%s|%s" % (getattr(sock, "name", ""), val)).encode("utf-8"))
        except Exception:
            pass
        # 一个节点组节点（Group）也可能嵌套；递归但限深。
        try:
            sub = getattr(node, "node_tree", None)
            if sub is not None and getattr(sub, "name", None) != getattr(nt, "name", None):
                if _hash_node_tree(sub, h, depth + 1, seen, kind):
                    limited = True
        except Exception:
            pass
    try:
        max_links = max(1, 2 * len(nodes))
        if len(links) > max_links:
            links = links[:max_links]
            limited = True
        for link in links:
            h.update(("L|%s.%s>%s.%s" % (
                getattr(getattr(link, "from_node", None), "name", ""),
                getattr(getattr(link, "from_socket", None), "name", ""),
                getattr(getattr(link, "to_node", None), "name", ""),
                getattr(getattr(link, "to_socket", None), "name", ""))).encode("utf-8"))
    except Exception:
        pass
    return limited


def _hash_modifiers(ob, h, seen=None):
    """修改器参数（不只是类型）：bevel 的 width/segments、boolean 的 solver、array 的 count…

    GN modifier 还要哈希 node_group 结构 + mod.properties.inputs 的 socket 值：
    5.3 改 Offset 只动 properties.inputs，不改任何对象/网格标量。
    """
    bits = []
    limited = False
    for mod in ob.modifiers:
        parts = [str(mod.type)]
        try:
            props = mod.bl_rna.properties
        except Exception:
            props = []
        for prop in props:
            name = getattr(prop, "identifier", "")
            if name in ("rna_type", "name"):
                continue
            if getattr(prop, "type", "") not in ("FLOAT", "INT", "BOOLEAN", "ENUM", "STRING"):
                continue
            try:
                parts.append("%s=%s" % (name, round(float(getattr(mod, name)), 6)))
            except Exception:
                try:
                    parts.append("%s=%s" % (name, getattr(mod, name)))
                except Exception:
                    continue
        bits.append("/".join(parts))
        try:
            if _hash_node_tree(getattr(mod, "node_group", None), h, 0, seen, "gn"):
                limited = True
        except Exception:
            pass
        try:
            inputs = getattr(getattr(mod, "properties", None), "inputs", None)
            if inputs is not None:
                for key in sorted(inputs.keys()):
                    item = inputs[key]
                    try:
                        val = item.to_dict()
                    except Exception:
                        val = str(item)[:200]
                    h.update(("GI|%s|%s" % (key, json.dumps(val, sort_keys=True, default=str))).encode("utf-8"))
        except Exception:
            pass
    h.update(("D|" + "|".join(bits)).encode("utf-8"))
    return limited


def _hash_materials(mats, h, domains, seen=None, info=None):
    """材质参数（不能只哈希材质名）：Roughness/Metallic/Base Color 变了必须 changed=true。"""
    if not mats:
        return
    domains.append("materials")
    import hashlib as _hl
    keys = ("Base Color", "Metallic", "Roughness", "IOR", "Alpha", "Emission Color",
            "Emission Strength", "Transmission Weight")
    for mat in mats:
        m = _hl.sha256()
        m.update(("N|%s" % mat.name).encode("utf-8"))
        try:
            m.update(("C|" + ",".join("%.4f" % float(c) for c in mat.diffuse_color)).encode("utf-8"))
        except Exception:
            pass
        try:
            m.update(("U|%s" % bool(getattr(mat, "use_nodes", False))).encode("utf-8"))
            nt = getattr(mat, "node_tree", None)
            if _hash_node_tree(nt, m, 0, seen, "material") and info is not None:
                info["truncated"] = True
            nodes = list(getattr(nt, "nodes", []) or [])
            m.update(("K|%d" % len(nodes)).encode("utf-8"))
            for node in nodes:
                if str(getattr(node, "type", "")) != "BSDF_PRINCIPLED":
                    continue
                for sock in getattr(node, "inputs", []):
                    if sock.name not in keys:
                        continue
                    val = getattr(sock, "default_value", None)
                    try:
                        val = tuple(round(float(x), 4) for x in val)
                    except TypeError:
                        try:
                            val = round(float(val), 4)
                        except Exception:
                            pass
                    m.update(("I|%s=%s" % (sock.name, val)).encode("utf-8"))
        except Exception:
            pass
        h.update(m.digest())


def _hash_drivers(ad, h, tag="DR"):
    """驱动器表达式/变量/目标；只改 expression 也必须 changed=true。"""
    if ad is None:
        return
    try:
        drivers = list(getattr(ad, "drivers", []) or [])
    except Exception:
        return
    for drv in drivers:
        try:
            d = drv.driver
            h.update(("%s|%s|%d|%s|%s" % (
                tag, drv.data_path, drv.array_index, getattr(d, "type", ""),
                getattr(d, "expression", ""))).encode("utf-8"))
            for var in getattr(d, "variables", []) or []:
                h.update(("DV|%s|%s|%s" % (
                    getattr(var, "name", ""), getattr(var, "type", ""),
                    getattr(var, "is_simple_expression", ""))).encode("utf-8"))
                for tgt in getattr(var, "targets", []) or []:
                    h.update(("DT|%s|%s|%s|%s" % (
                        getattr(tgt, "id_type", ""),
                        getattr(getattr(tgt, "id", None), "name", ""),
                        getattr(tgt, "data_path", ""),
                        getattr(tgt, "transform_type", ""))).encode("utf-8"))
        except Exception:
            pass


def _hash_shape_keys(ob, h):
    data = getattr(ob, "data", None)
    sk = getattr(data, "shape_keys", None)
    if sk is None:
        return
    try:
        blocks = list(getattr(sk, "key_blocks", []) or [])
    except Exception:
        blocks = []
    h.update(("SK|%d" % len(blocks)).encode("utf-8"))
    for kb in blocks:
        try:
            h.update(("KB|%s|%.6f|%.6f|%.6f|%s|%s" % (
                kb.name, float(kb.value), float(getattr(kb, "slider_min", 0.0)),
                float(getattr(kb, "slider_max", 1.0)), bool(getattr(kb, "mute", False)),
                getattr(kb, "vertex_group", ""))).encode("utf-8"))
        except Exception:
            pass
    _hash_drivers(getattr(sk, "animation_data", None), h, "SKD")


def _hash_pose(ob, h):
    if getattr(ob, "type", None) != "ARMATURE":
        return
    pose = getattr(ob, "pose", None)
    if pose is None:
        return
    for pb in getattr(pose, "bones", []) or []:
        try:
            mb = [round(float(v), 6) for row in pb.matrix_basis for v in row]
            h.update(("PB|%s|%s" % (pb.name, ",".join(str(v) for v in mb))).encode("utf-8"))
            for con in getattr(pb, "constraints", []) or []:
                h.update(("PC|%s|%.5f" % (
                    getattr(con, "type", ""), float(getattr(con, "influence", 0.0)))).encode("utf-8"))
        except Exception:
            pass
    _hash_drivers(getattr(ob, "animation_data", None), h, "POD")


def _hash_object(ob, h, info, domains, budget, seen=None):
    """对象域：名字/类型/变换（含 matrix_basis，赋值后立刻可见）/材质槽/修改器参数。"""
    info["objects"] += 1
    h.update(("O|%s|%s|%s" % (ob.name, ob.type, getattr(getattr(ob, "data", None), "name", ""))).encode("utf-8"))
    try:
        mw = [round(float(v), 6) for row in ob.matrix_world for v in row]
        h.update(("M|" + ",".join(str(v) for v in mw)).encode("utf-8"))
    except Exception:
        pass
    # matrix_world is cached and can lag behind an assignment; matrix_basis is the
    # authoritative user transform (location/rotation/scale), so hash both.
    try:
        mw = [round(float(v), 6) for row in ob.matrix_basis for v in row]
        h.update(("B|" + ",".join(str(v) for v in mw)).encode("utf-8"))
    except Exception:
        pass
    try:
        h.update(("P|" + str(getattr(getattr(ob, "parent", None), "name", ""))).encode("utf-8"))
        h.update(("L|" + ",".join(sorted(c.name for c in ob.users_collection))).encode("utf-8"))
    except Exception:
        pass
    try:
        mats = [s.material.name if s.material else "" for s in ob.material_slots]
        h.update(("A|" + ",".join(mats)).encode("utf-8"))
    except Exception:
        pass
    try:
        if _hash_modifiers(ob, h, seen):
            info["truncated"] = True
    except Exception:
        pass
    try:
        _hash_shape_keys(ob, h)
    except Exception:
        pass
    try:
        _hash_pose(ob, h)
    except Exception:
        pass
    try:
        _hash_drivers(getattr(ob, "animation_data", None), h, "OB")
    except Exception:
        pass
    return _hash_mesh(ob, h, info, domains, budget)


def _action_fcurves(act):
    """5.2+ layered action 的 fcurve 入口；旧版回退 Action.fcurves。

    不要用 hasattr(act, "fcurves") 判版本：第三方 shim 可能只暴露第一个
    channelbag，会把其它 slot 静默漏掉。结构判据是 act.layers。
    """
    layered = getattr(act, "layers", None) is not None
    if layered:
        slots = list(getattr(act, "slots", None) or [])
        curves = []
        seen = set()
        # 首选 bpy_extras；拿不到就退回 Action API（strip.channelbag），不再掉进
        # act.fcurves（layered action 上它不存在，旧写法会静默返回 []）。
        try:
            from bpy_extras import anim_utils
            for slot in slots:
                bag = anim_utils.action_get_channelbag_for_slot(act, slot)
                if bag is None:
                    continue
                for fc in getattr(bag, "fcurves", None) or []:
                    key = (fc.data_path, fc.array_index)
                    if key in seen:
                        continue
                    seen.add(key)
                    curves.append(fc)
            return curves
        except Exception:
            pass
        try:
            for layer in getattr(act, "layers", None) or []:
                for strip in getattr(layer, "strips", None) or []:
                    for slot in slots:
                        try:
                            bag = strip.channelbag(slot)
                        except Exception:
                            bag = None
                        if bag is None:
                            continue
                        for fc in getattr(bag, "fcurves", None) or []:
                            key = (fc.data_path, fc.array_index)
                            if key in seen:
                                continue
                            seen.add(key)
                            curves.append(fc)
            return curves
        except Exception as exc:
            # 两条路都失败：交给调用方记进 domains，不要假装"没有动画"
            raise RuntimeError("layered action fcurves unreadable: %s" % exc)
    try:
        return list(act.fcurves)
    except Exception:
        return []


def _hash_actions(actions, h, domains):
    """动作域：action 名 + fcurve 路径/索引 + 关键帧值/插值/句柄 + 外推。"""
    if not actions:
        return
    domains.append("actions")
    for act in actions:
        try:
            fcs = _action_fcurves(act)
            h.update(("X|%s|%d" % (act.name, len(fcs))).encode("utf-8"))
            for fc in fcs:
                h.update(("Y|%s|%d|%s|%s" % (
                    fc.data_path, fc.array_index, getattr(fc, "extrapolation", ""),
                    bool(getattr(fc, "mute", False)))).encode("utf-8"))
                for kp in fc.keyframe_points:
                    co = kp.co
                    hl = kp.handle_left
                    hr = kp.handle_right
                    h.update(("K|%.5f|%.5f|%s|%.5f|%.5f|%.5f|%.5f|%s" % (
                        co.x, co.y, kp.interpolation,
                        hl.x, hl.y, hr.x, hr.y,
                        getattr(kp, "easing", ""))).encode("utf-8"))
                for mod in getattr(fc, "modifiers", []) or []:
                    h.update(("FM|%s|%s" % (getattr(mod, "type", ""), getattr(mod, "mute", ""))).encode("utf-8"))
        except Exception:
            # 动画域读失败必须可见：旧写法 pass，digest 假装稳定。
            domains.append("actions_unreadable")


def _eval_stats(scene_objects):
    """depsgraph 评估后的 faces/verts + 有修改器的对象清单。

    零分配优先：ob_eval.data.polygons/vertices 直接给评估计数（Array 6→30 实测）；
    只有 data 不是 Mesh 时才 to_mesh() 兜底，并 finally 清理。对象/面/顶点有上限，
    触顶返回 limited=True，digest 回执据此标 digest_limited，不冒充全量指纹。
    """
    import bpy
    faces = 0
    verts = 0
    mods = []
    limited = False
    limits = {"objects": 500, "faces": 2000000, "verts": 2000000}
    try:
        dg = bpy.context.evaluated_depsgraph_get()
    except Exception:
        return 0, 0, mods, False
    counted = 0
    for ob in scene_objects:
        if getattr(ob, "type", None) != "MESH":
            continue
        if counted >= limits["objects"]:
            limited = True
            break
        # 隐藏且无修改器的对象不会贡献 eval 差异，跳过；有修改器的仍要算。
        if bool(getattr(ob, "hide_viewport", False)) and not getattr(ob, "modifiers", None):
            continue
        counted += 1
        try:
            ev = ob.evaluated_get(dg)
            data = getattr(ev, "data", None)
            if data is not None and hasattr(data, "polygons") and hasattr(data, "vertices"):
                f = len(data.polygons)
                v = len(data.vertices)
            else:
                me = ev.to_mesh()
                try:
                    f = len(me.polygons) if me is not None else 0
                    v = len(me.vertices) if me is not None else 0
                finally:
                    ev.to_mesh_clear()
            faces += f
            verts += v
        except Exception:
            pass
        try:
            names = [str(getattr(m, "type", "")) for m in getattr(ob, "modifiers", []) or []]
            if names:
                mods.append({"object": ob.name, "modifiers": names})
        except Exception:
            pass
        if faces >= limits["faces"] or verts >= limits["verts"]:
            limited = True
            break
    return faces, verts, mods, limited


def _scene_digest():
    """场景**内容哈希**（不看 mtime）：对象/变换/材质/修改器 + 网格拓扑与（有上限的）顶点坐标。

    判据只用于"改没改"，不用于交付指纹：超过顶点预算时 truncated=True，仍按拓扑与尺寸哈希。
    """
    import bpy

    t0 = time.time()
    h = hashlib.sha256()
    info = {"objects": 0, "meshes": 0, "verts": 0, "faces": 0, "truncated": False}
    domains = ["objects"]
    budget = DIGEST_MAX_FLOATS
    frame = None
    try:
        # filepath is deliberately NOT hashed: the same content saved under another
        # path is the same scene (field 反馈 4). It is reported separately as
        # filepath_changed by _digest_fields.
        h.update(("S|" + str(getattr(bpy.context.scene, "name", ""))).encode("utf-8"))
        # frame is NOT content: frame_set() is a read, and the same scene at 25 vs 1
        # must not report changed=true. Report it separately as frame/frame_after.
        frame = int(getattr(bpy.context.scene, "frame_current", 0) or 0)
    except Exception:
        pass
    # Scene content only: bpy.data.* also holds orphan/default datablocks (e.g. the
    # factory "Dots Stroke" material) that do not survive a save → digest of the same
    # scene changed after open_mainfile (found by the revert check).
    try:
        scene_objects = list(bpy.context.scene.objects)
    except Exception:
        scene_objects = list(bpy.data.objects)
    seen = set()
    for ob in sorted(scene_objects, key=lambda o: o.name):
        budget = _hash_object(ob, h, info, domains, budget, seen)
    try:
        used = {}
        for ob in scene_objects:
            for slot in getattr(ob, "material_slots", []):
                if slot.material is not None:
                    used[slot.material.name] = slot.material
        mats = sorted(used.values(), key=lambda m: m.name)
    except Exception:
        mats = []
    try:
        _hash_materials(mats, h, domains, seen, info)
    except Exception:
        pass
    try:
        acts = sorted(bpy.data.actions, key=lambda a: a.name)
    except Exception:
        acts = []
    _hash_actions(acts, h, domains)
    try:
        scene = bpy.context.scene
        _hash_node_tree(getattr(scene, "compositing_node_group", None) or getattr(scene, "node_tree", None), h, 0, seen, "material")
    except Exception:
        pass
    try:
        ev_faces, ev_verts, mods, eval_limited = _eval_stats(scene_objects)
    except Exception:
        ev_faces, ev_verts, mods, eval_limited = 0, 0, [], False
    return {
        "algo": DIGEST_ALGO,
        "digest": h.hexdigest()[:12],
        "scope": "scene",
        "domains": domains,
        "file": (getattr(bpy.data, "filepath", None) or None),
        "objects": info["objects"],
        "meshes": info["meshes"],
        "verts": info["verts"],
        "faces": info["faces"],
        "eval_faces": ev_faces,
        "eval_verts": ev_verts,
        "modifiers": mods[:200],
        "frame": frame,
        "materials": len(mats),
        "truncated": info["truncated"],
        "limited": bool(info["truncated"] or eval_limited),
        "ms": int((time.time() - t0) * 1000),
        "digest_ms": int((time.time() - t0) * 1000),
    }


def _digest_fields(before, after, elapsed_ms, kit_source):
    """exec digest=true 的结构化字段（纯函数，单测不依赖 bpy）。

    auto_restore / restore_applied 恒 False：本插件**从不**自动回滚 —— 改了就是改了。
    """
    b0 = before or {}
    a0 = after or {}
    b = b0.get("digest")
    a = a0.get("digest")
    fb = int(b0.get("faces") or 0)
    fa = int(a0.get("faces") or 0)
    efb = int(b0.get("eval_faces") or 0)
    efa = int(a0.get("eval_faces") or 0)
    evb = int(b0.get("eval_verts") or 0)
    eva = int(a0.get("eval_verts") or 0)
    file_before = b0.get("file")
    file_after = a0.get("file")
    return {
        "digest_before": b,
        "digest_after": a,
        "changed": bool(b is not None and a is not None and b != a),
        "faces_before": fb,
        "faces_after": fa,
        "faces_delta": fa - fb,
        "eval_faces_before": efb,
        "eval_faces_after": efa,
        "eval_faces_delta": efa - efb,
        "eval_verts_before": evb,
        "eval_verts_after": eva,
        "frame_before": b0.get("frame"),
        "frame_after": a0.get("frame"),
        "modifiers_after": a0.get("modifiers") or [],
        "verts_delta": int(a0.get("verts") or 0) - int(b0.get("verts") or 0),
        "objects_delta": int(a0.get("objects") or 0) - int(b0.get("objects") or 0),
        "filepath_before": file_before,
        "filepath_after": file_after,
        "filepath_changed": file_before != file_after,
        "digest_scope": list(a0.get("domains") or b0.get("domains") or ["objects"]),
        "digest_algo": a0.get("algo") or b0.get("algo") or DIGEST_ALGO,
        "restore_applied": False,
        "auto_restore": False,
        "kit_source": kit_source,
        "elapsed_ms": int(elapsed_ms),
        "digest_truncated": bool(a0.get("truncated") or b0.get("truncated")),
        "digest_limited": bool(a0.get("limited") or b0.get("limited") or a0.get("truncated") or b0.get("truncated")),
        "digest_ms": int(a0.get("digest_ms") or a0.get("ms") or elapsed_ms),
    }


def _digest():
    d = _scene_digest()
    return {
        "ok": True,
        "digest": d["digest"],
        "digest_scope": list(d.get("domains") or ["objects"]),
        "scope": d["scope"],
        "digest_algo": d["algo"],
        "file": d["file"],
        "objects": d["objects"],
        "meshes": d["meshes"],
        "verts": d["verts"],
        "faces": d["faces"],
        "eval_faces": d.get("eval_faces"),
        "eval_verts": d.get("eval_verts"),
        "modifiers": d.get("modifiers") or [],
        "frame": d.get("frame"),
        "materials": d["materials"],
        "truncated": d["truncated"],
        "limited": bool(d.get("limited") or d.get("truncated")),
        "digest_ms": d.get("digest_ms") or d["ms"],
        "kit_source": _kit_source(),
        "auto_restore": False,
        "restore_applied": False,
        "elapsed_ms": d["ms"],
    }


def _exec(code, timeout_ms=None, with_digest=False):
    global _calls, _errors
    _calls += 1
    K = _kernel_bootstrap()
    _load_action_helper(K)
    t0 = time.time()
    d0 = _scene_digest() if with_digest else None
    out, err = io.StringIO(), io.StringIO()
    ok, tb, errmsg = True, None, None
    ns = {"K": K, "bpy": K.bpy, "math": K.math, "mathutils": K.mathutils, "Vector": K.mathutils.Vector}
    try:
        import contextlib
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(code, "<dsh_worker>", "exec"), ns)
    except Exception as e:
        ok = False; errmsg = "%s: %s" % (type(e).__name__, e); tb = traceback.format_exc()
        _errors += 1
    stdout = out.getvalue()
    result = None
    lines = [l for l in stdout.splitlines() if l.startswith("HEADLESS ")]
    if lines:
        try:
            result = json.loads(lines[-1][len("HEADLESS "):].strip())
        except Exception as e:
            result = {"_parse_error": str(e), "raw": lines[-1][:300]}
    try:
        _bpy = ns.get("bpy") or __import__("bpy")
        _file = getattr(_bpy.data, "filepath", None) or None
        _objects = len(_bpy.data.objects)
    except Exception:
        _file, _objects = None, None
    payload = {"ok": ok, "ms": int((time.time() - t0) * 1000), "stdout": stdout[-8000:], "stderr": err.getvalue()[-4000:],
               "result": result, "error": errmsg, "traceback": tb,
               "file": _file, "objects": _objects}
    if with_digest:
        elapsed = int((time.time() - t0) * 1000)
        payload.update(_digest_fields(d0, _scene_digest(), elapsed, _kit_source()))
    return payload


def _status(gpu_info):
    import bpy
    K = sys.modules.get("dsh_rt_kernel")
    return {"ok": True, "version": WORKER_VERSION, "pid": os.getpid(),
            "uptime_s": int(time.time() - _started), "calls": _calls, "errors": _errors,
            "objects": len(bpy.data.objects), "file": bpy.data.filepath or None,
            "kernel_modules": sorted([a for a in dir(K) if K and a.startswith("dsh_") and a.endswith("_api")]),
            "boot": _boot_info, "frame_dir": _frame_dir(),
            "gpu": gpu_info}


def main():
    port = int(_arg("--port", "9879"))
    gpu_mode = _arg("--gpu", "auto")
    engine = str(_arg("--engine", "eevee")).lower()
    host = _arg("--host", "127.0.0.1")
    gpu_info = _engine_setup(gpu_mode, engine)
    boot_info = _run_boot(_arg("--boot", None))
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(4)
    _bpy = __import__("bpy")
    print("DSH_WORKER " + _j({"ready": True, "port": port, "pid": os.getpid(), "version": WORKER_VERSION,
                              "gpu": gpu_info, "boot": boot_info,
                              "file": getattr(_bpy.data, "filepath", None) or None,
                              "objects": len(_bpy.data.objects),
                              "blender": _bpy.app.version_string}), flush=True)
    stop = False
    while not stop:
        try:
            conn, addr = srv.accept()          # 主线程阻塞等待 —— bpy 调用随后也在主线程执行
        except Exception as e:
            print("DSH_WORKER_ERR " + _j({"accept": str(e)}), flush=True)
            time.sleep(0.2)
            continue
        conn.settimeout(None)
        f = conn.makefile("rwb")
        try:
            for raw in f:
                try:
                    req = json.loads(raw.decode("utf-8", "replace").strip() or "{}")
                except Exception as e:
                    f.write((_j({"id": None, "ok": False, "error": "bad json: %s" % e}) + "\n").encode()); f.flush(); continue
                rid = req.get("id")
                op = str(req.get("op") or "ping")
                if op == "ping":
                    resp = {"id": rid, "ok": True, "pong": True, "uptime_s": int(time.time() - _started)}
                elif op == "status":
                    resp = {"id": rid, "status": _status(gpu_info)}
                elif op == "digest":
                    resp = {"id": rid}
                    resp.update(_digest())
                elif op == "exec":
                    _purged = _purge_modules(req.get("purgePrefixes") or [])
                    r = _exec(
                        str(req.get("code") or ""),
                        req.get("timeoutMs"),
                        bool(req.get("digest")),
                    )
                    if _purged:
                        r["purged"] = _purged
                    resp = {"id": rid}; resp.update(r)
                elif op == "see":
                    r = _see(req.get("spec") or req.get("see") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "watch":
                    r = _watch(req.get("spec") or req.get("watch") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "reset":
                    r = _reset()
                    resp = {"id": rid}; resp.update(r)
                elif op == "checkpoint":
                    r = _checkpoint(req.get("spec") or req.get("checkpoint") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "revert":
                    r = _revert(req.get("spec") or req.get("revert") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "relocate":
                    r = _relocate(req.get("spec") or req.get("relocate") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "checkpoints":
                    r = _checkpoints(req.get("spec") or {})
                    resp = {"id": rid}; resp.update(r)
                elif op == "shutdown":
                    resp = {"id": rid, "ok": True, "bye": True}
                    f.write((_j(resp) + "\n").encode()); f.flush()
                    stop = True
                    break
                else:
                    resp = {"id": rid, "ok": False, "error": "unknown op: %s" % op}
                f.write((_j(resp) + "\n").encode()); f.flush()
        except Exception as e:
            try:
                f.write((_j({"ok": False, "error": "conn error: %s" % e}) + "\n").encode()); f.flush()
            except Exception:
                pass
        finally:
            try:
                f.close(); conn.close()
            except Exception:
                pass
    try:
        srv.close()
    except Exception:
        pass
    print("DSH_WORKER_STOP " + _j({"calls": _calls, "errors": _errors, "uptime_s": int(time.time() - _started)}), flush=True)


if __name__ == "__main__":
    main()