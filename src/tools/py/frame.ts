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
import { frameKey } from '../shared/frame-key.js'
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
  // C-5：去重键必须带调用方（键构造在 shared/frame-key.ts）。旧键只有尺寸，
  // A 看过的画面会让 B 收到"与上一张相同、未重复附图"，而 B 从没见过那张图 —— 去重变成"信息被吞"。
  const dd = frameDedupe(frameKey('py-see', size), f.hash, !!args.force)
  if (dd.dup) {
    out.text = text(out.text) + dedupeNote(dd.repeats)
    return out
  }
  const img = await toAttachment(ctx, f.png, 'py-see-' + String(Date.now()) + '.png')
  if (img.ref) out.image = img.ref
  // 明写"这是共享视口"：多 agent 共机时它通常停在人类上次看的位置，不是调用方机位。
  out.text =
    text(out.text) +
    LF +
    'SEE ' +
    String(size) +
    'px · ' +
    String(f.ms) +
    'ms · hash ' +
    f.hash +
    ' · 视口=共享（用户正在看的 3D 视图，不是调用方机位；要指定机位用 from/look_at 或相机名）'
  if (!img.ref) out.text = text(out.text) + LF + '⚠ 图片未回传：' + text(img.why || '未知原因')
  return out
}
