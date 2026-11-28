/** blender_see：GUI 视点捕获（viewpoint=viewport|camera|custom，mode=frame|sequence）。 */
import { vTool } from '../../contracts/tool.js'
import type { HostContext } from '../../host/context.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { renderOne } from '../../ui/cards.js'
import { resolveSession } from '../shared/session.js'
import { executeSee } from './execute.js'

function seeParameters(): Record<string, unknown> {
  return {
    mode: { type: 'string', description: 'frame（默认，单帧）| sequence（固定机位序列帧）' },
    camera: {
      type: 'string',
      description:
        'viewpoint=camera 时可选相机名；省略或 true = scene.camera。其他 viewpoint 不接受',
    },
    aspect: {
      type: 'string',
      description:
        '1:1（544/768/1024/1280）| 4:3（640/960/1280）| 16:9（1024/1152/1280，默认）。viewport/custom/sequence 用；camera 也接受（按该比例重算分辨率，不改相机）',
    },
    max_size: {
      type: 'integer',
      description:
        '固定档位，必须与 aspect 配对：1:1 544/768/1024/1280；4:3 640/960/1280；16:9 1024/1152/1280；camera 544/768/1024/1280。默认 1024。' +
        '跨档位直接 invalid_params（例：aspect=16:9 + max_size=768 被拒，768 只属于 1:1/camera），不夹取',
    },
    from: {
      type: 'json',
      description:
        '【custom】相机位置（世界坐标）："7,-7,5" / "7, -7, 5" / [7,-7,5] 都收，共 3 个数字；坏值回 invalid_params 并回显原值',
    },
    look_at: {
      type: 'json',
      description:
        '【custom】看向的点（世界坐标）："0,0,1" / "0, 0, 1" / [0,0,1] 都收，共 3 个数字',
    },
    lens: { type: 'number', description: '【custom】焦距 mm，默认 50' },
    ortho: { type: 'boolean', description: '【custom】正交投影（配合 ortho_scale）' },
    ortho_scale: { type: 'number', description: '【custom】正交尺度（贴长边），默认 10' },
    fit: {
      type: 'string',
      description:
        '【custom】自动取景 object|scene|对象名：按 bbox 一次框全（省略 from/look_at），回执带 px_per_mm',
    },
    fit_object: { type: 'json', description: '【custom】fit 别名（true/对象名/数组）' },
    clip_start: {
      type: 'number',
      description: '【custom/current/camera】近裁剪面 BU；近摄全白时调小（默认 0.1）',
    },
    full: {
      type: 'boolean',
      description: 'frame+viewport：整窗口截图（省略 area = 整窗口；固定 1024 长边）',
    },
    area: { type: 'integer', description: 'full=true 时只截某个区域（省略 = 整个窗口）' },
    shading: {
      type: 'string',
      description: '【custom/sequence】临时着色 WIREFRAME/SOLID/MATERIAL/RENDERED，出图后还原',
    },
    overlays: { type: 'boolean', description: '【custom/sequence】临时开关覆盖物，出图后还原' },
    diagnostics: {
      type: 'boolean',
      description: '【frame+custom】强制跑覆盖率/空帧诊断（默认按需）',
    },
    seconds: { type: 'number', description: '【sequence】采样时长，0.2–20 秒，默认 2' },
    fps: {
      type: 'number',
      description: '【sequence】采样频率，0.5–8，默认 4；帧数 round(seconds*fps) ≤32',
    },
    force: { type: 'boolean', description: '同画面默认不重复附图；true 强制重发' },
  }
}

function buildSeeTool(ctx: HostContext, port: number) {
  return vTool({
    name: 'blender_see',
    description:
      '【看 GUI】只服务 GUI 会话：viewpoint=viewport（当前视口）/ camera（当前帧相机）/ custom（from+look_at 自定义机位），mode=frame（默认单帧）或 sequence（固定机位序列帧，只 viewport/custom）。' +
      '固定档位 aspect=1:1（544/768/1024/1280）、4:3（640/960/1280）、16:9（1024/1152/1280），默认 16:9+1024；只给 aspect 取该比例最小档；非法值直接报错不夹取。' +
      'camera 只取当前帧求值（不改 scene.camera / 帧 / 选择 / 用户视口）；PANO 不支持、DOF/运动模糊只给 preview_only。' +
      'sequence 不执行 code、不改场景、失败不回落无头 worker。headless 渲染请用 blender_run(kind=render)。',
    parameters: seeParameters(),

    output: { schema: ANY_SCHEMA, render: renderOne },
    isConcurrencySafe: () => true,
    timeoutMs: T.see,
    async execute(args: Record<string, unknown>) {
      const ref = await resolveSession(port)
      // 保留结构化的 session_required（含 instance 线索），不再重建一个丢失上下文的失败。
      if (!ref.ok) return ref.failure
      return executeSee(ctx, port, args, ref.row)
    },
  })
}

export function registerSee(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildSeeTool(ctx, port)), 'dsh-blender-plugin: see')
}
