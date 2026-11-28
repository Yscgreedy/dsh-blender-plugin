"""DSH Blender 自定义视角捕获 —— 不动物体、不动场景相机，按给定相机参数出图。

通过 blender_see {from, look_at, ...} 调用；API 挂在 K.dsh_view_api。

解决什么：
  get_viewport_screenshot 只能出"当前用户视口"那一个角度（要换角度就得改用户视口）。
  本模块用自建 view/projection 矩阵 + GPUOffScreen.draw_view3d 离屏绘制，
  可以在**完全不修改场景与用户视口**的前提下，从任意位置/朝向/焦距出一帧。

数学（已与真相机对拍验证，误差 ~1e-7，见 selftest_matrices）：
  view = (Translation(from) @ dir.to_track_quat('-Z','Y').to_matrix().to_4x4()).inverted()
  proj:  AUTO 时 sensor 贴长边；
         hx = sensor/2（长边为宽时），hy = hx*h/w
         p00 = lens/hx, p11 = lens/hy
         这套与 Object.calc_matrix_camera() 输出逐元素一致。
  正交同理：p00 = 2/x_extent, p11 = 2/y_extent。

四种模式：
  viewport（默认）  GPUOffScreen.draw_view3d —— 指定机位（from/look_at）下的视口观感，零场景改动
  current          取用户当前视口朝向/镜头，按目标宽高重算投影（保水平视野、不拉伸、不动视口）
  camera           当前帧 evaluated 相机（含约束/驱动器）的视角；不改 scene.camera/帧/选择，输出渲染比例
  render           临时相机 + bpy.ops.render.opengl（Workbench/EEVEE 快渲），用完彻底还原
"""
import bpy, json, time, os, re, struct, zlib, tempfile

VIEW_VERSION = 4

# 近空帧的 PNG 字节阈值（v0.9.4）：**低于它才自动**跑一次诊断三项。
# 为什么要这个阈值：诊断（coverage / scene_bbox / objects_in_frame）实测 403 物体 560px 要 63 ms、
# 1120px 137 ms、2240px 488 ms，而真正的绘制 + 显存读回只有 ~22 ms ⇒ 正常帧不该每次白付。
# 但"瞄空"的告警不能丢：近空帧的 PNG 会压得极小（实测本机带网格线的一帧 560×315 = 37,908 B），
# 所以用字节数当机械判据，近空帧自动补跑诊断 → frame_looks_empty 照旧触发。
EMPTY_PNG_BYTES = 8000

# 默认输出到 Blender 本机临时目录（分享版不假设固定路径；正常调用时引擎会传
# path = 配置里的工作目录，这里只是兜底）。
WIN_DEFAULT = os.path.join(tempfile.gettempdir(), "dsh_view_capture.png")


import sys as _sys_kit
_KIT = getattr(_sys_kit.modules.get("dsh_rt_kernel"), "dsh_kit", None)
if _KIT is None:
    raise RuntimeError("view 需要共享内核 K.dsh_kit（由 KERNEL_BOOTSTRAP 注入）")


_j = _KIT.j  # 共享内核（原自带实现已删）
def _kernel():
    import sys
    return sys.modules.get("dsh_rt_kernel")

# ---------------------------------------------------------------- 坐标解析
_VEC_SPLIT = re.compile(r"[,\s;]+")

def _vec3(value, default, field="vector"):
    """字符串 "7,-7,5" / "[7,-7,5]" 与数组 [7,-7,5] 都收 → [x,y,z]。
    现场 bug（3.2.0-alpha.1）：_spec 曾 [float(v) for v in frm] 迭代字符串 → float(",") ValueError
    → custom 取帧 502。失败一律报**原串**，否则远程只看到逗号。
    """
    raw = value
    if isinstance(value, str):
        body = value.strip().strip("[]()")
        value = [part for part in _VEC_SPLIT.split(body) if part]
    if value is None:
        return [float(v) for v in default]
    try:
        out = [float(v) for v in value]
        if len(out) != 3:
            raise ValueError("需要 3 个分量")
        return out
    except (TypeError, ValueError):
        raise ValueError("%s 解析失败：%r —— 要 3 个数字，形如 '7,-7,5' 或 [7,-7,5]" % (field, raw))


# ---------------------------------------------------------------- 矩阵

def make_view_matrix(frm, look_at, up=(0.0, 0.0, 1.0)):
    """相机空间 → 与 cam.matrix_world.inverted() 一致（-Z 朝视线，Y 朝上）。"""
    from mathutils import Vector, Matrix
    frm = Vector(frm[:3])
    look = Vector(look_at[:3])
    d = look - frm
    if d.length < 1e-9:
        d = Vector((0.0, -1.0, 0.0))
    d.normalize()
    q = d.to_track_quat("-Z", "Y")
    return (Matrix.Translation(frm) @ q.to_matrix().to_4x4()).inverted()


def make_proj_matrix(w, h, lens=50.0, sensor=36.0, clip_start=0.1, clip_end=1000.0,
                     sensor_fit="AUTO", ortho=False, ortho_scale=1.0, shift_x=0.0, shift_y=0.0):
    """与 Object.calc_matrix_camera() 逐元素一致（landscape/portrait/ortho 均已对拍）。"""
    from mathutils import Matrix
    w = float(max(1, w)); h = float(max(1, h))
    fit = ("H" if w >= h else "V") if str(sensor_fit).upper().startswith("AUTO") else str(sensor_fit)[0].upper()
    if fit == "H":
        hx = sensor / 2.0
        hy = hx * (h / w)
    else:
        hy = sensor / 2.0
        hx = hy * (w / h)
    cs = float(clip_start); ce = float(clip_end)
    if ortho:
        sx = float(ortho_scale)
        x_extent = sx if fit == "H" else sx * (w / h)
        y_extent = sx * (h / w) if fit == "H" else sx
        p00 = 2.0 / x_extent; p11 = 2.0 / y_extent
        return Matrix(((p00, 0.0, 2.0 * float(shift_x), 0.0),
                       (0.0, p11, 2.0 * float(shift_y), 0.0),
                       (0.0, 0.0, -2.0 / (ce - cs), -(ce + cs) / (ce - cs)),
                       (0.0, 0.0, 0.0, 1.0)))
    p00 = lens / hx; p11 = lens / hy
    return Matrix(((p00, 0.0, 2.0 * float(shift_x), 0.0),
                   (0.0, p11, 2.0 * float(shift_y), 0.0),
                   (0.0, 0.0, -(ce + cs) / (ce - cs), -(2.0 * ce * cs) / (ce - cs)),
                   (0.0, 0.0, -1.0, 0.0)))


# ---------------------------------------------------------------- PNG 直写

def write_png(path, w, h, rgba, flip=True):
    """rgba: 顶层→底层顺序的 RGBA8 字节流（len = w*h*4）。

    直接写 PNG（不经过 bpy.data.images）的原因：GPU 帧缓冲读回来的是**已经 sRGB 编码**的 8bit 值，
    走 image.pixels（线性语义）再保存会被二次 gamma 编码。直写字节 = 所见即所得，且省掉一次色彩空间猜测。
    """
    raw = bytearray()
    stride = w * 4
    rng = range(h - 1, -1, -1) if flip else range(h)
    for y in rng:
        raw.append(0)  # filter type 0
        raw += rgba[y * stride:(y + 1) * stride]

    def _chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
           + _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


# ---------------------------------------------------------------- 视口定位

def _find_view3d(area_index=None):
    """返回 (window, area, region, space_view3d)；找不到 3D 视口时报错说明。"""
    wm = bpy.context.window_manager
    cands = []
    for win in wm.windows:
        scr = win.screen
        if scr is None:
            continue
        for a in scr.areas:
            if a.type == "VIEW_3D":
                cands.append((win, a))
    if not cands:
        raise RuntimeError("没有找到 VIEW_3D 区域：需要在 GUI 模式下打开一个 3D 视口（后台 -b 模式无法用它）")
    win, area = cands[0] if area_index is None else cands[min(max(0, int(area_index)), len(cands) - 1)]
    reg = next((r for r in area.regions if r.type == "WINDOW"), None)
    if reg is None:
        raise RuntimeError("VIEW_3D 区域没有 WINDOW 子区域")
    return win, area, reg, area.spaces.active


def _spec(spec):
    s = dict(spec or {})
    frm = s.get("from") or s.get("loc") or s.get("location")
    look = s.get("look_at") or s.get("target") or s.get("to")
    w = int(s.get("width") or (s.get("resolution") or [960, 540])[0])
    h = int(s.get("height") or (s.get("resolution") or [960, 540])[1])
    return {
        # 字符串 "7,-7,5" 与数组 [7,-7,5] 都收；解析失败报原串（见 _vec3）
        "from": _vec3(frm, [7.0, -7.0, 5.0], "from"),
        "look_at": _vec3(look, [0.0, 0.0, 1.0], "look_at"),
        "lens": float(s.get("lens", 50.0)),
        "sensor": float(s.get("sensor_width", s.get("sensor", 36.0))),
        "sensor_fit": str(s.get("sensor_fit", "AUTO")),
        "clip_start": float(s.get("clip_start", 0.1)),
        "clip_end": float(s.get("clip_end", 1000.0)),
        "ortho": bool(s.get("ortho", False)),
        "ortho_scale": float(s.get("ortho_scale", 10.0)),
        "shift_x": float(s.get("shift_x", 0.0)),
        "shift_y": float(s.get("shift_y", 0.0)),
        "width": max(16, min(4096, w)),
        "height": max(16, min(4096, h)),
        "mode": str(s.get("mode", "viewport")),
        "camera": s.get("camera"),
        "max_size": int(s.get("max_size") or 0),
        "engine": str(s.get("engine", "BLENDER_WORKBENCH")),
        "shading": s.get("shading"),
        "overlays": s.get("overlays"),
        "color_management": bool(s.get("color_management", True)),
        "background": bool(s.get("background", True)),
        "path": str(s.get("path") or WIN_DEFAULT),
        "area": None if s.get("area") is None else int(s.get("area")),
        "clear": s.get("clear", [0.05, 0.05, 0.05, 1.0]),
        # v0.9.4：默认**不跑**诊断三项（省 45–490 ms/次）；true = 强制每次跑
        "diagnostics": bool(s.get("diagnostics", False)),
        # v4：自动取景与标定（反馈 6）
        "fit": s.get("fit", s.get("fit_object")),
        "fit_margin": float(s.get("fit_margin") or 1.15),
        "aspect": str(s.get("aspect") or ""),
        "resize": bool(s.get("resize", False)),
        "ortho_given": "ortho" in dict(spec or {}),
    }


def matrices_json(spec_json):
    """只算矩阵，不出图（无 GUI 也能跑，便于对拍/调试）。"""
    s = _spec(json.loads(spec_json) if isinstance(spec_json, str) else spec_json)
    vm = make_view_matrix(s["from"], s["look_at"])
    pm = make_proj_matrix(s["width"], s["height"], s["lens"], s["sensor"], s["clip_start"], s["clip_end"],
                          s["sensor_fit"], s["ortho"], s["ortho_scale"], s["shift_x"], s["shift_y"])
    return _j({
        "ok": True, "width": s["width"], "height": s["height"], "mode": "matrices",
        "view_matrix": [[round(v, 6) for v in row] for row in vm],
        "proj_matrix": [[round(v, 6) for v in row] for row in pm],
        "spec": s,
    })


def targets():
    """列出所有 3D 视口（area 索引 → 是否可获得 region/着色模式），供选视角用。"""
    out = []
    wm = bpy.context.window_manager
    i = 0
    for win in wm.windows:
        scr = win.screen
        if scr is None:
            continue
        for a in scr.areas:
            if a.type == "VIEW_3D":
                reg = next((r for r in a.regions if r.type == "WINDOW"), None)
                sp = a.spaces.active
                out.append({"index": i, "window": [win.width, win.height],
                            "area": [a.x, a.y, a.width, a.height],
                            "region": None if reg is None else [reg.x, reg.y, reg.width, reg.height],
                            "shading": getattr(sp.shading, "type", None),
                            "overlays": bool(getattr(sp.overlay, "show_overlays", False)),
                            "is_active": bool(getattr(sp, "region_3d", None) and sp.region_3d.is_perspective is not None)})
                i += 1
    return _j({"ok": True, "count": len(out), "targets": out})


# ---------------------------------------------------------------- 捕获

def _capture_viewport(s, vm=None, pm=None, width=None, height=None):
    """GPUOffScreen 离屏绘制；vm/pm 省略时按 s 的相机参数自建（current/camera 模式传入现成矩阵）。"""
    import gpu
    win, area, reg, space = _find_view3d(s.get("area"))
    try:
        gpu.init()  # 后台/未初始化时必需；GUI 下已初始化，抛错忽略
    except Exception:
        pass
    w = int(width or s["width"]); h = int(height or s["height"])
    if vm is None:
        vm = make_view_matrix(s["from"], s["look_at"])
    if pm is None:
        pm = make_proj_matrix(s["width"], s["height"], s["lens"], s["sensor"], s["clip_start"], s["clip_end"],
                              s["sensor_fit"], s["ortho"], s["ortho_scale"], s["shift_x"], s["shift_y"])
    old_shading = None
    old_overlays = None
    try:
        if s["shading"]:
            old_shading = space.shading.type
            space.shading.type = str(s["shading"]).upper()
        if s["overlays"] is not None:
            old_overlays = space.overlay.show_overlays
            space.overlay.show_overlays = bool(s["overlays"])
        off = gpu.types.GPUOffScreen(w, h)
        try:
            with off.bind():
                fb = gpu.state.active_framebuffer_get()
                c = s["clear"]
                fb.clear(color=(float(c[0]), float(c[1]), float(c[2]), float(c[3]) if len(c) > 3 else 1.0), depth=1.0)
                scene = getattr(win, "scene", None) or bpy.context.scene
                vl = getattr(win, "view_layer", None) or bpy.context.view_layer
                off.draw_view3d(scene, vl, space, reg, vm, pm,
                                do_color_management=bool(s["color_management"]),
                                draw_background=bool(s["background"]))
                buf = off.texture_color.read()
                rgba = bytes(memoryview(buf))
        finally:
            try:
                off.free()
            except Exception:
                pass
    finally:
        if old_shading is not None:
            try:
                space.shading.type = old_shading
            except Exception:
                pass
        if old_overlays is not None:
            try:
                space.overlay.show_overlays = old_overlays
            except Exception:
                pass
    return rgba, {"region": [reg.x, reg.y, reg.width, reg.height], "area": [area.x, area.y, area.width, area.height],
                  "shading_used": space.shading.type}


def _current_matrices(space, reg, w, h, clip_start=0.1):
    """mode=current：用户当前视口朝向 + 同一镜头参数，按目标宽高重算投影（不拉伸、不动视口）。"""
    r3d = space.region_3d
    if r3d is None:
        raise RuntimeError("当前 3D 视口没有 region_3d")
    vm = r3d.view_matrix.copy()
    cam = bpy.context.scene.camera
    if r3d.view_perspective == "CAMERA" and cam is not None:
        cd = cam.data
        return vm, make_proj_matrix(w, h, cd.lens, cd.sensor_width, clip_start, 1000.0, cd.sensor_fit,
                                    cd.type == "ORTHO", cd.ortho_scale, cd.shift_x, cd.shift_y)
    sensor = 36.0
    if getattr(space, "camera", None) is not None and getattr(space.camera, "data", None) is not None:
        sensor = float(space.camera.data.sensor_width)
    return vm, make_proj_matrix(w, h, float(getattr(space, "lens", 50.0)), sensor, clip_start, 1000.0, "AUTO",
                                r3d.is_perspective is False, float(r3d.view_distance), 0.0, 0.0)


def _camera_matrices(s, scene, cam):
    """mode=camera：当前帧 evaluated 相机（约束/驱动器已算好）→ 矩阵 + 渲染比例尺寸。"""
    from mathutils import Vector
    ctype = str(getattr(cam.data, "type", "") or "").upper()
    if ctype == "PANO":
        raise RuntimeError("unsupported: 全景相机（PANO）不支持 camera 捕获，请用 blender_run(kind=render)")
    dg = bpy.context.evaluated_depsgraph_get()
    ce = cam.evaluated_get(dg)
    r = scene.render
    ax = (float(r.resolution_x) * float(getattr(r, "pixel_aspect_x", 1.0))) / max(
        1.0, float(r.resolution_y) * float(getattr(r, "pixel_aspect_y", 1.0)))
    if s.get("resize") and s.get("width") and s.get("height"):
        # 反馈 6: the caller asked for a fixed aspect; camera FOV follows Blender's
        # sensor fit at that size (no distortion, honest 'requested' framing).
        w, h = max(16, int(s["width"])), max(16, int(s["height"]))
    else:
        m = int(s.get("max_size") or 1024)
        w = m if ax >= 1.0 else max(16, int(round(m * ax)))
        h = max(16, int(round(m / ax))) if ax >= 1.0 else m
    loc = ce.matrix_world.translation
    fwd = ce.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
    s["from"] = [float(loc.x), float(loc.y), float(loc.z)]
    s["look_at"] = [float(loc.x + fwd.x), float(loc.y + fwd.y), float(loc.z + fwd.z)]
    s["lens"] = float(ce.data.lens)
    return ce.matrix_world.inverted(), ce.calc_matrix_camera(dg, x=w, y=h), w, h, {
        "camera": str(cam.name), "frame": int(scene.frame_current), "pixel_aspect": round(float(ax), 6),
        "preview_only": True, "dof_ignored": bool(getattr(cam.data.dof, "use_dof", False)),
        "motion_blur_ignored": bool(getattr(r, "use_motion_blur", False))}


def _capture_render(s):
    """临时相机 + viewport OpenGL 渲染（Workbench/EEVEE 快渲），结束后逐项还原。"""
    from mathutils import Vector
    scene = bpy.context.scene
    vl = bpy.context.view_layer
    cam_data = bpy.data.cameras.new("dsh_view_tmp_cam")
    cam = bpy.data.objects.new("dsh_view_tmp_cam", cam_data)
    saved = {}
    try:
        cam_data.lens = s["lens"]
        cam_data.sensor_width = s["sensor"]
        cam_data.sensor_fit = "AUTO" if s["sensor_fit"].upper().startswith("AUTO") else s["sensor_fit"].upper()
        cam_data.type = "ORTHO" if s["ortho"] else "PERSP"
        if s["ortho"]:
            cam_data.ortho_scale = s["ortho_scale"]
        cam_data.clip_start = s["clip_start"]
        cam_data.clip_end = s["clip_end"]
        cam_data.shift_x = s["shift_x"]
        cam_data.shift_y = s["shift_y"]
        cam.location = Vector(s["from"])
        cam.rotation_euler = (Vector(s["look_at"]) - Vector(s["from"])).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(cam)
        vl.update()
        r = scene.render
        saved = {"camera": scene.camera, "engine": r.engine, "rx": r.resolution_x, "ry": r.resolution_y,
                 "pct": r.resolution_percentage, "fp": r.filepath, "fmt": r.image_settings.file_format,
                 "color_mode": r.image_settings.color_mode}
        scene.camera = cam
        r.engine = s["engine"]
        r.resolution_x = s["width"]; r.resolution_y = s["height"]; r.resolution_percentage = 100
        r.filepath = s["path"]; r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGBA"
        if s["shading"]:
            try:
                scene.display.shading.type = str(s["shading"]).upper()
            except Exception:
                pass
        bpy.ops.render.opengl(write_still=True, view_context=False)
    finally:
        try:
            if saved.get("camera") is None and scene.camera is not None:
                scene.camera = None
            elif saved.get("camera") is not None:
                scene.camera = saved["camera"]
            if saved:
                scene.render.engine = saved["engine"]
                scene.render.resolution_x = saved["rx"]; scene.render.resolution_y = saved["ry"]
                scene.render.resolution_percentage = saved["pct"]
                scene.render.filepath = saved["fp"]
                scene.render.image_settings.file_format = saved["fmt"]
                scene.render.image_settings.color_mode = saved["color_mode"]
        except Exception:
            pass
        try:
            bpy.data.objects.remove(cam, do_unlink=True)
            bpy.data.cameras.remove(cam_data)
        except Exception:
            pass
    return None, {"method": "render.opengl", "engine": s["engine"], "output": s["path"]}


# ---------------------------------------------------------------- v0.9.1（93-D1/D2）：GUI 原语 + 自定义视角自诊断

def _win_path(p):
    """把 WSL 路径换成 Blender（Windows）能用的形态：优先用内核里的 K.win_path。"""
    K = _kernel()
    try:
        if K is not None and hasattr(K, "win_path"):
            return K.win_path(str(p))
    except Exception:
        pass
    return str(p)


def _scene_bbox():
    """当前场景可见 mesh 的世界 bbox + 最长边（给"瞄空"自诊断建议用）。"""
    from mathutils import Vector
    import numpy as np
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not (o.hide_render or o.hide_viewport)]
    if not meshes:
        return None
    pts = []
    for o in meshes:
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            pts.append((p.x, p.y, p.z))
    A = np.asarray(pts, dtype=float)
    mn, mx = A.min(axis=0), A.max(axis=0)
    size = mx - mn
    return {"min": [round(float(x), 4) for x in mn], "max": [round(float(x), 4) for x in mx],
            "center": [round(float(x), 4) for x in (mn + mx) / 2.0],
            "span": round(float(size.max()), 4), "objects": len(meshes)}


def _coverage(rgba, w, h, clear=None, stride=4):
    """画面里"非底色像素"占比（0..1）——判"自定义视角是不是瞄空了"。子采样（约 1/16 像素）。"""
    try:
        import numpy as np
        A = np.frombuffer(rgba, dtype="uint8").reshape(h, w, 4)[::stride, ::stride, :3].astype("int16")
        if clear and len(clear) >= 3:
            ref = np.asarray([int(round(float(c) * 255.0)) for c in clear[:3]], dtype="int16")
            return float((np.abs(A - ref).max(axis=2) > 8).mean())
        flat = A.reshape(-1, 3)
        if len(flat) == 0:
            return 0.0
        uniq, cnt = np.unique(flat, axis=0, return_counts=True)
        ref = uniq[int(np.argmax(cnt))]
        return float((np.abs(flat - ref).max(axis=1) > 8).mean())
    except Exception:
        try:
            n = len(rgba) // 4
            if n == 0:
                return 0.0
            base = tuple(int(round(float(c) * 255.0)) for c in (clear or [0, 0, 0])[:3])
            step = int(max(1, stride))
            diff = total = 0
            for i in range(0, n, step):
                j = i * 4
                total += 1
                if ((rgba[j] - base[0]) ** 2 + (rgba[j + 1] - base[1]) ** 2 + (rgba[j + 2] - base[2]) ** 2) > 64:
                    diff += 1
            return diff / max(1, total)
        except Exception:
            return 0.0


def _objects_in_frame(s, vm=None, pm=None):
    """按相机矩阵把每个可见对象的 bbox 投到画面里：返回 (in_frame_names, min_margin_px)。
    比"数非底色像素"可靠 —— background=true 时世界底色也算像素，纯覆盖率判不出"瞄空"。
    注意：mathutils.Matrix 只能跟 mathutils.Vector 乘（跟 numpy 数组会 TypeError，自检抓到过）。"""
    from mathutils import Vector
    if vm is None:
        vm = make_view_matrix(s["from"], s["look_at"])
    if pm is None:
        pm = make_proj_matrix(s["width"], s["height"], s["lens"], s["sensor"], s["clip_start"], s["clip_end"],
                              s["sensor_fit"], s["ortho"], s["ortho_scale"], s["shift_x"], s["shift_y"])
    vpm = pm @ vm
    w, h = float(s["width"]), float(s["height"])
    names, best = [], None
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.hide_render or o.hide_viewport:
            continue
        inside = False
        for c in o.bound_box:
            p = o.matrix_world @ Vector((c[0], c[1], c[2]))
            clip = vpm @ Vector((p.x, p.y, p.z, 1.0))
            if clip[3] <= 1e-9:
                continue                      # 在相机背后
            ndc = clip.xyz / clip[3]          # mathutils：切片 [:3] 会退化成 tuple，用 .xyz 才拿到 Vector
            x = (ndc[0] + 1.0) * 0.5 * w
            y = (ndc[1] + 1.0) * 0.5 * h
            if -0.1 * w <= x <= 1.1 * w and -0.1 * h <= y <= 1.1 * h:
                inside = True
                mx = min(x, w - x, y, h - y)
                best = mx if best is None else min(best, mx)
        if inside:
            names.append(o.name)
    return names, (None if best is None else round(float(best), 4))


def _empty_frame_note(cov, bbox, s, in_frame=None):
    """画面几乎为空时的可执行告警（而不是让用户自己去按 Home）。"""
    empty = (in_frame is not None and len(in_frame) == 0)
    if not empty and (cov is None or cov > 0.004):
        return None
    sug = None
    if bbox:
        import math as _m
        c = bbox["center"]
        span = max(float(bbox["span"]), 1e-6)
        v = [float(s["from"][i]) - c[i] for i in range(3)]
        n = _m.sqrt(sum(x * x for x in v)) or 1.0
        d = 2.2 * span
        sug = {"look_at": c, "from": [round(c[i] + v[i] / n * d, 4) for i in range(3)], "lens": s["lens"]}
    return {"code": "frame_looks_empty", "coverage": round(float(cov or 0.0), 6), "scene_bbox": bbox, "suggest": sug,
            "objects_in_frame": list(in_frame or []),
            "why": "画面里没有可见几何 —— 自定义视角瞄空（from/look_at 与场景不在同一处）"
                   if in_frame is not None else "画面里几乎只剩底色 —— 自定义视角多半瞄空",
            "hint": ("用返回的 scene_bbox.center 当 look_at；或直接用 suggest 里那组 from/look_at 再出一次"
                     if sug else "当前场景没有可见 mesh —— 自定义视角当然只有底色")}


def gui_frame(object=None, area=None, all=False):
    """GUI 原语（93-D1）：在真 UI 上下文里框选对象/全场景（blender_py 里 bpy.context.screen 为 None，做不到这件事）。"""
    win, ar, reg, space = _find_view3d(area)
    prev_sel = [o.name for o in bpy.context.selected_objects][:20]
    got = None
    try:
        with bpy.context.temp_override(window=win, screen=win.screen, area=ar, region=reg):
            if object:
                ob = bpy.data.objects.get(str(object))
                if ob is None:
                    return _j({"ok": False, "error": "对象不存在：%s" % object,
                               "hint": "先在 K 里看 bpy.data.objects 的名字"})
                ob.select_set(True)
                bpy.context.view_layer.objects.active = ob
                bpy.ops.view3d.view_selected(use_all_regions=False)
                got = ob.name
            else:
                bpy.ops.view3d.view_all(center=bool(all))
    except Exception as e:
        import traceback
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200]),
                   "traceback": traceback.format_exc()[-500:],
                   "hint": "需要 GUI 的 3D 视口；无头 -b 模式没有 UI 上下文（用 view.py 的 capture 代替）"})
    return _j({"ok": True, "framed": got, "mode": "all" if not object else "selected",
               "area": [ar.x, ar.y, ar.width, ar.height], "prev_selected": prev_sel,
               "note": "只动视口取景；场景数据未改"})


def gui_shading(mode="SOLID", color_type=None, area=None):
    """GUI 原语（93-D1）：切视口着色（WIREFRAME/SOLID/MATERIAL/RENDERED）+ 可选 color_type。"""
    win, ar, reg, space = _find_view3d(area)
    before = {"shading": space.shading.type, "color_type": getattr(space.shading, "color_type", None)}
    modes = ("WIREFRAME", "SOLID", "MATERIAL", "RENDERED")
    m = str(mode).upper()
    if m not in modes:
        return _j({"ok": False, "error": "未知 shading：%s" % mode, "allowed": list(modes)})
    try:
        space.shading.type = m
        if color_type:
            space.shading.color_type = str(color_type).upper()
    except Exception as e:
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200])})
    return _j({"ok": True, "shading": space.shading.type, "color_type": getattr(space.shading, "color_type", None),
               "before": before, "note": "只改视口显示；渲染设置未动"})


def gui_open(path):
    """GUI 原语（93-D1）：在 GUI 里打开 .blend（⚠ 替换当前文件；打开后旧引用全部失效）。"""
    if not path:
        return _j({"ok": False, "error": "path 必填"})
    wp = _win_path(path)
    try:
        bpy.ops.wm.open_mainfile(filepath=wp)
    except Exception as e:
        return _j({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200]), "path": wp})
    return _j({"ok": True, "opened": wp, "file": bpy.data.filepath, "objects": len(bpy.data.objects),
               "warning": "open_mainfile 会重建 bpy.data：之前抓到的 Object/Collection/材质引用全部作废，重新取一次",
               "note": "这是本会话当前文件；要写盘请显式 bpy.ops.wm.save_as_mainfile(filepath=...)"})


def gui_help():
    return _j({"version": VIEW_VERSION,
               "ops": {"gui_frame": "object=<名>|省略=全场景（真 UI 上下文 view_selected / view_all）",
                       "gui_shading": "mode=WIREFRAME|SOLID|MATERIAL|RENDERED，color_type 可选",
                       "gui_open": "path=<.blend>（⚠ 替换当前文件，旧引用失效）"},
               "why": "blender_py 的 execute_code 上下文没有 screen/area（实测 bpy.context.screen is None）→ 这三条由插件侧在真 UI 上下文执行",
               "read_only_note": "gui_frame / gui_shading 只动视口显示；gui_open 会换文件，属写操作"})


# ---------------------------------------------------------------- 宿主集成（/host/*）
#
# 这三条是**用户侧**能力（人点视口 → 进自己的消息），不是模型工具：
# 不进 /plan 的 op 目录、不改 addon（契约 §0）。数学复用本文件已有的
# make_view_matrix / make_proj_matrix / write_png，不另写一套。

# 点击兜底半径（按**出图**像素算）：灯光/相机/空物体没有可命中的表面，
# ray_cast 打不到，只能按"它在画面上的位置离点击点多近"兜底（对齐上游 addon.py 的 _PICK_RADIUS_PX）。
HOST_PICK_RADIUS_PX = 22.0


def _host_obj_brief(o):
    """pick 命中回执里的对象摘要。键固定 name/type/detail/location（契约 §1.5 的示例形状）。"""
    detail = str(o.type)
    if o.type == "MESH" and getattr(o, "data", None) is not None:
        try:
            detail = "MESH %dv/%df" % (len(o.data.vertices), len(o.data.polygons))
        except Exception:
            pass
    loc = o.matrix_world.translation
    return {"name": str(o.name), "type": str(o.type), "detail": detail,
            "location": [round(float(loc.x), 6), round(float(loc.y), 6), round(float(loc.z), 6)]}


def host_capture(spec_json):
    """抓**当前 GUI 视口**那一帧（矩阵直接取 region_3d），返回 PNG + 矩阵 + origin 信息。

    与 capture() 的分工：
      capture()      = "从任意位置看一眼"（自建矩阵，不动用户视口）—— 模型侧 blender_see 用
      host_capture() = "用户现在看到的就是这一帧"（region_3d 自己的 view/window 矩阵）—— 宿主面板用
    零场景改动、零视口改动（不改 shading/overlays/选择/相机），只读 GPU 离屏缓冲。

    ⚠ 拿不到矩阵就 **ok=false**（让上层把 pickable 置 false），绝不编一组矩阵冒充能点选。
    """
    s = json.loads(spec_json) if isinstance(spec_json, str) else dict(spec_json or {})
    try:
        max_size = int(s.get("max_size") or 1000)
    except Exception:
        max_size = 1000
    max_size = max(200, min(2000, max_size))
    path = str(s.get("path") or WIN_DEFAULT)
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    t0 = time.perf_counter()
    win, area, reg, space = _find_view3d(s.get("area"))
    r3d = getattr(space, "region_3d", None)
    if r3d is None:
        return _j({"ok": False, "error": "视口没有 region_3d：拿不到相机矩阵，不能假装能点选"})
    src_w, src_h = int(reg.width), int(reg.height)
    if max(src_w, src_h) > max_size:
        k = float(max_size) / float(max(src_w, src_h))
        w, h = max(1, int(src_w * k)), max(1, int(src_h * k))
    else:
        w, h = src_w, src_h
    vm = r3d.view_matrix.copy()
    pm = r3d.window_matrix.copy()
    import gpu
    try:
        gpu.init()          # 后台/未初始化时必需；GUI 下已初始化，抛错忽略
    except Exception:
        pass
    off = gpu.types.GPUOffScreen(w, h)
    try:
        with off.bind():
            fb = gpu.state.active_framebuffer_get()
            fb.clear(color=(0.05, 0.05, 0.05, 1.0), depth=1.0)
            # 画的就是用户视口的样子（do_color_management=True → write_png 直写字节，不做二次 gamma）
            off.draw_view3d(bpy.context.scene, bpy.context.view_layer, space, reg, vm, pm,
                            do_color_management=True, draw_background=True)
            rgba = bytes(memoryview(off.texture_color.read()))
    finally:
        try:
            off.free()
        except Exception:
            pass
    n = write_png(path, w, h, rgba)
    return _j({"ok": True, "path": path, "bytes": int(n), "width": int(w), "height": int(h),
               "view_matrix": [[round(float(v), 9) for v in row] for row in vm],
               "window_matrix": [[round(float(v), 9) for v in row] for row in pm],
               "file": str(bpy.data.filepath or ""), "scene": str(bpy.context.scene.name),
               "scene_count": int(len(bpy.data.scenes)),
               "region": [int(reg.x), int(reg.y), int(reg.width), int(reg.height)],
               "perspective": bool(r3d.is_perspective), "method": "region_3d/offscreen",
               "ms": int((time.perf_counter() - t0) * 1000)})


def host_pick(spec_json):
    """点击反投影：归一化点击坐标（0..1，左上原点、y 向下）→ 世界射线 → ray_cast 命中对象。

    **纪律（契约 §1.5）**：先校验 file/scene 错配，错配就回 `*_mismatch`；
    绝不把点击"投到当前场景"—— 那是把用户的一次点击变成一次误操作。
    """
    s = json.loads(spec_json) if isinstance(spec_json, str) else dict(spec_json or {})
    from mathutils import Matrix, Vector
    try:
        x = min(1.0, max(0.0, float(s.get("x", 0.5))))
        y = min(1.0, max(0.0, float(s.get("y", 0.5))))
    except Exception:
        x, y = 0.5, 0.5
    exp_file = "" if s.get("file") is None else str(s.get("file"))
    exp_scene = "" if s.get("scene") is None else str(s.get("scene"))
    cur_file = str(bpy.data.filepath or "")
    cur_scene = str(bpy.context.scene.name)
    if exp_file != cur_file:
        return _j({"ok": False, "error": "file_mismatch",
                   "expected": (exp_file or None), "current": (cur_file or None)})
    if exp_scene != cur_scene:
        return _j({"ok": False, "error": "scene_mismatch",
                   "expected": (exp_scene or None), "current": (cur_scene or None)})
    try:
        vm = Matrix([[float(v) for v in row] for row in s["view_matrix"]])
        pm = Matrix([[float(v) for v in row] for row in s["window_matrix"]])
    except Exception as e:
        return _j({"ok": False, "error": "unknown_seq", "why": "矩阵不可用: %s" % str(e)[:120]})
    try:
        w = float(s.get("width") or 0.0)
        h = float(s.get("height") or 0.0)
    except Exception:
        w = h = 0.0
    if w <= 0 or h <= 0:
        return _j({"ok": False, "error": "unknown_seq", "why": "缺 width/height"})
    vpm = pm @ vm
    try:
        inv = vpm.inverted()
    except Exception:
        return _j({"ok": False, "error": "unknown_seq", "why": "view@proj 不可逆"})
    ndc_x = 2.0 * x - 1.0
    ndc_y = 1.0 - 2.0 * y              # 图像 y 向下 → NDC y 向上
    p0 = inv @ Vector((ndc_x, ndc_y, -1.0, 1.0))
    p1 = inv @ Vector((ndc_x, ndc_y, 1.0, 1.0))
    if abs(p0.w) < 1e-12 or abs(p1.w) < 1e-12:
        return _j({"ok": False, "error": "unknown_seq", "why": "齐次 w≈0"})
    p0 = p0 / p0.w
    p1 = p1 / p1.w
    origin = Vector((p0.x, p0.y, p0.z))
    direction = Vector((p1.x - p0.x, p1.y - p0.y, p1.z - p0.z))
    if direction.length < 1e-12:
        return _j({"ok": False, "error": "unknown_seq", "why": "射线方向退化"})
    direction.normalize()
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    hit, loc, nrm, idx, obj, mtx = scene.ray_cast(dg, origin, direction)
    if hit and obj is not None:
        try:                              # 视口里看不见的东西不该被点到
            if obj.hide_viewport or not obj.visible_get():
                obj = None
        except Exception:
            pass
    if obj is not None:
        return _j({"ok": True, "object": _host_obj_brief(obj)})
    # 兜底：灯光/相机/空物体没有表面可命中，按屏幕距离取最近的一个
    best, best_d = None, None
    for o in scene.objects:
        if o.type not in ("LIGHT", "CAMERA", "EMPTY", "SPEAKER", "LIGHT_PROBE"):
            continue
        try:
            if o.hide_viewport or not o.visible_get():
                continue
        except Exception:
            pass
        p = o.matrix_world.translation
        clip = vpm @ Vector((p.x, p.y, p.z, 1.0))
        if clip.w <= 1e-9:
            continue
        sx = (clip.x / clip.w + 1.0) * 0.5 * w
        sy = (1.0 - clip.y / clip.w) * 0.5 * h
        dd = ((sx - x * w) ** 2 + (sy - y * h) ** 2) ** 0.5
        if dd <= HOST_PICK_RADIUS_PX and (best_d is None or dd < best_d):
            best, best_d = o, dd
    if best is not None:
        return _j({"ok": True, "object": _host_obj_brief(best)})
    return _j({"ok": True, "object": None})


def host_scene_items(spec_json):
    """`@` 提及的数据源（契约 §1.6）：objects / materials / collections，按 name 升序（稳定）。

    q 大小写不敏感子串过滤（空 = 全部）；limit **每类**各取这么多（默认 200、夹到 [1,1000]）。
    对象取 `bpy.data.objects`（不是 scene.objects）—— 契约要求"名字在 bpy.data.objects 里可直接用"。
    """
    s = json.loads(spec_json) if isinstance(spec_json, str) else dict(spec_json or {})
    q = str(s.get("q") or "").lower()
    # 口径与 Node 侧 clampItemsLimit 一致：缺省/非数 → 200；给了数 → 夹进 [1,1000]
    # （显式 limit=0 → 1，不是 200；契约 §1.6 写的是"夹到 [1,1000]"）
    lim = s.get("limit")
    if lim is None or lim == "":
        limit = 200
    else:
        try:
            limit = int(lim)
        except Exception:
            limit = 200
    limit = max(1, min(1000, limit))

    def hit(name):
        return (q == "") or (q in str(name).lower())

    objects = sorted([{"name": str(o.name), "type": str(o.type)} for o in bpy.data.objects if hit(o.name)],
                     key=lambda r: r["name"])[:limit]
    materials = sorted([{"name": str(m.name)} for m in bpy.data.materials if hit(m.name)],
                       key=lambda r: r["name"])[:limit]
    collections = sorted([{"name": str(c.name)} for c in bpy.data.collections if hit(c.name)],
                         key=lambda r: r["name"])[:limit]
    return _j({"ok": True, "objects": objects, "materials": materials, "collections": collections})



# ---------------------------------------------------------------- v4：自动取景 + 标定（反馈 6）

def _fit_objects(s):
    """fit=object|scene|<name> → 参与取景的对象（默认：选中，其次全部可见 mesh）。"""
    fit = s.get("fit")
    scene_meshes = [o for o in bpy.context.scene.objects
                    if o.type == "MESH" and not (o.hide_render or o.hide_viewport)]
    if isinstance(fit, str):
        key = fit.strip().lower()
        if key in ("", "false", "none", "off", "0"):
            return []
        if key not in ("true", "auto", "object", "selected", "scene"):
            ob = bpy.data.objects.get(fit)
            if ob is None:
                raise ValueError("fit_object=%s 不存在（bpy.data.objects 里没有这个名字）" % fit)
            return [ob]
        if key == "scene":
            return scene_meshes
        sel = [o for o in bpy.context.selected_objects if o.type == "MESH"]
        return sel or scene_meshes
    if fit is True:
        sel = [o for o in bpy.context.selected_objects if o.type == "MESH"]
        return sel or scene_meshes
    return []


def _world_corners(objs):
    from mathutils import Vector
    pts = []
    for ob in objs:
        try:
            for c in ob.bound_box:
                pts.append(ob.matrix_world @ Vector((c[0], c[1], c[2])))
        except Exception:
            continue
    return pts


def _fit_camera(s):
    """按对象世界 bbox 一次框全：改 from/look_at/(ortho, ortho_scale)。

    默认正交（覆盖率与距离无关，近摄不会因为 near clip 全白）；显式给
    ortho=false 时才按视锥算距离。
    """
    import math
    from mathutils import Vector
    objs = _fit_objects(s)
    pts = _world_corners(objs)
    if not pts:
        raise ValueError("fit_object 没有可框的 mesh（选中为空且场景没有可见 mesh）")
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (mn + mx) * 0.5
    span = mx - mn
    frm = s.get("from") or [center.x + 1.0, center.y - 1.0, center.z + 0.8]
    forward = Vector((center.x - float(frm[0]), center.y - float(frm[1]), center.z - float(frm[2])))
    if forward.length < 1e-9:
        forward = Vector((1.0, -1.0, -0.8))
    forward.normalize()
    up = Vector((0.0, 0.0, 1.0))
    right = forward.cross(up)
    if right.length < 1e-6:
        right = Vector((1.0, 0.0, 0.0))
    right.normalize()
    true_up = right.cross(forward).normalized()
    xs = [(p - center).dot(right) for p in pts]
    ys = [(p - center).dot(true_up) for p in pts]
    zs = [(p - center).dot(forward) for p in pts]
    wbox = max(xs) - min(xs)
    hbox = max(ys) - min(ys)
    depth = max(zs) - min(zs)
    w, h = float(s["width"]), float(s["height"])
    margin = float(s.get("fit_margin") or 1.15)
    use_ortho = bool(s.get("ortho")) or not s.get("ortho_given")
    if use_ortho:
        if w >= h:
            sx = max(wbox, hbox * (w / h)) * margin
        else:
            sx = max(hbox, wbox * (h / w)) * margin
        s["ortho"] = True
        s["ortho_scale"] = float(max(0.001, sx))
        dist = max(0.001, depth * 1.5 + max(wbox, hbox) * 2.0)
    else:
        fov = 2.0 * math.atan((float(s["sensor"]) * 0.5) / max(1e-6, float(s["lens"])))
        dist = (max(wbox, hbox) * 0.5) / max(1e-6, math.tan(fov * 0.5)) * margin
    s["from"] = [round(center.x - forward.x * dist, 6),
                 round(center.y - forward.y * dist, 6),
                 round(center.z - forward.z * dist, 6)]
    s["look_at"] = [round(center.x, 6), round(center.y, 6), round(center.z, 6)]
    return {
        "objects": [getattr(o, "name", "") for o in objs][:40],
        "bbox": {"center": [round(float(v), 6) for v in center],
                 "span": [round(float(v), 6) for v in span]},
        "ortho": bool(s.get("ortho")),
        "ortho_scale": round(float(s.get("ortho_scale") or 0.0), 6) or None,
        "distance": round(float(dist), 6),
        "frame_margin": margin,
        "direction": [round(float(forward.x), 4), round(float(forward.y), 4), round(float(forward.z), 4)],
    }


def _frame_metrics(s, bbox=None):
    """像素↔毫米标定：PX_PER_MM + 可见阈值（4.5 px 经验值，见反馈 6 探针表）。"""
    w = float(s.get("width") or 0)
    h = float(s.get("height") or 0)
    ppm = None
    frame_w_mm = None
    focus = None
    if w > 0:
        if s.get("ortho"):
            sx = float(s.get("ortho_scale") or 0.0)
            x_extent = sx if w >= h else sx * (w / max(h, 1.0))
            if x_extent > 0:
                frame_w_mm = x_extent * 1000.0
                ppm = w / frame_w_mm
        else:
            if bbox:
                focus = ((float(s["from"][0]) - float(bbox["center"][0])) ** 2 +
                         (float(s["from"][1]) - float(bbox["center"][1])) ** 2 +
                         (float(s["from"][2]) - float(bbox["center"][2])) ** 2) ** 0.5
            if focus and focus > 0 and float(s.get("lens") or 0) > 0:
                frame_w_m = 2.0 * focus * (float(s["sensor"]) * 0.5 / float(s["lens"]))
                frame_w_mm = frame_w_m * 1000.0
                ppm = w / frame_w_mm
    return {
        "px_per_mm": round(float(ppm), 4) if ppm else None,
        "frame_width_mm": round(float(frame_w_mm), 2) if frame_w_mm else None,
        "visible_threshold_mm": round(4.5 / float(ppm), 3) if ppm else None,
        "focus_distance": round(float(focus), 6) if focus else None,
        "clip_start": round(float(s.get("clip_start") or 0.0), 6),
        "ortho": bool(s.get("ortho")),
        "ortho_scale": round(float(s.get("ortho_scale") or 0.0), 6) or None,
    }


def _near_clip_note(s, bbox, cov):
    """近摄全白：距离 < clip_start 时先说清 near clip，而不是报"瞄空"。"""
    if cov is None or cov > 0.004:
        return None
    clip = float(s.get("clip_start") or 0.1)
    center = bbox["center"] if bbox else s.get("look_at") or [0, 0, 0]
    d = ((float(s["from"][0]) - float(center[0])) ** 2 +
         (float(s["from"][1]) - float(center[1])) ** 2 +
         (float(s["from"][2]) - float(center[2])) ** 2) ** 0.5
    if d >= clip:
        return None
    return {
        "code": "frame_clipped_by_near_plane",
        "coverage": round(float(cov), 6),
        "clip_start": round(clip, 6),
        "camera_distance": round(float(d), 6),
        "suggest_clip_start": round(max(0.0005, d * 0.5), 6),
        "why": "相机到目标的距离 %.4g BU < clip_start %.4g BU：整帧被近裁剪面切掉（不是瞄空）" % (d, clip),
        "hint": "把 clip_start 设成 %.4g（或把相机拉远到 > %.4g BU）再取一次；毫米级零件默认 0.1 BU 必然全白" % (max(0.0005, d * 0.5), clip),
    }


def capture(spec_json):
    """出图主入口：按 spec 出一帧 PNG，返回 JSON（含路径/尺寸/矩阵/耗时）。"""
    t0 = time.perf_counter()
    s = _spec(json.loads(spec_json) if isinstance(spec_json, str) else spec_json)
    path = s["path"]
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    meta = {}
    rgba = None
    mode = s["mode"].lower()
    err = None
    vm = pm = None
    extra = {}
    if s.get("fit"):
        try:
            extra["fit"] = _fit_camera(s)
        except Exception as e:
            return _j({"ok": False, "mode": mode, "error": "%s: %s" % (type(e).__name__, e),
                       "hint": "fit=object|scene 或 fit=<对象名>；也可以显式给 from/look_at"})
    if mode == "camera":
        raw_cam = s.get("camera")
        wanted = str(raw_cam).strip() if raw_cam is not None else ""
        if wanted and wanted.lower() != "true":
            cam = bpy.data.objects.get(wanted)
            if cam is None or getattr(cam, "type", "") != "CAMERA":
                return _j({"ok": False, "mode": mode,
                           "error": "unsupported: 没有名为 %s 的相机对象" % wanted})
        else:
            cam = bpy.context.scene.camera
        if cam is None:
            return _j({"ok": False, "mode": mode, "error": "unsupported: 场景没有活动相机（scene.camera 为空）"})
        try:
            vm, pm, w, h, cam_extra = _camera_matrices(s, bpy.context.scene, cam)
            extra.update(cam_extra or {})
            s["width"], s["height"] = w, h
            rgba, meta = _capture_viewport(s, vm, pm, w, h)
        except Exception as e:
            return _j({"ok": False, "mode": mode, "error": "%s: %s" % (type(e).__name__, e)})
    elif mode == "current":
        try:
            win, area, reg, space = _find_view3d(s.get("area"))
            vm, pm = _current_matrices(space, reg, s["width"], s["height"], float(s.get("clip_start") or 0.1))
            rgba, meta = _capture_viewport(s, vm, pm)
        except Exception as e:
            return _j({"ok": False, "mode": mode, "error": "%s: %s" % (type(e).__name__, e)})
    elif mode == "viewport":
        try:
            rgba, meta = _capture_viewport(s)
        except Exception as e:
            err = "%s: %s" % (type(e).__name__, e)
            mode = "render"  # 自动降级（例如没有 3D 视口可用）
    if rgba is None:
        rgba, meta2 = _capture_render(s)
        meta.update(meta2 or {})
        if not os.path.isfile(path):
            return _j({"ok": False, "error": err or "出图失败（viewport 与 render 两条路都没产出）", "mode": mode})
        size = os.path.getsize(path)
        bbox_r = _scene_bbox()
        metrics_r = _frame_metrics(s, bbox_r)
        # 近空帧/显式 diagnostics 才补跑逐对象投影（403 物体 ~18 ms×2）。
        need_diag_r = bool(s.get("diagnostics")) or int(size) < EMPTY_PNG_BYTES
        warn_r = _near_clip_note(s, bbox_r, 0.0) if need_diag_r else None
        return _j({"ok": True, "mode": mode, "path": path, "bytes": size,
                   "width": s["width"], "height": s["height"], "fallback_from": err,
                   "diagnostics": need_diag_r,
                   "coverage_estimate": None, "scene_bbox": bbox_r,
                   "warning": (warn_r or (None if bbox_r else (_empty_frame_note(0.0, None, s) if need_diag_r else None))),
                   "px_per_mm": metrics_r["px_per_mm"],
                   "visible_threshold_mm": metrics_r["visible_threshold_mm"],
                   "clip_start": s["clip_start"], "frame_metrics": metrics_r,
                   "matrix": {"view": [[round(v, 6) for v in r] for r in make_view_matrix(s["from"], s["look_at"])],
                              "proj": [[round(v, 6) for v in r] for r in make_proj_matrix(
                                  s["width"], s["height"], s["lens"], s["sensor"], s["clip_start"], s["clip_end"],
                                  s["sensor_fit"], s["ortho"], s["ortho_scale"], s["shift_x"], s["shift_y"])]},
                   "meta": meta, "ms": int((time.perf_counter() - t0) * 1000), "spec": s})
    n = write_png(path, s["width"], s["height"], rgba)
    # 反馈 6：覆盖率与 px/mm 变成**每次都有**的标定（不再只在近空帧时才算）。
    cov = _coverage(rgba, s["width"], s["height"], None)   # 底色取众数（background=true 时世界底色也算像素）
    bbox = _scene_bbox()
    metrics = _frame_metrics(s, bbox)
    need_diag = bool(s.get("diagnostics")) or int(n) < EMPTY_PNG_BYTES or cov <= 0.004
    in_frame = margin_px = None
    if need_diag:
        try:
            in_frame, margin_px = _objects_in_frame(s, vm, pm)
        except Exception:
            in_frame, margin_px = None, None
    warn = _near_clip_note(s, bbox, cov) if need_diag else None
    if warn is None and need_diag:
        warn = _empty_frame_note(cov, bbox, s, in_frame)
    out = {"ok": True, "mode": mode, "path": path, "bytes": n,
           "diagnostics": need_diag,
           "width": s["width"], "height": s["height"], "fallback_from": err,
           "coverage_estimate": round(float(cov), 6), "scene_bbox": bbox,
           "objects_in_frame": in_frame, "min_margin_px": margin_px, "warning": warn,
           "px_per_mm": metrics["px_per_mm"],
           "visible_threshold_mm": metrics["visible_threshold_mm"],
           "frame_metrics": metrics, "clip_start": s["clip_start"],
           "matrix": {"view": [[round(v, 6) for v in r] for r in
                               (vm if vm is not None else make_view_matrix(s["from"], s["look_at"]))],
                      "proj": [[round(v, 6) for v in r] for r in
                               (pm if pm is not None else make_proj_matrix(
                                   s["width"], s["height"], s["lens"], s["sensor"], s["clip_start"], s["clip_end"],
                                   s["sensor_fit"], s["ortho"], s["ortho_scale"], s["shift_x"], s["shift_y"]))]},
           "meta": meta, "ms": int((time.perf_counter() - t0) * 1000), "spec": s}
    out.update(extra)
    return _j(out)

def selftest():
    """无需 GUI 的自检：GPUOffScreen 清屏 → 读回 → 直写 PNG → 校验字节（后台 -b 也能跑）。"""
    import gpu
    out = {}
    try:
        gpu.init()
        out["gpu_init"] = "ok"
    except Exception as e:
        out["gpu_init"] = "ERR " + str(e)[:120]
    from mathutils import Vector
    cam_data = bpy.data.cameras.new("st")
    cam = bpy.data.objects.new("st", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    try:
        cam_data.lens = 50.0
        cam.location = (6.0, -4.0, 3.5)
        cam.rotation_euler = (Vector((0, 0, 1)) - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        ref = cam.calc_matrix_camera(dg, x=1920, y=1080)
        mine = make_proj_matrix(1920, 1080, 50.0, 36.0, cam_data.clip_start, cam_data.clip_end)
        out["proj_max_delta"] = max(abs(a - b) for ra, rb in zip([list(r) for r in ref], [list(r) for r in mine])
                                    for a, b in zip(ra, rb))
        vref = cam.matrix_world.inverted()
        vmine = make_view_matrix((6.0, -4.0, 3.5), (0.0, 0.0, 1.0))
        out["view_max_delta"] = max(abs(a - b) for ra, rb in zip([list(r) for r in vref], [list(r) for r in vmine])
                                    for a, b in zip(ra, rb))
        cam_data.type = "ORTHO"; cam_data.ortho_scale = 12.0
        bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get()
        oref = cam.calc_matrix_camera(dg, x=1920, y=1080)
        omine = make_proj_matrix(1920, 1080, ortho=True, ortho_scale=12.0)
        out["ortho_max_delta"] = max(abs(a - b) for ra, rb in zip([list(r) for r in oref], [list(r) for r in omine])
                                     for a, b in zip(ra, rb))
    finally:
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    W, H = 96, 54
    off = gpu.types.GPUOffScreen(W, H)
    try:
        with off.bind():
            fb = gpu.state.active_framebuffer_get()
            fb.clear(color=(25 / 255.0, 153 / 255.0, 51 / 255.0, 1.0), depth=1.0)
            rgba = bytes(memoryview(off.texture_color.read()))
    finally:
        off.free()
    p = os.path.join(os.path.dirname(WIN_DEFAULT), "dsh_view_selftest.png")
    out["png_bytes"] = write_png(p, W, H, rgba)
    out["png_path"] = p
    out["first_px"] = list(rgba[:4])
    out["ok"] = (out.get("proj_max_delta", 9) < 1e-5 and out.get("view_max_delta", 9) < 1e-5
                 and out.get("ortho_max_delta", 9) < 1e-5 and out["first_px"] == [25, 153, 51, 255])
    return _j(out)


def help():
    return _j({
        "version": VIEW_VERSION,
        "capture": "capture({from, look_at, lens, ortho, ortho_scale, width, height, shading, overlays, mode, path})",
        "fields": {
            "from / look_at": "世界坐标 [x,y,z]（必给）",
            "lens / sensor_width": "焦距 mm / 传感器宽 mm（默认 50 / 36，AUTO 贴长边）",
            "ortho / ortho_scale": "正交开关与尺度（贴长边）",
            "width / height": "出图分辨率（16..4096）",
            "shading": "WIREFRAME/SOLID/MATERIAL/RENDERED —— 临时切换视口着色，出图后还原",
            "overlays": "true/false 临时开关覆盖物（网格/坐标轴/gizmo），出图后还原",
            "mode": "viewport（默认，指定机位零场景改动）/ current（用户视口朝向，按目标宽高重算投影）"
                    " / camera（当前帧 evaluated 相机；不改 scene.camera/帧/选择；输出渲染比例）/ render（临时相机 + render.opengl）",
            "camera": "mode=camera 时的相机：true=scene.camera，或对象名（data 必须是 CAMERA）",
            "max_size": "mode=camera 时最长边像素（默认 1024；按渲染比例算另一条边）",
            "color_management": "默认 true（出图带色彩管理，所见即所得）",
            "background": "默认 true（画世界背景）",
            "path": "输出 PNG 的路径（Blender 侧可见；默认取配置的工作目录，兜底用系统临时目录）",
        },
        "others": {"matrices": "只算矩阵不出图", "targets": "列出可用的 3D 视口", "selftest": "无 GUI 自检",
                   "gui_frame": "GUI 原语：框选对象/全场景（blender_py 里 screen 为 None 做不到）",
                   "gui_shading": "GUI 原语：切视口着色 WIREFRAME/SOLID/MATERIAL/RENDERED",
                   "gui_open": "GUI 原语：打开 .blend（⚠ 替换当前文件）", "gui_help": "GUI 原语速查",
                   "host_capture": "宿主面板：抓当前 GUI 视口帧（region_3d 矩阵 + PNG；零视口改动）",
                   "host_pick": "宿主面板：归一化点击 → ray_cast 命中对象（先校验 file/scene 错配）",
                   "host_scene_items": "宿主面板：@ 提及数据源（objects/materials/collections）"},
        "diagnostics_v3": {
            "coverage_estimate": "画面里非底色像素占比（子采样）—— 用来判'自定义视角是不是瞄空了'",
            "scene_bbox": "当前场景可见 mesh 的世界 bbox（center/span）—— 瞄空时按它重设 look_at",
            "warning": "coverage ≤ 0.004 时给 {code:'frame_looks_empty', suggest:{from,look_at,lens}}，直接照它再出一次",
            "when": "v0.9.4 起**默认不跑**（回执里 diagnostics=false 且三项为 null）；"
                    "PNG < %d 字节（近空帧）自动补跑；spec.diagnostics=true 可强制每次都跑。"
                    "实测省 45 ms（空场景）～488 ms（2240×1260）/次" % EMPTY_PNG_BYTES,
        },
        "notes": "viewport 模式完全不改场景（物体/相机/选择都不动）；render 模式临时加相机，结束即删并逐项还原渲染设置",
    })


import sys as _sys
_K = _sys.modules.get("dsh_rt_kernel")
if _K is not None:
    _K.dsh_view_api = _KIT.Api({"version": VIEW_VERSION, "capture": capture, "matrices": matrices_json,
                       "targets": targets, "selftest": selftest, "help": help,
                       "gui_frame": gui_frame, "gui_shading": gui_shading, "gui_open": gui_open,
                       "gui_help": gui_help,
                       # 宿主集成（/host/*，用户侧能力；契约 §1）：抓当前 GUI 视口帧 / 点击反投影 / @ 提及数据源
                       "host_capture": host_capture, "host_pick": host_pick,
                       "host_scene_items": host_scene_items,
                       # v0.9.1：诊断原语正式暴露（私有名在 preload 的命名空间隔离下不外泄，
                       # 所以"能被复用/被自检调用"的东西必须挂到 API 上）
                       "diagnostics": {"scene_bbox": _scene_bbox, "coverage": _coverage,
                                       "objects_in_frame": _objects_in_frame,
                                       "empty_frame_note": _empty_frame_note,
                                       # v0.9.4：把"什么时候会自动跑诊断"的阈值一并暴露，
                                       # 自检才能对"diagnostics 标志 == (显式要求 or 字节数 < 阈值)"做机械断言
                                       "empty_png_bytes": EMPTY_PNG_BYTES}})


# ---- 端口（provider 端口倒置）：core 的 c_evidence 只 call_port("view_capture") ----
# 注册点就在提供方自己的模块尾：谁 preload/ensureView 了 view，谁就登记；没加载 = 端口不存在 =
# 消费方 fail-closed（core 不再出现 render 的私有 API 名，core → render 的 2-环断在调用侧）。
def _port_capture(payload):
    """端口 view_capture：dict 与 JSON 文本两种入参归一后交给 capture（引擎直调走 JSON，进程内走 dict）。"""
    spec = json.loads(payload) if isinstance(payload, str) else payload
    return capture(spec if spec is not None else {})


_KIT.register_port("view_capture", _port_capture, VIEW_VERSION)
