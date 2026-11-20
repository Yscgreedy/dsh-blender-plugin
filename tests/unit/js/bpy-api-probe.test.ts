/**
 * 工单 11：headless bpy_api_lookup 的纯逻辑与探针复用（不启动 Blender）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  buildProbeEvidence,
  driftOf,
  lookupHeadless,
  normalizeHit,
  probeCode,
  resetProbeCache,
} from '../../../runtime/core/bpy-api-probe.js'
import { pkgPath } from '../../helpers/pkg'

class FakeWorker {
  calls: string[] = []
  alive = false
  list() {
    return this.alive ? [{ name: 'bpy-api-probe', alive: true, pid: 4242 }] : []
  }
  async exec(code: string) {
    this.calls.push(code)
    const reused = this.alive
    this.alive = true
    return {
      ok: true,
      reused,
      result: {
        ok: true,
        blender_version: '5.3.0',
        result: { kind: 'function', identifier: 'ray_cast' },
      },
    }
  }
}

describe('headless bpy_api_lookup', () => {
  it('drift only when versions really differ, message carries both', () => {
    expect(driftOf('5.3', '5.3.0')).toBeNull()
    const d = driftOf('4.2', '5.3.0')
    expect(d?.level).toBe('warn')
    expect(d?.source).toBe('exe')
    expect(d?.message).toContain('4.2')
    expect(d?.message).toContain('5.3.0')
    expect(driftOf('4.2', '5.3.0', 'fixture')?.source).toBe('fixture')
  })

  it('builds the structured evidence with all required fields', () => {
    const ev = buildProbeEvidence({
      query: 'Object.ray_cast',
      observedVersion: '5.3.0',
      hits: [{ kind: 'function' }],
      cacheAge: 0,
      degraded: false,
      error: null,
      expectVersion: '4.2',
      versionFixture: null,
      elapsedMs: 12,
      reused: false,
      workerPid: 4242,
      startCount: 1,
      blenderExe: 'C:/Blender/blender.exe',
    })
    expect(ev.source).toBe('headless')
    expect(ev.blender_version).toBe('5.3.0')
    expect(ev.cache_age).toBe(0)
    expect(ev.hits).toHaveLength(1)
    expect(ev.probe).toEqual({
      blender_exe: 'C:/Blender/blender.exe',
      elapsed_ms: 12,
      reused: false,
      worker_pid: 4242,
      start_count: 1,
    })
    expect(ev.drift?.message).toContain('4.2')
    expect(ev.version_source).toBe('observed')

    const fixture = buildProbeEvidence({
      query: 'q',
      observedVersion: '5.3.0',
      hits: [],
      cacheAge: 0,
      degraded: false,
      error: null,
      expectVersion: '5.3',
      versionFixture: '4.2.1',
      elapsedMs: 1,
      reused: true,
      workerPid: 1,
      blenderExe: null,
    })
    expect(fixture.version_source).toBe('fixture')
    expect(fixture.drift?.message).toContain('4.2.1')
  })

  it('reuses one worker for 5 lookups and caches repeats', async () => {
    resetProbeCache()
    const worker = new FakeWorker()
    const first = await lookupHeadless(worker, { query: 'Object.ray_cast' })
    expect(first.probe.reused).toBe(false)
    expect(first.probe.worker_pid).toBeNull()
    expect(first.probe.start_count).toBe(1)
    expect(first.hits[0]).toMatchObject({ kind: 'function', name: 'ray_cast' })
    expect(first.hits[0]).toHaveProperty('doc')
    expect(first.hits[0]).toHaveProperty('params')
    for (const q of ['Object.ray_cast', 'Object.ray_cast', 'Object.ray_cast', 'Object.ray_cast']) {
      const again = await lookupHeadless(worker, { query: q })
      expect(again.source).toBe('headless')
    }
    expect(worker.calls).toHaveLength(1) // 缓存命中，不再起进程/不再 exec
    const other = await lookupHeadless(worker, { query: 'Object.location' })
    expect(other.probe.reused).toBe(true)
    expect(other.probe.start_count).toBe(1)
    expect(worker.calls).toHaveLength(2)

    // 缓存命中也要按本次入参重建 drift（不能把上次没有 expect_version 的证据原样返回）。
    const cachedDrift = await lookupHeadless(worker, {
      query: 'Object.ray_cast',
      expectVersion: '4.2',
    })
    expect(cachedDrift.cache_age).toBeGreaterThanOrEqual(0)
    expect(cachedDrift.probe.reused).toBe(true)
    expect(cachedDrift.drift?.message).toContain('4.2')
    expect(worker.calls).toHaveLength(2)
  })

  it('degrades loudly instead of throwing', async () => {
    resetProbeCache()
    const worker = {
      list: () => [],
      exec: async () => {
        throw new Error('worker boom')
      },
    }
    const ev = await lookupHeadless(worker, { query: 'Object.ray_cast' })
    expect(ev.degraded).toBe(true)
    expect(String(ev.error)).toContain('worker boom')
    expect(ev.hits).toEqual([])
  })

  it('normalizes hits into {kind,name,doc,params}', () => {
    const hit = normalizeHit({
      kind: 'function',
      identifier: 'ray_cast',
      description: 'Cast a ray',
    })
    expect(hit).toMatchObject({ kind: 'function', name: 'ray_cast', doc: 'Cast a ray', params: [] })
  })

  it('probe code loads the addon lookup implementation by path', () => {
    const code = probeCode('Object.ray_cast', 'C:/pkg/extension/dsh_blender_bridge/commands/core')
    expect(code).toContain('describe.py')
    expect(code).toContain('bpy_lookup.py')
    expect(code).toContain('"Object.ray_cast"')
    expect(code).toContain('HEADLESS ')
  })

  it('documents force_headless / expect_version / version_fixture in the schema', () => {
    const schema = fs.readFileSync(pkgPath('src', 'tools', 'inspect', 'index.ts'), 'utf8')
    expect(schema).toContain('force_headless')
    expect(schema).toContain('expect_version')
    expect(schema).toContain('version_fixture')
    expect(schema).toContain('source=headless')
  })
})
