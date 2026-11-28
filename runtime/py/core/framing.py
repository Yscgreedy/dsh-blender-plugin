# -*- coding: utf-8 -*-
"""相机取景纯计算（T-4）：worker see 的 fit=object|scene|<对象名> 用它算机位。

为什么不复用 runtime/py/render/view.py 的 _fit_camera：那条路属于 GUI 通道，
同一个文件还带 bpy / 渲染 / 标定一整套；worker 是常驻无头进程，只需要
"点集 → 机位"这段数学。这里不 import bpy / mathutils，pytest 可直接跑；
bpy 侧（取世界角点、筛对象）留在 worker.py。

坐标约定与 view.py 的 fit 一致：
  - look_at = 包围盒中心
  - 相机在 center + direction * distance；direction 默认 (1, -1, 0.8) 归一化（右前上）
  - 透视：用包围球半径 / 最小半视角算距离，八个角点必落在 fov 内（margin 再放宽）
  - 正交：ortho_scale = 投影后宽高按 sensor_fit=AUTO 折算的最大边 × margin，
    显式 ortho_scale 优先
  - margin 默认 1.15；< 1 夹到 1（否则相机会落进包围盒）
"""

import math

DEFAULT_DIRECTION = (1.0, -1.0, 0.8)
DEFAULT_MARGIN = 1.15
DEFAULT_SENSOR_MM = 36.0
# 退化包围盒（单点 / 共面单线）按 1 单位立方体框，否则相机会贴在点上。
DEGENERATE_SPAN = 1.0
_EPS = 1e-9


def _vec3(value, label):
    """3 个有限数字 → tuple；其它一律 ValueError（不静默跳过，错的点会给出错的机位）。"""
    try:
        x, y, z = float(value[0]), float(value[1]), float(value[2])
    except (TypeError, ValueError, IndexError, KeyError):
        raise ValueError("%s 不是 3 个数字：%r" % (label, value))
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
        raise ValueError("%s 含非有限值：%r" % (label, value))
    return (x, y, z)


def _positive(value, label):
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s 不是数字：%r" % (label, value))
    if not math.isfinite(n) or n <= 0.0:
        raise ValueError("%s 必须 > 0：%r" % (label, value))
    return n


def _unit(value, label):
    n = math.sqrt(sum(c * c for c in value))
    if n < _EPS:
        raise ValueError("%s 不能是零向量：%r" % (label, value))
    return (value[0] / n, value[1] / n, value[2] / n)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def bbox_of_points(points):
    """world 点集 → ((minx, miny, minz), (maxx, maxy, maxz))；空输入 → None。

    接受任何可索引的 3 元组（含 mathutils.Vector）；坏点抛 ValueError。
    """
    if not points:
        return None
    lo = None
    hi = None
    for p in points:
        x, y, z = _vec3(p, "point")
        if lo is None:
            lo, hi = [x, y, z], [x, y, z]
            continue
        for i, v in enumerate((x, y, z)):
            if v < lo[i]:
                lo[i] = v
            if v > hi[i]:
                hi[i] = v
    return (tuple(lo), tuple(hi))


def _half_fovs(aspect, lens_mm, sensor_mm):
    """Blender sensor_fit=AUTO：大边吃满 sensor，另一边按 aspect 收窄。"""
    base = sensor_mm / (2.0 * lens_mm)
    if aspect >= 1.0:
        tan_h, tan_v = base, base / aspect
    else:
        tan_v, tan_h = base, base * aspect
    return math.atan(tan_h), math.atan(tan_v)


def fit_view(bbox_min, bbox_max, aspect, lens_mm, margin=DEFAULT_MARGIN,
             ortho=False, ortho_scale=None, sensor_mm=DEFAULT_SENSOR_MM,
             direction=DEFAULT_DIRECTION):
    """按世界包围盒算机位：{"from": [x, y, z], "look_at": [x, y, z], "ortho_scale"?: float}。

    bbox_min / bbox_max 顺序无所谓（按轴归一化）；两值相等（单点）按 1 单位立方体处理。
    ortho=True 或显式给 ortho_scale 时回执带 ortho_scale（显式值优先）。
    """
    first = _vec3(bbox_min, "bbox_min")
    second = _vec3(bbox_max, "bbox_max")
    lo = tuple(min(first[i], second[i]) for i in range(3))
    hi = tuple(max(first[i], second[i]) for i in range(3))
    aspect = _positive(aspect, "aspect")
    lens_mm = _positive(lens_mm, "lens_mm")
    sensor_mm = _positive(sensor_mm, "sensor_mm")
    margin = _positive(margin, "margin")
    if margin < 1.0:
        margin = 1.0
    if ortho_scale is not None:
        ortho_scale = _positive(ortho_scale, "ortho_scale")

    center = tuple((lo[i] + hi[i]) * 0.5 for i in range(3))
    span = [hi[i] - lo[i] for i in range(3)]
    if max(span) < _EPS:
        span = [DEGENERATE_SPAN] * 3
    lo = tuple(center[i] - span[i] * 0.5 for i in range(3))
    hi = tuple(center[i] + span[i] * 0.5 for i in range(3))

    view_dir = _unit(_vec3(direction, "direction"), "direction")
    forward = (-view_dir[0], -view_dir[1], -view_dir[2])
    right = _cross(forward, (0.0, 0.0, 1.0))
    if math.sqrt(sum(c * c for c in right)) < 1e-6:
        right = (1.0, 0.0, 0.0)
    right = _unit(right, "right")
    true_up = _unit(_cross(right, forward), "up")

    corners = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    xs = [_dot((c[0] - center[0], c[1] - center[1], c[2] - center[2]), right) for c in corners]
    ys = [_dot((c[0] - center[0], c[1] - center[1], c[2] - center[2]), true_up) for c in corners]
    zs = [_dot((c[0] - center[0], c[1] - center[1], c[2] - center[2]), forward) for c in corners]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    depth = max(zs) - min(zs)

    scale_value = None
    if ortho or ortho_scale is not None:
        if aspect >= 1.0:
            need = max(width, height * aspect)
        else:
            need = max(height, width / aspect)
        scale = ortho_scale if ortho_scale is not None else need * margin
        # 正交不看 fov，但机位仍要在盒外：按投影深度 + 最大边给余量（与 view.py 同源）。
        dist = max(0.001, depth * 1.5 + max(width, height) * 2.0)
        scale_value = round(max(0.001, scale), 6)
    else:
        # 包围球半径 = 半对角线；距离 = 半径*margin / sin(最小半视角)，
        # 于是每个角点到视轴的夹角都 < 最小半视角（margin 只会更宽松）。
        radius = 0.5 * math.sqrt(sum(s * s for s in span))
        half_h, half_v = _half_fovs(aspect, lens_mm, sensor_mm)
        half_min = min(half_h, half_v)
        dist = max(0.001, (radius * margin) / math.sin(half_min))
    out = {"from": [round(center[i] + view_dir[i] * dist, 6) for i in range(3)],
           "look_at": [round(v, 6) for v in center]}
    if scale_value is not None:
        out["ortho_scale"] = scale_value
    return out
