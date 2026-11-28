// Where the virtual-gui consent policy comes from (3.3.1 human panel).
//
// The model must never be able to flip this: a policy the agent can set is the
// same as no consent gate. Every source here is human-owned and read at call
// time, so an edit takes effect without restarting Blender or DSH:
//
//   1. DSH_BLENDER_VIRTUAL_GUI_CONSENT            (env; also injected by the host
//      from the profile key virtualGuiConsent when it spawns the Gateway)
//   2. DSH_BLENDER_CONSENT_POLICY_FILE            ({"mode":"auto"} read live)
//   3. virtualGuiConsent in dsh-blender.config.json (the profile config file)
//   4. default: manual
//
// Mode names are auto / manual / deny; receipts keep the 3.1 policy names
// allow / ask / deny so consent_source=policy:allow and reason=policy_denied do
// not change meaning for existing callers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_FILES, CFG } from '../../config.js'
import { isRecord } from '../../foundation/json.js'

export const CONSENT_POLICY_ENV = 'DSH_BLENDER_VIRTUAL_GUI_CONSENT'
export const CONSENT_POLICY_FILE_ENV = 'DSH_BLENDER_CONSENT_POLICY_FILE'
/** How long a policy file read is reused (an edit lands in <= this many ms). */
export const POLICY_CACHE_MS = 250
export const CONSENT_MODES = ['auto', 'manual', 'deny'] as const

export type ConsentMode = (typeof CONSENT_MODES)[number]
/** The 3.1 vocabulary that receipts already speak. */
export type ConsentPolicy = 'allow' | 'ask' | 'deny'

export interface ConsentPolicyView {
  /** auto | manual | deny */
  mode: ConsentMode
  /** allow | ask | deny (what consent_source / reason report) */
  policy: ConsentPolicy
  /** True for auto: the panel must say so, always. */
  auto: boolean
  /** env:NAME | file:<path> | default */
  source: string
  /** The file the mode came from, when it came from a file. */
  file: string | null
  /** One line a human can act on. */
  note: string
}

/** The directory that holds consent requests and the optional policy file. */
export function consentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.DSH_BLENDER_CONSENT_DIR || '').trim()
  return override || path.join(CFG.workDirWsl, 'consent')
}

/** Parse a mode name; null when the value is not a mode at all. */
export function parseConsentMode(value: unknown): ConsentMode | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (['auto', 'allow', 'allowed', 'on', 'yes', 'true', '1'].includes(raw)) return 'auto'
  if (['deny', 'denied', 'off', 'no', 'false', '0'].includes(raw)) return 'deny'
  if (['manual', 'ask', 'prompt', 'human'].includes(raw)) return 'manual'
  return null
}

export function modeToPolicy(mode: ConsentMode): ConsentPolicy {
  if (mode === 'auto') return 'allow'
  if (mode === 'deny') return 'deny'
  return 'ask'
}

interface FileRead {
  at: number
  file: string | null
  mode: ConsentMode | null
  error: string | null
}
let cachedFile: FileRead | null = null

/** Test seam: forget the cached file read. */
export function resetConsentPolicyCache(): void {
  cachedFile = null
}

function readJsonMode(file: string, key: string): ConsentMode | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return null
    const direct = parseConsentMode(parsed[key])
    if (direct) return direct
    const features = isRecord(parsed.features) ? parsed.features : null
    return features ? parseConsentMode(features[key]) : null
  } catch {
    return null
  }
}

/** Candidate policy files, highest priority first, resolved at call time. */
export function policyFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = String(env[CONSENT_POLICY_FILE_ENV] || '').trim()
  const out = explicit ? [explicit] : []
  const configEnv = String(env.DSH_BLENDER_CONFIG || '').trim()
  if (configEnv) out.push(configEnv)
  out.push(...CONFIG_FILES)
  // Profile-level plugin config next to the workdir: the same key, one more place.
  out.push(path.join(os.homedir(), '.dsh', 'dsh-blender.config.json'))
  out.push(path.join(CFG.workDirWsl, 'consent', 'policy.json'))
  return [...new Set(out.filter(Boolean))]
}

function readFilePolicy(env: NodeJS.ProcessEnv, now: number): FileRead {
  if (cachedFile && now - cachedFile.at < POLICY_CACHE_MS) return cachedFile
  const read: FileRead = { at: now, file: null, mode: null, error: null }
  for (const file of policyFiles(env)) {
    const mode = readJsonMode(file, 'virtualGuiConsent')
    if (!mode) continue
    read.file = file
    read.mode = mode
    break
  }
  cachedFile = read
  return read
}

/**
 * The effective policy. Reads env, then the policy/profile files (live), then
 * falls back to manual — the safe answer when nothing says otherwise.
 */
export function resolveConsentPolicy(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ConsentPolicyView {
  const envMode = parseConsentMode(env[CONSENT_POLICY_ENV])
  if (envMode)
    return {
      mode: envMode,
      policy: modeToPolicy(envMode),
      auto: envMode === 'auto',
      source: 'env:' + CONSENT_POLICY_ENV,
      file: null,
      note: 'set by ' + CONSENT_POLICY_ENV + ' (env or profile key virtualGuiConsent)',
    }
  const file = readFilePolicy(env, now)
  if (file.mode)
    return {
      mode: file.mode,
      policy: modeToPolicy(file.mode),
      auto: file.mode === 'auto',
      source: 'file:' + String(file.file),
      file: file.file,
      note: 'read live from ' + String(file.file) + ' (virtualGuiConsent)',
    }
  return {
    mode: 'manual',
    policy: 'ask',
    auto: false,
    source: 'default',
    file: null,
    note: 'default policy: every virtual-gui start asks the human in the session panel',
  }
}

/**
 * Persist a mode for the panel/ops to pick up (human-facing helper, also used by
 * tests). Never reachable from a model tool: see the note at the top.
 */
export function writeConsentPolicy(
  mode: ConsentMode,
  file = path.join(consentDir(), 'policy.json'),
): { ok: boolean; file: string; error: string | null } {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + String(process.pid)
    fs.writeFileSync(tmp, JSON.stringify({ virtualGuiConsent: mode }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    resetConsentPolicyCache()
    return { ok: true, file, error: null }
  } catch (e) {
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The env var, when set to a mode, wins over every file — and locks the panel. */
export interface PolicyLock {
  locked: boolean
  env: string
  value: string | null
}

export function policyLock(env: NodeJS.ProcessEnv = process.env): PolicyLock {
  const raw = String(env[CONSENT_POLICY_ENV] || '').trim()
  if (!raw) return { locked: false, env: CONSENT_POLICY_ENV, value: null }
  const mode = parseConsentMode(raw)
  return { locked: mode !== null, env: CONSENT_POLICY_ENV, value: mode }
}

/**
 * The file a panel write goes to, in the order a human would expect:
 * the explicit policy file, the configured config file, an existing plugin
 * config anywhere on the list, then ~/.dsh (created on demand).
 */
export function policyWriteTarget(env: NodeJS.ProcessEnv = process.env): {
  file: string
  exists: boolean
  from: string
} {
  const explicit = String(env[CONSENT_POLICY_FILE_ENV] || '').trim()
  if (explicit)
    return {
      file: explicit,
      exists: fs.existsSync(explicit),
      from: 'env:' + CONSENT_POLICY_FILE_ENV,
    }
  const configured = String(env.DSH_BLENDER_CONFIG || '').trim()
  if (configured)
    return { file: configured, exists: fs.existsSync(configured), from: 'env:DSH_BLENDER_CONFIG' }
  for (const file of CONFIG_FILES) {
    if (fs.existsSync(file))
      return {
        file,
        exists: true,
        from: file.startsWith(CFG.workDirWsl) ? 'workdir' : 'config-list',
      }
  }
  return {
    file: path.join(os.homedir(), '.dsh', 'dsh-blender.config.json'),
    exists: false,
    from: 'default',
  }
}

export interface PolicySetResult {
  ok: boolean
  mode: ConsentMode | null
  file: string
  backup: string | null
  previous: string | null
  created: boolean
  error: string | null
}

/**
 * Write ONE key (`virtualGuiConsent`) into the human's config file.
 *
 * This is the only write path the panel has besides approve/deny, and it exists
 * so the human can switch the policy without editing JSON by hand. Nothing else
 * in the file is touched; a .bak copy of the previous bytes is left next to it
 * before the first write of a session.
 */
export function setConsentPolicy(
  mode: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PolicySetResult {
  const target = policyWriteTarget(env)
  const parsed = parseConsentMode(mode)
  const base: PolicySetResult = {
    ok: false,
    mode: parsed,
    file: target.file,
    backup: null,
    previous: null,
    created: !target.exists,
    error: null,
  }
  if (!parsed) return { ...base, error: 'mode must be auto | manual | deny' }
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true })
    let current: Record<string, unknown> = {}
    let bytes = ''
    if (fs.existsSync(target.file)) {
      bytes = fs.readFileSync(target.file, 'utf8')
      const json: unknown = bytes.trim() ? JSON.parse(bytes) : {}
      if (!isRecord(json)) return { ...base, error: 'the config file is not a JSON object' }
      current = json
    }
    const previous =
      current.virtualGuiConsent === undefined ? null : String(current.virtualGuiConsent)
    if (previous !== null && parseConsentMode(previous) === parsed)
      return { ...base, ok: true, previous, created: false }
    let backup: string | null = null
    if (bytes) {
      backup = target.file + '.bak'
      fs.writeFileSync(backup, bytes, 'utf8')
    }
    const next = { ...current, virtualGuiConsent: parsed }
    const tmp = target.file + '.tmp-' + String(process.pid)
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, target.file)
    resetConsentPolicyCache()
    return { ...base, ok: true, previous, backup, created: !bytes }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}
