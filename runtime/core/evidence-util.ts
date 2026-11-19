import { createHash } from 'node:crypto'

/** sha256 前 12 位（内容指纹口径，全仓统一）。 */
export function sha12(buf: string | Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12)
}
