# -*- coding: utf-8 -*-
"""资产搜索与导入（v3.2.0）—— 把「搜得到、用不上」的外部资产接进 op 面。

背景：v3.1 有意从 addon 命令面删掉了全部写命令（下载/导入/生成提交），
所以模型今天只能自己写 blender_py 脚本去请求 API、解包、导入。同一个错误
每会话重写一遍。这里把 **PolyHaven（免 key）** 的搜索与导入做成契约族，
其余资产源保持 blender_py 路径（见 skills/blender-modeling/references/资产与生成.md）。

API 挂 K.dsh_asset_api：

    asset_search(source="polyhaven", query="chair", limit=12)
      → {"ok":true, "source":"polyhaven", "count":n, "rows":[{id,name,categories,download_count,thumb}]}

    asset_fetch(source="polyhaven", id="modern_arm_chair_01", resolution="1k",
                name_prefix="PH", collection="assets", normalize=False)
      → {"ok":true, "imported":["PH_01"], "tris":n, "bbox":[x,y,z], "dir":"…", "notes":[…],
         "next":"blender_op(op=\"audit_mesh\", args={objects:[…]})"}

边界：
  - 只做 PolyHaven；Sketchfab / Poly Pizza 需要各自 API key，仍走 blender_py 模板。
  - 不做「替换已有对象」「自动材质修复」「自动 UV」——导入只保证命名、归集合与可复检。
  - 网络失败不静默：返回 ok:false + code（network_policy / not_found / format_unavailable）。
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request

ASSET_VERSION = 1
POLYHAVEN_API = "https://api.polyhaven.com"
USER_AGENT = "dsh-blender-plugin/3.2 (+https://github.com/sixtysevenlf/dsh-blender-plugin)"
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MODEL_FORMAT_ORDER = ("gltf", "glb")
TIMEOUT_API = 30
TIMEOUT_FILE = 120

_K = sys.modules.get("dsh_rt_kernel")
_KIT = getattr(_K, "dsh_kit", None) if _K is not None else None


def _j(x):
    return json.dumps(x, ensure_ascii=False)


def _err(msg, code="asset_error", **kw):
    out = {"ok": False, "error": msg, "code": code}
    out.update(kw)
    return _j(out)


def _bpy():
    import bpy  # 延迟导入：pytest 用 bpy_stub，模块本身保持可导入
    return bpy


def online_access():
    """Blender 的联网总开关；老版本没有该属性时按允许处理。"""
    try:
        value = getattr(_bpy().app, "online_access", None)
    except Exception:
        return True
    return True if value is None else bool(value)


def _http_get(url, timeout=TIMEOUT_API):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _http_json(url, timeout=TIMEOUT_API):
    return json.loads(_http_get(url, timeout).decode("utf-8"))


def _download(url, dest, timeout=TIMEOUT_FILE):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    digest = hashlib.md5()
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            fh.write(chunk)
    return digest.hexdigest()


def _clamp(value, low, high, default):
    try:
        n = int(value)
    except Exception:
        return default
    return max(low, min(high, n))


def _safe_join(root, relative):
    """把 API 给的相对路径落进 root；拒绝 .. 与绝对路径。"""
    rel = str(relative or "").replace("\\", "/").lstrip("/")
    target = os.path.abspath(os.path.join(root, rel))
    if not target.startswith(os.path.abspath(root) + os.sep):
        raise ValueError("拒绝越界路径: %r" % relative)
    return target


def _search_rows(payload, query, limit):
    """PolyHaven /assets 映射 → 统一行；query 做小写子串匹配（id/name/分类/标签）。"""
    needle = (query or "").strip().lower()
    rows = []
    for asset_id, info in (payload or {}).items():
        if not isinstance(info, dict):
            continue
        name = str(info.get("name") or asset_id)
        hay = " ".join([
            asset_id,
            name,
            " ".join(info.get("categories") or []),
            " ".join(info.get("tags") or []),
        ]).lower()
        if needle and needle not in hay:
            continue
        thumb = info.get("thumbnail_url")
        if isinstance(thumb, dict):
            thumb = thumb.get("url")
        rows.append({
            "id": asset_id,
            "name": name,
            "categories": list(info.get("categories") or []),
            "download_count": int(info.get("download_count") or 0),
            "thumb": thumb,
        })
    rows.sort(key=lambda row: row["download_count"], reverse=True)
    return rows[:limit]


def _pick_model_files(files_data, resolution, file_format=None):
    """从 /files 映射里挑出 (format, resolution, main_record, includes)。

    结构是 files_data[format][resolution][format] = {"url":…, "md5":…}，
    glTF 还带 include（贴图）映射，必须一起落盘，否则导入后材质全灰。
    """
    formats = [str(file_format).lower()] if file_format else list(MODEL_FORMAT_ORDER)
    available = []
    for fmt in formats:
        per_res = (files_data or {}).get(fmt) or {}
        available.extend(sorted(per_res.keys()))
        entry = (per_res.get(str(resolution)) or {})
        record = entry.get(fmt) if isinstance(entry, dict) else None
        if not isinstance(record, dict):
            continue
        includes = {}
        if isinstance(record.get("include"), dict):
            includes = record["include"]
            record = record.get("gltf") or record.get("glb") or record
        url = record.get("url") if isinstance(record, dict) else None
        if not url:
            continue
        return {"format": fmt, "resolution": str(resolution), "record": record, "includes": includes}
    return {"unsupported": True, "allowed_resolutions": sorted(set(available))}


def _fetch_model(files_data, resolution, file_format):
    picked = _pick_model_files(files_data, resolution, file_format)
    if picked.get("unsupported"):
        raise ValueError(
            "该资产没有 %s 的 %s（可用分辨率：%s）"
            % (resolution, file_format or "/".join(MODEL_FORMAT_ORDER),
               ", ".join(picked["allowed_resolutions"]) or "无")
        )
    work = tempfile.mkdtemp(prefix="dsh_asset_")
    main_path = _safe_join(work, "model." + ("glb" if picked["format"] == "glb" else "gltf"))
    _download(picked["record"]["url"], main_path)
    for rel, record in (picked["includes"] or {}).items():
        if isinstance(record, dict) and record.get("url"):
            _download(record["url"], _safe_join(work, rel))
    return work, main_path


def _name_objects(before, prefix):
    bpy = _bpy()
    added = [ob for ob in bpy.data.objects if ob.name not in before]
    base = str(prefix or "ASSET")
    for index, ob in enumerate(added, start=1):
        try:
            ob.name = "%s_%02d" % (base, index)
        except Exception:
            pass
    return added


def _link(added, collection):
    if not collection:
        return None
    bpy = _bpy()
    target = bpy.data.collections.get(str(collection))
    if target is None:
        target = bpy.data.collections.new(str(collection))
        bpy.context.scene.collection.children.link(target)
    for ob in added:
        try:
            if ob.name not in target.objects:
                target.objects.link(ob)
        except Exception:
            pass
    return target.name


def _triangles(added):
    total = 0
    for ob in added:
        if getattr(ob, "type", "") != "MESH":
            continue
        mesh = getattr(ob, "data", None)
        polys = getattr(mesh, "polygons", None) or []
        for poly in polys:
            total += max(1, len(getattr(poly, "vertices", []) or []) - 2)
    return total


def _bbox(added):
    bpy = _bpy()
    try:
        from mathutils import Vector  # noqa: F401
    except Exception:
        pass
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for ob in added:
        if getattr(ob, "type", "") != "MESH":
            continue
        for corner in getattr(ob, "bound_box", []) or []:
            world = ob.matrix_world @ _vec(corner)
            for i in range(3):
                lo[i] = min(lo[i], world[i])
                hi[i] = max(hi[i], world[i])
    if lo[0] == float("inf"):
        return None
    return [round(hi[i] - lo[i], 4) for i in range(3)]


def _vec(values):
    bpy = _bpy()
    try:
        from mathutils import Vector
        return Vector(values)
    except Exception:
        _ = bpy
        return tuple(values)


def asset_search(source="polyhaven", query="", limit=12, asset_type="models"):
    """搜资产：目前只接 PolyHaven（免 key）。"""
    src = str(source or "polyhaven").lower()
    if src != "polyhaven":
        return _err(
            "暂不支持 source=%r" % source,
            code="source_unsupported",
            supported=["polyhaven"],
            hint="Sketchfab / Poly Pizza 需要各自 API key：用 blender_py，模板见 "
                 "skills/blender-modeling/references/资产与生成.md",
        )
    if not online_access():
        return _err("Blender 联网总开关关闭", code="network_policy",
                    fix="偏好 ▸ 系统 ▸ 网络 ▸ 允许联网（或 bpy.app.online_access=True）后重试")
    kind = str(asset_type or "models").lower()
    if kind not in ("models", "textures", "hdris"):
        return _err("asset_type 只接受 models / textures / hdris", code="bad_params", given=asset_type)
    url = "%s/assets?t=%s" % (POLYHAVEN_API, urllib.parse.quote(kind))
    try:
        payload = _http_json(url)
    except Exception as e:
        return _err("PolyHaven 检索失败：%s: %s" % (type(e).__name__, str(e)[:160]), code="network_error")
    rows = _search_rows(payload, query, _clamp(limit, 1, 50, 12))
    return _j({"ok": True, "source": "polyhaven", "asset_type": kind,
               "query": str(query or ""), "count": len(rows), "rows": rows})


def asset_fetch(source="polyhaven", id=None, asset_type="models", resolution="1k",
                file_format=None, name_prefix=None, collection="assets"):
    """下载并导入一个资产；返回新增对象与可复检提示。"""
    src = str(source or "polyhaven").lower()
    if src != "polyhaven":
        return _err("暂不支持 source=%r" % source, code="source_unsupported", supported=["polyhaven"],
                    hint="Sketchfab / Poly Pizza 用 blender_py 模板（references/资产与生成.md）")
    if not online_access():
        return _err("Blender 联网总开关关闭", code="network_policy",
                    fix="偏好 ▸ 系统 ▸ 网络 ▸ 允许联网后重试")
    asset_id = str(id or "").strip()
    if not SLUG_RE.match(asset_id):
        return _err("id 必须是 PolyHaven slug（字母/数字/下划线/连字符）", code="bad_params", given=id)
    if str(asset_type).lower() != "models":
        return _err("v1 只导入 models；textures / hdris 用 blender_py 模板",
                    code="asset_type_unsupported", given=asset_type)
    try:
        files_data = _http_json("%s/files/%s" % (POLYHAVEN_API, urllib.parse.quote(asset_id, safe="")))
    except Exception as e:
        return _err("取文件清单失败：%s: %s" % (type(e).__name__, str(e)[:160]), code="network_error")
    try:
        work, main_path = _fetch_model(files_data, resolution, file_format)
    except ValueError as e:
        return _err(str(e), code="format_unavailable", id=asset_id, resolution=resolution)
    except Exception as e:
        return _err("下载失败：%s: %s" % (type(e).__name__, str(e)[:160]), code="download_failed")
    bpy = _bpy()
    before = {ob.name for ob in bpy.data.objects}
    try:
        bpy.ops.import_scene.gltf(filepath=main_path)
    except Exception as e:
        shutil.rmtree(work, ignore_errors=True)
        return _err("glTF 导入失败：%s: %s" % (type(e).__name__, str(e)[:200]), code="import_failed")
    added = _name_objects(before, name_prefix or asset_id.upper()[:12])
    coll = _link(added, collection)
    notes = []
    if not added:
        notes.append("导入没有新增对象：文件可能只含相机/空物体，或导入器静默失败")
    out = {
        "ok": bool(added),
        "source": "polyhaven",
        "id": asset_id,
        "resolution": resolution,
        "imported": [ob.name for ob in added],
        "created": len(added),
        "tris": _triangles(added),
        "bbox": _bbox(added),
        "collection": coll,
        "dir": work,
        "notes": notes,
        "next": 'blender_op(op="audit_mesh", args={objects:%s}) —— 未复检不算导入成功'
                % _j([ob.name for ob in added]),
    }
    return _j(out)


def asset_help():
    return _j({
        "ok": True,
        "family": "asset",
        "version": ASSET_VERSION,
        "ops": {
            "search": "搜资产（source=polyhaven，query/limit/asset_type）",
            "fetch": "下载并导入（source=polyhaven，id，resolution=1k，file_format=gltf|glb，"
                     "name_prefix，collection）",
        },
        "sources": {"polyhaven": "免 key，已接入", "sketchfab": "需要 key，走 blender_py",
                    "polypizza": "需要 key，走 blender_py"},
        "keys": ["id 必须是 slug（字母/数字/下划线/连字符）",
                 "resolution 缺省 1k；1k 比 4k 快一个数量级，先 1k 看形再换高精度",
                 "导入只做命名 + 归集合；材质/UV/减面要另外跑 material_* / uv_* / fix_*"],
        "limits": [
            "只支持 models；textures / hdris 没有自动挂接逻辑",
            "不校验在线资产许可：商用前自行确认 PolyHaven CC0 之外的来源",
            "导入后必须 blender_op(op=\"audit_mesh\") 复检；导入成功 ≠ 模型可用",
        ],
        "next": ["asset_search → asset_fetch → audit_mesh → uv_smart_project（要贴图时）"],
    })


def asset_dispatch(op, args_json):
    args = {}
    if isinstance(args_json, str) and args_json.strip():
        try:
            args = json.loads(args_json)
        except Exception as e:
            return _err("args 不是合法 JSON: %s" % str(e)[:120], code="bad_args")
    if not isinstance(args, dict):
        return _err("args 需要对象", code="bad_args")
    kw = dict(args)
    if isinstance(kw.get("args"), dict):
        kw.update(kw.pop("args"))
    ops = {"search": asset_search, "fetch": asset_fetch, "help": asset_help}
    fn = ops.get(str(op))
    if fn is None:
        return _err("unknown asset op", code="unknown_op", op=op, ops=sorted(ops))
    try:
        return fn(**kw)
    except TypeError as e:
        return _err("参数不匹配: %s" % str(e)[:200], code="bad_params", op=op)
    except Exception as e:
        return _err("%s: %s" % (type(e).__name__, str(e)[:200]), code="internal", op=op)


if _K is not None and _KIT is not None:
    _K.dsh_asset_api = _KIT.Api({
        "version": ASSET_VERSION,
        "dispatch": asset_dispatch,
        "search": asset_search,
        "fetch": asset_fetch,
        "help": asset_help,
    })
