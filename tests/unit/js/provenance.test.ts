import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pkgPath } from '../../helpers/pkg'

// v0.9.6: the loaded-version self check must use a content fingerprint,
// never mtime — a touch used to fake "stale", a same-second rewrite used to
// fake "fresh". A clean process is the judge for the on-disk catalog.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prov-stale-'))
const COPY_RT = path.join(TMP, 'lib', 'runtime')
const ENGINE = path.join(COPY_RT, 'engine.js')
const CATALOG = path.join(COPY_RT, 'catalog', 'data.js')
let mod: any
let origEngine = ''
let origMd5 = ''

function copyRuntime(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (['__pycache__', 'ext', 'venv', 'node_modules', 'pkg.tgz'].includes(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyRuntime(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

const md5 = (p: string) => createHash('md5').update(fs.readFileSync(p)).digest('hex')

beforeAll(async () => {
  // the shipped runtime is built JS under lib/runtime; Python assets stay in package runtime/.
  copyRuntime(pkgPath('lib', 'runtime'), COPY_RT)
  copyRuntime(pkgPath('runtime'), path.join(TMP, 'runtime'))
  fs.copyFileSync(pkgPath('package.json'), path.join(TMP, 'package.json'))
  mod = await import(pathToFileURL(ENGINE).href + '?probe=' + String(Date.now()))
  origEngine = fs.readFileSync(ENGINE, 'utf8')
  origMd5 = md5(ENGINE)
}, 60000)

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('loaded version provenance', () => {
  it('reports current right after loading with a sha256:12 hash', () => {
    const pr = mod.engineProvenance({})
    expect(pr).toMatchObject({ verdict: 'current', stale: false, hashAlgo: 'sha256:12' })
    expect(pr.loadedHash).toBeTruthy()
    expect(pr.loadedHash).toBe(pr.currentHash)
    expect(/^[0-9a-f]{12}$/.test(pr.loadedHash)).toBe(true)
    expect(String(pr.note)).toContain('mtime')
    const text = mod.catalogPayload({}).text
    expect(text).toContain('目录自证')
    expect(text).not.toContain('目录自证 FAIL')
  })

  it('ignores an mtime-only change but reports the mtime as reference', () => {
    const pr0 = mod.engineProvenance({})
    const future = new Date(Date.now() + 3600 * 1000)
    fs.utimesSync(ENGINE, future, future)
    expect(md5(ENGINE)).toBe(origMd5)
    expect(fs.statSync(ENGINE).mtimeMs).toBeGreaterThan(Date.now())
    const pr1 = mod.engineProvenance({})
    expect(pr1).toMatchObject({ verdict: 'current', stale: false })
    expect(pr1.currentHash).toBe(pr0.currentHash)
    expect(pr1.currentMtime).toBeTruthy()
    expect(pr1.currentMtime).not.toBe(pr0.currentMtime)
  })

  it('flags a real content change as stale and names both hashes', () => {
    fs.writeFileSync(
      ENGINE,
      origEngine + String.fromCharCode(10) + '// provenance-stale-probe' + String.fromCharCode(10),
      'utf8',
    )
    const pr = mod.engineProvenance({ verify: true })
    expect(pr).toMatchObject({ verdict: 'stale', stale: true })
    expect(String(pr.staleReason)).toContain(pr.loadedHash)
    expect(String(pr.staleReason)).toContain(pr.currentHash)
    expect(pr.diskVerdict && pr.diskVerdict.ok).toBe(true)
    expect(pr.diskVerdict.matchesLoadedCatalog).toBe(true)
  })

  it('names a stale on-disk catalog FAIL when the loaded catalog is old', () => {
    const mutated = fs.readFileSync(CATALOG, 'utf8').replace("f: 'sculpt',", "f: 'sculptx',")
    expect(mutated).not.toBe(fs.readFileSync(CATALOG, 'utf8'))
    fs.writeFileSync(CATALOG, mutated, 'utf8')
    const cat = mod.catalogPayload({ verify: true })
    expect(cat.provenance.diskVerdict.families).toBe(mod.PLAN_CATALOG.length)
    expect(cat.provenance.diskVerdict.matchesLoadedCatalog).toBe(false)
    expect(cat.provenance.catalogHash).not.toBe(cat.provenance.diskVerdict.catalogHash)
    expect(cat.text).toContain('目录自证 FAIL')
    const note = String(cat.provenance.diskVerdict.note)
    expect(note.includes('重启后端') || note.includes('以干净进程那份为准')).toBe(true)
  })
})
// H8（回归）：宿主层「已装载」必须来自宿主写的清单，而不是 Gateway 启动时扫的盘。
// 反例（2026-11-16 下游实测的洞）：改 lib/constants.js → 只重启 Gateway →
// Gateway 重新扫盘 → host.verdict 自证成 current，而宿主进程里仍是旧代码。
describe('host layer provenance (H1: the loaded side is the host manifest)', () => {
  const HOSTLIB = path.join(TMP, 'lib')
  const MANIFEST = path.join(TMP, 'host-manifest.json')
  const CONSTANTS = path.join(HOSTLIB, 'constants.js')
  let layers: any

  beforeAll(async () => {
    // 前面的用例把 lib/runtime/engine.js 改写过（运行时层 stale）：本组只验宿主层，先复原，
    // 否则顶层 verdict 会一直带 runtime。
    fs.writeFileSync(ENGINE, origEngine, 'utf8')
    fs.writeFileSync(path.join(HOSTLIB, 'index.js'), 'export default {}\n', 'utf8')
    fs.writeFileSync(CONSTANTS, 'export const PLUGIN_VERSION = "probe-1"\n', 'utf8')
    layers = await import(
      pathToFileURL(path.join(COPY_RT, 'foundation', 'layers.js')).href +
        '?layers=' +
        String(Date.now())
    )
  })

  afterAll(() => {
    delete process.env.DSH_BLENDER_HOST_MANIFEST
  })

  it('records the manifest at host load and keeps stale across a gateway-only restart', () => {
    const manifest = layers.writeHostManifest(HOSTLIB, MANIFEST, {
      pluginVersion: 'probe',
      hostPid: 4242,
    })
    // runtime/ 整枝不属于宿主层：清单里只能是 constants.js + index.js
    expect(manifest.fileCount).toBe(2)
    expect(Object.keys(manifest.files).sort()).toEqual(['constants.js', 'index.js'])
    process.env.DSH_BLENDER_HOST_MANIFEST = MANIFEST

    const loaded = mod.engineProvenance({ fresh: true })
    expect(loaded.verdict).toBe('current')
    expect(loaded.staleLayer).toEqual([])
    expect(loaded.host).toMatchObject({
      source: 'manifest',
      verdict: 'current',
      loadedFileCount: 2,
      fileCount: 2,
      changedCount: 0,
    })
    expect(loaded.host.loadedHash).toBe(loaded.host.currentHash)

    fs.writeFileSync(CONSTANTS, 'export const PLUGIN_VERSION = "probe-2"\n', 'utf8')

    const drifted = mod.engineProvenance({ fresh: true })
    expect(drifted.verdict).toBe('stale')
    expect(drifted.stale).toBe(true)
    expect(drifted.staleLayer).toEqual(['host'])
    expect(drifted.host.verdict).toBe('stale')
    expect(drifted.host.changedFiles).toEqual(['constants.js'])
    // 运行时层没动：stale 必须归因到宿主层，而不是可重启 Gateway 解决的那一层
    expect(drifted.runtime.verdict).toBe('current')
    expect(String(drifted.host.note)).toContain('只重启 Gateway 不会换掉宿主层')

    // ★「只重启 Gateway」= 同一份清单、下一次读盘。清单没重写 ⇒ 仍然 stale。
    const afterGatewayRestart = mod.engineProvenance({ fresh: true })
    expect(afterGatewayRestart.host.verdict).toBe('stale')
    expect(afterGatewayRestart.host.loadedAt).toBe(drifted.host.loadedAt)

    // 宿主重组合（新 fiber 重写清单）之后才转 current
    const rewritten = layers.writeHostManifest(HOSTLIB, MANIFEST, {
      pluginVersion: 'probe',
      hostPid: 4243,
    })
    expect(rewritten.hash).not.toBe(manifest.hash)
    const recomposed = mod.engineProvenance({ fresh: true })
    expect(recomposed.verdict).toBe('current')
    expect(recomposed.host.source).toBe('manifest')
    expect(recomposed.host.changedCount).toBe(0)
  })

  it('degrades to the boot scan and says so when no host manifest is provided', () => {
    delete process.env.DSH_BLENDER_HOST_MANIFEST
    const pr = mod.engineProvenance({ fresh: true })
    expect(pr.host.source).not.toBe('manifest')
    expect(pr.host.verdict).toBe('unknown')
    expect(String(pr.host.note)).toContain('降级')
  })
})

// 复测第四轮（2026-11-19，BlenderProject）：假 noop 的两个成因。
//   ① 清单在**共享目录**里，别的装载（仓库副本 / 另一个 profile）写下的那份会被当成「本安装已装载」；
//   ② 清单如果是在「镜像完成之后」才现扫的，它会把新磁盘记成已装载。
// 判据：清单必须属于本安装（root 一致）；「已装载」必须来自装载那一刻的扫描。
describe('host manifest identity + load-time scan (round 4)', () => {
  const HOSTLIB = path.join(TMP, 'lib')
  const OTHER = path.join(TMP, 'lib-other')
  const MANIFEST = path.join(TMP, 'host-manifest-identity.json')
  let layers: any

  beforeAll(async () => {
    fs.mkdirSync(OTHER, { recursive: true })
    fs.writeFileSync(
      path.join(OTHER, 'constants.js'),
      'export const PLUGIN_VERSION = "other"\n',
      'utf8',
    )
    layers = await import(
      pathToFileURL(path.join(COPY_RT, 'foundation', 'layers.js')).href +
        '?layers4=' +
        String(Date.now())
    )
  })

  afterAll(() => {
    delete process.env.DSH_BLENDER_HOST_MANIFEST
  })

  it('sameRoot 只认同一处（分隔符/尾斜杠无关，空值永远不等）', () => {
    expect(layers.sameRoot(HOSTLIB, HOSTLIB + path.sep)).toBe(true)
    expect(layers.sameRoot(HOSTLIB, OTHER)).toBe(false)
    expect(layers.sameRoot('', '')).toBe(false)
  })

  it('writeLayerManifest 保存装载时的逐文件指纹：磁盘后来变了也不改写', () => {
    fs.writeFileSync(
      path.join(HOSTLIB, 'constants.js'),
      'export const PLUGIN_VERSION = "load-1"\n',
      'utf8',
    )
    const scan = layers.scanLayer(HOSTLIB, ['runtime'])
    const written = layers.writeLayerManifest(scan, HOSTLIB, MANIFEST, {
      pluginVersion: 'probe',
      hostPid: 4242,
    })
    expect(written.files['constants.js']).toBe(scan.files['constants.js'])
    // 「装载之后」磁盘又变了（= 镜像完成、fiber 还是旧的）
    fs.writeFileSync(
      path.join(HOSTLIB, 'constants.js'),
      'export const PLUGIN_VERSION = "disk-2"\n',
      'utf8',
    )
    const reread = layers.readHostManifest(MANIFEST)
    expect(reread.files['constants.js']).toBe(scan.files['constants.js'])
    expect(reread.files['constants.js']).not.toBe(
      layers.scanLayer(HOSTLIB, ['runtime']).files['constants.js'],
    )
  })

  it('不属于本安装的清单 → host 判不了（unknown），不拿别人的指纹自证 current', () => {
    const foreign = layers.writeHostManifest(OTHER, path.join(TMP, 'foreign.json'), {
      pluginVersion: 'other-install',
      hostPid: 999,
    })
    expect(foreign.root).toBe(OTHER)
    process.env.DSH_BLENDER_HOST_MANIFEST = path.join(TMP, 'foreign.json')
    const pr = mod.engineProvenance({ fresh: true })
    expect(pr.host.verdict).toBe('unknown')
    expect(pr.host.source).not.toBe('manifest')
    expect(String(pr.host.note)).toContain('另一处装载')
  })
})
