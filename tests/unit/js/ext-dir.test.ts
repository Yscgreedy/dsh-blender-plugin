import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findExtDir, findPackageRoot } from '../../../runtime/ext/ext-dir.js'

const dirs: string[] = []
function tempPkg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-dir-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"dsh-blender-plugin"}')
  return dir
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('ext install directory resolution', () => {
  it('finds the package root and runtime/ext from the built lib/runtime/ext layout', () => {
    const pkg = tempPkg()
    const runner = path.join(pkg, 'lib', 'runtime', 'ext', 'gltf_validate_runner.js')
    fs.mkdirSync(path.dirname(runner), { recursive: true })
    fs.writeFileSync(runner, '')
    expect(findPackageRoot(pathToFileURL(runner))).toBe(pkg)
    expect(findExtDir(pathToFileURL(runner))).toBe(path.join(pkg, 'runtime', 'ext'))
  })

  it('finds runtime/ext from the source runtime/ext layout', () => {
    const pkg = tempPkg()
    const runner = path.join(pkg, 'runtime', 'ext', 'gltf_validate_runner.ts')
    fs.mkdirSync(path.dirname(runner), { recursive: true })
    fs.writeFileSync(runner, '')
    expect(findPackageRoot(pathToFileURL(runner))).toBe(pkg)
    expect(findExtDir(pathToFileURL(runner))).toBe(path.join(pkg, 'runtime', 'ext'))
  })
})
