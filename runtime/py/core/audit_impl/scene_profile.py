# -*- coding: utf-8 -*-
"""audit_scene 的调用档位：screen（便宜初筛）/ gate（能当门的完整结论）。

为什么单独一个纯逻辑文件：``audit_scene`` 默认跳过自交检查（性能契约），但"跳过"在回执里
只会变成 degraded/clean=false；现场反复出现两种误读：
  * 拿默认调用当门用 → 健康场景也 clean=false（以为几何坏了）；
  * 看到 clean=false 就去改几何 → 其实只是有一项检查没跑。

这里把"这次调用能不能当门"变成显式档位 + 回执字段 ``gate_ready``，不 import bpy，
方便在无 Blender 的单元测试里直接钉住语义。
"""

PROFILES = ("screen", "gate")
SCREEN_PROFILE = "screen"
GATE_PROFILE = "gate"
GATE_HINT = ('要一条能当门用的结论：profile="gate"（自动 self_intersect=true + '
             'summary_only=true），或显式 self_intersect=true')


def resolve_scene_profile(profile=None, self_intersect=None, summary_only=None):
    """把 (profile, self_intersect, summary_only) 归一成 (opts, error)。

    - profile="screen"（默认）：便宜初筛；self_intersect 默认 False，gate_ready=False；
    - profile="gate"：强制 self_intersect=True、summary_only=True；与显式
      self_intersect=False 矛盾时报错（不悄悄改参数，否则调用方以为跳过了自交）；
    - 未知 profile ⇒ BAD_PROFILE；返回值里的 forced 列出被档位改写的参数。
    """
    name = str(profile or SCREEN_PROFILE).strip().lower()
    if name not in PROFILES:
        return None, {"code": "BAD_PROFILE",
                      "error": "profile 只支持 %s（收到 %r）" % (list(PROFILES), profile),
                      "hint": GATE_HINT}
    si = False if self_intersect is None else bool(self_intersect)
    so = False if summary_only is None else bool(summary_only)
    forced = []
    if name == GATE_PROFILE:
        if self_intersect is False:
            return None, {"code": "GATE_PROFILE_CONFLICT",
                          "error": 'profile="gate" 与 self_intersect=false 矛盾：门必须跑自交检查',
                          "hint": GATE_HINT}
        if not si:
            si = True
            forced.append("self_intersect")
        if not so:
            so = True
            forced.append("summary_only")
    return {"profile": name, "self_intersect": bool(si), "summary_only": bool(so),
            "gate_ready": bool(si), "forced": forced}, None
