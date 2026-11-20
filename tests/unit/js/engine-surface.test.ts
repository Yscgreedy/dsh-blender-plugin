import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createEngine } from '../../../runtime/engine.js'

// 计数不写字面量：catalog 长族/加 op 时改 tests/fixtures/capability.lock.json 一处（sync_counts 同源头）。
const lock = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/capability.lock.json', import.meta.url), 'utf8'),
) as {
  families_count: number
  ops_count: number
}

const fakeAddon = {
  send: async () => ({}),
  close: () => {},
  instances: [],
}
const engine = createEngine({ addonClient: fakeAddon as any }) as any
afterAll(() => engine.stop())

describe('engine assembly', () => {
  it('exposes the frozen public surface', () => {
    expect(Object.keys(engine)).toHaveLength(32)
    expect(engine.addon).toBeTruthy()
    for (const k of [
      'plan',
      'txn',
      'preset',
      'launchBlender',
      'sceneEpoch',
      'renderFlag',
      'metrics',
      'protocol',
      'doctor',
      'status',
      'act',
      'cmd',
      'commands',
      'loopStart',
      'loopStop',
      'loopBoard',
      'loopExport',
      'loopHelp',
      'frameArea',
      'perf',
      'opt',
      'frame',
      'view',
      'hostSceneItems',
      'headless',
      'start',
      'stop',
    ]) {
      expect(typeof engine[k], k).toBe('function')
    }
    expect(Object.keys(engine.worker).sort()).toEqual([
      'aux',
      'digest',
      'exec',
      'list',
      'reset',
      'restart',
      'see',
      'snapshot',
      'start',
      'state',
      'status',
      'stop',
      'watch',
    ])
    expect(Object.keys(engine.job).sort()).toEqual([
      'collect',
      'kill',
      'list',
      'start',
      'status',
      'wait',
    ])
  })

  it('serves catalog locally without an addon (counts equal the frozen lock)', async () => {
    const c = await engine.plan('catalog', {})
    expect(c.ok).toBe(true)
    expect(c.families).toHaveLength(lock.families_count)
    expect(c.ops_count).toBe(lock.ops_count)
    expect(c.provenance).toBeTruthy()
  })

  it('reports metrics and render flag shapes', async () => {
    const m = engine.metrics()
    for (const k of [
      'calls',
      'errors',
      'timeouts',
      'inflight',
      'views',
      'headlessRuns',
      'workerStarts',
      'workerExecs',
    ]) {
      expect(typeof m[k], k).toBe('number')
    }
    expect(typeof m.lastCmdAgeMs === 'number' || m.lastCmdAgeMs === null).toBe(true)
    const flag = engine.renderFlag()
    expect(flag).toMatchObject({ present: expect.any(Boolean), stale: expect.any(Boolean) })
  })
})
