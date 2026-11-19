import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extInstallCommand,
  extReadiness,
  type SpawnSyncLike,
} from '../../../runtime/core/plan/ext-readiness.js'

const dirs: string[] = []

function tempExt(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-'))
  dirs.push(dir)
  return dir
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('external path readiness', () => {
  it('reports both missing tools without spawning anything', () => {
    const dir = tempExt()
    const spawn = vi.fn()
    const out = extReadiness({
      extDir: dir,
      platform: 'win32',
      spawn: spawn as unknown as SpawnSyncLike,
    })
    expect(out.ok).toBe(false)
    expect(out.tools.map((t) => t.id)).toEqual(['gltf-validator', 'open3d'])
    expect(out.tools[0].ok).toBe(false)
    expect(out.tools[1].ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(out.install_all).toContain('npm run setup:ext')
    expect(out.note).toContain('npm run setup:ext')
  })

  it('is ready only when the package and the venv import both work', () => {
    const dir = tempExt()
    write(path.join(dir, 'node_modules', 'gltf-validator', 'package.json'), '{"version":"2.0.0"}')
    write(path.join(dir, 'venv', 'Scripts', 'python.exe'), '')
    const spawn = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: '0.19.0\n', stderr: '', error: null })
    const out = extReadiness({
      extDir: dir,
      platform: 'win32',
      spawn: spawn as unknown as SpawnSyncLike,
    })
    expect(out.ok).toBe(true)
    expect(out.tools[0].version).toBe('2.0.0')
    expect(out.tools[1].version).toBe('0.19.0')
    expect(spawn).toHaveBeenCalledWith(
      path.join(dir, 'venv', 'Scripts', 'python.exe'),
      ['-c', 'import open3d;print(open3d.__version__)'],
      expect.objectContaining({ timeout: 5000 }),
    )
  })

  it('keeps the import error in the receipt instead of calling it ready', () => {
    const dir = tempExt()
    write(path.join(dir, 'node_modules', 'gltf-validator', 'package.json'), '{"version":"2.0.0"}')
    write(path.join(dir, 'venv', 'bin', 'python'), '')
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      stdout: '',
      stderr: "ModuleNotFoundError: No module named 'open3d'",
      error: null,
    })
    const out = extReadiness({
      extDir: dir,
      platform: 'linux',
      spawn: spawn as unknown as SpawnSyncLike,
    })
    expect(out.ok).toBe(false)
    expect(out.tools[1].ok).toBe(false)
    expect(out.tools[1].detail).toContain('ModuleNotFoundError')
  })

  it('offers platform-specific install commands with the resolved directory', () => {
    expect(extInstallCommand('gltf-validator', '/pkg/runtime/ext', 'linux')).toBe(
      'cd "/pkg/runtime/ext" && npm i gltf-validator',
    )
    expect(extInstallCommand('open3d', '/pkg/runtime/ext', 'linux')).toContain(
      'python3 -m venv venv',
    )
    expect(extInstallCommand('open3d', 'E:\\pkg\\runtime\\ext', 'win32')).toContain(
      'venv\\Scripts\\pip install open3d',
    )
  })
})
