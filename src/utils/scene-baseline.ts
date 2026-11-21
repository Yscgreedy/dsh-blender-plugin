/**
 * 每个会话上一次调用结束时的场景指纹（C-6）。
 *
 * 为什么需要：state_probe 的 state_before/after 只描述**本次调用窗口**；两次调用之间
 * 场景被别的 agent 或人改了，调用方从回执上看不出来（现场：faces 92567 → 92439 → 90547，
 * 而 before/after 各自都成立）。
 *
 * 存储是宿主进程内存（best effort）：进程重启 / 换宿主后第一次调用不报 drift，
 * 不会编造一个"上次"。MULTI-AGENT 下每个 agent 有独立 dshSessionId，键取 session id。
 */
export interface SceneBaseline {
  hash: string
  faces: number | null
  at: number
}

const BASELINES = new Map<string, SceneBaseline>()
const MAX_SESSIONS = 64

export interface SceneDrift {
  /** 上一次调用结束时的指纹 */
  from: string
  /** 本次调用开始时的指纹（与 from 不同） */
  to: string
  /** 上一次结束时的面数，便于判断规模变化 */
  facesBefore: number | null
  /** 上一次调用的时间（ms epoch） */
  at: number
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 本次 before 与上一次 after 不一致 ⇒ 返回 drift（没有人改过时不返回）。 */
export function checkSceneDrift(
  sessionId: unknown,
  before: unknown,
  facesBefore: unknown,
  now = Date.now(),
): SceneDrift | null {
  const key = String(sessionId || '')
  const hash = typeof before === 'string' ? before : ''
  const last = BASELINES.get(key)
  if (!key || !hash || !last || last.hash === hash) return null
  void now
  return { from: last.hash, to: hash, facesBefore: last.faces, at: last.at }
}

/** 记下这次调用结束时的指纹；没有 state_after（超时 / 老后端）就不更新。 */
export function rememberScene(
  sessionId: unknown,
  after: unknown,
  facesAfter: unknown,
  now = Date.now(),
): void {
  const key = String(sessionId || '')
  const hash = typeof after === 'string' ? after : ''
  if (!key || !hash) return
  BASELINES.delete(key)
  BASELINES.set(key, { hash, faces: num(facesAfter), at: now })
  while (BASELINES.size > MAX_SESSIONS) {
    const oldest = BASELINES.keys().next().value
    if (oldest === undefined) break
    BASELINES.delete(oldest)
  }
}

/** 测试用：清空基线。 */
export function resetSceneBaselines(): void {
  BASELINES.clear()
}
