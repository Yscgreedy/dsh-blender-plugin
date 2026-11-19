/**
 * Path preflight field report: blender_run(kind=headless, script_file="out/x/step1.py") was
 * resolved against the Gateway process cwd (the DSH profile dir), and file= (.blend)
 * was never checked at all — so Blender started first and only then refused the
 * missing file. Both are resolved/validated here, before any process exists.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  inputPathBaseList,
  inputPathBases,
  isAbsoluteInput,
  resolveExistingInput,
} from '../../../runtime/execution/input-paths.js'

let root = ''
let workspace = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p2-'))
  workspace = path.join(root, 'ws')
  fs.mkdirSync(path.join(workspace, 'out'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'out', 'step1.py'), 'print(1)\n')
  fs.writeFileSync(path.join(workspace, 'scene.blend'), 'x')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('input path preflight （痛点2）', () => {
  it('resolves a relative script against the explicit workdir first', () => {
    const bases = inputPathBases(workspace)
    expect(bases[0]).toBe(path.resolve(workspace))
    expect(resolveExistingInput('out/step1.py', bases, 'script_file')).toBe(
      path.join(workspace, 'out', 'step1.py'),
    )
  })

  it('falls back to a workspace env var when workdir is absent', () => {
    const bases = inputPathBases(undefined, {
      DSH_BLENDER_WORKSPACE: workspace,
    } as NodeJS.ProcessEnv)
    expect(resolveExistingInput('scene.blend', bases, 'file')).toBe(
      path.join(workspace, 'scene.blend'),
    )
  })

  it('puts the caller session workspace right after workdir and names every tier', () => {
    // 3.2.0-alpha.1 复测：三个工作区 env 在 Gateway 进程里都是空的，"工作区环境变量"那一档
    // 等于不存在；调用方的会话工作区必须能从入参显式传进来，并排在 env 与 cwd 之前。
    const envWs = path.join(root, 'env-ws')
    fs.mkdirSync(envWs, { recursive: true })
    const list = inputPathBaseList(
      undefined,
      { DSH_PROJECT_DIR: envWs } as NodeJS.ProcessEnv,
      workspace,
    )
    expect(list[0]).toEqual({ path: path.resolve(workspace), source: 'session-workspace' })
    expect(list[1]).toEqual({ path: path.resolve(envWs), source: 'env:DSH_PROJECT_DIR' })
    expect(list[list.length - 1].source).toBe('gateway-cwd')
    expect(resolveExistingInput('out/step1.py', list, 'script_file')).toBe(
      path.join(workspace, 'out', 'step1.py'),
    )
    // 显式 workdir 仍然压过会话工作区
    const explicit = path.join(root, 'explicit')
    fs.mkdirSync(path.join(explicit, 'out'), { recursive: true })
    fs.writeFileSync(path.join(explicit, 'out', 'step1.py'), 'print(2)\n')
    const withWork = inputPathBaseList(explicit, {} as NodeJS.ProcessEnv, workspace)
    expect(resolveExistingInput('out/step1.py', withWork, 'script_file')).toBe(
      path.join(explicit, 'out', 'step1.py'),
    )
  })

  it('fails before spawning and lists every base it tried', () => {
    const bases = inputPathBases(workspace)
    let caught: unknown = null
    try {
      resolveExistingInput('out/missing.py', bases, 'script_file')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeTruthy()
    const err = caught as { code?: string; stage?: string; evidence?: Record<string, unknown> }
    expect(err.code).toBe('input_missing')
    expect(err.stage).toBe('config')
    const tried = err.evidence?.tried as string[]
    expect(tried[0]).toBe(path.join(workspace, 'out', 'missing.py'))
    expect(tried.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects a missing absolute path instead of trusting it', () => {
    const bases = inputPathBases(workspace)
    const missing = path.join(root, 'nope.blend')
    expect(() => resolveExistingInput(missing, bases, 'file')).toThrowError(/不存在/)
  })

  it('keeps an existing absolute path as given', () => {
    const bases = inputPathBases(workspace)
    const abs = path.join(workspace, 'scene.blend')
    expect(resolveExistingInput(abs, bases, 'file')).toBe(abs)
  })

  it('recognises both Windows and POSIX absolute forms', () => {
    expect(isAbsoluteInput('D:\\work\\a.py')).toBe(true)
    expect(isAbsoluteInput('\\\\server\\share\\a.blend')).toBe(true)
    expect(isAbsoluteInput('/home/me/a.py')).toBe(true)
    expect(isAbsoluteInput('out/a.py')).toBe(false)
  })
})
