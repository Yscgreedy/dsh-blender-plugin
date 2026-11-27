# -*- coding: utf-8 -*-
"""DSH 共享内核（kit）—— **唯一实现**：JSON/API 样板、单位、几何、度量、回执骨架。

为什么存在：此前 26 个模块各自复制了 `class _DshApi` / `def _j` / dispatch / 单位换算 / BVH / IoU，
同一套管道代码 ~800-1500 行，且约定会在复制中漂移（contract.py 与 deliver.py 各自踩过同一个 dict-vs-Api 坑）。

怎么用：kit 由 KERNEL_BOOTSTRAP 注入（注册为 K.dsh_kit），所以**每条注入路径都有它**：
    K = sys.modules.get("dsh_rt_kernel")
    _KIT = getattr(K, "dsh_kit", None)          # None 时说明没走 bootstrap（自建脚本要自己兜）
    _j = _KIT.j ; Api = _KIT.Api ; dispatch = _KIT.dispatch ; units = _KIT.units

约定：kit 只放"**每个模块都要写一遍**"的东西；领域逻辑一律留在各模块。
跨域端口（本刀）：提供方尾部 `register_port("名字", fn, 版本)`，消费方 `call_port("名字", payload)` /
`port_available("名字")`；端口表在 K.dsh_ports。core 因此不再直取 render / export 的 K.dsh_*_api。
"""
import contextlib
import json
import os
import sys
import types

KIT_VERSION = 1

# 领域包布局（Phase E）：runtime/py/<domain>/ 是真实实现；runtime/<name>.py 只留 shim。
RUNTIME_DOMAINS = ("core", "geometry", "assembly", "render", "export")


def _kernel():
    K = sys.modules.get("dsh_rt_kernel")
    if K is None:
        K = types.ModuleType("dsh_rt_kernel")
        sys.modules["dsh_rt_kernel"] = K
    return K


def find_runtime_file(name):
    """按文件名定位 runtime 侧文件：领域包优先，旧扁平布局兜底。

    背景：模块不再都在 runtime/ 同一层。qc.py 找 qc_render.py、qc_render.py 找 montage.py、
    contract.py 找 assembly_features.json —— 都改走这里，避免各自硬编码。

    查找顺序：
      1) K.runtime_dir（引擎注入的 runtime 根）：py/<domain>/ → py/ → 根目录；
      2) 本文件所在目录（常规 import：py/core）：同目录 → 兄弟领域包 → runtime 根。
    K.runtime_dir 可能本身就是 py/core（离线 bootstrap 传 runtime_dir 的旧用法），
    此时第 1 步全 miss，第 2 步按 kit.py 的实际位置兜住。
    """
    name = str(name or "")
    if not name:
        return None
    try:
        K = _kernel()
        rd = getattr(K, "runtime_dir", None)
    except Exception:
        rd = None
    cands = []
    if rd:
        rd = str(rd)
        for d in RUNTIME_DOMAINS:
            cands.append(os.path.join(rd, "py", d, name))
        cands.append(os.path.join(rd, "py", name))
        cands.append(os.path.join(rd, name))
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        here = ""
    if here:
        cands.append(os.path.join(here, name))
        up = os.path.dirname(here)
        for d in RUNTIME_DOMAINS:
            cands.append(os.path.join(up, d, name))
        cands.append(os.path.join(os.path.dirname(up), name))
    seen = set()
    for c in cands:
        if c in seen:
            continue
        seen.add(c)
        try:
            if os.path.isfile(c):
                return c
        except Exception:
            continue
    return None


# ────────────────────────────── JSON / 回执 ──────────────────────────────
def j(obj):
    """统一 JSON 序列化（中文不转义；非 JSON 类型退化为 str）。"""
    return json.dumps(obj, ensure_ascii=False, default=str)


def err(msg, **kw):
    """统一错误回执。"""
    d = {"ok": False, "error": str(msg)[:300]}
    d.update(kw)
    return j(d)


def receipt(ok=None, state=None, verdict=None, **kw):
    """统一回执骨架：ok / state / verdict / units 四件套 + 任意附加字段。

    state 与 verdict 的关系（与 gate v3 一致）：state 用于"这一项成没成"，verdict 用于三态判定；
    调用方给哪个就带哪个，不给就不编。
    """
    d = {}
    if ok is not None:
        d["ok"] = bool(ok)
    if state is not None:
        d["state"] = state
    if verdict is not None:
        d["verdict"] = verdict
    d["units"] = {"mm_per_unit": units()}
    d.update(kw)
    return d


# ────────────────────────────── 单位 ──────────────────────────────
def units():
    """mm_per_unit = scene.unit_settings.scale_length * 1000（Blender 默认 1 单位 = 1 m ⇒ 1000）。"""
    try:
        import bpy
        return float(bpy.context.scene.unit_settings.scale_length or 1.0) * 1000.0
    except Exception:
        return 1000.0


def mm(v):
    """Blender 单位 → 毫米。"""
    return float(v) * units()


@contextlib.contextmanager
def scene_units(scale_length=1.0):
    """把场景单位临时钉到 1 单位 = scale_length 米，退出时复位。

    为什么需要：自检的期望值是**写死的绝对量**（print_selftest 的"1 单位立方体壁厚 1000 mm"、
    vehicle_selftest 的"车长 4300 mm"、audit_gate_selftest 的"远端浮块 gap > 1000 mm"），它们默认
    1 单位 = 1 m。打开的文件若把 scene.unit_settings.scale_length 设成 0.001（1 单位 = 1 mm，
    本机 GUI 默认文件就是），同一段自检会**正好差 1000 倍**而全判 fail —— 那是打开文件的口径，
    不是代码坏了。自检自带口径，跑完复位，不动用户文件。
    """
    import bpy

    us = bpy.context.scene.unit_settings
    prev = float(getattr(us, "scale_length", 1.0) or 1.0)
    us.scale_length = float(scale_length)
    try:
        yield prev
    finally:
        try:
            us.scale_length = prev
        except Exception:
            pass


# ────────────────────────────── 跨模块 API ──────────────────────────────
def api(name):
    """取另一个模块的 API（`K.dsh_<name>_api`）；没注入返回 None。"""
    return getattr(_kernel(), "dsh_%s_api" % name, None)


class Api(dict):
    """模块 API 的标准形态：dict 可下标访问 + 可直接调用（进程内 `api(op, args)`）。

    历史坑：API 曾是普通 dict ⇒ 进程内 `api(args)` 报 TypeError: dict object is not callable；
    两个模块各自写了转换 shim。这里统一定义，模块不要再自己造。

    default_op 是模块级契约：`api({...})` 使用它分派；未声明时保持历史的 help 行为。
    `api()` 始终是 help，`api["dispatch"](op, json)` 仍返回原始 str。
    """

    def __init__(self, *args, default_op="help", **kwargs):
        super().__init__(*args, **kwargs)
        self.default_op = str(default_op or "help")

    def __call__(self, op=None, args=None, **kw):
        if isinstance(op, dict):
            args, op = op, self.default_op
        elif op is None:
            op = "help"
        payload = args if isinstance(args, str) else j(dict(args or {}, **kw))
        out = self["dispatch"](str(op), payload)
        return out if isinstance(out, dict) else json.loads(out)

    def call(self, op, args=None, **kw):
        return self(op, args, **kw)


def register(name, version, ops, dispatch=None, extra=None, default_op="help"):
    """把 `K.dsh_<name>_api` 注册成标准 Api（模块尾部一行搞定，别再手写 _DshApi）。

    ops: {"op名": 可调用}  —— 同时成为 API 的键，便于 `K.dsh_x_api["op"](...)` 直接调。
    """
    def _default_dispatch(op, args_json):
        return dispatch_table(ops, op, args_json)
    d = {"version": version, "dispatch": dispatch or _default_dispatch}
    for k, v in (ops or {}).items():
        d[k] = v
    d.update(extra or {})
    a = Api(d, default_op=default_op)
    setattr(_kernel(), "dsh_%s_api" % name, a)
    return a


def resolve_refs(value, skip_keys=("out", "steps")):
    """把 args 里的 "@工件[.路径]" 解析成真值（递归 dict/list）—— **单发 op 与 pipe_run 共用同一套语义**。

    工件表在 K.dsh_artifacts（pipe_put / pipe_run 的 out= 写入）。引用不存在时抛 KeyError，
    skip_keys 里的键**不解析**（如 pipe_run 的 out="@名字" 是输出名；steps 由 pipe_run 自己按序解析）。
    路由层会把它变成可见的报错（而不是静默把字符串当参数用）。
    """
    reg = getattr(_kernel(), "dsh_artifacts", None) or {}

    def _walk(v):
        if isinstance(v, str) and v.startswith("@"):
            body = v[1:]
            parts = body.split(".")
            nm = parts[0]
            if nm not in reg:
                raise KeyError("引用了不存在的工件 @%s（现有：%s）" % (nm, ", ".join(sorted(reg.keys())) or "无"))
            cur = reg[nm].get("value") if isinstance(reg[nm], dict) else reg[nm]
            for p in parts[1:]:
                cur = cur[int(p)] if isinstance(cur, list) else cur[p]
            return cur
        if isinstance(v, dict):
            return {k: (x if k in skip_keys else _walk(x)) for k, x in v.items()}
        if isinstance(v, list):
            return [_walk(x) for x in v]
        return v

    return _walk(value)


def kapi(name):
    """模块 API 一行式访问器（K.dsh_<name>_api）；找不到时列出已加载模块，别让人靠猜 preload 名。"""
    K = _kernel()
    api = getattr(K, "dsh_%s_api" % str(name), None)
    if api is None:
        have = sorted(k[len("dsh_"):-len("_api")] for k in dir(K) if k.startswith("dsh_") and k.endswith("_api"))
        raise RuntimeError("内核里没有 K.dsh_%s_api（已加载：%s）—— 在线路径请把它加进 preload（例如 preload=%s）；离线路径用 runtime/py/core/offline_bootstrap.py" % (name, have, name))
    return api


def install_kernel(ns=None):
    """把 K（与 kapi）装进命名空间；不给就装进调用方的 globals。

    为什么需要它：K 只注入「被执行脚本的 globals」，而 `import` 进来的 lib/*.py 有自己的 globals
    ⇒ 直接写 K.dsh_vehicle_api 会 NameError。官方推荐两选一：
      * 文件顶部一行：`import sys; K = sys.modules["dsh_rt_kernel"]`
      * 或调用：`K.dsh_kit.install_kernel()` / `K.dsh_kit.kapi("vehicle")`
    """
    K = _kernel()
    target = ns if isinstance(ns, dict) else sys._getframe(1).f_globals
    target["K"] = K
    if getattr(K, "dsh_kit", None) is not None:
        target["kapi"] = K.dsh_kit.kapi
    return K


# ────────────────────────────── 跨域端口（provider 端口倒置） ──────────────────────────────
# 为什么存在：core 的 contract / gate 曾经直接按名字从内核里取 render / export 的私有 API，
# 于是反向依赖它们的**模块名 + 子 op 名** —— 这就是
# core → render、core → export 两条强 2-环。这条边逃得过 import 图检查（取的是内核属性，不是 import），
# 所以必须在**调用侧**倒置：
#   提供方在自己模块尾部 register_port("名字", fn, 版本)；
#   消费方只 port_available("名字") / call_port("名字", payload)，不认识提供方的模块与子 op。
# 端口表挂 K.dsh_ports（与 K.dsh_artifacts 同一约定：状态在持久内核上跨调用保留）。
PORT_VERSION = 1

# call_port 的"调用方没给 default"哨兵 —— 不能用 None（端口可能合法返回 None）
_PORT_MISSING = object()


def ports():
    """当前端口表（K.dsh_ports）；不存在或形状不对时建空表并挂回内核。"""
    K = _kernel()
    reg = getattr(K, "dsh_ports", None)
    if not isinstance(reg, dict):
        reg = {}
        setattr(K, "dsh_ports", reg)
    return reg


def register_port(name, fn, version=PORT_VERSION):
    """提供方登记一个端口（模块尾部一行）。同名重复登记 = 覆盖（后加载的实现胜出，与 K.dsh_x_api 一致）。"""
    if not callable(fn):
        raise TypeError("端口 %s 的 fn 必须可调用（拿到 %s）" % (str(name), type(fn).__name__))
    ports()[str(name)] = {"fn": fn, "version": int(version),
                          "owner": str(getattr(fn, "__module__", "") or "")}
    return fn


def port_available(name):
    """端口是否可用（登记过且 fn 可调用）—— 消费方据此走 fail-closed 回退，而不是靠抛异常。"""
    entry = ports().get(str(name))
    return bool(isinstance(entry, dict) and callable(entry.get("fn")))


def port_info(name):
    """端口元数据 {name, version, owner}（不含 fn）；未登记返回 None。"""
    entry = ports().get(str(name))
    if not isinstance(entry, dict) or not callable(entry.get("fn")):
        return None
    return {"name": str(name), "version": entry.get("version"), "owner": entry.get("owner")}


def port_names():
    """已登记端口名（诊断用，排序稳定）。"""
    return sorted(str(k) for k in ports().keys())


def call_port(name, payload=None, default=_PORT_MISSING):
    """调用端口；未登记时返回 default（给了）或抛 LookupError（没给）。

    返回值：端口函数的原样结果；**结果是 JSON 文本时解析成对象**（端口契约是"回执"：提供方可以
    `return capture(...)` 这种返回 JSON 串的实现，也可以在进程内直接返回 dict）。
    异常不吞：端口实现自己抛的错照旧冒泡给调用方（调用方按自己的回执形状兜）。
    """
    entry = ports().get(str(name))
    if not isinstance(entry, dict) or not callable(entry.get("fn")):
        if default is _PORT_MISSING:
            raise LookupError("端口未注册: %s（已登记：%s）" % (str(name), ", ".join(port_names()) or "无"))
        return default
    out = entry["fn"](payload)
    if isinstance(out, str):
        try:
            return json.loads(out)
        except Exception:
            return out
    return out


def _ports_selftest():
    """端口机制自检：登记 → 可查 → 可调（JSON 文本自动解析）→ 缺省回退 → 清理。"""
    name = "__dsh_port_selftest__"
    try:
        fn = register_port(name, lambda payload: json.dumps({"echo": payload}), PORT_VERSION)
        info = port_info(name) or {}
        return bool(callable(fn) and port_available(name)
                    and info.get("name") == name and info.get("version") == PORT_VERSION
                    and call_port(name, 7) == {"echo": 7}
                    and call_port("__dsh_port_absent__", "fallback", "fallback") == "fallback")
    except Exception:
        return False
    finally:
        ports().pop(name, None)


def comp_tree(scene=None):
    """拿合成器节点树：Blender 5.2 起 scene.node_tree 已移除（搬到 scene.compositing_node_group）。

    现场：5.2 上访问 scene.node_tree、或 Glare 的 mix、Mix 的 blend_type 会从助手函数深处抛 AttributeError。
    统一从这里取，版本差异只在一处处理；拿不到就明确说清版本口径。
    """
    import bpy
    sc = scene or bpy.context.scene
    for attr in ("compositing_node_group", "node_tree"):
        holder = getattr(sc, attr, None)
        if holder is None:
            continue
        tree = getattr(holder, "node_tree", holder)
        if tree is not None:
            return tree
    raise RuntimeError("拿不到合成器节点树：Blender 5.2 起改用 scene.compositing_node_group（旧的 scene.node_tree 已移除）；取到后注意 Glare 的 mix 与 Mix 的 blend_type/mix 都改名了，用 getattr 兜底")


# ────────────────────────────── 动画 Action 兼容 ──────────────────────────────
def _dsh_fcurve_identity(fcurve):
    """Datablock identity for de-duplication across slots.

    (data_path, array_index) is not an identity: two objects can share one action
    and repeat the same path in different slots with different data.
    """
    as_pointer = getattr(fcurve, "as_pointer", None)
    if callable(as_pointer):
        try:
            return ("pointer", as_pointer())
        except Exception:
            pass
    return ("object", id(fcurve))


def action_fcurves(action, slot=None):
    """F-curves of an action through the layered/slotted API when it is in use.

    Blender 4.4 made actions layered and slotted; 5.2 removed the
    Action.fcurves shortcut.  Do not detect the generation with
    hasattr(action, "fcurves"): third-party shims (mmd_tools is one) expose a
    one-slot compatibility collection and make a shim-driven "legacy" branch
    silently skip every other slot.  The structural test is action.layers.

    slot=None returns the union of every slot (each curve once); pass the
    slot assigned to the object (obj.animation_data.action_slot) for the
    curves that actually drive it.  Pre-4.4 actions keep using
    Action.fcurves.
    """
    if action is None:
        return []
    layers = getattr(action, "layers", None)
    if layers is not None:
        slots = [slot] if slot is not None else list(getattr(action, "slots", None) or ())
        curves = []
        seen = set()
        for candidate in slots:
            channelbag = None
            for layer in layers:
                for strip in getattr(layer, "strips", None) or ():
                    try:
                        channelbag = strip.channelbag(candidate)
                    except Exception:
                        channelbag = None
                    if channelbag is not None:
                        break
                if channelbag is not None:
                    break
            if channelbag is None:
                continue
            for fcurve in getattr(channelbag, "fcurves", None) or ():
                identity = _dsh_fcurve_identity(fcurve)
                if identity in seen:
                    continue
                seen.add(identity)
                curves.append(fcurve)
        return curves
    try:
        return list(getattr(action, "fcurves", None) or ())
    except AttributeError:
        return []


def wrap_dispatch(base, extra=None):
    """给已有 dispatch 挂附加 op（如 selftest）：命中 extra 走额外表，否则交回原 dispatch。

    用途：模块的 op 表是各自手写的（形态不一），补 op 时不该去改它的内部结构。
    """
    extra = extra or {}

    def _d(op, args_json=None):
        fn = extra.get(str(op))
        if fn is not None:
            return dispatch_table({str(op): fn}, op, args_json)
        if callable(base):
            return base(op, args_json)
        return err("unknown op", op=op, ops=sorted(extra.keys()))

    return _d

def flatten(args):
    """参数摊平：`{"args": {...}}` 与顶层键等价（历史两种写法都支持）。"""
    out = {}
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except Exception:
            args = {}
    for k, v in (args or {}).items():
        if k == "args" and isinstance(v, dict):
            out.update(v)
        else:
            out[k] = v
    return out


def dispatch_table(ops, op, args_json=None):
    """标准 dispatch：解析 → 摊平 → 查表 → 调用 → 统一错误回执。"""
    kw = flatten(args_json)
    try:
        kw = resolve_refs(kw)   # 单发 op 也支持 "@工件[.路径]"
    except KeyError as e:
        return err("引用解析失败: %s" % str(e)[:160], op=op)
    fn = ops.get(str(op))
    if fn is None:
        return err("unknown op", op=op, ops=sorted(ops))
    try:
        out = fn(**kw)
        return out if isinstance(out, str) else j(out)
    except TypeError as e:
        return err("参数不匹配: %s" % str(e)[:200], op=op)
    except Exception as e:
        return err("%s: %s" % (type(e).__name__, str(e)[:200]), op=op)


# ────────────────────────────── 几何 / 度量 ──────────────────────────────
def objects(names, strict=True):
    """名字列表 → 对象列表；strict 时返回 (objs, missing)。"""
    import bpy
    if isinstance(names, str):
        names = [names]
    objs = [bpy.data.objects.get(str(n)) for n in (names or [])]
    missing = [n for n, o in zip(names or [], objs) if o is None]
    return (objs, missing) if strict else [o for o in objs if o is not None]


def world_tris(objs, include_hidden=True):
    """一组对象的**世界三角面**（用 evaluated mesh：修改器/阵列都算进去）。"""
    import bpy
    dg = bpy.context.evaluated_depsgraph_get()
    tris = []
    for ob in objs:
        if ob is None or ob.type != "MESH":
            continue
        if not include_hidden:
            try:
                if not ob.visible_get():
                    continue
            except Exception:
                pass
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            mw = ob.matrix_world
            for t in me.loop_triangles:
                tris.append([tuple(mw @ me.vertices[i].co) for i in t.vertices])
        finally:
            ev.to_mesh_clear()
    return tris


def bvh(tris):
    """三角面 → BVH（空输入返回 None）。"""
    from mathutils.bvhtree import BVHTree
    if not tris:
        return None
    V = [v for t in tris for v in t]
    polys = [(3 * i, 3 * i + 1, 3 * i + 2) for i in range(len(tris))]
    return BVHTree.FromPolygons(V, polys, all_triangles=True)


def iou(mask_a, mask_b):
    """布尔掩码 IoU —— **唯一实现**（imgtools / qc / qc_render 都该用这个）。

    返回 (iou, inter, union)；空并集返回 (None, 0, 0)。
    """
    import numpy as np
    a = np.asarray(mask_a).astype(bool)
    b = np.asarray(mask_b).astype(bool)
    inter = int(np.count_nonzero(a & b))
    union = int(np.count_nonzero(a | b))
    return ((inter / union) if union else None), inter, union


def pairwise_clearance(objs_a, objs_b, samples=1200, seed=0):
    """两组对象的最近距离（米）与是否互穿 —— 采样法（顶点+面心 ↔ 对面 BVH）。

    返回 dict：{"gap_m": float|None, "interpenetrating": bool, "overlap_tri_pairs": int}
    诚实边界：间隙是采样点距离（大曲面平行贴合可能高估）；互穿判定精确（三角面相交）。
    """
    import random
    ta, tb = world_tris(objs_a), world_tris(objs_b)
    if not ta or not tb:
        return {"gap_m": None, "interpenetrating": False, "overlap_tri_pairs": 0, "error": "empty_mesh"}
    ba, bb = bvh(ta), bvh(tb)
    ov = ba.overlap(bb) or []
    rng = random.Random(int(seed))
    best = None
    for tris, other in ((ta, bb), (tb, ba)):
        pts = []
        for t in tris:
            pts.append(t[0]); pts.append(t[1]); pts.append(t[2])
            pts.append(((t[0][0] + t[1][0] + t[2][0]) / 3.0,
                        (t[0][1] + t[1][1] + t[2][1]) / 3.0,
                        (t[0][2] + t[1][2] + t[2][2]) / 3.0))
        if len(pts) > int(samples):
            pts = rng.sample(pts, int(samples))
        for p in pts:
            r = other.find_nearest(p)
            if r is None or r[0] is None:
                continue
            import mathutils
            d = (r[0] - mathutils.Vector(p)).length
            if best is None or d < best:
                best = d
    return {"gap_m": best, "interpenetrating": len(ov) > 0, "overlap_tri_pairs": len(ov)}



# ────────────────────────────── 场景内容探针（回执自证） ──────────────────────────────
state_VERSION = 1
_STATE_MAT_KEYS = ("Base Color", "Metallic", "Roughness", "IOR", "Alpha",
                   "Emission Color", "Emission Strength", "Transmission Weight")
_STATE_COORD_BUDGET = 400000  # 浮点预算（≈13 万顶点）；超了只哈希拓扑/变换并标 truncated


def _state_text(h, tag, value):
    h.update(("%s|%s" % (tag, value)).encode("utf-8", "replace"))


def _state_number(value, digits=6):
    try:
        return round(float(value), int(digits))
    except Exception:
        return value


def _state_material_sig(mat):
    """材质签名：漫反射 + Principled 关键输入（Roughness/Metallic/Base Color…）。"""
    import hashlib
    h = hashlib.sha256()
    _state_text(h, "N", getattr(mat, "name", ""))
    try:
        _state_text(h, "C", ",".join("%.4f" % float(c) for c in mat.diffuse_color))
    except Exception:
        pass
    try:
        _state_text(h, "U", bool(getattr(mat, "use_nodes", False)))
        nt = getattr(mat, "node_tree", None)
        nodes = list(getattr(nt, "nodes", []) or [])
        _state_text(h, "K", len(nodes))
        for node in nodes:
            if str(getattr(node, "type", "")) != "BSDF_PRINCIPLED":
                continue
            for sock in getattr(node, "inputs", []):
                if sock.name not in _STATE_MAT_KEYS:
                    continue
                value = getattr(sock, "default_value", None)
                try:
                    value = tuple(round(float(x), 4) for x in value)
                except TypeError:
                    value = _state_number(value, 4)
                _state_text(h, "I", "%s=%s" % (sock.name, value))
    except Exception:
        pass
    return h.hexdigest()[:8]


def _state_anim_sig(ob, h):
    """动画域签名（C-14）：action 名 + slot id + fcurve 数 + 每条前 8 个关键帧。

    以前 state_probe 完全不看动画：只改 fcurve 时回执说 changed=false（假阴性）。
    """
    try:
        ad = getattr(ob, "animation_data", None)
        act = getattr(ad, "action", None) if ad is not None else None
        if act is None:
            _state_text(h, "N", "none")
            return
        slot = getattr(ad, "action_slot", None)
        slot_id = ""
        try:
            slot_id = str(getattr(slot, "identifier", "") or getattr(slot, "name_display", ""))
        except Exception:
            slot_id = ""
        _state_text(h, "N", "%s|%s" % (str(getattr(act, "name", "")), slot_id))
        try:
            curves = action_fcurves(act, slot)
        except Exception:
            curves = []
        _state_text(h, "n", str(len(curves)))
        for fcurve in curves[:64]:
            try:
                points = getattr(fcurve, "keyframe_points", None)
                count = len(points) if points is not None else 0
                _state_text(h, "C", "%s|%d" % (str(getattr(fcurve, "data_path", "")), count))
                for index in range(0, min(8, count)):
                    point = points[index]
                    _state_text(h, "c", "%.5f,%.5f" % (float(point.co[0]), float(point.co[1])))
            except Exception:
                continue
    except Exception:
        _state_text(h, "N", "unreadable")


def _state_object_sig(ob, budget):
    """单个对象签名 + 计数；返回 (sig, counts, remaining_budget)。"""
    import hashlib
    h = hashlib.sha256()
    _state_text(h, "O", "%s|%s|%s" % (getattr(ob, "name", ""), getattr(ob, "type", ""),
                                     getattr(getattr(ob, "data", None), "name", "")))
    for key in ("location", "delta_location", "rotation_euler", "rotation_quaternion",
                "scale", "delta_scale"):
        value = getattr(ob, key, None)
        if value is None:
            continue
        try:
            _state_text(h, key, ",".join("%.6f" % float(x) for x in value))
        except Exception:
            pass
    try:
        parent = getattr(ob, "parent", None)
        _state_text(h, "P", getattr(parent, "name", ""))
        _state_text(h, "M", ",".join("%.6f" % float(x) for row in ob.matrix_world for x in row))
    except Exception:
        pass
    try:
        mats = [slot.material.name if slot.material else "" for slot in ob.material_slots]
        _state_text(h, "A", ",".join(mats))
    except Exception:
        pass
    try:
        mods = []
        for mod in ob.modifiers:
            bits = [str(getattr(mod, "type", "")), str(getattr(mod, "name", ""))]
            for prop in getattr(getattr(mod, "bl_rna", None), "properties", []):
                if prop.identifier in ("rna_type", "name"):
                    continue
                if getattr(prop, "type", "") not in ("FLOAT", "INT", "BOOLEAN", "ENUM", "STRING"):
                    continue
                try:
                    bits.append("%s=%s" % (prop.identifier, _state_number(getattr(mod, prop.identifier))))
                except Exception:
                    continue
            mods.append("/".join(bits))
        _state_text(h, "D", "|".join(mods))
    except Exception:
        pass
    _state_anim_sig(ob, h)
    counts, budget = _state_mesh_sig(ob, h, budget)
    return h.hexdigest()[:8], counts, budget


def _state_mesh_sig(ob, h, budget):
    """Mesh part: counts, edit-mode-aware coords, UV signature."""
    counts = {"verts": 0, "faces": 0, "edges": 0}
    try:
        if getattr(ob, "type", "") == "MESH" and getattr(ob, "data", None) is not None:
            me = ob.data
            if str(getattr(ob, "mode", "")) == "EDIT":
                import bmesh
                bm = bmesh.from_edit_mesh(me)
                counts = {"verts": len(bm.verts), "faces": len(bm.faces), "edges": len(bm.edges)}
                _state_text(h, "T", "%d|%d|%d" % (counts["verts"], counts["faces"], counts["edges"]))
                if budget > 0 and counts["verts"] * 3 <= budget:
                    for vert in bm.verts:
                        _state_text(h, "V", "%.5f,%.5f,%.5f" % (vert.co.x, vert.co.y, vert.co.z))
                    budget -= counts["verts"] * 3
                else:
                    _state_text(h, "V", "truncated")
            else:
                counts = {"verts": len(me.vertices), "faces": len(me.polygons), "edges": len(me.edges)}
                _state_text(h, "T", "%d|%d|%d" % (counts["verts"], counts["faces"], counts["edges"]))
                if budget > 0 and counts["verts"] * 3 <= budget:
                    import array
                    co = array.array("f", [0.0]) * (counts["verts"] * 3)
                    me.vertices.foreach_get("co", co)
                    h.update(co.tobytes())
                    budget -= counts["verts"] * 3
                else:
                    _state_text(h, "V", "truncated")
            uv = getattr(me, "uv_layers", None)
            active = getattr(uv, "active", None)
            if active is not None:
                data = active.data
                step = max(1, len(data) // 2000)
                _state_text(h, "G", len(data))
                for i in range(0, len(data), step):
                    try:
                        _state_text(h, "g", "%.5f,%.5f" % (data[i].uv.x, data[i].uv.y))
                    except Exception:
                        break
    except Exception:
        _state_text(h, "E", "mesh_unreadable")
    return counts, budget

def state_probe(budget=None):
    """场景**内容签名**（变换/材质/修改器/网格拓扑与坐标），用于回执自证 '改没改'。

    与 worker 的 digest 同口径但更轻：坐标只在预算内哈希；任何读取失败都降级为
    '仍给出计数'，绝不因为一个坏对象让整次执行失败。
    """
    import bpy
    import hashlib
    import time as _time
    t0 = _time.time()
    budget = _STATE_COORD_BUDGET if budget is None else int(budget)
    h = hashlib.sha256()
    info = {"objects": 0, "meshes": 0, "verts": 0, "faces": 0, "materials": 0}
    sigs = {}
    material_sigs = {}
    object_collections = {}
    edit_mode = []
    try:
        materials = sorted(bpy.data.materials, key=lambda m: m.name)
    except Exception:
        materials = []
    for mat in materials:
        try:
            material_sigs[mat.name] = _state_material_sig(mat)
            h.update(material_sigs[mat.name].encode("utf-8"))
        except Exception:
            continue
    info["materials"] = len(material_sigs)
    try:
        objects = sorted(bpy.data.objects, key=lambda o: o.name)
    except Exception:
        objects = []
    # 坐标预算按**每对象固定上限**分（C-7）：以前是跨对象共享的递减预算，增删一个对象会让
    # 后面一批对象在 "有坐标 / truncated" 之间翻转，制造出没人动过的 changed_objects 假阳性。
    per_object = max(0, int(budget) // max(1, len(objects))) if len(objects) else 0
    coord_truncated = False
    for ob in objects:
        try:
            sig, counts, _ = _state_object_sig(ob, per_object)
            if int(counts.get("verts") or 0) * 3 > per_object:
                coord_truncated = True
        except Exception:
            sig, counts = "unreadable", {"verts": 0, "faces": 0, "edges": 0}
            coord_truncated = True
        sigs[ob.name] = sig
        h.update(sig.encode("utf-8"))
        info["objects"] += 1
        if getattr(ob, "type", "") == "MESH":
            info["meshes"] += 1
            info["verts"] += int(counts.get("verts") or 0)
            info["faces"] += int(counts.get("faces") or 0)
        if str(getattr(ob, "mode", "")) == "EDIT":
            edit_mode.append(str(ob.name))
        try:
            object_collections[ob.name] = sorted(c.name for c in ob.users_collection)
        except Exception:
            object_collections[ob.name] = []
    return {
        "state_version": state_VERSION,
        "hash": h.hexdigest()[:12],
        "objects": info["objects"],
        "meshes": info["meshes"],
        "verts": info["verts"],
        "faces": info["faces"],
        "materials": info["materials"],
        "sigs": sigs,
        "material_sigs": material_sigs,
        "object_collections": object_collections,
        "edit_mode": edit_mode,
        "truncated": bool(coord_truncated),
        "ms": int((_time.time() - t0) * 1000),
    }


def state_delta(before, after):
    """两次 state_probe 的差：changed / faces_delta / 改动对象与材质（给人看的判据）。"""
    b = before or {}
    a = after or {}
    bs = b.get("sigs") or {}
    as_ = a.get("sigs") or {}
    changed_objects = sorted(name for name in set(bs) | set(as_) if bs.get(name) != as_.get(name))
    cols = a.get("object_collections") or b.get("object_collections") or {}
    changed_collections = {
        name: sorted(cols.get(name) or []) for name in changed_objects[:50]
    }
    bm = b.get("material_sigs") or {}
    am = a.get("material_sigs") or {}
    materials_changed = sorted(name for name in set(bm) | set(am) if bm.get(name) != am.get(name))
    changed = bool(b.get("hash") and a.get("hash") and b.get("hash") != a.get("hash"))
    return {
        "changed": changed,
        "state_before": b.get("hash"),
        "state_after": a.get("hash"),
        "faces_before": int(b.get("faces") or 0),
        "faces_after": int(a.get("faces") or 0),
        "faces_delta": int(a.get("faces") or 0) - int(b.get("faces") or 0),
        "verts_delta": int(a.get("verts") or 0) - int(b.get("verts") or 0),
        "objects_delta": int(a.get("objects") or 0) - int(b.get("objects") or 0),
        "changed_objects": changed_objects[:50],
        "changed_object_collections": changed_collections,
        "changed_objects_count": len(changed_objects),
        "materials_changed": materials_changed[:20],
        "materials_changed_count": len(materials_changed),
        "edit_mode": a.get("edit_mode") or [],
        "truncated": bool(a.get("truncated") or b.get("truncated")),
    }


def selftest():
    """内核自检：JSON/单位/回执/派遣/几何/IoU —— 每条都当场验。"""
    ev = {}
    ev["j"] = j({"a": 1}) == '{"a": 1}'
    ev["flatten"] = flatten({"args": {"x": 1}, "y": 2}) == {"x": 1, "y": 2}
    ev["dispatch_unknown"] = '"unknown op"' in dispatch_table({"a": lambda: "{}"}, "nope")
    ev["dispatch_ok"] = dispatch_table({"a": lambda **k: j({"ok": True, **k})}, "a", '{"z": 3}') == '{"ok": true, "z": 3}'
    ev["api_callable"] = isinstance(Api({"dispatch": lambda o, a: '{"ok": true}'}), dict)
    ev["units_positive"] = units() > 0
    m = Api({"dispatch": lambda o, a: '{"ok": true}'})
    ev["api_call"] = m("help", {}) == {"ok": True}
    try:
        import numpy as np
        i, inter, uni = iou(np.array([[1, 0], [1, 0]]), np.array([[1, 1], [0, 0]]))
        ev["iou"] = abs(float(i) - 1.0 / 3.0) < 1e-9 and inter == 1 and uni == 3
    except Exception as e:
        ev["iou"] = "skip: %s" % str(e)[:40]
    ev["ports"] = _ports_selftest()
    ok = all(v is True for v in ev.values())
    return j({"ok": bool(ok), "version": KIT_VERSION, "evidence": ev})


# ────────────────────────────── 批量 update ──────────────────────────────
class BatchUpdates:
    """多步数据写入 + 单次 `view_layer.update()` 的显式批次工具（v2.6.1 性能）。

    用法：
        batch = _KIT.BatchUpdates()
        batch.flush()                    # 可选：起始基线
        for ob in objs: ...              # 只写数据，不 update
        batch.flush()                    # 需要读 evaluated 数据前再刷

    纪律：任何 `evaluated_get()/to_mesh()/BVH/bake/render` 之前必须 flush；
    合并 update 会减少 `depsgraph_update_post` 的触发次数（活动追踪等依赖该事件
    的代码要复核粒度是否仍够）。
    """

    def __init__(self, view_layer=None):
        import bpy
        self.vl = view_layer or bpy.context.view_layer
        self.stages = 0
        self.updates = 0

    def stage(self, fn, *args, **kwargs):
        """执行一个写入阶段（只改数据，不 update）。"""
        result = fn(*args, **kwargs)
        self.stages += 1
        return result

    def flush(self):
        """把当前批次写入推给依赖图（读 evaluated 数据前调用）。"""
        self.vl.update()
        self.updates += 1
        return self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.flush()
        return False


# ────────────────────────────── selftest evidence 归一 ──────────────────────────────
def norm_evidence(evidence):
    """把各族 selftest 的 evidence 归一成可机器判的形状（与宿主 runtime/core/selftest.ts 同口径）。

    回 {evidence_flat: {path: bool}, evidence_nonbool: {path: value}, evidence_failed: [path],
       evidence_ok: bool, evidence_shape: flat-bool|nested|list|missing}。
    只做加性归一：原 evidence 原样保留，调用方按需取用。
    """
    flat, other, failed = {}, {}, []

    def walk(value, path, depth=0):
        if depth > 8:
            return
        if isinstance(value, bool):
            flat[path] = value
            if not value:
                failed.append(path)
        elif isinstance(value, (list, tuple)):
            for i, item in enumerate(value):
                walk(item, "%s[%d]" % (path, i), depth + 1)
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(item, ("%s.%s" % (path, key)) if path else str(key), depth + 1)
        elif value is not None:
            other[path or "value"] = value

    if isinstance(evidence, dict):
        for key, item in evidence.items():
            walk(item, str(key))
    elif isinstance(evidence, (list, tuple)):
        for i, item in enumerate(evidence):
            walk(item, "[%d]" % i)
    elif isinstance(evidence, bool):
        walk(evidence, "value")
    if isinstance(evidence, (list, tuple)):
        shape = "list"
    elif isinstance(evidence, dict):
        top = list(evidence.values())
        shape = "flat-bool" if top and all(isinstance(v, bool) for v in top) else "nested"
    else:
        shape = "missing" if evidence is None else "nested"
    return {"evidence_flat": flat, "evidence_nonbool": other, "evidence_failed": failed,
            "evidence_ok": not failed, "evidence_shape": shape}

# 注册：KERNEL_BOOTSTRAP 会执行本文件 ⇒ K.dsh_kit 在任何注入路径里都存在
_K = _kernel()
_K.dsh_kit = types.SimpleNamespace(
    version=KIT_VERSION, j=j, err=err, receipt=receipt, units=units, mm=mm,
    scene_units=scene_units, api=api,
    Api=Api, register=register, flatten=flatten, dispatch_table=dispatch_table,
    objects=objects, world_tris=world_tris, bvh=bvh, iou=iou,
    action_fcurves=action_fcurves,
    find_runtime_file=find_runtime_file, RUNTIME_DOMAINS=RUNTIME_DOMAINS,
    pairwise_clearance=pairwise_clearance, selftest=selftest, kernel=_kernel, wrap_dispatch=wrap_dispatch, resolve_refs=resolve_refs, kapi=kapi, install_kernel=install_kernel, comp_tree=comp_tree, BatchUpdates=BatchUpdates,
    # 跨域端口（provider 端口倒置）：提供方 register_port，消费方 call_port / port_available
    register_port=register_port, call_port=call_port, port_available=port_available,
    port_info=port_info, port_names=port_names, ports=ports, PORT_VERSION=PORT_VERSION,
    norm_evidence=norm_evidence,
    # 反馈 4：回执自证（changed/faces_delta）走这两个纯函数
    state_probe=state_probe, state_delta=state_delta,
)