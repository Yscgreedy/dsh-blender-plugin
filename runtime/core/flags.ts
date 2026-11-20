// 资产门开关与只读查询载荷
// @imports

export const GATE_FLAGS = [
  'dshbb_use_polyhaven',
  'dshbb_use_hyper3d',
  'dshbb_use_sketchfab',
  'dshbb_use_polypizza',
  'dshbb_use_hunyuan3d',
]

const REGION_CODE = [
  'import bpy, json, sys',
  'w = bpy.context.window',
  'res = []',
  'for a in bpy.context.screen.areas:',
  '    if a.type == "VIEW_3D":',
  '        r = next(x for x in a.regions if x.type == "WINDOW")',
  '        res.append({"region": [r.x, r.y, r.width, r.height], "area": [a.x, a.y, a.width, a.height], "shading": a.spaces.active.shading.type})',
  '_K = sys.modules.get("dsh_rt_kernel")',
  '_rm = None',
  'try:',
  '    _rm = _K.runtime_modules_status() if _K is not None and hasattr(_K, "runtime_modules_status") else None',
  'except Exception as _e:',
  '    _rm = {"error": str(_e)[:160]}',
  'print(json.dumps({"window": [w.width, w.height], "views": res, "runtime_modules": _rm}, ensure_ascii=False))',
].join('\n')

/**
 * 读 5 个集成开关的 python 载荷（`/commands` 用）。
 * 只读本仓 addon 的 `dshbb_use_*`（v2.3 起不再兼容旧 addon）。
 */
export const FLAGS_CODE = [
  'import bpy, json',
  's = bpy.context.scene',
  'names = ' + JSON.stringify(GATE_FLAGS),
  'flags = {}',
  'for n in names:',
  '    flags[n] = bool(getattr(s, n, None))',
  'print(json.dumps({"scene": s.name, "file": bpy.data.filepath, "flags": flags}))',
].join('\n')

export { REGION_CODE }
