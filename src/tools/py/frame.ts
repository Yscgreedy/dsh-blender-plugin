/**
 * blender_py 跑完顺手抓一帧（see=true 是默认）。
 *
 * 取帧失败不改判据：成功回执已经写好了，取不到帧就只留文本（老行为）。
 * 同画面默认不重复附图（frameDedupe），force=true 强制重发。
 */
import type { HostContext } from '../../host/context.js'
import { fetchFrame } from '../../host/http.js'
import { text } from '../../contracts/dynamic.js'
import { dedupeNote, frameDedupe } from '../../utils/frame-cache.js'
import { toAttachment } from '../../utils/image.js'

const LF = String.fromCharCode(10)

export async function withFrame(
  ctx: HostContext,
  port: number,
  args: Record<string, unknown>,
  out: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
    text(out.text) + LF + 'SEE ' + String(size) + 'px · ' + String(f.ms) + 'ms · hash ' + f.hash
  if (!img.ref) out.text = text(out.text) + LF + '⚠ 图片未回传：' + text(img.why || '未知原因')
  return out
}
