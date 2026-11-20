# -*- coding: utf-8 -*-
"""asm_export 阶段 1：参数校验 / 格式与名字 / 输出目录 / manifest 校验 / merge 前置。"""
from ..common import *  # noqa: F401,F403
from .helpers import *  # noqa: F401,F403
from ..manifest import _load_manifest, _manifest_validate
from ..merge import asm_merge
from ..repair import _repair_flag


def _asm_flags(merge, dry_run, include_receipt, ledger, verify):
    """5 个布尔参数统一校验；返回 (err, flags)。"""
    out = {}
    for key, raw in (("merge", merge), ("dry_run", dry_run), ("include_receipt", include_receipt),
                     ("ledger", ledger), ("verify", verify)):
        fixed, ferr = _repair_flag(raw, key)
        if ferr:
            return _err(ferr), None
        out[key] = fixed
    return None, out


def _asm_name_and_formats(formats, name):
    """校验 formats/name；返回 (err, fmts, nm, warnings)。"""
    fmts, ferr = _asm_export_formats(formats)
    if ferr:
        return _err(ferr), None, None, None
    nm, nwarn = _asm_export_name(name)
    if nm is None:
        return _err(nwarn), None, None, None
    return None, fmts, nm, ([nwarn] if nwarn else [])


def _asm_target_dir(out_dir, warnings):
    """解析输出目录；返回 (err, od)。"""
    if out_dir is not None and not isinstance(out_dir, (str, os.PathLike)):
        return _err("out_dir 必须是路径字符串，收到 %r" % (out_dir,)), None
    if out_dir:
        return None, _path(str(out_dir))
    K = _kernel()
    base = getattr(K, "out_dir", None) if K is not None else None
    od = _path(os.path.join(base or os.path.expanduser("~"), "asm_export"))
    warnings.append("out_dir 未给 → 默认 %s" % od)
    return None, od


def _asm_export_use_case(use_case, bake_anim=None, add_leaf_bones=None,
                         apply_scale_options=None, export_yup=None):
    """use_case 预设 + 逐轮显式覆盖 → (err, info)。

    info 里的 options 按导出器格式分组（{"fbx": {...}} / {"glb": {...}}），只装"预设 + 覆盖"
    产生的关键字；use_case=none 且没给覆盖时是空 dict ⇒ 导出器收到与拆分前完全一样的关键字。
    显式值永远盖过预设；坏值/落不了地的按键一律 ok:false（不静默退回预设或默认）。
    """
    allowed = list(_ASM_EXPORT_USE_CASES)
    raw = "none" if use_case is None else use_case
    if not isinstance(raw, str):
        return _err("use_case 必须是字符串，收到 %r（允许 %s）" % (use_case, allowed),
                    allowed=allowed), None
    name = raw.strip().lower() or "none"
    if name in _ASM_EXPORT_USE_CASES_REJECTED:
        return _err("use_case=%r 不在 asm_export 的支持范围：本路径只写 glb/fbx/obj" % name,
                    allowed=allowed,
                    hint="print 走 deliver_export(fmt='stl')；ar 走 USD 导出（deliver_export 的 USD 路径）"), None
    if name not in _ASM_EXPORT_USE_CASES:
        return _err("use_case 只支持 none|unity|unreal|godot|web，收到 %r" % (raw,),
                    allowed=allowed,
                    hint="不认识的 use_case 不会静默退回 none"), None
    preset = _ASM_EXPORT_USE_CASE_PRESETS.get(name) or {}
    options = {}
    if preset:
        options[str(preset["format"])] = dict(preset["options"])
    overrides = {}
    for key, value in (("bake_anim", bake_anim), ("add_leaf_bones", add_leaf_bones),
                       ("export_yup", export_yup)):
        if value is None:
            continue
        fixed, ferr = _repair_flag(value, key)
        if ferr:
            return _err(ferr, allowed=allowed), None
        overrides[key] = fixed
    if apply_scale_options is not None:
        scale = str(apply_scale_options).strip().upper()
        if scale not in _ASM_FBX_SCALE_OPTIONS:
            return _err("apply_scale_options 只支持 %s，收到 %r"
                        % ("/".join(_ASM_FBX_SCALE_OPTIONS), apply_scale_options),
                        allowed=allowed), None
        overrides["apply_scale_options"] = scale
    for key, value in overrides.items():
        fmt = _ASM_EXPORT_OVERRIDE_FORMATS[key]
        if preset and preset.get("format") != fmt:
            return _err("%s 只对 %s 导出器有效，但 use_case=%s 导出的是 %s"
                        % (key, fmt, name, preset.get("format")),
                        allowed=allowed,
                        hint="换匹配的 use_case，或 use_case=none 再显式给 formats"), None
        options.setdefault(fmt, {})[key] = value
    return None, {"name": name, "format": preset.get("format"), "preset": bool(preset),
                  "options": options,
                  "overrides": {k: overrides.get(k) for k in _ASM_EXPORT_OVERRIDE_KEYS},
                  "allowed": allowed}


def _asm_export_options(uc, fmts):
    """use_case 需要的格式必须在本次 formats 里；返回 (err, 按格式过滤后的 opts)。

    关键字没法落地的导出器不接收它们，静默丢弃就等于"设了没用"——所以要求 formats 含目标格式，
    由调用方显式补上（默认 formats 已含 glb/fbx，正常调用不会踩到）。
    """
    opts_all = dict((uc or {}).get("options") or {})
    missing = [fmt for fmt in opts_all if fmt not in fmts]
    if missing:
        knobs = sorted({k for fmt in missing for k in (opts_all.get(fmt) or {})})
        return _err("use_case=%s 需要 formats 含 %s（本次只有 %s）：%s 无处落地，不静默退回默认值"
                    % ((uc or {}).get("name"), "/".join(missing), "/".join(fmts) or "空",
                       "/".join(knobs)),
                    allowed=list(_ASM_EXPORT_USE_CASES), formats=list(fmts),
                    hint="把 %s 加进 formats，或换 use_case=none" % "/".join(missing)), None
    return None, {fmt: dict(v) for fmt, v in opts_all.items() if fmt in fmts}


def _asm_manifest_stage(manifest, merge):
    """载入并按需校验 manifest；返回 (err, m)。"""
    m = None
    if manifest is not None:
        m, merr = _load_manifest(manifest)
        if merr:
            return _err(merr), None
        mval = _manifest_validate(m, check_files=bool(merge), check_md5=bool(merge))
        if not mval["ok"]:
            return _err("manifest 校验失败（坏清单上不导出）", errors=mval["errors"][:10],
                        warnings=mval["warnings"][:10]), None
    if merge and m is None:
        return _err("merge=true 必须给 manifest（N 路合并需要零件清单）"), None
    return None, m


def _asm_merge_stage(ctx):
    """merge=true 时先跑 asm_merge（含 dry_run 计划）；返回 (fail_body_or_None, merge_rec)。"""
    flags = ctx["flags"]
    od, nm, fmts = ctx["od"], ctx["nm"], ctx["fmts"]
    dry_run = flags["dry_run"]
    merge_out_blend = os.path.join(od, nm + "_merged.blend")
    ctx["merge_out_blend"] = merge_out_blend
    if not flags["merge"]:
        return None, None
    merge_call = dict(manifest=ctx["m"], out_blend=merge_out_blend, dry_run=bool(dry_run))
    raw_merge = asm_merge(**merge_call)
    merge_rec = json.loads(raw_merge) if isinstance(raw_merge, str) else raw_merge
    if not isinstance(merge_rec, dict) or not merge_rec.get("ok"):
        gv = ((merge_rec or {}).get("gate") or {}).get("verdict") if isinstance(merge_rec, dict) else None
        body = {"ok": False, "verdict": gv or "fail", "dry_run": bool(dry_run),
                "stage": "merge", "dir": od, "name": nm, "formats": fmts,
                "use_case": _asm_export_use_case_slim(ctx.get("use_case")),
                "export_options": dict(ctx.get("export_opts") or {}),
                "files": {}, "counts": {"objects": 0, "files": 0},
                "gate": _asm_gate_slim((merge_rec or {}).get("gate")),
                "merge": _asm_merge_slim(merge_rec),
                "md5": {}, "warnings": ctx["warnings"],
                "error": "合并失败/装配门未通过 ⇒ 不导出",
                "verdict_line": "asm_export：合并阶段失败（%s）→ 未导出任何文件"
                                % str((merge_rec or {}).get("error"))[:160],
                "hint": "先看 merge.gate / merge.error；修 manifest/几何后重跑；merge 失败不保存 .blend",
                "honest_limits": list(_ASM_EXPORT_LIMITS)}
        return body, None
    return None, merge_rec
