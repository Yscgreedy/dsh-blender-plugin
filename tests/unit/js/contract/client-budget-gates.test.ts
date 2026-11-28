import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { pkgPath } from '../../../helpers/pkg'

const SCRIPT = pkgPath('scripts', 'check-client-budget.mjs')
const CLIENT = pkgPath('src', 'client', 'index.js')
const PKG = pkgPath('package.json')

/** 与脚本同一口径：按 \n 切，含末尾换行形成的空段（与 check-structure 的行预算一致）。 */
function clientLines(): number {
  return fs.readFileSync(CLIENT, 'utf8').split(/\r?\n/).length
}

function run(env: Record<string, string> = {}) {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env }
  if (!('DSH_CLIENT_LINE_CEILING' in env)) delete merged.DSH_CLIENT_LINE_CEILING
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: pkgPath(),
    encoding: 'utf8',
    env: merged,
  })
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

describe('check-client-budget gate', () => {
  it('passes at the ratchet ceiling and reports the current line count', () => {
    const lines = clientLines()
    const { status, stdout } = run()
    expect(status).toBe(0)
    expect(stdout).toContain('PASS')
    // 天花板即当前值：默认没有余量，加一行就得先抬天花板。
    expect(stdout).toContain('src/client/index.js ' + lines + '/' + lines + ' 行')
  })

  it('fails when the ceiling is set below the file', () => {
    const lines = clientLines()
    const { status, stderr } = run({ DSH_CLIENT_LINE_CEILING: '10' })
    expect(status).not.toBe(0)
    expect(stderr).toContain('FAIL')
    expect(stderr).toContain(lines + '/10')
    expect(stderr).toContain('降回来或改天花板')
  })

  it('fails closed when the ceiling override is not a positive integer', () => {
    const { status, stderr } = run({ DSH_CLIENT_LINE_CEILING: 'many' })
    expect(status).not.toBe(0)
    expect(stderr).toContain('必须是正整数')
  })

  it('stays wired into lint right after check-ports, and has a named script', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8')) as { scripts: Record<string, string> }
    const steps = pkg.scripts.lint.split('&&').map((step) => step.trim())
    const budgetAt = steps.indexOf('node scripts/check-client-budget.mjs')
    const portsAt = steps.indexOf('node scripts/check-ports.mjs')
    expect(portsAt).toBeGreaterThan(-1)
    expect(budgetAt).toBe(portsAt + 1)
    expect(pkg.scripts['check:client-budget']).toBe('node scripts/check-client-budget.mjs')
  })
})
