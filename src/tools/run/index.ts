/** blender_run：唯一作业入口（render / headless 有界队列）。 */
import { vTool } from '../../contracts/tool.js'
import type { HostContext } from '../../host/context.js'
import { ANY_SCHEMA } from '../schema-diagnostic.js'
import { T } from '../../constants.js'
import { renderOne } from '../../ui/cards.js'
import { executeRun } from './execute.js'

const ACTIONS = [
  'submit',
  'status',
  'wait',
  'collect',
  'cancel',
  'list',
  'perf',
  'tune',
  'worker',
  'help',
]

const CHANNELS_DESCRIPTION =
  'render：渲染通道数组，允许 render | alpha | mask | ink（默认 ["render"]）。' +
  '每通道回执给路径 + foreground_px/coverage/n_components/bbox；缺 ink 对象时该通道 skipped、整体 verdict=degraded（不是失败）。' +
  '帧区间与命令行不变，只是渲染完多一步 numpy 收尾'

/** 设备参数单独抽出来，避免 buildRunTool 越过 120 行硬限。 */
const RENDER_DEVICE_PARAMS = {
  device: {
    type: 'string',
    description: 'render：auto（默认，能绑 GPU 就绑）/ gpu / cpu；只对 CYCLES 有意义',
  },
  compute_device_type: {
    type: 'string',
    description: 'render：OPTIX / CUDA / HIP / ONEAPI / METAL / NONE（auto 默认按此顺序试）',
  },
}

/** `blender_run` 的参数表（抽到函数外：buildRunTool 有 120 行硬限）。 */
const RUN_PARAMETERS = {
  action: {
    type: 'string',
    description: ACTIONS.join(' | ') + '（默认：带 kind 则 submit，否则 list）',
  },
  kind: { type: 'string', description: 'submit：render（声明式渲染）| headless（跑脚本）' },
  id: { type: 'string', description: 'status/wait/collect/cancel 的 jobId' },
  priority: {
    type: 'integer',
    description: 'submit：队列优先级（-100..100，默认 0；越大越优先）',
  },
  timeout_ms: {
    type: 'integer',
    description: 'wait：等待上限毫秒（默认 120000，最大 600000，超时不取消）；headless：进程上限',
  },
  tail: { type: 'integer', description: 'collect：日志尾部字符数，默认 4000' },
  state: {
    type: 'string',
    description: 'list：按状态过滤 queued/assigned/running/completed/failed/canceled',
  },
  owner: {
    type: 'string',
    description:
      'list：会话过滤。me（默认，只列本会话）/ all（全部会话）/ <DSH session id>；子代理有独立 session id',
  },
  limit: {
    type: 'integer',
    description: 'list：本页条数（默认 20，最大 200；0 = 不分页）',
  },
  offset: { type: 'integer', description: 'list：跳过多少条（翻页）' },
  since_ms: { type: 'integer', description: 'list：只列 createdAt 不早于该时间戳的作业' },
  file: {
    type: 'string',
    description:
      'render/headless：.blend 路径；worker：start/restart/exec 的启动文件（只在 worker 启动时打开；已启动且文件不同会回 worker_file_mismatch）',
  },
  output: { type: 'string', description: 'render：输出文件模板（如 //render/frame_####）' },
  outdir: { type: 'string', description: 'render/headless：输出目录' },
  frames: {
    type: 'json',
    description: 'render：帧区间 [start,end]、"1-10" 或单帧 5；给了区间自动加 -a（相机动画）',
  },
  resolution: { type: 'json', description: 'render：[width,height]' },
  samples: {
    type: 'integer',
    description: 'render：采样数（Cycles samples / EEVEE taa_render_samples）',
  },
  engine: {
    type: 'string',
    description: 'render/headless：渲染引擎（CYCLES / BLENDER_EEVEE_NEXT / BLENDER_WORKBENCH）',
  },
  format: { type: 'string', description: 'render：图片格式（PNG/JPEG/OPEN_EXR…）' },
  camera: { type: 'string', description: 'render：camera=true 用场景相机，或相机对象名' },
  ...RENDER_DEVICE_PARAMS,
  channels: { type: 'json', description: CHANNELS_DESCRIPTION },
  script: {
    type: 'string',
    description:
      'headless：Python 脚本内容（--python 临时文件）；worker exec 用 code，script 会被拒绝',
  },
  code: {
    type: 'string',
    description:
      'worker exec：Python 源码（必填；与 headless 的 script 不是同一个参数。长任务在 code 里 print("HEADLESS {json}")）',
  },
  script_file: { type: 'string', description: 'headless：磁盘上的 .py 脚本路径' },
  preload: { type: 'string', description: 'headless：预载模块（逗号分隔）' },
  factory_startup: { type: 'boolean', description: 'headless：--factory-startup（默认 true）' },
  bootstrap: { type: 'boolean', description: 'headless：是否注入持久内核 K（默认 true）' },
  workdir: { type: 'string', description: 'headless：chdir + sys.path 首位' },
  include_noise: { type: 'boolean', description: 'headless：产物清单是否含噪音文件' },
  out_json: { type: 'string', description: 'headless：结构化结果落盘路径' },
  args: {
    type: 'json',
    description:
      'headless：追加到 -- 之后的命令行参数（string 按空白/引号分词，或 string[]；两条路都到 sys.argv）；tune：参数对象',
  },
  env: {
    type: 'json',
    description:
      'headless：子进程环境变量 {KEY:"VALUE"}（真透传；回执 provenance.env 列出注入的键）',
  },
  op: {
    type: 'string',
    description:
      'tune：status | analyze | apply | revert | help；worker：exec | digest | see | watch | checkpoint | revert | checkpoints | reset | status | start | stop | restart | list | help（默认 status）',
  },
  digest: {
    type: 'boolean',
    description:
      'worker exec：执行前后各算一次场景内容哈希（changed 不看 mtime；auto_restore=false 不回滚）',
  },
  session: {
    type: 'string',
    description: 'worker：热进程名（默认 default；多个场景并行时各用一个名字）',
  },
  label: {
    type: 'string',
    description: 'worker checkpoint/revert：档位名（revert 可给 last）',
  },
  purge: { type: 'string', description: 'worker exec：热重载前清掉的模块前缀（逗号分隔）' },
  spec: {
    type: 'json',
    description:
      'worker see/watch：{width,height,from,look_at,lens,shading,seconds,fps,frames,code}',
  },
}

function buildRunTool(ctx: HostContext, port: number) {
  return vTool({
    name: 'blender_run',
    description:
      '【作业 / 渲染】唯一作业入口：submit 立即返回 jobId；status/wait/collect/cancel/list/perf 观察。' +
      'kind=render 是声明式最终渲染（相机/帧/分辨率/采样/引擎/输出，不收 script）；kind=headless 是 fresh blender -b 跑脚本（script/script_file/file/outdir/workdir/preload/args/env）。' +
      '队列有界 pending 64、GPU 1、CPU 2，满则 QUEUE_FULL；wait 默认 120s、上限 600s（超时不取消）。' +
      'action=worker 是持久无头内核：同一常驻进程连续 exec/see/watch，并用 checkpoint/revert/checkpoints 做文件级 undo（不再每次冷启动，也不用手工另存 .blend）。' +
      'action=tune 是旧 Cycles 分析。旧工具迁移：blender_rt_headless / blender_rt_job → submit；blender_rt_perf → tune。',

    parameters: RUN_PARAMETERS,
    output: { schema: ANY_SCHEMA, render: renderOne },
    isConcurrencySafe: () => false,
    timeoutMs: T.headless,
    async execute(args: Record<string, unknown>, exec?: unknown) {
      // exec 带的是调用方身份（agent.session）：相对路径要按**会话工作区**绝对化，
      // 而不是宿主进程 cwd（= DSH profile 目录，见 host/workspace.ts）。
      return executeRun(ctx, port, args, exec)
    },
  })
}

export function registerRun(ctx: HostContext, port: number): void {
  ctx.effect(() => ctx.tools.register(buildRunTool(ctx, port)), 'dsh-blender-plugin: run')
}
