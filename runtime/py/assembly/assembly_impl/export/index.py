# -*- coding: utf-8 -*-
"""asm_export 编排：阶段函数分散在同包各模块，公开名字仍是 asm_export。"""
from ..common import *  # noqa: F401,F403
from .helpers import *  # noqa: F401,F403
from .plan import (_asm_flags, _asm_name_and_formats, _asm_target_dir, _asm_manifest_stage,
                   _asm_merge_stage, _asm_export_use_case, _asm_export_options)
from .targets import _asm_resolve_targets
from .write import _asm_export_all
from .manifest import _asm_manifest_stage as _asm_manifest_write
from .ledger import _asm_ledger_stage
from .body import _asm_planned_body, _asm_final_body


def asm_export(manifest=None, scope=None, objects=None, out_dir=None, name="assembly",
               formats=["glb", "fbx", "obj"], merge=False, dry_run=False,
               include_receipt=True, ledger=True, verify=True, use_case="none",
               bake_anim=None, add_leaf_bones=None, apply_scale_options=None,
               export_yup=None):
    """装配交付导出：可选 N 路合并 → GLB/FBX/OBJ → <out_dir>/<name>_manifest.json + append-only merge_ledger.jsonl。

    流程：
      1) merge=true 且 dry_run=false：先 asm_merge(dry_run=false)（内部 gate + snapshot；不过门不导出）；
         merge=true 且 dry_run=true：只跑 asm_merge(dry_run=true) 拿计划。
      2) 导出 GLB（export_scene.gltf, GLB/use_selection/export_apply/export_yup）、
         FBX（export_scene.fbx）、OBJ（wm.obj_export，回退 export_scene.obj）；自动 enable io_scene_gltf2/io_scene_fbx。
      3) manifest：objects/bbox(单位+mm)/units/md5/files/gate/merge receipt；manifest_md5 自指纹。
      4) ledger：append-only JSONL，一行一个 merge/export 事件（ts/action/manifest_md5/files/md5/gate_verdict）。
    失败口径：坏参数 / 空场景 / 全部格式失败 ⇒ ok:false；部分格式失败 ⇒ ok:true + warnings。
    dry_run=true：只回计划（不建目录、不导出、不写 manifest/ledger）；场景只读。

    use_case（交付去向预设；默认 none ⇒ 导出器关键字与旧版逐字相同）：
      none 不额外设置；unity → fbx + bake_anim=True/apply_scale_options=FBX_SCALE_ALL/轴 -Z,Y；
      unreal → fbx + bake_anim=True/apply_scale_options=FBX_SCALE_UNITS/轴 -Z,Y；
      godot|web → glb + export_yup=True/export_animations=True。
      print/ar 本路径写不出来 ⇒ ok:false + allowed + hint（print→deliver_export(fmt='stl')，ar→USD）。
      预设要求的格式必须出现在 formats 里（默认 formats 已含 glb/fbx）。
    bake_anim / add_leaf_bones / apply_scale_options / export_yup：逐轮显式覆盖，永远压过预设；
      键落不到本次 formats 里的导出器上 ⇒ ok:false（不静默丢弃）。
    """
    t0 = time.perf_counter()
    err, flags = _asm_flags(merge, dry_run, include_receipt, ledger, verify)
    if err:
        return err
    err, fmts, nm, warnings = _asm_name_and_formats(formats, name)
    if err:
        return err
    err, uc = _asm_export_use_case(use_case, bake_anim, add_leaf_bones,
                                   apply_scale_options, export_yup)
    if err:
        return err
    err, eopts = _asm_export_options(uc, fmts)
    if err:
        return err
    err, od = _asm_target_dir(out_dir, warnings)
    if err:
        return err
    ctx = {"flags": flags, "fmts": fmts, "nm": nm, "warnings": warnings, "od": od,
           "scope": scope, "objects": objects, "use_case": uc, "export_opts": eopts}
    err, m = _asm_manifest_stage(manifest, flags["merge"])
    if err:
        return err
    ctx["m"] = m
    fail_body, merge_rec = _asm_merge_stage(ctx)
    if fail_body is not None:
        return _j(_receipt(fail_body, t0))
    ctx["merge_rec"] = merge_rec
    err, ctx = _asm_resolve_targets(ctx)
    if err:
        return err
    ctx["gate_slim"] = _asm_gate_slim(ctx["gate"])
    ctx["merge_slim"] = _asm_merge_slim(ctx["merge_rec"])
    planned = _asm_export_paths(od, nm, fmts, flags["include_receipt"], flags["ledger"])
    if flags["merge"]:
        planned["blend"] = ctx["merge_out_blend"]
    ctx["planned"] = planned
    if flags["dry_run"]:
        return _j(_receipt(_asm_planned_body(ctx), t0))
    err, ctx = _asm_export_all(ctx)
    if err:
        return err
    ctx = _asm_manifest_write(ctx)
    ctx = _asm_ledger_stage(ctx)
    return _j(_receipt(_asm_final_body(ctx), t0))
