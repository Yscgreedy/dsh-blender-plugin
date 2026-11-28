/**
 * Consent requests are persisted, so a test that starts virtual-gui must not
 * write into the operator's real workDir — their panel would show rows filed by
 * a unit test (field report: a caller=h/s/a record appeared in the live panel).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ConsentSandbox {
  dir: string
  dispose: () => void
}

/** Point both consent paths at a throwaway directory for this test file. */
export function isolateConsentDir(prefix = 'dsh-consent-test-'): ConsentSandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const previousDir = process.env.DSH_BLENDER_CONSENT_DIR
  const previousFile = process.env.DSH_BLENDER_CONSENT_POLICY_FILE
  const previousInterval = process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS
  process.env.DSH_BLENDER_CONSENT_DIR = dir
  const policyFile = path.join(dir, 'policy.json')
  process.env.DSH_BLENDER_CONSENT_POLICY_FILE = policyFile
  process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS = '0'
  // 只设路径还不够：文件不存在时 resolveConsentPolicy 会继续往下找，最终读到
  // 操作者真实的 ~/.dsh/dsh-blender.config.json（本机是 virtualGuiConsent:auto），
  // manual 语义的用例就会假红。落一个 manual 锚点，让候选链在沙箱里就停住。
  fs.writeFileSync(policyFile, JSON.stringify({ virtualGuiConsent: 'manual' }), 'utf8')
  return {
    dir,
    dispose: () => {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore('DSH_BLENDER_CONSENT_DIR', previousDir)
      restore('DSH_BLENDER_CONSENT_POLICY_FILE', previousFile)
      restore('DSH_BLENDER_CONSENT_MIN_INTERVAL_MS', previousInterval)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}
