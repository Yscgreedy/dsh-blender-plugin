/** blender_py：在 ready 的 GUI 会话里执行 agent 写的 Python（GET /act 路径）。 */
import fs from 'node:fs'
import { BACKEND_HINT } from '../../constants.js'
import { ensureBackend } from '../../host/backend/index.js'
import { backendPost, fetchFrame, leasedText } from '../../host/http.js'
import { text } from '../../contracts/dynamic.js'
import type { HostContext } from '../../host/context.js'
import { dedupeNote, frameDedupe } from '../../utils/frame-cache.js'
import { toAttachment } from '../../utils/image.js'
import { toolError } from '../errors.js'
import { formatActText } from './envelope.js'

/**
 * 痛点1b 伴生修法：wm.read_factory_settings / wm.read_homefile 在 **GUI 会话**里会把插件
 * 连同 addon 一起重置掉 —— 现场一次就把整条 GUI 通道打死（之后只有 session_required，
 * 只能全程 headless）。它不是"禁用某个对象"，而是把 DSH Blender Bridge 一起卸掉，所以
 * 在这里拦下来：换成"逐个删除"，或改走 headless / worker（那边没有 addon 可被卸掉）。
 * 真要重置时显式传 allow_factory_reset=true。
 */
const FACTORY_RESET = /(?:wm\.)?(?:read_factory_settings|read_homefile)\s*\(/

function factoryResetGuard(code: string, file: string | null): string | null {
  let source = code
  if (!source && file) {
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch {
      return null // 读不到就交给后端报错，别用一个假理由拦下
    }
  }
  if (!FACTORY_RESET.test(source)) return null
  return (
    'script 里有 wm.read_factory_settings / wm.read_homefile：在 GUI 会话里执行会重置 Blender 并把 ' +
    'DSH Blender Bridge 一起卸掉（会话随即 addon_disconnected，只能人工在 N 面板重新 Enable + Connect）。' +
    '换成：① 逐对象清理 bpy.ops.object.select_all + bpy.ops.object.delete 或 bpy.data.batch_remove(objs)；' +
    '② 场景重置放 blender_run(kind=headless) / action=worker（那边没有 addon 可被卸掉）；' +
    '③ 确认要重置则显式传 allow_factory_reset=true。'
  )
}
/**
 * Execute code inside the GUI session's Blender. The dispatcher already
 * resolved the ready session; no path here starts a headless Blender.
 */
export async function executePy(
  ctx: HostContext,
  port: number,
  args: Record<string, unknown>,
  session: Record<string, unknown>,
): Promise<unknown> {
  if (!(await ensureBackend(port)))
    return toolError(
      'gateway_unreachable',
      'Gateway 不可用（127.0.0.1:' + String(port) + '）',
      BACKEND_HINT,
    )
  const code = String(args.code || '')
  const file = args.file ? String(args.file) : null
  if (!code && !file)
    return toolError(
      'invalid_params',
      'PY 需要 code 或 file 之一',
      '给 code（短 Python）或 file（磁盘上的 .py 脚本路径）',
    )
  const blocked = args.allow_factory_reset === true ? null : factoryResetGuard(code, file)
  if (blocked)
    return toolError('factory_reset_blocked', blocked, '改用逐对象删除，或改走 headless/worker')
  const r = await backendPost(
    port,
    '/act',
    {
      code: code,
      file: file,
      py: true,
      sessionId: String(session.id || ''),
      waitMs: Number(args.wait_ms) || 0,
    },
    180000,
  )
  const lt = leasedText(r)
  if (lt) return { text: lt }
  if (!r || r.ok !== true)
    return toolError(
      'py_error',
      'PY 执行失败 · ' + text(r.error || r.raw || 'unknown'),
      '看 traceback/stderr 修脚本；脚本可以重跑。需要后台执行时用 blender_run(kind=headless)。',
    )
  const out: Record<string, unknown> = { text: formatActText(r).join(String.fromCharCode(10)) }
  if (args.see !== false) {
    const size = Math.max(120, Math.min(1600, Number(args.max_size || 560)))
    let f
    try {
      f = await fetchFrame(port, size)
    } catch {
      return out
    }
    const dd = frameDedupe('py-see:' + String(size), f.hash, !!args.force)
    if (dd.dup) {
      out.text = text(out.text) + dedupeNote(dd.repeats)
      return out
    }
    const img = await toAttachment(ctx, f.png, 'py-see-' + String(Date.now()) + '.png')
    if (img.ref) out.image = img.ref
    out.text =
      text(out.text) +
      String.fromCharCode(10) +
      'SEE ' +
      String(size) +
      'px · ' +
      String(f.ms) +
      'ms · hash ' +
      f.hash
    if (!img.ref)
      out.text =
        text(out.text) + String.fromCharCode(10) + '⚠ 图片未回传：' + text(img.why || '未知原因')
  }
  return out
}
