/**
 * 声明式 render 的 Cycles 设备前导与回执解析。
 *
 * 现场（2026-11-20 第二阶段问题 1）：`kind=render` 在 `--factory-startup` 下启动，
 * `preferences.compute_device_type` 是 `NONE`，即使 .blend 里 `scene.cycles.device='GPU'`
 * 也绑不上，静默回落 CPU（480²/128spp 3.04s/帧 vs OPTIX 0.80s/帧）。
 * 这里做三件事：
 *   1. 按 device / compute_device_type 选后端（默认 auto：OPTIX→CUDA→HIP→ONEAPI→METAL）；
 *   2. 把实际状态打印成 `DSH_RENDER {json}`，由队列解析进 result.parsed.applied；
 *   3. 绑不上 GPU 时写 warning + fell_back_to_cpu，不再静默。
 *
 * 兼容性：Python 3.11+/Blender 4.2/5.3；不依赖 GPU_PRELUDE 的 EEVEE 默认（render 尊重 caller 的 engine）。
 */
import { isRecord } from '../core/json.js'

export const RENDER_DEVICES = ['auto', 'gpu', 'cpu'] as const
export const COMPUTE_DEVICE_TYPES = [
  'AUTO',
  'OPTIX',
  'CUDA',
  'HIP',
  'ONEAPI',
  'METAL',
  'NONE',
] as const

/** 规范化 device；未知值回 'auto' 并由 Python 侧记 warning（不在这里抛，保持旧调用方可用）。 */
export function normalizeRenderDevice(value: unknown): string {
  const v = String(value === undefined || value === null ? 'auto' : value)
    .trim()
    .toLowerCase()
  return (RENDER_DEVICES as readonly string[]).includes(v) ? v : 'auto'
}

/** 规范化 compute_device_type；空/auto → ''（让 Python 按 OPTIX→… 顺序试）。 */
export function normalizeComputeDeviceType(value: unknown): string {
  const v = String(value === undefined || value === null ? '' : value)
    .trim()
    .toUpperCase()
  if (!v || v === 'AUTO' || v === 'DEFAULT') return ''
  return (COMPUTE_DEVICE_TYPES as readonly string[]).includes(v) ? v : ''
}

/**
 * render 的设备/采样前导。调用方先设 engine，再拼这段；samples 在这里按**实际 engine**落地
 * （旧实现只在显式 engine=CYCLES/EEVEE 时才设 samples；engine 省略时 samples 被静默忽略）。
 *
 * engine_requested_value / engine_alias 两个字段来自 BlenderProject 探针 09:55–10:00 的
 * 临时 patch（非本仓库原有 WIP）；本仓库在 5.3 上复测后接管，用于把“请求引擎 vs 实际引擎”
 * 写进 DSH_RENDER 回执。
 */
const RENDER_DEVICE_PY = [
  'def _dsh_render_apply():',
  '    import bpy',
  '    sc = bpy.context.scene',
  '    req = _dsh_render_request',
  '    applied = {"engine": str(sc.render.engine), "engine_requested": req["engine_requested"], "engine_requested_value": globals().get("_dsh_engine_requested"), "engine_alias": globals().get("_dsh_engine_alias"), "engine_before": globals().get("_dsh_engine_before"), "samples_requested": req["samples"], "samples": None,',
  '               "device_requested": req["device"], "compute_device_type_requested": req["compute_device_type"] or "auto",',
  '               "compute_device_type": None, "devices_used": [], "scene_device": None,',
  '               "fell_back_to_cpu": False, "warnings": []}',
  '    def _warn(code, msg):',
  '        applied["warnings"].append(code + ": " + str(msg)[:160])',
  '    try:',
  '        if str(sc.render.engine) == "CYCLES":',
  '            try:',
  '                prefs = bpy.context.preferences.addons["cycles"].preferences',
  '            except Exception as e:',
  '                prefs = None',
  '                _warn("cycles_prefs_unavailable", e)',
  '            if prefs is not None:',
  '                want_cpu = req["device"] == "cpu" or req["compute_device_type"] in ("NONE", "CPU")',
  '                want_gpu = req["device"] == "gpu" or (req["device"] == "auto" and req["compute_device_type"] not in ("NONE", "CPU"))',
  '                if req["device"] == "cpu" and req["compute_device_type"] not in ("", "NONE", "CPU"):',
  '                    _warn("device_conflict", "device=cpu overrides compute_device_type=" + req["compute_device_type"])',
  '                if want_cpu:',
  '                    sc.cycles.device = "CPU"',
  '                else:',
  '                    types = [req["compute_device_type"]] if req["compute_device_type"] else ["OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"]',
  '                    errs = []',
  '                    chosen = None',
  '                    for t in types:',
  '                        try:',
  '                            prefs.compute_device_type = t',
  '                            prefs.get_devices()',
  '                            gpus = [d for d in prefs.devices if d.type == t]',
  '                            if gpus:',
  '                                for d in prefs.devices:',
  '                                    d.use = (d.type == t)',
  '                                chosen = t',
  '                                break',
  '                        except Exception as e:',
  '                            errs.append("%s: %s" % (t, e))',
  '                    applied["tried"] = errs',
  '                    if chosen:',
  '                        sc.cycles.device = "GPU"',
  '                    else:',
  '                        try:',
  '                            prefs.compute_device_type = "NONE"',
  '                        except Exception:',
  '                            pass',
  '                        sc.cycles.device = "CPU"',
  '                        applied["fell_back_to_cpu"] = True',
  '                        _warn("gpu_unavailable", "no GPU backend available (tried " + "/".join(types) + ")")',
  '                try:',
  '                    applied["compute_device_type"] = str(prefs.compute_device_type)',
  '                except Exception:',
  '                    pass',
  '                try:',
  '                    applied["devices_used"] = sorted({str(d.name) for d in prefs.devices if d.use and d.type != "CPU"})',
  '                except Exception:',
  '                    pass',
  '                applied["scene_device"] = str(getattr(sc.cycles, "device", "") or "")',
  '                if want_gpu and applied["scene_device"] != "GPU":',
  '                    applied["fell_back_to_cpu"] = True',
  '                    if not any(w.startswith("gpu_unavailable") for w in applied["warnings"]):',
  '                        _warn("gpu_not_bound", "scene.cycles.device=" + applied["scene_device"])',
  '        else:',
  '            applied["device_applicable"] = False',
  '            if req["device"] == "gpu" or req["compute_device_type"]:',
  '                _warn("device_ignored", "engine=" + str(sc.render.engine) + " is not CYCLES")',
  '        if req["samples"] is not None:',
  '            n = int(req["samples"])',
  '            eng = str(sc.render.engine)',
  '            if eng == "CYCLES":',
  '                sc.cycles.samples = n',
  '            elif eng.startswith("BLENDER_EEVEE"):',
  '                if hasattr(sc.eevee, "taa_render_samples"):',
  '                    sc.eevee.taa_render_samples = n',
  '            else:',
  '                _warn("samples_not_applicable", "engine=" + eng)',
  '        eng = str(sc.render.engine)',
  '        if eng == "CYCLES":',
  '            applied["samples"] = int(getattr(sc.cycles, "samples", 0) or 0)',
  '        elif eng.startswith("BLENDER_EEVEE"):',
  '            applied["samples"] = int(getattr(sc.eevee, "taa_render_samples", 0) or 0)',
  '        applied["engine"] = eng',
  '        # 反馈 8-2: say where the engine came from (requested vs inherited .blend).',
  '        applied["engine_source"] = "requested" if req["engine_requested"] else "inherit"',
  '        # 引擎别名（EEVEE_NEXT ↔ EEVEE 跨版本重命名）：请求值与实际值不同必须出现在 warnings 里，',
  '        # 否则调用方会以为拿到的就是自己点的那台引擎。',
  '        if applied.get("engine_alias"):',
  '            _warn("engine_alias", "%s → %s (Blender %s)" % (applied.get("engine_requested_value"), eng, bpy.app.version_string))',
  '    except Exception as e:',
  '        _warn("apply_error", "%s: %s" % (type(e).__name__, e))',
  '    print("DSH_RENDER " + _dsh_rjson.dumps(applied, ensure_ascii=False), flush=True)',
  '_dsh_render_apply()',
]

/**
 * headless 的设备/引擎前导（C-9）：队列执行器的 headless 分支以前完全不初始化
 * Cycles 设备，`--factory-startup` 下 compute_device_type=NONE —— 脚本自己切 Cycles
 * 也只能绑到 CPU（实测 1080×1920/64spp：42.7–45.5 s/帧 vs 12.2–14.8 s/帧）。
 *
 * 与 render 的 renderDevicePrelude 不同：这里**不看当前 engine**，先把设备枚举好
 * （脚本之后再切 Cycles 也能用），并按 render 同一套字段打印 DSH_RENDER 供回执解析。
 */
const HEADLESS_DEVICE_PY: string[] = [
  'def _dsh_headless_device():',
  '    import bpy as _b',
  '    import json as _j',
  '    req = _dsh_headless_request',
  '    info = {',
  '        "engine_requested": req["engine_requested"],',
  '        "engine": None,',
  '        "engine_source": "inherit",',
  '        "samples_requested": None,',
  '        "samples": None,',
  '        "device_requested": req["device"],',
  '        "compute_device_type_requested": req["compute_device_type"] or "auto",',
  '        "compute_device_type": None,',
  '        "devices_used": [],',
  '        "scene_device": None,',
  '        "fell_back_to_cpu": False,',
  '        "warnings": [],',
  '    }',
  '',
  '    def _w(code, msg):',
  '        info["warnings"].append(code + ": " + str(msg)[:160])',
  '',
  '    try:',
  '        sc = _b.context.scene',
  '        want_engine = req["engine"]',
  '        if want_engine == "cycles":',
  '            try:',
  '                sc.render.engine = "CYCLES"',
  '                info["engine_source"] = "requested"',
  '            except Exception as e:',
  '                _w("engine_set_failed", e)',
  '        elif want_engine == "eevee":',
  '            _w("engine_eevee_headless", "eevee keeps its own defaults; device prelude only configures Cycles")',
  '        info["engine"] = str(sc.render.engine)',
  '        prefs = None',
  '        try:',
  '            prefs = _b.context.preferences.addons["cycles"].preferences',
  '        except Exception as e:',
  '            _w("cycles_prefs_unavailable", e)',
  '        want_cpu = req["device"] == "cpu" or req["compute_device_type"] in ("NONE", "CPU")',
  '        want_gpu = (not want_cpu) and (',
  '            req["device"] == "gpu" or req["device"] == "auto" or bool(req["compute_device_type"])',
  '        )',
  '        chosen = None',
  '        if prefs is not None:',
  '            types = [req["compute_device_type"]] if req["compute_device_type"] else ["OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"]',
  '            if not want_cpu:',
  '                for t in types:',
  '                    try:',
  '                        prefs.compute_device_type = t',
  '                        prefs.get_devices()',
  '                        if [d for d in prefs.devices if d.type == t]:',
  '                            for d in prefs.devices:',
  '                                d.use = d.type == t',
  '                            chosen = t',
  '                            break',
  '                    except Exception as e:',
  '                        _w("device_try_" + str(t).lower(), e)',
  '            if chosen is None:',
  '                try:',
  '                    prefs.compute_device_type = "NONE"',
  '                except Exception:',
  '                    pass',
  '                if want_gpu:',
  '                    _w("gpu_unavailable", "no GPU backend available (tried " + "/".join(types) + ")")',
  '            try:',
  '                info["compute_device_type"] = str(prefs.compute_device_type)',
  '                info["devices_used"] = sorted({str(d.name) for d in prefs.devices if d.use and d.type != "CPU"})',
  '            except Exception as e:',
  '                _w("device_report_failed", e)',
  '        if chosen is None and want_gpu:',
  '            info["fell_back_to_cpu"] = True',
  '        try:',
  '            scene_device = getattr(getattr(sc, "cycles", None), "device", None)',
  '            info["scene_device"] = None if scene_device is None else str(scene_device)',
  '            if chosen is not None and info["scene_device"] != "GPU":',
  '                sc.cycles.device = "GPU"',
  '                info["scene_device"] = "GPU"',
  '            if chosen is None and want_gpu and info["scene_device"] == "GPU":',
  '                info["fell_back_to_cpu"] = True',
  '                info["scene_device"] = "CPU"',
  '            if str(sc.render.engine) == "CYCLES":',
  '                info["samples"] = int(getattr(sc.cycles, "samples", 0) or 0)',
  '        except Exception as e:',
  '            _w("scene_device_probe_failed", e)',
  '    except Exception as e:',
  '        _w("device_probe_failed", e)',
  '    print("DSH_RENDER " + _j.dumps(info, ensure_ascii=False), flush=True)',
  '',
  '',
  '_dsh_headless_device()',
]

/** headless 的设备前导（默认 device=auto；gpu=false / device=cpu 表示只用 CPU 并如实回执）。 */
export function headlessDevicePrelude(params: Record<string, unknown>): string {
  const engineRaw = String(params.engine ?? '')
    .trim()
    .toLowerCase()
  const engine = engineRaw === 'cycle' ? 'cycles' : engineRaw
  const gpuRaw = String(params.gpu ?? '')
    .trim()
    .toLowerCase()
  const gpuOff = ['false', 'off', '0'].includes(gpuRaw)
  const device = gpuOff
    ? 'cpu'
    : params.device === undefined && (gpuRaw === 'true' || gpuRaw === 'required')
      ? 'gpu'
      : normalizeRenderDevice(params.device)
  const wantedEngine = engine === 'cycles' || engine === 'eevee' ? engine : ''
  const reqLit =
    '{' +
    '"engine": ' +
    JSON.stringify(wantedEngine) +
    ', "engine_requested": ' +
    (wantedEngine ? 'True' : 'False') +
    ', "device": ' +
    JSON.stringify(device) +
    ', "compute_device_type": ' +
    JSON.stringify(normalizeComputeDeviceType(params.compute_device_type)) +
    '}'
  return [
    'import json as _dsh_hjson',
    '_dsh_headless_request = ' + reqLit,
    ...HEADLESS_DEVICE_PY,
  ].join(String.fromCharCode(10))
}

/** render 的设备/采样前导。调用方先设 engine，再拼这段；samples 在这里按**实际 engine** 落地。 */
export function renderDevicePrelude(params: Record<string, unknown>): string {
  const req = {
    device: normalizeRenderDevice(params.device),
    compute_device_type: normalizeComputeDeviceType(params.compute_device_type),
    samples:
      params.samples === undefined || params.samples === null
        ? null
        : Math.max(1, Math.trunc(Number(params.samples) || 1)),
  }
  const reqLit =
    '{' +
    '"device": ' +
    JSON.stringify(req.device) +
    ', "compute_device_type": ' +
    JSON.stringify(req.compute_device_type) +
    ', "samples": ' +
    (req.samples === null ? 'None' : String(req.samples)) +
    ', "engine_requested": ' +
    (String(params.engine ?? '').trim() ? 'True' : 'False') +
    '}'
  return ['import json as _dsh_rjson', '_dsh_render_request = ' + reqLit, ...RENDER_DEVICE_PY].join(
    String.fromCharCode(10),
  )
}

/** 从 stdout 取最后一条 DSH_RENDER 标记（render 进程的唯一设备/采样回执）。 */
export function parseRenderDeviceMarker(stdout: string): Record<string, unknown> | null {
  const matches = String(stdout || '').match(/^DSH_RENDER (\{.*\})\r?$/gm)
  if (!matches || matches.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(matches[matches.length - 1].slice('DSH_RENDER '.length))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
