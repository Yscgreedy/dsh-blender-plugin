/**
 * 会话工作区根的取法（3.2.0-alpha.1 复测 P2）。
 *
 * 现场：不带 workdir 的相对 script_file 仍解析到 C:\Users\…\.dsh\profiles\desktop\…，
 * 因为宿主进程 cwd 不是会话工作区，而 DSH_BLENDER_WORKSPACE / DSH_WORKSPACE /
 * DSH_PROJECT_DIR 在这台机器上都没设。根必须从调用现场（exec.agent.session）来，
 * 回落到宿主 cwd 时回执要**点名**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  callerSession,
  workspaceNote,
  workspacePayload,
  workspaceRoots,
} from '../../../src/host/workspace.js'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function mk(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const NO_ENV = {} as NodeJS.ProcessEnv

describe('workspaceRoots', () => {
  it('优先取 workingDirectory 服务（用户 cd 之后跟着变）', () => {
    const project = mk('project')
    const session = { id: 's1', header: { cwd: root } }
    const ctx = { workingDirectory: { get: () => project } }
    const view = workspaceRoots({ agent: { session } }, ctx, NO_ENV)
    expect(view.roots[0]).toEqual({ path: path.resolve(project), source: 'working-directory' })
    expect(view.detected).toBe(true)
  })

  it('服务缺失时退回 Session header 的 cwd', () => {
    const project = mk('project')
    const view = workspaceRoots(
      { agent: { session: { id: 's2', header: { cwd: project } } } },
      {},
      NO_ENV,
    )
    expect(view.roots[0]).toEqual({ path: path.resolve(project), source: 'session-cwd' })
    expect(view.detected).toBe(true)
  })

  it('服务抛错或给一个不存在的目录时不拖垮解析', () => {
    const project = mk('project')
    const session = { id: 's3', header: { cwd: project } }
    const throwing = {
      workingDirectory: {
        get: () => {
          throw new Error('boom')
        },
      },
    }
    expect(workspaceRoots({ agent: { session } }, throwing, NO_ENV).roots[0].source).toBe(
      'session-cwd',
    )
    const stale = { workingDirectory: { get: () => path.join(root, 'gone') } }
    expect(workspaceRoots({ agent: { session } }, stale, NO_ENV).roots[0].source).toBe(
      'session-cwd',
    )
  })

  it('没有会话信息时依次落到工作区 env，最后才是宿主 cwd', () => {
    const fromEnv = mk('env-ws')
    const view = workspaceRoots({}, {}, { DSH_PROJECT_DIR: fromEnv } as NodeJS.ProcessEnv)
    expect(view.roots[0]).toEqual({ path: path.resolve(fromEnv), source: 'env:DSH_PROJECT_DIR' })
    expect(view.detected).toBe(true)

    const bare = workspaceRoots({}, {}, NO_ENV)
    expect(bare.roots).toHaveLength(1)
    expect(bare.roots[0]).toEqual({ path: path.resolve(process.cwd()), source: 'host-cwd' })
    expect(bare.detected).toBe(false)
    expect(workspacePayload(bare)).toBe(null)
  })

  it('callerSession 认 exec.agent.session，也认嵌套 exec.session', () => {
    const session = { id: 'x' }
    expect(callerSession({ agent: { session } })).toBe(session)
    expect(callerSession({ session })).toBe(session)
    expect(callerSession(undefined)).toBe(undefined)
  })
})

describe('workspaceNote', () => {
  it('回落时点名"未检测到会话工作区根"并给出 workdir 建议', () => {
    const bare = workspaceRoots({}, {}, NO_ENV)
    const note = workspaceNote(bare)
    expect(note).toContain('回落')
    expect(note).toContain('未检测到会话工作区根')
    expect(note).toContain('workdir=')
  })

  it('命中会话根时写清来源', () => {
    const project = mk('project')
    const view = workspaceRoots({ agent: { session: { header: { cwd: project } } } }, {}, NO_ENV)
    expect(workspaceNote(view)).toContain('来源 session-cwd')
    expect(workspaceNote(view, path.join(project, 'out'))).toContain(path.join(project, 'out'))
  })
})
