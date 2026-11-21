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
  process.env.DSH_BLENDER_CONSENT_POLICY_FILE = path.join(dir, 'policy.json')
  process.env.DSH_BLENDER_CONSENT_MIN_INTERVAL_MS = '0'
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
