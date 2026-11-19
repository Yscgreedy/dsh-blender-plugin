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
import { BACKEND_HINT } from '../../constants.js'
import { asRecord, text } from '../../contracts/dynamic.js'
import { backendPost } from '../../host/http.js'
import { toAttachment } from '../../utils/image.js'
import { toolError } from '../errors.js'

const LF = String.fromCharCode(10)

const WORKER_OPS = [
  'exec',
  'see',
  'watch',
  'checkpoint',
  'revert',
  'checkpoints',
  'reset',
  'status',
  'start',
  'stop',
  'restart',
  'list',
] as const

function workerPayload(op: string, args: Record<string, unknown>): Record<string, unknown> {
  const name = text(args.session) || text(args.name) || 'default'
  const payload: Record<string, unknown> = { op, name, isolated: true }
  if (op === 'start') {
    for (const k of ['engine', 'preload', 'gpu', 'warmup', 'useUserConfig'])
      if (args[k] !== undefined && args[k] !== null) payload[k] = args[k]
    return payload
  }
  if (op === 'exec') {
    payload.code = text(args.code)
    if (args.timeout_ms) payload.timeoutMs = Number(args.timeout_ms)
    if (args.purge) payload.purgePrefix = text(args.purge)
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
  const spec = asRecord(args.spec)
  if (Object.keys(spec).length) payload.spec = spec
  else if (op === 'see' || op === 'watch') payload.spec = { width: Number(args.max_size) || 560 }
  return payload
}

function execText(name: string, r: Record<string, unknown>): string {
  const out = asRecord(r.result)
  const lines = [
    'WORKER exec · ' +
      name +
      ' · ' +
      (r.ok === true ? 'ok' : 'FAIL') +
      ' · ' +
      String(r.ms ?? '?') +
      'ms',
  ]
  if (r.error) lines.push('error: ' + text(r.error))
  if (out && Object.keys(out).length) lines.push('result: ' + JSON.stringify(out).slice(0, 4000))
  const so = text(r.stdout || '').trim()
  if (so) lines.push('stdout:', so.slice(-4000))
  const tb = text(r.traceback || '').trim()
  if (tb) lines.push('traceback:', tb.slice(-2000))
  return lines.filter(Boolean).join(LF)
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

async function withImage(
  ctx: unknown,
  body: Record<string, unknown>,
  r: Record<string, unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  const b64 = text(r.png_b64)
  if (!b64) {
    body.text = text(body.text) + LF + '（无图：' + text(r.error || 'worker 没回 png_b64') + '）'
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
    (att.ref ? '' : ' · 图片未回传：' + text(att.why || ''))
  return body
}

export async function executeWorker(
  ctx: unknown,
  port: number,
  args: Record<string, unknown>,
): Promise<unknown> {
  const op = (text(args.op) || 'status').trim()
  if (!(WORKER_OPS as readonly string[]).includes(op))
    return toolError('invalid_params', '未知 worker op：' + op, '可用：' + WORKER_OPS.join(' | '))
  const name = text(args.session) || text(args.name) || 'default'
  if (op === 'exec' && !text(args.code).trim())
    return toolError(
      'invalid_params',
      'worker op=exec 需要 code',
      '给 Python 源码；长任务用 code 里 print("HEADLESS {json}")',
    )
  let body: Record<string, unknown>
  try {
    body = await backendPost(port, '/worker', workerPayload(op, args), 300000)
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
      'worker_error',
      'WORKER ' + op + ' 失败 · ' + text(result.error || body.error || body.raw || 'unknown'),
      'op=status 看 worker 状态；必要时 op=restart 换干净进程（进程隔离：脚本脏了就重启）',
    )
  const beats = Number(body.__heartbeats) || 0
  const slow =
    beats > 0
      ? LF + 'note: 服务端在等待期间写了 ' + String(beats) + ' 次心跳（>15s 才到终态），不是失败'
      : ''
  if (op === 'exec') return { text: execText(name, result) }
  if (op === 'see' || op === 'watch')
    return withImage(ctx, { text: 'WORKER ' + op + ' · ' + name }, result, op)
  if (op === 'status' || op === 'list')
    return {
      text: 'WORKER ' + op + LF + JSON.stringify(body.result ?? body, null, 1).slice(0, 6000),
    }
  return { text: auxText(op, name, result, ok) + slow }
}
