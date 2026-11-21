# -*- coding: utf-8 -*-
"""audit_mesh 的作用域/来源判定（纯逻辑，不 import bpy）。

现场（2026-11-20 三路并发建模）：`audit_mesh(objects=[])` 被当成"审计当前场景全部对象"，
于是审计到用户自己打开的另一个 .blend，而回执里没有任何来源字段 —— agent 以为审的是自己的件。
这里把两条判定拆成可单测的纯函数：

  * empty_objects_guard：objects=[] 是**显式空列表**，不是"全场景"；只有 None 才是全场景。
  * mesh_source：回执里的 source{file,scene,scope,objects,requested}，把"审的是谁"写死。
"""


def _names(values):
    """把对象名参数归一成字符串列表（None → []，单个字符串 → [name]）。"""
    if values is None:
        return []
    if isinstance(values, str):
        return [values]
    try:
        return [str(x) for x in values]
    except TypeError:
        return [str(values)]


def empty_objects_guard(objects, scope=None, file=None):
    """objects=[] 的显式空列表：返回 ok=false 的错误体；其余情况返回 None。

    * file= 已给出文件作用域 → [] 在 file 模式里等同"文件内全部 mesh"（由加载器决定）。
    * scope= 已给出集合作用域 → [] 不是"全场景"，交给 _pick。
    * objects is None → 没有请求筛选，= 当前场景全部对象（合法，但回执必须回显 source）。
    """
    if file or scope:
        return None
    probe = objects
    if isinstance(objects, dict):
        probe = objects.get("objects")
        if probe is None:
            probe = objects.get("names")
        if probe is None:
            probe = objects.get("list")
    if isinstance(probe, (list, tuple, set)) and len(probe) == 0:
        return {
            "ok": False,
            "error": "objects=[] 是显式空列表：不审计当前场景全部对象（静默全场景会审到别人的文件）",
            "hint": "全场景用 audit_scene(objects=None)；指定对象传 objects=[\"...\"]；跨文件传 file=<.blend 路径>",
            "scope": "objects=[]",
        }
    return None


def library_meta(libraries):
    """把 bpy.data.libraries 的新条目快照成 (ref, name, filepath) 纯值。

    必须在删除任何一条**之前**调用：同一个 .blend 可能被 append 成多条 Library
    （实测 `geometry_nodes_essentials.blend` + `.001`），remove 第一条会让同批的其余条目
    失效；之后再读 `lib.name` 就是 `ReferenceError: StructRNA of type Library has been removed`。
    已经失效的条目直接跳过（它已经被别的 remove 连带清掉了）。
    """
    out = []
    for lib in libraries or []:
        try:
            out.append((lib, str(lib.name), str(lib.filepath)))
        except ReferenceError:
            continue
    return out


def purge_libraries(meta, remove):
    """逐条删库条目；返回 (removed_names, failed_messages)。

    `remove(ref)` 抛 ReferenceError 表示该条目已被同批删除连带清掉 —— 记进 removed，
    不当失败（旧实现就死在"删完第一条再读第二条的名字"）。
    """
    removed, failed = [], []
    for lib, name, _path in meta or []:
        try:
            remove(lib)
            removed.append(name)
        except ReferenceError:
            removed.append(name)
        except Exception as exc:
            failed.append("%s: %s" % (name, str(exc)[:80]))
    return removed, failed


def mesh_source(mode, file_path=None, scene=None, scope="current_scene", objects=None,
                requested=None, session_file=None):
    """回执的 source 块：来源文件/场景/作用域/实际审到的对象名。

    * mode: "session"（当前会话）或 "file"（临时加载的 .blend）。
    * file_path: file 模式是加载的文件；session 模式是 bpy.data.filepath（未存盘为 None）。
    * session_file: 会话当前打开的 .blend（file 模式下用来区分"加载源"与"会话文件"）。
    """
    return {
        "mode": str(mode),
        "file": str(file_path) if file_path else None,
        "scene": str(scene) if scene else None,
        "scope": str(scope),
        "objects": _names(objects),
        "requested": None if requested is None else _names(requested),
        "session_file": str(session_file) if session_file else None,
    }
