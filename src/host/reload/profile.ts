/**
 * host/reload/profile：H2 的**宿主侧动作** —— 把 profile 的 cordis.patch.yml 追加一行注释，
 * 触发一次 DSH HMR 的 profile 重组合。
 *
 * 为什么必须由宿主做：DSH desktop 自带 @deepseek-ai/dsh-hmr，它监听 profile 的
 * cordis.patch.yml，文件一变就重组合整个 profile（拆旧 fiber → 拉新 fiber，宿主进程不动）。
 * Gateway 进程看不到自己的 profile，也拿不到宿主 fiber —— 所以 HTTP 面只能回 409
 * 「只有宿主能重组合」。工具面（宿主侧）能做，就落在这里。
 *
 * 为什么是「追加注释」而不是 touch：注释不参与 YAML 解析（profile 结构一个字段都不变），
 * 但文件内容/字节数变了 → 磁盘变了 → HMR 重组合。每行带 ISO 时间戳与原因，便于事后自证
 * 「这次 reload 到底写了什么」（也能从回执里原样看到）。
 *
 * 失败一律显式（返回满足 needsRestart 的回执），绝不静默假装触发过。
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** profile 的 patch 层文件名（HMR 的监听对象）。 */
export const PATCH_FILE = 'cordis.patch.yml'
/** 宿主注入的 profile 目录（DSH 启动会话时设置）。 */
export const PROFILE_DIR_ENV = 'DSH_PROFILE_DIR'
/** profile 名（与 DSH_HOME/profiles/<name> 组合）。 */
export const PROFILE_NAME_ENV = 'DSH_PROFILE'
/** DSH 主目录。 */
export const DSH_HOME_ENV = 'DSH_HOME'
/** 注释前缀：便于从痕迹里认出「这一行是插件写的」。 */
export const TRIGGER_PREFIX = '# dsh-blender reload '

export interface PatchReceipt {
  /** 真的写进去了（= HMR 有触发物） */
  ok: boolean
  /** 用到的 profile 目录（找不到为 null） */
  profileDir: string | null
  /** cordis.patch.yml 的绝对路径 */
  patchPath: string | null
  /** 追加的注释行（回执里原样回给模型） */
  comment: string | null
  /** 触发后的文件字节数 */
  bytes: number | null
  /** 一句话说明（成功说写了什么，失败说为什么） */
  note: string
  /** 失败时「为什么还得重启」（与 ReloadReport.needsRestart 同义） */
  needsRestart: string[]
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 单个候选是否像一个 profile：目录里得有 cordis.patch.yml。 */
function looksLikeProfile(dir: string): boolean {
  return isDir(dir) && existsSync(path.join(dir, PATCH_FILE))
}

/**
 * profile 目录解析（按可靠度排序，绝不猜单个文件）：
 *   1. DSH_PROFILE_DIR（宿主直接给的那一个）
 *   2. $DSH_HOME/profiles/$DSH_PROFILE
 *   3. ~/.dsh/profiles/$DSH_PROFILE
 *   4. 扫 $DSH_HOME/profiles/*，取 cordis.patch.yml 最新改动的那一个（多 profile 时的兜底）
 */
export function resolveProfileDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (p: string) => boolean = looksLikeProfile,
): string | null {
  const explicit = String(env[PROFILE_DIR_ENV] || '').trim()
  if (explicit && exists(explicit)) return explicit
  const name = String(env[PROFILE_NAME_ENV] || '').trim()
  const homeDir = String(env[DSH_HOME_ENV] || '').trim() || path.join(home, '.dsh')
  const roots = [...new Set([path.join(homeDir, 'profiles'), path.join(home, '.dsh', 'profiles')])]
  if (name) {
    for (const root of roots) {
      const candidate = path.join(root, name)
      if (exists(candidate)) return candidate
    }
  }
  for (const root of roots) {
    const picked = newestProfileDir(root)
    if (picked) return picked
  }
  return null
}

/** 目录里最新改动过 patch 层的 profile（mtime 排序，稳定）。 */
export function newestProfileDir(root: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  let best: { dir: string; mtime: number } | null = null
  for (const name of entries.sort()) {
    const dir = path.join(root, name)
    const patch = path.join(dir, PATCH_FILE)
    let mtime: number
    try {
      mtime = statSync(patch).mtimeMs
    } catch {
      continue
    }
    if (!best || mtime > best.mtime) best = { dir, mtime }
  }
  return best ? best.dir : null
}

/** 控制字符逐字符判定（0x20 以下的 ASCII 控制区 + DEL 0x7f）：别让 reason 把 YAML 注释拆成两行。 */
function isControlChar(ch: string): boolean {
  return ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f
}

/** 注释行只能是单行：reason 里的换行/控制字符压平成空格。 */
function oneLine(reason: string): string {
  return Array.from(String(reason || ''))
    .map((ch) => (isControlChar(ch) ? ' ' : ch))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * 追加一行触发注释（原子写：tmp + rename，HMR 任何时刻都读不到半截 YAML）。
 * 返回的回执里 comment 就是写进去的那一行 —— 工具面原样回给模型。
 */
export function triggerProfileHmr(
  opts: {
    dir?: string | null
    reason?: string
    now?: Date
  } = {},
): PatchReceipt {
  const dir = opts.dir === undefined ? resolveProfileDir() : opts.dir
  const fail = (note: string, need: string): PatchReceipt => ({
    ok: false,
    profileDir: dir || null,
    patchPath: dir ? path.join(dir, PATCH_FILE) : null,
    comment: null,
    bytes: null,
    note,
    needsRestart: [need],
  })
  if (!dir) {
    return fail(
      '找不到 profile 目录（DSH_PROFILE_DIR / DSH_HOME/profiles / ~/.dsh/profiles 都没有可写的 cordis.patch.yml）',
      '宿主层改动只能由 profile 重组合生效：设 DSH_PROFILE_DIR 后重试，或重启 DSH',
    )
  }
  const patchPath = path.join(dir, PATCH_FILE)
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch (e: unknown) {
    return fail(
      'profile 的 ' + PATCH_FILE + ' 读不到：' + (e instanceof Error ? e.message : String(e)),
      'profile patch 层不可写：宿主层改动只能重启 DSH',
    )
  }
  if (text.length > 1024 * 1024) {
    return fail(
      'profile 的 ' + PATCH_FILE + ' 超过 1 MiB（' + String(text.length) + ' 字节）：拒绝追加',
      'profile patch 层异常（过大）：先人工检查，再重启 DSH',
    )
  }
  const iso = (opts.now || new Date()).toISOString()
  const comment =
    TRIGGER_PREFIX + iso + ' reason=' + oneLine(opts.reason || 'blender_session action=reload')
  const next = (text.endsWith('\n') ? text : text + '\n') + comment + '\n'
  try {
    const tmp = patchPath + '.dsh-reload-tmp'
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, patchPath)
  } catch (e: unknown) {
    return fail(
      '写 profile 的 ' + PATCH_FILE + ' 失败：' + (e instanceof Error ? e.message : String(e)),
      'profile patch 层写不进去：宿主层改动只能重启 DSH',
    )
  }
  return {
    ok: true,
    profileDir: dir,
    patchPath,
    comment,
    bytes: Buffer.byteLength(next, 'utf8'),
    note:
      '已向 ' +
      patchPath +
      ' 追加触发注释（' +
      comment +
      '）：' +
      '注释不参与 YAML 解析（profile 结构不变），但磁盘变了 → dsh-hmr 会重组合 profile，' +
      '宿主进程不动、Gateway 子进程随 fiber 换代',
    needsRestart: [],
  }
}

/**
 * 把插件自己写的触发注释摘掉（只有内容完全匹配才动，用于人工回退/测试收尾）。
 * 返回是否真的改过文件。
 */
export function removeTriggerLine(patchPath: string, comment: string): boolean {
  try {
    const text = readFileSync(patchPath, 'utf8')
    const line = comment + '\n'
    if (!text.includes(line)) return false
    writeFileSync(patchPath + '.dsh-reload-tmp', text.split(line).join(''), 'utf8')
    renameSync(patchPath + '.dsh-reload-tmp', patchPath)
    return true
  } catch {
    return false
  }
}
