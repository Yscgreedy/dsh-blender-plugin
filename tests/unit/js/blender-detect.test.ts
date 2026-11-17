import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectBlenderExe } from '../../../runtime/blender-detect.js'
import type { BlenderDetectDeps } from '../../../runtime/blender-detect.js'

// （报告 §3.1）：Windows 上 Blender 只装在 Steam 里时，detectBlenderExe
// 必须能找到它；本机故障现场就是 D:\Program Files\Steam\steamapps\common\Blender\blender.exe，
// 既没有 Blender Foundation 目录、也没有 DSH_BLENDER_EXE / 配置文件、where blender 也找不到。
//
// 规矩：fixture 全部在 os.tmpdir() 里构造（不依赖真实盘符 / 注册表 / Steam 客户端），
// 跑完清理；Windows 与 Linux CI 断言一致（路径只比"小写 + 正斜杠"归一化后的形式）。

/** 归一化：跨平台可比（Windows 反斜杠 / 大小写都抹平） */
function norm(p: unknown): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

const tmpDirs: string[] = []

function tmpHome(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-blender-detect-' + tag + '-'))
  tmpDirs.push(dir)
  return dir
}

function writeFile(p: string, text: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
  return p
}

/** libraryfolders.vdf 里的路径是转义过的：反斜杠要写两遍 */
function vdfPath(p: string): string {
  return p.replace(/\\/g, '\\\\')
}

const noProbe = (): never => {
  throw new Error('override must win before any filesystem probe')
}

const noProbeDeps: Partial<BlenderDetectDeps> = {
  exists: noProbe,
  listDir: noProbe,
  readText: noProbe,
  exec: noProbe,
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (!dir) break
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

describe('detectBlenderExe · Steam (Windows)', () => {
  it('resolves the Blender under a Steam root and inside a library from libraryfolders.vdf', () => {
    const home = tmpHome('steam-vdf')
    const pf = path.join(home, 'Program Files')
    const steamRoot = path.join(pf, 'Steam')
    const secondLib = path.join(home, 'SteamLibrary-D')
    // 默认根（<root>/steamapps/common/Blender）故意不装：命中只能来自 vdf 里列出的第二库。
    const exe = writeFile(path.join(secondLib, 'steamapps', 'common', 'Blender', 'blender.exe'), '')
    // 容错：空 path、无引号的裸 key、指向不存在目录的 path 都要能被跳过，不能中断解析。
    writeFile(
      path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
      [
        '"libraryfolders"',
        '{',
        '\t"0"',
        '\t{',
        '\t\t"path"\t\t"' + vdfPath(steamRoot) + '"',
        '\t\t"label"\t\t""',
        '\t\t"apps"',
        '\t\t{',
        '\t\t\t"365670"\t\t"0"',
        '\t\t}',
        '\t}',
        '\t"1"',
        '\t{',
        '\t\t"path"',
        '\t\t"path"\t\t""',
        '\t\t"path"\t\t"' + vdfPath(path.join(home, 'no-such-library')) + '"',
        '\t\t"path"\t\t"' + vdfPath(secondLib) + '"',
        '\t}',
        '}',
        'not a vdf line at all',
      ].join('\n'),
    )

    const got = detectBlenderExe({
      env: { ProgramFiles: pf },
      isWin: true,
      isMac: false,
      fileCfg: {},
      // 只认 fixture 树：本机真实 Steam（D:）存在，不能让它抢在 fixture 前面命中。
      exists: (p: string) => norm(p).startsWith(norm(home) + '/') && fs.existsSync(p),
      exec: () => {
        throw new Error('where.exe: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:steam')
    expect(norm(got.exe)).toBe(norm(exe))
  })

  it('finds the plain <steam>/steamapps/common/Blender install when the vdf is missing or junk', () => {
    const home = tmpHome('steam-junk-vdf')
    const pf = path.join(home, 'Program Files')
    const steamRoot = path.join(pf, 'Steam')
    const exe = writeFile(path.join(steamRoot, 'steamapps', 'common', 'Blender', 'blender.exe'), '')
    writeFile(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), '"path" "unterminated\n{{{{')

    const got = detectBlenderExe({
      env: { ProgramFiles: pf },
      isWin: true,
      isMac: false,
      fileCfg: {},
      exists: (p: string) => norm(p).startsWith(norm(home) + '/') && fs.existsSync(p),
      exec: () => {
        throw new Error('where.exe: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:steam')
    expect(norm(got.exe)).toBe(norm(exe))
  })

  it('hits only the simulated D drive and never the other drive letters', () => {
    const dRoot = path.join('D:' + path.sep, 'Program Files', 'Steam')
    const exe = path.join(dRoot, 'steamapps', 'common', 'Blender', 'blender.exe')
    const exists = (p: string): boolean => norm(p) === norm(dRoot) || norm(p) === norm(exe)

    const got = detectBlenderExe({
      env: {},
      isWin: true,
      isMac: false,
      fileCfg: {},
      exists,
      listDir: () => [],
      readText: () => null,
      exec: () => {
        throw new Error('where.exe: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:steam')
    expect(norm(got.exe)).toBe(norm(exe))
    // C:/E:/F: 的候选都被试过（exists 收到过它们的探测），只是不存在 → 只有 D 能命中。
    expect(norm(exe).startsWith('d:/')).toBe(true)
  })

  it('uses HKCU SteamPath so a library on G: is found without a C-F Steam root', () => {
    const root = path.join('G:' + path.sep, 'Steam')
    const exe = path.join(root, 'steamapps', 'common', 'Blender', 'blender.exe')
    const exists = (p: string): boolean => norm(p) === norm(root) || norm(p) === norm(exe)

    const got = detectBlenderExe({
      env: {},
      isWin: true,
      isMac: false,
      fileCfg: {},
      exists,
      listDir: () => [],
      readText: () => null,
      exec: (cmd: string) => {
        if (cmd === 'reg.exe')
          return 'HKEY_CURRENT_USER\\Software\\Valve\\Steam\n    SteamPath    REG_SZ    G:/Steam\n'
        throw new Error('where.exe: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:steam')
    expect(norm(got.exe)).toBe(norm(exe))
  })

  it('reports not-found without throwing when nothing is installed', () => {
    const got = detectBlenderExe({
      env: {},
      isWin: true,
      isMac: false,
      fileCfg: {},
      exists: () => false,
      listDir: () => [],
      readText: () => null,
      exec: () => {
        throw new Error('where.exe: blender not in PATH')
      },
    })
    expect(got).toEqual({ exe: null, from: 'not-found' })
  })
})

describe('detectBlenderExe · official install (Windows regression)', () => {
  it('still prefers a Blender Foundation versioned install', () => {
    const home = tmpHome('official')
    const pf = path.join(home, 'Program Files')
    const exe = writeFile(path.join(pf, 'Blender Foundation', 'Blender 5.2', 'blender.exe'), '')

    const got = detectBlenderExe({
      env: { ProgramFiles: pf },
      isWin: true,
      isMac: false,
      fileCfg: {},
    })

    expect(got.from).toBe('auto:install')
    expect(norm(got.exe)).toBe(norm(exe))
  })

  // P2-9 回归：同时装 5.2 与 5.3 时必须选 **5.3**。旧实现按 listDir 返回顺序取第一个存在的，
  // 于是后端 spawn 的可能是 5.2，而 GUI 里跑的是 5.3 —— 两条通道不是同一个 Blender，且完全静默。
  it('picks the highest version when several Blender installs coexist', () => {
    const home = tmpHome('official-multi')
    const pf = path.join(home, 'Program Files')
    const foundation = path.join(pf, 'Blender Foundation')
    const v52 = writeFile(path.join(foundation, 'Blender 5.2', 'blender.exe'), '')
    const v53 = writeFile(path.join(foundation, 'Blender 5.3', 'blender.exe'), '')
    const v42 = writeFile(path.join(foundation, 'Blender 4.2', 'blender.exe'), '')

    // listDir 故意给出"低版本在前"的顺序（资源管理器/文件系统都可能这样返回）
    const got = detectBlenderExe({
      env: { ProgramFiles: pf },
      isWin: true,
      isMac: false,
      fileCfg: {},
      exists: (p: string) => [v52, v53, v42].some((x) => norm(x) === norm(p)),
      listDir: (p: string) =>
        norm(p) === norm(foundation) ? ['Blender 4.2', 'Blender 5.2', 'Blender 5.3'] : [],
    })

    expect(got.from).toBe('auto:install')
    expect(norm(got.exe)).toBe(norm(v53))
  })
})

describe('detectBlenderExe · macOS / Linux (injected probes)', () => {
  it('finds a macOS .app bundle under /Applications', () => {
    const exe = path.join('/Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender')
    const exists = (p: string): boolean => norm(p) === norm(exe)

    const got = detectBlenderExe({
      env: {},
      isWin: false,
      isMac: true,
      fileCfg: {},
      homedir: () => '/Users/test',
      exists,
      listDir: (p: string) => (norm(p) === '/applications' ? ['Blender.app'] : []),
      readText: () => null,
      exec: () => {
        throw new Error('which: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:install')
    expect(norm(got.exe)).toBe(norm(exe))
  })

  it('finds the Steam-library install on a WSL mount', () => {
    const base = '/mnt/d'
    const exe = path.join(base, 'SteamLibrary', 'steamapps', 'common', 'Blender', 'blender.exe')
    const exists = (p: string): boolean => norm(p) === norm(base) || norm(p) === norm(exe)

    const got = detectBlenderExe({
      env: {},
      isWin: false,
      isMac: false,
      fileCfg: {},
      exists,
      listDir: () => [],
      readText: () => null,
      exec: () => {
        throw new Error('which: blender not in PATH')
      },
    })

    expect(got.from).toBe('auto:install')
    expect(norm(got.exe)).toBe(norm(exe))
  })
})

describe('detectBlenderExe · overrides', () => {
  it('lets DSH_BLENDER_EXE and the config file win over auto detection (env first)', () => {
    const envExe = path.join(os.tmpdir(), 'dsh-env-blender.exe')
    const cfgExe = path.join(os.tmpdir(), 'dsh-cfg-blender.exe')

    const fromEnv = detectBlenderExe({
      env: { DSH_BLENDER_EXE: envExe },
      fileCfg: { blenderExe: cfgExe },
      isWin: true,
      isMac: false,
      ...noProbeDeps,
    })
    expect(fromEnv).toEqual({ exe: envExe, from: 'config' })

    const fromCfg = detectBlenderExe({
      env: {},
      fileCfg: { blenderExe: cfgExe },
      isWin: true,
      isMac: false,
      ...noProbeDeps,
    })
    expect(fromCfg).toEqual({ exe: cfgExe, from: 'config' })
  })
})
