# -*- coding: utf-8 -*-
"""ref_* 原语的纯计算核心（C-1）：不 import bpy / numpy，pytest 可直接跑。

为什么单独拆：三条原语的规则（px→m 标定、误差随距离累积、原生裁剪合法性、
可读性阈值）都是纯数学；读图/落盘在 ref_ops.py（bpy + numpy），只能在真机验。
这里只吃数字，进 dict —— 于是单测能覆盖正常/边界/坏输入。

口径来自 docs/证据分级与读图纪律.md §7.2/§7.3/§7.4：
  - px_per_m = 已知长度的像素长度 / 已知长度（原生像素，不缩放）
  - err_m 随「离标定线的像素距离」线性累积：d_px * known_len_m / px_len
  - 原生裁剪 **不缩放**，scale 恒 1.0，换算尺寸只在有 px_per_m 时给
  - 可读性：特征在图上 < min_px 像素 ⇒ 不可读（不许猜）
"""

import hashlib
import math

MIN_READABLE_PX = 8
DEFAULT_AXIS = "X"
AXES = ("X", "Y")


def md5_of_file(path):
    """源图 md5（provenance：源图更新后旧尺寸表要判失效）。"""
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _positive(value, label):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s 必须是数字：%r" % (label, value))
    if not math.isfinite(number) or number <= 0:
        raise ValueError("%s 必须 > 0：%r" % (label, value))
    return number


def _size(native_px):
    try:
        width, height = int(native_px[0]), int(native_px[1])
    except (TypeError, ValueError, IndexError, KeyError):
        raise ValueError("native_px 必须是 [width, height]：%r" % (native_px,))
    if width <= 0 or height <= 0:
        raise ValueError("native_px 必须是正数：%r" % (native_px,))
    return width, height


def _point(value, label):
    try:
        x, y = float(value[0]), float(value[1])
    except (TypeError, ValueError, IndexError, KeyError):
        raise ValueError("%s 必须是 [x, y]：%r" % (label, value))
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError("%s 含非有限值：%r" % (label, value))
    return x, y


def _axis(value):
    axis = str(value or DEFAULT_AXIS).strip().upper()
    if axis not in AXES:
        raise ValueError("axis 只能是 X|Y：%r" % (value,))
    return axis


def _station_row(item, anchor, px_per_m, err_per_px, axis, index):
    if not isinstance(item, dict):
        raise ValueError("第 %d 个 station 不是 dict：%r" % (index + 1, item))
    name = str(item.get("name") or "s%d" % (index + 1)).strip()
    pos = None
    for key in ("px_x", "px_y", "px"):
        if item.get(key) is not None:
            pos = item.get(key)
            break
    if pos is None:
        raise ValueError("station %s 缺位置（px_x / px_y / px）" % name)
    try:
        pos = float(pos)
    except (TypeError, ValueError):
        raise ValueError("station %s 的位置不是数字：%r" % (name, pos))
    if not math.isfinite(pos):
        raise ValueError("station %s 的位置非有限：%r" % (name, pos))
    delta = pos - anchor
    return {
        "name": name,
        "px_x": round(pos, 3),
        "metres": round(delta / px_per_m, 6),
        "err_m": round(abs(delta) * err_per_px, 6),
        "axis": axis,
        "confidence": "近似",
    }


def measure_plan(native_px, p1, p2, known_len_m, stations=None, axis=DEFAULT_AXIS):
    """量一条已知长度 → px_per_m + 站位表（纯数字；不读图）。

    stations=None 时给标定两端点（metres=0 / known_len_m，err 0）；
    给了 stations 就按离 p1 的像素距离换算，err_m 随距离线性累积。
    """
    width, height = _size(native_px)
    x1, y1 = _point(p1, "p1")
    x2, y2 = _point(p2, "p2")
    for label, (x, y) in (("p1", (x1, y1)), ("p2", (x2, y2))):
        if not (0 <= x <= width and 0 <= y <= height):
            raise ValueError("%s 超出图像 %dx%d：(%g, %g)" % (label, width, height, x, y))
    known = _positive(known_len_m, "known_len_m")
    px_len = math.hypot(x2 - x1, y2 - y1)
    if px_len < 1e-6:
        raise ValueError("p1 与 p2 重合，量不出像素长度")
    axis_name = _axis(axis)
    px_per_m = px_len / known
    err_per_px = known / px_len
    if stations is None:
        first = x1 if axis_name == "X" else y1
        second = x2 if axis_name == "X" else y2
        rows = [
            {"name": "p1", "px_x": round(first, 3), "metres": 0.0, "err_m": 0.0,
             "axis": axis_name, "confidence": "标定"},
            {"name": "p2", "px_x": round(second, 3), "metres": round(known, 6), "err_m": 0.0,
             "axis": axis_name, "confidence": "标定"},
        ]
    else:
        if not isinstance(stations, (list, tuple)) or not stations:
            raise ValueError("stations 必须是非空列表：[{name, px_x}]")
        anchor = x1 if axis_name == "X" else y1
        rows = [_station_row(item, anchor, px_per_m, err_per_px, axis_name, i)
                for i, item in enumerate(stations)]
    return {
        "ok": True,
        "axis": axis_name,
        "known_len_m": known,
        "px": round(px_len, 4),
        "px_per_m": round(px_per_m, 6),
        "err_m_per_px": round(err_per_px, 8),
        "err_m_at_300px": round(300.0 * err_per_px, 6),
        "native_px": [width, height],
        "stations": rows,
    }


def _crop_name(value, index, seen):
    name = str(value or "").strip()
    if not name:
        raise ValueError("第 %d 个 crop 缺 name" % (index + 1))
    if name in seen:
        raise ValueError("crop 名字重复：%s" % name)
    if "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("crop name 不能带路径分隔符：%r" % name)
    return name


def _crop_box(box, name, width, height):
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("crop %s 的 box_px 必须是 [x0, y0, x1, y1]：%r" % (name, box))
    try:
        x0, y0, x1, y1 = [int(round(float(v))) for v in box]
    except (TypeError, ValueError):
        raise ValueError("crop %s 的 box_px 含非数字：%r" % (name, box))
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError("crop %s 的 box_px 越界或反向：%r（图 %dx%d）" % (name, list(box), width, height))
    return [x0, y0, x1, y1]


def crop_plan(native_px, crops, px_per_m=None):
    """裁剪清单校验 + 每块的像素/毫米尺寸（**不缩放**，scale 恒 1.0）。"""
    width, height = _size(native_px)
    if not isinstance(crops, (list, tuple)) or not crops:
        raise ValueError("crops 必须是非空列表：[{name, box_px}]")
    ppm = _positive(px_per_m, "px_per_m") if px_per_m is not None else None
    rows = []
    seen = set()
    for index, item in enumerate(crops):
        if not isinstance(item, dict):
            raise ValueError("第 %d 个 crop 不是 dict：%r" % (index + 1, item))
        name = _crop_name(item.get("name"), index, seen)
        box = _crop_box(item.get("box_px"), name, width, height)
        row = {"name": name, "box_px": box, "px": [box[2] - box[0], box[3] - box[1]],
               "scale": 1.0, "source_px": [width, height]}
        if item.get("size_m") is not None:
            row["size_m"] = round(_positive(item.get("size_m"), "size_m"), 6)
        if ppm is not None:
            row["mm"] = [round((box[2] - box[0]) / ppm * 1000.0, 3),
                         round((box[3] - box[1]) / ppm * 1000.0, 3)]
        rows.append(row)
        seen.add(name)
    return rows


def readability_rows(features, px_per_m=None, min_px=MIN_READABLE_PX):
    """特征在图上 < min_px 像素 ⇒ unreadable（米制特征需要 px_per_m）。"""
    threshold = _positive(min_px, "min_px")
    if not isinstance(features, (list, tuple)) or not features:
        raise ValueError("features 必须是非空列表：[{name, m}] 或 [{name, px}]")
    ppm = _positive(px_per_m, "px_per_m") if px_per_m is not None else None
    rows = []
    for index, item in enumerate(features):
        if not isinstance(item, dict):
            raise ValueError("第 %d 个 feature 不是 dict：%r" % (index + 1, item))
        name = str(item.get("name") or item.get("feature") or "").strip()
        if not name:
            raise ValueError("第 %d 个 feature 缺 name" % (index + 1))
        px = item.get("px")
        if px is None:
            px = item.get("size_px")
        size_m = item.get("m", item.get("size_m"))
        if px is None:
            if size_m is None or ppm is None:
                raise ValueError("feature %s 既没有 px，也没有 m + px_per_m" % name)
            px = float(size_m) * ppm
        try:
            px = float(px)
        except (TypeError, ValueError):
            raise ValueError("feature %s 的 px 不是数字：%r" % (name, px))
        if not math.isfinite(px) or px < 0:
            raise ValueError("feature %s 的 px 非法：%r" % (name, px))
        readable = px + 1e-9 >= threshold
        rows.append({
            "feature": name,
            "px": round(px, 2),
            "verdict": "readable" if readable else "unreadable",
            "why": "size %.2f px %s %.1f px" % (px, ">=" if readable else "<", threshold),
        })
    unreadable = [row for row in rows if row["verdict"] == "unreadable"]
    return {
        "ok": True,
        "min_px": threshold,
        "rows": rows,
        "unreadable": unreadable,
        "readable_count": len(rows) - len(unreadable),
        "unreadable_count": len(unreadable),
    }


def atlas_manifest(source, native_px, md5, crops_rows, px_per_m=None):
    """atlas.json 的骨架：源图 / md5 / 原生尺寸 / px-m / 每块裁剪框与像素尺寸。"""
    width, height = _size(native_px)
    if not isinstance(crops_rows, (list, tuple)):
        raise ValueError("crops_rows 必须是列表")
    ppm = _positive(px_per_m, "px_per_m") if px_per_m is not None else None
    digest = str(md5 or "").strip()
    if not digest:
        raise ValueError("md5 不能为空（provenance 必需）")
    rows = []
    for row in crops_rows:
        if not isinstance(row, dict):
            raise ValueError("crops_rows 的条目必须是 dict：%r" % (row,))
        rows.append(dict(row))
    return {
        "version": 1,
        "source": str(source),
        "md5": digest,
        "native_px": [width, height],
        "px_per_m": round(ppm, 6) if ppm is not None else None,
        "units": "m",
        "count": len(rows),
        "crops": rows,
    }


def grid_lines(native_px, px_per_m, step_m):
    """网格线像素位置（画 out_grid_png 用）；step_m 是米，返回 (xs, ys)。"""
    width, height = _size(native_px)
    ppm = _positive(px_per_m, "px_per_m")
    step_px = _positive(step_m, "step_m") * ppm
    if step_px < 1.0:
        # 亚像素网格等于把图涂满，还白烧 CPU：直接拒绝，让调用方放大步长。
        raise ValueError("网格步长换算后 <1 px（step_m=%.6g, px_per_m=%.6g）" % (step_m, ppm))
    xs, ys = [], []
    pos = 0.0
    while pos <= width:
        xs.append(int(round(pos)))
        pos += step_px
    pos = 0.0
    while pos <= height:
        ys.append(int(round(pos)))
        pos += step_px
    return xs, ys


def self_check():
    """无图自检：三条原语的规则在合成数字上都成立（ref_selftest 用）。"""
    checks = []

    def check(name, fn):
        try:
            fn()
            checks.append({"name": name, "ok": True})
        except Exception as error:  # noqa: BLE001 - 自检要把失败原因带进回执
            checks.append({"name": name, "ok": False, "error": "%s: %s" % (type(error).__name__, error)})

    def measure_ok():
        plan = measure_plan([1000, 500], [0, 0], [100, 0], 2.0)
        assert abs(plan["px_per_m"] - 50.0) < 1e-9, plan["px_per_m"]
        assert abs(plan["err_m_per_px"] - 0.02) < 1e-9
        assert abs(plan["err_m_at_300px"] - 6.0) < 1e-9

    def stations_ok():
        plan = measure_plan([1000, 500], [0, 0], [100, 0], 2.0,
                            stations=[{"name": "tip", "px_x": 150}])
        row = plan["stations"][0]
        assert abs(row["metres"] - 3.0) < 1e-6, row
        assert abs(row["err_m"] - 3.0) < 1e-6, row

    def crop_ok():
        rows = crop_plan([100, 100], [{"name": "a", "box_px": [10, 20, 40, 60]}], px_per_m=50.0)
        assert rows[0]["px"] == [30, 40]
        assert rows[0]["scale"] == 1.0
        assert abs(rows[0]["mm"][0] - 600.0) < 1e-6, rows[0]["mm"]

    def readability_ok():
        result = readability_rows([{"name": "seam", "m": 0.10}, {"name": "bolt", "m": 0.20}],
                                  px_per_m=55.0)
        verdicts = {row["feature"]: row["verdict"] for row in result["rows"]}
        assert verdicts == {"seam": "unreadable", "bolt": "readable"}, verdicts

    def rejects_bad():
        for fn in (
            lambda: measure_plan([10, 10], [0, 0], [0, 0], 1.0),
            lambda: crop_plan([10, 10], [{"name": "a", "box_px": [0, 0, 20, 20]}]),
            lambda: readability_rows([{"name": "a", "m": 0.1}]),
        ):
            try:
                fn()
            except ValueError:
                continue
            raise AssertionError("坏输入没有被拒绝")

    check("measure", measure_ok)
    check("stations", stations_ok)
    check("crop_plan", crop_ok)
    check("readability", readability_ok)
    check("reject_bad_input", rejects_bad)
    return checks
