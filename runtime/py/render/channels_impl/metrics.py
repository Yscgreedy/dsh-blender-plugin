# -*- coding: utf-8 -*-
"""render 通道指标（render / alpha / mask / ink）：每通道路径 + 前景像素/覆盖率/连通域/bbox。

台账（docs/archive/2026-11-20-角色动画与卡通渲染需求.md 第 72-74 行，render channels 条）要求：
每通道给 foreground_px / coverage / n_components / bbox；缺 ink 对象时该通道 skipped、
整体 verdict=degraded 而不是 fail（三态判定在 JS 侧做，这里只报每通道 status/metrics/reason）。

位置与加载方式（与 runtime/py/geometry/geo_impl/units.py 同一套）：
  - 放在 channels_impl/ 子包里而不是 render/ 顶层的公开模块：布局契约要求
    runtime/py/<domain>/ 顶层的每个 .py 都是 modules.json 里登记的公开模块，本文件是
    渲染作业的收尾助手，没有 K.dsh_*_api 入口，所以走子包、不登记 modules.json；
  - 前半段是纯函数（只依赖 numpy，无 cv2）：可直接单测，不需要 Blender；
  - 后半段是薄 bpy 包装：由队列渲染作业在 -a 之后追加的收尾片段按 __file__ 定位 exec。

连通域不用 cv2：按"行内游程 + 并查集"数 4-连通块，复杂度只跟游程数走（4K 图也不慢）。
"""
import os
import re

import numpy as np

# 通道名与阈值口径（与 src/tools/run/execute.ts 的允许列表同一组名字）
CHANNEL_NAMES = ("render", "alpha", "mask", "ink")
ALPHA_MIN = 0.5  # mask 通道：alpha >= 0.5 才算实体像素
INK_LEVEL = 0.5  # ink 通道：亮度 < 0.5 算墨线像素
_INK_PATTERN = re.compile(r"(?:^|[^0-9A-Za-z])(ink|outline|lineart|line_art)(?:[^0-9A-Za-z]|$)|描边|墨线", re.I)


# ---------------------------------------------------------------- 纯函数：指标


def empty_metrics():
    """空掩膜的指标（四个键恒定存在，bbox 用 None 表示"没有前景"）。"""
    return {"foreground_px": 0, "coverage": 0.0, "n_components": 0, "bbox": None}


def _as_mask(mask):
    arr = np.asarray(mask)
    if arr.dtype != bool:
        arr = arr.astype(bool)
    if arr.ndim != 2:
        raise ValueError("掩膜必须是二维布尔数组（收到维度 %d）" % arr.ndim)
    return arr


def _row_runs(row):
    """一行里的 True 游程 [(start, end_inclusive)]（numpy 差分，不做逐像素 Python 循环）。"""
    padded = np.concatenate(([False], row, [False])).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    return [(int(edges[i]), int(edges[i + 1]) - 1) for i in range(0, len(edges), 2)]


def n_components(mask):
    """4-连通连通域个数：行内游程 + 并查集（只并相邻两行里重叠的游程）。"""
    m = _as_mask(mask)
    if not m.any():
        return 0
    parent = []

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    prev = []
    for row in m:
        current = []
        for start, end in _row_runs(row):
            node = len(parent)
            parent.append(node)
            current.append((node, start, end))
        for node, start, end in current:
            for pnode, pstart, pend in prev:
                if start <= pend and pstart <= end:
                    root, other = find(node), find(pnode)
                    if root != other:
                        parent[other] = root
        prev = current
    return len({find(node) for node in range(len(parent))})


def metrics_from_mask(mask):
    """布尔掩膜 → {foreground_px, coverage, n_components, bbox=[x0,y0,x1,y1]}（bbox 含端点）。"""
    m = _as_mask(mask)
    total = int(m.sum())
    if total == 0:
        return empty_metrics()
    height, width = m.shape
    ys, xs = np.nonzero(m)
    return {
        "foreground_px": total,
        "coverage": round(float(total) / float(height * width), 6),
        "n_components": n_components(m),
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
    }


def alpha_mask(rgba, alpha_min=ALPHA_MIN):
    """RGBA → 布尔掩膜：alpha > alpha_min（alpha_min=0.0 时"有任何不透明度"都算）。"""
    arr = np.asarray(rgba, dtype=np.float32)
    if arr.ndim != 3:
        raise ValueError("RGBA 必须是 (h, w, 4) 数组（收到维度 %d）" % arr.ndim)
    alpha = arr[..., 3] if arr.shape[2] >= 4 else np.ones(arr.shape[:2], dtype=np.float32)
    return alpha > float(alpha_min)


def ink_mask(rgba, ink_level=INK_LEVEL, alpha_min=0.0):
    """RGBA → 墨线掩膜：不透明且亮度 < ink_level（白底线稿/黑线都适用）。"""
    arr = np.asarray(rgba, dtype=np.float32)
    rgb = arr[..., :3]
    alpha = arr[..., 3] if arr.shape[2] >= 4 else np.ones(arr.shape[:2], dtype=np.float32)
    luma = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    return (alpha > float(alpha_min)) & (luma < float(ink_level))


def mask_for(name, rgba):
    """通道名 → 判定掩膜（alpha/render 用任意不透明度，mask 用实体阈值，ink 用墨线）。"""
    if name == "mask":
        return alpha_mask(rgba, ALPHA_MIN)
    if name == "ink":
        return ink_mask(rgba)
    return alpha_mask(rgba, 0.0)


def metrics_from_rgba(rgba, name):
    """通道名 + RGBA → 四项指标；未知通道返回 None（由调用方决定怎么报）。"""
    if name not in CHANNEL_NAMES:
        return None
    return metrics_from_mask(mask_for(name, rgba))


def ink_object_names(names):
    """从对象名里挑出 ink/outline/lineart/描边/墨线 的对象（保持输入顺序）。"""
    out = []
    for raw in names or []:
        name = str(raw)
        if _INK_PATTERN.search(name):
            out.append(name)
    return out


def channel_entry(name, path=None, mask=None, status="ok", reason=None):
    """一条通道回执：ok 带 path+metrics；skipped/error 只带 reason（不编造指标）。"""
    entry = {"name": str(name), "status": str(status)}
    if path:
        entry["path"] = str(path)
    if status == "ok" and mask is not None:
        entry["metrics"] = metrics_from_mask(mask)
    if reason:
        entry["reason"] = str(reason)
    return entry


def receipt(requested, images=None, ink_objects=None, frame=None):
    """把"请求的通道"与"真出图的通道"合成 CHANNELS 回执（顺序 = 请求顺序）。"""
    images = images or {}
    ink_objects = list(ink_objects or [])
    entries = []
    for raw in requested or []:
        name = str(raw)
        pair = images.get(name)
        if pair is not None:
            path, rgba = pair
            entries.append(channel_entry(name, path=path, mask=mask_for(name, rgba)))
            continue
        if name == "ink":
            reason = "no_ink_object" if not ink_objects else "ink_render_failed"
            entries.append(channel_entry(name, status="skipped", reason=reason))
        else:
            entries.append(channel_entry(name, status="error", reason="image_not_available"))
    return {"ok": True, "frame": frame, "channels": entries, "ink_objects": ink_objects}


# ---------------------------------------------------------------- 薄 bpy 包装（渲染作业收尾）


def _bpy():
    """延迟 import bpy：纯函数部分在无 Blender 环境（pytest）里也要可用。"""
    import bpy

    return bpy


def _scene():
    return _bpy().context.scene


def _channel_dir(spec):
    """通道图目录：spec.outdir → <outdir>/channels；没有就落在 .blend 旁边的 channels/。"""
    outdir = str(spec.get("outdir") or "").strip()
    if outdir:
        return os.path.join(outdir, "channels")
    blend = _bpy().data.filepath or ""
    base = os.path.dirname(os.path.abspath(blend)) if blend else os.getcwd()
    return os.path.join(base, "channels")


def _channel_path(channel_dir, name, frame):
    return os.path.join(channel_dir, "%s_%04d.png" % (name, int(frame)))


def _load_rgba(path):
    """PNG → (h, w, 4) float32，行序翻回"从上到下"（Blender 的 pixels 自下而上）。"""
    bpy = _bpy()
    image = bpy.data.images.load(path, check_existing=False)
    try:
        width, height = image.size
        if not width or not height:
            raise ValueError("图像尺寸为空：%s" % path)
        buf = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(buf)
        return np.ascontiguousarray(buf.reshape((height, width, 4))[::-1])
    finally:
        bpy.data.images.remove(image)


def _render_still(scene, path, transparent=None, freestyle=False):
    """按需临时改渲染设置渲一张，返回后原样还原（不把作业参数写进 .blend 语义）。"""
    render = scene.render
    keep = {
        "filepath": render.filepath,
        "format": render.image_settings.file_format,
        "color": render.image_settings.color_mode,
        "film": render.film_transparent,
        "freestyle": render.use_freestyle,
    }
    try:
        render.image_settings.file_format = "PNG"
        if transparent:
            render.film_transparent = True
            render.image_settings.color_mode = "RGBA"
        render.use_freestyle = bool(freestyle)
        render.filepath = path
        _bpy().ops.render.render(write_still=True)
    finally:
        render.filepath = keep["filepath"]
        render.image_settings.file_format = keep["format"]
        render.image_settings.color_mode = keep["color"]
        render.film_transparent = keep["film"]
        render.use_freestyle = keep["freestyle"]
    return path


def _beauty_path(scene, frame):
    """render 通道就是 -a 已经渲好的那一帧：用 Blender 自己的路径解析（含 #### 补零）。"""
    return _bpy().path.abspath(scene.render.frame_path(frame=int(frame)))


def _transparent_png(scene, channel_dir, frame):
    """alpha / mask 共用一张透明背景单帧（同一帧只渲一次）。"""
    path = _channel_path(channel_dir, "transparent", frame)
    return _render_still(scene, path, transparent=True, freestyle=False)


def _ink_objects(scene):
    try:
        names = [ob.name for ob in scene.objects]
    except Exception:
        names = []
    return ink_object_names(names)


def _hide_others(scene, ink_names):
    """只留 ink 对象参与渲染，返回 [(对象名, 原 hide_render)] 供还原。"""
    saved = []
    for ob in scene.objects:
        if ob.name in ink_names:
            continue
        saved.append((ob.name, bool(ob.hide_render)))
        ob.hide_render = True
    return saved


def _ink_png(scene, channel_dir, frame, ink_names):
    """ink 通道：只渲 ink 对象 + Freestyle 线稿（无 ink 对象时调用方直接 skipped）。"""
    path = _channel_path(channel_dir, "ink", frame)
    saved = _hide_others(scene, ink_names)
    try:
        return _render_still(scene, path, transparent=True, freestyle=True)
    finally:
        for name, hidden in saved:
            ob = scene.objects.get(name)
            if ob is not None:
                ob.hide_render = hidden


def _channel_image(scene, name, channel_dir, frame, ink_names, transparent_path):
    """按通道名出图 → (path, rgba)；出不了图就返回 None（回执里记 error/skipped）。"""
    if name == "render":
        path = _beauty_path(scene, frame)
    elif name in ("alpha", "mask"):
        path = transparent_path
    elif name == "ink":
        if not ink_names:
            return None
        path = _ink_png(scene, channel_dir, frame, ink_names)
    else:
        return None
    if not path or not os.path.exists(path):
        return None
    return path, _load_rgba(path)


def run_channels(spec=None):
    """渲染收尾入口：requested 通道逐个出图算指标，返回 CHANNELS 回执（JSON 可序列化）。"""
    spec = spec or {}
    requested = [str(name) for name in (spec.get("channels") or [])]
    scene = _scene()
    frame = int(getattr(scene, "frame_current", 1) or 1)
    channel_dir = _channel_dir(spec)
    os.makedirs(channel_dir, exist_ok=True)
    ink_names = _ink_objects(scene)
    transparent_path = None
    if any(name in ("alpha", "mask") for name in requested):
        transparent_path = _transparent_png(scene, channel_dir, frame)
    images = {}
    for name in requested:
        try:
            pair = _channel_image(scene, name, channel_dir, frame, ink_names, transparent_path)
        except Exception:
            pair = None
        if pair is not None:
            images[name] = pair
    out = receipt(requested, images, ink_names, frame)
    out["outdir"] = channel_dir
    return out