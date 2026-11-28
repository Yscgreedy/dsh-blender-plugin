/**
 * blender_run action=worker：持久无头内核（痛点7 + 痛点8）。
 *
 * 现状（38 号现场）：27 次 headless 作业、13 次取帧，每次都是"起一个 blender -b → 跑一次 →
 * 退出"，固定 ~2 s 冷启动；改一步看一眼就得再起一次，且没有 undo，回滚只能手工另存 .blend。
 * 后端其实早就有常驻 worker（/worker：exec/see/watch/reset + checkpoint 栈），但模型面
 * 只从 blender_op loop 的 target=session 间接用过它。
 *
 * 这个动作把它变成第一类入口：同一个进程里连续 exec、连续 see、checkpoint/revert。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BACKEND_HINT } from '../../constants.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import { digestOutcome, execOutcome } from './worker-digest.js'
import { backendPost } from '../../host/http.js'
import { workspaceRoots } from '../../host/workspace.js'
import { toAttachment } from '../../utils/image.js'
import { toolError } from '../errors.js'

const LF = String.fromCharCode(10)

const WORKER_OPS = [
  'exec',
  'digest',
  'see',
  'watch',
  'checkpoint',
  'revert',
  'checkpoints',
  'relocate',
  'reset',
  'status',
  'start',
  'stop',
  'restart',
  'list',
  'help',
] as const

function workerPayload(
  op: string,
  args: Record<string, unknown>,
  filePath = '',
): Record<string, unknown> {
  const name = text(args.session) || text(args.name) || 'default'
  const payload: Record<string, unknown> = { op, name, isolated: true }
  if (op === 'start') {
    for (const k of ['engine', 'preload', 'gpu', 'warmup', 'useUserConfig'])
      if (args[k] !== undefined && args[k] !== null) payload[k] = args[k]
    if (filePath) payload.file = filePath
    return payload
  }
  if (op === 'exec') {
    payload.code = text(args.code)
    if (filePath) payload.file = filePath
    if (args.timeout_ms) payload.timeoutMs = Number(args.timeout_ms)
    if (args.purge) payload.purgePrefix = text(args.purge)
    if (args.digest === true || String(args.digest ?? '').toLowerCase() === 'true')
      payload.digest = true
    return payload
  }
  if (op === 'digest') {
    if (filePath) payload.file = filePath
    return payload
  }
  if (op === 'relocate') {
    const spec: Record<string, unknown> = {}
    if (text(args.file)) spec.file = text(args.file)
    payload.spec = spec
    return payload
  }
  if (op === 'checkpoint' || op === 'revert' || op === 'checkpoints') {
    const spec: Record<string, unknown> = {}
    const label = text(args.label || args.checkpoint || args.name_label)
    if (label) spec.label = label
    const dir = text(args.outdir)
    if (dir) spec.dir = dir
    payload.spec = spec
    return payload
  }
  if (filePath) payload.file = filePath
  const spec = asRecord(args.spec)
  if (Object.keys(spec).length) payload.spec = spec
  else if (op === 'see' || op === 'watch') payload.spec = { width: Number(args.max_size) || 560 }
  return payload
}

/**
 * start / restart / stop 的终态行。
 *
 * 反向假回执（3.2.0-alpha.1 复测 P1a 对称面）：旧的判据是 `result.ok === true`，
 * 而 start/stop 的结果是 worker 快照（name/alive/ready/pid/port…），根本没有 ok 字段，
 * 于是**每次成功的 start / stop 都被写成 FAIL**，agent 判定"没起来/没停掉"→ 重试 →
 * 第二个 start 撞同一个端口。现在判据来自信封（body.ok），状态一律按显式字段读。
 */
function lifecycleLines(op: string, name: string, r: Record<string, unknown>): string[] {
  const lines: string[] = []
  if (op === 'start' || op === 'restart') {
    if (r.file !== undefined)
      lines.push(
        'loaded_file: ' +
          (text(r.file) || '(空场景/未保存)') +
          ' · objects=' +
          String(r.objects ?? '?'),
      )
    lines.push(
      'state: alive=' +
        String(r.alive ?? '?') +
        ' · ready=' +
        String(r.ready ?? '?') +
        ' · pid=' +
        text(r.pid || '-') +
        ' · port=' +
        text(r.port || '-') +
        (r.joined === true ? ' · joined=已在跑的同一个 start' : ''),
    )
    const warm = asRecord(r.warmup)
    if (Object.keys(warm).length)
      lines.push('warmup: ok=' + String(warm.ok ?? '?') + ' · ms=' + String(warm.ms ?? '?'))
    if (r.alive !== true || r.ready !== true)
      lines.push(
        'state: pending（进程还没到 ready —— 不是失败）',
        'next_action: blender_run(action="worker", op=status, session="' + name + '")',
      )
  }
  if (op === 'stop') {
    lines.push(
      'state: stopped=' +
        String(r.stopped ?? '?') +
        ' · was_alive=' +
        String(r.wasAlive ?? '?') +
        ' · alive=' +
        String(r.alive ?? '?') +
        (r.signaled === true ? ' · 已 SIGKILL（shutdown 超时）' : ''),
    )
    // 「stop 之后 status 还看得见旧 pid」不该靠猜：清掉的值直接写在回执里。
    const cleared = asRecord(r.cleared)
    if (Object.keys(cleared).length)
      lines.push(
        'cleared: pid=' +
          text(cleared.pid ?? '-') +
          ' · ready=' +
          String(cleared.ready ?? '?') +
          ' · 快照里 pid 已空',
      )
    if (r.wasAlive === false) lines.push('note: 本来就没在跑 —— 不是失败，不需要重试')
    else if (r.stopped !== true)
      lines.push(
        'state: stopping（进程还没退出）',
        'next_action: blender_run(action="worker", op=status, session="' + name + '")',
      )
  }
  return lines
}

function auxText(op: string, name: string, r: Record<string, unknown>, ok = true): string {
  const lines = ['WORKER ' + op + ' · ' + name + ' · ' + (ok ? 'ok' : 'FAIL')]
  if (r.error) lines.push('error: ' + text(r.error))
  lines.push(...lifecycleLines(op, name, r))
  if (r.dir) lines.push('dir: ' + text(r.dir))
  if (r.checkpoint) {
    const c = asRecord(r.checkpoint)
    lines.push(
      'checkpoint: ' +
        text(c.label) +
        ' · ' +
        text(c.path) +
        ' · objects=' +
        String(c.objects ?? '?') +
        ' · bytes=' +
        String(c.bytes ?? '?'),
    )
  }
  if (r.restored_from) {
    const c = asRecord(r.restored_from)
    lines.push('reverted to: ' + text(c.label) + ' · ' + text(c.path))
    lines.push('objects=' + String(r.objects ?? '?') + ' · file=' + text(r.file || '-'))
    // 反馈 5: the working file must come back, not stay on the checkpoint copy.
    if (r.file_changed === true)
      lines.push(
        '⚠ file_changed=true：工作文件从 ' +
          text(r.file_before || '-') +
          ' 变成 ' +
          text(r.file || '-') +
          '（之后 save 落这里）',
      )
    if (r.backup) lines.push('pre_revert 备份: ' + text(r.backup))
    if (r.relocate_error) lines.push('relocate_error: ' + text(r.relocate_error))
    if (r.next_save_goes_to) lines.push('next_save_goes_to: ' + text(r.next_save_goes_to))
  }
  if (Array.isArray(r.stack)) {
    if (!r.stack.length) lines.push('stack: (空)')
    for (const raw of r.stack) {
      const c = asRecord(raw)
      lines.push(
        '· ' +
          text(c.label) +
          ' · ' +
          text(c.path) +
          ' · objects=' +
          String(c.objects ?? '?') +
          (c.exists === false ? ' · 文件已丢失' : ''),
      )
    }
  }
  if (r.revert)
    lines.push(
      'next_revert: blender_run(action=worker, op=revert, label="' +
        text(r.revert).replace(/.*label="|".*/g, '') +
        '")',
    )
  return lines.join(LF)
}

/**
 * see/watch 回执里的取景行：成功给 applied，失败给 fit.error，note 单独一行。
 *
 * 真机反馈（task-34）：图对了，但工具文本只有尺寸/coverage，模型判断不了 fit
 * 是否生效、失败原因是什么。没有任何 fit/note 时返回空数组 —— 正文一行都不加，
 * 既有回执逐字节不变。
 */
export function workerSeeFitLines(r: Record<string, unknown>): string[] {
  const lines: string[] = []
  const fit = asRecord(r.fit)
  if (Object.keys(fit).length) {
    const kind = text(fit.kind) || '?'
    const error = text(fit.error)
    if (error) {
      lines.push('fit=' + kind + ' · fit.error=' + error)
    } else {
      const applied = Array.isArray(fit.applied)
        ? fit.applied.map((x) => text(x)).filter((x) => x)
        : []
      lines.push('fit=' + kind + ' · applied=' + (applied.length ? applied.join(',') : '-'))
    }
  }
  const note = text(r.note)
  if (note) lines.push('note: ' + note)
  return lines
}

async function withImage(
  ctx: unknown,
  body: Record<string, unknown>,
  r: Record<string, unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  const b64 = text(r.png_b64)
  const tail = workerSeeFitLines(r)
    .map((line) => LF + line)
    .join('')
  if (!b64) {
    body.text =
      text(body.text) + LF + '（无图：' + text(r.error || 'worker 没回 png_b64') + '）' + tail
    return body
  }
  const png = Buffer.from(b64, 'base64')
  const att = await toAttachment(
    ctx,
    new Uint8Array(png),
    'worker-see-' + String(Date.now()) + '.png',
  )
  if (att.ref) body.image = att.ref
  body.text =
    text(body.text) +
    LF +
    label +
    ' · ' +
    String(r.width ?? '?') +
    'x' +
    String(r.height ?? '?') +
    ' · ' +
    String(r.ms ?? '?') +
    'ms · coverage=' +
    String(r.coverage_estimate ?? '?') +
    (att.ref ? '' : ' · 图片未回传：' + text(att.why || '')) +
    tail
  return body
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\' || p.startsWith('/')
}

/** file= is a start-time input; resolve it once in the caller's workspace, never in the backend cwd. */
function resolveWorkerFile(
  raw: string,
  exec: unknown,
): { path?: string; error?: string; base?: string } {
  const given = raw.trim()
  if (!given) return {}
  if (isAbsolutePath(given)) {
    return fs.existsSync(given)
      ? { path: given }
      : { error: 'file 不存在：' + given + '（本次没有启动任何 worker）' }
  }
  const view = workspaceRoots(exec)
  const tried: string[] = []
  for (const root of view.roots) {
    const candidate = path.resolve(root.path, given)
    tried.push(candidate)
    if (fs.existsSync(candidate)) return { path: candidate, base: root.path }
  }
  return {
    error:
      'file 是相对路径且找不到：' +
      given +
      '（本次没有启动任何 worker）已尝试：' +
      tried.join(' , ') +
      ' —— 给绝对路径或传 session 所在工作区',
  }
}

function workerHelp(): string {
  return [
    'WORKER help · 持久无头内核（同一个 blender -b 进程里连续 exec/see）',
    '',
    '通用参数：',
    '  session/name   热进程名（默认 default；多个场景各用一个名字）',
    '  op             exec | digest | see | watch | checkpoint | revert | checkpoints | reset | status | start | stop | restart | list | help',
    '  digest         exec.digest=true：回 digest_before/digest_after/changed（内容哈希；auto_restore=false，不回滚）',
    '  file           .blend 路径；只在 start / restart / exec 生效，且只在启动时打开',
    '  code           worker exec 的 Python 源码（必填；script 是 submit kind=headless 的参数）',
    '  timeout_ms     exec 超时（默认 120000）',
    '  purge          exec 前清掉的模块前缀（逗号分隔）',
    '',
    'file 语义：',
    '  · worker 未启动：file= 会作为 blender -b 的启动文件打开，回执读 loaded_file/objects 自证。',
    '  · worker 已启动且文件不同：明确回 worker_file_mismatch（带 current_file/requested_file），',
    '    不静默换场景；要换文件用 op=restart file=<目标>。',
    '  · worker 已启动且文件相同：直接复用；回执仍给 loaded_file/objects。',
    '',
    'digest 语义（工单 7）：',
    '  · op=digest 取当前场景内容哈希基线（digest_scope=string[]；不改场景、不落盘）；',
    '  · exec digest=true 在执行前后各算一次：changed 用内容哈希判定，不看 mtime；',
    '  · auto_restore / restore_applied 恒 false —— 改了就是改了，要回退用 checkpoint/revert；',
    '  · kit_source 说明 K 从哪来（boot | boot-degraded | bootstrap）；checkpoint 不建、不进证据。',
    '  · evidence 字段：digest_before: string · digest_after: string · changed: boolean ·',
    '    digest_scope: string[]（实际参与哈希的域，如 objects/mesh/materials/actions）·',
    '    eval_faces_before/after/delta、eval_verts_before/after（depsgraph 评估计数，与 base faces 并列）·',
    '    frame_before/after（单独回报，不计入 changed）· modifiers_after: array ·',
    '    digest_ms: number（本次哈希耗时）· digest_limited: boolean（触顶/截断，不作交付指纹）·',
    '    restore_applied: boolean · kit_source: string · elapsed_ms: number · auto_restore: boolean ·',
    '    worker: {session: string, file: string|null}（file=null 表示 factory startup）。',
    '  schema: {"digest_before":{"type":"string"},"digest_after":{"type":"string"},"changed":{"type":"boolean"},"digest_scope":{"type":"array"},"restore_applied":{"type":"boolean"},"kit_source":{"type":"string"},"elapsed_ms":{"type":"number"},"auto_restore":{"type":"boolean"},"worker":{"type":"object"}}',
    '',
    'checkpoint / revert / checkpoints：',
    '  · checkpoint 把当前场景另存为文件级快照，label 命名，outdir 可指定；',
    '  · revert label="last" 回上一档，或 label=<名字> 回指定档；',
    '  · revert 是整份 .blend 回滚，会丢掉快照之后的改动；checkpoints 列出栈（含文件丢失标记）。',
    '',
    'see / watch 的 spec 字段：',
    '  {width,height,from:[x,y,z],look_at:[x,y,z],lens,ortho,ortho_scale,fit,fit_margin,shading,seconds,fps,frames,code}',
    '  · fit：object | scene | <对象名>（按对象世界 bbox 自动取景；ortho 时连 ortho_scale 一起补）；',
    '  · 显式 from/look_at 优先，fit 只补缺失项；fit 失败不中断出图：回执带 note + fit.error；',
    '  · shading：WIREFRAME | SOLID | MATERIAL | RENDERED；',
    '  · watch 可先跑 spec.code，再按 frames/fps 出帧序列；',
    '  · see 回 png_b64 + width/height/ms/coverage_estimate。',
    '',
    '错误码：worker_file_mismatch（文件不同）、worker_file_unverified（读不到当前文件）、worker_error。',
  ].join(LF)
}

export async function executeWorker(
  ctx: unknown,
  port: number,
  args: Record<string, unknown>,
  exec?: unknown,
): Promise<unknown> {
  const op = (text(args.op) || 'status').trim()
  if (!(WORKER_OPS as readonly string[]).includes(op))
    return toolError('invalid_params', '未知 worker op：' + op, '可用：' + WORKER_OPS.join(' | '))
  if (op === 'help') return { text: workerHelp() }
  const name = text(args.session) || text(args.name) || 'default'
  const code = text(args.code)
  const script = text(args.script)
  if (op === 'exec' && !code.trim()) {
    if (script.trim())
      return toolError(
        'invalid_params',
        'worker op=exec 需要 code；收到的是 script',
        'script 是 submit kind=headless 的参数；worker exec 请把 Python 源码放进 code',
      )
    return toolError(
      'invalid_params',
      'worker op=exec 需要 code',
      '给 Python 源码；长任务用 code 里 print("HEADLESS {json}")',
    )
  }
  let filePath = ''
  if (op === 'exec' || op === 'digest' || op === 'start' || op === 'restart') {
    const resolved = resolveWorkerFile(text(args.file), exec)
    if (resolved.error)
      return toolError(
        'input_missing',
        resolved.error,
        '给绝对路径，或让 session 工作区能解析到该 .blend',
      )
    filePath = resolved.path || ''
  }
  let body: Record<string, unknown>
  try {
    body = await backendPost(port, '/worker', workerPayload(op, args, filePath), 300000)
  } catch (e: unknown) {
    return toolError(
      'gateway_unreachable',
      'WORKER ' + op + ' 失败 · ' + text(e instanceof Error ? e.message : e),
      BACKEND_HINT,
    )
  }
  const result = asRecord(body.result)
  // 判据只看信封：start/stop 的 result 是 worker 快照，从来没有 ok 字段。
  const ok = body.ok === true && result.ok !== false
  if (!ok && !result.png_b64)
    return toolError(
      text(body.code || 'worker_error'),
      'WORKER ' + op + ' 失败 · ' + text(result.error || body.error || body.raw || 'unknown'),
      text(body.fix) ||
        'op=status 看 worker 状态；必要时 op=restart 换干净进程（进程隔离：脚本脏了就重启）',
    )
  const beats = Number(body.__heartbeats) || 0
  const slow =
    beats > 0
      ? LF + 'note: 服务端在等待期间写了 ' + String(beats) + ' 次心跳（>15s 才到终态），不是失败'
      : ''
  if (op === 'digest') return digestOutcome(name, result, ok)
  if (op === 'exec') return execOutcome(name, result)
  if (op === 'see' || op === 'watch')
    return withImage(ctx, { text: 'WORKER ' + op + ' · ' + name }, result, op)
  if (op === 'status' || op === 'list')
    return {
      text: 'WORKER ' + op + LF + JSON.stringify(body.result ?? body, null, 1).slice(0, 6000),
    }
  return { text: auxText(op, name, result, ok) + slow }
}
