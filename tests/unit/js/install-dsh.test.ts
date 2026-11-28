import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { pkgPath } from '../../helpers/pkg'

import * as installer from '../../../scripts/install-dsh.mjs'

const tmpDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('install-dsh helpers', () => {
  it('parses link / file / version dependencies', () => {
    expect(
      installer.parseDependency({ dependencies: { 'dsh-blender-plugin': 'link:D:/w/x' } }),
    ).toMatchObject({
      kind: 'link',
      target: 'D:/w/x',
    })
    expect(
      installer.parseDependency({ dependencies: { 'dsh-blender-plugin': 'file:C:/pkgs/x' } }),
    ).toMatchObject({
      kind: 'file',
      target: 'C:/pkgs/x',
    })
    expect(
      installer.parseDependency({ dependencies: { 'dsh-blender-plugin': '3.3.0' } }),
    ).toMatchObject({
      kind: 'version',
      target: null,
    })
    expect(installer.parseDependency({ dependencies: {} })).toBe(null)
  })

  it('plans copy/remove from content hashes and never touches runtime/ext', () => {
    const previous = {
      'lib/a.js': 'h1',
      'lib/old.js': 'h2',
      'docs/old.md': 'h3',
      'runtime/ext/venv/x.txt': 'h4',
      '__pycache__/a.pyc': 'h5',
    }
    const next = { 'lib/a.js': 'h1', 'lib/b.js': 'h6' }
    const plan = installer.mergePlan(previous, next)
    expect(plan.copy).toEqual(['lib/b.js'])
    expect(plan.remove).toEqual(['docs/old.md', 'lib/old.js'])
    expect(plan.keptProtected).toEqual(['__pycache__/a.pyc', 'runtime/ext/venv/x.txt'])
    expect(installer.isProtected('runtime/ext/venv/Scripts/python.exe')).toBe(true)
    expect(installer.isProtected('lib/index.js')).toBe(false)
  })

  it('resolves a profile from DSH_HOME/profiles and rejects non-profiles', () => {
    const home = tmpDir('dsh-home-')
    const profile = path.join(home, 'profiles', 'desktop')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'plugins: []\n', 'utf8')
    fs.mkdirSync(path.join(home, 'profiles', 'empty'), { recursive: true })
    expect(
      installer.resolveProfileDir({ env: { DSH_HOME: home, DSH_PROFILE: 'desktop' }, home }),
    ).toBe(profile)
    expect(installer.resolveProfileDir({ env: { DSH_HOME: home }, home })).toBe(profile)
    expect(installer.looksLikeProfile(path.join(home, 'profiles', 'empty'))).toBe(false)
  })

  it('picks the newest Blender version dir that actually has extensions/', () => {
    const root = tmpDir('blender-root-')
    for (const version of ['5.2', '5.3']) {
      fs.mkdirSync(path.join(root, version, 'extensions', 'user_default'), { recursive: true })
    }
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    const roots = [root]
    expect(installer.pickBlenderVersionDir(roots)?.name).toBe('5.3')
    expect(installer.pickBlenderVersionDir(roots, '5.2')?.name).toBe('5.2')
    expect(installer.pickBlenderVersionDir([tmpDir('empty-blender-')])).toBe(null)
  })

  it('dry-run CLI reports the plan for a fixture profile without touching it', () => {
    const profile = tmpDir('dsh-profile-')
    const pkgDir = tmpDir('dsh-pkg-')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'plugins: []\n', 'utf8')
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      JSON.stringify(
        {
          name: 'profile',
          dependencies: { 'dsh-blender-plugin': 'file:' + pkgDir.replace(/\\/g, '/') },
        },
        null,
        2,
      ),
      'utf8',
    )
    const run = spawnSync(
      process.execPath,
      [pkgPath('scripts/install-dsh.mjs'), '--profile', profile, '--dry-run', '--json'],
      { cwd: pkgPath(), encoding: 'utf8', timeout: 120_000 },
    )
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(String(run.stdout).trim())
    expect(report.profile).toBe(profile)
    expect(report.target).toBe(pkgDir)
    expect(report.files).toBeGreaterThan(500)
    expect(report.copy).toBeGreaterThan(0)
    expect(report.dryRun).toBe(true)
    // dry-run 不落盘：fixture 里没有 manifest / lib
    expect(fs.existsSync(path.join(pkgDir, '.dsh-install-manifest.json'))).toBe(false)
  })
})
