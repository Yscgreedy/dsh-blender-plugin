/**
 * 路径与常量（从 engine.mjs 外移）
 *
 * 绝对/跨 OS 路径、临时目录、addon 侧命令目录、以及 KERNEL_BOOTSTRAP 用的 PATH_HELPERS。
 * engine.mjs 具名导入并原样重导出 ⇒ 对外面逐字节不变（tmp/snap.mjs / snap_norm.mjs 对拍）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CFG, PATHS, IS_WIN, IS_MAC, blenderPath } from './config.js'
import { PATH_HELPERS_TEMPLATE } from './embedded/path-helpers.js'

/** 与 engine.mjs 同目录（runtime/） */
export const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Python 资产根：源码树里 = runtime/；构建产物里 = 包根 runtime/（lib/runtime/*.js 的上一层再上两层） */
export const PY_ROOT = (() => {
  if (fs.existsSync(path.join(HERE, 'py'))) return HERE
  const built = path.resolve(HERE, '..', '..', 'runtime')
  if (fs.existsSync(path.join(built, 'py'))) return built
  return HERE
})()

export const ADDRESS = { host: CFG.addonHost, port: CFG.addonPort }
export const WIN_TMP = CFG.workDirWin
export const WSL_TMP = CFG.workDirWsl
export const LIVE_PNG_WIN = PATHS.livePngWin
export const LIVE_PNG_WSL = PATHS.livePngWsl
/**
 * 把宿主侧路径表达成「Blender 进程侧」的形式。
 * Windows：path.win32.join（反斜杠 + 盘符）；WSL：wslToWin；macOS：identity（同机同 OS）。
 * macOS 支持：原先散落的 path.win32.join 在 mac 上会产出 \Users\... 这种垃圾串，
 * 统一收到这里，避免以后再漏。
 */
export function blenderJoin(...parts: string[]): string {
  return blenderPath(path.join(...parts))
}
/**
 * Python 领域包布局。真实实现在 runtime/py/<domain>/，**公开模块名不变**
 * （preload / module 字段照旧）。当前布局不再有扁平 runtime/<name>.py shim：
 * 每个模块（含 generator / uv_tools）都必须登记领域并落在 runtime/py/<domain>/。
 *
 * 唯一映射源是 runtime/py/modules.json —— paths.ts / offline_bootstrap.py /
 * layout 契约测试都读同一份清单，这里不再维护第二份硬编码表。
 */
interface PyModuleManifest {
  version: number
  domains: string[]
  modules: Record<string, string>
}

function loadPyModuleManifest(): PyModuleManifest {
  const file = path.join(PY_ROOT, 'py', 'modules.json')
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error('读取 Python 模块清单失败：' + file + '（' + String(e) + '）', { cause: e })
  }
  const parsed = raw as Partial<PyModuleManifest>
  const domains = Array.isArray(parsed.domains) ? parsed.domains.map(String) : []
  const modules =
    parsed.modules && typeof parsed.modules === 'object'
      ? (parsed.modules as Record<string, string>)
      : {}
  if (!domains.length || !Object.keys(modules).length) {
    throw new Error('Python 模块清单格式错误：' + file)
  }
  return { version: Number(parsed.version) || 0, domains, modules }
}

const PY_MANIFEST = loadPyModuleManifest()
export const PY_DOMAINS: string[] = PY_MANIFEST.domains
const PY_MODULE_DOMAIN: Record<string, string> = PY_MANIFEST.modules
/** 公开模块名 → runtime/py/<domain>/<name>.py（唯一登记源是 modules.json）。 */
export function pyModuleFile(name: unknown): string {
  const n = String(name == null ? '' : name)
    .trim()
    .replace(/\.py$/, '')
  const d = Object.prototype.hasOwnProperty.call(PY_MODULE_DOMAIN, n) ? PY_MODULE_DOMAIN[n] : null
  if (!d)
    throw new Error(
      '未知的 runtime Python 模块：' +
        n +
        '（modules.json 未登记；可用：' +
        pyModuleNames().join(', ') +
        '）',
    )
  return path.join(PY_ROOT, 'py', d, n + '.py')
}
/** 全部公开模块名（preload 报错时列出用；不随文件系统变化）。 */
export function pyModuleNames(): string[] {
  return Object.keys(PY_MODULE_DOMAIN).sort()
}
export function pyModuleExists(name: unknown): boolean {
  try {
    return fs.existsSync(pyModuleFile(name))
  } catch (e) {
    return false
  }
}
/** 共享内核（kit）：JSON/API 样板·单位·几何·度量·回执骨架的唯一实现 */
export const KIT_PATH = pyModuleFile('kit')
/** 几何底座（geo）：**机制层** —— 布尔/开孔/开槽/镜像/阵列/拉伸/放样/倒角/自动平滑。
 *  只给动词、不给名词（不含任何形状默认值）；与 kit 同等由 KERNEL_BOOTSTRAP 保证在场。 */
export const GEO_PATH = pyModuleFile('geo')
export const RUNNER_PATH = pyModuleFile('runner')
export const PERF_PATH = pyModuleFile('perf')
export const VIEW_PATH = pyModuleFile('view')
/** 契约层：组件/连接注册、包络/干涉/接口校验、破坏性门控、证据账本、三态判定 */
export const CONTRACT_PATH = pyModuleFile('contract')
/** 规划器：对象图 → 诊断 → 编译到 bpy → 图导出 */
export const PLANNER_PATH = pyModuleFile('planner')
export const WORKER_PATH = pyModuleFile('worker')
export const TXN_PATH = pyModuleFile('txn')
/** 内置 QC（v0.7.0）：掩膜 / IoU / 剖面 / 对照图 + 内环 measure 预置 */
export const QC_PATH = pyModuleFile('qc')
/** 渲染 harness（v0.8.8）：自动取景 + 固定三点光 + 逐张 jsonl 计时 + 预算判定 */
export const QC_RENDER_PATH = pyModuleFile('qc_render')
/** 配方库（v0.8.2）：参数组合的保存 / 套用 / 导出 */
export const PRESET_PATH = pyModuleFile('presets')
/** 网格体检（v0.9.0 接通）：audit_* 前缀 op 走这里。
 *  此前 audit.py 只存在于 preload 通道，docs 里文档化的 blender_op(op="audit_mesh") 其实没有路由。 */
export const AUDIT_PATH = pyModuleFile('audit')
/** 拼图（v0.9.0 接通）：montage op 走这里（证据分级 L2：裁切拼图给眼看的少数格） */
export const MONTAGE_PATH = pyModuleFile('montage')
/** 铰接/机构（v0.9.0）：关节实测 + 扫掠验证 + URDF/USDA 导出（motion_* 前缀 op） */
export const MOTION_PATH = pyModuleFile('motion')
/** 交付导出（v0.9.0）：单位盒归一化 + 多组 OBJ/MTL + manifest(md5)（deliver_* 前缀 op） */
export const DELIVER_PATH = pyModuleFile('deliver')
/** 生成器注册表（v0.9.0 · #18 代码化建模通道的 Blender 原生轻量版）：已归入 geometry 领域包。 */
export const GENERATOR_PATH = pyModuleFile('generator')
/** 程序化雕刻（v0.9.6 · 上游整合）：sculpt_* 前缀 op 走这里。
 *  上游两家都做不到程序化雕刻（blend-ai 自述不能模拟笔触；mcp-for-blender 没有雕刻），
 *  本模块用 numpy 位移笔刷 + 拓扑准备 + 遮罩把"雕刻"变成可复算的几何操作。 */
export const SCULPT_PATH = pyModuleFile('sculpt')
/** 网格修复闭环（v0.9.6 · 上游整合）：fix_* 前缀 op —— audit 只诊断，这里负责治。 */
export const FIX_PATH = pyModuleFile('mesh_fix')
/** UV 四件套（v0.9.6 · 上游整合）：已归入 geometry 领域包。 */
export const UV_PATH = pyModuleFile('uv_tools')
/** 制造检查（v0.9.6 · 上游整合）：print_* 前缀 op（薄壁 / 悬垂 / 壳体 / 汇总）。 */
export const PRINT_PATH = pyModuleFile('printcheck')
/** 沿路径扫掠（v0.9.6 · 上游整合）：sweep_* 前缀 op（管路/线缆/轨道 + 弯折半径先算后建）。 */
export const SWEEP_PATH = pyModuleFile('sweep')
/** 材质节点图（v0.9.6）：material_* 前缀 op —— 实测 2,732 次节点连线 / 204 个脚本在重复造轮子 */
export const MATERIAL_PATH = pyModuleFile('material')
export const ASSET_PATH = pyModuleFile('asset')
/** 渲染状态跟踪（v0.9.6）：渲染开始写磁盘标记、结束删；后端读文件秒判 busy */
export const RENDER_GUARD_PATH = pyModuleFile('render_guard')
/** 规格驱动门包（v0.9.6 · 现场反馈 #3）：一份 spec 跑完所有门（三态判定） */
export const GATE_PATH = pyModuleFile('gate')
/** 参考图量具（整合方案）：量成数字 / 裁出来放大 / 画回去 / 差分 */
export const IMG_PATH = pyModuleFile('imgtools')
/** 门标定套件：注入 8 类缺陷量门抓得住几类 + 健康基线对照 */
export const CALIB_PATH = pyModuleFile('calib')
/** 人脸比例门：landmarks → 6 个无量纲比例 → 与经典/参考比差 */
export const FACE_PATH = pyModuleFile('faceeval')
/** 人形素体（零素材）：关节坐标+半径 → Skin+Subsurf → 比例正确的假人 */
export const HUMAN_PATH = pyModuleFile('human')
/** 成对间隙门：规则表驱动的最近距离 + 互穿判定 */
export const CLEARANCE_PATH = pyModuleFile('clearance')
/** 车辆外壳：纵向剖面 → 放样成壳（解析轮眉）+ 比例门 */
export const VEHICLE_PATH = pyModuleFile('vehicle')
/** 参考图通用还原方法层：类别协议 + 通用量具/放样/拟合/分件/旋转体 */
export const SHAPE_PATH = pyModuleFile('shapegen')
/** 流水线：工件注册表 + 步骤编排 */
export const PIPELINE_PATH = pyModuleFile('pipeline')
/** 装配：manifest / 全对全分类扫描 / 合并 / 装配门 */
export const ASSEMBLY_PATH = pyModuleFile('assembly')
/** 白模：声明式 blockout + 3 视图 + GLB 导出 */
export const BLOCKOUT_PATH = pyModuleFile('blockout')
/** 角色动画：骨架体检 / pose 施加 / rest-evaluated 变形审计（anim_* 前缀 op） */
export const ANIM_PATH = pyModuleFile('anim')
/** 卡通渲染：Shader to RGB 色阶材质 + 反向外壳描边（toon_* 前缀 op） */
export const TOON_PATH = pyModuleFile('toon')
/** 同机位 QC 视觉报告（verdict-first） */
export const VISUALREPORT_PATH = pyModuleFile('visualreport')
/** 无头多视轮廓拟合（解析投影，不渲染） */
export const SHAPESOLVE_PATH = pyModuleFile('shapesolve')
/** 缺陷注入/基线回放评估（evalharness） */
export const EVALHARNESS_PATH = pyModuleFile('evalharness')
/** 曲面算法包：loft/sweep/patch/validate */
export const SURFACE_PATH = pyModuleFile('surface')
/**
 * 用户 Blender 配置目录（GPU 偏好所在）—— 无头进程默认读不到它，Cycles 会静默回落 CPU。
 * 分享版默认 null（用系统默认配置）；要继承某套配置就设 DSH_BLENDER_USER_CONFIG / 配置项 blenderUserConfig。
 */
export const USER_CONFIG_WIN = process.env.BLENDER_USER_CONFIG || CFG.blenderUserConfig || null
export const USER_SCRIPTS_WIN = process.env.BLENDER_USER_SCRIPTS || CFG.blenderUserScripts || null
/** GPU/engine prelude lives in ./embedded/gpu-prelude.ts (kept out of the 600-line budget). */
export { GPU_PRELUDE } from './embedded/gpu-prelude.js'
/** 自定义视角出图（默认覆盖写这个文件） */
export const VIEW_PNG_WIN = PATHS.viewPngWin
export const VIEW_PNG_WSL = PATHS.viewPngWsl
/** 无头 Blender 可执行文件（WSL 侧路径；spawn 走 binfmt 直接起 Windows 进程）；找不到时由工具给出配置指引 */
export const BLENDER_EXE = CFG.blenderExe
export { PKG_ROOT } from './config.js'

/** KERNEL_BOOTSTRAP 的 Python 路径辅助（模板在 ./embedded/path-helpers.ts，占位符在这里替换）。 */
export const PATH_HELPERS = PATH_HELPERS_TEMPLATE
  // macOS 与「非 WSL 的原生 POSIX」都不需要跨 OS 路径改写（Blender 与宿主同机）。
  // WSL 判据沿用工程里已有的 /mnt/c 探测，不依赖可能未导出的 WSL_DISTRO_NAME。
  .replace(
    /__DSH_NATIVE_POSIX__/g,
    IS_MAC || (!IS_WIN && !fs.existsSync('/mnt/c')) ? 'True' : 'False',
  )
  .replace(/__DISTRO__/g, JSON.stringify(process.env.WSL_DISTRO_NAME || 'Ubuntu'))
  .replace(/__OUTDIR__/g, JSON.stringify(WIN_TMP))
  .replace(/__RUNTIME_DIR__/g, JSON.stringify(HERE))
/** act wrapper lives in ./embedded/act-wrapper.ts (kept out of the 600-line budget). */
export { ACT_WRAPPER } from './embedded/act-wrapper.js'

// kit 的**内容指纹**：并入每个模块的失效判据 ⇒ 改 kit 会让所有模块在下次调用时自动重注
export const KIT_SRC = (() => {
  try {
    return fs.readFileSync(KIT_PATH, 'utf8')
  } catch (e) {
    return ''
  }
})()
export const KIT_HASH = createHash('sha256').update(KIT_SRC).digest('hex').slice(0, 12)
/**
 * geo 的口径/回执层（geo_impl/units.py）也必须能在**内联 bootstrap** 路径里被 geo.py 找到。
 *
 * 背景：KERNEL_BOOTSTRAP 把 GEO_SRC 直接嵌进脚本，此时 __file__ 指向临时 job 脚本，
 * 按路径找 geo_impl/units.py 必然 ENOENT（实测 headless 作业直接崩在加载处）。
 * 这里把源码一并带上，geo.py 优先用内联源码，文件路径只作 preload/inject 路径的兜底。
 */
export const GEO_UNITS_SRC = (() => {
  try {
    return fs.readFileSync(path.join(PY_ROOT, 'py', 'geometry', 'geo_impl', 'units.py'), 'utf8')
  } catch {
    return ''
  }
})()

export const GEO_SRC = (() => {
  try {
    return fs.readFileSync(GEO_PATH, 'utf8')
  } catch (e) {
    return ''
  }
})()
export const GEO_HASH = createHash('sha256').update(GEO_SRC).digest('hex').slice(0, 12)
