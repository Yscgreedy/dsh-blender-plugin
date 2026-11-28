# -*- coding: utf-8 -*-
"""ref_* 原语（C-1）的 bpy/numpy IO 包装；规则全在 ref_core.py。

三条原语（docs/证据分级与读图纪律.md §7.4）：
  ref_measure(image, p1, p2, known_len_m, out_grid_png, stations=[], axis="X")
      → {px_per_m, stations:[{px_x, metres, err_m}], grid_png, md5, native_px}
  ref_crop_atlas(image, crops=[{name, box_px, size_m?}], outdir, px_per_m=None)
      → 原生**不缩放**裁剪 + atlas.json（源图 / 裁剪框 / px-m / 换算尺寸 / md5）
  ref_readability(atlas_json, min_px=8, features=[], px_per_m=None)
      → 列出图上不可读的特征（< min_px 像素）

这里只做读图/落盘/画图；像素口径与坏输入判定在 ref_core（纯 stdlib，单测覆盖）。
"""
from .common import *  # noqa: F401,F403
from . import ref_core

REF_VERSION = 1


def _fail(error):
    return _j({"ok": False, "error": str(error)[:400]})


def _line(arr, x0, y0, x1, y1, color):
    """Bresenham 画线（原生像素坐标，左上原点）。"""
    height, width = int(arr.shape[0]), int(arr.shape[1])
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    steps = max(abs(x1 - x0), abs(y1 - y0), 1)
    for i in range(steps + 1):
        x = int(round(x0 + (x1 - x0) * i / steps))
        y = int(round(y0 + (y1 - y0) * i / steps))
        if 0 <= x < width and 0 <= y < height:
            arr[y, x, :] = color


def _cross(arr, x, y, color, arm=4):
    _line(arr, x - arm, y, x + arm, y, color)
    _line(arr, x, y - arm, x, y + arm, color)


def _draw_overlay(arr, plan, p1, p2, grid_step_m=None):
    """在原生图上画：网格 + 标定线（红）+ 端点/站位十字（黄）。返回新数组。"""
    out = np.array(arr, dtype=np.float32, copy=True)
    height, width = int(out.shape[0]), int(out.shape[1])
    px_per_m = float(plan["px_per_m"])
    known = float(plan["known_len_m"])
    step = float(grid_step_m) if grid_step_m else max(known / 4.0, 1e-6)
    xs, ys = ref_core.grid_lines([width, height], px_per_m, step)
    grid_color = np.array([0.20, 0.85, 1.00, 1.00], dtype=np.float32)
    for x in xs:
        _line(out, x, 0, x, height - 1, grid_color)
    for y in ys:
        _line(out, 0, y, width - 1, y, grid_color)
    _line(out, p1[0], p1[1], p2[0], p2[1], np.array([1.0, 0.15, 0.15, 1.0], dtype=np.float32))
    marker = np.array([1.0, 0.95, 0.10, 1.0], dtype=np.float32)
    _cross(out, p1[0], p1[1], marker)
    _cross(out, p2[0], p2[1], marker)
    for row in plan["stations"]:
        pos = row.get("px_x")
        if pos is None:
            continue
        if plan["axis"] == "Y":
            _cross(out, p1[0], float(pos), marker)
        else:
            _cross(out, float(pos), p1[1], marker)
    return out


def _stations_arg(stations):
    if stations is None:
        return None
    if isinstance(stations, dict):
        return [stations]
    return stations


def ref_measure(image=None, p1=None, p2=None, known_len_m=None, out_grid_png=None,
                stations=None, axis="X", grid_step_m=None):
    """量已知长度 → px_per_m + 站位表；可选把标定线/网格画回图（out_grid_png）。"""
    try:
        if not image:
            raise ValueError("image 必填（源图路径）")
        arr, path, native, _loaded = _load_ex(image)
        plan = ref_core.measure_plan(native, p1, p2, known_len_m,
                                     stations=_stations_arg(stations), axis=axis)
        result = dict(plan)
        result.update({"image": path, "md5": ref_core.md5_of_file(path), "native_px": native,
                       "ref_version": REF_VERSION})
    except Exception as error:  # noqa: BLE001 - 坏输入走回执，不抛给调度层
        return _fail("%s: %s" % (type(error).__name__, error))
    if out_grid_png:
        try:
            overlay = _draw_overlay(arr, plan, [float(p1[0]), float(p1[1])],
                                    [float(p2[0]), float(p2[1])], grid_step_m)
            result["grid_png"] = _save(overlay, out_grid_png)
        except Exception as error:  # noqa: BLE001 - 画不出来不影响数字
            result["grid_png"] = None
            result["grid_error"] = "%s: %s" % (type(error).__name__, str(error)[:200])
    return _j(result)


def ref_crop_atlas(image=None, crops=None, outdir=None, px_per_m=None):
    """批量原生（**不缩放**）裁剪 + atlas.json；每块带裁剪框/像素/换算尺寸。"""
    try:
        if not image:
            raise ValueError("image 必填（源图路径）")
        if not outdir:
            raise ValueError("outdir 必填（裁剪图与 atlas.json 的落盘目录）")
        arr, path, native, _loaded = _load_ex(image)
        rows = ref_core.crop_plan(native, crops, px_per_m=px_per_m)
        target = _win(outdir)
        os.makedirs(target, exist_ok=True)
        saved = []
        for row in rows:
            x0, y0, x1, y1 = row["box_px"]
            tile = np.array(arr[y0:y1, x0:x1, :], dtype=np.float32, copy=True)
            item = dict(row)
            item["path"] = _save(tile, os.path.join(target, row["name"] + ".png"))
            item["source"] = path
            saved.append(item)
        manifest = ref_core.atlas_manifest(path, native, ref_core.md5_of_file(path), saved,
                                           px_per_m=px_per_m)
        atlas_path = os.path.join(target, "atlas.json")
        with open(atlas_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
    except Exception as error:  # noqa: BLE001
        return _fail("%s: %s" % (type(error).__name__, error))
    return _j({"ok": True, "ref_version": REF_VERSION, "atlas_json": atlas_path,
               "source": path, "md5": manifest["md5"], "native_px": manifest["native_px"],
               "px_per_m": manifest["px_per_m"], "count": manifest["count"], "crops": saved})


def _atlas_features(atlas):
    rows = atlas.get("features")
    if isinstance(rows, (list, tuple)) and rows:
        return list(rows)
    crops = atlas.get("crops")
    if not isinstance(crops, (list, tuple)):
        return []
    return [{"name": row.get("name"), "m": row.get("size_m")}
            for row in crops
            if isinstance(row, dict) and row.get("size_m") is not None]


def ref_readability(atlas_json=None, min_px=ref_core.MIN_READABLE_PX, features=None,
                    px_per_m=None):
    """按 atlas.json 的 px_per_m（或显式 features）列出 < min_px 的不可读特征。"""
    atlas = {}
    atlas_path = ""
    try:
        if atlas_json:
            atlas_path = _win(atlas_json)
            if not os.path.exists(atlas_path):
                raise ValueError("atlas_json 不存在：%s" % atlas_path)
            with open(atlas_path, encoding="utf-8") as handle:
                atlas = json.load(handle)
        ppm = px_per_m if px_per_m is not None else atlas.get("px_per_m")
        items = features if features is not None else _atlas_features(atlas)
        if not items:
            raise ValueError("没有可判的特征：给 features=[{name, m}]，或让 atlas.json 带 features / size_m")
        result = ref_core.readability_rows(items, px_per_m=ppm, min_px=min_px)
    except Exception as error:  # noqa: BLE001
        return _fail("%s: %s" % (type(error).__name__, error))
    result.update({"atlas_json": atlas_path or None,
                   "source": atlas.get("source"),
                   "md5": atlas.get("md5"),
                   "px_per_m": round(float(ppm), 6) if ppm else None,
                   "ref_version": REF_VERSION})
    return _j(result)


def ref_help():
    """ref_* 的用法（模型面 blender_op op=ref_help）。"""
    return _j({
        "ok": True, "ref_version": REF_VERSION,
        "ops": {
            "ref_measure": "ref_measure(image, p1, p2, known_len_m, out_grid_png=None, "
                           "stations=[{name, px_x}], axis='X')"
                           " → px_per_m / err_m_per_px / stations[{px_x, metres, err_m}] / grid_png",
            "ref_crop_atlas": "ref_crop_atlas(image, crops=[{name, box_px, size_m?}], outdir, px_per_m=None)"
                              " → 原生不缩放裁剪 + atlas.json（source/md5/native_px/px_per_m/crops）",
            "ref_readability": "ref_readability(atlas_json, min_px=8, features=[{name, m}], px_per_m=None)"
                               " → rows[{feature, px, verdict}] · unreadable[]",
            "ref_selftest": "无图自检：三条原语的规则在合成数字上是否成立",
        },
        "protocol": [
            "量测在原生分辨率图上做；只有给模型看的图才缩放",
            "每条尺寸带 provenance（源图 + md5 + 原生尺寸）与 err_m；没有 err_m 的站位表不许进契约",
            "< 0.3 m 的特征必须有原生裁剪（scale=1.0）；< 8 px 的特征一律判不可读，不许猜",
        ],
        "hint": "先 ref_measure 标定 px_per_m，再 ref_crop_atlas 裁 ROI，最后 ref_readability 复核可读性",
    })


def ref_selftest():
    """无图自检（合成数字）：三条原语的规则与坏输入拒绝。"""
    checks = ref_core.self_check()
    ok = all(bool(item.get("ok")) for item in checks)
    return _j({"ok": ok, "ref_version": REF_VERSION, "checks": checks})
